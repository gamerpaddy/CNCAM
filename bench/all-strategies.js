// Every milling strategy, against the envelope its own cutter really sweeps.
//
//   node bench/all-strategies.js
//
// The hand-written cases in sim-bench.js are the ones I thought to write. This
// runs the real generators instead, so a tool shape or a move pattern nobody
// thought of still gets measured.

import { simulateRemoval } from '../src/engine/simulate.js';
import { generateToolpath, MILLING_OPS } from '../src/engine/toolpath.js';
import { defaultParamsFor } from '../src/engine/op-defaults.js';
import { MOVE_STRIDE, OP } from '../src/engine/cl.js';
import { clearanceProfile, cuttingRadiusOf } from '../src/engine/tool-geometry.js';
import { makePocketAndHole, makeStepped, makeMushroom } from '../src/test/fixtures.js';

const TOOLS = {
  flat: { number: 1, type: 'flat', diameter: 6, fluteLength: 24, flutes: 3, spindleRpm: 9000, feedCut: 800, feedPlunge: 300 },
  ball: { number: 2, type: 'ball', diameter: 6, fluteLength: 24, flutes: 2, spindleRpm: 9000, feedCut: 800, feedPlunge: 300 },
  bull: { number: 3, type: 'bull', diameter: 8, cornerRadius: 1.5, fluteLength: 24, flutes: 3, spindleRpm: 8000, feedCut: 700, feedPlunge: 250 },
  drill: { number: 4, type: 'drill', diameter: 6, tipAngle: 118, fluteLength: 40, flutes: 2, spindleRpm: 3000, feedCut: 200, feedPlunge: 200 },
  chamfer: { number: 5, type: 'chamfer', diameter: 10, tipAngle: 90, fluteLength: 12, flutes: 4, spindleRpm: 9000, feedCut: 600, feedPlunge: 200 },
  vbit: { number: 6, type: 'chamfer', diameter: 3.175, tipAngle: 60, tipDiameter: 0.2, fluteLength: 8, flutes: 1, spindleRpm: 16000, feedCut: 400, feedPlunge: 150 },
  small: { number: 8, type: 'flat', diameter: 4, fluteLength: 20, flutes: 3, spindleRpm: 11000, feedCut: 600, feedPlunge: 250 },
  face: { number: 7, type: 'face', diameter: 25, flutes: 4, fluteLength: 10, spindleRpm: 4000, feedCut: 1200, feedPlunge: 300 },
};

// Which cutter each strategy is naturally run with. A face mill down a pocket
// or a drill following a contour is not a case worth measuring.
const FOR = {
  face: ['face', 'flat'],
  contour2d: ['flat', 'bull', 'ball'],
  pocket: ['flat', 'bull'],
  clear2d: ['flat', 'bull'],
  adaptive: ['flat', 'bull'],
  slot: ['flat', 'ball'],
  drill: ['drill'],
  bore: ['small'],
  chamfer: ['chamfer', 'vbit'],
  engrave: ['vbit'],
  parallel3d: ['ball', 'bull', 'flat'],
  waterline: ['ball', 'bull'],
};

/** The billet that actually contains a part, with a little to face off the top. */
function boundsOf(mesh) {
  const p = mesh.positions ?? mesh.vertices ?? mesh;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return { min, max };
}

const PARTS = {
  'pocket+hole': makePocketAndHole(),
  stepped: makeStepped(),
  mushroom: makeMushroom(),
};

/**
 * The lowest the tool's surface ever gets above (x, y), by brute force —
 * answered twice, with a cutter a micron under and a micron over.
 *
 * A path running exactly one cutter radius from a cell is tangent to the sweep:
 * a contact of zero width, which floating point resolves either way. Toolpaths
 * do this deliberately and constantly — a contour is *offset by the radius*, so
 * every cell along the finished wall is one of these. Where the two answers
 * differ there is nothing to measure, and comparing against either alone
 * reports the whole length of a wall as a disagreement.
 */
const GRAZE = 1e-6;

function envelopeAt(ops, x, y) {
  let lowest = Infinity;
  let tight = Infinity;
  for (const { cl, tool } of ops) {
    const profile = clearanceProfile(tool);
    const radius = cuttingRadiusOf(tool) + GRAZE;
    const inner = radius - 2 * GRAZE;
    const d = cl.moves;
    let prev = null;
    for (let n = 0; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      let a; let b;
      if (d[o] === OP.DRILL) {
        a = [d[o + 1], d[o + 2], d[o + 4]];
        b = [d[o + 1], d[o + 2], d[o + 3]];
        prev = b;
      } else {
        const p = [d[o + 1], d[o + 2], d[o + 3]];
        if (!prev) { prev = p; continue; }
        a = prev; b = p; prev = p;
      }
      const span = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const steps = Math.max(1, Math.ceil(span / 0.02));
      // The closest approach, solved rather than sampled, and evaluated on top
      // of the uniform walk. Stepping every 0.02mm puts the nearest sample up to
      // 0.01mm to one side of it, which reads the minimum distance a shade too
      // high — and a toolpath offset by exactly the cutter radius sits *on* that
      // shade. Without this the reference reports a finished wall as untouched.
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const uu = ux * ux + uy * uy;
      const nearest = uu > 1e-12
        ? Math.max(0, Math.min(1, ((x - a[0]) * ux + (y - a[1]) * uy) / uu))
        : -1;
      for (let s = 0; s <= steps + 1; s++) {
        const t = s <= steps ? s / steps : nearest;
        if (t < 0) continue;
        const dist = Math.hypot(a[0] + ux * t - x, a[1] + uy * t - y);
        if (dist > radius) continue;
        const z = a[2] + (b[2] - a[2]) * t + profile(dist);
        if (z < lowest) lowest = z;
        if (dist <= inner && z < tight) tight = z;
      }
    }
  }
  return { lowest, grazed: Math.abs(lowest - tight) > 1e-5 };
}

const rows = [];
let worstAll = 0;
let worstCase = '';

for (const [partName, part] of Object.entries(PARTS)) {
  const bounds = boundsOf(part.mesh);
  const stock = {
    kind: 'box',
    min: [bounds.min[0], bounds.min[1], bounds.min[2]],
    max: [bounds.max[0], bounds.max[1], bounds.max[2] + 1],
  };
  for (const type of MILLING_OPS) {
    for (const toolName of FOR[type] ?? []) {
      const tool = TOOLS[toolName];
      let cl;
      try {
        cl = generateToolpath({
          type, name: type, tool, mesh: part.mesh, stock,
          params: defaultParamsFor(type, { stock, modelBounds: bounds, tool }),
        });
      } catch (err) {
        rows.push([`${partName}/${type}/${toolName}`, '—', '—', `error: ${err.message}`]);
        continue;
      }
      if (!cl || cl.count === 0) continue;
      const ops = [{ cl, tool }];
      const sim = simulateRemoval({ stock, ops, maxCells: 25_000 });
      if (sim.eventCount === 0) continue;
      const surface = sim.initial.slice();
      for (let i = 0; i < sim.eventCount; i++) surface[sim.evCell[i]] = sim.evHeight[i];

      // Every fortieth cell that actually got cut — enough coverage to catch a
      // whole-surface error, few enough that the brute force finishes.
      let worst = 0;
      let checked = 0;
      let skipped = 0;
      let at = null;
      for (let k = 0; k < surface.length; k += 37) {
        if (sim.mask[k] === 0 || surface[k] >= sim.initial[k] - 1e-6) continue;
        const i = k % sim.width;
        const j = (k - i) / sim.width;
        const x = sim.origin[0] + i * sim.cellSize;
        const y = sim.origin[1] + j * sim.cellSize;
        const { lowest: want, grazed } = envelopeAt(ops, x, y);
        if (!Number.isFinite(want)) continue;
        if (grazed) { skipped++; continue; }   // a contact of zero width
        checked++;
        const e = Math.abs(surface[k] - want);
        if (e > worst) { worst = e; at = [+x.toFixed(2), +y.toFixed(2)]; }
      }
      if (checked === 0) continue;
      const label = `${partName}/${type}/${toolName}`;
      rows.push([label, String(cl.count), `${checked}+${skipped}`,
        worst.toFixed(4) + (at ? ` at ${at}` : '')]);
      if (worst > worstAll) { worstAll = worst; worstCase = label; }
    }
  }
}

const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) {
  console.log(`${r[0].padEnd(widths[0])}  ${r[1].padStart(widths[1])} moves  `
    + `${r[2].padStart(widths[2])} probes   ${r[3]}`);
}
console.log(`\nworst disagreement with the swept envelope: ${worstAll.toFixed(4)} mm  (${worstCase})`);
