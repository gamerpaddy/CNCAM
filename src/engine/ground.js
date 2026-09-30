// What an operation has cut so far, kept as the ground it left behind: regions
// of the XY plane, each with the depth it was taken down to.
//
// Every pass that comes down somewhere at rapid, or swings a lead through
// somewhere, is making a claim about how high the metal stands there. The
// claims the passes used to make were each true of the case they were written
// for and wrong beside it:
//
//   - "the level above cut this XY", decided by the pass above having run
//     within a cutter's radius of here — which is true of a cutter sticking a
//     whole radius out past that pass into metal nobody touched. A contour that
//     re-reads its outline every level rapided 5mm into the clamp part that way
//     and then took 9mm at once;
//   - "a finish pass is entered at depth", said of a pass whose whole job is
//     the allowance it takes off, standing the full height of the wall at the
//     point it came down — a rapid 22mm down the side of the boss;
//   - "a lead swings through ground the lead before it cut", when the lead
//     before it had been walked a level higher still.
//
// This keeps the record those claims need, so a pass can ask instead.

import {
  diffLoops, intersectLoops, offsetLoops, bufferOpenPaths, loopToOpenPath, loopsBounds,
} from '../geom/clipper.js';
import { stockOutline } from './stock.js';

/**
 * The widest a strip of metal may be and still count as none.
 *
 * A cutter that comes back to a wall it left touches it along a line, and the
 * two polygons that describe the visits disagree by their chord tolerance: a
 * strip a few thousandths wide that is not metal, it is two drawings of one
 * edge. Anything wider is metal to cut, and at rapid it is metal to hit.
 */
export const GRAZE = 0.05;

/**
 * The same, for a tool coming down at rapid: a fifth as much. A strip of metal
 * the edge of a feeding cutter touches is a finishing cut; the same strip met
 * at rapid is a knock the cutter takes sideways at its full traverse rate, and
 * all that may be excused there is the disagreement between two polygons that
 * describe one line — a few thousandths.
 */
export const RAPID_GRAZE = 0.01;

export class Ground {
  /**
   * @param stock the billet; outside its outline there is only air
   * @param topZ the top of the metal the operation starts from
   */
  constructor({ stock = null, topZ }) {
    this.topZ = topZ;
    this.outline = stock ? stockOutline(stock, 0) : null;
    this.records = [];   // { loops, z, box }, lowest z first
  }

  /** Everything inside `loops` has been cut down to `z`. */
  cut(loops, z) {
    if (!loops?.length) return;
    const record = { loops, z, box: loopsBounds(loops) };
    let i = this.records.length;
    while (i > 0 && this.records[i - 1].z > z) i--;
    this.records.splice(i, 0, record);
  }

  /** A cutter of `radius` has run along `path` (flat [x, y, …]) at `z`. */
  sweep(path, radius, z, closed = false) {
    this.cut(sweptBy(path, radius, closed), z);
  }

  /**
   * How high metal still stands anywhere inside `loops`: the depth of the
   * shallowest cut it takes to account for all of it, or the top of the metal
   * where some of it was never cut at all. -Infinity where there is none —
   * the whole of it is off the billet.
   *
   * @param graze the widest a strip may be and still not count as metal
   */
  topIn(loops, graze = GRAZE) {
    let rest = this.outline ? intersectLoops(loops, this.outline) : loops;
    if (thin(rest, graze)) return -Infinity;
    let box = loopsBounds(rest);
    for (const { loops: cut, z, box: b } of this.records) {
      if (!overlaps(box, b)) continue;
      rest = diffLoops(rest, cut);
      if (thin(rest, graze)) return z;
      box = loopsBounds(rest);
    }
    return this.topZ;
  }

  /**
   * The highest metal under a cutter of `radius` standing at (x, y) — the
   * question a rapid down to there asks, so judged to RAPID_GRAZE.
   */
  topUnder(x, y, radius) {
    return this.topIn([footprint(x, y, radius)], RAPID_GRAZE);
  }
}

/** The region a cutter of `radius` sweeps running along `path`. */
export function sweptBy(path, radius, closed = false) {
  if (!path || path.length < 2 || !(radius > 0)) return [];
  const open = closed ? loopToOpenPath(path) : path;
  // a path that never moves is the footprint of a cutter standing still
  if (open.length < 4) return [footprint(open[0], open[1], radius)];
  // chorded as finely as the footprint, so the two never disagree by more than
  // RAPID_GRAZE where they describe the same cutter
  return bufferOpenPaths([open], radius, 0.002);
}

/**
 * The disc a cutter of `radius` covers standing at (x, y), as a polygon whose
 * chords stay within a few thousandths of the circle — well inside GRAZE, so
 * the difference between it and a swept band of the same cutter is never
 * mistaken for metal.
 */
export function footprint(x, y, radius, chord = 0.002) {
  const n = Math.max(12, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - chord / radius))));
  const loop = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    loop[i * 2] = x + radius * Math.cos(a);
    loop[i * 2 + 1] = y + radius * Math.sin(a);
  }
  return loop;
}

/** Nowhere wider than `graze` — a line where two cuts meet, not metal. */
function thin(loops, graze) {
  return loops.length === 0 || offsetLoops(loops, -graze / 2, 0.001).length === 0;
}

function overlaps(a, b) {
  return a.min[0] <= b.max[0] && b.min[0] <= a.max[0]
    && a.min[1] <= b.max[1] && b.min[1] <= a.max[1];
}
