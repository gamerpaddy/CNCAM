// 3D finishing: ride the tool over the surface, dropping it onto a heightmap so
// it follows whatever the model does — the strategy that actually finishes
// curved and sloped faces, where the Z-level ops can only leave steps.
//
// Three patterns:
//   zigzag / oneway — straight passes at a fixed angle. Simple and predictable,
//     but a fixed direction meets every slope at a different angle, so the
//     finish varies across the part and shallow faces get a wide effective
//     stepover.
//   flow            — passes follow the surface's steepest-descent direction.
//     The tool runs down the slope rather than across it, which is how a slope
//     wants to be cut: the cusp stays even and the scallops line up with the
//     form instead of cutting across it.
//
// Points where the tool would sit above topZ or below bottomZ are treated as
// off-surface: the pass breaks there and the tool retracts rather than dragging
// through air at cutting feed.

import { CLBuilder, FEED, lastXY } from '../cl.js';
import { mergeTolerance } from '../simplify.js';
import {
  buildHeightmap, buildToolKernel, dropCutter, downhillAt,
} from '../../geom/heightmap.js';
import { stockOutline } from '../stock.js';
import {
  loopsBounds, offsetLoops, intersectLoops, unionWithHoles,
} from '../../geom/clipper.js';
import { silhouetteAbove } from '../../geom/silhouette.js';
import { applyRegionsToArea, regionsActive, regionRefusal } from '../regions.js';
import { pointInLoops } from '../../geom/inside.js';
import { applyCutting } from '../cutting.js';
import { approach, entryPlane, entryGapOf } from '../heights.js';

export function generateParallel3d({ mesh, tool, params, stock, regions }) {
  const r = tool.diameter / 2;
  const step = Math.max(0.05, (params.stepover ?? 0.25) * tool.diameter);
  const tolerance = params.tolerance ?? 0.01;
  const clearance = params.clearanceHeight;
  const stockToLeave = params.stockToLeave ?? 0;
  const pattern = params.pattern ?? 'zigzag';
  const oneWay = pattern === 'oneway';
  const angle = ((params.angleDeg ?? 0) * Math.PI) / 180;
  const feedPlane = entryPlane(params, params.topZ, params.bottomZ);

  const cl = new CLBuilder().simplify(mergeTolerance(tolerance));
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  // grid fine enough that stepover and tolerance are both resolved, and the
  // heightmap is padded by the tool radius so the kernel never runs off the edge
  const cellSize = Math.max(tolerance, Math.min(step / 4, r / 4, 0.3));
  const meshBox = boundsOf(mesh.positions);
  const map = buildHeightmap(mesh, {
    cellSize,
    bounds: {
      min: [meshBox.min[0] - r - cellSize, meshBox.min[1] - r - cellSize, meshBox.min[2]],
      max: [meshBox.max[0] + r + cellSize, meshBox.max[1] + r + cellSize, meshBox.max[2]],
    },
    floor: -Infinity,
  });
  const kernel = buildToolKernel(tool, map.cellSize);

  // machining area: the stock footprint, narrowed by any picked regions
  const area = applyRegionsToArea(stockOutline(stock, 0), regions, { radius: r, tolerance });
  if (area.length === 0) {
    cl.warn('parallel finishing has nothing left to machine after the region filter');
    return cl.finish();
  }
  /**
   * How far past the part the pass is allowed to run.
   *
   * A drop-cutter raster follows whatever is under the tool and clamps to
   * Bottom Z where there is nothing — so on the *outside* of a part it walks
   * down the wall and then ploughs a lap round the base at Bottom Z. On inside
   * geometry that behaviour is exactly right: the tool cannot reach the corner,
   * so it goes as deep as it can and leaves the fillet, and stopping early
   * there would leave a step in the middle of a surface. Outside, there is
   * nothing under it at all — the roughing pass took that ground away — and the
   * lap is a groove cut in air that costs minutes and looks like damage.
   *
   * So the limit is a boundary rather than a depth: the part's own shadow at
   * Bottom Z, grown by the tool radius so the wall itself is still finished to
   * the bottom, plus whatever extra the user asks for.
   *
   *   part  — stay within a radius of the part (the default)
   *   stock — the old behaviour: the whole area, down to Bottom Z everywhere
   */
  const boundary = params.parallelBoundary ?? 'part';
  const extra = Math.max(0, params.boundaryExtra ?? 0);
  let limit = null;
  if (boundary !== 'stock' && mesh?.positions?.length) {
    const shadow = silhouetteAbove(mesh, params.bottomZ, { tolerance });
    // The **outer** boundaries only, holes discarded. A pocket is a hole in the
    // shadow, and keeping it would exclude the pocket floor from the pass that
    // is there to finish it — measured: the floor of a 12mm-deep pocket stopped
    // being cut at all. What this limit is for is the ground *outside* the
    // part, and a part's outline is what says where that is.
    const outers = shadow.length ? unionWithHoles(shadow).map((region) => region.outer) : [];
    if (outers.length) limit = offsetLoops(outers, r + extra, tolerance);
  }

  const limited = regionsActive(regions);
  const box = loopsBounds(limit?.length ? intersectLoops(area, limit) : area);

  /**
   * The same area, with its own edge counted as inside it.
   *
   * `pointInLoops` answers false for a point sitting exactly on a boundary, and
   * the raster puts points there by construction: `box` is the bounds of this
   * very area, so the first and last sample of every row land precisely on its
   * edge. Read through `area` that came back as "a region excluded this point",
   * which forbids the tool from crossing and forces a full retract — so every
   * row began and ended with a climb to clearance the moment the setup held any
   * region at all. Measured on the sample part, a clamp declared 500mm clear of
   * the work took this pass from 418mm of rapid to 7174mm.
   *
   * A hair's growth makes the edge belong to the area it is the edge of. It
   * costs an avoided island the same hair, which is nothing beside the tool
   * radius already standing off it.
   */
  const insideArea = limited ? offsetLoops(area, Math.max(tolerance, 1e-3), tolerance) : area;

  /**
   * How high the tool would have to be to pass over (x, y) without touching the
   * part — the drop-cutter surface with no Z window and no region filter on it.
   *
   * `dropCutter` already answers for the whole cutter rather than for a point,
   * so this *is* the non-gouging height and the link test below needs no fudge
   * factor on top of it. Nothing there at all reads as −∞, which is what makes
   * the empty ground either side of a part free to cross.
   */
  const surfaceAt = (x, y) => {
    const z = dropCutter(map, kernel, x, y);
    return Number.isFinite(z) ? z + stockToLeave : -Infinity;
  };

  /**
   * [x, y, z, offLimits] with `z === null` where there is nothing this pass may
   * cut.
   *
   * `offLimits` separates the two reasons a point can be refused, because they
   * are not equally crossable. A point with no material at it is empty air the
   * tool may drive over; a point the *region filter* rejected is part of the
   * job somebody said not to machine, and driving over it at cutting depth
   * would cut a groove across the face they excluded — with the link test
   * happily reporting that nothing was in the way.
   */
  const probe = (x, y) => {
    if (limited && !pointInLoops(insideArea, x, y)) return [x, y, null, true];
    // Outside the part's own boundary there is nothing to finish. Reported as
    // *empty*, not off-limits, and the difference matters: off-limits means
    // "somebody said not to machine here", which stops the tool crossing at
    // depth. This is air. The tool may sail over it — it simply must not be
    // asked to descend to Bottom Z and cut a lap round the outside, which is
    // all this limit prevents. Marking it off-limits instead turned every gap
    // in a raster into a full retract.
    if (limit && !pointInLoops(limit, x, y)) return [x, y, null, false];
    const surface = surfaceAt(x, y);
    if (!Number.isFinite(surface) || surface > params.topZ + 1e-9) return [x, y, null, false];
    // What to do where the surface is below Bottom Z, which is the other half
    // of the same complaint. Flattening it to Bottom Z draws a plateau in mid
    // air across the middle of every pocket and a lap round the base of every
    // wall — the tool at cutting depth, in ground that is not there. Stopping
    // is what a finishing pass with a Z window means: below this, not my job.
    if (surface < params.bottomZ) {
      return boundary === 'stock' ? [x, y, params.bottomZ, false] : [x, y, null, false];
    }
    return [x, y, surface, false];
  };

  const sample = (x, y) => {
    const p = probe(x, y);
    return p[2] === null ? null : p;
  };

  /**
   * When the tool may cross a gap instead of retracting out of it.
   *
   * A finishing raster over anything but a solid block breaks constantly — a
   * bore, a step, the air either side of the part — and every break used to be
   * a retract to clearance and a plunge back in. On a part with a few features
   * that is hundreds of them, and most cross ground the cutter is already
   * above: there is a hole in the part and the tool is asked to climb 30mm to
   * go round the outside of it.
   *
   * So a gap is crossed at cutting feed when the highest thing under it is
   * below both ends — the tool is already clear of it, and passing over costs
   * one move. `maxDistance` is what keeps that from being a slow way to cross a
   * whole part: beyond it a retract and a rapid really is quicker, and the
   * threshold is in tool diameters because that is what "just round the corner"
   * scales with.
   */
  const link = {
    surfaceAt,
    maxDistance: Math.max(0, params.linkDistance ?? tool.diameter * 3),
    probeStep: Math.max(map.cellSize, tolerance * 2),
    entryGap: entryGapOf(params),
    /**
     * How far a link may cut into the surface on the way across before it
     * stops counting as clear of it.
     *
     * Zero is too strict to be useful: two points on the same face have the
     * surface between them bowed above the straight line by the sagitta over
     * the gap, which is a micron on anything a finishing pass meets, and a
     * link refused for a micron is a link that lifts a millimetre. The pass is
     * already chorded to `tolerance`, so a link that stays inside it cuts
     * nothing the toolpath was not allowed to cut anyway.
     *
     * It is a margin on the *straight* link, not a licence: anything that dips
     * further is not cut through but ridden over — see planLink.
     */
    sag: tolerance,
    /**
     * The height this pass may cut at a place, or null where it may not cut at
     * all — the same question `probe` answers for the pass itself.
     *
     * What makes riding a link across the surface safe. `surfaceAt` knows only
     * where the material is; it does not know that this operation has a Z
     * window, a boundary and possibly a region filter, and a link that followed
     * *it* would happily cut below Bottom Z or across a face somebody excluded.
     */
    cuttableAt: (x, y) => probe(x, y)[2],
  };

  if (pattern === 'flow') {
    emitFlowPasses(cl, {
      map, box, step, sample, clearance, feedPlane, link,
      // where there is no slope there is nothing to follow, so flats fall back
      // to straight passes at the nominal raster angle
      flatHeading: [Math.cos(angle), Math.sin(angle)],
    });
    if (cl.count === 0) {
      const why = regionRefusal(regions, r, tolerance);
      cl.warn(why
        ? `follow-slope finishing produced no passes — ${why}`
        : 'follow-slope finishing produced no passes — check Top Z and Bottom Z');
    }
    return cl.finish();
  }

  // sweep in a rotated frame so the raster angle is just a change of basis
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const toWorld = (u, v) => [u * cos - v * sin, u * sin + v * cos];
  const corners = [
    [box.min[0], box.min[1]], [box.max[0], box.min[1]],
    [box.max[0], box.max[1]], [box.min[0], box.max[1]],
  ].map(([x, y]) => [x * cos + y * sin, -x * sin + y * cos]);
  const uMin = Math.min(...corners.map((c) => c[0]));
  const uMax = Math.max(...corners.map((c) => c[0]));
  const vMin = Math.min(...corners.map((c) => c[1]));
  const vMax = Math.max(...corners.map((c) => c[1]));

  // The finest the pass is ever sampled — one heightmap cell, which is the
  // finest the surface is known at.
  const fine = Math.max(map.cellSize, tolerance * 2);
  /**
   * The stride the row is walked at before anything is looked at closely.
   *
   * Sampling every cell was most of the cost of a finishing pass and nearly all
   * of it was thrown away: a ⌀3 ball at a 0.08 stepover takes 444,000 drops and
   * the simplifier keeps 28,000 of them, because a floor sampled sixteen times
   * per stepover is still a floor. So the row is walked coarsely and *refined*
   * where the surface does something — which is the same rule the simplifier
   * applies afterwards, applied before the work is done rather than after.
   *
   * Half a tool radius, at most a stepover: the drop-cutter surface cannot have
   * a feature narrower than the cutter that made it, so a stride below that
   * cannot step over one; and a sliver narrower than the stepover is missed by
   * the next pass anyway.
   */
  const coarse = Math.max(fine, Math.min(step, r / 2));
  let forward = true;
  // One emitter across the whole raster, not one per line. The break the tool
  // meets most often is the one at the *end* of a line, and a per-line emitter
  // has to retract there because it does not know what comes next — so a part
  // that needs no retracts at all still got one per pass, which on a finishing
  // stepover is hundreds. In a zig-zag the next line starts a stepover away
  // from where this one ended, which is the shortest link in the program.
  const state = { cutting: false, at: null, gap: false };
  const emit = (p) => emitPoint(cl, p, state, { clearance, feedPlane, link });

  /**
   * Everything between `p0` and `p1`, and then `p1`.
   *
   * Two ends that agree stand for the span between them; two that do not are
   * split and asked again. What counts as agreeing is the same tolerance the
   * path is chorded to — the midpoint has to sit on the straight line between
   * them — plus the rule that a break has to be found, not interpolated: where
   * one end is off-surface and the other is not, the edge between them is a
   * real edge of the cut and is closed in on to `fine`.
   */
  const refine = (s0, p0, s1, p1, probeAt) => {
    const z0 = p0[2];
    const z1 = p1[2];
    if (s1 - s0 <= fine * 1.5) { emit(p1); return; }
    // flat, and both ends on the surface: nothing between them to find
    if (z0 !== null && z1 !== null && Math.abs(z1 - z0) <= tolerance) { emit(p1); return; }
    // both ends off the surface: so is the span, unless something narrower
    // than the cutter is hiding in it, and nothing can be
    if (z0 === null && z1 === null && p0[3] === p1[3] && s1 - s0 <= coarse + 1e-9) {
      emit(p1);
      return;
    }
    const sm = (s0 + s1) / 2;
    const pm = probeAt(sm);
    if (z0 !== null && z1 !== null && pm[2] !== null
      && Math.abs(pm[2] - (z0 + z1) / 2) <= tolerance) {
      // the midpoint sits on the chord, so the chord is the surface
      emit(pm);
      emit(p1);
      return;
    }
    refine(s0, p0, sm, pm, probeAt);
    refine(sm, pm, s1, p1, probeAt);
  };

  const length = uMax - uMin;
  for (let v = vMin; v <= vMax + 1e-9; v += step) {
    const u0 = forward ? uMin : uMax;
    const dir = forward ? 1 : -1;
    const probeAt = (s) => {
      const [x, y] = toWorld(u0 + dir * s, v);
      return probe(x, y);
    };
    /**
     * A one-way row does not carry on from where the last one ended.
     *
     * The emitter is deliberately carried across rows, because in a zig-zag the
     * next row starts a stepover from where this one finished and cutting
     * straight to it is the shortest link there is. One-way rows all start at
     * the *same* side, so that link is the full width of the part — and with
     * nothing marking it as a link it was emitted as a cutting move, in a
     * straight line, with Z interpolated between two points ninety millimetres
     * apart. On the test slope that is 366 moves and 22 metres of travel at
     * cutting feed, and the deepest of them ran **17mm below the finished
     * surface**: a diagonal groove ploughed through the part, once per row.
     *
     * Marking it as a gap is all it needs — `planLink` then answers it the way
     * it answers every other break, and a return this long is a retract.
     */
    if (oneWay && state.cutting) state.gap = true;
    let s0 = 0;
    let p0 = probeAt(0);
    emit(p0);
    while (s0 < length - 1e-9) {
      const s1 = Math.min(length, s0 + coarse);
      const p1 = probeAt(s1);
      refine(s0, p0, s1, p1, probeAt);
      s0 = s1;
      p0 = p1;
    }
    if (!oneWay) forward = !forward;
  }

  if (state.cutting) cl.rapid(...lastXY(cl), clearance);
  if (cl.count === 0) {
    // see engine/regions.js regionRefusal
    const why = regionRefusal(regions, r, tolerance);
    cl.warn(why
      ? `parallel finishing produced no passes — ${why}`
      : 'parallel finishing produced no passes — check Top Z and Bottom Z');
  }
  return cl.finish();
}

/**
 * Slope-following passes: evenly spaced streamlines of steepest descent.
 *
 * Each pass runs *along* the slope rather than cutting across it at whatever
 * angle a fixed raster happens to make. The hard part is spacing: seeding on a
 * lattice and discarding seeds that a previous streamline already passed leaves
 * gaps far wider than the stepover, because one streamline invalidates seeds
 * across its whole length. That is a coverage hole in a *finishing* pass —
 * uncut material, not just uneven cusps.
 *
 * So seeds are placed the way Jobard & Lefer place evenly-spaced streamlines:
 * every accepted streamline offers new seeds one stepover off each flank, and a
 * streamline stops when it comes closer than half a stepover to a different
 * one. Spacing then holds across the whole surface instead of depending on
 * where the lattice happened to fall.
 */
function emitFlowPasses(cl, {
  map, box, step, sample, clearance, feedPlane = null, link = null, flatHeading = [1, 0],
}) {
  const { cellSize } = map;
  const dSep = step;                       // target spacing between passes
  const dTest = step * 0.5;                // how close a pass may come to another
  const stride = Math.max(cellSize, step / 3);
  const maxSteps = Math.ceil(
    (Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1]) / stride) * 3,
  );

  const placed = new PointIndex(dSep);
  // A queue read through an index rather than shifted: pruning at push time
  // still leaves tens of thousands of seeds on a real surface, and `shift`
  // copies the whole array every time.
  const queue = latticeSeeds(box, dSep * 2, sample);
  let head = 0;

  /**
   * How much path this pass may lay down before it is called pathological.
   *
   * Covering the area at the asked spacing takes area/dSep of path, and no
   * sane streamline field takes many times that. It is a backstop, not a
   * budget: it says so when it fires, because the alternative is what the old
   * one did — a fixed count of *queue pops*, hit long before the surface was
   * covered, which stopped the pass with a third of the part still standing
   * and nothing anywhere to say so.
   */
  const boxArea = Math.max(1, (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]));
  const lengthBudget = (boxArea / dSep) * 6;
  let laid = 0;

  const paths = [];
  while (head < queue.length && laid < lengthBudget) {
    const seed = queue[head++];
    if (placed.hasWithin(seed[0], seed[1], dSep * 0.9)) continue;

    // a streamline runs both ways from its seed: downhill to the valley and
    // uphill to the ridge, which is one continuous pass over the form
    const down = integrate(seed, 1);
    const up = integrate(seed, -1);
    const path = [...up.slice(1).reverse(), ...down];
    if (path.length < 2) continue;

    for (const [x, y] of path) placed.add(x, y);
    laid += (path.length - 1) * stride;
    paths.push(path);

    // Fresh seeds a stepover off each flank of what was just cut, tested
    // before they go on the queue as well as after they come off it. Offering
    // two per point put a quarter of a million seeds on the queue for one
    // surface, nearly all of them inside ground already cut; a stepover apart
    // is as finely as they can differ and still be separate passes.
    const seedEvery = Math.max(1, Math.round(dSep / stride));
    for (let n = 0; n < path.length; n += seedEvery) {
      const a = path[n];
      const b = path[Math.min(n + 1, path.length - 1)];
      const tx = b[0] - a[0], ty = b[1] - a[1];
      const len = Math.hypot(tx, ty);
      if (len < 1e-9) continue;
      const nx = -ty / len, ny = tx / len;
      for (const side of [1, -1]) {
        const cx = a[0] + nx * dSep * side;
        const cy = a[1] + ny * dSep * side;
        if (placed.hasWithin(cx, cy, dSep * 0.9)) continue;
        const candidate = sample(cx, cy);
        if (candidate) queue.push(candidate);
      }
    }
  }
  if (laid >= lengthBudget) {
    cl.warn('follow-slope finishing stopped at its path budget — some of the surface '
      + 'is not covered; a larger stepover or a smaller area will finish it');
  }

  emitOrdered(cl, paths, { clearance, feedPlane, link });

  function integrate(seed, sign) {
    const path = [];
    let [x, y] = seed;
    let heading = null;
    for (let n = 0; n < maxSteps; n++) {
      const point = sample(x, y);
      if (!point) break;
      // keep clear of streamlines already cut, but not of our own first steps
      if (n > 2 && placed.hasWithin(x, y, dTest)) break;
      path.push(point);

      const i = Math.round((x - map.min[0]) / cellSize);
      const j = Math.round((y - map.min[1]) / cellSize);
      const slope = downhillAt(map, i, j);
      // A flat has no downhill, but stopping dead there leaves bare patches
      // wherever a slope runs out onto a plateau; carrying the heading straight
      // on crosses the flat and picks the slope up on the far side.
      if (slope) {
        const next = [slope[0] * sign, slope[1] * sign];
        // Downhill that points back the way we came is the bottom of the slope
        // being followed, and there is nothing beyond it to follow.
        //
        // Without this the pass turned round and walked back over itself. It
        // happens wherever a plateau meets a descent — the flat carries the
        // heading straight on, the tool crosses onto the skirt of the dome, and
        // steepest descent there points radially *outward*, which is where it
        // has just come from. Measured on the slope part: one pass 823mm long
        // on a part 116mm across the diagonal, and 2.2x the raster's cutting
        // distance laid down over *less* of the surface than the raster covered.
        if (heading && next[0] * heading[0] + next[1] * heading[1] <= 0) break;
        heading = next;
      // Starting on a flat is not a reason to give up — a plateau still needs
      // finishing, and with no gradient to follow a straight pass is what it
      // wants. Without this, flat areas are simply left uncut.
      } else if (!heading) heading = [flatHeading[0] * sign, flatHeading[1] * sign];
      x += heading[0] * stride;
      y += heading[1] * stride;
    }
    return path;
  }
}

/**
 * Emit streamlines nearest-first, keeping the tool down between them where it
 * can stay down.
 *
 * Two things the old emitter did not do, both of them the raster's own
 * behaviour applied here. Each pass got a fresh emitter state and a retract to
 * clearance after it, so a surface needing 900 streamlines got 900 full
 * retract-and-plunge cycles — on the slope part, 59m of rapid and 13m at plunge
 * feed, about half the cycle time, to cut 48m. And the passes came out in seed
 * order, which is the order a lattice sorted by height happens to fall in, so
 * consecutive passes were a median of 24mm apart with nothing linkable between
 * them.
 *
 * Ordered end-to-end, most links are a stepover long and `planLink` keeps the
 * tool in the cut across them, exactly as it does between raster lines.
 * Reversing a pass to put its near end first is free: a finishing pass over a
 * form has no preferred direction, which is why the raster zig-zags.
 */
function emitOrdered(cl, paths, { clearance, feedPlane, link }) {
  if (paths.length === 0) return;
  const used = new Uint8Array(paths.length);
  const state = { cutting: false, at: null, gap: false };
  let at = null;

  for (let emitted = 0; emitted < paths.length; emitted++) {
    let best = -1;
    let bestDistance = Infinity;
    let flip = false;
    for (let i = 0; i < paths.length; i++) {
      if (used[i]) continue;
      if (!at) { best = i; flip = false; break; }
      const path = paths[i];
      const head = path[0];
      const tail = path[path.length - 1];
      const dh = (head[0] - at[0]) ** 2 + (head[1] - at[1]) ** 2;
      const dt = (tail[0] - at[0]) ** 2 + (tail[1] - at[1]) ** 2;
      const d = Math.min(dh, dt);
      if (d < bestDistance) { bestDistance = d; best = i; flip = dt < dh; }
    }
    if (best < 0) break;
    used[best] = 1;
    const path = flip ? [...paths[best]].reverse() : paths[best];
    // the tool is somewhere else entirely, which is exactly what a gap in the
    // raster is — `planLink` decides whether it may stay down for it
    if (state.cutting) state.gap = true;
    for (const point of path) emitPoint(cl, point, state, { clearance, feedPlane, link });
    at = path[path.length - 1];
  }
  if (state.cutting) cl.rapid(...lastXY(cl), clearance);
}

/** Coarse starting seeds, highest first so passes begin on ridges. */
function latticeSeeds(box, spacing, sample) {
  const seeds = [];
  for (let y = box.min[1]; y <= box.max[1] + 1e-9; y += spacing) {
    for (let x = box.min[0]; x <= box.max[0] + 1e-9; x += spacing) {
      const point = sample(x, y);
      if (point) seeds.push(point);
    }
  }
  return seeds.sort((a, b) => b[2] - a[2]);
}

/** Bucketed 2D points, for "is anything already within d of here?". */
class PointIndex {
  constructor(cell) {
    this.cell = cell;
    this.buckets = new Map();
  }

  add(x, y) {
    const key = `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
    let bucket = this.buckets.get(key);
    if (!bucket) { bucket = []; this.buckets.set(key, bucket); }
    bucket.push(x, y);
  }

  hasWithin(x, y, distance) {
    const gi = Math.floor(x / this.cell);
    const gj = Math.floor(y / this.cell);
    const limit = distance * distance;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const bucket = this.buckets.get(`${gi + di},${gj + dj}`);
        if (!bucket) continue;
        for (let n = 0; n < bucket.length; n += 2) {
          const dx = bucket[n] - x;
          const dy = bucket[n + 1] - y;
          if (dx * dx + dy * dy < limit) return true;
        }
      }
    }
    return false;
  }
}

/**
 * Take the raster one sample at a time, keeping the tool down wherever it can
 * stay down.
 *
 * `state` is { cutting, at, gap }: whether the tool is in the cut, the last
 * point it actually cut, and whether anything has been skipped since. It is
 * carried across raster lines on purpose — see the note at the call site.
 *
 * @param p [x, y, z] with `z === null` where there is nothing to cut
 */
function emitPoint(cl, p, state, { clearance, feedPlane = null, link = null }) {
  if (p[2] === null) {
    if (state.cutting) {
      state.gap = true;
      if (p[3]) state.gapOffLimits = true;
    }
    return;
  }
  if (!state.cutting) {
    approach(cl, p[0], p[1], p[2], { clearance, feedPlane });
  } else if (!state.gap) {
    cl.cut(p[0], p[1], p[2]);
  } else {
    const plan = state.gapOffLimits ? null : planLink(state.at, p, link, clearance);
    if (plan?.kind === 'cut') {
      // straight over: the whole cutter clears everything between, so the move
      // gouges nothing and the tool never leaves the cut
      cl.cut(p[0], p[1], p[2]);
    } else if (plan?.kind === 'ride') {
      // over the surface itself rather than over the top of it — the ground
      // between is the same face this pass is finishing, so the tool stays in
      // the cut and finishes it on the way past
      for (const q of plan.points) cl.cut(q[0], q[1], q[2]);
      cl.cut(p[0], p[1], p[2]);
    } else if (plan?.kind === 'hop') {
      // just over whatever is in the way, and no further
      cl.rapid(state.at[0], state.at[1], plan.z);
      cl.rapid(p[0], p[1], plan.z);
      cl.cut(p[0], p[1], p[2], FEED.PLUNGE);
    } else {
      cl.rapid(...lastXY(cl), clearance);
      approach(cl, p[0], p[1], p[2], { clearance, feedPlane });
    }
  }
  state.cutting = true;
  state.at = p;
  state.gap = false;
  state.gapOffLimits = false;
}

/**
 * How to get from one point to the next across a break in the surface:
 * straight over it, a hop just clear of it, or out to clearance.
 *
 * The ground is measured **along the move itself**, not at the samples that
 * were skipped: those lie on the raster lines and the link cuts the corner
 * between two of them, so it passes over ground none of them stands on.
 * Checking the wrong ground is worse than not checking — it would be a gouge
 * with a test in front of it. `surfaceAt` gives the height the whole cutter
 * needs at a place, so the comparison is the non-gouging condition itself.
 *
 * Three outcomes rather than two, and the middle one is the one that matters.
 * A pass-or-retract test has to be answered by the single highest point under
 * the link, and at a break the link runs *along the edge of the part*, where
 * the surface wobbles above the straight line between the two ends by microns.
 * So the answer was almost always "retract", and the tool climbed thirty
 * millimetres to clear a bump it could have stepped over. Lifting to just above
 * whatever is actually in the way costs one entry gap and keeps the shape of
 * the link honest: it is exactly as high as it needs to be.
 *
 * The fourth outcome, and on a slope-following pass the commonest one, is to
 * *ride* the surface across. Two passes that end a stepover apart at different
 * heights have nothing standing between them — the ground under the link is
 * below both ends — and yet the straight line from one to the other cuts the
 * corner off the slope they are both on, by a tenth of a millimetre on the test
 * part. That is a gouge, so the link was lifted over it: 351 hops, each one a
 * rapid up, a rapid across and a plunge back in, to cross three quarters of a
 * millimetre of the face the pass is finishing anyway. Following the surface
 * instead costs a handful of cutting moves, cuts nothing that is not being
 * finished, and never leaves the material.
 *
 * @returns { kind: 'cut' } | { kind: 'ride', points } | { kind: 'hop', z }
 *   | null to retract
 */
function planLink(from, to, link, clearance) {
  if (!link || !from || !(link.maxDistance > 0)) return null;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const distance = Math.hypot(dx, dy);
  if (!(distance <= link.maxDistance)) return null;

  let peak = -Infinity;      // highest ground under the link, absolutely
  let clears = true;         // …and does the straight move stay above all of it
  // …to within what the path is chorded to anyway — see `sag` at the call site
  const sag = Math.max(1e-6, link.sag ?? 0);
  const steps = Math.max(2, Math.ceil(distance / link.probeStep));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const under = link.surfaceAt(from[0] + dx * t, from[1] + dy * t);
    if (under > peak) peak = under;
    if (under > from[2] + dz * t + sag) clears = false;
  }
  if (clears) return { kind: 'cut' };
  if (!Number.isFinite(peak)) return { kind: 'cut' };

  // Nothing between the two ends stands above the higher of them, so the tool
  // does not have to come out of the cut to get across — it only has to stop
  // pretending the surface is a straight line.
  if (peak <= Math.max(from[2], to[2]) + sag) {
    const points = ridePath(from, to, link, steps);
    if (points) return { kind: 'ride', points };
  }

  const z = peak + link.entryGap;
  // above clearance there is nothing to be gained: that *is* the retract
  return z < clearance - 1e-9 ? { kind: 'hop', z } : null;
}

/**
 * The surface between two points, as points this pass is allowed to cut — or
 * null where any of it is not, in which case the tool has to go over the top
 * after all.
 *
 * Asked of `cuttableAt` rather than of `surfaceAt`, and that is the whole
 * safety of it: below Bottom Z, outside the part's own boundary and inside an
 * avoided region all come back null, so a ride never wanders off the ground the
 * pass itself would cut.
 */
function ridePath(from, to, link, steps) {
  if (!link.cuttableAt) return null;
  const points = [];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = from[0] + (to[0] - from[0]) * t;
    const y = from[1] + (to[1] - from[1]) * t;
    const z = link.cuttableAt(x, y);
    if (z === null) return null;
    points.push([x, y, z]);
  }
  return points;
}

function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}
