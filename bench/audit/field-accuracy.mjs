// node bench/audit/field-accuracy.mjs part tool — the waterline drop-cutter field at several budgets against a fine reference:
// how far the tool height it reports is from the truth, in mm, and how long it takes
import { loadPart, TOOLS } from './lib.js';
import { buildHeightmap, buildToolKernel, toolLocationField } from '../../src/geom/heightmap.js';
import { computeBounds } from '../../src/geom/mesh.js';
const part = loadPart(process.argv[2] ?? 'test-slope'); const tool = TOOLS[process.argv[3] ?? 'ball'];
const r = tool.diameter / 2; const box = computeBounds(part.mesh.positions);
const area = (box.max[0] - box.min[0] + 2 * r) * (box.max[1] - box.min[1] + 2 * r);
const make = (cell) => { const pad = r + 3 * cell; const map = buildHeightmap(part.mesh, { cellSize: cell, floor: box.min[2] - 1, bounds: { min: [box.min[0] - pad, box.min[1] - pad, box.min[2]], max: [box.max[0] + pad, box.max[1] + pad, box.max[2]] } }); const t = performance.now(); const f = toolLocationField(map, buildToolKernel(tool, cell, { segment: 17 })); return { map, f, ms: performance.now() - t, cell }; };
const ref = make(0.05);
const at = (m, x, y) => { const i = Math.round((x - m.map.min[0]) / m.cell), j = Math.round((y - m.map.min[1]) / m.cell); return m.f[j * m.map.width + i]; };
for (const budget of [2.5e9, 1.5e9, 1.0e9, 0.6e9]) {
  const cell = ((area * Math.PI * r * r) / budget) ** 0.25; const m = make(cell);
  const errs = [];
  for (let k = 0; k < 20000; k++) { const x = box.min[0] + 2 + Math.random() * (box.max[0] - box.min[0] - 4), y = box.min[1] + 2 + Math.random() * (box.max[1] - box.min[1] - 4); const a = at(ref, x, y), b = at(m, x, y); if (a > box.min[2] - 0.5) errs.push(b - a); }
  const abs = errs.map(Math.abs).sort((p, q) => p - q); const pct = (p) => abs[Math.floor(abs.length * p)];
  const low = errs.filter((e) => e < -0.02).length / errs.length;
  console.log(`budget ${budget.toExponential(1)} cell ${cell.toFixed(3)}: ${m.ms.toFixed(0)} ms, error median ${pct(0.5).toFixed(3)} p95 ${pct(0.95).toFixed(3)} max ${abs.at(-1).toFixed(3)} mm; reports the tool too low by >0.02 at ${(100 * low).toFixed(1)}% of points`);
}
