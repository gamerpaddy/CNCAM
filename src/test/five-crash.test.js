// What a simultaneous 5-axis program asks of the machine, the clamps and the
// cutter — the three checks that cannot be made from the toolpath alone.

import { test, assert } from './runner.js';
import { CLBuilder, FEED } from '../engine/cl.js';
import { createMachine, rotaryPreset } from '../doc/machines.js';
import { fiveChecks, DEFAULT_ROTARY_FEED } from '../engine/five/checks.js';
import { fixturePrisms, toolRings, fixtureHit } from '../engine/five/fixture-hits.js';
import { createFixture } from '../engine/fixtures.js';
import { simulateRemoval } from '../engine/simulate.js';
import { machineWarnings } from '../doc/machines.js';

const RAD = Math.PI / 180;
const lean = (deg, az = 0) => [
  Math.sin(deg * RAD) * Math.cos(az * RAD), Math.sin(deg * RAD) * Math.sin(az * RAD), Math.cos(deg * RAD),
];
const BALL = {
  number: 1, type: 'ball', diameter: 6, fluteLength: 15, spindleRpm: 12000, feedCut: 900, feedPlunge: 300,
};

function five(tweak = (r) => r, pivot = [0, 0, 0]) {
  const machine = createMachine({ kind: 'mill', rotary: tweak(rotaryPreset('AC')) });
  return { rotary: machine.rotary, tcp: 'kins', pivot };
}

/** a cut along X at the given heading of the spindle, one move each 0.5mm */
function pass(axisAt, length = 20, feed = 900) {
  const cl = new CLBuilder();
  cl.event('feeds', { cut: feed, plunge: 200 });
  cl.rapid(0, 0, 20);
  cl.setAxis(...axisAt(0));
  cl.rapid(0, 0, 5);
  for (let x = 0.5; x <= length; x += 0.5) {
    cl.setAxis(...axisAt(x));
    cl.cut(x, 0, 5, FEED.CUT);
  }
  return cl.finish();
}

test('a program inside the machine\'s reach has nothing to report but its own numbers', () => {
  const cl = pass((x) => lean(10 + x * 0.5, 0));
  const { findings, stats } = fiveChecks(cl, five());
  assert.eq(stats.unreachable, 0);
  assert.eq(findings.filter((f) => f.level === 'warn').length, 0, JSON.stringify(findings));
  assert.close(stats.maxTilt, 20, 0.6);
});

test('an axis limit is named, with how many moves are past it and where the first is', () => {
  const tight = five((r) => r.map((a) => (a.letter === 'A' ? { ...a, min: -15, max: 15 } : a)));
  const cl = pass((x) => lean(10 + x, 0));          // leans from 10° out to 30°
  const { findings, stats } = fiveChecks(cl, tight);
  assert.ok(stats.unreachable > 0);
  const f = findings.find((x) => /cannot point the spindle/.test(x.text));
  assert.ok(f && f.level === 'warn', JSON.stringify(findings));
  assert.ok(/A/.test(f.text), f.text);
});

test('turning the table faster than it can go at the programmed feed is said, with the shortfall', () => {
  // a 60° swing of lean in half a millimetre, at 900mm/min: far past 7200°/min
  const cl = pass((x) => lean(20, (x / 0.5) * 60), 6);
  const { findings, stats } = fiveChecks(cl, five());
  assert.ok(stats.worstDemand > DEFAULT_ROTARY_FEED);
  assert.ok(findings.some((f) => /cannot keep up/.test(f.text)), JSON.stringify(findings));
});

test('a leaning cut that passes within a degree of vertical is noted, and a steady one is not', () => {
  const near = fiveChecks(pass(() => lean(0.4, 30)), five());
  assert.ok(near.findings.some((f) => /within 1 degree of vertical/.test(f.text)), JSON.stringify(near.findings));
  const steady = fiveChecks(pass(() => lean(25, 30)), five());
  assert.ok(!steady.findings.some((f) => /vertical/.test(f.text)));
});

test('the linear axes go where the table carries the tip, which is what the travel check measures', () => {
  // the tip stays on a 20mm line, but the rotary centre is 300mm below it: leaning
  // 30° swings the tip 150mm sideways in machine X or Y
  const cl = pass(() => lean(30, 0), 20);
  const flat = fiveChecks(cl, five((r) => r, [0, 0, 0])).extent;
  const swung = fiveChecks(cl, five((r) => r, [0, 0, -300])).extent;
  const spanX = (e) => e.max[0] - e.min[0];
  const spanY = (e) => e.max[1] - e.min[1];
  assert.ok(Math.max(spanX(swung), spanY(swung)) > Math.max(spanX(flat), spanY(flat)) + 100,
    'a far pivot sweeps the tip through a much larger box');
  const machine = createMachine({ kind: 'mill', travel: [200, 200, 200] });
  const warnings = machineWarnings(machine, { min: [0, -250, -50], max: [20, 0, 50] });
  assert.ok(warnings.some((w) => /Y/.test(w.text)));
});

// --- the clamps ---------------------------------------------------------------

function clamp(x0, x1, height = 60) {
  const f = createFixture('box');
  f.center = [(x0 + x1) / 2, 0];
  f.size = [x1 - x0, 20];
  f.baseZ = 0;
  f.height = height;
  return f;
}

test('a holder standing beside a clamp is clear when upright and in it when the spindle leans over', () => {
  const rings = toolRings(BALL);
  const prisms = fixturePrisms([clamp(20, 40)]);
  const tip = [0, 0, 3];
  assert.eq(fixtureHit(prisms, rings, tip, [0, 0, 1]), null, 'upright, the tool is above the tip and nowhere near it');
  const hit = fixtureHit(prisms, rings, tip, lean(40, 0));
  assert.ok(hit && hit.depth > 0, 'leaning toward it, the holder is inside');
  assert.eq(hit.name, 'Jaw');
  assert.eq(fixtureHit(prisms, rings, tip, lean(40, 180)), null, 'leaning away is fine');
});

test('a disabled clamp is not in the way, and a clamp the tool is above is not either', () => {
  const rings = toolRings(BALL);
  const off = clamp(20, 40);
  off.enabled = false;
  assert.eq(fixtureHit(fixturePrisms([off]), rings, [0, 0, 3], lean(40, 0)), null);
  const low = fixturePrisms([clamp(20, 40, 5)]);
  assert.eq(fixtureHit(low, rings, [0, 0, 3], lean(40, 0)), null, 'the holder is above a 5mm clamp');
});

const STOCK = { kind: 'box', min: [-10, -10, 0], max: [50, 10, 12] };

/** a short leaning pass over the stock, tip at depth 2 */
function leaning(deg, az) {
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.setAxis(...lean(deg, az));
  cl.rapid(0, 0, 30);
  cl.rapid(0, 0, 14);
  cl.cut(0, 0, 10, FEED.PLUNGE);
  cl.cut(5, 0, 10, FEED.CUT);
  cl.rapid(5, 0, 30);
  return { cl: cl.finish(), tool: BALL };
}

test('the simulation finds the clamp the holder is in, and where in the program', () => {
  const sim = simulateRemoval({
    stock: STOCK, ops: [leaning(40, 0)], maxCells: 20_000, fixtures: [clamp(20, 40)],
  });
  const hit = sim.findings.find((f) => f.kind === 'fixture');
  assert.ok(hit, JSON.stringify(sim.findings.slice(0, 3)));
  assert.eq(hit.name, 'Jaw');
  assert.ok(hit.step >= 0 && hit.step < sim.stepCount);
  const clear = simulateRemoval({
    stock: STOCK, ops: [leaning(40, 180)], maxCells: 20_000, fixtures: [clamp(20, 40)],
  });
  assert.eq(clear.findings.filter((f) => f.kind === 'fixture').length, 0);
});

test('a program with no fixtures, or one that never tilts, reports no fixture hits', () => {
  const none = simulateRemoval({ stock: STOCK, ops: [leaning(40, 0)], maxCells: 20_000 });
  assert.eq(none.findings.filter((f) => f.kind === 'fixture').length, 0);
});

test('findings carry the step, in order, and a vertical program has none to report', () => {
  const sim = simulateRemoval({
    stock: STOCK, ops: [leaning(40, 0)], maxCells: 20_000, fixtures: [clamp(20, 40)],
  });
  for (let i = 1; i < sim.findings.length; i++) assert.ok(sim.findings[i].step >= sim.findings[i - 1].step);
  const cl = new CLBuilder();
  cl.rapid(0, 0, 30);
  cl.rapid(0, 0, 20);
  const quiet = simulateRemoval({ stock: STOCK, ops: [{ cl: cl.finish(), tool: BALL }], maxCells: 20_000 });
  assert.eq(quiet.findings.length, 0);
  assert.eq(quiet.five, null, 'an ordinary program has no 5-axis engagement to report');
});

// --- the cutter ---------------------------------------------------------------

/**
 * A finishing cut across the flat top of the stock: the ball 0.03mm into it, with
 * the spindle at `deg`. The path is the ball's *centre* held at one height, so the
 * depth is the same however it leans — the CL tip is the pole of the ball, which is
 * not where it bottoms out once it is tilted.
 */
function flatCut(deg) {
  const R = BALL.diameter / 2;
  const a = deg === 0 ? [5e-5, 0, 1] : lean(deg, 180);   // a hair of tilt takes the 5-axis route
  const centreZ = 12 - 0.03 + R;
  const tip = (x) => [x - R * a[0], -R * a[1], centreZ - R * a[2]];
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.setAxis(...a);
  const start = tip(0);
  cl.rapid(start[0], start[1], 30);
  cl.rapid(start[0], start[1], start[2] + 2);
  cl.cut(...start, FEED.PLUNGE);
  const end = tip(30);
  cl.cut(...end, FEED.CUT);
  cl.rapid(end[0], end[1], 30);
  return { cl: cl.finish(), tool: BALL };
}

test('a ball nose finishing on its tip is cutting at almost no speed, and leaning it moves the work out along the ball', () => {
  const upright = simulateRemoval({ stock: STOCK, ops: [flatCut(0)], maxCells: 160_000 }).five;
  const leaned = simulateRemoval({ stock: STOCK, ops: [flatCut(20)], maxCells: 160_000 }).five;
  assert.ok(upright && leaned, 'both are 5-axis programs to the simulation');
  assert.ok(upright.cutSteps > 3 && leaned.cutSteps > 3, `${upright.cutSteps}, ${leaned.cutSteps} steps cut`);
  // upright, the 0.03mm cut is taken within a third of a millimetre of the ball's centre
  assert.ok(upright.meanRatio < 0.12, `upright works at ${upright.meanRatio.toFixed(2)} of the radius`);
  assert.ok(upright.deadShare > 0.4, `upright: ${upright.deadShare.toFixed(2)} of the metal at the dead centre`);
  // leaned 20° the ball's lowest point is R·sin(20°) off its axis, and the cut is taken there
  assert.close(leaned.meanRatio, Math.sin(20 * RAD), 0.08, 'effective radius share');
  assert.ok(leaned.deadShare < 0.05, `leaned: ${leaned.deadShare.toFixed(2)}`);
  assert.ok(leaned.peakMrr > 0 && Number.isFinite(leaned.peakMrr));
});

test('metal removal rate is the volume of a step over its time', () => {
  const { five: eng } = simulateRemoval({ stock: STOCK, ops: [flatCut(20)], maxCells: 160_000 });
  // a 0.03mm-deep groove with a ⌀6 ball is a circular segment 2·√(2Rd) = 0.85mm
  // wide, 0.03 deep: about 0.017mm² of section, so about 0.5mm³ over 30mm
  assert.close(eng.volume, 0.5, 0.25, `${eng.volume.toFixed(2)}mm³ taken`);
  // and 600mm/min over that section is about 10mm³/min
  assert.close(eng.peakMrr, 10, 6, `${eng.peakMrr.toFixed(1)}mm³/min at the peak`);
});
