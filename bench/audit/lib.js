// One table for every milling strategy: how fast it generates, how it loads the
// cutter, how much of its cutting is air, and how much of its time is spent
// travelling instead of cutting.
//
//   node bench/audit/sweep.js [strategy ...]         all strategies, all parts
//   node bench/audit/sweep.js adaptive --part=stepped
//
// Not part of the test suite. The load is measured the way the engagement test
// does it — replay the finished program through a heightmap of the billet, and
// read the footprint each move takes down to its own tip plane — but the
// reading is kept per strategy rather than asserted, so a strategy that is too
// heavy, too slow, or too fond of lifting shows up as a number to compare.
//
// Columns
//   gen    seconds to generate the toolpath
//   cut    minutes at cutting feeds     (cut + lead + ramp + plunge)
//   rapid  minutes travelling at rapid  (rapidFeed below)
//   air    share of the cutting distance that removed < 0.02mm of material
//   w95    the 95th percentile radial width of cut, in cutter diameters
//   wMax   the widest bite of any ordinary cut, in cutter diameters
//   deep   the deepest cut taken at more than 0.9xD of width (mm)
//   crash  deepest a rapid or a cut drove the tool body into standing stock,
//          and how many moves did it (mm / count)
//   lift   rapid lifts that rise above the stock top by more than the cutter
//          needed to clear what it had just cut, per 100 mm of cutting

import { generateToolpath, MILLING_OPS } from '../../src/engine/toolpath.js';
import { defaultParamsFor } from '../../src/engine/op-defaults.js';
import { eachMove, OP, FEED } from '../../src/engine/cl.js';
import { clearanceProfile, cuttingRadiusOf } from '../../src/engine/tool-geometry.js';
import { readFileSync } from 'node:fs';
import { parseSTL } from '../../src/io/stl.js';
import { meshFromSoup, computeBounds } from '../../src/geom/mesh.js';
import { createSetup } from '../../src/doc/schema.js';
import { resolveSetup } from '../../src/engine/setup.js';
import { computeStock } from '../../src/engine/stock.js';

export const RAPID_FEED = 5000;
export const TOOLS = {
  flat: { number: 1, type: 'flat', diameter: 6, fluteLength: 24, flutes: 3, spindleRpm: 9000, feedCut: 800, feedPlunge: 300 },
  ball: { number: 2, type: 'ball', diameter: 6, fluteLength: 24, flutes: 2, spindleRpm: 9000, feedCut: 800, feedPlunge: 300 },
  bull: { number: 3, type: 'bull', diameter: 8, cornerRadius: 1.5, fluteLength: 24, flutes: 3, spindleRpm: 8000, feedCut: 700, feedPlunge: 250 },
  drill: { number: 4, type: 'drill', diameter: 6, tipAngle: 118, fluteLength: 40, flutes: 2, spindleRpm: 3000, feedCut: 200, feedPlunge: 200 },
  chamfer: { number: 5, type: 'chamfer', diameter: 10, tipAngle: 90, fluteLength: 12, flutes: 4, spindleRpm: 9000, feedCut: 600, feedPlunge: 200 },
  vbit: { number: 6, type: 'chamfer', diameter: 3.175, tipAngle: 60, tipDiameter: 0.2, fluteLength: 8, flutes: 1, spindleRpm: 16000, feedCut: 400, feedPlunge: 150 },
  small: { number: 8, type: 'flat', diameter: 4, fluteLength: 20, flutes: 3, spindleRpm: 11000, feedCut: 600, feedPlunge: 250 },
  face: { number: 7, type: 'face', diameter: 25, flutes: 4, fluteLength: 10, spindleRpm: 4000, feedCut: 1200, feedPlunge: 300 },
  pencil: { number: 9, type: 'ball', diameter: 3, fluteLength: 12, flutes: 2, spindleRpm: 12000, feedCut: 500, feedPlunge: 200 },
};

export const FOR = {
  face: ['face', 'flat'],
  contour2d: ['flat', 'bull'],
  pocket: ['flat', 'bull'],
  clear2d: ['flat', 'bull'],
  adaptive: ['flat', 'bull'],
  slot: ['flat'],
  drill: ['drill'],
  bore: ['small'],
  chamfer: ['chamfer'],
  engrave: ['vbit'],
  parallel3d: ['ball', 'flat'],
  pencil: ['pencil'],
  scallop: ['ball'],
  waterline: ['ball', 'bull'],
};

export const PARTS = ['test-step-plate', 'test-hole-plate', 'test-slope', 'clamp1'];

/** A real sample, placed on its datum with the default billet around it. */
export function loadPart(name) {
  const buf = readFileSync(new URL(`../../samples/${name}.stl`, import.meta.url));
  const mesh = meshFromSoup(parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
  const { meshes, stock } = resolveSetup(createSetup(), [mesh], computeStock);
  // STOCK_TOP=n stands n mm more billet on top: a job that has not been faced
  if (process.env.STOCK_TOP) stock.max[2] += +process.env.STOCK_TOP;
  return { mesh: meshes[0], stock, bounds: computeBounds(meshes[0].positions) };
}

export function bounds(mesh) {
  const p = mesh.positions ?? mesh.vertices ?? mesh;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return { min, max };
}

export class Material {
  constructor(stock, cell) {
    this.cell = cell;
    const pad = 8;
    this.min = [stock.min[0] - pad, stock.min[1] - pad];
    this.width = Math.ceil((stock.max[0] - stock.min[0] + 2 * pad) / cell) + 1;
    this.height = Math.ceil((stock.max[1] - stock.min[1] + 2 * pad) / cell) + 1;
    this.area = cell * cell;
    this.floor = stock.min[2];
    this.top = new Float32Array(this.width * this.height).fill(-1e9);
    for (let j = 0; j < this.height; j++) {
      for (let i = 0; i < this.width; i++) {
        const x = this.min[0] + i * cell;
        const y = this.min[1] + j * cell;
        if (x >= stock.min[0] && x <= stock.max[0] && y >= stock.min[1] && y <= stock.max[1]) {
          this.top[j * this.width + i] = stock.max[2];
        }
      }
    }
  }

  carve(x0, y0, z0, x1, y1, z1, radius, profile) {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((Math.min(x0, x1) - radius - this.min[0]) / c));
    const i1 = Math.min(this.width - 1, Math.ceil((Math.max(x0, x1) + radius - this.min[0]) / c));
    const j0 = Math.max(0, Math.floor((Math.min(y0, y1) - radius - this.min[1]) / c));
    const j1 = Math.min(this.height - 1, Math.ceil((Math.max(y0, y1) + radius - this.min[1]) / c));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lenSq = dx * dx + dy * dy;
    const plane = Math.min(z0, z1) + 1e-4;
    let cells = 0;
    let depth = 0;
    let volume = 0;
    for (let j = j0; j <= j1; j++) {
      const py = this.min[1] + j * c;
      const row = j * this.width;
      for (let i = i0; i <= i1; i++) {
        const px = this.min[0] + i * c;
        let t = lenSq > 0 ? ((px - x0) * dx + (py - y0) * dy) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
        if (d > radius) continue;
        const surface = Math.max(z0 + (z1 - z0) * t + profile(d), this.floor - 1);
        const was = this.top[row + i];
        if (was <= surface + 1e-6) continue;
        if (was > -1e8) {
          if (was - surface > depth) depth = was - surface;
          if (was > plane && surface <= plane) cells++;
          volume += (was - surface) * this.area;
        }
        this.top[row + i] = surface;
      }
    }
    return { swath: cells * this.area, depth, volume };
  }

  interference(x, y, z, radius, profile) {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((x - radius - this.min[0]) / c));
    const i1 = Math.min(this.width - 1, Math.ceil((x + radius - this.min[0]) / c));
    const j0 = Math.max(0, Math.floor((y - radius - this.min[1]) / c));
    const j1 = Math.min(this.height - 1, Math.ceil((y + radius - this.min[1]) / c));
    let over = 0;
    for (let j = j0; j <= j1; j++) {
      const py = this.min[1] + j * c;
      const row = j * this.width;
      for (let i = i0; i <= i1; i++) {
        const t = this.top[row + i];
        if (t <= z + 1e-6) continue;
        const d = Math.hypot(this.min[0] + i * c - x, py - y);
        if (d > radius - 1.5 * c || t <= z + profile(d) + 1e-6) continue;
        over = Math.max(over, t - z - profile(d));
      }
    }
    return over;
  }
}

export function measure(cl, tool, stock, shared = null, hook = null) {
  const radius = cuttingRadiusOf(tool);
  const profile = clearanceProfile(tool);
  const cell = shared ? shared.cell : Math.max(0.15, radius / 10);
  const m = shared ?? new Material(stock, cell);
  const step = Math.max(0.3, cell * 2);
  const r = {
    cutLen: 0, rapidLen: 0, airLen: 0, widths: [], wMax: 0, deep: 0,
    crash: 0, crashes: 0, areas: [], airByFeed: new Map(), airRuns: [], run: 0, areaAt: null, heavy: 0, buried: 0, heavyByZ: new Map(), heavyAt: null, airByZ: new Map(), crashAt: [], depthSum: 0, depthLen: 0, cutMin: 0, rapidMin: 0, lifts: 0, volume: 0, vertRapid: 0,
  };
  let prev = null;
  let maxCutZ = -Infinity;
  const feeds = { cut: tool.feedCut, plunge: tool.feedPlunge };
  eachMove(cl, (op, x, y, z, i, j, k, feed, index) => {
    if (op === OP.DRILL) {
      const v = m.carve(x, y, z, x, y, z, radius, profile);
      r.volume += v.volume;
      const depth = Math.abs(i - z);
      r.cutLen += depth;
      r.cutMin += depth / Math.max(1, feeds.plunge);
      prev = [x, y, i];
      return;
    }
    if (!prev) { prev = [x, y, z]; return; }
    const len = Math.hypot(x - prev[0], y - prev[1], z - prev[2]);
    const n = Math.max(1, Math.ceil(len / step));
    if (op === OP.RAPID || feed === FEED.RAPID) {
      r.rapidLen += len;
      if (hook) hook(prev, [x, y, z], feed, 0, len, true, index);
      r.rapidMin += len / RAPID_FEED;
      if (Math.abs(x - prev[0]) + Math.abs(y - prev[1]) < 1e-6) r.vertRapid += len;
      if (z > prev[2] + 1e-6 && Math.abs(x - prev[0]) + Math.abs(y - prev[1]) < 1e-6) {
        // a pure rise: a lift. Count it when it goes well above what was cut.
        if (z > maxCutZ + 2 * Math.max(1, radius * 0.2)) r.lifts++;
        maxCutZ = -Infinity;
      }
      for (let p = 0; p <= n; p++) {
        const t = p / n;
        const over = m.interference(prev[0] + (x - prev[0]) * t, prev[1] + (y - prev[1]) * t,
          prev[2] + (z - prev[2]) * t, radius, profile);
        if (over > 0.05) {
          r.crashes++;
          if (r.crashAt.length < 6 && over > (+process.env.CRASHMIN || 0.3)) r.crashAt.push([+prev[0].toFixed(1), +prev[1].toFixed(1), +prev[2].toFixed(1), +x.toFixed(1), +y.toFixed(1), +z.toFixed(1), +over.toFixed(2)]);
          if (over > r.crash) r.crash = over;
        }
      }
      prev = [x, y, z];
      return;
    }
    const descending = z < prev[2] - 1e-6 && prev[2] - z > Math.hypot(x - prev[0], y - prev[1]) * 0.02;
    r.cutLen += len;
    let f = feeds.cut;
    if (feed === FEED.PLUNGE) f = feeds.plunge;
    else if (descending && feed === FEED.RAMP) f = Math.min(feeds.cut, feeds.plunge * len / Math.max(1e-9, prev[2] - z));
    r.cutMin += len / Math.max(1, f);
    let vol = 0;
    for (let p = 1; p <= n; p++) {
      const t0 = (p - 1) / n;
      const t1 = p / n;
      const ax = prev[0] + (x - prev[0]) * t0;
      const ay = prev[1] + (y - prev[1]) * t0;
      const bx = prev[0] + (x - prev[0]) * t1;
      const by = prev[1] + (y - prev[1]) * t1;
      const piece = Math.hypot(bx - ax, by - ay);
      const z0 = prev[2] + (z - prev[2]) * t0;
      const z1 = prev[2] + (z - prev[2]) * t1;
      const { swath, depth, volume } = m.carve(ax, ay, z0, bx, by, z1, radius, profile);
      vol += volume;
      if (z1 > maxCutZ) maxCutZ = z1;
      if (descending || piece < 1e-9) continue;
      const w = Math.min(swath / piece, 2 * radius) / (2 * radius);
      if (feed === FEED.CUT) {
        if (w > 0.02) { r.depthSum += depth * piece; r.depthLen += piece; }
        r.widths.push([w, piece]);
        if (w > 0.02) { r.areas.push([w * 2 * radius * depth, piece]); if (!r.areaAt || w * 2 * radius * depth > r.areaAt[3]) r.areaAt = [+bx.toFixed(1), +by.toFixed(1), +z1.toFixed(1), +(w * 2 * radius * depth).toFixed(1), +w.toFixed(2), +depth.toFixed(1)]; }
        if (w > 0.5) { r.heavy += piece; { const key = Math.round(z1 * 2) / 2; r.heavyByZ.set(key, (r.heavyByZ.get(key) ?? 0) + piece); } if (!r.heavyAt || w > r.heavyAt[3]) r.heavyAt = [+bx.toFixed(1), +by.toFixed(1), +z1.toFixed(1), +w.toFixed(2), +depth.toFixed(1)]; }
        if (w > 0.9) r.buried += piece;
        if (w > r.wMax) r.wMax = w;
        if (w > 0.9 && depth > r.deep) { r.deep = depth; r.deepAt = [+bx.toFixed(1), +by.toFixed(1), +z1.toFixed(1), +depth.toFixed(1)]; }
      }
    }
    r.volume += vol;
    if (hook) hook(prev, [x, y, z], feed, vol, len, false, index);
    if (vol >= 0.02 * Math.max(0.1, len) && r.run > 0) { r.airRuns.push(r.run); r.run = 0; }
    if (vol < 0.02 * Math.max(0.1, len)) {
      r.airLen += len;
      r.airByFeed.set(feed, (r.airByFeed.get(feed) ?? 0) + len);
      r.run += len;
      const key = Math.min(z, prev[2]).toFixed(1);
      r.airByZ.set(key, (r.airByZ.get(key) ?? 0) + len);
    }
    // a cut that ends in standing stock with the tool body inside it
    const over = m.interference(x, y, z, radius, profile);
    if (over > 0.05 && feed !== FEED.PLUNGE && feed !== FEED.RAMP && feed !== FEED.LEAD) {
      // cutting moves leave the cell they stand on cleared; only count a
      // standing wall *beside* the tool, which means the carve missed it
    }
    prev = [x, y, z];
  });
  // length-weighted 95th percentile of the width
  r.widths.sort((a, b) => a[0] - b[0]);
  const total = r.widths.reduce((s, w) => s + w[1], 0);
  let acc = 0;
  r.w95 = 0;
  for (const [w, l] of r.widths) { acc += l; if (acc >= 0.95 * total) { r.w95 = w; break; } }
  r.areas.sort((a, b) => a[0] - b[0]);
  const at = r.areas.reduce((t, a) => t + a[1], 0);
  let ac = 0;
  r.area99 = 0;
  for (const [a, l] of r.areas) { ac += l; if (ac >= 0.99 * at) { r.area99 = a; break; } }
  r.areaMax = r.areas.length ? r.areas[r.areas.length - 1][0] : 0;
  return r;
}


export function generate(type, tool, part, extra = {}, earlier = undefined) {
  const { mesh, stock, bounds: b } = part;
  const t0 = performance.now();
  const cl = generateToolpath({
    type, name: type, tool, mesh, stock, earlier,
    params: { ...defaultParamsFor(type, { stock, modelBounds: b, tool }), ...extra },
  });
  return { cl, gen: (performance.now() - t0) / 1000 };
}

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
export function writePng(out, W, H, img) {
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const b = Buffer.alloc(8 + d.length + 4); b.writeUInt32BE(d.length, 0); b.write(t, 4); Buffer.from(d).copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
const raw = Buffer.alloc((W * 3 + 1) * H); for (let j = 0; j < H; j++) { raw[j * (W * 3 + 1)] = 0; Buffer.from(img.buffer, j * W * 3, W * 3).copy(raw, j * (W * 3 + 1) + 1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
