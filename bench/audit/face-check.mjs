// STOCK_TOP=5 node bench/audit/face-check.mjs part — a facing pass, then adaptive with what it cleared deducted (as the app does)
import { loadPart, TOOLS, Material, measure } from './lib.js';
import { generateToolpath } from '../../src/engine/toolpath.js';
import { defaultParamsFor } from '../../src/engine/op-defaults.js';
import { clearedStack } from '../../src/engine/rest.js';
import { depthLevelsFor } from '../../src/engine/stock.js';
import { eachMove, OP, FEED } from '../../src/engine/cl.js';
const part = loadPart(process.argv[2] ?? 'test-hole-plate');
const { stock, bounds, mesh } = part; const ft = { ...TOOLS.flat, number: 1, diameter: 8 }; const rt = TOOLS.flat;
const gen = (type, tool, extra = {}, regions) => generateToolpath({ type, name: type, tool, mesh, stock, regions, params: { ...defaultParamsFor(type, { stock, modelBounds: bounds, tool }), ...extra } });
const face = gen('face', ft);
const params = { ...defaultParamsFor('adaptive', { stock, modelBounds: bounds, tool: rt }) };
// the levels the app asks about (app/regions-ui.js): where the strategy starts, and adaptive's step-ups
const real = params;
const set = new Set(depthLevelsFor(real, mesh, rt));
const step = Math.round(Math.max(0, real.stepUp ?? 0) * rt.diameter * 1000) / 1000;
if (step > 0.05) for (const z of depthLevelsFor({ ...real, stepdown: step }, mesh, rt)) set.add(z);
const levels = [...set];
const cleared = clearedStack([{ cl: face, tool: ft }], levels, { tolerance: 0.01, stock });
const cl = generateToolpath({ type: 'adaptive', name: 'a', tool: rt, mesh, stock, params, regions: { include: [], avoid: [], cleared } });
const by = new Map(); let prev = null;
eachMove(cl, (op, x, y, z, i, j, k, feed) => { if (prev && op === OP.LINE && feed !== FEED.RAPID && Math.abs(z - prev[2]) < 1e-3) by.set(z.toFixed(1), (by.get(z.toFixed(1)) ?? 0) + Math.hypot(x - prev[0], y - prev[1])); prev = [x, y, z]; });
console.log('face bottom', params.bottomZ, 'stock top', stock.max[2], 'levels', levels.slice(0, 6).map((z) => z.toFixed(1)).join(','));
console.log('adaptive cut length by level after the face:', [...by].sort((a, b) => b[0] - a[0]).filter(([, l]) => l > 30).map(([k, l]) => `${k}:${l.toFixed(0)}`).join(' '));
