// Indexed multi-axis milling — 3+1 and 3+2.
//
// Two halves, matching where the feature lives: the orientation maths in
// engine/indexing.js (which way the spindle points, what the rotaries must be
// set to, and whether a machine can reach a face at all), and the post, which
// wraps an ordinary toolpath in the tilted work plane that maths describes.
//
// The load-bearing checks are the invariants a bug would break silently:
//   * a solved rotary set really carries the face normal to +Z (reconstructed,
//     not trusted) — a sign error becomes a failed test, not a wrong swing;
//   * an indexed setup on the face that is already up posts *byte-for-byte* like
//     a plain one — the feature costs nothing when it is not tilting anything;
//   * a plain program gains no G68.2/G53.1/G69 — the change is invisible until
//     a setup asks for it.

import { test, assert } from './runner.js';
import {
  toolAxis, tiltAngle, solveRotary, applyRotary, eulerFor, indexKind, rotaryAxes,
  orientationFor, orientationKey, indexingWarnings, isIndexed,
} from '../engine/indexing.js';
import { createMachine, defaultMachines } from '../doc/machines.js';
import { rotationMatrix, applyMatrix, transposeMatrix } from '../engine/setup.js';
import { createSetup } from '../doc/schema.js';
import { generateToolpath, MILLING_OPS, BOTH_MACHINES } from '../engine/toolpath.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { eachMove, OP, FEED } from '../engine/cl.js';
import { buildGcode } from '../post/index.js';
import { makeBox, makeTube, makePocketBlock } from './fixtures.js';

const TOOL = { number: 3, diameter: 6, spindleRpm: 9000, feedCut: 800, feedPlunge: 300 };

const TRUNNION = createMachine({
  name: '5-axis trunnion', kind: 'mill',
  rotary: [
    { letter: 'A', axis: [1, 0, 0], min: -120, max: 120 },
    { letter: 'C', axis: [0, 0, 1], min: -360, max: 360 },
  ],
});
const FOUR_AXIS = createMachine({
  name: '4-axis', kind: 'mill',
  rotary: [{ letter: 'A', axis: [1, 0, 0], min: -120, max: 120 }],
});
const THREE_AXIS = createMachine({ name: '3-axis', kind: 'mill', rotary: [] });

function closeVec(a, b, eps, msg = '') {
  for (let i = 0; i < 3; i++) assert.close(a[i], b[i], eps, `${msg} [${i}]`);
}

// --- orientation maths --------------------------------------------------------

test('the tool axis of the face that is already up is +Z', () => {
  closeVec(toolAxis([0, 0, 0]), [0, 0, 1], 1e-9, 'identity');
  // spinning about Z alone never tips the tool off vertical
  closeVec(toolAxis([0, 0, 37]), [0, 0, 1], 1e-9, 'pure C');
  assert.eq(tiltAngle([0, 0, 0]), 0);
});

test('tilting the setup tilts the tool axis the same way the mesh was turned', () => {
  // engine/setup.js rotates the model +90° about X so a +Y face points up; the
  // spindle then points along +Y in the part frame.
  closeVec(toolAxis([90, 0, 0]), [0, 1, 0], 1e-9, 'A90 → +Y');
  closeVec(toolAxis([0, 90, 0]), [-1, 0, 0], 1e-9, 'B90 → −X');
  assert.close(tiltAngle([90, 0, 0]), 90, 1e-9, 'a 90° tilt is 90° off vertical');
  assert.close(tiltAngle([45, 0, 0]), 45, 1e-9);
});

test('a solved rotary set really lays the face normal on +Z', () => {
  // The check is reconstruction, not the formula: rebuild the table rotation
  // from the angles and confirm it carries the tool axis to straight up.
  const orientations = [
    [0, 0, 0], [90, 0, 0], [0, 90, 0], [45, 0, 30], [30, 20, 0], [-60, 15, 10],
  ];
  for (const r of orientations) {
    const solved = solveRotary(r, TRUNNION);
    assert.ok(solved.reachable, `A/C should reach ${r}`);
    const landed = applyRotary(rotaryAxes(TRUNNION), solved.angles, toolAxis(r));
    closeVec(landed, [0, 0, 1], 1e-9, `${r} lands upright`);
  }
});

test('a B/C trunnion reaches every face too, by the same reconstruction', () => {
  // The A/C family is not the only one — a B-tilt with a C turntable is just as
  // common, and the solver must land it on +Z the same way.
  const bc = createMachine({
    name: 'B/C trunnion', kind: 'mill',
    rotary: [
      { letter: 'B', axis: [0, 1, 0], min: -120, max: 120 },
      { letter: 'C', axis: [0, 0, 1], min: -360, max: 360 },
    ],
  });
  for (const r of [[0, 90, 0], [90, 0, 0], [40, 15, 0], [-30, 25, 60], [0, -90, 0]]) {
    const solved = solveRotary(r, bc);
    assert.ok(solved.reachable, `B/C should reach ${r}`);
    closeVec(applyRotary(rotaryAxes(bc), solved.angles, toolAxis(r)), [0, 0, 1], 1e-9,
      `${r} lands upright on B/C`);
  }
});

test('a malformed rotary machine degrades rather than throwing', () => {
  // Two tilt axes and no turntable, a lone Z, an empty list: none is a machine we
  // ship, but a hand-edited project file could hold one, and it must refuse the
  // orientation cleanly instead of crashing the post.
  const weird = [
    { name: 'A+B', rotary: [{ letter: 'A', axis: [1, 0, 0] }, { letter: 'B', axis: [0, 1, 0] }] },
    { name: 'C only', rotary: [{ letter: 'C', axis: [0, 0, 1] }] },
    { name: 'garbage axis', rotary: [{ letter: 'A', axis: [0, 0, 0] }] },
  ];
  for (const w of weird) {
    const machine = createMachine({ kind: 'mill', ...w });
    const solved = solveRotary([50, 20, 0], machine);
    assert.ok(typeof solved.reachable === 'boolean', `${w.name}: an answer, not a throw`);
    assert.ok(!Number.isNaN(solved.tilt), `${w.name}: a finite tilt`);
  }
});

test('3+1 reaches a face on its swing plane and refuses one off it', () => {
  // The A axis tips about X, so it reaches a face tilted in the Y-Z plane…
  const onPlane = solveRotary([40, 0, 0], FOUR_AXIS);
  assert.ok(onPlane.reachable, 'a Y-Z tilt is reachable on a single A axis');
  closeVec(applyRotary(rotaryAxes(FOUR_AXIS), onPlane.angles, toolAxis([40, 0, 0])),
    [0, 0, 1], 1e-9, 'and it lands upright');
  // …but not one tipped sideways about Y, which needs a second axis.
  const offPlane = solveRotary([0, 40, 0], FOUR_AXIS);
  assert.ok(!offPlane.reachable, 'a sideways tilt needs a turntable this machine lacks');
  assert.ok(/cannot orient|3\+1|rotary/i.test(offPlane.reason ?? ''), 'and it says why');
});

test('a 3-axis machine can only cut the face that points up', () => {
  assert.ok(solveRotary([0, 0, 0], THREE_AXIS).reachable, 'the top face is fine');
  const tilted = solveRotary([90, 0, 0], THREE_AXIS);
  assert.ok(!tilted.reachable, 'anything tilted is out of reach');
  assert.ok(/3-axis/.test(tilted.reason ?? ''), `and it says so, got: ${tilted.reason}`);
});

test('a swing past the axis travel is caught before the machine finds it', () => {
  // A straight flip needs A180, and the cradle only reaches ±120.
  const flip = solveRotary([180, 0, 0], TRUNNION);
  assert.ok(!flip.reachable, 'A180 is past the ±120 cradle');
  assert.ok(flip.overTravel?.includes('A'), 'and the axis is named');
  assert.ok(/travel/.test(flip.reason ?? ''), `with a reason, got: ${flip.reason}`);
});

test('indexKind counts the rotary axes', () => {
  assert.eq(indexKind(THREE_AXIS), '3-axis');
  assert.eq(indexKind(FOUR_AXIS), '3+1');
  assert.eq(indexKind(TRUNNION), '3+2');
});

test('the tilted-plane Euler angles undo the rotation the mesh was turned through', () => {
  // One description of the tilt, stated backwards: engine/setup.js turned the
  // part until the face pointed up, and G68.2 turns the programmed coordinates
  // the other way, back out to the datum.
  assert.eq(eulerFor([90, 0, 0]).join(), '-90,0,0');
  // and the other way is not three minus signs — Rz·Ry·Rx transposed is
  // Rx·Ry·Rz, a different order, so a mixed turn comes back on all three axes
  assert.eq(eulerFor([45, 0, 30]).join(), '-40.893,-20.705,-22.208');
});

test('orientationFor describes an indexed setup and ignores a plain one', () => {
  const plain = createSetup('Top');
  assert.eq(orientationFor(plain, TRUNNION), null, 'a plain setup posts flat');
  assert.ok(!isIndexed(plain));

  const idx = createSetup('Front');
  idx.orientation.rotationDeg = [90, 0, 0];
  idx.index = { enabled: true };
  assert.ok(isIndexed(idx));
  const o = orientationFor(idx, TRUNNION);
  assert.ok(o && o.reachable, 'reachable on the trunnion');
  closeVec(o.toolAxis, [0, 1, 0], 1e-9, 'tool axis carried through');
  assert.eq(o.kind, '3+2');
  assert.ok(!o.identity, 'a tilted face is not the identity');
});

test('the top face of an indexed setup is the identity — no swing needed', () => {
  const idx = createSetup('Top, on the rotary table');
  idx.index = { enabled: true };                 // rotationDeg stays [0,0,0]
  const o = orientationFor(idx, TRUNNION);
  assert.ok(o.identity, 'nothing to tilt');
  assert.eq(orientationKey(o), orientationKey(orientationFor(idx, FOUR_AXIS)),
    'the identity is the same however many axes the machine has');
});

test('indexing warnings fire only for a setup the machine cannot reach', () => {
  const front = createSetup('Front');
  front.orientation.rotationDeg = [90, 0, 0];
  front.index = { enabled: true };
  const top = createSetup('Top');
  top.index = { enabled: true };

  assert.eq(indexingWarnings(TRUNNION, [front, top]).length, 0, 'the trunnion reaches both');
  assert.eq(indexingWarnings(THREE_AXIS, [top]).length, 0, 'the top face needs no rotary');
  const warned = indexingWarnings(THREE_AXIS, [front, top]);
  assert.eq(warned.length, 1, 'only the tilted face on a 3-axis machine warns');
  assert.ok(/Front/.test(warned[0].text), 'and it names the setup');
});

test('the stock rack ships a 4-axis and a 5-axis mill', () => {
  const mills = defaultMachines().filter((m) => m.kind === 'mill');
  const kinds = mills.map((m) => indexKind(m));
  assert.ok(kinds.includes('3+1'), 'a 4-axis preset');
  assert.ok(kinds.includes('3+2'), 'a 5-axis preset');
  // every preset's rotary list survives createMachine as unit vectors
  for (const m of mills) {
    for (const a of rotaryAxes(m)) {
      assert.close(Math.hypot(...a.axis), 1, 1e-9, `${m.name} ${a.letter} is a unit axis`);
    }
  }
});

// --- posting an indexed program ----------------------------------------------

/** A contour of a box, as one op on a given setup/orientation. */
function contourOp(name, setup, machine, mesh = makeBox(20, 20, 5)) {
  const cl = generateToolpath({
    type: 'contour2d', name, tool: TOOL, mesh,
    stock: { min: [0, 0, 0], max: [20, 20, 5] },
    params: {
      topZ: 5, bottomZ: 0, stepdown: 2, clearanceHeight: 15,
      stockToLeave: 0, tolerance: 0.01, rampAngle: 0,
    },
  });
  return {
    name, cl, wcs: setup.wcs, setup: setup.id, setupName: setup.name,
    orientation: orientationFor(setup, machine),
  };
}

function indexedSetup(name, rotationDeg) {
  const s = createSetup(name);
  s.orientation.rotationDeg = rotationDeg;
  s.index = { enabled: true };
  return s;
}

test('a plain milling program gains no tilted-plane words', () => {
  // The regression guard: nothing about indexing may touch a 3-axis file.
  const s = createSetup('Top');
  const { text } = buildGcode('linuxcnc', [contourOp('cut', s, THREE_AXIS)]);
  assert.ok(!/G68\.2|G53\.1|G69/.test(text), `no tilt words, got:\n${text.slice(0, 200)}`);
});

test('an indexed setup on the face that is up posts byte-for-byte like a plain one', () => {
  // The strongest statement of "costs nothing when it tilts nothing": the
  // identity orientation must reproduce the plain file exactly.
  const plain = createSetup('Top');
  const idx = createSetup('Top');
  idx.id = plain.id;                             // same names in the file
  idx.index = { enabled: true };
  const a = buildGcode('linuxcnc', [contourOp('cut', plain, THREE_AXIS)]).text;
  const b = buildGcode('linuxcnc', [contourOp('cut', idx, TRUNNION)]).text;
  assert.eq(a, b, 'identical output');
});

test('a tilted face is posted as a tilted work plane', () => {
  const { text } = buildGcode('linuxcnc', [contourOp('front', indexedSetup('Front', [90, 0, 0]), TRUNNION)]);
  assert.ok(/G68\.2 X0 Y0 Z0 I-90 J0 K0/.test(text), `plane declared, got:\n${text}`);
  assert.ok(/G53\.1/.test(text), 'and the tool is oriented to it');
  assert.ok(/index 3\+2: tool axis 0 1 0 — A90 C0/.test(text), 'with a human-readable note');
  assert.ok(/G69/.test(text), 'and the plane is cancelled before the program ends');
  // the plane comes before any cutting move
  assert.ok(text.indexOf('G68.2') < text.indexOf('G1 '), 'declared before the first cut');
  assert.ok(!/undefined|NaN/.test(text), 'no formatting garbage');
});

test('a work plane is stated once for a face and cancelled once when it changes', () => {
  const front = indexedSetup('Front', [90, 0, 0]);
  const side = indexedSetup('Side', [0, 90, 0]);
  const ops = [
    contourOp('front rough', front, TRUNNION),
    contourOp('front finish', front, TRUNNION),  // same face — restates nothing
    contourOp('side rough', side, TRUNNION),      // new face — reorients
  ];
  const { text } = buildGcode('linuxcnc', ops);
  assert.eq((text.match(/G68\.2/g) || []).length, 2, 'one plane per face, not per op');
  assert.eq((text.match(/G53\.1/g) || []).length, 2, 'oriented once per face');
  // two indexed faces on one fixturing swing automatically: no operator stop
  assert.ok(!/^M0$/m.test(text), `no re-fixture stop between indexed faces, got:\n${text}`);
  // the second face cancels the first before declaring itself
  const secondPlane = text.indexOf('I0 J-90 K0');
  const cancelBefore = text.lastIndexOf('G69', secondPlane);
  assert.ok(cancelBefore >= 0 && cancelBefore < secondPlane, 'G69 before the new plane');
});

test('crossing from an indexed setup to a plain one re-fixtures and cancels the plane', () => {
  const front = indexedSetup('Front', [90, 0, 0]);
  const plain = createSetup('Back in the vice');
  const ops = [
    contourOp('front', front, TRUNNION),
    contourOp('flat', plain, TRUNNION),
  ];
  const { text } = buildGcode('linuxcnc', ops);
  assert.ok(/^M0$/m.test(text), 'a plain setup is a genuine re-fixturing — it stops');
  // and the tilt is gone before the flat operation cuts
  const flatStart = text.indexOf('operation: flat');
  const firstFlatCut = flatStart + text.slice(flatStart).search(/\nG1 /);
  assert.ok(text.lastIndexOf('G69', firstFlatCut) >= 0, 'plane cancelled before the flat op cuts');
  assert.ok(!/G68\.2/.test(text.slice(flatStart)), 'the flat op has no plane');
});

test('a post that cannot tilt refuses an indexed op instead of faking it', () => {
  // GRBL has no tilted work plane. Posting a tilt as flat moves would cut the
  // wrong thing, so it warns loudly and the reader is told not to run it.
  const { text } = buildGcode('grbl', [contourOp('front', indexedSetup('Front', [90, 0, 0]), TRUNNION)]);
  assert.ok(!/G68\.2|G53\.1/.test(text), 'no tilt words it does not support');
  assert.ok(/NOT indexed|cannot orient a tilted/i.test(text), `and a warning, got:\n${text}`);
  assert.ok(/G1 /.test(text), 'the moves are still written (the warning is above them)');
});

test('an orientation the machine cannot reach is flagged in the file', () => {
  // A sideways tilt on a single-A machine: the swing would alarm. The post is
  // handed reachable:false and says so where the operator will see it.
  const { text } = buildGcode('linuxcnc', [contourOp('side', indexedSetup('Side', [0, 90, 0]), FOUR_AXIS)]);
  assert.ok(/WARNING/.test(text), `an unreachable swing warns, got:\n${text}`);
  assert.ok(/alarm|gouge|reach|rotary/i.test(text), 'with a reason');
});

test('every milling operation runs and posts inside a tilted frame', () => {
  // "3+2 with operations": the ordinary strategies compute on the rotated mesh
  // and the post wraps them. Each must produce real cutting and a valid file.
  const front = indexedSetup('Front', [45, 0, 0]);
  const cases = [
    {
      type: 'face', mesh: makeBox(30, 30, 6),
      params: { topZ: 6, bottomZ: 5, stepover: 0.6, stepdown: 1.5, clearanceHeight: 16, pattern: 'zigzag', stockToLeave: 0 },
    },
    {
      type: 'pocket', mesh: makePocketBlock({ size: 40, pocketSize: 20, height: 10, depth: 6 }).mesh,
      params: { topZ: 10, bottomZ: 4, stepdown: 2, stepover: 0.4, clearanceHeight: 20, rampAngle: 3, stockToLeave: 0, tolerance: 0.01 },
    },
    {
      type: 'drill', mesh: makeTube(15, 10, 10, 3, 8),
      params: { topZ: 8, bottomZ: -1, clearanceHeight: 15, entryGap: 2, peck: 2 },
    },
  ];
  for (const c of cases) {
    const cl = generateToolpath({
      type: c.type, name: c.type, tool: TOOL,
      mesh: c.mesh, stock: { min: [0, 0, 0], max: [40, 40, 10] }, params: c.params,
    });
    assert.ok(cl.count > 0, `${c.type} produced motion`);
    const op = {
      name: c.type, cl, wcs: front.wcs, setup: front.id, setupName: front.name,
      orientation: orientationFor(front, TRUNNION),
    };
    const { text } = buildGcode('linuxcnc', [op]);
    assert.ok(/G68\.2 X0 Y0 Z0 I-45 J0 K0/.test(text), `${c.type} posts in the tilted plane`);
    // the first cut is a G1 (face/pocket) or a canned cycle (drill); either way
    // the plane must be declared before it. The header's own G80 is mid-line, so
    // anchoring the search to a line start keeps it out of the way.
    const firstCut = text.search(/\n(G1 |G98 )/);
    assert.ok(firstCut >= 0 && text.indexOf('G68.2') < firstCut,
      `${c.type} tilts before it cuts`);
    assert.ok(/G69/.test(text), `${c.type} cancels the plane`);
    assert.ok(!/undefined|NaN/.test(text), `${c.type}: no formatting garbage`);
  }
});

test('a tilted work plane never leaks past the program', () => {
  // Whatever the last operation left tilted, the file ends flat: G69 stands
  // before M2, so the next program on the machine reads its coordinates square.
  const { text } = buildGcode('linuxcnc', [contourOp('front', indexedSetup('Front', [90, 0, 0]), TRUNNION)]);
  const lines = text.trimEnd().split('\n');
  const lastCancel = lines.lastIndexOf('G69');
  const end = lines.indexOf('M2');
  assert.ok(lastCancel >= 0 && lastCancel < end, 'G69 before M2');
});

// --- the adversarial sweep -----------------------------------------------------
//
// Every milling strategy, run tilted, against the one property that must hold
// however the geometry comes out: indexing changes *nothing* about the toolpath.
// The strategy computed on the rotated mesh, the post wraps it — so the cutting
// moves an operation writes tilted are the cutting moves it writes flat, to the
// byte. Anything else means the tilt leaked into the toolpath, which is the bug
// the whole design exists to make impossible.

const SWEEP_TOOLS = {
  flat: { number: 1, type: 'flat', diameter: 6, flutes: 2, fluteLength: 30, spindleRpm: 12000, feedCut: 800, feedPlunge: 250 },
  ball: { number: 2, type: 'ball', diameter: 4, flutes: 2, fluteLength: 30, spindleRpm: 12000, feedCut: 800, feedPlunge: 250 },
  drill: { number: 3, type: 'drill', diameter: 5, tipAngle: 118, flutes: 2, fluteLength: 30, spindleRpm: 3000, feedCut: 200, feedPlunge: 150 },
  vee: { number: 4, type: 'chamfer', diameter: 6, tipAngle: 90, tipDiameter: 0, flutes: 1, fluteLength: 10, spindleRpm: 10000, feedCut: 600, feedPlunge: 200 },
  // an M6 tap goes in the tube's ⌀5 bore, which is what its tapping drill leaves
  tap: { number: 5, type: 'tap', diameter: 6, pitch: 1, flutes: 3, fluteLength: 25, spindleRpm: 350, feedCut: 350, feedPlunge: 350 },
  // and a thread mill has to orbit inside the ⌀10 one
  threadMill: { number: 6, type: 'threadmill', diameter: 4, pitch: 1, flutes: 3, fluteLength: 20, spindleRpm: 5000, feedCut: 350, feedPlunge: 120 },
};
const SWEEP_BLOCK = makePocketBlock({ size: 40, pocketSize: 20, height: 20, depth: 12 });
const SWEEP_STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] };

/** Valid inputs for a milling strategy — the same shapes the sanity sweep uses,
 *  with a matching drilled/bored hole for the two ops that need one. */
function sweepInputs(type) {
  const tool = type === 'drill' ? SWEEP_TOOLS.drill
    : (type === 'chamfer' || type === 'engrave' || type === 'spot') ? SWEEP_TOOLS.vee
      : (type === 'parallel3d' || type === 'waterline') ? SWEEP_TOOLS.ball
        : type === 'tap' ? SWEEP_TOOLS.tap
          : type === 'threadMill' ? SWEEP_TOOLS.threadMill
            : SWEEP_TOOLS.flat;
  const mesh = (type === 'drill' || type === 'tap' || type === 'spot')
    ? makeTube(20, 20, 15, 2.5, 20)   // ⌀5 hole: the ⌀5 drill, and the M6 tap's drill
    : (type === 'bore' || type === 'threadMill') ? makeTube(20, 20, 15, 5, 20)
      : SWEEP_BLOCK.mesh;
  const params = {
    ...defaultParamsFor(type, { stock: SWEEP_STOCK, tool }),
    tolerance: 0.05, clearanceHeight: 40, clearanceX: 0, topZ: 20, bottomZ: 8,
  };
  if (type === 'drill' || type === 'bore') params.bottomZ = 0;
  return { tool, mesh, params };
}

/** The feed moves (G1/G2/G3) of a posted program — the toolpath itself. */
function feedMoves(text) {
  return text.split('\n').filter((l) => /^(G1|G2|G3)\b/.test(l));
}

test('indexing leaves every milling toolpath byte-for-byte unchanged', () => {
  const orientations = [[90, 0, 0], [0, 90, 0], [45, 0, 30], [179.999, 0, 0]];
  for (const type of MILLING_OPS) {
    // A command emits no moves at all — it is lines of G-code, not a cut — so
    // there is no toolpath for indexing to leave unchanged. See BOTH_MACHINES.
    if (BOTH_MACHINES.has(type)) continue;
    const { tool, mesh, params } = sweepInputs(type);
    const cl = generateToolpath({ type, name: type, tool, mesh, stock: SWEEP_STOCK, params, fixtures: [] });
    assert.ok(cl.count > 0, `${type} must cut something on the sweep fixture`);
    const plain = feedMoves(buildGcode('linuxcnc', [{ name: type, cl, wcs: 'G54' }]).text);
    for (const rot of orientations) {
      const s = indexedSetup(type, rot);
      const text = buildGcode('linuxcnc', [{
        name: type, cl, wcs: 'G54', setup: s.id, orientation: orientationFor(s, TRUNNION),
      }]).text;
      assert.ok(!/undefined|NaN/.test(text), `${type} @ ${rot}: no formatting garbage`);
      assert.eq(feedMoves(text).join('\n'), plain.join('\n'),
        `${type} @ ${rot}: the tilt changed the toolpath`);
      assert.ok(/G68\.2/.test(text) && /G53\.1/.test(text) && /G69/.test(text),
        `${type} @ ${rot}: plane declared, oriented and cancelled`);
    }
  }
});

test('every strategy, tilted, still produces a finite in-frame toolpath', () => {
  // The tilt is a post concern, but a strategy whose *rotated* mesh confused it
  // into a NaN would surface here rather than at the machine.
  for (const type of MILLING_OPS) {
    const { tool, mesh, params } = sweepInputs(type);
    const cl = generateToolpath({ type, name: type, tool, mesh, stock: SWEEP_STOCK, params, fixtures: [] });
    let bad = 0;
    eachMove(cl, (op, x, y, z) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) bad++;
    });
    assert.eq(bad, 0, `${type} emitted ${bad} non-finite moves`);
  }
});

test('the tool is retracted before every rotary swing', () => {
  // The table moves the work under a stationary tool, so it must be clear first.
  // The move immediately before every G53.1 is a rapid, never a feed — and the
  // retract height is the highest point any operation reaches, so it can only
  // ever lift, never plunge.
  const faces = [indexedSetup('A', [90, 0, 0]), indexedSetup('B', [0, 90, 0]), indexedSetup('C', [45, 0, 20])];
  const text = buildGcode('linuxcnc', faces.map((s, i) => contourOp(`face ${i}`, s, TRUNNION))).text;
  const lines = text.split('\n');
  let swings = 0;
  lines.forEach((line, i) => {
    if (line !== 'G53.1') return;
    swings++;
    let j = i - 1;
    while (j >= 0 && !/^(G0|G1|G2|G3)\b/.test(lines[j])) j--;
    assert.ok(j >= 0 && /^G0\b/.test(lines[j]),
      `swing at line ${i} is preceded by a rapid, not "${lines[j]}"`);
  });
  assert.eq(swings, 3, 'three faces, three swings');
});

test('a datum change re-establishes the tilted plane under the new offset', () => {
  // G68.2 is anchored to the active work offset, so two indexed faces that share
  // an angle but sit on different offsets (G54, then G55) must not keep the first
  // plane — it points at the wrong origin now. The plane is torn down and rebuilt.
  const a = indexedSetup('Face A', [90, 0, 0]); a.id = 'idx-a'; a.wcs = 'G54';
  const b = indexedSetup('Face B', [90, 0, 0]); b.id = 'idx-b'; b.wcs = 'G55';
  const opA = { ...contourOp('a', a, TRUNNION), wcs: 'G54' };
  const opB = { ...contourOp('b', b, TRUNNION), wcs: 'G55' };
  const text = buildGcode('linuxcnc', [opA, opB]).text;
  assert.eq((text.match(/G68\.2/g) || []).length, 2, 'the plane is restated under the new datum');
  const g55 = text.indexOf('\nG55');
  assert.ok(g55 >= 0 && text.indexOf('G68.2', g55) > g55, 'and it comes after the offset change');
  // torn down before rebuilt: a G69 sits between G55 and the second plane
  const secondPlane = text.indexOf('G68.2', g55);
  const cancel = text.lastIndexOf('G69', secondPlane);
  assert.ok(cancel > g55 && cancel < secondPlane, 'the stale plane is cancelled first');
});

test('a silent operation between two faces does not disturb the sequence', () => {
  // An operation that cut nothing (a drill that found no hole) writes no tool
  // change, no plane and no stop — and it must not swallow or duplicate the
  // reorientation that belongs to the real operations around it.
  const front = indexedSetup('Front', [90, 0, 0]);
  const side = indexedSetup('Side', [0, 90, 0]);
  const emptyDrill = generateToolpath({
    // a distinct tool number, so "no tool was fitted" is about this operation and
    // not confused with the contour's own T3
    type: 'drill', name: 'no hole', tool: { ...SWEEP_TOOLS.drill, number: 9 },
    mesh: makeBox(20, 20, 5), stock: { min: [0, 0, 0], max: [20, 20, 5] },
    params: { topZ: 5, bottomZ: 0, clearanceHeight: 15 },
  });
  assert.eq(emptyDrill.count, 0, 'the drill found no hole, so it is silent');
  const ops = [
    contourOp('front cut', front, TRUNNION),
    { name: 'no hole', cl: emptyDrill, wcs: side.wcs, setup: side.id, orientation: orientationFor(side, TRUNNION) },
    contourOp('side cut', side, TRUNNION),
  ];
  const text = buildGcode('linuxcnc', ops).text;
  assert.eq((text.match(/G68\.2/g) || []).length, 2, 'two real faces, two planes');
  assert.eq((text.match(/G69/g) || []).length, 2, 'each cancelled once');
  assert.ok(!/T9 M6/.test(text), 'the silent drill fitted no tool');
});

test('an over-travel swing warns but still writes the structure', () => {
  // A180 is past the ±120 cradle. The post cannot know the operator will not fix
  // the fixturing, so it writes the plane and marks it — a silent drop would be
  // a face quietly not machined.
  const { text } = buildGcode('linuxcnc', [contourOp('flip', indexedSetup('Flip', [180, 0, 0]), TRUNNION)]);
  assert.ok(/WARNING/.test(text), 'the unreachable swing is flagged');
  assert.ok(/G68\.2/.test(text), 'and the plane is still declared');
});

test('a program mixing plain and indexed setups fixtures at each boundary', () => {
  // Plain → indexed → plain: each crossing is a real re-fixturing (the part goes
  // on and off the rotary table), so each stops, and the tilted plane lives only
  // around the indexed run in the middle — declared after the first stop,
  // cancelled at the second.
  const plainA = createSetup('vice A'); plainA.wcs = 'G54';
  const tilt = indexedSetup('on the table', [90, 0, 0]); tilt.wcs = 'G55';
  const plainB = createSetup('vice B'); plainB.wcs = 'G56';
  const ops = [
    { ...contourOp('rough', plainA, THREE_AXIS), wcs: 'G54' },
    { ...contourOp('side', tilt, TRUNNION), wcs: 'G55' },
    { ...contourOp('finish', plainB, THREE_AXIS), wcs: 'G56' },
  ];
  const text = buildGcode('linuxcnc', ops).text;
  assert.eq((text.match(/^M0$/gm) || []).length, 2, 'two re-fixturing stops');
  assert.eq((text.match(/G68\.2/g) || []).length, 1, 'one plane, around the indexed run');
  assert.eq((text.match(/G69/g) || []).length, 1, 'cancelled once');
  // the plane sits between the two stops
  const plane = text.indexOf('G68.2');
  const stops = [...text.matchAll(/^M0$/gm)].map((m) => m.index);
  assert.ok(plane > stops[0] && plane < stops[1], 'the plane is the middle setup only');
});

test('a post that cannot tilt refuses every operation the same way', () => {
  // Not just contour: whatever the operation, GRBL writes no tilt words and warns.
  for (const type of ['face', 'pocket', 'drill', 'engrave']) {
    const { tool, mesh, params } = sweepInputs(type);
    const cl = generateToolpath({ type, name: type, tool, mesh, stock: SWEEP_STOCK, params, fixtures: [] });
    const s = indexedSetup(type, [90, 0, 0]);
    const text = buildGcode('grbl', [{
      name: type, cl, wcs: 'G54', setup: s.id, orientation: orientationFor(s, TRUNNION),
    }]).text;
    assert.ok(!/G68\.2|G53\.1|G69/.test(text), `${type}: no tilt words GRBL cannot honour`);
    assert.ok(/NOT indexed|cannot orient a tilted/i.test(text), `${type}: and a warning`);
  }
});

test('a head with two tilt axes reaches every face, in either order', () => {
  // Two perpendicular tilts span the sphere exactly as a tilt and a turntable
  // do — an A/B head is a 3+2 machine. The solver had a case for a tilt with a
  // turn and none for a tilt with a tilt, so it fell through to "A+B rotary
  // axes cannot orient this face" for every face on every part: a statement
  // about the solver dressed up as one about the geometry, and it left a whole
  // class of machine unable to index at all.
  const head = (order) => createMachine({
    name: order.join('+'), kind: 'mill',
    rotary: order.map((letter) => ({
      letter,
      axis: letter === 'A' ? [1, 0, 0] : [0, 1, 0],
      min: -120,
      max: 120,
    })),
  });
  for (const machine of [head(['A', 'B']), head(['B', 'A'])]) {
    assert.eq(indexKind(machine), '3+2', `${machine.name} has two rotaries`);
    for (const rot of [[30, 0, 0], [0, 30, 0], [25, -40, 0], [-15, 70, 35], [90, 0, 0], [0, -90, 0]]) {
      const s = solveRotary(rot, machine);
      assert.ok(s.reachable, `${machine.name} reaches ${rot}: ${s.reason}`);
      // the check that matters: swing the axes to those angles and the face
      // normal has to land on +Z, which is what "indexed" means
      closeVec(applyRotary(rotaryAxes(machine), s.angles, toolAxis(rot)), [0, 0, 1], 1e-9,
        `${machine.name} at ${rot}`);
    }
    // the face that is already up still needs no swing
    const flat = solveRotary([0, 0, 0], machine);
    assert.ok(flat.reachable && flat.tilt < 1e-9, 'the top face is the identity');
  }

  // and travel is still travel: a head that only nods 15° cannot reach 60°
  const stiff = createMachine({
    name: 'stiff head', kind: 'mill',
    rotary: [{ letter: 'A', axis: [1, 0, 0], min: -15, max: 15 },
      { letter: 'B', axis: [0, 1, 0], min: -15, max: 15 }],
  });
  const far = solveRotary([60, 0, 0], stiff);
  assert.ok(!far.reachable, 'refused');
  assert.ok(/past the axis travel/.test(far.reason ?? ''), far.reason);

  // two axes about the same line are not a pair of tilts, and saying so is
  // better than answering it wrongly
  const doubled = createMachine({
    name: 'two A axes', kind: 'mill',
    rotary: [{ letter: 'A', axis: [1, 0, 0], min: -120, max: 120 },
      { letter: 'U', axis: [1, 0, 0], min: -120, max: 120 }],
  });
  assert.ok(!solveRotary([25, -40, 0], doubled).reachable, 'still refused');
});


// --- the tilted work plane the post declares ---------------------------------

// The post writes a comment saying which way the tool axis points and, on the
// next line, a G68.2 declaring the work plane; G53.1 then stands the spindle
// normal to that plane. So the plane's normal *is* the tool axis — two
// statements of one direction, and the only way to catch them disagreeing is to
// read the angles the post actually writes and rebuild the plane from them.
//
// They disagreed. G68.2 rotates the programmed coordinates the way G68 R does,
// so its matrix is the setup rotation *undone*, and the file carried the
// rotation repeated instead: normal along −Y under a comment reading +Y. Every
// orientation that is not its own inverse swung 180° off the face.
test('the plane the post declares has its normal along the tool axis', () => {
  // the plane a G68.2 I/J/K declares, in the same XYZ convention rotationMatrix
  // states — its +Z is the third column
  const planeNormal = (euler) => {
    const m = rotationMatrix(euler);
    return [m[2], m[5], m[8]];
  };
  const orientations = [
    [0, 0, 0], [180, 0, 0], [0, 0, 90],          // their own inverse — always passed
    [90, 0, 0], [0, 90, 0], [-90, 0, 0],         // the "on its side" presets
    [45, 0, 0], [90, 0, 45], [30, 20, 0], [25, -40, 65],
  ];
  for (const r of orientations) {
    closeVec(planeNormal(eulerFor(r)), toolAxis(r), 1e-4, `plane normal for ${r}`);
  }
});

// The same fault stated as the machinist sees it: a point the strategies wrote
// in the tilted frame has to end up on the face, not on the far side of it.
//
// Truth is built the long way round, from the two facts nothing here shares —
// the mesh rotation R (setup.js) and the solved rotary set (checked separately
// against applyRotary). A programmed q is the part-frame point Rᵀq, which the
// table then swings. What the controller does is the same thing with the post's
// own angles in place of Rᵀ. The two agree only if those angles are Rᵀ.
test('an indexed point lands where the toolpath put it', () => {
  for (const r of [[90, 0, 0], [0, 90, 0], [45, 0, 0], [30, 20, 0], [25, -40, 65]]) {
    const solved = solveRotary(r, TRUNNION);
    assert.ok(solved.reachable, `trunnion reaches ${r}`);
    const axes = rotaryAxes(TRUNNION);
    for (const q of [[10, 5, 0], [-3, 12, -4], [0, 0, 25]]) {
      const want = applyRotary(axes, solved.angles, applyMatrix(transposeMatrix(rotationMatrix(r)), q));
      const got = applyRotary(axes, solved.angles, applyMatrix(rotationMatrix(eulerFor(r)), q));
      closeVec(got, want, 1e-3, `point ${q} at ${r}`);
    }
  }
});

// A turn about Z of 90° and one of −270° are the same fixturing, and the post
// should not cancel and re-declare a plane between two operations that share it.
test('the same orientation written two ways gets one plane', () => {
  assert.eq(orientationKey({ euler: eulerFor([0, 0, 90]) }),
    orientationKey({ euler: eulerFor([0, 0, -270]) }), 'one plane, not two');
});
