// A cutter with its axis tilted: how low does it reach above a point?
//
// Everything the 3-axis code knows about a cutter it knows as a *height by
// radius*: `profileTable` says how far above the tip the surface is at distance
// r from the axis. That is the whole tool when the axis is vertical — the lowest
// point of the solid above any (x, y) is the one at that radius — and it is why
// the sweep, the drop-cutter and the gouge checks are all a lookup.
//
// Tilt the axis and the lookup stops being one. The point above a cell is at
// some radius from the axis *and* some height along it, both changing as you go
// up the vertical line through the cell, and the lowest point of the tool on
// that line is a different place on the profile for every cell and every tilt.
//
// So it is solved, not tabulated. The tool is a solid of revolution whose
// boundary is the silhouette `tool-geometry.js` already describes — one
// description of the cutter, the same polyline the drawing, the reach check and
// the vertical sweep are all made from (see cncam-one-description-rule). A
// vertical line meets the surface of revolution of one straight segment of that
// polyline — a cone, a cylinder, a flat annulus — in the roots of a quadratic,
// and the lowest point of the solid above the line is the lowest root over all
// segments, because a line that enters a solid enters through its boundary.
//
// With the axis vertical every root collapses to the 3-axis lookup, which is
// the first test of it (five-tilt.test.js).
//
// ## Frames
//
// Tool frame: the tip is the origin, `s` runs up the axis, `ρ` is the distance
// from it. World offsets are from the tip: (ex, ey) is the horizontal offset of
// the vertical line, `z` the height above the tip, and the axis is the unit
// vector a = (ax, ay, az) pointing from the tip up the spindle, so along the
// line  s(z) = a·(ex, ey, z) = u + az·z  with  u = ax·ex + ay·ey,  and
// ρ²(z) = ex² + ey² + z² − s².

import { toolSections } from '../tool-geometry.js';

const EPS = 1e-9;
const ARC_SEGMENTS = 32;

/**
 * One shell: the segments of a stretch of the tool's silhouette, with what the
 * solver needs worked out once.
 */
function buildShell(segments, kinds = null) {
  const n = segments.length;
  const shell = {
    n,
    form: new Uint8Array(n),       // 0 s = c + m·ρ · 1 wall ρ = r · 2 flat annulus · 3 ρ = d + k·s
    p: new Float64Array(n),        // m, r, s or k, by form
    q: new Float64Array(n),        // c, —, —, d
    rlo: new Float64Array(n), rhi: new Float64Array(n),
    slo: new Float64Array(n), shi: new Float64Array(n),
    kind: kinds ?? new Array(n).fill('tool'),
    verts: [],                     // every [ρ, s] vertex, for bounding boxes
  };
  segments.forEach(([[r0, s0], [r1, s1]], i) => {
    shell.rlo[i] = Math.min(r0, r1); shell.rhi[i] = Math.max(r0, r1);
    shell.slo[i] = Math.min(s0, s1); shell.shi[i] = Math.max(s0, s1);
    shell.verts.push([r0, s0], [r1, s1]);
    const dr = r1 - r0;
    const ds = s1 - s0;
    if (Math.abs(dr) < EPS) {                 // a cylinder wall
      shell.form[i] = 1; shell.p[i] = r0;
    } else if (Math.abs(ds) < EPS) {          // a flat annulus
      shell.form[i] = 2; shell.p[i] = s0;
    } else if (Math.abs(ds / dr) <= 1) {      // shallow: s as a function of ρ
      const m = ds / dr;
      shell.form[i] = 0; shell.p[i] = m; shell.q[i] = s0 - m * r0;
    } else {                                  // steep: ρ as a function of s
      const k = dr / ds;
      shell.form[i] = 3; shell.p[i] = k; shell.q[i] = r0 - k * s0;
    }
  });
  return shell;
}

/**
 * The cutter as two shells: what cuts (the flutes) and what only has to clear
 * (the shank and the holder). Built once per tool.
 *
 * The flutes remove metal; the rest of the assembly does not, and meeting metal
 * is a collision. They are kept apart because the answers are different: the
 * sweep lowers the stock to the first, and the crash check asks whether the
 * second is inside what is left.
 */
export function toolShells(tool) {
  const cutting = [];
  const body = [];
  const bodyKinds = [];
  // thirty-two chords to a quarter circle: a facet off the true arc by under a
  // thousandth of the radius, which the stamped sweep is never asked to beat
  for (const { kind, points } of toolSections(tool, { arcSegments: ARC_SEGMENTS })) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) continue;
      if (kind === 'cutting') cutting.push([a, b]);
      else { body.push([a, b]); bodyKinds.push(kind); }
    }
  }
  return {
    cutting: buildShell(cutting),
    body: buildShell(body, bodyKinds),
    radius: Math.max(0, ...cutting.map(([a, b]) => Math.max(a[0], b[0]))),
  };
}

/** Which segment gave the last answer — for naming the shank or the holder. */
export const last = { index: -1 };

/** Roots of A·z² + B·z + C = 0, calling `visit` with each. */
function roots(A, B, C, visit) {
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) > 1e-12) visit(-C / B);
    return;
  }
  const disc = B * B - 4 * A * C;
  if (disc < 0) return;
  const sq = Math.sqrt(disc);
  // the stable form: no cancellation between −B and the root
  const q = -0.5 * (B + (B >= 0 ? sq : -sq));
  if (Math.abs(q) < 1e-300) { visit(0); return; }
  visit(q / A);
  if (Math.abs(A) > 1e-300 && Math.abs(q) > 0) visit(C / q);
}

/**
 * The lowest height, above the tip, that the shell reaches over the vertical
 * line at horizontal offset (ex, ey) when its axis points along (ax, ay, az) —
 * or Infinity where it does not reach that line at all.
 */
export function lowestAbove(shell, ax, ay, az, ex, ey) {
  const u = ax * ex + ay * ey;
  const e2 = ex * ex + ey * ey;
  let best = Infinity;
  let at = -1;
  for (let i = 0; i < shell.n; i++) {
    const rlo = shell.rlo[i] - 1e-7;
    const rhi = shell.rhi[i] + 1e-7;
    const form = shell.form[i];
    if (form === 2) {                                    // s = const
      if (Math.abs(az) < EPS) continue;
      const s = shell.p[i];
      const z = (s - u) / az;
      const rho2 = e2 + z * z - s * s;
      if (z < best && rho2 >= rlo * rlo - 1e-9 && rho2 <= rhi * rhi + 1e-9) { best = z; at = i; }
    } else if (form === 1) {                             // ρ = const
      const r = shell.p[i];
      const slo = shell.slo[i] - 1e-7;
      const shi = shell.shi[i] + 1e-7;
      roots(1 - az * az, -2 * u * az, e2 - u * u - r * r, (z) => {
        const s = u + az * z;
        if (z < best && s >= slo && s <= shi) { best = z; at = i; }
      });
    } else if (form === 0) {                             // s = c + m·ρ
      const m = shell.p[i];
      const c = shell.q[i];
      const k1 = 1 + m * m;
      roots(k1 * az * az - m * m, 2 * k1 * u * az - 2 * c * az,
        k1 * u * u - 2 * c * u + c * c - m * m * e2, (z) => {
          const rho = (u + az * z - c) / m;
          if (z < best && rho >= rlo && rho <= rhi) { best = z; at = i; }
        });
    } else {                                             // ρ = d + k·s
      const k = shell.p[i];
      const d = shell.q[i];
      const k1 = 1 + k * k;
      roots(1 - k1 * az * az, -2 * k1 * u * az - 2 * d * k * az,
        -k1 * u * u - 2 * d * k * u + e2 - d * d, (z) => {
          const rho = d + k * (u + az * z);
          if (z < best && rho >= rlo && rho <= rhi) { best = z; at = i; }
        });
    }
  }
  last.index = at;
  return best;
}

/**
 * Where a shell sits over the grid with the tip at the origin: the bounding box
 * of its footprint, and the lowest height it reaches anywhere.
 *
 * Each ring of the silhouette is a circle in the plane square to the axis, and
 * a circle tilted by θ reaches r·sinθ below its own centre. So the lowest point
 * of a tilted cutter is not the tip, which is the trap here: a ball nose leaned
 * over bottoms out on its flank, off to one side, and any shortcut that says
 * nothing can be this low by testing the tip's height is wrong for it.
 *
 * `maxZ` is a ceiling above the tip: the stock only stands so high, and the part
 * of the cutter above that cannot touch it, however wide it is up there.
 */
export function shellBox(shell, ax, ay, az, maxZ = Infinity) {
  const tilt = Math.hypot(ax, ay);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, floor = Infinity;
  const v = shell.verts;
  // Two vertices a segment. With a ceiling, a segment that never gets down to it
  // is left out — nothing that high can matter — and one that does is counted
  // whole, which over-bounds it and so is safe.
  for (let i = 0; i < v.length; i += 2) {
    const lowA = v[i][1] * az - v[i][0] * tilt;
    const lowB = v[i + 1][1] * az - v[i + 1][0] * tilt;
    if (Math.min(lowA, lowB) > maxZ) continue;
    for (let k = i; k < i + 2; k++) {
      const [r, s] = v[k];
      const cx = s * ax;
      const cy = s * ay;
      if (cx - r < x0) x0 = cx - r;
      if (cx + r > x1) x1 = cx + r;
      if (cy - r < y0) y0 = cy - r;
      if (cy + r > y1) y1 = cy + r;
      const low = s * az - r * tilt;
      if (low < floor) floor = low;
    }
  }
  if (floor === Infinity) return { x0: 0, x1: 0, y0: 0, y1: 0, floor: Infinity };
  return { x0, x1, y0, y1, floor };
}

/** [dj, start, end, minClearance, di0, di1] per row — heightmap.js ROW_STRIDE. */
const ROW_STRIDE = 6;

/**
 * The drop-cutter's kernel for a tilted cutter: the same object
 * `buildToolKernel` makes for a vertical one, so `dropCutter` runs on it
 * unchanged.
 *
 * A kernel is the cutter's clearance at every grid offset under it — how far
 * above the tip its surface is over that cell — and `dropCutter` lowers the tip
 * until no cell of the map is above `height − clearance`. For a vertical tool
 * the clearance is a lookup by radius; here it is `lowestAbove`, solved at each
 * offset. A vertical axis hands back the very kernel the 3-axis code builds (the
 * caller delegates), which is what makes "a 5-axis pass with no tilt is the
 * parallel finish" an identity rather than a tolerance.
 *
 * `rise` caps how far above the tip a cell is worth considering: a flute 20mm
 * long tilted 30° reaches 10mm sideways at its top, and every cell out there
 * is a row for the drop-cutter to read — on a surface that never gets within
 * `rise` of the tool there is nothing for them to find. The caller sets it from
 * the part's own relief.
 *
 * @param box the footprint's bounding box (`shellBox`), tip at the origin
 * @param heightAt (di, dj) → the clearance at that grid offset, Infinity if none
 * @returns the kernel `dropCutter` reads, plus `extent` in mm
 */
function kernelFrom(box, cellSize, rise, heightAt) {
  const i0 = Math.floor(box.x0 / cellSize) - 1;
  const i1 = Math.ceil(box.x1 / cellSize) + 1;
  const j0 = Math.floor(box.y0 / cellSize) - 1;
  const j1 = Math.ceil(box.y1 / cellSize) + 1;

  const rows = [];
  const offsets = [];
  const found = new Float64Array(i1 - i0 + 1);
  for (let dj = j0; dj <= j1; dj++) {
    // the run of columns this row actually reaches, found end to end so the row
    // is one contiguous stretch — which is all `dropCutter` can walk
    let first = null;
    let lastCol = null;
    for (let di = i0; di <= i1; di++) {
      const z = heightAt(di, dj);
      found[di - i0] = z;
      if (z < Infinity && z <= rise) {
        if (first === null) first = di;
        lastCol = di;
      }
    }
    if (first === null) continue;
    const start = offsets.length / 3;
    let minC = Infinity;
    for (let di = first; di <= lastCol; di++) {
      // a hole in the middle of a row is a cell the cutter does not cover:
      // an infinite clearance means it can never be the cell that holds the tip up
      const c = Math.fround(found[di - i0]);
      if (c < minC) minC = c;
      offsets.push(di, dj, c);
    }
    const end = offsets.length / 3;
    rows.push({ dj, start, end, minC, di0: first, di1: lastCol });
  }
  // the lowest-reaching rows first: they are where the tip is held highest, and
  // the sooner a high tip is found the more of the rest `dropCutter` can skip
  rows.sort((p, q) => p.minC - q.minC);
  const packedRows = [];
  for (const r of rows) packedRows.push(r.dj, r.start, r.end, r.minC, r.di0, r.di1);
  const packed = new Float32Array(offsets);
  const clearance = new Float32Array(packed.length / 3);
  for (let n = 0; n < clearance.length; n++) clearance[n] = packed[n * 3 + 2];
  const extent = Math.max(Math.abs(box.x0), Math.abs(box.x1), Math.abs(box.y0), Math.abs(box.y1));
  return {
    offsets: packed,
    clearance,
    count: clearance.length,
    radius: extent,
    extent,
    rows: new Float64Array(packedRows),
    rowCount: packedRows.length / ROW_STRIDE,
  };
}

/** The kernel for one axis, every offset solved exactly. */
export function buildTiltedKernel(shell, axis, cellSize, rise = Infinity) {
  const [ax, ay, az] = axis;
  return kernelFrom(shellBox(shell, ax, ay, az), cellSize, rise,
    (di, dj) => lowestAbove(shell, ax, ay, az, di * cellSize, dj * cellSize));
}

/**
 * The cutter's height at any offset, for any way it can lean, made cheaply.
 *
 * A cutter is a solid of revolution, so tilting it by θ and then turning the
 * lean to point at azimuth φ is the θ-tilted cutter seen from a turned frame:
 * `H(θ, φ)(e) = H(θ, 0)(R(−φ)·e)`. The expensive part — solving the height at
 * every offset — is therefore done once per tilt, on a grid, and the height for
 * any azimuth is that grid read back through a rotation. The simulation asks
 * for it millions of times and the planner for a few thousand different leans,
 * and solving each from scratch was most of the time either took; this is a
 * bilinear lookup per cell instead.
 *
 * Where a lookup would straddle the edge of the footprint — where the height
 * goes from a number to nothing, and an average of the two is no height at all —
 * the cell is solved exactly instead, and where all four neighbours are empty
 * the answer is empty without any arithmetic.
 *
 * @param rise the highest above the tip anything is asked about: the tool above
 *   that is left out of the grid, which is what keeps a long flute or a holder
 *   from making a table the size of the room
 */
export function leaningSampler(shell, cellSize, rise = Infinity) {
  const tables = new Map();

  const tableFor = (tiltDeg) => {
    let hit = tables.get(tiltDeg);
    if (hit) return hit;
    const t = (tiltDeg * Math.PI) / 180;
    const ax = Math.sin(t);
    const az = Math.cos(t);
    const box = shellBox(shell, ax, 0, az, rise);
    if (box.floor === Infinity) {
      hit = { h: new Float32Array(1).fill(Infinity), reach: 0, size: 1, empty: true };
    } else {
      // a turned footprint can point anywhere, so the grid covers the circle the
      // footprint sweeps — plus a cell each side for the bilinear reads
      const reach = Math.ceil(Math.max(
        Math.abs(box.x0), Math.abs(box.x1), Math.abs(box.y0), Math.abs(box.y1),
      ) / cellSize) + 2;
      const size = reach * 2 + 1;
      const h = new Float32Array(size * size);
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          h[j * size + i] = lowestAbove(shell, ax, 0, az, (i - reach) * cellSize, (j - reach) * cellSize);
        }
      }
      hit = { h, reach, size, empty: false };
    }
    tables.set(tiltDeg, hit);
    return hit;
  };

  return {
    tableFor,
    /**
     * A function (ex, ey) → height above the tip, for the cutter tilted
     * `tiltDeg` (a whole number: the grid is per degree) and leaning toward
     * `azRad`. `axis` is the true axis, for the cells solved exactly.
     */
    heightFn(tiltDeg, azRad, axis) {
      const table = tableFor(tiltDeg);
      if (table.empty) return () => Infinity;
      const cp = Math.cos(azRad);
      const sp = Math.sin(azRad);
      const { h, reach, size } = table;
      const last = size - 1;
      const [ax, ay, az] = axis;
      return (ex, ey) => {
        // into the frame the table was solved in: turned back by φ
        const fx = (ex * cp + ey * sp) / cellSize + reach;
        const fy = (-ex * sp + ey * cp) / cellSize + reach;
        if (fx < 0 || fy < 0 || fx >= last || fy >= last) return Infinity;
        const i = Math.floor(fx);
        const j = Math.floor(fy);
        const u = fx - i;
        const v = fy - j;
        const k = j * size + i;
        const h00 = h[k];
        const h10 = h[k + 1];
        const h01 = h[k + size];
        const h11 = h[k + size + 1];
        const empty = (h00 === Infinity) + (h10 === Infinity) + (h01 === Infinity) + (h11 === Infinity);
        if (empty === 4) return Infinity;
        if (empty > 0) return lowestAbove(shell, ax, ay, az, ex, ey);
        return h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;
      };
    },
  };
}

/** Kernels for every way a cutter can lean — the sampler's heights, laid out for `dropCutter`. */
export function leaningKernels(shell, cellSize, rise = Infinity) {
  const sampler = leaningSampler(shell, cellSize, rise);
  return {
    /** The kernel for a cutter tilted `tiltDeg` from vertical, leaning toward `azDeg`. */
    kernel(tiltDeg, azDeg) {
      const t = (tiltDeg * Math.PI) / 180;
      const phi = (azDeg * Math.PI) / 180;
      const axis = [Math.sin(t) * Math.cos(phi), Math.sin(t) * Math.sin(phi), Math.cos(t)];
      const height = sampler.heightFn(tiltDeg, phi, axis);
      return kernelFrom(shellBox(shell, axis[0], axis[1], axis[2], rise), cellSize, rise,
        (di, dj) => height(di * cellSize, dj * cellSize));
    },
  };
}
