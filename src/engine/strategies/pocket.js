// Pocketing: clear the inside of a closed region down to depth.
//
// Where clear2d removes everything between the stock and the part, a pocket
// works the other way round — you name the area (by picking its floor face, or
// by letting the strategy find enclosed regions in the part) and it empties it.
//
// Enclosed regions are found from the silhouette: a hole in the shadow is a
// place the part is absent but surrounded, which is exactly a pocket. That
// means an unpicked pocket operation still does the obvious thing.

import { CLBuilder } from '../cl.js';
import { pluralEs } from '../text.js';
import { concentricRings } from '../rings.js';
import { mergeTolerance } from '../simplify.js';
import {
  offsetLoops, offsetNormalized, enclosedVoids, diffLoops, loopArea,
} from '../../geom/clipper.js';
import { SilhouetteStack } from '../../geom/silhouette.js';
import { depthLevelsFor } from '../stock.js';
import { applyRegionsToArea } from '../regions.js';
import {
  cutLoopPass, orderLoopForEntry, loopEntryPoint, loopExitPoint, resolveLead,
} from './contour.js';
import { pointInLoops, loopEnclosesAny } from '../../geom/inside.js';
import { applyCutting } from '../cutting.js';
import { crossingPlane, goHome, entryGapOf } from '../heights.js';

const MAX_PASSES = 500;

export function generatePocket({
  mesh, tool, params, regions, stock, fixtures,
}) {
  const r = tool.diameter / 2;
  const stockToLeave = params.stockToLeave ?? 0;
  const step = Math.max(0.1, (params.stepover ?? 0.4) * tool.diameter);
  const clearance = params.clearanceHeight;
  const tolerance = params.tolerance ?? 0.01;
  const direction = params.direction ?? 'climb';
  const lead = { type: params.leadType ?? 'none', radius: params.leadRadius ?? 0 };
  // how high a ring has to go to reach the next one — see engine/heights.js
  const crossAt = crossingPlane(params, stock, fixtures);

  const cl = new CLBuilder().simplify(mergeTolerance(tolerance));
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  const silhouette = new SilhouetteStack(mesh, { tolerance });
  let cutAnything = false;
  let sawRegion = false;      // a pocket existed, even if the tool would not fit
  let lastShadow = null;      // silhouette at final depth, for the finish passes

  // Every level first, each carrying the area the level *above* it emptied.
  //
  // That is the only ground a roughing pass may fly over below clearance, and
  // getting it from the part instead is a crash. `zLevelLinker` answers "how
  // high is the *part* here", which is exactly right for a finishing pass —
  // waterline runs after the roughing has taken the stock away — and wrong for
  // this one: where the part is absent the stock very often is not, and the
  // linker cheerfully returned a height one entry gap above the cut for a
  // traverse straight through uncut billet. A pocketing pass knows precisely
  // what it has emptied, because it emptied it.
  const levels = [];
  let zEntry = params.topZ;
  let clearedAbove = null;
  for (const z of depthLevelsFor(params, mesh, tool)) {
    const shadow = silhouette.down(z);
    const found = pocketArea(shadow, regions,
      { radius: r, tolerance, stockToLeave, z, minClearedWidth: step });
    if (found.raw) sawRegion = true;
    levels.push({ z, zEntry, area: found.area, clearedAbove, shadow });
    // Both of these only move when this level actually emptied something.
    // `zEntry` is the height the *next* level's ramp starts from, and a level
    // that found no region has taken nothing off: the pocket on the step plate
    // has a flat level at the boss top where no pocket is enclosed yet, and
    // carrying that level's Z down meant the pass below rapided to a feed plane
    // one millimetre inside the billet and then ramped a stepdown through 3mm
    // of standing stock — a full-width cut at three times the depth asked for.
    if (found.area.length) { clearedAbove = found.area; zEntry = z; }
    lastShadow = shadow;
  }

  // The highest the tool is ever asked to travel between passes. `crossAt` is
  // null when a clamp could be standing in the way, and then nothing below
  // clearance may be trusted — see heights.js.
  const ceiling = crossAt != null ? Math.min(crossAt, clearance) : clearance;
  const gap = entryGapOf(params);

  /**
   * How high to travel from `a` to `b`, both in this level.
   *
   * A gap above the floor the level above left, when the whole move stays
   * inside what that level emptied — the tool is then flying over ground it
   * cut itself, at a height it stood at while cutting it. Anything else is the
   * crossing plane, because a pocketing pass has no idea what is standing
   * outside its own pockets.
   */
  const linkFor = (level, a, b) => {
    if (!a || !level.clearedAbove?.length) return ceiling;
    return spanInside(level.clearedAbove, a, b, Math.max(r / 2, tolerance * 4, 0.05))
      ? Math.min(ceiling, level.zEntry + gap)
      : ceiling;
  };

  // Planned before any of it is emitted: a pass has to know the height it
  // *leaves* at as well as the one it arrives at, and that belongs to the move
  // to the pass after it. See waterline for the same two-phase shape.
  const passes = [];
  let from = null;            // where the previous pass finishes
  let fromZ = params.topZ;
  let slotLength = 0;         // how far the tool runs full width opening levels
  for (const level of levels) {
    const { z, zEntry: above, area, shadow } = level;
    if (area.length === 0) continue;

    // Concentric passes inward from the pocket wall, spaced to divide the
    // pocket rather than stepped off its wall — a fixed step leaves the last
    // pass taking whatever the division left over. See engine/rings.js.
    const rings = concentricRings(area, step, tolerance, r);

    // One pocket at a time, innermost ring first.
    //
    // The rings used to be emitted a *ring index* at a time — every pocket's
    // innermost ring, then every pocket's next one out — so a part with two
    // pockets had the tool crossing between them on every single step, climbing
    // to the crossing plane and back down for each crossing. Nine changes of
    // pocket to cut six rings, on a two-pocket test part. Grouping the rings by
    // the pocket that contains them costs nothing and the tool finishes what it
    // is in before it goes anywhere.
    for (const group of pocketGroups(rings, area, from)) {
      // The first pass of a group opens the level, and there is nowhere for the
      // chip to go while it does — see `pocketGroups`. How far it runs like
      // that is worth knowing, so it is added up rather than left to be found
      // in the metal.
      if (group.length) slotLength += perimeterOf(group[0].loop);
      let entered = false;
      for (const { loop, isWall } of group) {
        // Only the wall pass gets a lead — an inner ring is cutting stock, not
        // a surface. Which side the metal is on is a separate question and both
        // passes need it, because it also decides which way round climb milling
        // runs. See pocketSide.
        const passLead = pocketSide(loop, isWall ? lead : { type: 'none', radius: 0 }, shadow);
        // Already down and stepping across from the ring beside this one — see
        // the note on `atDepth` below, and engine/linking.js startNearestSlide
        // for why the step is spread along the loop rather than taken square.
        const slide = entered && !hasLead(passLead);
        const runIn = slide ? 2 * tool.diameter : 0;
        const ready = orderLoopForEntry(loop, direction, resolveLead(loop, passLead),
          from, runIn);
        const entry = loopEntryPoint(ready, passLead);
        // One entry per pocket per level, and the rest is a spiral.
        //
        // Every ring was entered on its own: lift, traverse, and ramp a whole
        // stepdown down into the next ring out — which reads at the machine as
        // the tool pecking its way outward, and is what "it ramps down again on
        // every step outwards" is. There is nothing to ramp through. Two
        // concentric rings are one stepover apart, the tool is already at depth,
        // and stepping across is the same bite the ring itself takes. So the
        // first ring of a pocket descends and the rest are joined at depth.
        const atDepth = slide;
        passes.push({
          z,
          // nothing to descend through: the tool is already down here
          zEntry: atDepth ? z : above,
          loop: ready,
          lead: passLead,
          atDepth,
          runIn,
          link: atDepth ? null : linkFor(level, from, entry),
        });
        from = loopExitPoint(ready, passLead);
        fromZ = z;
        entered = true;
      }
    }
  }

  for (let i = 0; i < passes.length; i++) {
    const p = passes[i];
    const next = passes[i + 1];
    if (cutLoopPass(cl, p.loop, p.zEntry, p.z, {
      clearance,
      direction,
      params,
      lead: p.lead,
      atDepth: p.atDepth,
      runIn: p.runIn,
      // arrive over this pass at the height that clears what is between here
      // and the last one — inside a pocket this operation has already opened,
      // that is a lift to just above its floor rather than over the whole billet
      crossAt: p.link,
      // and leave at the height the *next* pass arrives at, so the retract and
      // the traverse that follows it are the two ends of one move rather than a
      // diagonal that cuts the corner off whatever is between. A next pass that
      // steps across at depth wants no retract at all.
      exitAt: next ? (next.atDepth ? p.z : next.link) : ceiling,
    })) cutAnything = true;
  }

  // finish passes: re-walk the pocket wall at final depth with less and less
  // stock left on, so the wall is sized by a cutter that is not buried
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
  if (finishPasses > 0 && stockToLeave > 0 && lastShadow) {
    for (let i = 1; i <= finishPasses; i++) {
      const remaining = stockToLeave * (1 - i / finishPasses);
      const pass = pocketArea(lastShadow, regions,
        { radius: r, tolerance, stockToLeave: remaining, z: params.bottomZ, minClearedWidth: step });
      for (const loop of pass.area) {
        if (cutLoopPass(cl, loop, params.bottomZ, params.bottomZ, {
          clearance, direction, params, lead: pocketSide(loop, lead, lastShadow), crossAt,
        })) cutAnything = true;
      }
    }
  }

  if (!cutAnything) {
    // "nothing here" and "nothing this tool can reach" are very different
    // problems, and only one of them is fixed by picking a smaller cutter
    cl.warn(sawRegion
      ? `pocket found regions but none fit a ⌀${tool.diameter}mm tool — try a smaller cutter`
      : 'pocket found no enclosed region to clear — pick the pocket floor face, or use Z-level clearing');
  }
  // What the stepover cannot buy. Every level of a concentric pocket opens with
  // one pass that has material on both sides of it, and no ordering removes it
  // — the innermost ring is only the shortest place to put it. It is worth
  // saying out loud because it looks exactly like a setting that was ignored:
  // the operation is set to take 0.4 of the cutter and part of it takes all of
  // it. A narrow pocket is the bad case, because there the innermost ring is
  // nearly as long as the wall.
  if (cutAnything && slotLength > tool.diameter * 4) {
    cl.info(`${slotLength.toFixed(0)}mm of this is the pass that opens each level, `
      + 'which is a full-width cut whatever the stepover says — the middle of a '
      + 'fresh level has stock on both sides. Adaptive clearing spirals in '
      + 'instead and never takes more than the engagement it is set.');
  }
  goHome(cl, clearance);
  return cl.finish();
}

/**
 * This level's rings sorted into the pockets that contain them, each group
 * innermost ring first, and the groups themselves in travel order.
 *
 * A ring index is not a place: two pockets contribute a loop each to every ring,
 * and a part with an island contributes several. Emitting by ring index visits
 * every pocket on every step; emitting by pocket visits each one once.
 *
 * The pockets are the outer boundaries of the level's area — a hole in it is an
 * island standing inside a pocket, and its rings belong to the pocket around it.
 */
function pocketGroups(rings, area, from) {
  // Matched on the ring's *extent*, not on a point.
  //
  // The obvious test — is the ring's first vertex inside this pocket — is false
  // for exactly the ring that matters: the wall pass *is* the pocket boundary,
  // so its vertices lie on it, and a point on a loop is in neither side of it.
  // Every wall ring fell through to the first pocket, which put one pocket's
  // outermost pass in the middle of the other pocket's group and left the tool
  // crossing the part to cut it. Two disjoint pockets cannot overlap, so the box
  // a ring lives in answers the question without ever standing on a boundary.
  const outers = area.filter((loop) => loopArea(loop) > 0).map(boxOf);
  const groups = new Map();
  // Innermost first, which leaves the wall pass clean and last — and makes the
  // *first* pass of every level the shortest of the full-width ones.
  //
  // It used to say the tool is never fully buried here, which is not true and
  // was never true: a level is fresh stock, so the innermost ring has material
  // on both sides of it whatever order the rings are cut in. Concentric
  // pocketing has to start somewhere and wherever it starts is a slot; the
  // innermost ring is simply the shortest place to put it. Measured on a 36×20
  // pocket with a ⌀6: 97mm cut past 0.75xD, all of it the first pass of each
  // level. `pocketSlot` says so, and adaptive clearing is the way out.
  for (let k = rings.length - 1; k >= 0; k--) {
    for (const loop of rings[k]) {
      const box = boxOf(loop);
      let key = outers.findIndex((outer) => boxWithin(box, outer));
      if (key < 0) key = 0;             // no pocket claims it: one pocket, or an oddity
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ loop, isWall: k === 0 });
    }
  }
  // nearest first, so two pockets are done in the order the tool reaches them
  const out = [...groups.values()];
  if (out.length < 2) return out;
  const ordered = [];
  let at = from;
  while (out.length) {
    let best = 0;
    if (at) {
      let nearest = Infinity;
      out.forEach((group, i) => {
        const d = Math.hypot(group[0].loop[0] - at[0], group[0].loop[1] - at[1]);
        if (d < nearest) { nearest = d; best = i; }
      });
    }
    const group = out.splice(best, 1)[0];
    ordered.push(group);
    const last = group[group.length - 1].loop;
    at = [last[0], last[1]];
  }
  return ordered;
}

/** Does this pass enter through a lead-in arc rather than straight onto the loop? */
function hasLead(lead) {
  return (lead?.type ?? 'none') !== 'none' && (lead?.radius ?? 0) > 0;
}

/**
 * Does the straight move from `a` to `b` stay inside `loops` the whole way?
 *
 * Sampled, because what matters is the middle of the move and not its ends —
 * two points inside one pocket each say nothing about the wall between them.
 * The region is grown by a hair first: the ends of these moves are ring entry
 * points, and a ring *is* an offset of the area, so both ends sit exactly on a
 * boundary where `pointInLoops` is neither in nor out. An edge belongs to the
 * area it is the edge of — the same rule as engine/regions.js.
 */
function spanInside(loops, a, b, step) {
  const grown = offsetLoops(loops, 1e-3, 1e-3);
  const region = grown.length ? grown : loops;
  const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(span / Math.max(step, 1e-6)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (!pointInLoops(region, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) return false;
  }
  return true;
}

/** [minX, minY, maxX, maxY] of one flat loop. */
/** How far the tool travels round a closed loop. */
function perimeterOf(loop) {
  const n = loop.length / 2;
  let sum = 0;
  for (let i = 0, k = n - 1; i < n; k = i++) {
    sum += Math.hypot(loop[i * 2] - loop[k * 2], loop[i * 2 + 1] - loop[k * 2 + 1]);
  }
  return sum;
}

function boxOf(loop) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < loop.length; i += 2) {
    b[0] = Math.min(b[0], loop[i]); b[1] = Math.min(b[1], loop[i + 1]);
    b[2] = Math.max(b[2], loop[i]); b[3] = Math.max(b[3], loop[i + 1]);
  }
  return b;
}

/** Does `inner` sit inside `outer`? Slack of a micron, for the clipper's grid. */
function boxWithin(inner, outer, eps = 1e-3) {
  return inner[0] >= outer[0] - eps && inner[1] >= outer[1] - eps
    && inner[2] <= outer[2] + eps && inner[3] <= outer[3] + eps;
}

/**
 * Which side of a pocket ring the metal is on.
 *
 * A tool-centre loop cannot be asked: the offsetter winds the inward offset of
 * an enclosed void exactly as it winds the outward offset of a part outline, so
 * the two are indistinguishable from the loop alone — and they are opposites.
 * Round a boss the metal is what the loop encloses; round a pocket wall it is
 * everything the loop does not. Both answers matter twice over, because climb
 * milling and the lead-in arc both swing off the side the metal is not on: with
 * the boss answer the wall pass runs conventional and its arc lead swings out
 * through the wall it was about to finish. Measured on a 24×24 pocket with a
 * ⌀12 cutter, that arc put the cutter 2mm past the finished size.
 *
 * The region's outer boundaries are the pocket walls (metal outside); its holes
 * are islands standing in the pocket (metal inside), which is the ordinary
 * boss case again.
 *
 * **A hole is not an island just because it is a hole.** Rest machining
 * subtracts what an earlier pass already took (see pocketArea), and every
 * deduction leaves a hole in the region that is *air* — ground the first cutter
 * emptied — not a boss. Read off the winding alone those came back as bosses:
 * the leftover ribbon against the wall ran conventional and its lead arc swung
 * **out through the pocket wall**, 1.94mm past finished size with a ⌀3 cutter,
 * ten millimetres deep, on a pass whose whole purpose was to clean that wall
 * up. Nothing said a word, because with rest machining off the same operation
 * is clean and the ribbon only exists when it is on.
 *
 * So the question is put to the part rather than to the loop: a hole holds
 * metal when the part's own shadow at this depth is standing in it. That is the
 * same silhouette the pocket was found from, so there is no second description
 * of where the metal is.
 */
function pocketSide(loop, lead, shadow = null) {
  if (loopArea(loop) > 0) return { ...lead, materialOutside: true };
  return { ...lead, materialOutside: !loopEnclosesAny(loop, shadow) };
}


/**
 * The tool-centre region to clear at this level.
 *
 * With a floor face picked, that pick *is* the pocket: everything inside it
 * that the part is not occupying at this depth. Taking the picked area minus
 * the silhouette rather than the picked area alone is what makes a boss
 * standing in the middle of a pocket survive being machined away.
 *
 * With nothing picked, the enclosed voids in the part's shadow are the pocket —
 * a hole in the shadow is a place the part is absent but surrounded, which is
 * exactly what a pocket is. So an unpicked pocket operation still does the
 * obvious thing.
 *
 * Avoided faces subtract from either. They used to be applied to a *bounding
 * rectangle* of the shadow, which meant a pocket op with only avoid picks would
 * machine the whole footprint of the part — the pick made it cut more, not less.
 *
 * @returns { raw: whether any pocket exists here, area: where the centre may go }
 */
function pocketArea(shadow, regions, { radius, tolerance, stockToLeave, z, minClearedWidth = 0 }) {
  const include = regions?.include ?? [];
  let found = include.length > 0
    ? diffLoops(offsetLoops(include, 0, tolerance), shadow)
    : enclosedVoids(shadow);
  // avoided faces still apply, and only ever take area away
  if ((regions?.avoid ?? []).length > 0) {
    found = applyRegionsToArea(found, { include: [], avoid: regions.avoid }, { radius, tolerance });
  }
  if (found.length === 0) return { raw: false, area: [] };

  // shrink by the radius so the cutter body stays inside the pocket walls;
  // a pocket narrower than the tool shrinks away to nothing, which is the
  // honest answer — that cutter cannot machine it
  const area = offsetLoops(found, -(radius + stockToLeave), tolerance);
  // What an earlier operation already took off comes out *after* that shrink,
  // because it is a deduction from where the centre may usefully go rather than
  // from the pocket. Doing it before would erode the cleared area twice — once
  // here and once in applyRegionsToArea — and leave a ring of air being cut
  // round everything the first cutter did.
  if ((regions?.cleared ?? []).length > 0) {
    return {
      raw: true,
      area: applyRegionsToArea(area, { include: [], avoid: [], cleared: regions.cleared },
        { radius, tolerance, z, minClearedWidth }),
    };
  }
  return { raw: true, area };
}
