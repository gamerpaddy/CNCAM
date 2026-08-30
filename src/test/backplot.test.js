import { test, assert } from './runner.js';
import { parseGcode } from '../post/parse.js';
import {
  readGcode, reviewProgram, comparePaths, checkPost, rapidCutFinding,
} from '../engine/backplot.js';
import { simulateRemoval } from '../engine/simulate.js';
import { buildGcode } from '../post/index.js';
import { generateToolpath } from '../engine/toolpath.js';
import { CLBuilder, FEED } from '../engine/cl.js';
import { makePocketBlock, makeTube } from './fixtures.js';

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

// --- a lathe writes X as a diameter ---

test('X on a lathe is a diameter, and comes back as the radius it is', () => {
  // G7 is in the header of every file post/lathe.js writes. Read as a plain
  // coordinate, a ⌀40 bar comes back at ⌀80 — the backplot draws it off the
  // stock, the simulation cuts air, and the round-trip check reports every
  // operation in the program as out by half a diameter.
  const r = readGcode(program('G21 G90 G18 G7', 'G0 X43 Z1', 'G1 X40 F0.2', 'Z-20'));
  assert.eq(r.parsed.xWords, 'diameter', 'and says which the file said');
  assert.eq(r.parsed.unsupported.length, 0, 'G7 is a word this reader knows');
  assert.close(r.parsed.points[0].x, 21.5, 1e-9, 'half of X43');
  assert.close(r.parsed.points[1].x, 20, 1e-9, 'and half of X40');
});

test('and G8 puts it back', () => {
  const r = readGcode(program('G21 G90 G18 G7', 'G0 X40 Z1', 'G8', 'G1 X40 Z-1'));
  assert.close(r.parsed.points[0].x, 20, 1e-9, 'a diameter while G7 stands');
  assert.close(r.parsed.points[1].x, 40, 1e-9, 'and a radius after G8');
});

test("a lathe's T0909 is station 9, not tool 909", () => {
  // Read as one number, the read-back tells you the file asks for a T909 you
  // have not got, and then simulates it with whatever the widest cutter in the
  // library is.
  const r = readGcode(program('G21 G90 G18 G7', 'T0909 M6', 'G0 X40 Z1'));
  const change = r.parsed.events.find((e) => e.type === 'tool');
  assert.eq(change.tool, 9, 'the turret station');
});

test('and a mill still calls T909 tool 909', () => {
  const r = readGcode(program('G21 G90 G17', 'T909 M6', 'G0 X40 Y0 Z1'));
  assert.eq(r.parsed.events.find((e) => e.type === 'tool').tool, 909);
});

test('a mill file is radius all the way, G7 never having been said', () => {
  const r = readGcode(program('G21 G90 G17', 'G0 X40 Y0 Z1', 'G1 Z0 F100'));
  assert.eq(r.parsed.xWords, 'radius');
  assert.close(r.parsed.points[0].x, 40, 1e-9, 'X is X');
});

// --- the round-trip check's own noise floor ---

/**
 * A long path with arcs in it, which is where the check used to cry wolf: the
 * fitter makes the file a hair longer than the polyline it came from, and a
 * comparison walked by fraction of length slips by that much.
 */
function spiralProgram(turns = 15, segments = 90) {
  const cl = new CLBuilder();
  cl.toolChange(1);
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(10, 0, 5);
  cl.cut(10, 0, 0, FEED.PLUNGE);
  for (let i = 1; i <= turns * segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    cl.cut(10 * Math.cos(a), 10 * Math.sin(a), -(i / (turns * segments)) * 15);
  }
  cl.rapid(10, 0, 5);
  return cl.finish();
}

/** Post an op and check the file against the path, as refreshGcodePreview does. */
function checked(cl, name, post = 'linuxcnc', options = {}, mangle = (t) => t) {
  const ops = [{ name, cl }];
  const { text, lineMap } = buildGcode(post, ops, options);
  return { ...checkPost({ ops, text, lineMap, fitTolerance: 0.01 }), text };
}

test('a correct program with arcs in it is not reported as a post bug', () => {
  const spiral = spiralProgram();
  const r = checked(spiral, 'spiral');
  assert.ok(/\bG[23]\b/.test(r.text), 'the post fitted arcs, which is the case that drifts');
  assert.ok(r.over <= 0, `nothing to say: worst ${r.worst.toFixed(3)}mm, `
    + `allowed ${r.ops[0].allowed.toFixed(3)}mm over ${r.ops[0].extra.toFixed(3)}mm of drift`);
});

test('and the fault it exists to find still fires on the same program', () => {
  const spiral = spiralProgram();
  const ops = [{ name: 'spiral', cl: spiral }];
  const { text, lineMap } = buildGcode('linuxcnc', ops);
  const flipped = text.split('\n')
    .map((l) => l.replace(/^G2\b/, 'G@').replace(/^G3\b/, 'G2').replace(/^G@/, 'G3'))
    .join('\n');
  const r = checkPost({ ops, text: flipped, lineMap, fitTolerance: 0.01 });
  assert.ok(r.over > 1, `a flipped arc is still a diameter out: ${r.worst.toFixed(2)}mm `
    + `against ${r.ops[0].allowed.toFixed(2)}mm allowed`);
});

/** A real drilling pass, pecked - the operation both posts spell differently. */
function peckedHole() {
  return generateToolpath({
    type: 'drill',
    name: 'drill',
    tool: { ...TOOL, type: 'drill', diameter: 5, tipAngle: 118 },
    mesh: makeTube(20, 20, 18, 2.5, 20),
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] },
    params: {
      topZ: 20, bottomZ: 0, clearanceHeight: 30, tolerance: 0.01,
      diameterTol: 0.5, entryGap: 1, peck: 2,
    },
  });
}

test('a hole pecked long-hand is the same hole as one pecked by canned cycle', () => {
  // GRBL and the lathe have no G83, so both write the pecks out as moves. The
  // CL says one hole; the file says twenty blocks of down, out, down again, and
  // walked side by side the two part company by the depth of the hole - which
  // put "do not run this" on every drilling operation posted for either.
  const cl = peckedHole();
  assert.ok(!/G8[13]/.test(buildGcode('grbl', [{ name: 'drill', cl }]).text),
    'GRBL writes the pecks out');
  assert.ok(/G8[13]/.test(buildGcode('linuxcnc', [{ name: 'drill', cl }]).text),
    'and LinuxCNC writes a cycle');
  for (const post of ['linuxcnc', 'grbl']) {
    const r = checked(cl, 'drill', post);
    assert.ok(r.over <= 0, `${post}: nothing to say, worst ${r.worst.toFixed(3)}mm`);
  }
});

test('but a hole drilled to the wrong depth is still caught, however it is spelled', () => {
  const cl = peckedHole();
  for (const post of ['linuxcnc', 'grbl']) {
    const ops = [{ name: 'drill', cl }];
    const { text, lineMap } = buildGcode(post, ops);
    const shallow = text.replace(/Z-1\.502/g, 'Z6.498');
    assert.ok(shallow !== text, `${post}: the depth was there to break`);
    const r = checkPost({ ops, text: shallow, lineMap, fitTolerance: 0.01 });
    assert.ok(r.over > 0, `${post}: eight millimetres short is a fault, not noise`);
  }
});


test('and a closed profile keeps the retract that ends it', () => {
  // A loop arrives back where it started and lifts: three moves at one XY that
  // are not a hole. Reduced as though they were, an engraved rectangle lost its
  // lift-off and read as 22mm of post bug.
  const cl = new CLBuilder();
  cl.toolChange(1);
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(0, 0, 10);
  cl.cut(0, 0, -1, FEED.PLUNGE);
  for (const [x, y] of [[30, 0], [30, 20], [0, 20], [0, 0]]) cl.cut(x, y, -1);
  cl.rapid(0, 0, 10);
  const r = checked(cl.finish(), 'engrave');
  assert.ok(r.over <= 0, `nothing to say: ${r.worst.toFixed(3)}mm`);
});

// --- what a word means depends on the modes in force ---

/** The length of everything the reader drew after the first move. */
function pathLength(text) {
  const { points } = parseGcode(text);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y,
      points[i].z - points[i - 1].z);
  }
  return total;
}

test('the R form of an arc turns the way the G word says', () => {
  // Two arcs pass through the same two points at the same radius and the sign
  // of R picks between them — but *which* of the two is the short way depends
  // on the direction of travel, so reading the sign alone is right for G3 and
  // the complement of the arc for G2. A quarter circle came back as the three
  // quarters that go round the other side of the part.
  const quarter = (Math.PI * 10) / 2;              // 15.71mm
  const three = 3 * quarter;                       // 47.12mm
  const arc = (g, r) => program('G21 G90', 'G0 X0 Y0', `G${g} X10 Y10 R${r} F100`);
  assert.close(pathLength(arc(2, 10)), quarter, 0.05, 'G2 R+ is the short way');
  assert.close(pathLength(arc(3, 10)), quarter, 0.05, 'and so is G3 R+');
  assert.close(pathLength(arc(2, -10)), three, 0.05, 'G2 R− is the long way');
  assert.close(pathLength(arc(3, -10)), three, 0.05, 'and so is G3 R−');
  // I/J is unambiguous, and is what the R form has to agree with
  assert.close(pathLength(program('G21 G90', 'G0 X0 Y0', 'G2 X10 Y10 I10 J0 F100')),
    quarter, 0.05, 'the same arc spelled I10 J0');
});

test('G95 is millimetres per revolution, not per minute', () => {
  // Every lathe file this app writes says G95 in its header and F0.2 in its
  // passes. Read as a rate, a program the app estimates at eight minutes comes
  // back as seventy-one hours, and the machine's feed limit is checked against
  // a number three orders of magnitude out.
  const { events } = parseGcode(program('G21 G90 G18 G7 G95', 'G97 S1000 M3',
    'G0 X43 Z1', 'G1 X40 F0.2'));
  const feed = events.find((e) => e.type === 'feed');
  assert.close(feed.feed, 200, 1e-9, '0.2mm a rev at 1000 rpm is 200mm a minute');
});

test('and under G96 the speed follows the diameter', () => {
  // Constant surface speed: S is metres a minute and the rpm is whatever gives
  // it at the diameter the tool is at. Read as an rpm, a 200 m/min pass came
  // back as a spindle turning 200 times a minute.
  const { events } = parseGcode(program('G21 G90 G18 G7 G95', 'G96 D2500 S200 M3',
    'G0 X40 Z1', 'G1 X40 F0.2'));
  const spun = events.find((e) => e.type === 'spindle');
  assert.eq(spun.rpm, 2500, 'on the centreline it is the clamp the D word set');
  const feed = events.find((e) => e.type === 'feed');
  // ⌀40 is a 20mm radius: 200000mm/min of skin ÷ (2π×20) = 1591 rpm
  assert.close(feed.feed, 0.2 * (200000 / (2 * Math.PI * 20)), 1e-6,
    'and the feed is the rev rate at the diameter the tool is at');
});

test('a rotary word is said to be unread, not silently dropped', () => {
  // A wrapped program (engine/wrap.js) is mostly rotary: its Y is an angle and
  // its blocks say A. Dropped, the whole pattern collapses onto one line and
  // the file reads as though the tool never moved — which is exactly the sort
  // of confident wrong picture reading a file back is supposed to prevent.
  const r = readGcode(program('G21 G90 G93', 'G0 X0 Z5 A0', 'G1 Z-1 F100',
    'A90 F20', 'X20 A180 F20', 'G94'));
  const codes = r.parsed.unsupported.map((u) => u.code);
  assert.ok(codes.some((c) => /^A\b/.test(c)), `the A axis is named: ${codes.join(', ')}`);
  assert.ok(codes.some((c) => /G93/.test(c)), `and so is inverse time: ${codes.join(', ')}`);
  assert.eq(codes.length, 2, 'once each, not once a block');
  const said = reviewProgram({
    cl: r.cl, parsed: r.parsed, machine: null, extent: r.extent, speeds: r.speeds,
  });
  assert.ok(said.some((s) => /went unread/.test(s.text)), JSON.stringify(said));
});

test('an inverse-time F is not reported as a feed rate', () => {
  // Under G93 the F says how many of that block fit in a minute. A wrapped
  // program's 1.9 is half a minute of cutting, not a spindle crawling at
  // 1.9mm/min.
  const r = readGcode(program('G21 G90', 'G0 X0 Y0 Z1', 'G1 Z-1 F300', 'X10',
    'G93', 'G1 X20 F1.9', 'G94'));
  assert.close(r.speeds.maxFeed, 300, 1e-9, 'only the rates the file stated as rates');
});

test('an ordinary milling program still reads clean', () => {
  // The guard on all of the above: none of these modes exists in a three-axis
  // file, and a check that fires on a correct program is a check nobody reads.
  const r = readGcode(program('G21 G90 G94 G17', 'T1 M6', 'M3 S9000',
    'G0 X0 Y0 Z5', 'G1 Z-1 F250', 'X20 F700', 'Y20', 'G0 Z5', 'M5', 'M2'));
  assert.eq(r.parsed.unsupported.length, 0,
    `nothing went unread: ${JSON.stringify(r.parsed.unsupported)}`);
  assert.close(r.speeds.maxFeed, 700, 1e-9, 'and the feeds are the feeds');
  assert.eq(r.speeds.maxRpm, 9000, 'and the speed is the speed');
});
