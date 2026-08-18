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

import { offsetNormalized } from '../geom/clipper.js';

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
