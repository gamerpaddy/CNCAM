// Concentric offset passes over a region, spaced so they divide it.
//
// Every 2.5D clearing strategy works the same way: take the area the cutter
// centre may occupy and erode it by a stepover at a time until nothing is left.
// The obvious way to write that is `offset(area, -k * step)` for k = 0, 1, 2…
// and it is wrong in one specific, measurable way — the last pass takes the
// remainder.
//
// A band 11mm wide with a ⌀6 cutter at a 3mm stepover puts its passes 3mm
// apart from each edge: at 0 and 3 coming in from one side, at 8 and 11 from
// the other. The pass at 8 arrives with material from 6 to 11 in front of it
// and takes **5mm** in one bite — 0.83 of the cutter's diameter on an operation
// set to half of it. Nothing about that is visible in the settings: it is the
// band's width divided by the stepover having a remainder, and the last pass
// inheriting it.
//
// So the spacing is solved rather than assumed. The region has a *medial
// depth* — the furthest it can be eroded before it empties, which is half the
// widest part of it — and the passes are laid out to land exactly on it:
// `n = ceil(depth / step)` passes at `depth / n` apart. The spacing is never
// more than the stepover asked for and the two families meet in the middle
// instead of overlapping by whatever was left over.

import { offsetNormalized, loopArea } from '../geom/clipper.js';
import { pointInLoops, distanceToLoops } from '../geom/inside.js';
import { rampSlopeFor } from './linking.js';

/** Never more than this many passes over one piece, whatever the arithmetic. */
const MAX_RINGS = 500;

/** How finely the medial depth is pinned down, as a share of the stepover. */
const DEPTH_STEPS = 6;

/**
 * The furthest this region can be eroded before there is nothing left of it.
 *
 * Found by doubling and then bisecting, because the answer is a property of the
 * shape rather than of anything the caller knows: the widest part of a roughing
 * band is wherever the part happens to be furthest from the stock.
 */
function medialDepth(loops, step, tolerance) {
  let lo = 0;                       // known to leave something
  let hi = step;
  while (hi < step * MAX_RINGS && offsetNormalized(loops, -hi, tolerance).length > 0) {
    lo = hi;
    hi *= 2;
  }
  for (let i = 0; i < DEPTH_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (offsetNormalized(loops, -mid, tolerance).length > 0) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * `loops` eroded a pass at a time, spaced so the passes divide the region.
 *
 * @param loops the tool-centre area, outer boundaries and holes together
 * @param step the stepover asked for — an upper bound on the spacing, never
 *   the spacing itself
 * @param radius the cutter's, which decides when a second pass is a second
 *   pass and when it is the first one cut again: a region no deeper than the
 *   radius is swept whole by the boundary pass, and adding the medial one there
 *   is a lap round a ribbon that has already gone. Rest machining leaves
 *   exactly those, and re-cutting them made a rest pass *longer* than the pass
 *   it was meant to shorten.
 * @returns [k] => the loops of the region eroded k spacings; [0] is `loops`
 */
export function concentricRings(loops, step, tolerance, radius = 0) {
  if (loops.length === 0) return [];
  const depth = medialDepth(loops, step, tolerance);
  // A region no wider than one pass is one pass: eroding it at all empties it.
  if (!(depth > 1e-6) || depth <= radius + 1e-9) return [loops];
  const n = Math.min(MAX_RINGS, Math.max(1, Math.ceil(depth / step - 1e-9)));
  const spacing = depth / n;
  const rings = [loops];
  for (let k = 1; k <= n; k++) {
    const ring = offsetNormalized(loops, -k * spacing, tolerance);
    // The last one lands *on* the medial axis, where the region is a curve
    // rather than an area, so an empty answer there is the shape running out
    // and not an error.
    if (ring.length === 0) break;
    rings.push(ring);
  }
  return rings;
}

/**
 * What to enter a pocket's core on, when the core is too small to ramp round.
 *
 * The innermost ring of a round or a square region is its medial axis, and
 * there that is a *point*: the offsetter hands back a loop a few hundredths
 * across. A pass that ramps in along it goes round and round the point until
 * the lap cap in engine/linking.js steepens it — eight laps of a 0.05mm square
 * is a 62° plunge written as thirty-two blocks, on an operation set to 3°. The
 * angle on the Entry tab did nothing, and nothing said so. Pocketing met it on
 * every square and round pocket, Z-level roughing on every enclosed one.
 *
 * A ring that short cuts nothing the ring outside it does not, when that one
 * sweeps the whole of its inside: a cutter walking a loop clears everything
 * within its radius of the loop. So where the next ring out encloses it and
 * does that, the core is not a pass of its own (`'drop'`), and the ramp goes
 * down the next ring instead — a helix of a real radius. Where the next ring is
 * too far out to reach the middle (a stepover over half the cutter), the middle
 * is cut by a circle round it — half the cutter's radius, the usual helical
 * entry, or as much of that as the region has room for — which clears all the
 * point would have, because the cutter is wider than the circle (`'replace'`).
 *
 * @param loop the ring the pass would ramp in on
 * @param next the ring cut after it, if any — the candidate to enter on instead
 * @param options.depth how far the ramp descends
 * @param options.area the loops the tool centre must stay inside
 * @returns { action: 'keep' } | { action: 'drop' } | { action: 'replace', loop }
 */
export function coreEntry(loop, next, {
  depth, rampAngle, radius, tolerance, area,
}) {
  const keep = { action: 'keep' };
  if (!(rampAngle > 0) || !(depth > 1e-9) || !loop || loop.length < 6) return keep;
  if (!rampSlopeFor(depth, perimeterOf(loop), rampAngle).steepened) return keep;
  if (next && encloses(next, loop)
    && offsetNormalized([next], -(radius - tolerance), tolerance).length === 0) {
    return { action: 'drop' };
  }
  const [x0, y0, x1, y1] = boxOf(loop);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let reach = 0;              // how far the ring strays from its own middle
  for (let i = 0; i < loop.length; i += 2) {
    reach = Math.max(reach, Math.hypot(loop[i] - cx, loop[i + 1] - cy));
  }
  // the centre must stay where a tool centre may go, and the circle inside the
  // cutter's own radius, or the middle of it is left standing
  const room = Math.min(distanceToLoops(area ?? [], cx, cy), radius) - tolerance;
  const helix = Math.min(radius / 2, room);
  if (!(helix > reach + tolerance)) return keep;
  return { action: 'replace', loop: circleLoop(cx, cy, helix, tolerance) };
}

/** How far the tool travels round a closed loop. */
function perimeterOf(loop) {
  const n = loop.length / 2;
  let sum = 0;
  for (let i = 0, k = n - 1; i < n; k = i++) {
    sum += Math.hypot(loop[i * 2] - loop[k * 2], loop[i * 2 + 1] - loop[k * 2 + 1]);
  }
  return sum;
}

/** [minX, minY, maxX, maxY] of one flat loop. */
function boxOf(loop) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < loop.length; i += 2) {
    b[0] = Math.min(b[0], loop[i]); b[1] = Math.min(b[1], loop[i + 1]);
    b[2] = Math.max(b[2], loop[i]); b[3] = Math.max(b[3], loop[i + 1]);
  }
  return b;
}

/** Does closed loop `outer` go round `inner`? A micron of slack for the grid. */
function encloses(outer, inner) {
  if (!(loopArea(outer) > 0)) return false;
  const a = boxOf(inner);
  const b = boxOf(outer);
  if (a[0] < b[0] - 1e-3 || a[1] < b[1] - 1e-3 || a[2] > b[2] + 1e-3 || a[3] > b[3] + 1e-3) return false;
  return pointInLoops([outer], (a[0] + a[2]) / 2, (a[1] + a[3]) / 2);
}

/** A counter-clockwise circle, chorded to `tolerance`. */
function circleLoop(cx, cy, radius, tolerance) {
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / radius)));
  const n = Math.max(12, Math.min(720, Math.ceil((2 * Math.PI) / Math.max(step, 1e-6))));
  const loop = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    loop[i * 2] = cx + radius * Math.cos(a);
    loop[i * 2 + 1] = cy + radius * Math.sin(a);
  }
  return loop;
}

