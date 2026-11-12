// Constant-scallop finishing: passes spaced along the *surface*, so the cusp
// between them is the same height everywhere on the part.
//
// A raster steps a fixed distance across the plan view. On a flat floor that
// is the distance between its passes; on a steep wall the same plan step is a
// far longer way along the surface, and the cusp it leaves is far taller — so a
// raster finishing a ramp and a dome is smooth on the one and ridged on the
// other, whatever stepover was asked for. Spacing the passes by distance
// *along the surface* is the fix, and it is what this does.
//
//   spacing   a ball of radius R leaves a cusp of height h between passes s apart
//             where  h = R − √(R² − (s/2)²), so  s = 2·√(2Rh − h²). The height
//             is what is asked for; the spacing follows from the cutter.
//   passes    the distance from the edge of the machinable area, measured over the
//             surface (not across the plan), is a field; its contours at s/2, 3s/2,
//             5s/2 … are the passes. Each is at the same surface distance from
//             the last, which is the whole point.
//
// Seen from above like the other heightmap finishers, so an undercut is not
// finished, and the tool is dropped on the same surface and judged by the same
// links as the parallel pass (see parallel3d.js prepareFinish).

import { prepareFinish, emitOrdered } from './parallel3d.js';
import { regionRefusal } from '../regions.js';

/** The spacing a ball of radius R leaves a cusp of height h at, mm. */
export function scallopSpacing(R, h) {
  if (!(R > 0) || !(h > 0)) return 0;
  const k = Math.min(h, R);
  return 2 * Math.sqrt(2 * R * k - k * k);
}

/** The cutter's radius where it meets the work: a ball's, a bull's corner. */
export function scallopRadius(tool) {
  if (tool.type === 'ball') return tool.diameter / 2;
  if (tool.type === 'bull') return Math.min(tool.cornerRadius || 0, tool.diameter / 2);
  return 0;
}

/** A binary min-heap on (key, node), flat. */
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, value) {
    const { k, v } = this;
    let i = k.length;
    k.push(key); v.push(value);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p];
      i = p;
    }
    k[i] = key; v[i] = value;
  }
  pop() {
    const { k, v } = this;
    const topKey = k[0];
    const topValue = v[0];
    const lastKey = k.pop();
    const lastValue = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lastKey) break;
        k[i] = k[c]; v[i] = v[c];
        i = c;
      }
      k[i] = lastKey; v[i] = lastValue;
    }
    return [topKey, topValue];
  }
}

// the sixteen moves of a grid step and a knight's move: the straight-line error of
// a path over a grid falls from 8% with eight neighbours to under 3% with these
const STEPS = [];
for (let dj = -2; dj <= 2; dj++) {
  for (let di = -2; di <= 2; di++) {
    if ((di === 0 && dj === 0) || Math.abs(di) === 2 && Math.abs(dj) === 2) continue;
    // keep a move only when no shorter move is in the same direction
    const gcd = (a, b) => (b === 0 ? Math.abs(a) : gcd(b, a % b));
    if (gcd(di, dj) !== 1) continue;
    STEPS.push([di, dj]);
  }
}

export function generateScallop({
  mesh, tool, params: given, stock, regions, earlier = null,
}) {
  const R = scallopRadius(tool);
  if (!(R > 0)) {
    const cl = prepareFinish({
      mesh, tool, params: given, stock, regions, earlier, label: 'scallop finishing',
    }).cl;
    cl.toolChange(tool.number);
    cl.warn('scallop finishing needs a ball or a bull-nose cutter: a flat end mill has no radius to leave a '
      + 'scallop of, so its cusp is the stepover itself — use parallel finishing');
    return cl.finish();
  }
  const height = given.scallopHeight > 0 ? given.scallopHeight : 0.02;
  // a margin against the 3% the distance field can be out by
  const spacing = Math.min(tool.diameter * 0.9, scallopSpacing(R, height) * 0.95);
  const prepared = prepareFinish({
    mesh, tool, params: given, stock, regions, earlier, stepOf: () => Math.max(0.05, spacing), label: 'scallop finishing',
  });
  if (prepared.empty) return prepared.cl.finish();
  const {
    cl, r, tolerance, clearance, feedPlane, map, box, probe, sample, link,
  } = prepared;

  // --- the distance field, over a grid no finer than the spacing can use ---
  let g = Math.max(map.cellSize, spacing / 4);
  const ngx = (g2) => Math.floor((box.max[0] - box.min[0]) / g2) + 1;
  const ngy = (g2) => Math.floor((box.max[1] - box.min[1]) / g2) + 1;
  while (ngx(g) * ngy(g) > 3_000_000) g *= 1.25;
  const nx = ngx(g);
  const ny = ngy(g);
  const x0 = box.min[0];
  const y0 = box.min[1];
  const N = nx * ny;
  // `z` says where the cutter may go at all (NaN where it may not); `part` is the
  // part's own surface, which is what the distance is measured over. The two
  // differ wherever the tool is held off by something — at the foot of a steep
  // wall the tool's height climbs while the surface it is cutting stays put — and
  // spacing the passes over the tool's path rather than over the part is what
  // left rings of uncut ground round the foot of the dome in the first version.
  const z = new Float32Array(N).fill(NaN);
  const part = new Float32Array(N).fill(NaN);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * g;
      const y = y0 + j * g;
      const p = probe(x, y);
      if (p[2] === null) continue;
      const k = j * nx + i;
      z[k] = p[2];
      const ci = Math.round((x - map.min[0]) / map.cellSize);
      const cj = Math.round((y - map.min[1]) / map.cellSize);
      const h = ci >= 0 && cj >= 0 && ci < map.width && cj < map.height ? map.data[cj * map.width + ci] : NaN;
      part[k] = Number.isFinite(h) && h !== map.floor ? h : p[2];
    }
  }
  const dist = new Float64Array(N).fill(Infinity);
  const heap = new Heap();
  // the edge of what may be cut: a cell that has an uncuttable neighbour, or the
  // edge of the grid
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (Number.isNaN(z[k])) continue;
      const edge = i === 0 || j === 0 || i === nx - 1 || j === ny - 1
        || Number.isNaN(z[k - 1]) || Number.isNaN(z[k + 1]) || Number.isNaN(z[k - nx]) || Number.isNaN(z[k + nx]);
      if (edge) { dist[k] = 0; heap.push(0, k); }
    }
  }
  if (heap.size === 0) {
    cl.warn('scallop finishing has no surface to cover: check Top Z, Bottom Z and the regions');
    return cl.finish();
  }
  while (heap.size) {
    const [d, k] = heap.pop();
    if (d > dist[k]) continue;
    const i = k % nx;
    const j = (k - i) / nx;
    for (const [di, dj] of STEPS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const m = nj * nx + ni;
      const zm = z[m];
      if (Number.isNaN(zm)) continue;
      const w = Math.hypot(di * g, dj * g, part[m] - part[k]);
      if (d + w < dist[m]) { dist[m] = d + w; heap.push(d + w, m); }
    }
  }
  let reach = 0;
  for (let k = 0; k < N; k++) if (Number.isFinite(dist[k]) && dist[k] > reach) reach = dist[k];

  // --- the contours: one pass at half a spacing, then at every spacing after ---
  const levels = Math.floor((reach - spacing / 2) / spacing) + 1;
  if (levels > 4000) {
    cl.warn(`scallop finishing would need ${levels} passes — a taller scallop or a smaller area keeps it sensible`);
    return cl.finish();
  }
  // Marching squares over every level at once. For each cell of four corners,
  // every level that falls in its range crosses it, so one sweep sorts the
  // segments into their levels without a pass over the grid per level.
  const segments = Array.from({ length: Math.max(0, levels) }, () => []);
  const edgeKey = (a, b) => (a < b ? a * N + b : b * N + a);
  const crossing = (a, b, level) => {
    const da = dist[a];
    const db = dist[b];
    const t = (level - da) / (db - da);
    const ia = a % nx; const ja = (a - ia) / nx;
    const ib = b % nx; const jb = (b - ib) / nx;
    return [x0 + (ia + (ib - ia) * t) * g, y0 + (ja + (jb - ja) * t) * g];
  };
  // where each level crosses each grid edge, by level then edge; an edge is the
  // same point to the two cells that share it, which is what joins the segments
  const pointsAt = Array.from({ length: Math.max(0, levels) }, () => new Map());
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = a + nx;
      const da = dist[a]; const db = dist[b]; const dc = dist[c]; const dd = dist[d];
      if (!(Number.isFinite(da) && Number.isFinite(db) && Number.isFinite(dc) && Number.isFinite(dd))) continue;
      const lo = Math.min(da, db, dc, dd);
      const hi = Math.max(da, db, dc, dd);
      if (hi - lo < 1e-12) continue;
      const first = Math.max(0, Math.ceil((lo - spacing / 2) / spacing));
      const last = Math.min(levels - 1, Math.floor((hi - spacing / 2) / spacing));
      for (let k = first; k <= last; k++) {
        const level = spacing / 2 + k * spacing;
        // the edges of this cell the level crosses: a–b, b–c, c–d, d–a
        const sides = [[a, b], [b, c], [c, d], [d, a]];
        const hit = [];
        for (const [p, q] of sides) {
          const dp = dist[p];
          const dq = dist[q];
          if ((dp < level) !== (dq < level)) {
            const key = edgeKey(p, q);
            hit.push(key);
            if (!pointsAt[k].has(key)) pointsAt[k].set(key, crossing(p, q, level));
          }
        }
        // two crossings are one segment; four is a saddle, which is paired the
        // simple way — at this grid the difference is below the tolerance
        for (let h = 0; h + 1 < hit.length; h += 2) segments[k].push([hit[h], hit[h + 1]]);
      }
    }
  }

  // join each level's segments into polylines by the edges they share
  const paths = [];
  const minLength = tool.diameter;
  for (let k = 0; k < segments.length; k++) {
    const segs = segments[k];
    if (!segs.length) continue;
    const at = new Map();
    segs.forEach(([p, q], n) => {
      for (const key of [p, q]) {
        if (!at.has(key)) at.set(key, []);
        at.get(key).push(n);
      }
    });
    const used = new Uint8Array(segs.length);
    const starts = [...at.entries()].filter(([, list]) => list.length === 1).map(([key]) => key);
    const walk = (startKey) => {
      const line = [startKey];
      let key = startKey;
      for (;;) {
        const next = (at.get(key) ?? []).find((n) => !used[n]);
        if (next === undefined) break;
        used[next] = 1;
        const [p, q] = segs[next];
        key = p === key ? q : p;
        line.push(key);
      }
      return line;
    };
    const lines = starts.map(walk).filter((l) => l.length > 1);
    // what is left is closed loops
    for (let n = 0; n < segs.length; n++) {
      if (used[n]) continue;
      lines.push(walk(segs[n][0]));
    }
    for (const line of lines) {
      const path = [];
      let length = 0;
      let prev = null;
      for (const key of line) {
        const [x, y] = pointsAt[k].get(key);
        const s = sample(x, y);
        if (!s) {
          // a gap in the cuttable ground ends this run and starts the next
          if (path.length > 1) paths.push(path.splice(0));
          path.length = 0;
          prev = null;
          continue;
        }
        if (prev) length += Math.hypot(x - prev[0], y - prev[1]);
        path.push(s);
        prev = [x, y];
      }
      if (path.length > 1 && length >= minLength * 0.5) paths.push(path);
    }
  }

  if (paths.length === 0) {
    const why = regionRefusal(regions, r, tolerance);
    cl.warn(why
      ? `scallop finishing produced no passes — ${why}`
      : 'scallop finishing produced no passes — check Top Z and Bottom Z');
    return cl.finish();
  }
  cl.info(`${levels} passes ${spacing.toFixed(3)}mm apart along the surface — a ${height}mm scallop `
    + `from a ⌀${tool.diameter} cutter of radius ${R}`);
  emitOrdered(cl, paths, { clearance, feedPlane, link });
  return cl.finish();
}
