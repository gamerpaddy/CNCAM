// How close the removal simulation is to the swept envelope, and what it costs.
//
//   node bench/sim-bench.js

import { simulateRemoval } from '../src/engine/simulate.js';
import { generateToolpath } from '../src/engine/toolpath.js';
import { CLBuilder, FEED } from '../src/engine/cl.js';
import { makeMushroom, makePocketBlock, makeStepped } from '../src/test/fixtures.js';
import { referenceSurface } from './ref.js';

const FLAT = {
  number: 1, type: 'flat', diameter: 6, fluteLength: 20,
  spindleRpm: 10000, feedCut: 800, feedPlunge: 300,
};
const BALL = { ...FLAT, type: 'ball' };
const BULL = { ...FLAT, type: 'bull', cornerRadius: 1 };
const VBIT = { ...FLAT, type: 'chamfer', diameter: 10, tipAngle: 90 };

function op(type, tool, mesh, stock, params) {
  const cl = generateToolpath({
    type, name: type, tool, mesh, stock, params: { tolerance: 0.05, ...params },
  });
  return { cl, tool };
}

// --- the cases ---------------------------------------------------------------

const cases = [];

// A shallow ramp entry: the case the three-point sweep is worst at, because the
// lowest point of a cell's contact is at the moment it leaves the cutter, not
// at the closest approach.
{
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(5, 20, 12);
  cl.cut(35, 20, 4, FEED.RAMP);      // 30mm along, 8mm down — a 15° ramp
  cases.push({
    name: 'ramp entry (flat 6mm)',
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] },
    ops: [{ cl: cl.finish(), tool: FLAT }],
  });
}

// The same, steeper, with a ball nose — a plunge-ramp into a 3D surface.
{
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(5, 20, 12);
  cl.cut(15, 20, 2, FEED.RAMP);      // 10mm along, 8mm down
  cl.cut(35, 20, 2);
  cl.cut(38, 20, 9, FEED.RAMP);      // and back out
  cases.push({
    name: 'steep ramp (ball 6mm)',
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] },
    ops: [{ cl: cl.finish(), tool: BALL }],
  });
}

// A helix, which is a ramp that also turns — every cell sees a curved sweep.
{
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(20, 20, 12);
  const R = 5;
  for (let i = 0; i <= 96; i++) {
    const a = (i / 24) * Math.PI * 2;
    const z = 10 - (i / 96) * 8;
    cl.cut(20 + R * Math.cos(a), 20 + R * Math.sin(a), z, FEED.RAMP);
  }
  cases.push({
    name: 'helical entry (flat 6mm)',
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] },
    ops: [{ cl: cl.finish(), tool: FLAT }],
  });
}

// A real 3D finishing pass over a curved part.
{
  const { mesh } = makeMushroom();
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 15] };
  cases.push({
    name: 'parallel3d finish (ball 6mm)',
    stock,
    ops: [op('parallel3d', BALL, mesh, stock, {
      topZ: 15, bottomZ: 0, stepover: 1.0, clearanceHeight: 25,
      stockToLeave: 0, angle: 0,
    })],
  });
}

// A real roughing pass — lots of straight, level cuts.
{
  const { mesh } = makeMushroom();
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 15] };
  cases.push({
    name: 'clear2d rough (flat 6mm)',
    stock,
    ops: [op('clear2d', FLAT, mesh, stock, {
      topZ: 15, bottomZ: 0, stepdown: 3, stepover: 0.5, clearanceHeight: 25,
      stockToLeave: 0, rampAngle: 0, leadType: 'none',
    })],
  });
}

// A bull nose, whose profile is neither flat nor a sphere.
{
  const { mesh } = makeStepped();
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] };
  cases.push({
    name: 'contour (bull 6mm r1)',
    stock,
    ops: [op('contour2d', BULL, mesh, stock, {
      topZ: 20, bottomZ: 0, stepdown: 4, clearanceHeight: 30,
      stockToLeave: 0, leadType: 'none',
    })],
  });
}

// A V bit, whose profile is a cone: the steepest slope any tool has.
{
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(5, 20, 12);
  cl.cut(5, 20, 9.5, FEED.PLUNGE);
  cl.cut(35, 20, 9.5);
  cl.cut(35, 25, 8.5, FEED.RAMP);
  cl.cut(5, 25, 8.5);
  cases.push({
    name: 'engrave (90 V 10mm)',
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] },
    ops: [{ cl: cl.finish(), tool: VBIT }],
  });
}

// A 3D pass over a curved part with a bull nose — a profile that is flat in the
// middle and a torus at the edge, so neither special case covers it.
{
  const { mesh } = makeMushroom();
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 15] };
  cases.push({
    name: 'parallel3d finish (bull 6mm r1)',
    stock,
    ops: [op('parallel3d', BULL, mesh, stock, {
      topZ: 15, bottomZ: 0, stepover: 1.0, clearanceHeight: 25,
      stockToLeave: 0, angle: 0,
    })],
  });
}

// A plunge straight down, then out: nothing linear about the deepest contact.
{
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(20, 20, 12);
  cl.cut(20, 20, 3, FEED.PLUNGE);
  cl.cut(30, 20, 3);
  cl.cut(30, 30, 11, FEED.RAMP);     // straight up and out of the metal
  cases.push({
    name: 'plunge and exit (ball 6mm)',
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] },
    ops: [{ cl: cl.finish(), tool: BALL }],
  });
}

// A pocket, which is where the ramp entries and the corner links live together.
{
  const { mesh } = makePocketBlock();
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] };
  cases.push({
    name: 'pocket (flat 6mm, ramped)',
    stock,
    ops: [op('pocket', FLAT, mesh, stock, {
      topZ: 10, bottomZ: 4, stepdown: 2, stepover: 0.45, clearanceHeight: 20,
      stockToLeave: 0, rampAngle: 3, leadType: 'none',
    })],
  });
}

// --- running -----------------------------------------------------------------

const MAX_CELLS = Number(process.env.CELLS || 40000);

function stats(sim, { heights: truth, grazed }) {
  const pb = replay(sim);
  let under = 0; let overcut = 0; let sum = 0; let n = 0; let skipped = 0;
  let worstCell = -1;
  for (let k = 0; k < truth.length; k++) {
    if (sim.mask[k] === 0) continue;
    // a cell the cutter only grazes is a contact of zero width; see ref.js
    if (Math.abs(truth[k] - grazed[k]) > 1e-5) { skipped++; continue; }
    const e = pb[k] - truth[k];              // + means material left that should be gone
    if (e > under) { under = e; worstCell = k; }
    if (-e > overcut) overcut = -e;
    sum += Math.abs(e); n++;
  }
  return { mean: sum / n, under, overcut, skipped, worstCell };
}

/** Final surface of a record, by applying every event. */
function replay(sim) {
  const out = sim.initial.slice();
  for (let i = 0; i < sim.eventCount; i++) out[sim.evCell[i]] = sim.evHeight[i];
  return out;
}

function time(fn, runs = 3) {
  let best = Infinity;
  let value;
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    value = fn();
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    if (ms < best) best = ms;
  }
  return { ms: best, value };
}

console.log(`grid budget ${MAX_CELLS} cells\n`);
const head = ['case', 'moves', 'steps', 'events', 'ms', 'mean err', 'undercut', 'overcut', 'grazed'];
const rows = [];
let totalMs = 0;
let worstAll = 0;
let meanAll = 0;
for (const c of cases) {
  const { ms, value: sim } = time(() => simulateRemoval({
    stock: c.stock, ops: c.ops, maxCells: MAX_CELLS,
  }));
  const truth = referenceSurface({
    stock: c.stock,
    ops: c.ops,
    width: sim.width,
    height: sim.height,
    cellSize: sim.cellSize,
    origin: sim.origin,
    mask: sim.mask,
  });
  const s = stats(sim, truth);
  const moves = c.ops.reduce((n, o) => n + o.cl.count, 0);
  rows.push([
    c.name, String(moves), String(sim.stepCount), String(sim.eventCount),
    ms.toFixed(1), s.mean.toFixed(5), s.under.toFixed(4), s.overcut.toFixed(4),
    String(s.skipped),
  ]);
  totalMs += ms;
  worstAll = Math.max(worstAll, s.under);
  meanAll += s.mean;
}

const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r) => r.map((v, i) => (i === 0 ? v.padEnd(widths[i]) : v.padStart(widths[i]))).join('  ');
console.log(line(head));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const r of rows) console.log(line(r));
console.log(`\ntotal ${totalMs.toFixed(1)} ms   worst undercut ${worstAll.toFixed(4)} mm   `
  + `mean of means ${(meanAll / rows.length).toFixed(5)} mm`);
