// node bench/audit/contour-check.mjs part — contour finishing after an adaptive rough, with and without skipping what the rough cleared
import { loadPart, TOOLS, Material, measure } from './lib.js';
import { generateToolpath } from '../../src/engine/toolpath.js';
import { defaultParamsFor } from '../../src/engine/op-defaults.js';
import { clearedStack } from '../../src/engine/rest.js';
import { depthLevelsFor } from '../../src/engine/stock.js';
const part = loadPart(process.argv[2] ?? 'clamp1');
const { stock, bounds, mesh } = part; const rt = TOOLS.flat; const ft = TOOLS.small;
const gen = (type, tool, extra = {}, regions) => generateToolpath({ type, name: type, tool, mesh, stock, regions, params: { ...defaultParamsFor(type, { stock, modelBounds: bounds, tool }), ...extra } });
const rough = gen('adaptive', rt);
const params = { ...defaultParamsFor('contour2d', { stock, modelBounds: bounds, tool: ft }), restMachining: true };
const cleared = clearedStack([{ cl: rough, tool: rt }], depthLevelsFor(params, mesh, ft), { tolerance: 0.01, stock });
const surfaces = [];
for (const [label, regions] of [['plain', undefined], ['skipping cleared', { include: [], avoid: [], cleared }]]) {
  const t0 = performance.now(); const cl = generateToolpath({ type: 'contour2d', name: 'c', tool: ft, mesh, stock, params, regions }); const ms = performance.now() - t0;
  const m = new Material(stock, 0.15); measure(rough, rt, stock, m); const r = measure(cl, ft, stock, m);
  let hash = 0; for (let i = 0; i < m.top.length; i += 7) hash = (hash * 31 + Math.round(m.top[i] * 100)) | 0;
  surfaces.push(m.top.slice());
  console.log(`${process.argv[2]} contour ${label}: ${r.cutMin.toFixed(2)} min, air ${(100 * r.airLen / Math.max(1, r.cutLen)).toFixed(0)}%, vol ${r.volume.toFixed(0)}, surface ${hash}, crash ${r.crash.toFixed(2)}/${r.crashes}, ${cl.count} moves, ${ms.toFixed(0)} ms`);
}
{ const [a, b] = surfaces; let n = 0, mx = 0, at = null; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > 0.02) n++; if (d > mx) { mx = d; at = i; } } console.log(`   surface differs in ${n} cells (>0.02mm), max ${mx.toFixed(2)}mm; plain ${a[at ?? 0].toFixed(2)} vs skipping ${b[at ?? 0].toFixed(2)} (mm height)`); }
if (process.env.LEVELS) {
  const { eachMove, OP, FEED } = await import('../../src/engine/cl.js');
  const cl = generateToolpath({ type: 'contour2d', name: 'c', tool: ft, mesh, stock, params, regions: { include: [], avoid: [], cleared } });
  const by = new Map(); let prev = null;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => { if (prev && op === OP.LINE && feed !== FEED.RAPID) { const key = Math.min(z, prev[2]).toFixed(1); const e = by.get(key) ?? [0, 0]; const L = Math.hypot(x - prev[0], y - prev[1]); if (Math.abs(z - prev[2]) < 1e-3) e[0] += L; else e[1] += Math.hypot(x - prev[0], y - prev[1], z - prev[2]); by.set(key, e); } prev = [x, y, z]; });
  console.log('level: level-cut / descending-length'); console.log([...by].sort((a, b) => b[0] - a[0]).filter(([, e]) => e[0] + e[1] > 20).map(([k, e]) => `${k}: ${e[0].toFixed(0)}/${e[1].toFixed(0)}`).join('  '));
  console.log(JSON.stringify(cl.notes).slice(0, 500));
}
{ const cl = generateToolpath({ type: 'contour2d', name: 'c', tool: ft, mesh, stock, params, regions: { include: [], avoid: [], cleared } }); const m = new Material(stock, 0.15); measure(rough, rt, stock, m); const r = measure(cl, ft, stock, m); console.log(`   as the app builds it: ${r.cutMin.toFixed(2)} min, ${cl.count} moves, notes ${JSON.stringify((cl.notes ?? []).map((n) => n.text.slice(0, 40)))}`); }
