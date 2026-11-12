// node bench/audit/rest-check.mjs part — a rough, then a rest pass with a smaller cutter, on one billet:
// what the pair removes in total, and the program lengths. Run before and after a change to compare.
import { loadPart, TOOLS, Material, measure, writePng } from './lib.js';
import { generateToolpath } from '../../src/engine/toolpath.js';
import { defaultParamsFor } from '../../src/engine/op-defaults.js';
import { clearedStack } from '../../src/engine/rest.js';
import { depthLevelsFor } from '../../src/engine/stock.js';
const part = loadPart(process.argv[2] ?? 'test-step-plate');
const big = { ...TOOLS.flat, number: 1, diameter: 10 };
const small = TOOLS.small;
const { stock, bounds, mesh } = part;
const gen = (type, tool, extra = {}, regions = undefined) => generateToolpath({
  type, name: type, tool, mesh, stock, regions,
  params: { ...defaultParamsFor(type, { stock, modelBounds: bounds, tool }), ...extra },
});
const rough = gen('clear2d', big);
const earlier = [{ cl: rough, tool: big }];
const params = { ...defaultParamsFor('clear2d', { stock, modelBounds: bounds, tool: small }), restMachining: true };
const levels = depthLevelsFor(params, mesh, small);
const cleared = clearedStack(earlier, levels, { tolerance: params.tolerance ?? 0.01, stock });
const t0 = performance.now();
const rest = generateToolpath({ type: 'clear2d', name: 'rest', tool: small, mesh, stock, params, regions: { include: [], avoid: [], cleared } });
const ms = performance.now() - t0;
const m = new Material(stock, 0.15);
const a = measure(rough, big, stock, m);
const segs = [];
const b = measure(rest, small, stock, m, (p0, p1, feed, vol, len, rapid) => { if (!rapid) segs.push([p0, p1, vol / Math.max(0.1, len) < 0.02, Math.min(p0[2], p1[2])]); });
if (process.env.DRAW) {
  const S = 8; const W = Math.ceil((stock.max[0] - stock.min[0] + 20) * S); const H = Math.ceil((stock.max[1] - stock.min[1] + 20) * S);
  const img = new Uint8Array(W * H * 3).fill(255);
  const [z0, z1] = (process.env.ZW ?? '-1000,1000').split(',').map(Number);
  for (const [a, b2, air, z] of segs) {
    if (z < z0 || z > z1) continue;
    const n = Math.max(1, Math.ceil(Math.hypot(b2[0] - a[0], b2[1] - a[1]) * S));
    for (let k = 0; k <= n; k++) {
      const x = a[0] + (b2[0] - a[0]) * k / n, y = a[1] + (b2[1] - a[1]) * k / n;
      const i = Math.round((x - stock.min[0] + 10) * S), j = H - 1 - Math.round((y - stock.min[1] + 10) * S);
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      const o = (j * W + i) * 3; const c = air ? [255, 0, 0] : [0, 150, 0]; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2];
    }
  }
  writePng(process.env.DRAW, W, H, img);
}
let hash = 0; for (let i = 0; i < m.top.length; i += 7) hash = (hash * 31 + Math.round(m.top[i] * 100)) | 0;
console.log(`${process.argv[2]}: rough vol ${a.volume.toFixed(0)}  rest vol ${b.volume.toFixed(0)} cut ${b.cutMin.toFixed(2)}m air ${(100 * b.airLen / Math.max(1, b.cutLen)).toFixed(0)}%  moves ${rest.count} cutLen ${b.cutLen.toFixed(0)} rapidMin ${b.rapidMin.toFixed(2)}  gen ${ms.toFixed(0)}ms  surface ${hash} crash ${b.crash.toFixed(2)}/${b.crashes}`);
if (process.env.FEEDS) { const by = {}; let prev = null; (await import('../../src/engine/cl.js')).eachMove(rest, (op, x, y, z, i, j, k, feed) => { if (prev && op !== 0 && feed !== 0) { by[feed] = (by[feed] ?? 0) + Math.hypot(x - prev[0], y - prev[1], z - prev[2]); } prev = [x, y, z]; }); console.log(JSON.stringify(by)); }

if (process.env.BYZ) { const by = new Map(); for (const [a, b2, air, z] of segs) { const k = z.toFixed(1); const e = by.get(k) ?? [0, 0]; const l = Math.hypot(b2[0] - a[0], b2[1] - a[1]); e[air ? 1 : 0] += l; by.set(k, e); } console.log([...by].sort((x, y) => y[0] - x[0]).map(([k, [c, a]]) => `${k}: cut ${c.toFixed(0)} air ${a.toFixed(0)}`).join(String.fromCharCode(10))); }
