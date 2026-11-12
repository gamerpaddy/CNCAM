// node bench/audit/rest-check.mjs part — a rough, then a rest pass with a smaller cutter, on one billet:
// what the pair removes in total, and the program lengths. Run before and after a change to compare.
import { loadPart, TOOLS, Material, measure } from './lib.js';
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
const b = measure(rest, small, stock, m);
let hash = 0; for (let i = 0; i < m.top.length; i += 7) hash = (hash * 31 + Math.round(m.top[i] * 100)) | 0;
console.log(`${process.argv[2]}: rough vol ${a.volume.toFixed(0)}  rest vol ${b.volume.toFixed(0)} cut ${b.cutMin.toFixed(2)}m air ${(100 * b.airLen / Math.max(1, b.cutLen)).toFixed(0)}%  moves ${rest.count} cutLen ${b.cutLen.toFixed(0)} rapidMin ${b.rapidMin.toFixed(2)}  gen ${ms.toFixed(0)}ms  surface ${hash}`);
if (process.env.FEEDS) { const by = {}; let prev = null; (await import('../../src/engine/cl.js')).eachMove(rest, (op, x, y, z, i, j, k, feed) => { if (prev && op !== 0 && feed !== 0) { by[feed] = (by[feed] ?? 0) + Math.hypot(x - prev[0], y - prev[1], z - prev[2]); } prev = [x, y, z]; }); console.log(JSON.stringify(by)); }
