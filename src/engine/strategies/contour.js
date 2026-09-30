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

import { CLBuilder, FEED, lastXY, lastZ } from '../cl.js';
import { plural, pluralEs } from '../text.js';
import { mergeTolerance } from '../simplify.js';
import {
  offsetLoops, loopArea, unionWithHoles, diffLoops,
} from '../../geom/clipper.js';
import { SilhouetteStack, silhouetteAbove } from '../../geom/silhouette.js';
import { depthPasses } from '../stock.js';
import {
  cutLoopWithRamp, cutPerimeter, orderByProximity, startNearest, startNearestSlide,
} from '../linking.js';
import {
  orientLoop, leadInPoints, leadOutPoints, emitLeadOut,
  internalLeadStart, startOnSegment, leadOnLoop, leadRoomFor, leadFits, roomOutside,
} from '../leads.js';
import { applyRegionsToPaths, regionRefusal } from '../regions.js';
import { approach, entryPlane, crossingPlane, goHome } from '../heights.js';
import { applyCutting } from '../cutting.js';
import {
  cutPerimeterWithTabs, spansBetweenTabs, tabAnchors, tabLift, startClearOfTabs,
} from '../tabs.js';
import { Ground, sweptBy } from '../ground.js';
import { fluteLengthOf } from '../tool-geometry.js';

export function generateContour({
  mesh, tool, params, regions, stock, fixtures,
}) {
  const r = tool.diameter / 2;
  const stockToLeave = params.stockToLeave ?? 0;
  const clearance = params.clearanceHeight;
  const tolerance = params.tolerance ?? 0.01;
  const direction = params.direction ?? 'climb';
  const lead = {
    type: params.leadType ?? 'none',
    radius: params.leadRadius ?? 0,
    // a tool working from inside the outline is cutting an opening — see resolveLead
    cavity: (params.side ?? 'outside') === 'inside',
  };
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
  // What has been cut so far and how deep: where every pass below asks how high
  // the metal stands before it comes down, and before it swings a lead through
  // it. See engine/ground.js.
  const ground = new Ground({ stock, topZ: params.topZ });
  const entry = {
    ground,
    radius: r,
    // how much standing metal a lead may take with the side of the cutter: what
    // one level takes, with a quarter to spare
    limit: 1.25 * Math.max(0.05, params.stepdown ?? 1),
    dropped: 0,       // leads left off, for the note below
  };
  // Leads left off because they would have swung into the part — see leadRoomFor.
  const leadNotes = { gouged: 0 };
  const roomFor = (raw) => contourLeadRoom(raw, side, regions, r, tolerance, stock, leadNotes);
  let finalShadow = null;
  const clip = { radius: r, tolerance };
  const side = params.side ?? 'outside';
  const tabs = tabConfig(params, tool);
  if (tabs.count > 0 && tabs.height > 0) {
    // Where the tabs are, once, on the outline the last pass cuts to size — and
    // every lap below the tab top, rough or finish, lifts over those places.
    const finished = offsetLoops(
      selectProfiles(silhouetteAbove(mesh, params.bottomZ, { tolerance }), params.profile ?? 'outer'),
      offsetFor(side, r, 0), tolerance);
    tabs.anchors = tabAnchors(finished, tabs.count);
    // a lap round the same profile is its allowance off it, at most
    tabs.reach = stockToLeave + r + tolerance;
  }
  // Boundaries the cutter was too big to go round, counted for the note below.
  let dropped = 0;
  // Loops started again from the top of the metal rather than from the level
  // above — see emitLevel.
  let restarted = 0;
  const emitLevel = (shadow, allowance, z, useTabs, zAbove) => {
    const profiles = selectProfiles(shadow, params.profile ?? 'outer');
    const raw = offsetLoops(profiles, offsetFor(side, r, allowance), tolerance);
    // Offsetting a boundary inward by more than its own half-width collapses
    // it, which is the honest answer — a ⌀12 cutter cannot go round a ⌀4.5
    // hole. Saying nothing is not: asking for every profile on this part and
    // getting a program byte-identical to "outer profile only" reads as a
    // setting that does not work. See the note where this is reported.
    if (raw.length < profiles.length) dropped = Math.max(dropped, profiles.length - raw.length);
    const { closed, open } = applyRegionsToPaths(raw, regions, { ...clip, z });
    const leadRoom = lead.type !== 'none' && closed.length ? roomFor(raw) : null;
    let any = false;
    // nearest first, from wherever the tool finished the level above — the
    // offsetter's own order has no relation to where anything is
    for (const loop of orderByProximity(closed, cl.count > 0 ? lastXY(cl) : null)) {
      // Per loop, not per level: in `level` mode the outline is re-read at every
      // depth, so a loop that appears when the cross-section changes is the
      // first thing ever to visit that line and the stock there is untouched.
      // Taking it in one pass is a cut as deep as the whole operation — 15mm
      // with a ⌀6 cutter on the step plate, 23mm on the sloped one — so it is
      // stepped down to like any other.
      //
      // From as high as the metal stands anywhere under the pass, which is not
      // the same question as whether the pass above ran near it. That was the
      // test, and a loop the outline had pushed out by less than a radius passed
      // it everywhere while the cutter stuck out past the pass above into metal
      // standing the full height of the billet: on the clamp part a rapid 5mm
      // into it and then 9mm taken at once, three levels in one.
      let from = entryHeight(ground, sweptBy(loop, r, true), z, params.topZ);
      if (from > zAbove + 1e-9) restarted++;
      for (const zz of depthPasses(from, z, params.stepdown)) {
        const useTabsHere = (useTabs && zz <= z + 1e-9) || zz < tabTop - 1e-9;
        if (cutLoopPass(cl, loop, from, zz, {
          clearance, direction, lead, params, tabs: useTabsHere ? tabs : null, crossAt, entry, leadRoom,
        })) any = true;
        from = zz;
      }
    }
    for (const path of open) {
      let from = entryHeight(ground, sweptBy(path, r), z, params.topZ);
      for (const zz of depthPasses(from, z, params.stepdown)) {
        if (cutOpenPass(cl, path, zz, {
          clearance, feedPlane: entryPlane(params, from, zz), entry, zEntry: from, params,
        })) {
          any = true;
        }
        from = zz;
      }
    }
    return any;
  };
  // One finish pass: every profile `allowance` off the part, each taken at the
  // depths in `laps`, top first. `step` is how much of the wall it takes — how
  // far back the pass before it ran, which is where it may come down.
  const emitFinish = (shadow, allowance, laps, step) => {
    const profiles = selectProfiles(shadow, params.profile ?? 'outer');
    const raw = offsetLoops(profiles, offsetFor(side, r, allowance), tolerance);
    const { closed, open } = applyRegionsToPaths(raw, regions, { ...clip, z: params.bottomZ });
    const leadRoom = lead.type !== 'none' && closed.length ? roomFor(raw) : null;
    let any = false;
    for (const loop of orderByProximity(closed, cl.count > 0 ? lastXY(cl) : null)) {
      for (const zz of laps) {
        if (cutLoopPass(cl, loop, zz, zz, {
          clearance, direction, lead, params, tabs: zz < tabTop - 1e-9 ? tabs : null, crossAt,
          entry, stepIn: step, leadRoom,
        })) any = true;
      }
    }
    for (const path of open) {
      for (const zz of laps) {
        if (cutOpenPass(cl, path, zz, {
          clearance, feedPlane: entryPlane(params, zz, zz), entry, zEntry: zz, stepIn: step, params,
        })) any = true;
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
    const leadRoom = lead.type !== 'none' && closed.length ? roomFor(raw) : null;
    // Each closed loop is one continuous descent.
    for (const loop of orderByProximity(closed, cl.count > 0 ? lastXY(cl) : null)) {
      if (cutLoopColumn(cl, loop, params.topZ, levels, {
        clearance, direction, lead, params, tabs, tabTop, crossAt, entry, leadRoom,
      })) cutAnything = true;
    }
    // A loop an avoid region has cut open cannot spiral; take it level by level.
    for (const path of open) {
      let from = params.topZ;
      for (const zz of levels) {
        if (cutOpenPass(cl, path, zz, {
          clearance, feedPlane: entryPlane(params, from, zz), entry, zEntry: from, params,
        })) {
          cutAnything = true;
        }
        from = zz;
      }
    }
  } else {
    levels.forEach((z, i) => {
      finalShadow = perLevel ? silhouette.down(z) : partShadow;
      const isFinal = i === levels.length - 1;
      const cutsIntoTab = z < tabTop - 1e-9;
      const zAbove = i > 0 ? levels[i - 1] : params.topZ;
      if (emitLevel(finalShadow, stockToLeave, z, isFinal || cutsIntoTab, zAbove)) cutAnything = true;
    });
  }

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
    // Finish passes peel the allowance off at final depth, so the wall is cut by
    // a tool that is no longer buried in stock. Each takes what the one before
    // it left — `step` of the wall, standing the whole height of the cut — which
    // makes it the one pass in the operation that is *meant* to have metal the
    // full depth beside it, and it is entered for that: down beside the wall,
    // not onto it (see cutLoopPass `stepIn`). Entered like any other pass, it
    // rapided down onto its own allowance: 22mm down the side of the boss.
    //
    // And no more of the wall in one lap than the flutes reach. The whole wall
    // at once put 3mm of the allowance on the shank of a ⌀6 with 20mm of flute,
    // 23mm down the boss — so a wall taller than the flutes is taken in as few
    // laps as reach it, the top first.
    const step = stockToLeave / finishPasses;
    const laps = finishLaps(params.topZ, params.bottomZ, fluteLengthOf(tool));
    for (let i = 1; i <= finishPasses; i++) {
      const remaining = stockToLeave * (1 - i / finishPasses);
      if (emitFinish(finalShadow, remaining, laps, step)) cutAnything = true;
    }
    if (laps.length > 1) {
      cl.info(`the finish passes take the wall in ${laps.length} laps: it is `
        + `${(params.topZ - params.bottomZ).toFixed(1)}mm deep and the cutter has `
        + `${fluteLengthOf(tool).toFixed(1)}mm of flute — in one lap the shank would rub `
        + 'the allowance off the top of it.');
    }
  }

  if (leadNotes.gouged > 0 && cutAnything) {
    cl.info(`the ${lead.type} lead is left off ${plural(leadNotes.gouged, 'pass', 'passes')} `
      + 'where it would have swung into the part or a clamp — a smaller lead radius keeps it.');
  }
  if (entry.dropped > 0 && cutAnything && lead.type !== 'none') {
    cl.info(`the ${lead.type} lead is left off ${plural(entry.dropped, 'pass', 'passes')} `
      + 'where it would come down on, or swing through, metal no pass had cut to that '
      + 'depth — the pass comes in and goes out along its own line instead. Rough the '
      + 'outside first to keep them.');
  }
  if (restarted > 1 && cutAnything) {
    cl.info(`${plural(restarted, 'loop')} started again from the top of the stock: the `
      + 'outline at that depth reaches past the one above it, into metal no pass had cut, '
      + 'and one pass would have taken all of it at once. On a sloped or drafted wall that '
      + 'is every level — Follow: part cuts the widest outline once, top to bottom.');
  }
  if (dropped > 0 && cutAnything) {
    cl.info(`${dropped} boundary/boundaries left uncut — a ⌀${tool.diameter} cutter does `
      + 'not fit round them. Use a smaller cutter, or bore them.');
  }
  if (!cutAnything) {
    // A pick that leaves the pass nowhere to go is not a heights problem, and
    // sending somebody to the Heights tab for it wastes their time in the one
    // tab that is not the cause — see engine/regions.js regionRefusal.
    const why = regionRefusal(regions, r, tolerance);
    cl.warn(why
      ? `contour produced no passes — ${why}`
      : 'contour produced no passes — check Top Z and Bottom Z');
  }
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
 *
 * The winding means what it says for a part: an outline encloses metal and a
 * hole encloses air. Tool side *inside* reads the same shape the other way
 * round — the cutter works from inside the outline, opening it up, so the
 * outline encloses the air the tool is in and the wall is outside it, and an
 * island in it is metal. `lead.cavity` says so. Left to the winding, every
 * pass round such an opening ran the wrong way for its direction (a "climb"
 * cut was a conventional one) and its lead curled out into the wall, where the
 * room check found it did not fit and quietly dropped it.
 */
export function resolveLead(rawLoop, lead) {
  const hole = loopArea(rawLoop) < 0;
  return { ...lead, materialOutside: lead?.materialOutside ?? (lead?.cavity ? !hole : hole) };
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
 * @param options.entry `{ ground, radius, limit, dropped }` — what the
 *   operation has cut so far (engine/ground.js), asked before the pass comes
 *   down anywhere or swings a lead through anything, and told what the pass
 *   cut. Without it the pass takes the caller's word that the ground under it
 *   stands at `zEntry`.
 * @param options.stepIn a finish pass: how far the pass before it ran from the
 *   wall, beyond this one — the line it may come down on when its own start is
 *   standing in the allowance it is there to take off.
 * @param options.leadRoom where a lead may take the tool centre at this depth —
 *   see leadRoomFor. A lead that would leave it is left off.
 */
export function cutLoopPass(cl, rawLoop, zEntry, z, {
  clearance, direction, lead, params, tabs, crossAt = null, exitAt = null,
  atDepth = false, runIn = 0, entry = null, stepIn = 0, leadRoom = null,
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
  // A pass comes down, and steps onto the wall, where it starts: not on a tab.
  const loop = startClearOfTabs(orderLoopForEntry(rawLoop, direction, lead,
    cl.count > 0 ? lastXY(cl) : null, runIn), tabs);
  const resolved = resolveLead(rawLoop, lead);
  const passLead = leadOnLoop(loop, resolved);
  let inPts = leadInPoints(loop, passLead);
  const rampAngle = params.rampAngle ?? 0;
  const ramping = rampAngle > 0 && zEntry > z + 1e-9;
  const entryZ = ramping ? zEntry : z;
  // A lead swings off the pass into ground beside it, and has to come down
  // there first — see leadInAllowed for what that ground has to be. Before
  // that, it has to stay out of the part.
  if (inPts.length && !leadFits(leadRoom, leadPath(inPts, loop))) {
    inPts = [];
  } else if (inPts.length && entry && !leadInAllowed(entry, inPts, loop, zEntry, entryZ)) {
    inPts = [];
    entry.dropped++;
  }
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

  let finished = loop;        // the loop as the lap at depth walked it
  let across = null;          // where a finish pass came down beside the wall
  if (atDepth && inPts.length === 0) {
    // One stepover across, at depth, and straight on round. The bite is the
    // same one the ring itself takes, so there is nothing to ramp through and
    // nothing to lift over.
    cl.cut(loop[0], loop[1], z);
    walk(loop, z);
  } else if (inPts.length === 0) {
    // Down onto the pass itself — onto ground this pass is entered from, which
    // the caller vouches for and `entry`, where there is one, checks.
    let plane = feedPlane;
    const top = entry ? entry.ground.topUnder(loop[0], loop[1], entry.radius) : -Infinity;
    if (top > zEntry + 1e-9) {
      // Metal stands under the start higher than that. On a finish pass that is
      // the allowance it is there for, the full height of the wall: come down
      // on the line the pass before ran instead, and step across onto the wall
      // at depth. Anywhere else, or where that line is not clear either, feed
      // down from above the metal rather than rapid into it.
      across = stepIn > 0 && !ramping ? besideWall(entry, loop, resolved, stepIn, zEntry) : null;
      if (!across) plane = Math.min(entryPlane(params, top, z) ?? clearance, home);
    }
    if (across) {
      arrive(cl, across[0], across[1], home);
      approach(cl, across[0], across[1], z, { clearance: home, feedPlane: plane, positioned: true });
      cl.cut(loop[0], loop[1], z, FEED.LEAD);
      walk(loop, z);
    } else {
      arrive(cl, loop[0], loop[1], home);
      // ramp-in then walk with tabs applied only at final depth
      finished = cutLoopWithRamp(cl, loop, zEntry, z, params.rampAngle ?? 0,
        { walkPerimeter: walk, feedPlane: plane, lift: tabLift(loop, tabs, z) });
    }
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
     * the angle asked for — and the lead-in is walked at the level above. The
     * lap at depth that follows is what finishes the wall, exactly as before.
     */
    const [sx, sy] = inPts[0];
    arrive(cl, sx, sy, home);
    approach(cl, sx, sy, entryZ, { clearance: home, feedPlane, positioned: true });
    for (let i = 1; i < inPts.length; i++) cl.cut(inPts[i][0], inPts[i][1], entryZ, FEED.LEAD);
    cl.cut(loop[0], loop[1], entryZ, FEED.LEAD);
    entry?.ground.sweep(leadPath(inPts, loop), entry.radius, entryZ);
    // The lead-out is taken from the loop the ramp actually finished on: when
    // the descent reaches depth partway round, the closing lap starts and ends
    // there rather than at loop[0], and leading out of the wrong point re-cuts
    // the wall backwards. See cutLoopWithRamp.
    finished = ramping
      ? cutLoopWithRamp(cl, loop, zEntry, z, rampAngle,
        { walkPerimeter: walk, feedPlane, alreadyThere: true, lift: tabLift(loop, tabs, z) })
      : (walk(loop, z), loop);
  }
  if (entry) {
    if (across) entry.ground.sweep([...across, loop[0], loop[1]], entry.radius, z);
    recordLap(entry, finished, z, tabs);
  }
  if (inPts.length) leadOut(cl, finished, z, passLead, entry, leadRoom);

  if (exit != null) cl.rapid(...lastXY(cl), exit);
  return true;
}

/**
 * What a lap at `z` leaves: its slot cut down to `z`, except where it rode over
 * a tab, which is cut only down to the tab's top.
 */
function recordLap(entry, loop, z, tabs) {
  const slot = sweptBy(loop, entry.radius, true);
  if (!(tabs && tabs.count > 0 && tabs.height > 0)) {
    entry.ground.cut(slot, z);
    return;
  }
  entry.ground.cut(slot, Math.max(z, tabs.topZ ?? z + tabs.height));
  for (const span of spansBetweenTabs(loop, tabs)) entry.ground.sweep(span, entry.radius, z);
}

/**
 * A lead-out, where it stays out of the part and the ground beside the pass
 * allows one — straight up out of the slot otherwise. See leadFits and
 * sweepAllowed.
 */
function leadOut(cl, loop, z, passLead, entry, leadRoom) {
  const out = leadOutPoints(loop, passLead);
  if (out.length === 0) return;
  const path = [loop[0], loop[1]];
  for (const [x, y] of out) path.push(x, y);
  if (!leadFits(leadRoom, path)) return;
  if (entry && !sweepAllowed(entry, path, loop, z)) {
    entry.dropped++;
    return;
  }
  entry?.ground.sweep(path, entry.radius, z);
  emitLeadOut(cl, loop, z, passLead);
}

/**
 * A contour's lead room at one depth: everywhere but the part, round the
 * outside; inside the offset profile, cutting inside it; none on the line.
 */
function contourLeadRoom(raw, side, regions, r, tolerance, stock, notes) {
  if (side === 'on' || raw.length === 0) return null;
  if (side !== 'inside') return roomOutside(raw, { stock, regions, radius: r, tolerance, notes });
  const allowed = regions?.avoid?.length
    ? diffLoops(raw, offsetLoops(regions.avoid, r, tolerance)) : raw;
  return leadRoomFor(allowed, notes);
}

/** A lead-in's points and the loop start it lands on, as one flat path. */
function leadPath(points, loop) {
  const out = [];
  for (const [x, y] of points) out.push(x, y);
  out.push(loop[0], loop[1]);
  return out;
}

/**
 * Whether a lead-in may be walked: whether the ground beside the pass will take
 * it.
 *
 * A contour cuts a slot down a line, and a lead swings off that line into the
 * ground beside it — where nothing of this operation has been, unless a lead at
 * the level above swung through the same place. A single descent down the whole
 * loop has no leads between the top and the bottom, and the one it led out on
 * at the bottom swung through stock standing the full height of the cut — 23mm
 * deep, sideways, with the flutes and then the shank. A finishing lap at the
 * bottom had the same two arcs.
 *
 * Two things have to hold. The tool comes down at the start of the lead at
 * rapid, to an entry gap above `zEntry`, so nothing may stand under it higher
 * than that: a lead-in walked a level up, as it is when the pass ramps, sits
 * over ground the lead before it cut a level higher still — the level above
 * *that* — and a contour following its outline level by level rapided 1.9mm
 * into it at every level on the boss. And the lead then swings through ground
 * that may stand no more than a stepdown and a quarter above where it is
 * walked, the most one level leaves. What else the job may have cut there — a
 * roughing pass round the outside — this operation cannot know, so it does not
 * assume it: the lead is left off, the pass comes in along its own line, and
 * the operation says so.
 */
function leadInAllowed(entry, inPts, loop, zEntry, entryZ) {
  const { ground, radius } = entry;
  if (ground.topZ > zEntry + 1e-9 && ground.topUnder(inPts[0][0], inPts[0][1], radius) > zEntry + 1e-9) {
    return false;
  }
  return sweepAllowed(entry, leadPath(inPts, loop), loop, entryZ);
}

/**
 * Whether a lead along `path` may be walked at `z` beside a pass along `loop`:
 * the ground it sweeps, less the slot the pass cuts itself, stands no more than
 * `entry.limit` above `z`. What a tangent departure leaves between the arc and
 * the slot is a sliver the edge of the cutter grazes — see ground.js GRAZE.
 */
function sweepAllowed(entry, path, loop, z) {
  const { ground, radius, limit } = entry;
  // within a level of the top, nothing can stand higher than a level
  if (ground.topZ <= z + limit + 1e-9) return true;
  const beside = diffLoops(sweptBy(path, radius), sweptBy(loop, radius, true));
  return beside.length === 0 || ground.topIn(beside) <= z + limit + 1e-9;
}

/**
 * Where a finish pass may come down instead of on its own start: the nearest
 * point of the line the pass before it ran, `step` further from the wall on the
 * side the metal is not — if the ground there really is clear down to `z`.
 */
function besideWall(entry, loop, resolved, step, z) {
  // round a boss the pass before ran outside this one; round a hole, inside it
  const previous = offsetLoops([loop], resolved.materialOutside ? -step : step, 0.001);
  const near = nearestOnLoops(previous, loop[0], loop[1]);
  if (!near) return null;
  return entry.ground.topUnder(near[0], near[1], entry.radius) > z + 1e-9 ? null : near;
}

/** The nearest point on any of `loops` (closed) to (x, y), or null when there are none. */
function nearestOnLoops(loops, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const loop of loops) {
    const n = loop.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = loop[i * 2];
      const ay = loop[i * 2 + 1];
      const dx = loop[j * 2] - ax;
      const dy = loop[j * 2 + 1] - ay;
      const lenSq = dx * dx + dy * dy;
      let t = lenSq > 0 ? ((x - ax) * dx + (y - ay) * dy) / lenSq : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + dx * t;
      const py = ay + dy * t;
      const d = Math.hypot(x - px, y - py);
      if (d < bestD) { bestD = d; best = [px, py]; }
    }
  }
  return best;
}

/**
 * The height a pass along `sweep` has to start from: as high as the metal
 * stands anywhere under it, and never above the top of the cut or below the
 * pass itself.
 */
function entryHeight(ground, sweep, z, topZ) {
  return Math.max(z, Math.min(topZ, ground.topIn(sweep)));
}

/**
 * The depths a finish pass takes the wall at: all of it at the bottom when the
 * flutes reach the top of it, otherwise as few equal laps as they reach, the
 * top one first.
 */
export function finishLaps(topZ, bottomZ, flute) {
  const height = topZ - bottomZ;
  if (!(flute > 0) || height <= flute + 1e-9) return [bottomZ];
  const n = Math.ceil(height / flute - 1e-9);
  const laps = [];
  for (let i = 1; i < n; i++) laps.push(topZ - (height * i) / n);
  laps.push(bottomZ);
  return laps;
}

/**
 * Get over (x, y) at `home`, ready to start a pass — and never go *down* to it
 * at rapid.
 *
 * `home` is a link height, planned from the part: clear of everything the part
 * puts between here and there, by an entry gap. What it cannot see is what the
 * passes themselves leave, and a pass arriving *lower* than the one before it
 * left is coming down beside the wall the last pass cut — through the cusp
 * between the two, which is exactly the metal the part does not know about.
 * Waterline does this at every level: the tool stood at one level, the link to
 * the next came back a hair below it, and the step down was a rapid 0.2mm into
 * the scallop the last level left.
 *
 * So a descending arrival travels at the height it is already at, which clears
 * everything the link does and more, and feeds the rest of the way down.
 */
function arrive(cl, x, y, home) {
  const here = lastZ(cl);
  if (here == null || !(here > home + 1e-9)) {
    cl.rapid(x, y, home);
    return;
  }
  cl.rapid(x, y, here);
  cl.cut(x, y, home, FEED.PLUNGE);
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
  clearance, direction, lead, params, tabs, tabTop, crossAt, entry = null, leadRoom = null,
}) {
  if (rawLoop.length / 2 < 3 || passes.length === 0) return false;
  const zBottom = passes[passes.length - 1];
  // The plane the tool lifts to when the loop is done and it may cross to
  // another — above the stock, or clearance when clamps rule a low plane out.
  const home = crossAt != null && crossAt > zBottom + 1e-9
    ? Math.min(crossAt, clearance) : clearance;
  const rampAngle = params.rampAngle ?? 0;
  const loop0 = startClearOfTabs(orderLoopForEntry(rawLoop, direction, lead,
    cl.count > 0 ? lastXY(cl) : null, 0), tabs);
  const passLead = leadOnLoop(loop0, resolveLead(rawLoop, lead));
  let inPts = leadInPoints(loop0, passLead);
  // walked at the top when the descent ramps, at the first level when it does not
  const inZ = (params.rampAngle ?? 0) > 0 && zTop > passes[0] + 1e-9 ? zTop : passes[0];
  if (inPts.length && !leadFits(leadRoom, leadPath(inPts, loop0))) {
    inPts = [];
  } else if (inPts.length && entry && !leadInAllowed(entry, inPts, loop0, zTop, inZ)) {
    inPts = [];
    entry.dropped++;
  } else if (inPts.length) {
    entry?.ground.sweep(leadPath(inPts, loop0), entry.radius, inZ);
  }

  // Tabs apply to any pass cutting into the tab band, exactly as level by level.
  const walkerFor = (z) => (tabs && tabs.count > 0 && tabs.height > 0 && z < tabTop - 1e-9
    ? (l, depth) => cutPerimeterWithTabs(cl, l, depth, tabs)
    : (l, depth) => cutPerimeter(cl, l, depth));

  let current = loop0;   // the loop as last walked; the ramp rotates its start
  let from = zTop;
  // …and so do the ramps down to it: see tabs.js tabLift
  const liftFor = (l, z) => (walkerUsesTabs(tabs, z, tabTop) ? tabLift(l, tabs, z) : null);
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
          { walkPerimeter: walk, feedPlane, lift: liftFor(loop0, z) });
      } else {
        const ramping = rampAngle > 0 && from > z + 1e-9;
        const entryZ = ramping ? from : z;
        const [sx, sy] = inPts[0];
        approach(cl, sx, sy, entryZ, { clearance: home, feedPlane });
        for (let i = 1; i < inPts.length; i++) cl.cut(inPts[i][0], inPts[i][1], entryZ, FEED.LEAD);
        cl.cut(loop0[0], loop0[1], entryZ, FEED.LEAD);
        current = ramping
          ? cutLoopWithRamp(cl, loop0, from, z, rampAngle,
            { walkPerimeter: walk, feedPlane, alreadyThere: true, lift: liftFor(loop0, z) })
          : (walk(loop0, z), loop0);
      }
    } else {
      // Every pass after: the tool is standing on `current` at `from`, the level
      // just cut. Drop one stepdown into that slot right where it is and keep
      // going round — no lead, no retract, no travel. `alreadyThere` is what
      // tells the ramp not to lift first.
      current = cutLoopWithRamp(cl, current, from, z, rampAngle,
        { walkPerimeter: walk, alreadyThere: true, lift: liftFor(current, z) });
    }
    from = z;
  });

  // Out of the wall once, then up to the travel plane for the move to the next
  // loop (or home, if this was the last).
  //
  // Once is at the bottom, which is the one depth nothing beside the loop has
  // been cut to: the descent was a single helix, so the only ground cleared at
  // the bottom is the slot it cut. Swung out of it across a plate bigger than
  // the part, the arc took the whole depth with the side of the cutter — 23mm
  // on the step plate turned 30°, past the end of the flutes. Where that is what
  // it would do, the tool comes straight up out of the slot instead.
  // what the descent leaves is what its last lap leaves: every lap above it
  // was cut deeper by the one below, tabs and all
  if (entry) recordLap(entry, current, zBottom, walkerUsesTabs(tabs, zBottom, tabTop) ? tabs : null);
  if (inPts.length) leadOut(cl, current, zBottom, passLead, entry, leadRoom);
  cl.rapid(...lastXY(cl), home);
  return true;
}

function walkerUsesTabs(tabs, z, tabTop) {
  return !!(tabs && tabs.count > 0 && tabs.height > 0 && z < tabTop - 1e-9);
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

/**
 * An open span left over after region clipping: plunge in, cut it, retract.
 *
 * With `entry`, the plunge is checked against what the operation has cut, the
 * way a closed pass's is (see cutLoopPass): a finish pass whose span starts in
 * its own allowance comes down `stepIn` back from the wall, on whichever side
 * the ground is clear, and steps across; anything else standing under the
 * start higher than `zEntry` is fed down onto rather than rapided into.
 */
export function cutOpenPass(cl, path, z, {
  clearance, feedPlane = null, entry = null, zEntry = z, stepIn = 0, params = null,
}) {
  if (path.length < 4) return false;
  let plane = feedPlane;
  let across = null;
  if (entry) {
    const top = entry.ground.topUnder(path[0], path[1], entry.radius);
    if (top > zEntry + 1e-9) {
      across = stepIn > 0 ? besideSpan(entry, path, stepIn, z) : null;
      if (!across) plane = params ? entryPlane(params, top, z) : null;
    }
  }
  if (across) {
    approach(cl, across[0], across[1], z, { clearance, feedPlane: plane });
    cl.cut(path[0], path[1], z, FEED.LEAD);
  } else {
    approach(cl, path[0], path[1], z, { clearance, feedPlane: plane });
  }
  for (let i = 1; i < path.length / 2; i++) cl.cut(path[i * 2], path[i * 2 + 1], z);
  if (entry) {
    if (across) entry.ground.sweep([...across, path[0], path[1]], entry.radius, z);
    entry.ground.sweep(path, entry.radius, z);
  }
  cl.rapid(...lastXY(cl), clearance);
  return true;
}

/**
 * besideWall for a span: `step` off its start, square to its first segment, on
 * the side where the ground is clear down to `z` — a span keeps no record of
 * which side of it the part is, and the ground does.
 */
function besideSpan(entry, path, step, z) {
  const [x0, y0, x1, y1] = path;
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (!(len > 0)) return null;
  const nx = -(y1 - y0) / len;
  const ny = (x1 - x0) / len;
  for (const s of [1, -1]) {
    const x = x0 + nx * step * s;
    const y = y0 + ny * step * s;
    if (!(entry.ground.topUnder(x, y, entry.radius) > z + 1e-9)) return [x, y];
  }
  return null;
}
