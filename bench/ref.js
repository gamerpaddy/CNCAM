// An independent, deliberately slow reference for the swept envelope.
//
// Same model as engine/simulate.js — a height grid, a tool described by its
// clearance profile — but every move is minimised over t by brute force instead
// of by three sample points. Whatever this says the floor is, is what the real
// simulator should say too.

import { MOVE_STRIDE, OP } from '../src/engine/cl.js';
import { clearanceProfile, cuttingRadiusOf } from '../src/engine/tool-geometry.js';

const SAMPLES = 4000;

/**
 * How far either side of the given cutter the second opinion is taken.
 *
 * A cell sitting exactly one cutter radius from the path is *tangent* to the
 * sweep: a contact of zero width, which floating point resolves either way from
 * one cell to the next. Axis-aligned toolpaths on an axis-aligned grid produce
 * these by the hundred, and they say nothing about whether the simulation is
 * any good.
 *
 * So the reference answers twice, with a cutter a micron under and a micron
 * over, and the bench scores only the cells the two agree about. Both sides,
 * because a tangency is missed by the reference as often as it is taken: with
 * only the undersized answer to compare against, a cell the reference dropped
 * and the simulator kept still looked like a 1.6mm disagreement.
 */
const GRAZE = 1e-6;

export function referenceSurface(args) {
  return {
    heights: run(args, GRAZE),
    grazed: run(args, -GRAZE),
  };
}

function run({ stock, ops, width, height, cellSize, origin, mask }, shrink) {
  const count = width * height;
  const heights = new Float32Array(count).fill(stock.max[2]);
  const grid = { width, height, cellSize, origin };

  for (const { cl, tool } of ops) {
    const profile = clearanceProfile(tool);
    const radius = cuttingRadiusOf(tool) - shrink;
    const d = cl.moves;
    let prev = null;
    for (let n = 0; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      let a; let b;
      if (d[o] === OP.DRILL) {
        a = [d[o + 1], d[o + 2], d[o + 4]];
        b = [d[o + 1], d[o + 2], d[o + 3]];
        prev = a;
      } else {
        const p = [d[o + 1], d[o + 2], d[o + 3]];
        if (!prev) { prev = p; continue; }
        a = prev; b = p;
        prev = p;
      }
      sweep(heights, mask, a, b, radius, profile, grid);
    }
  }
  return heights;
}

function sweep(heights, mask, p0, p1, radius, profile, grid) {
  const { width, height, cellSize, origin } = grid;
  const lowestZ = Math.min(p0[2], p1[2]);
  const ox = origin[0]; const oy = origin[1];
  const i0 = clamp(Math.floor((Math.min(p0[0], p1[0]) - radius - ox) / cellSize), width);
  const i1 = clamp(Math.ceil((Math.max(p0[0], p1[0]) + radius - ox) / cellSize), width);
  const j0 = clamp(Math.floor((Math.min(p0[1], p1[1]) - radius - oy) / cellSize), height);
  const j1 = clamp(Math.ceil((Math.max(p0[1], p1[1]) + radius - oy) / cellSize), height);
  const floor = lowestZ + profile(0);
  const r2 = radius * radius;
  const dx = p1[0] - p0[0]; const dy = p1[1] - p0[1]; const dz = p1[2] - p0[2];

  for (let j = j0; j <= j1; j++) {
    const cy = oy + j * cellSize;
    for (let i = i0; i <= i1; i++) {
      const cell = j * width + i;
      if (mask[cell] === 0) continue;
      const before = heights[cell];
      if (before <= floor) continue;
      const cx = ox + i * cellSize;
      // The window of t over which the cell is under the cutter, solved rather
      // than searched: |p(t) − c| = r is a quadratic, and sampling t uniformly
      // over the whole move misses a cell that is tangent to the sweep — which
      // reads as the simulator inventing material it did not remove.
      const ex = p0[0] - cx; const ey = p0[1] - cy;
      const A = dx * dx + dy * dy;
      const B = ex * dx + ey * dy;
      const C = ex * ex + ey * ey - r2;
      let ta = 0; let tb = 1;
      if (A > 1e-15) {
        const disc = B * B - A * C;
        // A path that runs exactly one cutter radius from a grid line is
        // tangent to the sweep, and in floating point the discriminant of an
        // exact tangency comes out either side of zero. Axis-aligned toolpaths
        // on an axis-aligned grid do this constantly, so a strict test reports
        // the whole length of a pass as a disagreement about a contact of zero
        // width. Anything within rounding of tangent counts as touching.
        if (disc < -1e-9 * (B * B + A * Math.abs(C) + 1)) continue;
        const root = Math.sqrt(Math.max(0, disc));
        ta = Math.max(0, (-B - root) / A);
        tb = Math.min(1, (-B + root) / A);
        if (ta > tb) continue;
      } else if (C > 0) continue;
      let lowest = Infinity;
      for (let s = 0; s <= SAMPLES; s++) {
        const t = ta + (tb - ta) * (s / SAMPLES);
        const ax = p0[0] + dx * t - cx;
        const ay = p0[1] + dy * t - cy;
        const dist2 = ax * ax + ay * ay;
        const z = p0[2] + dz * t + profile(dist2 > 0 ? Math.sqrt(dist2) : 0);
        if (z < lowest) lowest = z;
      }
      if (lowest < before) heights[cell] = lowest;
    }
  }
}

function clamp(v, n) { return v < 0 ? 0 : v > n - 1 ? n - 1 : v; }
