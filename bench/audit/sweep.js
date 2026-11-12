// See lib.js for the measurement; this is the table.
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

import { defaultParamsFor } from '../../src/engine/op-defaults.js';
import { MILLING_OPS } from '../../src/engine/toolpath.js';
import { cuttingRadiusOf } from '../../src/engine/tool-geometry.js';
import { TOOLS, FOR, PARTS, Material, measure, loadPart, generate } from './lib.js';

const FINISHERS = new Set(['contour2d', 'parallel3d', 'pencil', 'scallop', 'waterline', 'chamfer', 'engrave']);
const ROUGH_TOOL = TOOLS.flat;

const args = process.argv.slice(2);
const wantParts = args.find((a) => a.startsWith('--part='))?.slice(7).split(',') ?? PARTS;
const wantOps = args.filter((a) => !a.startsWith('--'));
const EXTRA = {};
for (const a of args.filter((x) => x.startsWith('--set='))) { const [k, v] = a.slice(6).split('='); EXTRA[k] = isNaN(+v) ? v : +v; }

function report(label, gen, cl, r) {
  console.log(
    `${label.padEnd(44)} gen ${gen.toFixed(2).padStart(6)}s  moves ${String(cl.count).padStart(6)}`
    + `  cut ${r.cutMin.toFixed(2).padStart(6)}m  rapid ${r.rapidMin.toFixed(2).padStart(5)}m`
    + `  air ${(100 * r.airLen / Math.max(1e-9, r.cutLen)).toFixed(0).padStart(3)}%`
    + `  w95 ${r.w95.toFixed(2)}  wMax ${r.wMax.toFixed(2)}  deep ${r.deep.toFixed(1)}`
    + `  area99/max ${r.area99.toFixed(1)}/${r.areaMax.toFixed(1)}mm2`
    + `  heavy ${r.heavy.toFixed(0)}/${r.buried.toFixed(0)}mm`
    + `  crash ${r.crash.toFixed(2)}/${r.crashes}  lifts ${r.lifts}`
    + `  ap ${(r.depthSum / Math.max(1e-9, r.depthLen)).toFixed(1)}  mrr ${(r.volume / Math.max(1e-9, r.cutMin + r.rapidMin)).toFixed(0)}`
    + `  vol ${r.volume.toFixed(0)}  rapid/cut ${(r.rapidMin / Math.max(1e-9, r.cutMin)).toFixed(2)}`,
  );
  if (process.argv.includes('--air')) { const runs = r.airRuns.sort((a, b) => b - a); console.log('   air by feed class', JSON.stringify([...r.airByFeed]), 'runs>30mm', runs.filter((x) => x > 30).length, 'sum', runs.filter((x) => x > 30).reduce((a, b) => a + b, 0).toFixed(0), 'top', runs.slice(0, 5).map((x) => x.toFixed(0)).join(',')); console.log('   max chip area at', JSON.stringify(r.areaAt)); }
  if (process.argv.includes('--air')) console.log('   air by Z:', [...r.airByZ].sort((a, b) => b[0] - a[0]).filter(([, l]) => l > 20).map(([z, l]) => `${z}:${l.toFixed(0)}`).join(' '));
  if (process.argv.includes('--heavy')) console.log('   heavy by Z:', [...r.heavyByZ].sort((a, b) => b[0] - a[0]).filter(([, l]) => l > 8).map(([z, l]) => `${z}:${l.toFixed(0)}`).join(' '));
  if (process.argv.includes('--heavy') && r.heavyAt) console.log('   widest bite at', JSON.stringify(r.heavyAt));
  if (r.deepAt && r.deep > 3) console.log('   deepest full-width cut at', JSON.stringify(r.deepAt));
  if (r.crashAt.length) console.log('   crashes (from->to, depth):', JSON.stringify(r.crashAt));
}

for (const partName of wantParts) {
  const part = loadPart(partName);
  const { stock } = part;
  // the material after a roughing pass, which every finisher is measured on
  let rough = null;
  let roughGen = 0;
  const needRough = () => {
    if (rough) return rough;
    const g = generate('adaptive', ROUGH_TOOL, part);
    roughGen = g.gen;
    const m = new Material(stock, Math.max(0.15, cuttingRadiusOf(TOOLS.pencil) / 10));
    measure(g.cl, ROUGH_TOOL, stock, m);
    rough = m;
    return m;
  };
  for (const type of MILLING_OPS) {
    if (wantOps.length && !wantOps.includes(type)) continue;
    for (const toolName of FOR[type] ?? []) {
      const tool = TOOLS[toolName];
      const label = `${partName}/${type}/${toolName}`;
      let g;
      try {
        // as the app does: a finishing pass is told what the rough ahead of it was
        const earlier = FINISHERS.has(type)
          ? [{ type: 'adaptive', tool: ROUGH_TOOL, params: defaultParamsFor('adaptive', { stock, modelBounds: part.bounds, tool: ROUGH_TOOL }) }]
          : undefined;
        g = generate(type, tool, part, EXTRA, earlier);
      } catch (err) {
        console.log(`${label.padEnd(44)} error: ${err.message}`);
        continue;
      }
      if (!g.cl || g.cl.count === 0) continue;
      let material = null;
      if (FINISHERS.has(type)) {
        const base = needRough();
        material = new Material(stock, base.cell);
        material.top.set(base.top);
      }
      const r = measure(g.cl, tool, stock, material);
      report(label + (material ? ' (after rough)' : ''), g.gen, g.cl, r);
    }
  }
}
