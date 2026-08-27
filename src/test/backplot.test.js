import { test, assert } from './runner.js';
import { parseGcode } from '../post/parse.js';
import {
  readGcode, reviewProgram, comparePaths, rapidCutFinding,
} from '../engine/backplot.js';
import { simulateRemoval } from '../engine/simulate.js';
import { buildGcode } from '../post/index.js';
import { generateToolpath } from '../engine/toolpath.js';
import { CLBuilder, FEED } from '../engine/cl.js';
import { makePocketBlock } from './fixtures.js';

const TOOL = {
  number: 1, type: 'flat', diameter: 6, fluteLength: 25, shankDiameter: 6,
  spindleRpm: 9000, feedCut: 700, feedPlunge: 250, flutes: 3,
};

const program = (...lines) => lines.join('\n');

test('an inch program comes back in millimetres', () => {
  const r = readGcode(program('G20 G90 G17', 'G0 X0 Y0 Z1', 'G1 Z0 F10', 'G1 X1 Y2'));
  assert.eq(r.stats.units, 'inch', 'and says which it was written in');
  const last = r.parsed.points[r.parsed.points.length - 1];
  assert.close(last.x, 25.4, 1e-6, 'one inch of X');
  assert.close(last.y, 50.8, 1e-6, 'two inches of Y');
  // an inch-per-minute feed is 25.4 mm/min, not 10
  assert.close(r.speeds.maxFeed, 254, 1e-6, 'and the feed with it');
});

test('an incremental program is resolved to absolute', () => {
  const r = readGcode(program('G21 G90', 'G0 X10 Y10 Z5', 'G91', 'G1 X5', 'G1 Y5', 'G90', 'G1 X0'));
  const xs = r.parsed.points.map((p) => [p.x, p.y]);
  assert.close(xs[0][0], 10, 1e-9, 'the absolute move stands');
  assert.close(xs[1][0], 15, 1e-9, 'the first increment adds to it');
  assert.close(xs[2][1], 15, 1e-9, 'and the second to that');
  assert.close(xs[3][0], 0, 1e-9, 'and G90 goes back to absolute');
});

test('an arc given as a radius is the arc the control would cut', () => {
  // quarter circle from (10,0) to (0,10) about the origin, counter-clockwise
  const ij = readGcode(program('G21 G90 G17', 'G0 X10 Y0 Z0', 'G3 X0 Y10 I-10 J0'));
  const r = readGcode(program('G21 G90 G17', 'G0 X10 Y0 Z0', 'G3 X0 Y10 R10'));
  assert.eq(r.parsed.unsupported.length, 0, 'the R form is understood');
  const radius = (p) => Math.hypot(p.x, p.y);
  for (const p of r.parsed.points) {
    assert.close(radius(p), 10, 0.01, 'every point is on the circle');
  }
  assert.ok(Math.abs(ij.parsed.points.length - r.parsed.points.length) <= 1,
    'and it is the same arc as the I/J spelling');
});

test('a negative radius takes the long way round', () => {
  const short = readGcode(program('G21 G90 G17', 'G0 X10 Y0 Z0', 'G3 X0 Y10 R10'));
  const long = readGcode(program('G21 G90 G17', 'G0 X10 Y0 Z0', 'G3 X0 Y10 R-10'));
  assert.ok(long.parsed.points.length > short.parsed.points.length * 2,
    'three quarters of a circle rather than one');
});

test('an arc in G18 turns in ZX, not in XY', () => {
  const r = readGcode(program('G21 G90 G18', 'G0 X10 Y0 Z0', 'G2 X0 Z10 I-10 K0'));
  for (const p of r.parsed.points) {
    assert.close(Math.hypot(p.x, p.z), 10, 0.02, 'the arc is in the ZX plane');
    assert.close(p.y, 0, 1e-9, 'and Y never moves');
  }
});

test('a canned cycle is one hole, at the depth and retract it was given', () => {
  const r = readGcode(program('G21 G90 G17', 'G0 X0 Y0 Z10', 'G99 G81 X5 Y5 Z-3 R1 F100', 'G80'));
  assert.eq(r.parsed.cycles.length, 1, 'one hole');
  const hole = r.parsed.cycles[0];
  assert.close(hole.z, -3, 1e-9, 'to its bottom');
  assert.close(hole.retract, 1, 1e-9, 'and back to R, because G99');
});

test('and G98 comes back to where the run started, not to R', () => {
  const r = readGcode(program('G21 G90 G17', 'G0 X0 Y0 Z10', 'G98 G81 X5 Y5 Z-3 R1 F100', 'G80'));
  assert.close(r.parsed.cycles[0].retract, 10, 1e-9, 'the initial plane');
});

test('what the parser cannot read, it says rather than skips', () => {
  const r = readGcode(program('G21 G90', 'G12.1 X5', 'M62 P1', 'G1 X1 F100'));
  const codes = r.parsed.unsupported.map((u) => u.code);
  assert.ok(codes.includes('G12.1'), `the polar code is reported: ${codes}`);
  assert.ok(codes.includes('M62'), `and the M code: ${codes}`);
});

test('a parsed program is CL data the rest of the app can use', () => {
  const r = readGcode(program(
    'G21 G90 G17', 'T1 M6', 'S9000 M3', 'G0 X0 Y0 Z5',
    'G1 Z-1 F300', 'G1 X20 F700', 'G0 Z5', 'M5', 'M30',
  ));
  assert.ok(r.cl.count >= 4, 'the moves are there');
  assert.eq(r.stats.tools, 1, 'and the tool change');
  assert.close(r.speeds.maxRpm, 9000, 1e-9, 'and the spindle speed');
  assert.close(r.extent.max[0], 20, 1e-9, 'and the extent it needs');
});

// --- the post's own check ---

/** A real operation, posted and read back. */
function roundTrip(post, params = {}) {
  const block = makePocketBlock({ size: 40, pocketSize: 20, height: 10, depth: 6 });
  const cl = generateToolpath({
    type: 'pocket',
    name: 'pocket',
    tool: TOOL,
    mesh: block.mesh,
    stock: { min: [0, 0, 0], max: [40, 40, 10] },
    params: {
      topZ: 10, bottomZ: 4, stepdown: 2, clearanceHeight: 15, ...params,
    },
  });
  const { text } = buildGcode(post, [{ name: 'pocket', cl }]);
  return { cl, text, back: readGcode(text) };
}

test('what the post prints is the path it was given — LinuxCNC', () => {
  const { cl, back } = roundTrip('linuxcnc');
  const { worst } = comparePaths(cl, back.cl);
  assert.ok(worst < 0.02, `the two paths agree to ${worst.toFixed(4)}mm`);
});

/** A circle, which is what makes the post fit arcs and so what tests them. */
function circleProgram(radius = 10, segments = 96, z = -1) {
  const cl = new CLBuilder();
  cl.comment('circle');
  cl.toolChange(1);
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(radius, 0, 5);
  cl.cut(radius, 0, z, FEED.PLUNGE);
  for (let i = 1; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    cl.cut(radius * Math.cos(a), radius * Math.sin(a), z);
  }
  cl.rapid(radius, 0, 5);
  return cl.finish();
}

test('and where the post refits a path into arcs, it is still the same path', () => {
  const cl = circleProgram();
  const { text } = buildGcode('linuxcnc', [{ name: 'circle', cl }]);
  assert.ok(/\bG[23]\b/.test(text), 'the post fitted arcs');
  const { worst } = comparePaths(cl, readGcode(text).cl);
  assert.ok(worst < 0.05, `arc fitting stays on the path: ${worst.toFixed(4)}mm`);
});

test('what the post prints is the path it was given — GRBL', () => {
  const { cl, back } = roundTrip('grbl');
  const { worst } = comparePaths(cl, back.cl);
  assert.ok(worst < 0.02, `the two paths agree to ${worst.toFixed(4)}mm`);
});

test('an arc posted the wrong way round is not the path that went in', () => {
  // The classic post bug, and the one a backplot by eye is least likely to
  // catch: the arc still starts and ends where it should, and goes round the
  // outside of the part to get there.
  const cl = circleProgram();
  const { text } = buildGcode('linuxcnc', [{ name: 'circle', cl }]);
  const flipped = /\bG3\b/.test(text)
    ? text.replace(/\bG3\b/g, 'G2')
    : text.replace(/\bG2\b/g, 'G3');
  const { worst } = comparePaths(cl, readGcode(flipped).cl);
  assert.ok(worst > 0.1, `the diff notices: ${worst.toFixed(3)}mm`);
});

test('and a coordinate quietly moved is caught too', () => {
  const { cl, text } = roundTrip('linuxcnc');
  const broken = text.replace(/^Y19\.975$/m, 'Y21.975');
  assert.ok(broken !== text, 'the fixture line was there to break');
  const { worst } = comparePaths(cl, readGcode(broken).cl);
  assert.ok(worst > 0.5, `the diff notices: ${worst.toFixed(3)}mm`);
});

// --- checking a whole program ---

const STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] };

function review(text, extra = {}) {
  const r = readGcode(text);
  return reviewProgram({
    cl: r.cl,
    parsed: r.parsed,
    stock: STOCK,
    fixtures: [],
    extent: r.extent,
    speeds: r.speeds,
    machine: null,
    ...extra,
  });
}

test('a rapid that takes metal is a crash, and the simulation is what says so', () => {
  // A G0 straight across the billet 2mm down. Read off the geometry alone this
  // is indistinguishable from a stay-down link the app makes on purpose; what
  // separates them is whether there was anything there.
  const r = readGcode(program('G21 G90', 'G0 X0 Y20 Z-2', 'G0 X40 Y20', 'M30'));
  const sim = simulateRemoval({
    stock: STOCK,
    ops: [{ cl: r.cl, tool: TOOL }],
  });
  const found = rapidCutFinding(sim, [{ name: 'the file' }]);
  assert.ok(found, 'reported');
  assert.ok(/rapid/.test(found.text), `and it is about the rapid: ${found?.text}`);
  assert.ok(sim.rapidCut.depth > 1, `taking real metal: ${sim.rapidCut.depth}`);
});

test('a rapid over ground already cleared is not', () => {
  // the same traverse, over a channel the program has just cut
  const r = readGcode(program(
    'G21 G90',
    'G0 X0 Y20 Z12', 'G1 Z-2 F200', 'G1 X40 F600',
    'G0 X0 Y20', 'M30',
  ));
  const sim = simulateRemoval({ stock: STOCK, ops: [{ cl: r.cl, tool: TOOL }] });
  assert.eq(sim.rapidCut.count, 0,
    `the metal was already gone: ${sim.rapidCut.depth}mm`);
  assert.eq(rapidCutFinding(sim), null, 'so there is nothing to report');
});

test('a rapid clear over the top of the billet is not', () => {
  const r = readGcode(program('G21 G90', 'G0 X0 Y20 Z12', 'G0 X40 Y20', 'M30'));
  const sim = simulateRemoval({ stock: STOCK, ops: [{ cl: r.cl, tool: TOOL }] });
  assert.eq(sim.rapidCut.count, 0, 'clear of the stock is clear');
});

test('a move over a clamp below the clamp is reported', () => {
  const clamp = {
    id: 'f1', kind: 'box', name: 'front clamp', enabled: true,
    center: [20, 20], size: [20, 20], height: 25, baseZ: 0,
  };
  const found = review(
    program('G21 G90', 'G0 X0 Y0 Z20', 'G0 X20 Y20', 'M30'),
    { fixtures: [clamp] },
  );
  assert.ok(found.some((f) => /front clamp/.test(f.text)), `named: ${JSON.stringify(found)}`);
});

test('and clear over the top of it is not', () => {
  const clamp = {
    id: 'f1', kind: 'box', name: 'front clamp', enabled: true,
    center: [20, 20], size: [20, 20], height: 25, baseZ: 0,
  };
  const found = review(
    program('G21 G90', 'G0 X0 Y0 Z30', 'G0 X20 Y20', 'M30'),
    { fixtures: [clamp] },
  );
  assert.ok(!found.some((f) => /clamp/.test(f.text)), `nothing to say: ${JSON.stringify(found)}`);
});

test('a program too big for the machine says so', () => {
  const machine = {
    kind: 'mill', name: 'a small one', travel: [100, 100, 100],
    spindleMin: 0, spindleMax: 0, maxFeed: 0,
  };
  const found = review(program('G21 G90', 'G0 X0 Y0 Z12', 'G1 X300 F500', 'M30'), { machine });
  assert.ok(found.some((f) => /300\.0mm of X/.test(f.text)), `the travel: ${JSON.stringify(found)}`);
});

test('a file the parser only half understood says so first', () => {
  const found = review(program('G21 G90', 'G12.1 X5', 'G0 X0 Y0 Z12', 'M30'));
  assert.ok(/went unread/.test(found[0].text), `${JSON.stringify(found)}`);
});

test('a run of holes keeps the cycle depth the first block stated', () => {
  // The whole reason a drilling run is two lines and then four: every block
  // after the first says X and Y and means the same Z, R and Q.
  const r = readGcode(program(
    'G21 G90 G17', 'G0 X0 Y0 Z10',
    'G98 G81 X5 Y5 Z-3 R1 F100', 'X15 Y5', 'X15 Y15', 'G80',
  ));
  assert.eq(r.parsed.cycles.length, 3, 'three holes');
  for (const hole of r.parsed.cycles) {
    assert.close(hole.z, -3, 1e-9, 'each to the same depth');
    assert.close(hole.r, 1, 1e-9, 'from the same R plane');
  }
  assert.close(r.parsed.cycles[2].x, 15, 1e-9, 'and at their own positions');
  assert.close(r.parsed.cycles[2].y, 15, 1e-9, 'and at their own positions');
});

test('and forgets them when the cycle is cancelled', () => {
  const r = readGcode(program(
    'G21 G90 G17', 'G0 X0 Y0 Z10',
    'G98 G81 X5 Y5 Z-3 R1 F100', 'G80',
    'G81 X15 Y15 Z-8 R2', 'G80',
  ));
  assert.close(r.parsed.cycles[1].z, -8, 1e-9, 'the second run has its own depth');
});

test('a peck depth is modal too', () => {
  const r = readGcode(program(
    'G21 G90 G17', 'G0 X0 Y0 Z10',
    'G98 G83 X5 Y5 Z-9 R1 Q3 F100', 'X15 Y5', 'G80',
  ));
  assert.close(r.parsed.cycles[1].q, 3, 1e-9, 'the second hole pecks the same way');
});
