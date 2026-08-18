// Top-surface heightmap and drop-cutter.
//
// 3D finishing asks one question over and over: with the tool centred at (x,y),
// how far down can it go before it touches the part? Answering that against raw
// triangles is expensive and fiddly, so the mesh is rasterised once into a grid
// of top-surface heights and every later query is a max-filter over the disc
// the tool covers.
//
// The filter uses a per-tool clearance profile c(d): the height the tool's
// surface sits above its tip at radial distance d. Flat cutters are 0
// everywhere, a ball nose is the sphere, a bull nose is flat then rounded.
//
// A surface point at height h and distance d must not be above the tool's
// surface there, i.e. tip + c(d) >= h, so the lowest legal tip is
// max over the disc of (h - c(d)). Note the minus: a ball nose curves *up* away
// from its tip, which is exactly what lets it drop below a flat cutter as it
// comes off an edge.

import { clearanceProfile, cuttingRadiusOf } from '../engine/tool-geometry.js';

const MAX_CELLS = 4_000_000;

/**
 * Rasterise the mesh's upward-facing surface into a height grid.
 * Cells with no geometry hold `floor`.
 *
 * @param mesh { positions, indices }
 * @param options { cellSize, bounds, floor }
 */
export function buildHeightmap(mesh, {
  cellSize = 0.25, bounds, floor = -Infinity, dilate = true,
} = {}) {
  const b = bounds ?? meshBounds(mesh.positions);
  const width = Math.max(1, Math.ceil((b.max[0] - b.min[0]) / cellSize) + 1);
  const height = Math.max(1, Math.ceil((b.max[1] - b.min[1]) / cellSize) + 1);

  if (width * height > MAX_CELLS) {
    const scale = Math.sqrt((width * height) / MAX_CELLS);
    return buildHeightmap(mesh, { cellSize: cellSize * scale, bounds: b, floor, dilate });
  }

  const data = new Float32Array(width * height).fill(floor);
  const { positions, indices } = mesh;

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, bi = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[bi], by = positions[bi + 1], bz = positions[bi + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];

    // signed area in XY; zero means the triangle is vertical and contributes
    // no top surface (its edges are covered by the faces that meet it)
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;

    const i0 = clamp(Math.floor((Math.min(ax, bx, cx) - b.min[0]) / cellSize), 0, width - 1);
    const i1 = clamp(Math.ceil((Math.max(ax, bx, cx) - b.min[0]) / cellSize), 0, width - 1);
    const j0 = clamp(Math.floor((Math.min(ay, by, cy) - b.min[1]) / cellSize), 0, height - 1);
    const j1 = clamp(Math.ceil((Math.max(ay, by, cy) - b.min[1]) / cellSize), 0, height - 1);

    for (let j = j0; j <= j1; j++) {
      const py = b.min[1] + j * cellSize;
      for (let i = i0; i <= i1; i++) {
        const px = b.min[0] + i * cellSize;
        // barycentric test in XY
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
        const z = w0 * az + w1 * bz + w2 * cz;
        const k = j * width + i;
        if (z > data[k]) data[k] = z;
      }
    }
  }

  const out = dilate ? dilateMax(data, width, height, floor) : data;
  const map = {
    data: out, width, height, cellSize, min: [b.min[0], b.min[1]], bounds: b, floor,
  };
  if (width * height >= WINDOW_WORTH_IT) {
    map.window = { half: WINDOW_HALF, data: rowWindowMax(out, width, height, WINDOW_HALF) };
  }
  return map;
}

/**
 * A per-cell maximum over a fixed horizontal window, so `dropCutter` can rule a
 * whole row of the tool out with one read.
 *
 * The cost of finishing is one max-filter over the cutter disc per sampled
 * point, and on a fine pass the disc is a couple of thousand cells: a ⌀3 ball
 * at a 0.08 stepover builds a 0.06mm grid, which puts about 1,960 cells under
 * the tool and asks for it about 440,000 times. Nearly all of that work is
 * spent confirming that ground the tool is already well clear of is, indeed,
 * clear.
 *
 * So each row of the disc is bounded before it is walked: the highest cell
 * anywhere in the row, less the *lowest* the tool's surface gets over that row,
 * cannot beat the best tip height found so far, then nothing in the row can and
 * the row is skipped. This array is what makes that bound one lookup instead of
 * a scan.
 *
 * Van Herk's algorithm: forward running maxima within blocks of the window
 * width and backward ones across the same blocks, so the window at any offset
 * is the larger of two reads — O(n) whatever the window size.
 */
const WINDOW_HALF = 8;
const WINDOW_WORTH_IT = 200_000;   // below this the scan is already cheap

function rowWindowMax(data, width, height, half) {
  const k = half * 2 + 1;
  const out = new Float32Array(data.length);
  const pre = new Float32Array(width);
  const suf = new Float32Array(width);
  for (let j = 0; j < height; j++) {
    const row = j * width;
    for (let i = 0; i < width; i++) {
      pre[i] = i % k === 0 ? data[row + i] : Math.max(pre[i - 1], data[row + i]);
    }
    for (let i = width - 1; i >= 0; i--) {
      suf[i] = (i % k === k - 1 || i === width - 1)
        ? data[row + i] : Math.max(suf[i + 1], data[row + i]);
    }
    for (let i = 0; i < width; i++) {
      // Clamped indices, not substituted reads: the two blocks the window
      // straddles have to stay adjacent, or the pair stops covering the middle
      // of it — and a max-filter that misses a cell is a cutter that dives
      // through the thing that cell was.
      const lo = i - half < 0 ? 0 : i - half;
      const hi = i + half > width - 1 ? width - 1 : i + half;
      const a = suf[lo];
      const b = pre[hi];
      out[row + i] = a > b ? a : b;
    }
  }
  return out;
}

/**
 * 3x3 max filter, run separably.
 *
 * Cells are sampled at their centres, so a triangle that covers part of a cell
 * without covering its centre contributes nothing and the surface comes out too
 * low right where it matters — the sharp convex edges a finishing pass rolls
 * over. Growing every height by one cell makes the map conservative: it may
 * claim material half a cell too far out, which leaves a whisker of stock, but
 * it can never invite the cutter into the part.
 */
function dilateMax(data, width, height, floor) {
  const tmp = new Float32Array(data.length);
  for (let j = 0; j < height; j++) {
    const row = j * width;
    for (let i = 0; i < width; i++) {
      let m = data[row + i];
      if (i > 0 && data[row + i - 1] > m) m = data[row + i - 1];
      if (i + 1 < width && data[row + i + 1] > m) m = data[row + i + 1];
      tmp[row + i] = m;
    }
  }
  const out = new Float32Array(data.length);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      let m = tmp[j * width + i];
      if (j > 0 && tmp[(j - 1) * width + i] > m) m = tmp[(j - 1) * width + i];
      if (j + 1 < height && tmp[(j + 1) * width + i] > m) m = tmp[(j + 1) * width + i];
      out[j * width + i] = m;
    }
  }
  return out;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function meshBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

// The cutter's shape is described once, in engine/tool-geometry.js, and this is
// that description evaluated. It used to be a second one living here, which
// knew about balls and bull noses and answered *zero* for every other cutter in
// the rack — so a chamfer mill, a drill and a face mill were all simulated and
// finished as flat cutters of their full diameter. Re-exported because it is
// the drop-cutter's own vocabulary and callers here should not have to know
// which file the silhouette lives in.
export { clearanceProfile, cuttingRadiusOf };

/**
 * Precompute the grid offsets the tool covers, with each one's clearance.
 * Reused across every sample point, which is what keeps finishing tractable.
 */
export function buildToolKernel(tool, cellSize) {
  const r = cuttingRadiusOf(tool);
  const profile = clearanceProfile(tool);
  const reach = Math.ceil(r / cellSize);
  const offsets = [];
  // Rows, kept alongside, because the disc is a stack of contiguous runs and a
  // whole run can often be ruled out at once — see rowWindowMax. Ordered from
  // the middle outward: the centre row is where the tool is lowest and so where
  // the highest tip usually comes from, and the sooner a high one is found the
  // more of the rest can be skipped.
  const rows = [];
  for (let n = 0; n <= reach; n++) {
    for (const dj of n === 0 ? [0] : [n, -n]) {
      const start = offsets.length / 3;
      let minC = Infinity;
      for (let di = -reach; di <= reach; di++) {
        const d = Math.hypot(di * cellSize, dj * cellSize);
        if (d > r + 1e-9) continue;
        // rounded the way the offsets array will store it, so the bound below
        // is a bound on the numbers the scan actually uses
        const c = Math.fround(profile(d));
        if (c < minC) minC = c;
        offsets.push(di, dj, c);
      }
      const end = offsets.length / 3;
      if (end === start) continue;
      // `minC` is measured rather than assumed to be the clearance at the row's
      // nearest point: a cutter whose silhouette is not monotonic in radius
      // would break that assumption, and this cannot.
      //
      // Flat, not an array of objects: this is read a few hundred million times
      // in a finishing pass, and walking objects to get at six numbers costs
      // more than the arithmetic they are for.
      rows.push(dj, start, end, minC, offsets[start * 3], offsets[(end - 1) * 3]);
    }
  }
  return {
    offsets: new Float32Array(offsets),
    count: offsets.length / 3,
    radius: r,
    rows: new Float64Array(rows),
    rowCount: rows.length / ROW_STRIDE,
  };
}

/** [dj, start, end, minClearance, di0, di1] per row of the cutter disc. */
const ROW_STRIDE = 6;

/**
 * Surface gradient at a grid cell, by central difference.
 * Returns [dz/dx, dz/dy]; zero where the neighbourhood has no geometry.
 */
export function gradientAt(map, i, j) {
  const { data, width, height, cellSize, floor } = map;
  const h = (a, b) => {
    const ci = a < 0 ? 0 : a > width - 1 ? width - 1 : a;
    const cj = b < 0 ? 0 : b > height - 1 ? height - 1 : b;
    return data[cj * width + ci];
  };
  const xp = h(i + 1, j), xm = h(i - 1, j);
  const yp = h(i, j + 1), ym = h(i, j - 1);
  if (xp === floor || xm === floor || yp === floor || ym === floor) return [0, 0];
  return [(xp - xm) / (2 * cellSize), (yp - ym) / (2 * cellSize)];
}

/** Steepest-descent direction at a cell as a unit vector, or null on the flat. */
export function downhillAt(map, i, j, minSlope = 1e-3) {
  const [gx, gy] = gradientAt(map, i, j);
  const mag = Math.hypot(gx, gy);
  if (mag < minSlope) return null;
  return [-gx / mag, -gy / mag];
}

/**
 * Lowest tip Z the tool can reach at (x, y) without gouging.
 * Returns `map.floor` when the tool covers no geometry at all.
 */
export function dropCutter(map, kernel, x, y) {
  const { data, width, height, cellSize } = map;
  const ci = Math.round((x - map.min[0]) / cellSize);
  const cj = Math.round((y - map.min[1]) / cellSize);
  const k = kernel.offsets;
  const win = map.window;

  const rows = kernel.rows;
  const half = win ? win.half : 0;
  const span = half * 2 + 1;

  let best = -Infinity;
  for (let m = 0; m < kernel.rowCount; m++) {
    const at = m * ROW_STRIDE;
    const j = cj + rows[at];
    if (j < 0 || j >= height) continue;
    const base = j * width;
    const rowStart = rows[at + 1];
    const rowEnd = rows[at + 2];
    const minC = rows[at + 3];

    // The row's ceiling, in one or two reads rather than fifty. Skipping is
    // only ever an optimisation: `ceiling` is an upper bound on every candidate
    // the row could produce, so a row that cannot beat `best` cannot change the
    // answer. Exact, not approximate — there is no tolerance in it.
    if (win && best > -Infinity) {
      const lo = ci + rows[at + 4];
      const hi = ci + rows[at + 5];
      let top = -Infinity;
      // windows of 2·half+1 cells, enough of them to cover the run
      for (let c = lo + half; ; c += span) {
        const i = c < 0 ? 0 : c > width - 1 ? width - 1 : c;
        const v = win.data[base + i];
        if (v > top) top = v;
        if (c >= hi - half) break;
      }
      if (top - minC <= best) continue;
    }

    for (let n = rowStart; n < rowEnd; n++) {
      const i = ci + k[n * 3];
      if (i < 0 || i >= width) continue;
      const h = data[base + i];
      if (h === map.floor) continue;
      const candidate = h - k[n * 3 + 2];
      if (candidate > best) best = candidate;
    }
  }
  return best === -Infinity ? map.floor : best;
}
