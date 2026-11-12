// node bench/audit/field-check.mjs part tool — the waterline's drop-cutter field with and without run bounds: same values, how fast
import { loadPart, TOOLS } from './lib.js';
import { buildHeightmap, buildToolKernel, toolLocationField } from '../../src/geom/heightmap.js';
import { computeBounds } from '../../src/geom/mesh.js';
const part = loadPart(process.argv[2] ?? 'test-slope'); const tool = TOOLS[process.argv[3] ?? 'ball'];
const r = tool.diameter / 2; const box = computeBounds(part.mesh.positions);
const area = (box.max[0] - box.min[0] + 2 * r) * (box.max[1] - box.min[1] + 2 * r);
const cell = Math.max(0.01, ((area * Math.PI * r * r) / 2.5e9) ** 0.25); const pad = r + 3 * cell;
const map = buildHeightmap(part.mesh, { cellSize: cell, floor: box.min[2] - 1, bounds: { min: [box.min[0] - pad, box.min[1] - pad, box.min[2]], max: [box.max[0] + pad, box.max[1] + pad, box.max[2]] } });
const run = (opt) => { const k = buildToolKernel(tool, map.cellSize, opt); const t = performance.now(); const f = toolLocationField(map, k); return [f, performance.now() - t]; };
const [a, ta] = run({}); const [b, tb] = run({ segment: 17 });
let diff = 0; for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
console.log(`${process.argv[2]} ${map.width}x${map.height} cell ${cell.toFixed(3)}: rows ${ta.toFixed(0)}ms, runs ${tb.toFixed(0)}ms, max difference ${diff}`);
