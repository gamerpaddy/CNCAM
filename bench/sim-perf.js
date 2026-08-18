// What the removal simulation costs, on programs and grids the app uses.
//
//   node bench/sim-perf.js
//
// A baseline to measure the next change against. The numbers below were taken
// on the sweep as it stands; the ones that matter are the ratios between grids,
// which should stay linear in the cell count, and the ratio to whatever a
// change makes them.

import { simulateRemoval } from '../src/engine/simulate.js';
import { generateToolpath } from '../src/engine/toolpath.js';
import { makeMushroom, makePocketBlock, makeStepped } from '../src/test/fixtures.js';

const FLAT = {
  number: 1, type: 'flat', diameter: 6, fluteLength: 20,
  spindleRpm: 10000, feedCut: 800, feedPlunge: 300,
};
const BALL = { ...FLAT, type: 'ball' };
const BULL = { ...FLAT, type: 'bull', cornerRadius: 1 };

function op(type, tool, mesh, stock, params) {
  return {
    cl: generateToolpath({
      type, name: type, tool, mesh, stock, params: { tolerance: 0.05, ...params },
    }),
    tool,
  };
}

// A whole job: rough the billet down, then finish the shape over it.
const { mesh } = makeMushroom();
const STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 15] };
const JOB = [
  op('clear2d', FLAT, mesh, STOCK, {
    topZ: 15, bottomZ: 0, stepdown: 1.5, stepover: 0.4, clearanceHeight: 25,
    stockToLeave: 0.3, rampAngle: 3, leadType: 'none',
  }),
  op('parallel3d', BALL, mesh, STOCK, {
    topZ: 15, bottomZ: 0, stepover: 0.3, clearanceHeight: 25, stockToLeave: 0, angle: 0,
  }),
  op('contour2d', BULL, mesh, STOCK, {
    topZ: 15, bottomZ: 0, stepdown: 1.5, clearanceHeight: 25,
    stockToLeave: 0, leadType: 'arc',
  }),
];

const { mesh: pocketMesh } = makePocketBlock();
const POCKET_STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] };
const POCKET = [
  op('pocket', FLAT, pocketMesh, POCKET_STOCK, {
    topZ: 10, bottomZ: 4, stepdown: 0.8, stepover: 0.35, clearanceHeight: 20,
    stockToLeave: 0, rampAngle: 3, leadType: 'none',
  }),
];

const { mesh: steppedMesh } = makeStepped();
const STEPPED_STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] };
const ADAPTIVE = [
  op('adaptive', FLAT, steppedMesh, STEPPED_STOCK, {
    topZ: 20, bottomZ: 0, stepdown: 4, stepover: 0.9, clearanceHeight: 30,
    stockToLeave: 0.2, rampAngle: 2, leadType: 'none',
  }),
];

const workloads = [
  { name: 'mushroom job (3 ops)', stock: STOCK, ops: JOB },
  { name: 'deep pocket', stock: POCKET_STOCK, ops: POCKET },
  { name: 'adaptive rough', stock: STEPPED_STOCK, ops: ADAPTIVE },
];

// the app's own quality names, from app/settings.js
const GRIDS = [['medium', 40_000], ['high', 120_000], ['ultra', 400_000]];

const RUNS = Number(process.env.RUNS || 5);
console.log(`best of ${RUNS}\n`);
const head = ['workload', 'grid', 'cells', 'moves', 'ms', 'events', 'µs/1k cells'];
const rows = [];
let total = 0;

for (const w of workloads) {
  const moves = w.ops.reduce((n, o) => n + o.cl.count, 0);
  for (const [name, cells] of GRIDS) {
    const args = { stock: w.stock, ops: w.ops, maxCells: cells };
    simulateRemoval(args);                       // warm the JIT before timing
    let ms = Infinity;
    let sim;
    for (let i = 0; i < RUNS; i++) {
      const t = process.hrtime.bigint();
      sim = simulateRemoval(args);
      const took = Number(process.hrtime.bigint() - t) / 1e6;
      if (took < ms) ms = took;
    }
    total += ms;
    const grid = sim.width * sim.height;
    rows.push([
      w.name, name, String(grid), String(moves), ms.toFixed(0),
      String(sim.eventCount), ((ms * 1000) / (grid / 1000)).toFixed(1),
    ]);
  }
}

const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r) => r.map((v, i) => (i <= 1 ? v.padEnd(widths[i]) : v.padStart(widths[i]))).join('  ');
console.log(line(head));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const r of rows) console.log(line(r));
console.log(`\ntotal ${total.toFixed(0)} ms`);
