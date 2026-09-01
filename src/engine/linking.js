// Entry linking shared by strategies. cutLoopWithRamp() enters a closed loop
// either by straight plunge (rampAngleDeg <= 0) or by ramping down along the
// loop geometry, then machines one full perimeter at the target depth.
// The caller is responsible for positioning (rapid above loop[0]) beforehand.

import { FEED } from './cl.js';
import { pointInLoops } from '../geom/inside.js';
import { offsetLoops } from '../geom/clipper.js';

/**
 * How high the tool has to be to travel from one pass to the next, read off the
 * levels a Z-level strategy has already computed.
 *
 * A Z-level operation retracts between passes because a pass cannot know what
 * comes next, and the height it retracts to has to be safe for the worst case:
 * the crossing plane, above the whole part. On a job with several features per
 * level that is a full climb and a full descent per loop — the tool leaves a
 * 30mm bore to cut 5mm of the next one and comes straight back, hundreds of
 * times. Read as motion it is pecking, and it is the reported complaint about
 * waterline finishing.
 *
 * Nothing has to be measured again to do better. The stack of silhouettes the
 * strategy already built *is* the shape of the part: `region[k]` is where the
 * tool centre may not be at `levels[k].z`, and because each one is the shadow of
 * everything above it, they nest — outside a region means outside every region
 * above it. So the height that clears a point is found by binary search, and the
 * answer is the level *above* the first region that contains it, which is a
 * height the tool is known to clear rather than one interpolated between two.
 *
 * Sampled along the move, not just at its ends: what matters is the highest
 * thing under the link, and at the edge of a feature that is rarely an endpoint.
 *
 * @param levels [{ z, region }], z descending, region = tool-centre keepout
 * @param ceiling never returns more than this — the strategy's own crossing
 *   plane, so a link is never worse than the retract it replaces
 * @returns (a, b) => height, with `a`/`b` as [x, y, z]
 */
export function zLevelLinker(levels, {
  entryGap = 0, ceiling = Infinity, probeStep = 1, boundarySlack = 0,
} = {}) {
  // Optionally eroded by a hair before anything is asked of it.
  //
  // The passes a Z-level strategy makes lie *on* the boundary of the keepout —
  // that is what a tool-centre offset is — and a point exactly on a loop is
  // inside neither side of it, so the two ends of every link, which are the two
  // places the tool provably is, can read as "material all the way to the top".
  // Measured on a two-pocket part: the tool climbed over the billet to move
  // between two concentric rings 2.4mm apart inside the pocket it was standing
  // in, and a hair of erosion took those retracts from 28 to 10. The same
  // reasoning as the region test in engine/regions.js — an edge belongs to the
  // area it is the edge of.
  //
  // Off by default, and asked for by the callers whose passes sit on the
  // boundary. It is not free: on waterline finishing the same hair *raised*
  // the rapid distance from 494mm to 869mm on the sample part, because the
  // links stop collapsing onto one shared height and each becomes its own
  // retract. Which of those two is right for waterline is a question worth
  // measuring on its own, and not one to answer as a side effect of fixing
  // pocketing.
  const probe = boundarySlack > 0
    ? levels.map((l) => (l.region?.length
      ? { ...l, region: offsetLoops(l.region, -boundarySlack, boundarySlack) }
      : l))
    : levels;

  const heightAt = (x, y) => {
    // first (highest) level whose keepout contains the point
    let lo = 0;
    let hi = probe.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pointInLoops(probe[mid].region, x, y)) hi = mid; else lo = mid + 1;
    }
    if (lo === 0) return Infinity;              // material to the top: only the ceiling clears it
    if (lo >= levels.length) return -Infinity;  // nothing under the tool here at all
    return levels[lo - 1].z;
  };

  return (a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const distance = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(distance / Math.max(probeStep, 1e-6)));
    let need = -Infinity;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const h = heightAt(a[0] + dx * t, a[1] + dy * t);
      if (h > need) need = h;
      if (need === Infinity) break;
    }
    if (need === Infinity) return ceiling;
    // clear ground the whole way: still lift off the cut, but only by the gap
    if (need === -Infinity) need = Math.max(a[2], b[2]);
    return Math.min(ceiling, need + entryGap);
  };
}

/**
 * Put a level's loops in an order that does not cross the part to get to each
 * one.
 *
 * The offsetter hands its results back in whatever order the clipping came out
 * in, which bears no relation to where anything is. A pocket with eight islands
 * in it, or a chamfer round eight holes, is eight entries in an arbitrary
 * sequence — so the tool traverses the width of the part between passes that
 * are two millimetres apart, and does it eight times. Nearest-neighbour
 * ordering is not optimal (the travelling salesman is not solved here) and it
 * does not have to be: it removes the pathological orderings, which is where
 * all of the waste is.
 *
 * Nothing about the cut changes — the same loops are cut the same way, in a
 * different sequence — so this is free.
 *
 * @param loops flat [x, y, x, y, …] arrays
 * @param from the tool's current [x, y], or null when it is anywhere
 * @param open the paths do not close on themselves, so the tool finishes at the
 *   far end rather than back where it started
 */
export function orderByProximity(loops, from = null, { open = false } = {}) {
  if (loops.length < 2) return loops;
  const remaining = [...loops];
  const out = [];
  let at = from;

  while (remaining.length > 0) {
    let best = 0;
    if (at) {
      let bestDistance = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = nearestDistanceSq(remaining[i], at);
        if (d < bestDistance) { bestDistance = d; best = i; }
      }
    }
    const [loop] = remaining.splice(best, 1);
    out.push(loop);
    // where the tool will be when that path finishes: back at its start for a
    // closed pass, and at the far end for an open one. Assuming "back at the
    // start" for a span the tool walks away from measures the next hop from the
    // wrong end of it, which is the ordering this function exists to avoid.
    at = open ? [loop[loop.length - 2], loop[loop.length - 1]] : [loop[0], loop[1]];
  }
  return out;
}

/** Squared distance from a point to the nearest vertex of a loop. */
function nearestDistanceSq(loop, [x, y]) {
  let best = Infinity;
  for (let i = 0; i < loop.length; i += 2) {
    const dx = loop[i] - x;
    const dy = loop[i + 1] - y;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return best;
}

/**
 * Rotate a closed loop so it begins at the vertex nearest the tool.
 *
 * A loop is a cycle: where you break into it is free, and breaking in at the
 * far side means traversing the whole thing twice — once at clearance to get
 * there and once cutting to come back. Only used where the entry is a plain
 * plunge: a lead-in is placed relative to the first point and a user who set
 * one up has said where they want the tool to arrive.
 */
export function startNearest(loop, from) {
  if (!from || loop.length < 6) return loop;
  const n = loop.length / 2;
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = loop[i * 2] - from[0];
    const dy = loop[i * 2 + 1] - from[1];
    const d = dx * dx + dy * dy;
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  if (best === 0) return loop;
  const out = new Array(loop.length);
  for (let i = 0; i < n; i++) {
    const k = (best + i) % n;
    out[i * 2] = loop[k * 2];
    out[i * 2 + 1] = loop[k * 2 + 1];
  }
  return out;
}

/**
 * Break into a closed loop at a point the tool can *slide* onto from where it
 * is, rather than at the vertex nearest to it.
 *
 * This is the step from one concentric ring to the next, and it was the
 * heaviest move in a pocketing program — once per ring, every ring.
 *
 * `startNearest` picks the nearest **vertex**, and on rings offset from a
 * rectangle the nearest vertex is a corner. So the tool finished a ring and
 * went diagonally into the corner of the uncut band, where material stands on
 * two sides at once: measured on a 34mm pocket with a ⌀6 cutter at a 0.4xD
 * stepover, **0.97xD at the full 6mm depth of cut**, four times, while the
 * rings either side of it ran at 0.5xD.
 *
 * Landing on the nearest *point* instead — the perpendicular projection — is
 * better and still wrong: crossing a band perpendicular is a full-width cut
 * however short it is. What makes the step light is taking it at a shallow
 * angle, so start the loop a run-in *further along* it. The tool then advances
 * the stepover over `runIn` of travel instead of over nothing, and the band it
 * is opening is the same width as the one the ring itself takes.
 *
 * @param runIn how far along the loop to start, in mm; capped at a quarter of
 *   the loop so a small ring does not spend its length transitioning
 */
export function startNearestSlide(loop, from, runIn) {
  if (!from || loop.length < 6) return loop;
  const n = loop.length / 2;
  const at = (i) => [loop[(i % n) * 2], loop[(i % n) * 2 + 1]];

  // the closest point on the loop, which may be part-way along a segment
  let bestIndex = 0;
  let bestT = 0;
  let bestDistance = Infinity;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = at(i);
    const [bx, by] = at(i + 1);
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    total += Math.sqrt(lenSq);
    let t = lenSq > 0 ? ((from[0] - ax) * dx + (from[1] - ay) * dy) / lenSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t - from[0];
    const py = ay + dy * t - from[1];
    const d = px * px + py * py;
    if (d < bestDistance) { bestDistance = d; bestIndex = i; bestT = t; }
  }

  // walk on along the loop, in the direction it is cut, by the run-in
  let want = Math.max(0, Math.min(runIn, total / 4));
  let index = bestIndex;
  let t = bestT;
  for (let step = 0; step <= n; step++) {
    const [ax, ay] = at(index);
    const [bx, by] = at(index + 1);
    const segment = Math.hypot(bx - ax, by - ay);
    const remaining = segment * (1 - t);
    if (remaining >= want) {
      t += segment > 0 ? want / segment : 0;
      break;
    }
    want -= remaining;
    index += 1;
    t = 0;
  }
  index %= n;

  const [ax, ay] = at(index);
  const [bx, by] = at(index + 1);
  const mid = [ax + (bx - ax) * t, ay + (by - ay) * t];
  // exactly on a vertex is a plain rotation, and saying so keeps a loop that
  // was already in the right place byte-identical
  if (t <= 1e-9) return startNearest(loop, mid);
  if (t >= 1 - 1e-9) return startNearest(loop, [bx, by]);
  const out = [mid[0], mid[1]];
  for (let i = 1; i <= n; i++) {
    const k = (index + i) % n;
    out.push(loop[k * 2], loop[k * 2 + 1]);
  }
  return out;
}

/**
 * How many times a ramp may go back over its own length before the angle is
 * treated as unreachable rather than honoured.
 *
 * A ramp descends by *length*, so a short path at a shallow angle needs a great
 * many laps: a 0.6mm leftover span at 2° descends 20 microns per traversal, and
 * two millimetres of stepdown is a hundred laps. That was measured, not
 * imagined — it is the single biggest source of blocks in an adaptive program,
 * and the reason raising the ramp angle from 2° to 7° cut the file by a third.
 *
 * It is also not a ramp. A hundred passes over half a millimetre is the cutter
 * oscillating inside its own footprint at plunge depth: the same cut as a
 * plunge, taking a hundred times as many blocks and a hundred times as long.
 */
const MAX_RAMP_LAPS = 8;

/**
 * The angle a ramp actually descends at, given how far it has to go down and
 * how much path it has to do it on.
 *
 * The requested angle is a limit on how hard the tool is asked to plunge, so it
 * is honoured wherever it can be. Where it cannot — where honouring it would
 * mean more laps than MAX_RAMP_LAPS — the choice is between steepening and
 * plunging, and steepening is the gentler of the two by exactly the factor the
 * lap cap allows.
 *
 * @returns { slope, laps, steepened } — steepened says the answer is not what
 *   was asked for, so the caller can report it
 */
export function rampSlopeFor(depth, spanLength, rampAngleDeg, maxLaps = MAX_RAMP_LAPS) {
  const asked = Math.tan((rampAngleDeg * Math.PI) / 180);
  if (!(spanLength > 0) || !(depth > 0) || !(asked > 0)) {
    return { slope: asked, laps: 0, steepened: false };
  }
  const laps = depth / (spanLength * asked);
  if (laps <= maxLaps) return { slope: asked, laps, steepened: false };
  return { slope: depth / (spanLength * maxLaps), laps: maxLaps, steepened: true };
}

/** Length of an open polyline of [x, y] points. */
function pathLength(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return total;
}

/** Length once round a closed flat loop [x0, y0, …]. */
function loopPerimeter(loop) {
  const n = loop.length / 2;
  let total = 0;
  for (let i = 0, k = n - 1; i < n; k = i++) {
    total += Math.hypot(loop[i * 2] - loop[k * 2], loop[i * 2 + 1] - loop[k * 2 + 1]);
  }
  return total;
}

/** Machine one full perimeter at depth, starting and ending at loop[0]. */
export function cutPerimeter(cl, loop, z) {
  const n = loop.length / 2;
  for (let i = 1; i <= n; i++) {
    const k = i % n;
    cl.cut(loop[k * 2], loop[k * 2 + 1], z);
  }
}

/**
 * @param options.walkPerimeter optional (loop, z) => void: how the final closed
 *   pass at target depth is walked. Defaults to plain cutPerimeter. Used by
 *   contour with tabs, which lifts the cutter for a few short spans as it goes.
 * @param options.alreadyThere the tool is already sitting on the loop at
 *   `zEntry` — do not drop to it again. Set by a pass that arrived along a
 *   lead-in.
 * @returns the loop as it was finally walked, which is *not* the loop passed in
 *   when the ramp reached depth partway round: the last lap then starts and ends
 *   at the ramp-out point. A caller that follows the pass with a lead-out needs
 *   to know where the pass actually finished.
 */
export function cutLoopWithRamp(cl, loop, zEntry, zTarget, rampAngleDeg = 0, options = {}) {
  const n = loop.length / 2;
  const pt = (i) => [loop[(((i % n) + n) % n) * 2], loop[(((i % n) + n) % n) * 2 + 1]];
  const walk = options.walkPerimeter ?? ((l, z) => cutPerimeter(cl, l, z));
  // rapid down to the feed plane rather than feeding through the air above the
  // material; see heights.js for why that is worth doing
  const dropTo = (x, y, z) => {
    const plane = options.feedPlane;
    if (plane != null && plane > z + 1e-9) cl.rapid(x, y, plane);
    cl.cut(x, y, z, FEED.PLUNGE);
  };

  if (!(rampAngleDeg > 0) || zEntry <= zTarget + 1e-9) {
    const [x0, y0] = pt(0);
    dropTo(x0, y0, zTarget);
    walk(loop, zTarget);
    return loop;
  }

  // A closed loop ramps round and round itself, so the same lap cap applies:
  // a 3mm hole at 2° is nine laps of the circle per millimetre of depth, and
  // the blocks for all of them buy nothing a steeper descent would not.
  const perimeter = loopPerimeter(loop);
  const { slope } = rampSlopeFor(zEntry - zTarget, perimeter, rampAngleDeg);
  const [sx, sy] = pt(0);
  // down to the material top, where the ramp begins — unless a lead-in already
  // brought the tool there, in which case dropping again is a move to where it
  // is standing
  if (!options.alreadyThere) dropTo(sx, sy, zEntry);

  let z = zEntry;
  let i = 0;
  let guard = n * (MAX_RAMP_LAPS + 1);   // hard cap; see rampSlopeFor
  while (guard-- > 0) {
    const a = pt(i), b = pt(i + 1);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dz = len * slope;
    if (dz <= 1e-12) { i++; continue; }

    if (z - dz <= zTarget + 1e-9) {
      // target depth is reached partway along this segment — insert that point,
      // then walk one full perimeter at depth, closing back on it
      const f = (z - zTarget) / dz;
      const px = a[0] + (b[0] - a[0]) * f;
      const py = a[1] + (b[1] - a[1]) * f;
      cl.cut(px, py, zTarget, FEED.RAMP);
      // build a loop that starts at the ramp-out point so the walker can
      // apply tabs symmetrically from there
      const rotated = rotateLoop(loop, i + 1, [px, py]);
      walk(rotated, zTarget);
      return rotated;
    }
    z -= dz;
    cl.cut(b[0], b[1], z, FEED.RAMP);
    i++;
  }
  // guard tripped (degenerate loop): finish with a plunge + perimeter
  dropTo(sx, sy, zTarget);
  walk(loop, zTarget);
  return loop;
}

/**
 * Enter and cut an *open* span — the shape a clearing pass leaves once the part
 * has trimmed a ring into pieces.
 *
 * A closed loop can ramp down over its own length and close back on itself, so
 * the wedge left under the ramp is cut away by the time the loop finishes. An
 * open span has no such luck: it descends to one end and stops. So the ramp
 * zig-zags back and forth along the span until it reaches depth, then covers the
 * span in both directions at depth, which is what takes the wedge out.
 *
 * How short is too short to ramp at all: `minLength`, which the caller sets to
 * the cutter's diameter. Below that every point of the span is within one
 * radius of every other, so the whole of it lies inside a single cutter
 * footprint — the tool never leaves the hole it is making, whatever angle it is
 * told to descend at. That is a plunge, and writing it as a plunge is the
 * honest version of what a hundred laps over half a millimetre already was.
 *
 * @param emit (x, y, z, feedClass) => void — the caller's move sink, so a
 *   strategy tracking material removal sees every move the entry makes
 * @param pts array of [x, y]
 * @param options.minLength below this span length, plunge instead
 * @param options.onSteepen called with the angle actually used, in degrees,
 *   when the requested one would have needed more laps than are allowed
 * @returns the [x, y] the tool finishes on
 */
export function cutSpanWithRamp(emit, pts, zEntry, zTarget, rampAngleDeg = 0, options = {}) {
  const { minLength = 0, onSteepen = null } = options;
  const forward = pts;
  const back = [...pts].reverse();
  // The passes that follow a ramp are still part of getting in: they take off
  // the wedge the ramp left, which is as wide as the cutter however light the
  // rest of the pass is. Classing them as lead moves keeps that visible — to the
  // machinist reading the backplot, and to anything measuring what the cut does.
  const walk = (path, from, z, feed) => {
    for (let i = from; i < path.length; i++) emit(path[i][0], path[i][1], z, feed);
    return path[path.length - 1];
  };

  const length = pathLength(pts);
  const ramping = rampAngleDeg > 0 && zEntry > zTarget + 1e-9;
  if (!ramping || pts.length < 2 || length < minLength) {
    emit(pts[0][0], pts[0][1], zTarget, FEED.PLUNGE);
    // Which of the two this is decides how the pass that follows is classed,
    // and the distinction is not cosmetic. With no ramp asked for, a plunge is
    // simply how this operation enters and what follows is ordinary cutting,
    // held to the bite limit like everything else. Where a ramp *was* asked for
    // and the span is too short to take one, the pass that follows is the
    // entry — the same material the zig-zag and its two return traversals used
    // to remove, and those were leads. Calling it a cut instead would report a
    // bite that the ramp angle, not the bite limit, is what governs.
    return walk(forward, 1, zTarget, ramping ? FEED.LEAD : FEED.CUT);
  }

  const ramp = rampSlopeFor(zEntry - zTarget, length, rampAngleDeg);
  const { slope } = ramp;
  if (ramp.steepened) onSteepen?.((Math.atan(slope) * 180) / Math.PI);
  emit(pts[0][0], pts[0][1], zEntry, FEED.PLUNGE);   // through air to material top

  let z = zEntry;
  // one spare lap over what the slope was solved for, so float error at the
  // last chord cannot leave the ramp one micron short and fall through
  for (let lap = 0; lap <= MAX_RAMP_LAPS; lap++) {
    const path = lap % 2 === 0 ? forward : back;
    const other = lap % 2 === 0 ? back : forward;
    for (let i = 1; i < path.length; i++) {
      const [ax, ay] = path[i - 1];
      const [x, y] = path[i];
      const len = Math.hypot(x - ax, y - ay);
      const dz = len * slope;
      if (dz <= 1e-12) continue;
      if (z - dz <= zTarget + 1e-9) {
        const f = (z - zTarget) / dz;
        emit(ax + (x - ax) * f, ay + (y - ay) * f, zTarget, FEED.RAMP);
        walk(path, i, zTarget, FEED.LEAD);          // finish this traversal at depth
        return walk(other, 1, zTarget, FEED.LEAD);  // and come back over the wedge
      }
      z -= dz;
      emit(x, y, z, FEED.RAMP);
    }
  }
  // a span too short for the ramp to ever land: drop in and cut it
  emit(pts[0][0], pts[0][1], zTarget, FEED.PLUNGE);
  return walk(forward, 1, zTarget, FEED.CUT);
}

/** Return the loop rotated so it starts at `start`, with `origin` prepended. */
function rotateLoop(loop, start, origin) {
  const n = loop.length / 2;
  const out = [origin[0], origin[1]];
  for (let k = start; k < start + n; k++) {
    const idx = ((k % n) + n) % n;
    out.push(loop[idx * 2], loop[idx * 2 + 1]);
  }
  return out;
}
