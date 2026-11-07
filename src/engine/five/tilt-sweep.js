// Sweeping a tilted cutter through the stock.
//
// The 3-axis sweep (simulate.js `cut`) is analytic: for a vertical cutter the
// moment a cell enters and leaves the cut is the root of a quadratic in the
// travel, so a whole move is one pass over the cells. A tilted cutter has no
// such closed form — the lowest point above a cell is itself the root of a
// quadratic in height (tilt-kernel.js), and putting a second one inside the
// first is not something worth solving.
//
// So a tilted move is *stamped*: the cutter is set down at intervals along the
// path, each stamp lowers every cell its lowest surface reaches, and the stock
// ends at the lowest of them. What that leaves between stamps is a scallop, and
// its height is the whole error: a ball of radius R stamped every s leaves one
// s²/8R high, so the spacing is chosen from the height the simulation is
// willing to be wrong by and not from a count of how many stamps feels like
// enough. The tilt is stamped the same way — a reorienting rapid swings the
// cutter about its tip, a degree or two at a time.
//
// Only a program that actually tilts the tool ever comes here. A move whose two
// ends are both vertical goes through `cut`, unchanged, so every 3-axis
// simulation is byte-for-byte what it was (src/test/sim-golden.test.js).

import { lowestAbove, shellBox, last, leaningSampler } from './tilt-kernel.js';
import { settleThrough } from '../workpiece.js';

const MIN_CHANGE = 0.001;

/** Swing the cutter no more than this between stamps, in degrees. */
const ANGLE_STEP = 2;

/** Never space stamps closer than a quarter of a cell: finer shows nothing. */
const MIN_SPACING = 0.25;

/** The tallest scallop a stamped sweep may leave, in mm, for a given cell. */
export function scallopBudget(cellSize) {
  return Math.max(0.005, cellSize * 0.08);
}

/**
 * How far apart to stamp: the spacing at which a cutter of this radius leaves a
 * scallop no taller than the budget, clamped to something a cell can show.
 */
export function stampSpacing(radius, cellSize) {
  const spacing = Math.sqrt(8 * Math.max(radius, 1e-3) * scallopBudget(cellSize));
  return Math.max(cellSize * MIN_SPACING, Math.min(spacing, Math.max(radius, cellSize)));
}

/**
 * The cutter's shells with lookup tables for them, for a grid of this cell size.
 * `rise` is how far above the tip anything is asked about — the height of the
 * stock — so a long flute or a holder above it costs nothing.
 */
export function prepareSweep(shells, cellSize, rise) {
  return {
    ...shells,
    cuttingSampler: leaningSampler(shells.cutting, cellSize, rise),
    bodySampler: leaningSampler(shells.body, cellSize, rise),
  };
}

/** (ex, ey) → height above the tip, for this shell leaning along `axis`. */
function heightOf(shell, sampler, axis) {
  if (!sampler) return (ex, ey) => lowestAbove(shell, axis[0], axis[1], axis[2], ex, ey);
  const tilt = Math.round(Math.acos(Math.min(1, Math.max(-1, axis[2]))) * DEG);
  return sampler.heightFn(tilt, Math.atan2(axis[1], axis[0]), axis);
}

const DEG = 180 / Math.PI;

/** The angle between two unit axes, in degrees. */
export function angleBetween(a, b) {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(dot) * 180 / Math.PI;
}

/** Normalised linear interpolation of two unit axes. */
export function blendAxis(a, b, t) {
  const x = a[0] + (b[0] - a[0]) * t;
  const y = a[1] + (b[1] - a[1]) * t;
  const z = a[2] + (b[2] - a[2]) * t;
  const n = Math.hypot(x, y, z) || 1;
  return [x / n, y / n, z / n];
}

/** How many stamps a move from pose a to pose b needs. */
export function stampsFor(a, axisA, b, axisB, spacing) {
  const travel = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const swing = angleBetween(axisA, axisB);
  return Math.max(1, Math.ceil(travel / spacing), Math.ceil(swing / ANGLE_STEP));
}

/**
 * Lower the stock under one stamp of the cutter.
 * @returns the deepest cut it made, and how many distinct cells it lowered
 */
function stamp(world, log, step, tip, axis, shells, stockTop, marks) {
  const shell = shells.cutting;
  const reach = heightOf(shell, shells.cuttingSampler, axis);
  const { heights, mask, grid, columns } = world;
  const { width, height, cellSize, origin } = grid;
  const [ax, ay, az] = axis;
  // only the part of the cutter below the top of the stock can touch it
  const box = shellBox(shell, ax, ay, az, stockTop - tip[2]);
  const floor = tip[2] + box.floor;
  if (floor >= stockTop) return null;

  const i0 = clampIndex(Math.floor((tip[0] + box.x0 - origin[0]) / cellSize), width);
  const i1 = clampIndex(Math.ceil((tip[0] + box.x1 - origin[0]) / cellSize), width);
  const j0 = clampIndex(Math.floor((tip[1] + box.y0 - origin[1]) / cellSize), height);
  const j1 = clampIndex(Math.ceil((tip[1] + box.y1 - origin[1]) / cellSize), height);
  let deepest = 0;
  let cells = 0;
  let volume = 0;
  let rhoWeighted = 0;
  const cellArea = cellSize * cellSize;
  for (let j = j0; j <= j1; j++) {
    const ey = origin[1] + j * cellSize - tip[1];
    const row = j * width;
    for (let i = i0; i <= i1; i++) {
      const cell = row + i;
      const before = heights[cell];
      if (before <= floor || mask[cell] === 0) continue;
      const ex = origin[0] + i * cellSize - tip[0];
      const z = reach(ex, ey);
      if (z === Infinity) continue;
      const lowest = tip[2] + z;
      if (lowest >= before - MIN_CHANGE) continue;
      const settled = columns ? settleThrough(columns, cell, lowest) : lowest;
      const took = (before - lowest) * cellArea;
      volume += took;
      // How far from the cutter's axis this cell is touched: the radius of the
      // cutting edge that takes it, and so how fast that edge is going. Zero is
      // the dead centre of a ball, which cuts at no speed at all. Averaged over
      // the metal taken, because that is what the edge speed is the speed *of*.
      const s = ax * ex + ay * ey + az * z;
      rhoWeighted += took * Math.sqrt(Math.max(0, ex * ex + ey * ey + z * z - s * s));
      if (before - lowest > deepest) deepest = before - lowest;
      if (marks.cells[cell] !== marks.epoch) { marks.cells[cell] = marks.epoch; cells++; }
      log.push(step, cell, settled, before);
      heights[cell] = settled;
    }
  }
  return { deepest, cells, volume, rhoWeighted };
}

/**
 * Sweep a tilted cutter from pose a to pose b, and say what it took.
 *
 * @param world { heights, mask, grid, columns, marks } — `marks` is
 *   `{ cells: Uint32Array, epoch }`, scratch for counting distinct cells
 * @param shells from `toolShells`
 * @returns { swath, depth, volume, rho } — `swath` and `depth` are the two numbers
 *   `cut` reports, so the load log does not have to know which sweep made them:
 *   `swath` is the area of the distinct cells this move lowered. `volume` is the
 *   metal it took off, in mm³, and `rho` how far from the axis that metal was
 *   taken, on average — the radius of the cutting edge that was doing the work.
 */
export function cutTilted(world, log, step, a, axisA, b, axisB, shells, stockTop, spacing) {
  // The shell reaches below the tip by at most its widest ring, so a move that
  // stays that far above the stock cannot touch it.
  if (Math.min(a[2], b[2]) - shells.radius >= stockTop) return { swath: 0, depth: 0 };

  const marks = world.marks;
  marks.epoch++;
  const n = stampsFor(a, axisA, b, axisB, spacing);
  let depth = 0;
  let cells = 0;
  let volume = 0;
  let rhoWeighted = 0;
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const tip = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const took = stamp(world, log, step, tip, blendAxis(axisA, axisB, t), shells, stockTop, marks);
    if (!took) continue;
    if (took.deepest > depth) depth = took.deepest;
    cells += took.cells;
    volume += took.volume;
    rhoWeighted += took.rhoWeighted;
  }
  const cellArea = world.grid.cellSize * world.grid.cellSize;
  return { swath: cells * cellArea, depth, volume, rho: volume > 0 ? rhoWeighted / volume : 0 };
}

/**
 * Is the shank or the holder in the metal with the tool at this pose, and how
 * far? The tilted counterpart of simulate.js `bodyTouch`: the lowest point the
 * body reaches above each cell, against the height the stock stands at there.
 * What the flutes reach has already been cut, so a cell under them is down at
 * their level and cannot be in the body's way.
 */
export function bodyTouchTilted(world, tip, axis, shells, stockTop, eps) {
  const body = shells.body;
  if (body.n === 0) return null;
  const { heights, mask, grid } = world;
  const { width, height, cellSize, origin } = grid;
  const [ax, ay, az] = axis;
  const box = shellBox(body, ax, ay, az, stockTop - tip[2]);
  if (tip[2] + box.floor >= stockTop - eps) return null;
  const i0 = clampIndex(Math.floor((tip[0] + box.x0 - origin[0]) / cellSize), width);
  const i1 = clampIndex(Math.ceil((tip[0] + box.x1 - origin[0]) / cellSize), width);
  const j0 = clampIndex(Math.floor((tip[1] + box.y0 - origin[1]) / cellSize), height);
  const j1 = clampIndex(Math.ceil((tip[1] + box.y1 - origin[1]) / cellSize), height);
  const reach = heightOf(body, shells.bodySampler, axis);
  let worst = 0;
  let kind = null;
  let where = null;
  for (let j = j0; j <= j1; j++) {
    const ey = origin[1] + j * cellSize - tip[1];
    const row = j * width;
    for (let i = i0; i <= i1; i++) {
      const cell = row + i;
      if (mask[cell] === 0) continue;
      const stands = heights[cell];
      if (stands <= tip[2] + box.floor + worst) continue;
      const z = reach(origin[0] + i * cellSize - tip[0], ey);
      if (z === Infinity) continue;
      const over = stands - (tip[2] + z);
      if (over > worst) {
        worst = over;
        kind = body.kind[last.index] ?? 'holder';
        where = [origin[0] + i * cellSize, origin[1] + j * cellSize, stands];
      }
    }
  }
  return worst > eps ? { depth: worst, kind, at: where } : null;
}

function clampIndex(v, n) { return v < 0 ? 0 : v > n - 1 ? n - 1 : v; }
