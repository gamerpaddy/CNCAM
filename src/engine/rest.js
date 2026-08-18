// Rest machining: what the operations before this one already took off.
//
// A program is a sequence, and every operation in it is generated as though it
// were the first. So the finishing pass re-walks the whole part at full depth
// through air the roughing pass cleared an hour ago, and the second roughing
// pass with the small cutter goes everywhere the big one already went — which
// is the commonest reason a program takes twice as long as it needs to, and it
// is invisible on screen because cutting air looks exactly like cutting.
//
// What is *certainly* gone is not a guess. A milling cutter is a cylinder: when
// its centre passes over a point at height z, everything above z within the
// tool's radius of that point is removed. So the area cleared to a depth is the
// earlier programs' cutting moves at or below that depth, each buffered by the
// tool that made them, unioned. No simulation, no raster, no thresholds — the
// toolpath already says it.
//
// The direction of the approximation is the part that matters. Buffering by the
// tool radius is exact for a flat cutter and *generous* for a ball or a V bit,
// whose radius at the tip is smaller than its nominal one — so the deduction is
// shrunk by `margin` before it is used, and the strategies erode it by their own
// radius on top of that (see engine/regions.js). Both push the same way: toward
// cutting somewhere that turned out to be empty, which costs seconds, and away
// from skipping somewhere that turned out to be solid, which costs a cutter.

import { eachMove, OP, FEED } from './cl.js';
import { bufferOpenPaths, unionLoops } from '../geom/clipper.js';

/**
 * How much of the deduction is given back, in mm.
 *
 * A tenth of a millimetre is below anything a roughing pass holds and well
 * above the chording error of a buffered polyline, so it costs nothing and
 * covers the case the buffer is optimistic about.
 */
const DEFAULT_MARGIN = 0.1;

/**
 * The XY area earlier programs have already cleared down to `z`.
 *
 * @param earlier [{ cl, tool }] in program order — only the ones before this
 *   operation, and only ones that actually have a toolpath
 * @param z the depth to ask about. Material at this height is gone where some
 *   earlier cut passed at or below it.
 * @returns closed loops, or [] when nothing qualifies
 */
export function clearedArea(earlier, z, { margin = DEFAULT_MARGIN, tolerance = 0.01 } = {}) {
  const loops = [];
  for (const { cl, tool } of earlier ?? []) {
    const radius = (tool?.diameter ?? 0) / 2 - margin;
    if (!cl || !(radius > 0)) continue;
    const paths = cuttingPathsBelow(cl, z);
    if (paths.length === 0) continue;
    loops.push(...bufferOpenPaths(paths, radius, tolerance));
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
 * The cutting moves at or below `z`, chained into polylines.
 *
 * Chained rather than buffered one segment at a time because the union of ten
 * thousand two-point capsules is the same shape as the union of a hundred
 * polylines and takes a great deal longer to compute.
 *
 * A move counts only when **both** of its ends are at or below `z`: a plunge
 * from clearance down to depth passes through the height being asked about, but
 * it has not cleared the part of the column above where it stopped, and half of
 * a ramp is not a cleared floor.
 */
function cuttingPathsBelow(cl, z) {
  const paths = [];
  let current = null;
  let prev = null;
  eachMove(cl, (op, x, y, moveZ, i, j, k, feed) => {
    const point = [x, y, moveZ];
    const cutting = op === OP.LINE && feed !== FEED.RAPID;
    // A drill is a cut too, and the hole it leaves is exactly the tool: its one
    // move stands for the whole depth, so it counts wherever it ends up.
    const drilling = op === OP.DRILL;
    const low = moveZ <= z + 1e-9;
    if (drilling && low) {
      paths.push([x, y, x, y]);
      current = null;
    } else if (cutting && low && prev && prev[2] <= z + 1e-9) {
      if (!current) { current = [prev[0], prev[1]]; paths.push(current); }
      current.push(x, y);
    } else {
      current = null;
    }
    prev = point;
  });
  return paths.filter((p) => p.length >= 4);
}
