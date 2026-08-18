// How close the turning simulation is to the envelope the insert really sweeps.
//
//   node bench/turn-bench.js
//
// Same idea as sim-bench.js one dimension down: the nose is a circle rolled
// along the path in the (radius, Z) plane, and the reference finds the lowest
// radius it reaches over every Z sample by brute force.

import { simulateTurning } from '../src/engine/simulate.js';
import { generateToolpath } from '../src/engine/toolpath.js';
import { CLBuilder, FEED, MOVE_STRIDE, OP } from '../src/engine/cl.js';
import { makeShaft } from '../src/test/fixtures.js';

const SAMPLES = 3000;

const ROUGH = { number: 1, type: 'turning', noseRadius: 0.8, diameter: 12, feedCut: 150 };
const FINISH = { number: 2, type: 'turning', noseRadius: 0.4, diameter: 12, feedCut: 80 };

/** The outer surface, by brute force over each move. */
function reference(bar, ops, count) {
  const { zMin, zMax } = bar;
  const dz = (zMax - zMin) / (count - 1);
  const out = new Float32Array(count).fill(bar.radius);

  for (const { cl, tool } of ops) {
    const nose = Math.max(0, tool?.noseRadius ?? 0);
    if (!(nose > 0)) continue;
    const d = cl.moves;
    let prev = null;
    for (let n = 0; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      if (d[o] === OP.DRILL) continue;
      const p = [d[o + 1], d[o + 3]];
      if (!prev) { prev = p; continue; }
      roll(out, prev, p, nose, zMin, dz, count);
      prev = p;
    }
  }
  return out;
}

function roll(out, p0, p1, nose, zMin, dz, count) {
  const dr = p1[0] - p0[0];
  const dZ = p1[1] - p0[1];
  const lo = Math.min(p0[1], p1[1]) - nose;
  const hi = Math.max(p0[1], p1[1]) + nose;
  const i0 = Math.max(0, Math.floor((lo - zMin) / dz));
  const i1 = Math.min(count - 1, Math.ceil((hi - zMin) / dz));
  for (let i = i0; i <= i1; i++) {
    const zi = zMin + i * dz;
    let lowest = out[i];
    for (let s = 0; s <= SAMPLES; s++) {
      const t = s / SAMPLES;
      const e = zi - (p0[1] + dZ * t);
      if (e <= -nose || e >= nose) continue;
      const v = p0[0] + dr * t - Math.sqrt(nose * nose - e * e);
      if (v < lowest) lowest = v;
    }
    out[i] = lowest;
  }
}

// --- a real turning program --------------------------------------------------

const shaft = makeShaft();
const bar = { radius: 18, innerRadius: 0, zMin: 0, zMax: 60 };
const stock = {
  kind: 'cylinder',
  min: [-18, -18, 0],
  max: [18, 18, 60],
  cylinder: { diameter: 36, height: 60, center: [0, 0], baseZ: 0 },
};

function op(type, tool, params) {
  return {
    cl: generateToolpath({
      type, name: type, tool, mesh: shaft.mesh, stock,
      params,
    }),
    tool,
  };
}

const base = {
  topZ: 60, bottomZ: 0, clearanceX: 0, clearanceHeight: 50, entryGap: 1,
  tolerance: 0.02, stockToLeave: 0, stepdown: 2, peck: 0,
  faceToRadius: 0, partOffRadius: 0,
};
const ops = [
  op('turnRough', ROUGH, { ...base, stepdown: 1.5, stockToLeave: 0.3 }),
  op('turnFinish', FINISH, { ...base }),
];

const moves = ops.reduce((n, o) => n + o.cl.count, 0);
console.log(`${moves} moves over a Ø36 bar\n`);

const head = ['samples', 'steps', 'events', 'ms', 'mean err', 'undercut', 'overcut'];
const rows = [];
for (const samples of [400, 800, 1600, 3200]) {
  let ms = Infinity;
  let sim;
  for (let i = 0; i < 3; i++) {
    const t = process.hrtime.bigint();
    sim = simulateTurning({ bar, ops, samples });
    const took = Number(process.hrtime.bigint() - t) / 1e6;
    if (took < ms) ms = took;
  }
  const truth = reference(bar, ops, sim.count);
  const surface = sim.initial.slice();
  for (let i = 0; i < sim.eventCount; i++) surface[sim.evCell[i]] = sim.evHeight[i];

  let under = 0; let over = 0; let sum = 0; let n = 0;
  for (let i = 0; i < sim.count; i++) {
    const e = surface[i] - truth[i];        // + means metal left that should be gone
    if (e > under) under = e;
    if (-e > over) over = -e;
    sum += Math.abs(e); n++;
  }
  rows.push([
    String(samples), String(sim.stepCount), String(sim.eventCount), ms.toFixed(1),
    (sum / n).toFixed(5), under.toFixed(4), over.toFixed(4),
  ]);
}

const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r) => r.map((v, i) => v.padStart(widths[i])).join('  ');
console.log(line(head));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const r of rows) console.log(line(r));
