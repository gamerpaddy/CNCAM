// Simultaneous 5-axis kinematics: the rotary solve at every point of a path.

import { test, assert } from './runner.js';
import { createMachine, rotaryPreset } from '../doc/machines.js';
import { createSetup, serializeProject, deserializeProject, createProject } from '../doc/schema.js';
import {
  trunnionOf, fiveAxisRefusal, axisBranches, chooseAngles, tipToMachine, machineToTip,
  axisFromAngles, toWritten, fromWritten, POLE_DEG,
} from '../engine/five/kinematics.js';
import { solveRotary } from '../engine/indexing.js';

const RAD = Math.PI / 180;

function machineOf(kind, tweak = (r) => r) {
  return createMachine({ kind: 'mill', name: kind, rotary: tweak(rotaryPreset(kind)) });
}

/** a deterministic spread of unit vectors on the upper cap, out to `maxTilt` degrees */
function directions(n, maxTilt) {
  const out = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let i = 0; i < n; i++) {
    const tilt = Math.acos(1 - rnd() * (1 - Math.cos(maxTilt * RAD)));
    const az = rnd() * Math.PI * 2;
    out.push([Math.sin(tilt) * Math.cos(az), Math.sin(tilt) * Math.sin(az), Math.cos(tilt)]);
  }
  return out;
}

const close3 = (a, b, eps) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < eps;

test('a trunnion is recognised, anything else is refused with a reason', () => {
  assert.eq(trunnionOf(machineOf('AC')).kind, 'AC');
  assert.eq(trunnionOf(machineOf('BC')).kind, 'BC');
  for (const kind of ['none', 'A', 'B']) {
    assert.eq(trunnionOf(machineOf(kind)), null, kind);
    assert.ok(fiveAxisRefusal(machineOf(kind)), kind);
  }
  assert.eq(fiveAxisRefusal(machineOf('AC')), null);
  // a turntable *under* the tilt is a different machine
  const swapped = createMachine({ rotary: [...rotaryPreset('AC')].reverse() });
  assert.eq(trunnionOf(swapped), null);
});

for (const kind of ['AC', 'BC']) {
  test(`${kind}: every spindle direction round-trips through the angles that point it`, () => {
    const machine = machineOf(kind);
    for (const k of directions(400, 100)) {
      const r = chooseAngles(k, machine);
      assert.ok(r.reachable, `${k} unreachable: ${r.reason}`);
      assert.ok(close3(axisFromAngles(r.angles, machine), k, 1e-9), `axis for ${k}`);
    }
  });

  test(`${kind}: both branches point the spindle the same way`, () => {
    const machine = machineOf(kind);
    for (const k of directions(100, 80)) {
      const branches = axisBranches(k, machine);
      assert.eq(branches.length, 2, 'two ways to the same direction');
      for (const angles of branches) assert.ok(close3(axisFromAngles(angles, machine), k, 1e-9));
    }
  });

  test(`${kind}: the tool tip survives machine → part → machine, with a pivot`, () => {
    const machine = machineOf(kind);
    const pivot = [12.5, -7, -80];
    let n = 0;
    for (const k of directions(120, 90)) {
      const r = chooseAngles(k, machine);
      const p = [3 + n, 40 - n * 0.5, -20 + (n % 7)];
      n++;
      const m = tipToMachine(p, r.angles, machine, pivot);
      assert.ok(close3(machineToTip(m, r.angles, machine, pivot), p, 1e-9));
    }
  });
}

test('a rotary centre at the datum leaves a point on the axes where it is', () => {
  const machine = machineOf('AC');
  const r = chooseAngles([0.4, 0.3, Math.sqrt(1 - 0.25)], machine);
  assert.ok(close3(tipToMachine([0, 0, 0], r.angles, machine, [0, 0, 0]), [0, 0, 0], 1e-12));
});

test('the pivot matters: a part swung about a centre below it moves sideways', () => {
  const machine = machineOf('AC');
  const r = chooseAngles([0, Math.sin(30 * RAD), Math.cos(30 * RAD)], machine);
  const swung = tipToMachine([0, 0, 0], r.angles, machine, [0, 0, -50]);
  assert.ok(Math.hypot(swung[0], swung[1], swung[2]) > 20, `moved only ${swung}`);
});

test('sweeping the spindle once round a cone keeps the angles continuous', () => {
  const machine = machineOf('AC');
  const tilt = 35 * RAD;
  let prev = null;
  let worst = 0;
  for (let deg = 0; deg <= 340; deg += 1) {
    const az = deg * RAD;
    const k = [Math.sin(tilt) * Math.cos(az), Math.sin(tilt) * Math.sin(az), Math.cos(tilt)];
    const r = chooseAngles(k, machine, prev);
    assert.ok(r.reachable, `at ${deg}°: ${r.reason}`);
    if (prev) {
      worst = Math.max(worst, Math.abs(r.angles.A - prev.A), Math.abs(r.angles.C - prev.C));
    }
    prev = r.angles;
  }
  assert.ok(worst < 2, `an axis jumped ${worst}° in a one-degree step`);
});

test('two full turns round the cone stay reachable: the branch flip replaces a whole turn', () => {
  const machine = machineOf('AC');
  const tilt = 35 * RAD;
  let prev = null;
  let worst = 0;
  for (let deg = 0; deg <= 720; deg += 1) {
    const az = deg * RAD;
    const k = [Math.sin(tilt) * Math.cos(az), Math.sin(tilt) * Math.sin(az), Math.cos(tilt)];
    const r = chooseAngles(k, machine, prev);
    assert.ok(r.reachable, `at ${deg}°: ${r.reason}`);
    assert.ok(Math.abs(r.angles.C) <= 360 + 1e-9, 'C stays inside its travel');
    if (prev) worst = Math.max(worst, Math.abs(r.angles.A - prev.A), Math.abs(r.angles.C - prev.C));
    prev = r.angles;
  }
  assert.ok(worst <= 190, `a jump of ${worst}° — more than a branch flip`);
});

test('an axis limit that no branch and no whole turn satisfies is reported, naming the axis', () => {
  const machine = machineOf('AC', (rotary) => rotary.map((a) => (a.letter === 'A' ? { ...a, min: -30, max: 30 } : a)));
  const k = [0, Math.sin(50 * RAD), Math.cos(50 * RAD)];
  const r = chooseAngles(k, machine);
  assert.eq(r.reachable, false);
  assert.ok(/A/.test(r.reason), r.reason);
});

test('exactly at the pole the turntable is held, and near it is flagged', () => {
  const machine = machineOf('AC');
  const held = chooseAngles([0, 0, 1], machine, { A: 0, C: 77 });
  assert.close(held.angles.C, 77, 1e-9);
  assert.close(held.angles.A, 0, 1e-9);
  const near = chooseAngles([Math.sin(0.4 * RAD), 0, Math.cos(0.4 * RAD)], machine, { A: 0, C: 0 });
  assert.eq(near.nearPole, true);
  assert.ok(near.tilt < POLE_DEG);
  assert.eq(chooseAngles([Math.sin(10 * RAD), 0, Math.cos(10 * RAD)], machine).nearPole, false);
});

test('an axis that counts the other way is written negated and read back the same', () => {
  const machine = machineOf('AC', (rotary) => rotary.map((a) => (a.letter === 'A' ? { ...a, sign: -1 } : a)));
  const written = toWritten({ A: 25, C: 40 }, machine);
  assert.eq(written.A, -25);
  assert.eq(written.C, 40);
  const back = fromWritten(written, machine);
  assert.eq(back.A, 25);
  assert.eq(back.C, 40);
});

test('the indexing solver still answers through its refactored entry point', () => {
  const machine = machineOf('AC');
  for (const rot of [[0, 0, 0], [90, 0, 0], [-90, 0, 0], [30, 40, 20], [0, 180, 0]]) {
    const a = solveRotary(rot, machine);
    assert.ok(a.angles, JSON.stringify(rot));
  }
});

test('a setup carries a five-axis block that survives save and load', () => {
  const project = createProject();
  const setup = createSetup();
  assert.eq(setup.five, null);
  setup.five = { enabled: true, pivot: [0, 0, -120], signChecked: true };
  project.setups = [setup];
  const back = deserializeProject(serializeProject(project));
  assert.eq(back.setups[0].five.pivot[2], -120);
  assert.eq(back.setups[0].five.signChecked, true);
});

test('a damaged five-axis block is repaired, and says so', () => {
  const project = createProject();
  const setup = createSetup();
  setup.five = { enabled: true, pivot: 'far away' };
  project.setups = [setup];
  const notes = [];
  const back = deserializeProject(serializeProject(project), notes);
  assert.eq(back.setups[0].five.pivot, null);
  assert.ok(notes.some((n) => /pivot/.test(n)), notes.join('; '));
});

test('a machine keeps rotary signs and its TCP mode, and falls back to the safe one', () => {
  const machine = machineOf('AC', (rotary) => rotary.map((a) => (a.letter === 'C' ? { ...a, sign: -1, maxFeed: 7200 } : a)));
  assert.eq(machine.rotary.find((a) => a.letter === 'C').sign, -1);
  assert.eq(machine.rotary.find((a) => a.letter === 'C').maxFeed, 7200);
  assert.eq(machine.rotary.find((a) => a.letter === 'A').sign, undefined);
  assert.eq(machine.tcp, 'kins');
  assert.eq(createMachine({ tcp: 'g43.4' }).tcp, 'g43.4');
  assert.eq(createMachine({ tcp: 'nonsense' }).tcp, 'kins');
});
