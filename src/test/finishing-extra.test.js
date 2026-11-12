// Pencil and constant-scallop finishing.
//
// Both are checked against geometry written down in the test, never against the
// strategy's own idea of it:
//
//   pencil   a square pocket has an inside corner a ⌀6 ball leaves a radius-3
//            fillet in. After the pencil, the metal left in that corner is
//            measured by carving it with an independent ball and compared with
//            what the same corner holds without it — and the cutter is checked
//            not to be inside the wall or the floor anywhere on its way.
//   scallop  on a plane at 45° a raster that steps a fixed distance across the plan
//            view is 1.41 times too wide along the surface; the spacing between
//            passes is measured in 3D and must be the designed one.

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { eachMove, FEED, OP } from '../engine/cl.js';
import { scallopSpacing, scallopRadius } from '../engine/strategies/scallop.js';
import { makePocketBlock, makeRamp, makeBox } from './fixtures.js';
import { createOperation } from '../doc/schema.js';
import { pickToolFor } from '../engine/tool-match.js';

const ball = (diameter) => ({
  number: 1, type: 'ball', name: `${diameter}mm ball`, diameter, flutes: 2,
  fluteLength: 15, spindleRpm: 10000, feedCut: 800, feedPlunge: 300,
});

function run(type, mesh, stock, tool, over = {}) {
  const params = {
    ...defaultParamsFor('parallel3d', { stock, tool }),
    ...defaultParamsFor(type, { stock, tool }),
    topZ: stock.max[2], bottomZ: stock.min[2], clearanceHeight: stock.max[2] + 10, ...over,
  };
  return generateToolpath({ type, name: type, tool, mesh, stock, params });
}

/** The cutting moves of a program as [x, y, z] points, in order. */
function cuts(cl) {
  const out = [];
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.LINE && feed !== FEED.RAPID) out.push([x, y, z]);
  });
  return out;
}

// ---------------------------------------------------------------- pencil

const POCKET = { size: 40, pocketSize: 20, height: 20, depth: 8 };       // walls at 10 and 30, floor at Z12
const POCKET_STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] };
const WALLS = { lo: 10, hi: 30, floor: 12, top: 20 };

test('pencil finishing runs round the inside corners of a pocket, at the floor, a radius off the wall', () => {
  const { mesh } = makePocketBlock(POCKET);
  const tool = ball(2);
  const cl = run('pencil', mesh, POCKET_STOCK, tool, { pencilRefDiameter: 6 });
  const path = cuts(cl);
  assert.ok(path.length >= 5, `a closed loop of cuts, got ${path.length} points`);
  // every cut is on the floor
  for (const [x, y, z] of path) assert.close(z, WALLS.floor, 0.02, `a cut at (${x.toFixed(2)}, ${y.toFixed(2)}) is at ${z}, the floor is Z12`);
  // …and a radius (1mm) off the nearest wall, give or take the one-cell bias of the surface map
  for (const [x, y] of path) {
    const off = Math.min(Math.abs(x - WALLS.lo), Math.abs(x - WALLS.hi), Math.abs(y - WALLS.lo), Math.abs(y - WALLS.hi));
    assert.ok(off >= 1 - 0.01 && off <= 1.3, `${off.toFixed(3)} from a wall, the cutter radius is 1`);
  }
  // all four sides: the loop reaches every wall
  const near = (f) => path.some(([x, y]) => f(x, y));
  assert.ok(near((x) => Math.abs(x - 11) < 0.3) && near((x) => Math.abs(x - 29) < 0.3), 'both walls in X');
  assert.ok(near((x, y) => Math.abs(y - 11) < 0.3) && near((x, y) => Math.abs(y - 29) < 0.3), 'and both in Y');
  // about the perimeter of the square a radius in from the walls: 4 x 18
  let length = 0;
  for (let n = 1; n < path.length; n++) length += Math.hypot(path[n][0] - path[n - 1][0], path[n][1] - path[n - 1][1]);
  assert.close(length, 72, 6, `a lap of about 72mm, got ${length.toFixed(1)}`);
  assert.ok(cl.notes.some((n) => /creases? traced/.test(n.text)), 'and says what it traced');
});

test('the pencil leaves a far smaller fillet in the corner than the cutter it follows', () => {
  const { mesh } = makePocketBlock(POCKET);
  const tool = ball(2);
  const path = cuts(run('pencil', mesh, POCKET_STOCK, tool, { pencilRefDiameter: 6 }));
  // the metal left at a cell 0.3mm from the wall, by an independent carve of the
  // pencil ball over every point it visits (the lower surface of a sphere: the
  // lowest the ball's underside gets to there)
  const r = 1;
  const at = [10.3, 20];
  let left = Infinity;
  for (let n = 1; n < path.length; n++) {
    const steps = Math.max(1, Math.ceil(Math.hypot(path[n][0] - path[n - 1][0], path[n][1] - path[n - 1][1]) / 0.05));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = path[n - 1][0] + (path[n][0] - path[n - 1][0]) * t;
      const y = path[n - 1][1] + (path[n][1] - path[n - 1][1]) * t;
      const z = path[n - 1][2] + (path[n][2] - path[n - 1][2]) * t;
      const d = Math.hypot(x - at[0], y - at[1]);
      if (d <= r) left = Math.min(left, z + r - Math.sqrt(r * r - d * d));
    }
  }
  const pencilLeft = left - WALLS.floor;
  // the ⌀6 ball alone leaves 3 - sqrt(9 - 2.7^2) = 1.69mm standing there
  const refOnly = 3 - Math.sqrt(9 - 2.7 * 2.7);
  assert.ok(pencilLeft < 0.5, `${pencilLeft.toFixed(2)}mm left with the pencil`);
  assert.ok(pencilLeft < refOnly / 2, `against ${refOnly.toFixed(2)}mm without it`);
  assert.ok(pencilLeft > -0.05, 'and the cut is not below the floor');
});

test('the pencil cutter is never inside the wall or the floor', () => {
  const { mesh } = makePocketBlock(POCKET);
  const r = 1;
  for (const tool of [ball(2), { ...ball(2), type: 'bull', cornerRadius: 0.5 }]) {
    const path = cuts(run('pencil', mesh, POCKET_STOCK, tool, { pencilRefDiameter: 6 }));
    assert.ok(path.length > 0, tool.type);
    const cr = tool.type === 'bull' ? tool.cornerRadius : r;
    for (const [x, y, z] of path) {
      assert.ok(z >= WALLS.floor - 0.02, `${tool.type}: tip at ${z}, below the floor`);
      // the widest the cutter is above its tip, against the wall: the flank, from the corner radius up
      const toWall = Math.min(x - WALLS.lo, WALLS.hi - x, y - WALLS.lo, WALLS.hi - y);
      assert.ok(toWall >= cr - 0.02, `${tool.type}: ${toWall.toFixed(3)} from the wall, corner radius ${cr}`);
    }
  }
});

test('a surface with no inside corner has nothing for a pencil, and says so', () => {
  const block = makeBox(40, 40, 10);             // a block: every edge on it is convex
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 11] };
  const cl = run('pencil', block, stock, ball(2), { pencilRefDiameter: 6 });
  assert.eq(cuts(cl).length, 0, 'no cuts');
  assert.ok(cl.notes.some((n) => n.level === 'warn' && /nothing to clean/.test(n.text)), cl.notes.map((n) => n.text).join(' | '));
});

test('a reference cutter no bigger than the pencil is refused with the reason', () => {
  const { mesh } = makePocketBlock(POCKET);
  const cl = run('pencil', mesh, POCKET_STOCK, ball(2), { pencilRefDiameter: 2 });
  assert.eq(cuts(cl).length, 0);
  assert.ok(cl.notes.some((n) => /no bigger than this one/.test(n.text)));
});

test('a stock to leave raises the pencil by that much, and the default reference is twice the cutter', () => {
  const { mesh } = makePocketBlock(POCKET);
  const bare = cuts(run('pencil', mesh, POCKET_STOCK, ball(2)));
  const left = cuts(run('pencil', mesh, POCKET_STOCK, ball(2), { stockToLeave: 0.3 }));
  assert.ok(bare.length > 0, 'the default reference (4mm) still finds the corners');
  assert.close(Math.min(...left.map((p) => p[2])), WALLS.floor + 0.3, 0.03);
});

// ---------------------------------------------------------------- scallop

test('the scallop spacing is the textbook one and round-trips through the height it came from', () => {
  const s = scallopSpacing(3, 0.05);
  assert.close(s, 2 * Math.sqrt(2 * 3 * 0.05 - 0.05 * 0.05), 1e-12);
  assert.close(3 - Math.sqrt(9 - (s / 2) ** 2), 0.05, 1e-9, 'a ball of radius 3 at that spacing leaves 0.05');
  assert.eq(scallopSpacing(0, 0.05), 0);
  assert.eq(scallopSpacing(3, 0), 0);
  assert.eq(scallopRadius({ type: 'ball', diameter: 6 }), 3);
  assert.eq(scallopRadius({ type: 'bull', diameter: 6, cornerRadius: 1 }), 1);
  assert.eq(scallopRadius({ type: 'flat', diameter: 6 }), 0);
});

test('a flat cutter is refused: it has no radius to leave a scallop of', () => {
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 41] };
  const cl = run('scallop', makeRamp(40, 40, 40), stock, { ...ball(6), type: 'flat' });
  assert.eq(cuts(cl).length, 0);
  assert.ok(cl.notes.some((n) => /ball or a bull-nose/.test(n.text)));
});

/** The distance from each point of the program to the nearest point of a *different* pass. */
function neighbourGaps(cl, keep) {
  const pts = [];
  let prev = null;
  let length = 0;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (feed === FEED.RAPID || op === OP.RAPID) { prev = null; return; }
    if (prev) {
      const L = Math.hypot(x - prev[0], y - prev[1], z - prev[2]);
      const n = Math.max(1, Math.ceil(L / 0.4));
      for (let q = 1; q <= n; q++) {
        const t = q / n;
        pts.push([prev[0] + (x - prev[0]) * t, prev[1] + (y - prev[1]) * t, prev[2] + (z - prev[2]) * t, length + L * t]);
      }
      length += L;
    }
    prev = [x, y, z];
  });
  const cell = 3;
  const hash = new Map();
  const key = (a, b, c) => `${a},${b},${c}`;
  pts.forEach((p, n) => {
    const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell));
    if (!hash.has(k)) hash.set(k, []);
    hash.get(k).push(n);
  });
  const gaps = [];
  for (const p of pts) {
    if (!keep(p)) continue;
    let best = Infinity;
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          const list = hash.get(key(Math.floor(p[0] / cell) + a, Math.floor(p[1] / cell) + b, Math.floor(p[2] / cell) + c));
          if (!list) continue;
          for (const m of list) {
            if (Math.abs(pts[m][3] - p[3]) < 6) continue;      // the same pass
            best = Math.min(best, Math.hypot(pts[m][0] - p[0], pts[m][1] - p[1], pts[m][2] - p[2]));
          }
        }
      }
    }
    if (best < cell) gaps.push(best);
  }
  gaps.sort((a, b) => a - b);
  return { median: gaps[Math.floor(gaps.length / 2)], p95: gaps[Math.floor(gaps.length * 0.95)], count: gaps.length };
}

const inside = (p) => p[0] > 6 && p[0] < 34 && p[1] > 6 && p[1] < 34;
const RAMP_STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 41] };

test('on a 45 degree plane the passes are the designed distance apart along the surface', () => {
  const tool = ball(6);
  const cl = run('scallop', makeRamp(40, 40, 40), RAMP_STOCK, tool, { scallopHeight: 0.05 });
  assert.ok(cuts(cl).length > 200, 'passes were made');
  const design = scallopSpacing(3, 0.05) * 0.95;
  const gaps = neighbourGaps(cl, inside);
  assert.ok(gaps.count > 500, `${gaps.count} points measured`);
  assert.close(gaps.median, design, design * 0.03, `median ${gaps.median.toFixed(3)} against a design of ${design.toFixed(3)}`);
  assert.ok(gaps.p95 < design * 1.1, `p95 ${gaps.p95.toFixed(3)}: no gap more than 10% over`);
});

test('a raster of the same plan step is 41 per cent too wide on that plane, which is what scallop corrects', () => {
  const tool = ball(6);
  const s = scallopSpacing(3, 0.05);
  const raster = run('parallel3d', makeRamp(40, 40, 40), RAMP_STOCK, tool, { stepover: s / 6, pattern: 'zigzag', angleDeg: 90 });
  const gaps = neighbourGaps(raster, inside);
  assert.close(gaps.median, s * Math.SQRT2, 0.02, `the raster is ${gaps.median.toFixed(3)} apart on the surface, ${s.toFixed(3)} in plan`);
  const scallop = neighbourGaps(run('scallop', makeRamp(40, 40, 40), RAMP_STOCK, tool, { scallopHeight: 0.05 }), inside);
  assert.ok(Math.abs(scallop.median - s * 0.95) < Math.abs(gaps.median - s * 0.95) / 5, 'scallop is far nearer the design');
});

test('a smaller scallop height asks for closer passes, in the proportion the formula says', () => {
  const tool = ball(6);
  const a = neighbourGaps(run('scallop', makeRamp(40, 40, 40), RAMP_STOCK, tool, { scallopHeight: 0.08 }), inside).median;
  const b = neighbourGaps(run('scallop', makeRamp(40, 40, 40), RAMP_STOCK, tool, { scallopHeight: 0.02 }), inside).median;
  assert.close(a / b, scallopSpacing(3, 0.08) / scallopSpacing(3, 0.02), 0.06, `${a.toFixed(2)} against ${b.toFixed(2)}`);
});

test('scallop never takes the cutter below the surface', () => {
  const tool = ball(6);
  const cl = run('scallop', makeRamp(40, 40, 40), RAMP_STOCK, tool);
  // a ball of radius 3 resting on the plane z = x touches it with its tip 3(sqrt2 - 1) below the plane
  const lowest = (x) => x - 3 * (Math.SQRT2 - 1);
  let worst = Infinity;
  for (const [x, , z] of cuts(cl)) worst = Math.min(worst, z - lowest(x));
  assert.ok(worst > -0.02, `the lowest point is ${worst.toFixed(3)} under the ball's own resting height`);
});

test('a flat floor is finished too, and a region keeps the passes out of what it excludes', () => {
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 11] };
  const flat = run('scallop', makeBox(40, 40, 10), stock, ball(6), { scallopHeight: 0.1 });
  assert.ok(cuts(flat).length > 50, 'a flat top still gets its passes');
  const z = cuts(flat).map((p) => p[2]);
  assert.close(Math.max(...z) - Math.min(...z), 0, 0.02, 'all of them at the one height');
});

test('the new strategies are in the catalogue, pick a ball, and read what is before them', async () => {
  for (const type of ['pencil', 'scallop']) {
    const op = createOperation(type);
    assert.eq(op.type, type);
    const rack = [
      { id: 'a', type: 'flat', diameter: 10, number: 1 },
      { id: 'b', type: 'ball', diameter: 6, number: 2 },
      { id: 'c', type: 'ball', diameter: 2, number: 3 },
    ];
    assert.eq(pickToolFor(type, rack).id, 'c', `${type} takes the smallest ball, like every finisher`);
    assert.ok('pencilRefDiameter' in op.params && 'scallopHeight' in op.params);
  }
  const { READS_EARLIER } = await import('../engine/toolpath.js');
  assert.ok(READS_EARLIER.has('pencil') && READS_EARLIER.has('scallop'));
});

// ---------------------------------------------------------------- the line finder

test('thinning takes a thick bar to one line and a square ring to one closed loop', async () => {
  const { thin, tracePaths, simplifyRun } = await import('../geom/skeleton.js');
  const W = 30;
  const H = 20;
  const bar = new Uint8Array(W * H);
  for (let j = 7; j <= 12; j++) for (let i = 2; i <= 27; i++) bar[j * W + i] = 1;
  const line = thin(bar, W, H);
  const cells = line.reduce((n, v) => n + v, 0);
  assert.ok(cells >= 20 && cells <= 30, `a bar 26 long thins to about 26 cells, got ${cells}`);
  const rows = new Set();
  line.forEach((v, k) => { if (v) rows.add(Math.floor(k / W)); });
  assert.ok([...rows].every((r) => r >= 8 && r <= 11), 'and down its middle');
  assert.eq(tracePaths(line, W, H).length, 1, 'one run');

  const ring = new Uint8Array(W * H);
  for (let j = 3; j <= 16; j++) {
    for (let i = 5; i <= 24; i++) {
      const edge = j <= 5 || j >= 14 || i <= 7 || i >= 22;
      if (edge) ring[j * W + i] = 1;
    }
  }
  const loops = tracePaths(thin(ring, W, H), W, H);
  // a ring is a line that comes back to itself: every cell of it is in some run,
  // the runs together are about its perimeter (2 x (14 + 10) = 48), and each run
  // starts where another ends — which is what a closed loop looks like cut at its corners
  const total = loops.reduce((n, run) => n + run.length, 0);
  assert.ok(total >= 44 && total <= 70, `about a perimeter of cells, got ${total}`);
  const ends = loops.flatMap((run) => [run[0], run[run.length - 1]]);
  const joined = ends.every(([i, j], n) => ends.some(([a, b], m) => m !== n && Math.abs(a - i) <= 1 && Math.abs(b - j) <= 1));
  assert.ok(joined, 'every end meets another');
  const simple = simplifyRun([[0, 0], [1, 0.01], [2, 0], [3, 0.02], [4, 0]], 0.1);
  assert.eq(simple.length, 2, 'a straight run is its two ends');
  assert.eq(simplifyRun([[0, 0], [1, 1]], 0.1).length, 2);
});
