// Posting simultaneous 5-axis, and reading the file back.
//
// The post is the one stage nothing else checks, and for 5-axis it is where a
// mirrored axis or a lost pivot would turn a correct toolpath into a scrapped
// part. So every program here is posted, read back through the machine's own
// kinematics, and held against the CL it came from.

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { buildGcode } from '../post/index.js';
import { parseGcode } from '../post/parse.js';
import { checkPost, clFromGcode } from '../engine/backplot.js';
import { createMachine, rotaryPreset } from '../doc/machines.js';
import { createSetup } from '../doc/schema.js';
import { fiveFor } from '../engine/five/post-data.js';
import { MOVE_STRIDE, OP, CLBuilder, FEED } from '../engine/cl.js';
import { makeRevolved, makeBox } from './fixtures.js';

const R = 8;
const STOCK = { kind: 'box', min: [-10, -10, 0], max: [10, 10, 9] };
const BALL = {
  number: 3, type: 'ball', diameter: 6, fluteLength: 20, spindleRpm: 12000, feedCut: 900, feedPlunge: 300,
};

function dome() {
  const outline = [[0, 0], [R, 0]];
  for (let deg = 6; deg <= 90; deg += 6) {
    outline.push([R * Math.cos((deg * Math.PI) / 180), R * Math.sin((deg * Math.PI) / 180)]);
  }
  return makeRevolved(outline, 48);
}

let cached = null;
/** the finishing program on the dome, made once */
function program() {
  if (cached) return cached;
  cached = generateToolpath({
    type: 'finish5', name: 'finish', tool: BALL, mesh: dome(), stock: STOCK,
    params: {
      ...defaultParamsFor('finish5', { stock: STOCK, tool: BALL }),
      topZ: 9, bottomZ: 0.5, clearanceHeight: 18, stepover: 0.25, tolerance: 0.03, leadAngle: 8,
    },
  });
  return cached;
}

function machineOf(tcp, tweak = (r) => r) {
  return createMachine({
    kind: 'mill', name: `trunnion ${tcp}`, rotary: tweak(rotaryPreset('AC')), tcp,
  });
}

function fiveSetup(extra = {}) {
  const setup = createSetup();
  setup.five = { enabled: true, pivot: [4, -3, -60], signChecked: true };
  return Object.assign(setup, extra);
}

function post(tcp, { machine = machineOf(tcp), setup = fiveSetup(), cl = program(), dialect = 'linuxcnc' } = {}) {
  const ops = [{
    name: 'finish', cl, wcs: 'G54', setup: setup.id, setupName: setup.name,
    orientation: null, wrap: null, five: fiveFor(setup, machine, cl),
  }];
  const { text, lineMap } = buildGcode(dialect, ops, { programName: 'five', arcs: true });
  return { text, lineMap, ops, machine };
}

const lines = (text) => text.split('\n');

/**
 * The motion blocks of the file with the mode each is written in. G0 and G1 are
 * modal, so a block that is only `X-2.5 Z1.03 F900` is a cut because of the G1
 * a few lines up — the thing a reader of the file has to track too.
 */
function motions(text) {
  const out = [];
  let mode = null;
  for (const l of lines(text)) {
    if (!l || l.startsWith('(')) continue;
    const g = l.match(/^G([01])(\s|$)/);
    if (g) mode = Number(g[1]);
    else if (/^[GTM]\d/.test(l)) continue;           // a mode word, a tool, a stop: not a move
    if (mode == null || !/\b[XYZAC]-?\d/.test(l)) continue;
    out.push({ mode, line: l });
  }
  return out;
}
const cutting = (text) => motions(text).filter((m) => m.mode === 1).map((m) => m.line);

for (const tcp of ['kins', 'g43.4', 'none']) {
  test(`${tcp}: the posted file read back through the machine is the toolpath it came from`, () => {
    if (tcp === 'none') { assert.throws(() => post(tcp)); return; }
    const { text, lineMap, ops } = post(tcp);
    const check = checkPost({ ops, text, lineMap });
    assert.ok(check, 'there was something to check');
    assert.ok(check.over <= 0, `the tip is ${check.worst.toFixed(3)}mm off the path (allowed ${check.ops[0].allowed.toFixed(3)})`);
    assert.ok(check.axisOver <= 0, `the spindle direction is ${check.axisWorst.toFixed(2)}° off`);
    // and the check has teeth: it did see a tilted program
    const parsed = parseGcode(text, { kinematics: ops[0].five });
    const back = clFromGcode(parsed).cl;
    assert.eq(back.fiveAxis, true, 'the read-back program leans the tool');
    assert.eq(parsed.unsupported.length, 0, JSON.stringify(parsed.unsupported));
  });

  test(`${tcp}: no arcs, no cycles, rotary words on the cutting blocks, and the table ends at zero`, () => {
    if (tcp === 'none') { assert.throws(() => post(tcp)); return; }
    const { text } = post(tcp);
    assert.ok(!/\bG[23] /.test(text), 'no arcs in a 5-axis operation');
    assert.ok(!/^G8[1-9]/m.test(text), 'no canned cycles');
    const cuts = cutting(text);
    assert.ok(cuts.length > 100, `${cuts.length} cutting blocks`);
    assert.ok(cuts.filter((l) => /\bA-?[\d.]+/.test(l) || /\bC-?[\d.]+/.test(l)).length > cuts.length / 2,
      'rotary words ride on the cutting blocks');
    // the last A and C written are zero
    const last = (letter) => [...text.matchAll(new RegExp(`\\b${letter}(-?[\\d.]+)`, 'g'))].pop();
    assert.eq(Number(last('A')[1]), 0, 'A ends at zero');
    assert.eq(Number(last('C')[1]), 0, 'C ends at zero');
  });
}

test('kins writes tool-tip coordinates and no mode words', () => {
  const { text } = post('kins');
  assert.ok(!/G43\.4/.test(text) && !/G93/.test(text));
  assert.ok(/trt kinematics/.test(text), 'it says what it assumes of the control');
});

test('g43.4 turns tool-centre-point on before the first rotary move, and the length offset back on after', () => {
  const { text } = post('g43.4');
  const all = lines(text);
  const on = all.findIndex((l) => /^G43\.4 H3/.test(l));
  assert.ok(on > 0, 'G43.4 H3 is written');
  const firstRotary = all.findIndex((l) => /\b[AC]-?[\d.]+/.test(l) && /^G[01] /.test(l));
  assert.ok(on < firstRotary, 'before any rotary word');
  const off = all.findIndex((l) => l === 'G49' && all.indexOf(l) > on);
  assert.ok(off > firstRotary, 'cancelled after');
  assert.eq(all[off + 1], 'G43 H3', 'and the plain length offset restored');
  assert.eq(all.filter((l) => /^G43\.4/.test(l)).length, 1, 'once');
});

test('without tool-centre-point it is inverse time, in machine axes, and G94 comes back', () => {
  const { text } = post('none', { cl: simpleFivePath() });
  const all = lines(text);
  assert.ok(all.includes('G93'), 'inverse time on');
  assert.ok(all.lastIndexOf('G94') > all.indexOf('G93'), 'and off again');
  const cuts = cutting(text);
  assert.ok(cuts.every((l) => /\bF[\d.]+/.test(l)), 'every cutting block states its own duration');
  // the pivot is 60 below the datum, so the machine's Z is not the tip's Z where the table is tilted
  const tip = post('kins').text;
  assert.ok(cutting(tip).join('\n') !== cuts.join('\n'), 'the axes are not the tip coordinates');
});

test('the angles stay continuous and inside the axis limits', () => {
  const { text } = post('kins');
  let a = 0;
  let c = 0;
  let worst = 0;
  for (const { mode, line: l } of motions(text)) {
    const na = l.match(/\bA(-?[\d.]+)/);
    const nc = l.match(/\bC(-?[\d.]+)/);
    // rapids are allowed to swing the table at clearance; cutting blocks are not
    const jump = Math.max(na ? Math.abs(Number(na[1]) - a) : 0, nc ? Math.abs(Number(nc[1]) - c) : 0);
    if (mode === 1) worst = Math.max(worst, jump);
    if (na) a = Number(na[1]);
    if (nc) c = Number(nc[1]);
    assert.ok(Math.abs(a) <= 120 && Math.abs(c) <= 360, `${l} is past a limit`);
  }
  assert.ok(worst < 20, `an axis jumps ${worst}° in one cutting block`);
});

test('no block swings the spindle more than a couple of degrees', () => {
  const { text } = post('kins');
  let a = 0;
  let worst = 0;
  for (const l of lines(text).filter((x) => /^G[01] /.test(x))) {
    const na = l.match(/\bA(-?[\d.]+)/);
    if (na) { worst = Math.max(worst, Math.abs(Number(na[1]) - a)); a = Number(na[1]); }
  }
  assert.ok(worst <= 2.6, `A moves ${worst}° in a block`);
});

test('an axis that counts the other way is written negated, and still reads back as the same path', () => {
  const flipped = machineOf('kins', (r) => r.map((x) => (x.letter === 'A' ? { ...x, sign: -1 } : x)));
  const plain = post('kins');
  const mirrored = post('kins', { machine: flipped });
  const aOf = (text) => cutting(text).map((l) => l.match(/\bA(-?[\d.]+)/)).filter(Boolean).map((m) => Number(m[1]));
  const a = aOf(plain.text);
  const b = aOf(mirrored.text);
  // the limits are symmetric, so the mirrored file is the same angles with A negated
  assert.ok(b.length > 100);
  assert.ok(b.every((v, i) => Math.abs(v + a[i]) < 1e-3 || Math.abs(v) < 1e-3), 'A is negated');
  const check = checkPost({ ops: mirrored.ops, text: mirrored.text, lineMap: mirrored.lineMap });
  assert.ok(check.axisOver <= 0, `reads back ${check.axisWorst.toFixed(1)}° off`);
  // read with the *wrong* machine, the same file is caught: the check has teeth
  const wrong = parseGcode(mirrored.text, { kinematics: plain.ops[0].five });
  const clWrong = clFromGcode(wrong).cl;
  assert.ok(clWrong.fiveAxis);
  const tampered = checkPost({
    ops: [{ ...mirrored.ops[0], five: plain.ops[0].five }], text: mirrored.text, lineMap: mirrored.lineMap,
  });
  assert.ok(tampered.axisOver > 0 || tampered.over > 0, 'a mirrored axis does not read back as the toolpath');
});

test('a 3-axis program posts exactly as before: no rotary words, no 5-axis machinery', () => {
  const mesh = makeBox(20, 20, 8);
  const stock = { kind: 'box', min: [0, 0, 0], max: [20, 20, 10] };
  const cl = generateToolpath({
    type: 'face', name: 'face', tool: { ...BALL, type: 'flat' }, mesh, stock,
    params: {
      ...defaultParamsFor('face', { stock, tool: BALL }),
      topZ: 10, bottomZ: 9, clearanceHeight: 18,
    },
  });
  assert.eq(cl.fiveAxis, false);
  const setup = createSetup();
  const base = { name: 'face', cl, wcs: 'G54', setup: setup.id, setupName: setup.name, orientation: null, wrap: null };
  const without = buildGcode('linuxcnc', [base], { programName: 'x' }).text;
  const withNull = buildGcode('linuxcnc', [{ ...base, five: null }], { programName: 'x' }).text;
  assert.eq(withNull, without);
  assert.ok(!/\b[ABC]-?\d/.test(without.replace(/\(.*\)/g, '')), 'no rotary words');
});

test('a setup that has not switched 5-axis on, an indexed one, and a machine without a trunnion are not posted', () => {
  const off = createSetup();                       // five: null
  let r = post('kins', { setup: off });
  assert.ok(/5-AXIS OPERATION NOT POSTED/.test(r.text), 'not switched on');
  assert.eq(cutting(r.text).length, 0, 'and no moves written in its place');

  const indexed = fiveSetup({ index: { enabled: true } });
  r = post('kins', { setup: indexed });
  assert.ok(/also indexed/.test(r.text));
  assert.eq(cutting(r.text).length, 0);

  const threeAxis = createMachine({ kind: 'mill', name: 'router', rotary: [] });
  r = post('kins', { machine: threeAxis });
  assert.ok(/NOT POSTED/.test(r.text) && /no rotary axes/.test(r.text));
  assert.eq(cutting(r.text).length, 0);
});

test('a control with no tool-centre-point and no pivot is refused rather than guessed at', () => {
  const setup = fiveSetup();
  setup.five.pivot = null;
  const r = post('none', { setup });
  assert.ok(/rotary centre/.test(r.text), r.text.slice(0, 400));
  assert.eq(cutting(r.text).length, 0);
});

test('a post that cannot write 5-axis moves says so instead of writing XYZ and hoping', () => {
  const r = post('kins', { dialect: 'grbl' });
  assert.ok(/NOT POSTED/.test(r.text), 'GRBL has no 5-axis');
  assert.eq(cutting(r.text).length, 0);
  // and the read-back check does not call a deliberate omission a bug
  const check = checkPost({ ops: r.ops, text: r.text, lineMap: r.lineMap });
  assert.ok(!check || check.over <= 0);
});

test('the program ends upright at clearance, so what follows it starts from a known place', () => {
  const { text } = post('kins');
  const all = motions(text);
  const tail = all[all.length - 1].line;
  assert.ok(/\bC0\b/.test(tail) || /\bA0\b/.test(tail), `the last block: ${tail}`);
  // the first move of the CL is upright and so is the last, and the last is a rapid
  const cl = program();
  const tilt = (n) => Math.hypot(cl.moves[n * MOVE_STRIDE + 4], cl.moves[n * MOVE_STRIDE + 5]);
  assert.close(tilt(0), 0, 1e-9);
  assert.close(tilt(cl.count - 1), 0, 1e-9);
  assert.eq(cl.moves[(cl.count - 1) * MOVE_STRIDE], OP.RAPID);
});

test('a program that winds the turntable round every pass is unwound between them, not run into its stop', () => {
  // each row sweeps the lean once and three quarters round (270° of azimuth) and the next
  // begins back at zero. Taking the nearest way each time the turntable gains a turn a
  // pass; six passes would be 1800° and C only has ±360.
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  const lean = (deg, az) => [
    Math.sin(deg * Math.PI / 180) * Math.cos(az * Math.PI / 180),
    Math.sin(deg * Math.PI / 180) * Math.sin(az * Math.PI / 180),
    Math.cos(deg * Math.PI / 180),
  ];
  for (let row = 0; row < 6; row++) {
    const y = row * 2;
    cl.setAxis(...lean(20, 0));
    cl.rapid(0, y, 18);
    cl.rapid(0, y, 6);
    for (let k = 0; k <= 54; k++) {
      cl.setAxis(...lean(20, k * 5));
      cl.cut(k * 0.3, y, 5, FEED.CUT);
    }
    cl.rapid(16, y, 18);
  }
  cl.setAxis(0, 0, 1);
  cl.rapid(16, 10, 18);
  const program2 = cl.finish();
  const r = post('kins', { cl: program2 });
  let c = 0;
  let worst = 0;
  for (const { mode, line: l } of motions(r.text)) {
    const nc = l.match(/\bC(-?[\d.]+)/);
    if (!nc) continue;
    const v = Number(nc[1]);
    if (mode === 1) worst = Math.max(worst, Math.abs(v - c));
    c = v;
    assert.ok(Math.abs(v) <= 360, `C${v} is past its stop`);
  }
  assert.ok(worst < 12, `a cutting block turns C ${worst}°`);
  assert.ok(!/WARNING/.test(r.text), r.text.split('\n').filter((l) => /WARNING/.test(l)).join(' | '));
});

function simpleFivePath() {
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(0, 0, 20);
  cl.setAxis(0, -0.5, Math.sqrt(0.75));
  cl.rapid(0, 0, 20);
  cl.cut(0, 0, 5, FEED.CUT);
  cl.setAxis(0, -Math.sin(0.6), Math.cos(0.6));
  cl.cut(10, 0, 5, FEED.CUT);
  cl.rapid(10, 0, 20);
  cl.setAxis(0, 0, 1); cl.rapid(10, 0, 20);
  return cl.finish();
}
test('unreachable five-axis poses fail with operation and source move', () => {
  const machine = machineOf('kins', axes => axes.map(a => ({ ...a, min: -1, max: 1 })));
  try { post('kins', { machine, cl: simpleFivePath() }); throw new Error('export succeeded'); }
  catch (e) {
    assert.eq(e.code, 'FIVE_AXIS_UNREACHABLE');
    assert.eq(e.finding.operation, 'finish');
    assert.ok(Number.isInteger(e.finding.move));
  }
});
test('non-TCP rejects unresolved interpolation error with numeric evidence', () => {
  try { post('none'); throw new Error('export succeeded'); }
  catch(e) { assert.eq(e.code, 'FIVE_AXIS_TOLERANCE'); assert.ok(e.finding.error > e.finding.tolerance); }
});
test('valid non-TCP path still round trips through machine coordinates', () => {
  const {text,lineMap,ops}=post('none', {cl:simpleFivePath()});
  const result=checkPost({ops,text,lineMap});
  assert.ok(result.over <= 0, JSON.stringify(result)); assert.ok(result.axisOver <= 0, JSON.stringify(result));
});
