// 2D contour: machine around the part's outline, depth pass by depth pass.
//
// Offsets the part's downward silhouette outward by tool radius + stock to
// leave, and cuts each resulting loop. Using the silhouette rather than the
// bare slice is what keeps the pass reachable where the part overhangs.
//
// Each loop is oriented for the requested cut direction, entered by ramp or by
// lead-in, and left by lead-out. Optional finish passes walk the remaining
// stock-to-leave off at final depth.
//
// **Which outline** is the decision this operation lives or dies by, and for a
// long time there was only one answer to it. The silhouette at a depth is the
// shadow of everything *above* that depth, so on any part whose footprint is not
// constant, the outline changes every level: on the sample clamp the top pass is
// a 29×29 loop and the bottom one is 78×80. Follow those and the cutter spends
// the first passes carving a groove through the middle of the billet and only
// reaches the outside at the bottom — which is a clearing pass wearing a
// contour's name, and reads exactly like "it wants to machine everything".
//
// So the outline is a choice, and the default is the one people mean:
//
//   part  — one outline, the shadow of the whole part down to Bottom Z, cut at
//           every level. This is "cut the part free": a slot down the outside of
//           the billet that never enters the part's footprint at any depth.
//   level — the profile as it stands at each depth. Right for a stepped
//           prismatic part, where each level really is a different outline.

import { CLBuilder, FEED, lastXY } from '../cl.js';
import { plural, pluralEs } from '../text.js';
import { mergeTolerance } from '../simplify.js';
import { offsetLoops, loopArea, unionWithHoles } from '../../geom/clipper.js';
import { SilhouetteStack, silhouetteAbove } from '../../geom/silhouette.js';
import { depthPasses } from '../stock.js';
import {
  cutLoopWithRamp, cutPerimeter, orderByProximity, startNearest, startNearestSlide,
} from '../linking.js';
import {
  orientLoop, leadInPoints, leadOutPoints, emitLeadOut,
  internalLeadStart, startOnSegment, leadOnLoop,
} from '../leads.js';
import { applyRegionsToPaths } from '../regions.js';
import { approach, entryPlane, crossingPlane, goHome, EntrySurface } from '../heights.js';
import { applyCutting } from '../cutting.js';
import { cutPerimeterWithTabs } from '../tabs.js';

export function generateContour({
  mesh, tool, params, regions, stock, fixtures,
}) {
  const r = tool.diameter / 2;
  const stockToLeave = params.stockToLeave ?? 0;
  const clearance = params.clearanceHeight;
  const tolerance = params.tolerance ?? 0.01;
  const direction = params.direction ?? 'climb';
  const lead = { type: params.leadType ?? 'none', radius: params.leadRadius ?? 0 };
  // how high a pass has to go to reach the next one — see engine/heights.js
  const crossAt = crossingPlane(params, stock, fixtures);

  const cl = new CLBuilder().simplify(mergeTolerance(tolerance));
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  // One outline for the whole cut, or a fresh one at every level — see the note
  // at the top of the file. A stack is only worth building for the second.
  const perLevel = (params.contourOutline ?? 'part') === 'level';
  const silhouette = perLevel ? new SilhouetteStack(mesh, { tolerance }) : null;
  const partShadow = perLevel ? null : silhouetteAbove(mesh, params.bottomZ, { tolerance });

  let cutAnything = false;
  // Where the material still stands, pass by pass — the height a ramp entry
  // starts from. See engine/heights.js EntrySurface.
  const surface = new EntrySurface(params.topZ, r);
  let finalShadow = null;
  const clip = { radius: r, tolerance };
  const tabs = tabConfig(params, tool);
  const side = params.side ?? 'outside';
  // Boundaries the cutter was too big to go round, counted for the note below.
  let dropped = 0;
  const emitLevel = (shadow, allowance, z, useTabs) => {
    const profiles = selectProfiles(shadow, params.profile ?? 'outer');
    const raw = offsetLoops(profiles, offsetFor(side, r, allowance), tolerance);
    // Offsetting a boundary inward by more than its own half-width collapses
    // it, which is the honest answer — a ⌀12 cutter cannot go round a ⌀4.5
    // hole. Saying nothing is not: asking for every profile on this part and
    // getting a program byte-identical to "outer profile only" reads as a
    // setting that does not work. See the note where this is reported.
    if (raw.length < profiles.length) dropped = Math.max(dropped, profiles.length - raw.length);
    const { closed, open } = applyRegionsToPaths(raw, regions, { ...clip, z });
    let any = false;
    // nearest first, from wherever the tool finished the level above — the
    // offsetter's own order has no relation to where anything is
    for (const loop of orderByProximity(closed, cl.count > 0 ? lastXY(cl) : null)) {
      // Per loop, not per level: in `level` mode the outline is re-read at every
      // depth, so a loop that appears when the cross-section changes is the
      // first thing ever to visit that line and the stock there is untouched.
      // Taking it in one pass is a cut as deep as the whole operation — 15mm
      // with a ⌀6 cutter on the step plate, 23mm on the sloped one — so it is
      // stepped down to like any other. See engine/heights.js EntrySurface.
      let from = surface.entryFor(loop);
      for (const zz of depthPasses(from, z, params.stepdown)) {
        const useTabsHere = (useTabs && zz <= z + 1e-9) || zz < tabTop - 1e-9;
        if (cutLoopPass(cl, loop, from, zz, {
          clearance, direction, lead, params, tabs: useTabsHere ? tabs : null, crossAt,
        })) { any = true; surface.covered(loop); }
        from = zz;
      }
    }
    for (const path of open) {
      let from = surface.entryFor(path, false);
      for (const zz of depthPasses(from, z, params.stepdown)) {
        if (cutOpenPass(cl, path, zz, { clearance, feedPlane: entryPlane(params, from, zz) })) {
          any = true;
          surface.covered(path, false);
        }
        from = zz;
      }
    }
    return any;
  };

  // Tabs go on every pass that would cut into the tab, not only the last one.
  // A tab taller than one stepdown is machined away by the pass above it if
  // only the final pass lifts over it — the setting is accepted, the program
  // looks right, and the part comes loose anyway.
  // A tab is a count *and* a height, and asking for tabs without a height gets
  // a program with nothing holding the part in — which is discovered when it
  // moves, not when it is generated. Only that direction is worth saying: a
  // height with no count is how tabs are switched off, and is the default.
  if (tabs.count > 0 && !(tabs.height > 0)) {
    cl.warn(`${plural(tabs.count, 'tab')} asked for with no tab height — nothing will `
      + 'hold the part when the last pass goes through. Set how tall the tabs are.');
  }
  const levels = [...depthPasses(params.topZ, params.bottomZ, params.stepdown)];
  const tabTop = params.bottomZ + tabs.height;

  // A single-outline contour whose loops are the same shape at every depth can
  // be taken loop by loop, each in one continuous descent, instead of level by
  // level. That is what stops the tool leading out, retracting over the stock
  // and leading back in between every stepdown.
  //
  // It needs the loop shape constant with depth. That rules out `level` mode
  // (the outline is re-read each level) and rest-machining `cleared` snapshots,
  // which are the one part of region clipping that varies with Z — an avoid or
  // include keepout clips the same at every depth, so it is applied once, at the
  // bottom, and holds all the way up. An irrelevant keepout therefore leaves the
  // loops unchanged and the descent identical to having no region at all, which
  // is the invariant the region tests hold this to.
  const clearedVaries = Array.isArray(regions?.cleared) && regions.cleared.length > 0;
  const continuous = !perLevel && !clearedVaries;
  if (continuous) {
    finalShadow = partShadow;
    const profiles = selectProfiles(finalShadow, params.profile ?? 'outer');
    const raw = offsetLoops(profiles, offsetFor(side, r, stockToLeave), tolerance);
    if (raw.length < profiles.length) dropped = Math.max(dropped, profiles.length - raw.length);
    // avoid/include are depth-invariant, so clipping once at the bottom holds
    // for the whole descent.
    const { closed, open } = applyRegionsToPaths(raw, regions, { ...clip, z: params.bottomZ });
    surface.beginLevel();
    // Each closed loop is one continuous descent; mark it covered so the finish
    // passes below enter it at final depth rather than re-descending it.
    for (const loop of orderByProximity(closed, cl.count > 0 ? lastXY(cl) : null)) {
      if (cutLoopColumn(cl, loop, params.topZ, levels, {
        clearance, direction, lead, params, tabs, tabTop, crossAt,
      })) { cutAnything = true; surface.covered(loop); }
    }
    // A loop an avoid region has cut open cannot spiral; take it level by level.
    for (const path of open) {
      let from = params.topZ;
      for (const zz of levels) {
        if (cutOpenPass(cl, path, zz, { clearance, feedPlane: entryPlane(params, from, zz) })) {
          cutAnything = true;
        }
        from = zz;
      }
    }
    surface.endLevel(params.bottomZ);
  } else {
    levels.forEach((z, i) => {
      finalShadow = perLevel ? silhouette.down(z) : partShadow;
      const isFinal = i === levels.length - 1;
      const cutsIntoTab = z < tabTop - 1e-9;
      surface.beginLevel();
      if (emitLevel(finalShadow, stockToLeave, z, isFinal || cutsIntoTab)) cutAnything = true;
      surface.endLevel(z);
    });
  }

  // finish passes: peel the remaining allowance off at final depth, so the wall
  // is cut by a tool that is no longer buried in stock
  // A finishing pass peels off the allowance a roughing pass left. With no
  // allowance there is nothing for it to peel, so it does nothing at all — and
  // did so silently, which reads as a setting that is broken rather than one
  // that has nothing to do. Say it.
  const finishPasses = Math.max(0, Math.round(params.finishPasses ?? 0));
  if (finishPasses > 0 && !(stockToLeave > 0)) {
    cl.warn(`${pluralEs(finishPasses, 'finish pass')} asked for with no stock to leave — `
      + 'they would re-cut the wall the roughing passes already left to size. '
      + 'Set a stock allowance for them to take off.');
  }
  if (finishPasses > 0 && stockToLeave > 0 && finalShadow) {
    for (let i = 1; i <= finishPasses; i++) {
      const remaining = stockToLeave * (1 - i / finishPasses);
      // only the very last finish pass carries the tabs — earlier finish
      // passes are still shaving stock off, not the through-cut
      surface.beginLevel();
      emitLevel(finalShadow, remaining, params.bottomZ, true);
      surface.endLevel(params.bottomZ);
    }
  }

  if (dropped > 0 && cutAnything) {
    cl.info(`${dropped} boundary/boundaries left uncut — a ⌀${tool.diameter} cutter does `
      + 'not fit round them. Use a smaller cutter, or bore them.');
  }
  if (!cutAnything) cl.warn('contour produced no passes — check Top Z and Bottom Z');
  goHome(cl, clearance);
  return cl.finish();
}

/**
 * Which way round the loop is cut and which of its points the tool arrives at.
 *
 * Both answers move the entry point, and a caller that has to *plan* the move
 * to this pass — waterline, which works out how high it may travel by looking
 * at where it is going — needs the same answer this pass will act on. Asking
 * the same function is what keeps the plan and the move from being two
 * descriptions of one thing: the previous version planned a link to `loop[0]`
 * and the pass then entered at some other vertex, so the plan cleared ground
 * the tool never crossed and missed the ground it did.
 *
 * Idempotent, which is what lets both of them call it: re-orienting an oriented
 * loop and re-breaking it at the point it already starts on change nothing.
 */
/**
 * @param runIn when the tool is already at depth and about to *slide* onto this
 *   loop from the one beside it, how far along the loop to start — so the step
 *   across is taken at a shallow angle rather than square into the material.
 *   See engine/linking.js startNearestSlide. 0 breaks in at the nearest vertex.
 */
export function orderLoopForEntry(rawLoop, direction, lead, from = null, runIn = 0) {
  const resolved = resolveLead(rawLoop, lead);
  const loop = orientLoop(rawLoop, direction, resolved.materialOutside);
  if (leadInPoints(loop, resolved).length === 0) {
    // Break into the loop at the point nearest the tool. A loop is a cycle, so
    // where you enter it is free — and entering at the far side means crossing
    // it twice, once at clearance to get there and once cutting to come back.
    if (!from) return loop;
    return runIn > 0 ? startNearestSlide(loop, from, runIn) : startNearest(loop, from);
  }
  // With a lead, where the tool arrives is not free: inside a pocket the arc
  // needs a straight to reach back along, so the pass starts in the middle of
  // the longest one rather than on whichever corner the offsetter began at.
  const start = resolved.materialOutside ? internalLeadStart(loop, resolved) : null;
  return start ? startOnSegment(loop, start.index, start.mid) : loop;
}

/**
 * Which side of this pass the metal is on, as one answer for both the cut
 * direction and the lead.
 *
 * A tool-centre loop does not know: the same rectangle is the outside of a boss
 * or the inside of a pocket depending only on what it was offset from. A loop
 * that runs the other way round is the silhouette's own way of saying "hole",
 * and that is the default — but a strategy that has just offset a void inward
 * knows better than the winding does, and says so with `lead.materialOutside`.
 *
 * Both questions have to be answered the same way or the pass contradicts
 * itself: climb round a pocket wall is the opposite direction to climb round a
 * boss, and a lead into a pocket curls the opposite way to one onto a boss.
 *
 * Answer it once, against the loop as the offsetter produced it — after
 * `orientLoop` the winding is whatever the cut direction wanted and no longer
 * says anything about the geometry, so a caller that orients first and asks
 * afterwards gets a different answer for the same pass.
 */
export function resolveLead(rawLoop, lead) {
  return { ...lead, materialOutside: lead?.materialOutside ?? loopArea(rawLoop) < 0 };
}

/** Where the tool first arrives on a pass prepared by `orderLoopForEntry`. */
export function loopEntryPoint(loop, lead) {
  const inPts = leadInPoints(loop, leadOnLoop(loop, lead));
  return inPts.length ? inPts[0] : [loop[0], loop[1]];
}

/** And where it is standing when that pass finishes. */
export function loopExitPoint(loop, lead) {
  const outPts = leadOutPoints(loop, leadOnLoop(loop, lead));
  return outPts.length ? outPts[outPts.length - 1] : [loop[0], loop[1]];
}

/**
 * One closed pass: position, get into the cut, go round, get out, retract.
 * @returns whether anything was emitted
 */
/**
 * @param options.atDepth the tool is already at `z` next to this pass, so it
 *   steps across at depth instead of lifting, traversing and coming back down.
 *   Only a caller that knows the ground between the two is one stepover wide
 *   may say so — see strategies/pocket.js, which is where the concentric rings
 *   of one pocket are joined into a spiral instead of being entered one at a
 *   time. `exitAt` at or below `z` means the same thing on the way out: leave
 *   the tool where it is, because the next pass starts from there.
 */
export function cutLoopPass(cl, rawLoop, zEntry, z, {
  clearance, direction, lead, params, tabs, crossAt = null, exitAt = null,
  atDepth = false, runIn = 0,
}) {
  if (rawLoop.length / 2 < 3) return false;
  // Where this pass comes from and goes back to. A pass cannot know what the
  // next one is — the lesson parallel3d's retracts taught — so the caller,
  // which does, hands it a height it may travel at instead of clearance. One
  // ring per level made this invisible: the retract and the descent that
  // followed it were at the same XY and the peephole dropped the pair. With
  // several rings per level, as a Z-level rough or a waterline finish has,
  // every transition between them was a full climb and a full descent.
  const home = crossAt != null && crossAt > z + 1e-9
    ? Math.min(crossAt, clearance) : clearance;
  // Where the pass *leaves* the cut, which is a different question from where
  // it arrived: the caller knows what comes next and this pass does not. A
  // caller that can plan the link (see zLevelLinker) sets it to the height that
  // clears the ground between here and the next pass, so a descent through the
  // same feature lifts by an entry gap rather than by the whole part.
  // …and null means "stay where you are": the next pass steps across at depth,
  // so a retract here would be a lift the very next block undoes.
  const exit = exitAt == null ? home
    : exitAt > z + 1e-9 ? Math.min(Math.max(exitAt, z), clearance)
      : null;
  // The same question the caller asked, asked the same way — including the
  // run-in. Dropping it here re-broke the loop at its nearest *vertex*, which
  // on a ring offset from a rectangle is a corner, so a caller that had
  // carefully arranged to slide onto this ring got a square step into the
  // corner of the uncut band anyway. Idempotent only holds when both calls are
  // given the same arguments.
  const loop = orderLoopForEntry(rawLoop, direction, lead,
    cl.count > 0 ? lastXY(cl) : null, runIn);
  const passLead = leadOnLoop(loop, resolveLead(rawLoop, lead));
  const inPts = leadInPoints(loop, passLead);
  // The tool only has to *feed* through the material this pass removes: from
  // the level above (already cut away at this XY) down to this one. Feeding
  // from the feed plane instead meant the last pass of a 30mm profile fed 32mm
  // straight down in a single plunge move — the stepdown was honoured by the
  // cutting levels and thrown away by the entry, which is the dangerous half.
  // …and never above the height this pass arrives at. The plane is measured
  // from the level above, which is right when the tool comes down from
  // clearance and wrong the moment the caller hands it a lower arrival — a
  // pocket linking two of its own rings arrives an entry gap above the cut and
  // was then sent back up over the stock before plunging. See heights.js.
  const rawFeedPlane = entryPlane(params, zEntry, z);
  const feedPlane = rawFeedPlane == null ? null : Math.min(rawFeedPlane, home);
  const walk = tabs && tabs.count > 0 && tabs.height > 0
    ? (l, depth) => cutPerimeterWithTabs(cl, l, depth, tabs)
    : (l, depth) => cutPerimeter(cl, l, depth);

  if (atDepth && inPts.length === 0) {
    // One stepover across, at depth, and straight on round. The bite is the
    // same one the ring itself takes, so there is nothing to ramp through and
    // nothing to lift over.
    cl.cut(loop[0], loop[1], z);
    walk(loop, z);
  } else if (inPts.length === 0) {
    cl.rapid(loop[0], loop[1], home);
    // ramp-in then walk with tabs applied only at final depth
    cutLoopWithRamp(cl, loop, zEntry, z, params.rampAngle ?? 0,
      { walkPerimeter: walk, feedPlane });
  } else {
    /**
     * A lead-in is where the pass enters the wall. It is not where the pass
     * gets *down*, and those were the same statement here: the tool arced in at
     * full depth, which meant it had plunged straight down a whole stepdown
     * first. "Ramp angle" was on the panel, defaulted to 3°, and did nothing
     * whenever a lead was in use — which is every contour, because `arc` is the
     * default lead.
     *
     * So the descent happens the way it does without a lead — round the loop at
     * the angle asked for — and the lead-in is walked at the level above,
     * through metal the previous level already took away. The lap at depth that
     * follows is what finishes the wall, exactly as before.
     */
    const rampAngle = params.rampAngle ?? 0;
    const ramping = rampAngle > 0 && zEntry > z + 1e-9;
    const entryZ = ramping ? zEntry : z;
    const [sx, sy] = inPts[0];
    approach(cl, sx, sy, entryZ, { clearance: home, feedPlane });
    for (let i = 1; i < inPts.length; i++) cl.cut(inPts[i][0], inPts[i][1], entryZ, FEED.LEAD);
    cl.cut(loop[0], loop[1], entryZ, FEED.LEAD);
    // The lead-out is taken from the loop the ramp actually finished on: when
    // the descent reaches depth partway round, the closing lap starts and ends
    // there rather than at loop[0], and leading out of the wrong point re-cuts
    // the wall backwards. See cutLoopWithRamp.
    const finished = ramping
      ? cutLoopWithRamp(cl, loop, zEntry, z, rampAngle,
        { walkPerimeter: walk, feedPlane, alreadyThere: true })
      : (walk(loop, z), loop);
    emitLeadOut(cl, finished, z, passLead);
  }

  if (exit != null) cl.rapid(...lastXY(cl), exit);
  return true;
}

/**
 * Cut one closed loop down its whole depth in a single continuous descent.
 *
 * Level by level, a contour leads in, ramps down one stepdown, walks the lap,
 * leads out, retracts over the stock, and comes back for the next level — the
 * "in and out every step" the panel complaint is about. But a closed loop ends
 * a lap where it began, so between levels the tool is already standing on the
 * wall it is about to take deeper. There is nothing to retract for and nowhere
 * to travel to: it drops one stepdown in place and carries on round.
 *
 * So the lead-in and lead-out happen once each — at the very top and the very
 * bottom — and everything between is one helix down the loop. The tool never
 * leaves the wall, which is the whole point: a first attempt at this instead
 * left the tool down and then *rapided laterally at depth* back to the lead-in
 * point, straight through the part. It does not travel between passes at all.
 *
 * Only correct where the loop is the same shape at every depth — one outline,
 * no depth-varying region clipping. The caller (`continuous`) enforces that.
 *
 * @param zTop the top of the cut; the first pass enters from here
 * @param passes the depths to cut, top to bottom (the last is the floor)
 * @returns whether anything was emitted
 */
function cutLoopColumn(cl, rawLoop, zTop, passes, {
  clearance, direction, lead, params, tabs, tabTop, crossAt,
}) {
  if (rawLoop.length / 2 < 3 || passes.length === 0) return false;
  const zBottom = passes[passes.length - 1];
  // The plane the tool lifts to when the loop is done and it may cross to
  // another — above the stock, or clearance when clamps rule a low plane out.
  const home = crossAt != null && crossAt > zBottom + 1e-9
    ? Math.min(crossAt, clearance) : clearance;
  const rampAngle = params.rampAngle ?? 0;
  const loop0 = orderLoopForEntry(rawLoop, direction, lead,
    cl.count > 0 ? lastXY(cl) : null, 0);
  const passLead = leadOnLoop(loop0, resolveLead(rawLoop, lead));
  const inPts = leadInPoints(loop0, passLead);

  // Tabs apply to any pass cutting into the tab band, exactly as level by level.
  const walkerFor = (z) => (tabs && tabs.count > 0 && tabs.height > 0 && z < tabTop - 1e-9
    ? (l, depth) => cutPerimeterWithTabs(cl, l, depth, tabs)
    : (l, depth) => cutPerimeter(cl, l, depth));

  let current = loop0;   // the loop as last walked; the ramp rotates its start
  let from = zTop;
  passes.forEach((z, idx) => {
    const walk = walkerFor(z);
    if (idx === 0) {
      // First pass: enter the wall the way a lone pass does — a lead-in walked
      // through the metal above, or a ramp down from the travel plane. This is
      // the one place the tool comes down from clearance.
      const rawFeedPlane = entryPlane(params, from, z);
      const feedPlane = rawFeedPlane == null ? null : Math.min(rawFeedPlane, home);
      if (inPts.length === 0) {
        cl.rapid(loop0[0], loop0[1], home);
        current = cutLoopWithRamp(cl, loop0, from, z, rampAngle,
          { walkPerimeter: walk, feedPlane });
      } else {
        const ramping = rampAngle > 0 && from > z + 1e-9;
        const entryZ = ramping ? from : z;
        const [sx, sy] = inPts[0];
        approach(cl, sx, sy, entryZ, { clearance: home, feedPlane });
        for (let i = 1; i < inPts.length; i++) cl.cut(inPts[i][0], inPts[i][1], entryZ, FEED.LEAD);
        cl.cut(loop0[0], loop0[1], entryZ, FEED.LEAD);
        current = ramping
          ? cutLoopWithRamp(cl, loop0, from, z, rampAngle,
            { walkPerimeter: walk, feedPlane, alreadyThere: true })
          : (walk(loop0, z), loop0);
      }
    } else {
      // Every pass after: the tool is standing on `current` at `from`, the level
      // just cut. Drop one stepdown into that slot right where it is and keep
      // going round — no lead, no retract, no travel. `alreadyThere` is what
      // tells the ramp not to lift first.
      current = cutLoopWithRamp(cl, current, from, z, rampAngle,
        { walkPerimeter: walk, alreadyThere: true });
    }
    from = z;
  });

  // Out of the wall once, then up to the travel plane for the move to the next
  // loop (or home, if this was the last).
  emitLeadOut(cl, current, zBottom, passLead);
  cl.rapid(...lastXY(cl), home);
  return true;
}

/**
 * Which of the part's profiles this operation cuts.
 *
 * The silhouette at a depth is every boundary the part presents there: its
 * outline, and a loop around each hole and pocket inside it. Cutting all of
 * them is right for a part whose every feature is an open profile, and wrong
 * for the commonest job there is — "cut this part out of the sheet" — where it
 * sends the tool into every bore on the way.
 *
 *   outer — the outline of each island, holes discarded. The cut-out.
 *   all   — every boundary, inside and out.
 */
export function selectProfiles(shadow, profile) {
  if (profile !== 'outer' || shadow.length === 0) return shadow;
  const outers = unionWithHoles(shadow).map((region) => region.outer);
  return outers.length ? outers : shadow;
}

/**
 * Which way to step off the profile.
 *
 * Outside leaves the loop standing and is how a part is cut out; inside opens
 * the loop up and is how a bore or a slot is brought to size; on drives the
 * tool centre down the line itself, for engraving and for a cut the user has
 * already compensated.
 */
export function offsetFor(side, radius, allowance) {
  if (side === 'inside') return -(radius + allowance);
  if (side === 'on') return 0;
  return radius + allowance;
}

/**
 * The tabs an operation asks for, in the terms the cutter needs.
 *
 * `width` is the standing material the user wants; the lift window that leaves
 * it is wider by the cutter's diameter, which is why the tool has to be known
 * here. `topZ` fixes the tab top as one plane above the profile floor rather
 * than a height above whichever pass is running.
 */
function tabConfig(params, tool) {
  return {
    count: Math.max(0, Math.round(params.tabCount ?? 0)),
    width: Math.max(0, params.tabWidth ?? 0),
    height: Math.max(0, params.tabHeight ?? 0),
    toolDiameter: tool?.diameter ?? 0,
    topZ: params.bottomZ + Math.max(0, params.tabHeight ?? 0),
  };
}

/** An open span left over after region clipping: plunge in, cut it, retract. */
export function cutOpenPass(cl, path, z, { clearance, feedPlane = null }) {
  if (path.length < 4) return false;
  approach(cl, path[0], path[1], z, { clearance, feedPlane });
  for (let i = 1; i < path.length / 2; i++) cl.cut(path[i * 2], path[i * 2 + 1], z);
  cl.rapid(...lastXY(cl), clearance);
  return true;
}
