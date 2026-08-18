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

/**
 * The lower of two travel heights, either of which may be absent.
 *
 * `crossingPlane` and `entryPlane` both answer null for "no opinion", and null
 * is not a height: `Math.min(null, x)` is 0, which is the floor of the cut
 * rather than a plane above it.
 */
function lowerPlane(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

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
      // The depth passes of one loop are a descent down a single slot, not a
      // series of separate visits to it. Once the top pass has cut the wall,
      // the slot beneath it is air the loop itself made, so the passes below
      // stay down (`exitAt`) and each descends from an entry gap above the
      // level the one before it left — not from the plane over the billet the
      // tool arrived at first. Climbing back over the stock to travel a few
      // millimetres round the same profile, once per stepdown, is the "in and
      // out every step" the retract used to be: on a 20mm cut-out at a 3mm
      // stepdown it grew 4, 7, 10mm as the cut deepened, all of it air.
      const passes = [...depthPasses(from, z, params.stepdown)];
      passes.forEach((zz, i) => {
        const useTabsHere = (useTabs && zz <= z + 1e-9) || zz < tabTop - 1e-9;
        const continues = i < passes.length - 1;
        // Where this pass *descends* from. The first arrives over the billet;
        // every one after it drops into the slot the pass above just cut, so it
        // need only clear that level by an entry gap.
        const descendFrom = i === 0 ? crossAt
          : lowerPlane(crossAt, entryPlane(params, from, zz));
        // Where it *leaves* the tool. A continuing pass stays down for the next
        // one; the last pass lifts back to the travel plane, because the tool
        // may now cross to another loop — retracting only into this slot would
        // drag it through whatever stands between the two. With clamps in the
        // setup there is no safe low plane (crossAt is null), so the last pass
        // goes all the way to clearance, which is the height that clears them.
        const leaveAt = continues ? zz : (crossAt ?? clearance);
        if (cutLoopPass(cl, loop, from, zz, {
          clearance, direction, lead, params, tabs: useTabsHere ? tabs : null,
          crossAt: descendFrom, exitAt: leaveAt,
        })) { any = true; surface.covered(loop); }
        from = zz;
      });
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
  if (perLevel) {
    // The outline is re-read at every depth, so each level is a different set of
    // loops and has to be planned on its own — level by level, top down.
    levels.forEach((z, i) => {
      finalShadow = silhouette.down(z);
      const isFinal = i === levels.length - 1;
      const cutsIntoTab = z < tabTop - 1e-9;
      surface.beginLevel();
      if (emitLevel(finalShadow, stockToLeave, z, isFinal || cutsIntoTab)) cutAnything = true;
      surface.endLevel(z);
    });
  } else {
    // One outline for the whole cut: the loops are the same at every depth, so
    // each is taken top to bottom in one descent rather than the whole set being
    // visited once per level. That is what lets a loop's passes link into a
    // continuous step-down (see the closed-loop pass above) instead of the tool
    // climbing out and back in between every stepdown.
    finalShadow = partShadow;
    surface.beginLevel();
    if (emitLevel(finalShadow, stockToLeave, params.bottomZ, true)) cutAnything = true;
    surface.endLevel(params.bottomZ);
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
