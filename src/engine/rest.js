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
import { bufferOpenPaths, unionLoops, diffLoops } from '../geom/clipper.js';
import { profileTable } from './tool-geometry.js';
import { stockOutline } from './stock.js';

/**
 * The roughing strategies that start from the billet as it stands, and so are
 * told what a facing pass ahead of them took off without being asked.
 *
 * Rest machining is a switch, and off is the right default for it: whether a
 * second cutter should skip the first one's ground is a decision. Facing is not
 * like that. A facing pass exists to remove the top of the billet, the roughing
 * pass after it opens with a level across the top of the billet, and nobody
 * means the second one to repeat the first. It did: on the step plate the whole
 * of the opening level ran through air a face mill had already been over, 2.1m
 * of a Z-level rough and 7.3m of an adaptive one — a third of that operation.
 *
 * Only these two, because they are the ones that cut a level at the top of the
 * stock. A second facing pass at the same height is a spring pass and has to
 * stay one.
 */
const ROUGHS_THE_BILLET = new Set(['clear2d', 'adaptive']);

/**
 * The operations ahead of `op` whose cuts it leaves out, in program order.
 *
 * All of them with rest machining on; the facing passes otherwise, for the
 * strategies above. One answer, because three places need it and they may not
 * disagree: what is deducted (app/regions-ui.js), what the operation's
 * fingerprint is made from (app/op-status.js), and which jobs have to finish
 * before this one is described (app/actions/program.js).
 *
 * Disabled operations are skipped — a pass that is not going to run has cleared
 * nothing.
 */
export function deductedBefore(op, operations) {
  const all = !!op?.params?.restMachining;
  if (!all && !ROUGHS_THE_BILLET.has(op?.type)) return [];
  const out = [];
  for (const previous of operations ?? []) {
    if (previous.id === op.id) break;
    if (!previous.enabled) continue;
    if (all || previous.type === 'face') out.push(previous);
  }
  return out;
}

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
 * How far above the depth asked about a move may sit and still be *at* it, in mm.
 *
 * The moves are stored as 32-bit floats and the depth asked about is a double,
 * and the two are the same number only when it happens to be a binary fraction:
 * a level at Z-10.7 is stored as -10.69999981, which is above -10.7. Compared
 * to a billionth of a millimetre, a pass that cut *exactly the level being
 * asked about* never counted — and two roughing passes on one part share their
 * levels by construction, because both add one at each of the part's flats.
 * Measured on the step plate, an adaptive rest pass after a complete Z-level
 * rough: 5.86m of feed, 98.3% of it through air.
 *
 * A float this size is good to better than a hundred-thousandth of a
 * millimetre; a tenth of a micron of standing metal is not a cut.
 */
const SAME_LEVEL = 1e-4;

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
  const outside = options.stock ? outsideOf(options.stock, options.tolerance ?? 0.01) : [];
  return zs.map((z) => ({ z, loops: clearedArea(earlier, z, options) }))
    .filter((slice) => slice.loops.length > 0)
    .map((slice) => (outside.length
      ? { z: slice.z, loops: unionLoops([...slice.loops, ...outside]) } : slice));
}

/** How far round the billet "there is nothing out here" is stated, in mm. */
const FAR = 1000;

/**
 * Everything that is not billet: a wide frame with the stock's footprint cut
 * out of it.
 *
 * What an earlier pass cleared is read off where its cutter went, and a cutter
 * does not go far past the edge of the stock — so the area it leaves stops a
 * radius or so outside the billet, and the ground beyond that reads as *not
 * cleared*. It is the one place that needs no clearing at all. A rest pass
 * handed that deduction found a band between "cleared" and the edge of its own
 * region, all the way round the billet, and cut it: a lap round the outside of
 * the stock at every level, 489mm of it on the step plate, through nothing.
 *
 * Joined to a slice only where an earlier pass cleared something at that depth
 * — a level nobody has touched keeps the empty answer, and with it the path it
 * always had. Inside the footprint by the same hair `clearedArea` reaches past
 * a swept edge, and for the same reason: two booleans must not share an edge.
 */
function outsideOf(stock, tolerance) {
  const hole = stockOutline(stock, -tolerance);
  if (!hole.length) return [];
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const loop of hole) {
    for (let i = 0; i + 1 < loop.length; i += 2) {
      if (loop[i] < x0) x0 = loop[i];
      if (loop[i] > x1) x1 = loop[i];
      if (loop[i + 1] < y0) y0 = loop[i + 1];
      if (loop[i + 1] > y1) y1 = loop[i + 1];
    }
  }
  if (!(x1 > x0) || !(y1 > y0)) return [];
  const frame = [x0 - FAR, y0 - FAR, x1 + FAR, y0 - FAR, x1 + FAR, y1 + FAR, x0 - FAR, y1 + FAR];
  return diffLoops([frame], hole);
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
  if (profile.flat || height >= profile.edge) return profile.radius;
  const { table, samples, radius } = profile;
  // At the tip itself (height 0) a ball nose is a point and cleared nothing
  // wider — but a bull nose or a V bit with a flat on its end is as wide as that
  // flat, and a pass cut at exactly this level has swept it. Reading a bull as a
  // point there made every level the cutter had *just* cut look untouched, so a
  // rest pass re-walked each level's whole floor: a ⌀8 bull adaptive took 7.7
  // more minutes of step-up levels on the step plate, half of it through air.
  const limit = Math.max(0, height) + 1e-9;
  let widest = 0;
  for (let i = 0; i <= samples; i++) {
    if (table[i] <= limit) widest = i;
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
    const low = moveZ <= z + SAME_LEVEL;
    if (drilling && low) {
      pathsFor(bucketFor(moveZ)).push([x, y, x, y]);
      current = null;
    } else if (cutting && low && prev && prev[2] <= z + SAME_LEVEL) {
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
