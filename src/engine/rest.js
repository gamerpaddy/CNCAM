// Rest machining: what the operations before this one already took off.
//
// A program is a sequence, and every operation in it is generated as though it
// were the first. So the finishing pass re-walks the whole part at full depth
// through air the roughing pass cleared an hour ago, and the second roughing
// pass with the small cutter goes everywhere the big one already went — which
// is the commonest reason a program takes twice as long as it needs to, and it
// is invisible on screen because cutting air looks exactly like cutting.
//
// What is *certainly* gone is not a guess. When a cutter's tip passes at height
// zm, everything above zm within the tool's radius *at that height* is removed.
// So the area cleared down to z is the earlier programs' cutting moves at or
// below z, each buffered by how wide the tool was at z, unioned. No simulation,
// no raster, no thresholds — the toolpath already says it.
//
// "How wide the tool was at z" is the whole of the care needed here. A flat
// cutter is a cylinder and the buffer is its nominal radius whatever height is
// asked about. A ball nose is not: a ⌀6 ball whose tip passed 2mm below the
// height being asked about was only 2.24mm across up there, not 6, and
// buffering it by 3 claims three quarters of a millimetre of metal came off
// that is still standing. That is the one direction this may not be wrong in —
// skipping solid ground costs a cutter, where cutting empty ground costs
// seconds. So the radius is read off the tool's own silhouette
// (tool-geometry.js profileTable), which is the same shape the simulator sweeps.
//
// A blanket fudge used to stand in for that: the deduction was shrunk by a
// tenth of a millimetre whatever the cutter. It never covered the ball nose it
// was for — three quarters of a millimetre is not a tenth — and it cost a full
// lap round the part at every level, because a tenth of a millimetre of
// leftover ribbon is still a region, and a region gets a ring. Measured on the
// step plate, ⌀12 clearing then a ⌀6 rest pass: 10.6m of the rest pass's 10.8m
// of feed motion removed no metal at all.

import { eachMove, OP, FEED } from './cl.js';
import { bufferOpenPaths, unionLoops } from '../geom/clipper.js';
import { profileTable } from './tool-geometry.js';

/**
 * Radii are grouped into buckets this wide, in mm, before the paths are chained.
 *
 * A flat cutter has one radius whatever height it is asked about, so its whole
 * program falls in a single bucket and the chaining is exactly what it was. A
 * ball nose has a different radius at every height, and buffering each move on
 * its own would be the union-of-ten-thousand-capsules the chaining exists to
 * avoid — so the radius is rounded down to a twentieth of a millimetre, which
 * is finer than the deduction is ever read at and coarse enough that a pass at
 * one depth stays one path.
 *
 * Rounded *down*, so a bucket never claims more reach than the tool had.
 */
const RADIUS_BUCKET = 0.05;

/**
 * The XY area earlier programs have already cleared down to `z`.
 *
 * @param earlier [{ cl, tool }] in program order — only the ones before this
 *   operation, and only ones that actually have a toolpath
 * @param z the depth to ask about. Material at this height is gone where some
 *   earlier cut passed at or below it.
 * @returns closed loops, or [] when nothing qualifies
 */
export function clearedArea(earlier, z, { tolerance = 0.01 } = {}) {
  const loops = [];
  for (const { cl, tool } of earlier ?? []) {
    if (!cl || !(tool?.diameter > 0)) continue;
    for (const { radius, paths } of cuttingPathsBelow(cl, z, tool)) {
      // A hair past the swept edge, and deliberately: the boundary of what an
      // earlier pass cleared is, on a straight wall, the *same line* as the
      // keep-out the next cutter stands off — both are the part offset by a
      // radius. Stopping exactly on it leaves the two booleans arguing over a
      // shared edge, and the ribbon that survives the argument is cut as a full
      // lap round the part at every level. See the note above `bucketed`.
      if (radius > 0) loops.push(...bufferOpenPaths(paths, radius + tolerance, tolerance));
    }
  }
  return loops.length ? unionLoops(loops) : [];
}

/**
 * The same answer at every depth the operation is going to cut at.
 *
 * One area is not enough, and asking for it at one depth is the whole of the
 * old fault: the cleared area *shrinks* as you go down — at the bottom of a
 * part only the margin outside it has been cleared to there — so an operation
 * that took the answer at its own Bottom Z deducted a ring round the outside
 * and nothing else. The levels where the earlier pass had actually removed
 * everything, which are the shallow ones, got no deduction at all. The pass
 * then had to route round that ring at every level, and rest machining came
 * out *longer* than the same operation with it switched off.
 *
 * A slice per level, computed from scratch. The obvious saving — buffer each
 * move once into the shallowest level it counts at and accumulate upward — is
 * not available, because the paths are *chained* before they are buffered and
 * two spans that were separate at one level join into one at the next; the
 * increment is not a suffix of anything. An operation has a handful of levels
 * and the chaining is what makes each one cheap, so this is left plain.
 *
 * @param levels the depths to answer at, in any order
 * @returns [{ z, loops }] sorted deepest first — see clearedAt in regions.js
 *   for how a query lands on a slice
 */
export function clearedStack(earlier, levels, options = {}) {
  const zs = [...new Set(levels)].filter((z) => Number.isFinite(z)).sort((a, b) => a - b);
  // deepest first, which is also smallest first: the area only grows as the
  // question moves up the part
  return zs.map((z) => ({ z, loops: clearedArea(earlier, z, options) }))
    .filter((slice) => slice.loops.length > 0);
}

/**
 * How wide `tool` is at `height` above its tip, from its own silhouette.
 *
 * `profileTable` holds the other direction — the surface height at each radius
 * — because that is what the sweep needs. This reads it backwards: the widest
 * radius whose flank is still at or below the height asked about. Above the
 * flank the answer is the full cutting radius, which is every height on a flat
 * cutter and every height above the ball on a ball nose.
 */
function radiusAtHeight(profile, height) {
  if (!(height > 0)) return profile.flat ? profile.radius : 0;
  if (profile.flat || height >= profile.edge) return profile.radius;
  const { table, samples, radius } = profile;
  let widest = 0;
  for (let i = 0; i <= samples; i++) {
    if (table[i] <= height) widest = i;
  }
  return (radius * widest) / samples;
}

/**
 * The cutting moves at or below `z`, chained into polylines and grouped by how
 * wide the tool was at `z` when it made them.
 *
 * Chained rather than buffered one segment at a time because the union of ten
 * thousand two-point capsules is the same shape as the union of a hundred
 * polylines and takes a great deal longer to compute. Grouped because a shaped
 * cutter's reach depends on how far below `z` its tip was, and one buffer
 * distance for the whole program would have to be the smallest of them to be
 * honest — which would throw away most of the deduction on any part deeper than
 * the tool's tip. A flat cutter yields exactly one group, so this is the old
 * behaviour for the commonest case.
 *
 * A move counts only when **both** of its ends are at or below `z`: a plunge
 * from clearance down to depth passes through the height being asked about, but
 * it has not cleared the part of the column above where it stopped, and half of
 * a ramp is not a cleared floor. The radius is read at the *higher* of the two
 * ends, which is the narrower part of the tool and so the safe one.
 *
 * @returns [{ radius, paths }] — paths are flat [x0,y0,x1,y1,…]
 */
function cuttingPathsBelow(cl, z, tool) {
  const profile = profileTable(tool);
  const groups = new Map();
  // A program holds a handful of distinct heights and a great many moves at
  // each, and reading the silhouette is a scan of its table — so it is read
  // once per height rather than once per move.
  const cache = new Map();
  const bucketFor = (topZ) => {
    const key = Math.round((z - topZ) * 1000);
    let bucket = cache.get(key);
    if (bucket === undefined) {
      // rounded down, so a bucket never claims more reach than the tool had
      bucket = Math.floor(radiusAtHeight(profile, key / 1000) / RADIUS_BUCKET) * RADIUS_BUCKET;
      cache.set(key, bucket);
    }
    return bucket;
  };
  const pathsFor = (radius) => {
    if (!groups.has(radius)) groups.set(radius, []);
    return groups.get(radius);
  };
  let current = null;
  let currentRadius = null;
  let prev = null;
  eachMove(cl, (op, x, y, moveZ, i, j, k, feed) => {
    const point = [x, y, moveZ];
    const cutting = op === OP.LINE && feed !== FEED.RAPID;
    // A drill is a cut too, and the hole it leaves is exactly the tool: its one
    // move stands for the whole depth, so it counts wherever it ends up.
    const drilling = op === OP.DRILL;
    const low = moveZ <= z + 1e-9;
    if (drilling && low) {
      pathsFor(bucketFor(moveZ)).push([x, y, x, y]);
      current = null;
    } else if (cutting && low && prev && prev[2] <= z + 1e-9) {
      const radius = bucketFor(Math.max(moveZ, prev[2]));
      if (!current || radius !== currentRadius) {
        current = [prev[0], prev[1]];
        currentRadius = radius;
        pathsFor(radius).push(current);
      }
      current.push(x, y);
    } else {
      current = null;
    }
    prev = point;
  });
  return [...groups.entries()]
    .map(([radius, paths]) => ({ radius, paths: paths.filter((p) => p.length >= 4) }))
    .filter((group) => group.radius > 0 && group.paths.length > 0);
}
