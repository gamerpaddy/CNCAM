// Where the tool goes before an operation begins — post/core.js `approach`.
//
// An operation's first move is written from the operation alone, as one rapid
// from the last point it knows about. A program cannot know where the machine
// is when it starts, or after a tool change, and even between two operations on
// one cutter that single move is a descent across the whole job. So the post
// lifts to the height the operation travels at, crosses at that height, and
// only then lets the operation's own first move come down — and never trusts a
// word it wrote before the cutter was changed.

import { test, assert } from './runner.js';
import { buildGcode } from '../post/index.js';
import { parseGcode } from '../post/parse.js';
import { checkPost } from '../engine/backplot.js';
import { CLBuilder, MOVE_STRIDE, OP } from '../engine/cl.js';
import { generateToolpath } from '../engine/toolpath.js';
import { generateCommand } from '../engine/strategies/command.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { makeStepped, makePocketAndHole } from './fixtures.js';

/**
 * A pass that starts a millimetre over the stock, the way a contour or a
 * pocket does, and is over it at 10 before and after.
 */
function pass(number, [x, y], { entryZ = 1, top = 10 } = {}) {
  const cl = new CLBuilder();
  cl.toolChange(number);
  cl.spindle(9000);
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(x, y, entryZ);
  cl.cut(x + 10, y, 0);
  cl.rapid(x + 10, y, top);
  return cl.finish();
}

/** The lines of a program after the marker line, up to the first cutting move. */
function approachLines(text, marker) {
  const lines = text.split('\n');
  const from = lines.findIndex((l) => l === marker || l.includes(marker));
  const out = [];
  for (const line of lines.slice(from + 1)) {
    if (/^G1\b/.test(line)) break;
    out.push(line);
  }
  return out;
}

const POSTS = ['linuxcnc', 'grbl'];

/** Two lists of lines are the same when they read the same. */
const same = (actual, expected, msg) => assert.eq(JSON.stringify(actual), JSON.stringify(expected), msg);

test('a program does not begin with one move from wherever the tool happens to be', () => {
  // `G0 X20 Y15 Z1`, the first motion of the file: from the touch-off point, or
  // the changer's park, straight to a millimetre over the stock with all three
  // axes at once.
  for (const post of POSTS) {
    const { text } = buildGcode(post, [{ name: 'a', cl: pass(1, [20, 15]) }]);
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^G0 Z10$/.test(l));
    assert.ok(start >= 0, `${post} lifts before it does anything else, got:\n${text}`);
    same(lines.slice(start, start + 3), ['G0 Z10', 'X20 Y15', 'Z1'],
      `${post}: up, across at that height, then down`);
    assert.ok(!lines.slice(0, start).some((l) => /^(G0 )?[XY]/.test(l)),
      `${post} moves nothing sideways before it has lifted`);
  }
});

test('a second pass on the same cutter does not descend across the job to its start', () => {
  const ops = [
    { name: 'a', cl: pass(1, [20, 15]) },
    { name: 'b', cl: pass(1, [40, 30]) },
  ];
  for (const post of POSTS) {
    const { text } = buildGcode(post, ops);
    same(approachLines(text, '(operation: b)').slice(0, 2), ['X40 Y30', 'Z1'],
      `${post}: over the start at the height the last pass ended at, then straight down`);
  }
});

test('an approach that is level already keeps to one line', () => {
  // the second pass begins at clearance, over the start, as a parallel finish does
  const ops = [
    { name: 'a', cl: pass(1, [20, 15]) },
    { name: 'b', cl: pass(1, [40, 30], { entryZ: 10 }) },
  ];
  const { text } = buildGcode('linuxcnc', ops);
  same(approachLines(text, '(operation: b)').slice(0, 1), ['X40 Y30'], 'nothing added to it');
});

test('a pass that starts over the tool does not move it sideways', () => {
  const ops = [
    { name: 'a', cl: pass(1, [20, 15]) },
    // the last pass ended at X30 Y15
    { name: 'b', cl: pass(1, [30, 15]) },
  ];
  const { text } = buildGcode('linuxcnc', ops);
  const lines = approachLines(text, '(operation: b)');
  assert.eq(lines[0], 'Z1', `it only comes down, got:\n${lines.join('\n')}`);
});

test('after a change of cutter the tool goes up before it goes across, whatever was written last', () => {
  // The second cutter starts exactly where the first one ended. Every word
  // matches what the program said before, so a post that remembered them
  // wrote no X or Y at all - and the head had been changed, parked or jogged
  // to touch off in between.
  const first = pass(1, [20, 15]);
  const second = pass(2, [30, 15]);
  for (const [post, options] of [['linuxcnc', {}], ['linuxcnc', { toolChanger: 'manual' }],
    ['grbl', {}], ['grbl', { toolChanger: 'auto' }]]) {
    const { text } = buildGcode(post, [{ name: 'a', cl: first }, { name: 'b', cl: second }], options);
    const after = approachLines(text, '(operation: b)');
    const at = after.findIndex((l) => /^G0 Z10$/.test(l));
    assert.ok(at >= 0, `${post} ${JSON.stringify(options)} lifts after the change, got:\n${after.join('\n')}`);
    same(after.slice(at, at + 3), ['G0 Z10', 'X30 Y15', 'Z1'],
      `${post} ${JSON.stringify(options)} states where it is going after the change`);
  }
});

test('each setup crosses at its own height', () => {
  // Another fixturing has its own datum, so its clearance is a different
  // number; lifting to the highest Z in the whole program would send the first
  // setup to a height it never needed and the second to one it cannot reach.
  const low = pass(1, [20, 15], { top: 10 });
  const high = pass(1, [20, 15], { top: 45 });
  const { text } = buildGcode('linuxcnc', [
    { name: 'a', cl: low, wcs: 'G54', setup: 's1', setupName: 'Setup 1' },
    { name: 'b', cl: high, wcs: 'G55', setup: 's2', setupName: 'Setup 2' },
  ]);
  same(approachLines(text, '(operation: a)').filter((l) => /Z/.test(l)).slice(0, 1), ['G0 Z10'],
    'the first setup lifts to its own 10');
  assert.ok(approachLines(text, '(operation: b)').includes('G0 Z45'),
    `and the second to its own 45, got:\n${approachLines(text, '(operation: b)').join('\n')}`);
});

test('a hole is approached from over it', () => {
  const cl = new CLBuilder();
  cl.toolChange(4);
  cl.spindle(2000);
  cl.event('feeds', { cut: 500, plunge: 150 });
  cl.rapid(12, 8, 10);
  cl.drill(12, 8, -5, { retractZ: 2 });
  cl.drill(30, 8, -5, { retractZ: 2 });
  cl.rapid(30, 8, 10);
  const { text } = buildGcode('linuxcnc', [{ name: 'holes', cl: cl.finish() }]);
  const lines = text.split('\n');
  const cycle = lines.findIndex((l) => /^G98 G81 /.test(l));
  assert.ok(cycle > 2, 'a cycle is written');
  same(lines.slice(cycle - 2, cycle), ['G0 Z10', 'X12 Y8'],
    'over the first hole at the height the pass travels at, before the cycle');
});

/** Each operation's highest Z, as the post reads it. */
function topsOf(ops) {
  return ops.map(({ cl }) => {
    let top = -Infinity;
    for (let n = 0; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      top = Math.max(top, cl.moves[o + 3], cl.moves[o] === OP.DRILL ? cl.moves[o + 4] : -Infinity);
    }
    return top;
  });
}

/**
 * Whether every operation's first sideways move is made level at or above the
 * height it travels at, and what the first one that is not looks like.
 */
function firstCrossings(ops, text, lineMap) {
  const tops = topsOf(ops);
  const seen = new Set();
  let prev = { x: 0, y: 0, z: 0 };
  const bad = [];
  for (const m of parseGcode(text).motion) {
    const op = lineMap.get(m.line)?.op;
    const moved = Math.hypot(m.x - prev.x, m.y - prev.y) > 1e-6;
    if (op != null && moved && !seen.has(op)) {
      seen.add(op);
      if (Math.min(prev.z, m.z) < tops[op] - 1e-6) {
        bad.push(`op ${op} crosses from Z${prev.z} to Z${m.z} under its travel height ${tops[op]}`);
      }
    }
    prev = { x: m.x, y: m.y, z: m.z };
  }
  return { bad, crossed: seen.size };
}

const JAWS = (stock) => {
  const cy = (stock.min[1] + stock.max[1]) / 2;
  const jaw = (x) => ({
    kind: 'box', name: 'Jaw', enabled: true, center: [x, cy],
    size: [10, (stock.max[1] - stock.min[1]) * 0.6], rotationDeg: 0,
    baseZ: stock.min[2], height: stock.max[2] - stock.min[2] + 15,
  });
  return [jaw(stock.min[0] - 6), jaw(stock.max[0] + 6)];
};

test('no operation begins by descending across the job, whatever the strategy and the cutter', () => {
  const flat = { number: 1, type: 'flat', diameter: 6, flutes: 2, fluteLength: 20, spindleRpm: 12000, feedCut: 800, feedPlunge: 250 };
  const ball = { number: 2, type: 'ball', diameter: 4, flutes: 2, fluteLength: 20, spindleRpm: 12000, feedCut: 800, feedPlunge: 250 };
  const drill = { number: 3, type: 'drill', diameter: 4, flutes: 2, fluteLength: 30, spindleRpm: 6000, feedCut: 300, feedPlunge: 150 };
  const parts = {
    stepped: { mesh: makeStepped({ base: 40, top: 20, baseHeight: 10, topHeight: 10 }).mesh },
    holes: { mesh: makePocketAndHole().mesh },
  };
  let crossings = 0;
  for (const [name, part] of Object.entries(parts)) {
    const stock = name === 'stepped'
      ? { kind: 'box-margin', min: [-1, -1, 0], max: [41, 41, 21] }
      : { kind: 'box-margin', min: [-1, -1, -1], max: [61, 41, 21] };
    const fixtures = JAWS(stock);
    const sequence = [
      ['contour2d', flat], ['clear2d', flat], ['pocket', flat], ['adaptive', flat],
      ['waterline', ball], ['parallel3d', ball], ['drill', drill], ['contour2d', flat],
    ];
    const ops = [];
    for (const [type, tool] of sequence) {
      const params = { ...defaultParamsFor(type, { stock, tool }), tolerance: 0.05 };
      const cl = generateToolpath({ type, name: type, tool, mesh: part.mesh, stock, params, fixtures });
      if (cl.count) ops.push({ name: type, cl });
    }
    assert.ok(ops.length >= 4, `${name}: enough operations to have crossings between`);
    for (const post of POSTS) {
      const { text, lineMap } = buildGcode(post, ops, {});
      const { bad, crossed } = firstCrossings(ops, text, lineMap);
      same(bad, [], `${name} ${post}: no operation descends on its way across`);
      crossings += crossed;
    }
  }
  assert.ok(crossings >= 20, `the check looked at ${crossings} crossings`);
});

test('the approach does not make a correct program look wrong to the read-back', () => {
  // checkPost walks the file against the toolpath it was posted from, operation
  // by operation. The lines an approach adds are rapids ahead of the first cut,
  // which is what it leaves out of the comparison.
  const ops = [
    { name: 'a', cl: pass(1, [20, 15]) },
    { name: 'b', cl: pass(1, [40, 30]) },
    { name: 'c', cl: pass(2, [5, 5]) },
  ];
  for (const post of POSTS) {
    const { text, lineMap } = buildGcode(post, ops);
    const check = checkPost({ ops, text, lineMap });
    assert.ok(check.over <= 0, `${post}: the file still matches its toolpath (${check.worst.toFixed(3)}mm off)`);
  }
});

test('a new fixturing, a new datum or a hand-written block each forget where the tool was', () => {
  // The second pass starts exactly where the first ended, so a post that went
  // on believing in its last position would write nothing to bring the tool
  // there - and the part has been turned over, the datum has moved under the
  // numbers, or a block of somebody's own G-code has moved the head.
  const expected = ['G0 Z10', 'X30 Y15', 'Z1'];
  const first = pass(1, [20, 15]);
  const second = pass(1, [30, 15]);
  const cases = {
    'another setup': [
      { name: 'a', cl: first, wcs: 'G54', setup: 's1', setupName: 'Setup 1' },
      { name: 'b', cl: second, wcs: 'G54', setup: 's2', setupName: 'Setup 2' },
    ],
    'another work offset': [
      { name: 'a', cl: first, wcs: 'G54' },
      { name: 'b', cl: second, wcs: 'G55' },
    ],
    'a block of G-code': [
      { name: 'a', cl: first },
      { name: 'park', cl: generateCommand({ params: { gcode: 'G53 G0 X0 Y0' } }) },
      { name: 'b', cl: second },
    ],
  };
  for (const [what, ops] of Object.entries(cases)) {
    const { text } = buildGcode('linuxcnc', ops);
    const after = approachLines(text, '(operation: b)');
    const at = after.findIndex((l) => l === 'G0 Z10');
    assert.ok(at >= 0, `${what}: lifts first, got:\n${after.join('\n')}`);
    same(after.slice(at, at + 3), expected, `${what}: then across, then down`);
  }
});
