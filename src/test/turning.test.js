// Turning: the part as a profile, the four operations, and the lathe post.
//
// The invariant that runs through all of these is the radius/diameter boundary.
// Everything inside CNCAM holds X as a radius because that is the geometry;
// exactly one place doubles it, and if any other place does — or the one place
// stops — the part comes out at half or twice the size with no other symptom.

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { eachMove, OP, FEED } from '../engine/cl.js';
import { turningProfile, radiusAtZ, offsetProfile, barFromStock } from '../engine/lathe.js';
import { buildGcode } from '../post/index.js';
import { simulateTurning, SimulationPlayback } from '../engine/simulate.js';
import { makeShaft, makeBox } from './fixtures.js';

const INSERT = {
  number: 1, type: 'turning', name: 'CCMT 0.4', diameter: 6, noseRadius: 0.4,
  fluteLength: 12, flutes: 1, spindleRpm: 1200, feedCut: 120, feedPlunge: 80,
};
const BLADE = {
  number: 2, type: 'parting', name: '3mm blade', diameter: 3, bladeWidth: 3,
  fluteLength: 20, flutes: 1, spindleRpm: 700, feedCut: 40, feedPlunge: 40,
};

const shaft = makeShaft();
const BAR = {
  kind: 'cylinder', min: [-20, -20, 0], max: [20, 20, 65],
  cylinder: { diameter: 40, height: 65, center: [0, 0] },
};

const base = {
  topZ: 60, bottomZ: 0, clearanceX: 0, clearanceHeight: 50, entryGap: 1,
  tolerance: 0.05, stockToLeave: 0, stepdown: 2, peck: 0,
  faceToRadius: 0, partOffRadius: 0,
};

function cutPoints(cl) {
  const pts = [];
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.LINE && feed !== FEED.RAPID) pts.push([x, z]);
  });
  return pts;
}

/** Every X the program visits, rapids included — the widest is the clearance. */
function allRadii(cl) {
  const out = [];
  eachMove(cl, (op, x) => out.push(x));
  return out;
}

function notes(cl, level) {
  return cl.notes.filter((n) => !level || n.level === level).map((n) => n.text).join(' | ');
}

// --- the profile ---

test('a shaft turns into the radius it has at each point along it', () => {
  const profile = turningProfile(shaft.mesh, { samples: 400 });
  assert.close(profile.zMin, 0, 1e-6);
  assert.close(profile.zMax, shaft.zMax, 1e-6);
  // the big diameter behind the step, the small one in front of it
  assert.close(radiusAtZ(profile, 10), shaft.bigR, 0.2);
  assert.close(radiusAtZ(profile, shaft.zMax - 5), shaft.smallR, 0.2);
  assert.close(profile.maxRadius, shaft.bigR, 0.2);
});

test('the profile never understates the part', () => {
  // Understating it by half a sample is a finishing pass that cuts into the
  // part. The envelope is dilated by one sample for exactly this reason, so it
  // may sit proud but never inside.
  const profile = turningProfile(shaft.mesh, { samples: 120 });
  for (let z = 1; z < shaft.zStep - 1; z += 1) {
    assert.ok(radiusAtZ(profile, z) >= shaft.bigR - 1e-6,
      `at Z${z} the profile reads ${radiusAtZ(profile, z).toFixed(3)}, inside ${shaft.bigR}`);
  }
});

test('a part that is not round still turns to the shape that contains it', () => {
  // a 40mm cube on the axis: the envelope is the circle it fits in
  const profile = turningProfile(makeBox(40, 40, 40));
  assert.ok(profile.maxRadius > 40, `expected the far corner, got ${profile.maxRadius}`);
});

test('the bar comes from the stock, or from the part when there is none', () => {
  const profile = turningProfile(shaft.mesh);
  assert.close(barFromStock(BAR, profile).radius, 20, 1e-6, 'the cylinder stock');
  assert.ok(barFromStock(null, profile).radius > profile.maxRadius, 'or the smallest bar that fits');
});

test('the nose offset moves the path away from the work, not into it', () => {
  const straight = [[10, 5], [0, 5]];              // a plain diameter
  const offset = offsetProfile(straight, 0.4);
  for (const [, r] of offset) assert.close(r, 5.4, 1e-6, 'a diameter is offset outward');
  assert.eq(offsetProfile(straight, 0).length, 2, 'and no nose means no offset');
});

// --- the operations ---

test('facing sweeps from the outside of the bar in to the centre', () => {
  const cl = generateToolpath({
    type: 'turnFace', name: 'face', tool: INSERT, mesh: shaft.mesh, stock: BAR,
    params: { ...base, topZ: 62, bottomZ: 60, stepdown: 0.5 },
  });
  const pts = cutPoints(cl);
  assert.ok(pts.length >= 4, 'several passes');
  // every cutting pass ends nearer the axis than it started
  const starts = pts.filter((_, i) => i % 2 === 0).map((p) => p[0]);
  const ends = pts.filter((_, i) => i % 2 === 1).map((p) => p[0]);
  for (let i = 0; i < ends.length; i++) {
    assert.ok(ends[i] < starts[i], `pass ${i} ran outward: ${starts[i]} → ${ends[i]}`);
  }
  assert.close(Math.min(...pts.map((p) => p[0])), 0, 0.5, 'and reaches the centre');
});

test('roughing works inward from the bar and stops at the part', () => {
  const cl = generateToolpath({
    type: 'turnRough', name: 'rough', tool: INSERT, mesh: shaft.mesh, stock: BAR,
    params: { ...base, topZ: 60, bottomZ: 0, stepdown: 2, stockToLeave: 0.3 },
  });
  const radii = [...new Set(cutPoints(cl).map((p) => Math.round(p[0] * 100) / 100))]
    .sort((a, b) => b - a);
  assert.ok(radii.length >= 4, `expected several depths of cut, got ${radii.join(', ')}`);
  assert.ok(radii[0] <= 20, 'the first pass is inside the ⌀40 bar');
  // It must never cut past the small diameter plus the allowance. Measured on
  // the *nose centre*, which is what CL X is, so the last pass sits an insert
  // nose radius outside the diameter it leaves behind.
  assert.close(radii[radii.length - 1], shaft.smallR + 0.3 + INSERT.noseRadius, 0.35,
    `roughing finished at ${radii[radii.length - 1]}, and the part is ${shaft.smallR}`);
});

test('roughing leaves the allowance it was asked for', () => {
  const run = (stockToLeave) => {
    const cl = generateToolpath({
      type: 'turnRough', name: 'rough', tool: INSERT, mesh: shaft.mesh, stock: BAR,
      params: { ...base, topZ: 60, bottomZ: 0, stepdown: 2, stockToLeave },
    });
    return Math.min(...cutPoints(cl).map((p) => p[0]));
  };
  assert.ok(run(1) > run(0.1) + 0.5, 'more allowance stops further out');
});

test('roughing leaves the allowance on a plateau, not a multiple of it', () => {
  // A pass stops where the work rises to meet it, so a plateau is cut to size
  // only by a pass at its own radius. The ladder used to drop that pass when it
  // already had one within a fifth of a stepdown — on either side, and the two
  // sides are not alike: a level outside the plateau leaves the difference
  // standing. Measured on the ⌀30 section of the test shaft, "leaving 0.3mm on"
  // left 0.5mm. The stepdown here is chosen so the ladder lands just outside
  // the big diameter and the old rule swallows the plateau.
  // Swept rather than sampled at one stepdown: where the ladder falls relative
  // to the plateau is exactly what the fault turned on, and most stepdowns miss
  // it. 2.14 is one that lands 0.42 outside a plateau wanting 0.30.
  const stockToLeave = 0.3;
  for (const stepdown of [1.5, 1.7, 2, 2.14, 2.5, 3]) {
    const cl = generateToolpath({
      type: 'turnRough', name: 'rough', tool: INSERT, mesh: shaft.mesh, stock: BAR,
      params: { ...base, topZ: 60, bottomZ: 0, stepdown, stockToLeave },
    });
    // a pass that ran the length of the big diameter reached the chuck end; the
    // deepest of those is what the big diameter is left at
    const alongBig = cutPoints(cl).filter(([, z]) => z < 5);
    assert.ok(alongBig.length > 0, `stepdown ${stepdown}: nothing ran along the big diameter`);
    const left = Math.min(...alongBig.map(([x]) => x)) - INSERT.noseRadius - shaft.bigR;
    assert.close(left, stockToLeave, 0.02,
      `stepdown ${stepdown} left ${left.toFixed(2)}mm on the ⌀${shaft.bigR * 2} `
      + `where ${stockToLeave} was asked for`);
  }
});

test('a recess no turning pass can reach is named, by both the ops it concerns', () => {
  // A diameter with a bigger one on both sides of it cannot be approached from
  // either end. Roughing therefore does not touch it, and the finishing insert
  // — which follows the profile wherever it goes — takes the whole depth of it
  // in one cut. Neither said so: roughing reported "leaving 0.3mm on" and
  // finishing reported the length of profile it had followed.
  const grooved = makeShaft({ groove: { z: 20, width: 4, radius: 10 } });
  const args = {
    mesh: grooved.mesh, stock: BAR,
    params: { ...base, topZ: 60, bottomZ: 0, stepdown: 2, stockToLeave: 0.3 },
  };
  const rough = generateToolpath({ ...args, type: 'turnRough', name: 'rough', tool: INSERT });
  const finish = generateToolpath({ ...args, type: 'turnFinish', name: 'finish', tool: INSERT });

  const depth = grooved.bigR - grooved.groove.radius;   // 5mm
  for (const [what, cl] of [['roughing', rough], ['finishing', finish]]) {
    const said = notes(cl);
    assert.ok(/⌀20\.00/.test(said), `${what} did not name the ⌀20 recess: ${said}`);
    assert.ok(new RegExp(`${depth.toFixed(2)}mm`).test(said),
      `${what} did not say how deep it is: ${said}`);
  }

  // and a plain stepped shaft, which has no recess, must stay quiet about one
  const plain = generateToolpath({
    ...args, mesh: shaft.mesh, type: 'turnFinish', name: 'finish', tool: INSERT,
  });
  assert.ok(!/cannot reach|grooving tool/.test(notes(plain)),
    `a plain step was reported as unreachable: ${notes(plain)}`);
});

test('nothing to rough is said, not silently produced', () => {
  const cl = generateToolpath({
    type: 'turnRough', name: 'rough', tool: INSERT, mesh: shaft.mesh,
    stock: { kind: 'cylinder', min: [-3, -3, 0], max: [3, 3, 65], cylinder: { diameter: 6, height: 65, center: [0, 0] } },
    params: { ...base, topZ: 60, bottomZ: 0 },
  });
  assert.eq(cutPoints(cl).length, 0);
  assert.ok(/nothing to rough/.test(notes(cl, 'warn')), notes(cl));
});

test('finishing follows the profile and is offset by the insert nose', () => {
  const withNose = generateToolpath({
    type: 'turnFinish', name: 'finish', tool: INSERT, mesh: shaft.mesh, stock: BAR,
    params: { ...base, topZ: 58, bottomZ: 2, tolerance: 0.05 },
  });
  const sharp = generateToolpath({
    type: 'turnFinish', name: 'finish', tool: { ...INSERT, noseRadius: 0 },
    mesh: shaft.mesh, stock: BAR, params: { ...base, topZ: 58, bottomZ: 2, tolerance: 0.05 },
  });
  const nearFreeEnd = (cl) => cutPoints(cl).filter((p) => p[1] > 50).map((p) => p[0]);
  const withR = Math.max(...nearFreeEnd(withNose));
  const sharpR = Math.max(...nearFreeEnd(sharp));
  assert.close(sharpR, shaft.smallR, 0.3, 'a sharp tool drives straight down the profile');
  assert.close(withR - sharpR, 0.4, 0.05, 'and a 0.4 nose stands 0.4 off it');
  assert.ok(/compensated/.test(notes(withNose)), notes(withNose));
  assert.ok(/no nose compensation/.test(notes(sharp)), notes(sharp));
});

test('parting off pecks its way to the centre', () => {
  const cl = generateToolpath({
    type: 'turnPart', name: 'part', tool: BLADE, mesh: shaft.mesh, stock: BAR,
    params: { ...base, bottomZ: 5, peck: 2 },
  });
  const pts = cutPoints(cl);
  assert.ok(pts.length >= 5, `expected several pecks, got ${pts.length}`);
  assert.ok(pts.every((p) => Math.abs(p[1] - 5) < 1e-6), 'all at the parting Z');
  assert.close(Math.min(...pts.map((p) => p[0])), 0, 1e-6, 'right through the middle');
  // each peck goes deeper than the last
  const depths = pts.map((p) => p[0]);
  for (let i = 1; i < depths.length; i++) assert.ok(depths[i] <= depths[i - 1] + 1e-9);
});

test('parting to a radius leaves a pip rather than cutting through', () => {
  const cl = generateToolpath({
    type: 'turnPart', name: 'part', tool: BLADE, mesh: shaft.mesh, stock: BAR,
    params: { ...base, bottomZ: 5, peck: 0, partOffRadius: 1.5 },
  });
  assert.close(Math.min(...cutPoints(cl).map((p) => p[0])), 1.5, 1e-6);
});

// --- the post ---

test('the lathe post writes diameters, and nothing else does', () => {
  const cl = generateToolpath({
    type: 'turnFinish', name: 'finish', tool: INSERT, mesh: shaft.mesh, stock: BAR,
    params: { ...base, topZ: 58, bottomZ: 2 },
  });
  const { text } = buildGcode('lathe', [{ name: 'finish', cl }]);

  assert.ok(/^G21 G90 G9[45] G18 G7 /m.test(text), `no diameter-mode header:\n${text.slice(0, 200)}`);
  assert.ok(!/^\s*[^(]*\bY-?[\d.]/m.test(text), 'a lathe has no Y axis');

  // Every X word in the file must be exactly twice a radius in the CL data —
  // the widest included, which is the clearance the tool rapids at.
  const radii = allRadii(cl);
  const widest = Math.max(...radii);
  const xWords = [...text.matchAll(/X(-?[\d.]+)/g)].map((m) => Number(m[1]));
  assert.close(Math.max(...xWords), widest * 2, 0.01, 'X is a diameter');
  for (const x of xWords) {
    assert.ok(radii.some((r) => Math.abs(r * 2 - x) < 0.01),
      `X${x} is not twice any radius the toolpath visits`);
  }
});

test('a lathe feed is per revolution, and per minute when it is asked to be', () => {
  const cl = generateToolpath({
    type: 'turnFinish', name: 'finish', tool: INSERT, mesh: shaft.mesh, stock: BAR,
    params: { ...base, topZ: 58, bottomZ: 2 },
  });
  const perRev = buildGcode('lathe', [{ name: 'f', cl }], { feedMode: 'perRev' }).text;
  assert.ok(/^G21 G90 G95 /m.test(perRev), 'G95 asks the control for mm/rev');
  const revFeeds = [...perRev.matchAll(/F([\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(revFeeds.length > 0, 'the program has a feed in it');
  // 120 mm/min at 1200 rpm is 0.1 mm/rev, which is what the insert box quotes
  assert.close(Math.max(...revFeeds), 120 / 1200, 1e-6, 'mm/min divided by rpm');

  const perMin = buildGcode('lathe', [{ name: 'f', cl }], { feedMode: 'perMinute' }).text;
  assert.ok(/^G21 G90 G94 /m.test(perMin), 'G94 asks for mm/min');
  const minFeeds = [...perMin.matchAll(/F([\d.]+)/g)].map((m) => Number(m[1]));
  assert.close(Math.max(...minFeeds), 120, 1e-6, 'mm/min passed through unchanged');
});

test('a threading pass is spindle-synchronised, and the approach to it is not', () => {
  const cl = generateToolpath({
    type: 'turnThread', name: 'thread', tool: INSERT, mesh: shaft.mesh, stock: BAR,
    params: {
      // A Z range that stays on one diameter. 35 crosses the shaft's shoulder,
      // and the run-out below it would drive the tool into the bigger section —
      // which the operation now refuses and warns about, correctly.
      ...base, topZ: 55, bottomZ: 45, threadPitch: 1.5, threadPasses: 4,
      threadStartRadius: 10, threadFirstDepth: 0, threadSpringPasses: 0,
    },
  });
  const { text } = buildGcode('lathe', [{ name: 'thread', cl }]);
  const g33 = text.split('\n').filter((l) => l.startsWith('G33'));
  assert.eq(g33.length, 4, 'one synchronised move per pass');
  for (const line of g33) {
    assert.ok(/K1\.5\b/.test(line), `pitch missing from ${line}`);
    assert.ok(!/\bF/.test(line), `${line} has a feed — the pitch is the feed`);
  }
  // the tool still has to get there and get out, and neither is synchronised
  assert.ok(text.includes('G0 '), 'the lead-in and retract are rapids');
  assert.ok(!cl.notes.some((n) => n.level === 'warn'),
    'nothing left to warn about once the passes are really synchronised');
});

test('a post that cannot synchronise says so rather than writing G1', () => {
  const cl = generateToolpath({
    type: 'turnThread', name: 'thread', tool: INSERT, mesh: shaft.mesh, stock: BAR,
    params: {
      ...base, topZ: 55, bottomZ: 35, threadPitch: 1.5, threadPasses: 2,
      threadStartRadius: 10,
    },
  });
  const { text } = buildGcode('grbl', [{ name: 'thread', cl }]);
  assert.ok(/WARNING/.test(text), 'a mill post must not pretend to cut a thread');
  assert.ok(!text.includes('G33'), 'and must not write a code it does not have');
});

test('constant surface speed is G96 with a cap, and G97 without', () => {
  const make = (params) => generateToolpath({
    type: 'turnFace', name: 'face', tool: INSERT, mesh: shaft.mesh, stock: BAR,
    params: { ...base, topZ: 60, bottomZ: 57, ...params },
  });
  const fixed = buildGcode('lathe', [{ name: 'f', cl: make({}) }]).text;
  assert.ok(/G97 S1200 M3/.test(fixed), 'a fixed speed is G97');

  const css = buildGcode('lathe', [{
    name: 'f',
    cl: make({ spindleMode: 'css', surfaceSpeed: 120, cssMaxRpm: 1800 }),
  }]).text;
  assert.ok(/G96 D1800 S120 M3/.test(css), `no G96 in:\n${css.slice(0, 300)}`);
  assert.ok(/^G97$/m.test(css),
    'the file must leave the control out of constant-surface-speed mode');
});

test('the mill posts are untouched by the lathe motion writer', () => {
  const cl = generateToolpath({
    type: 'turnFinish', name: 'finish', tool: INSERT, mesh: shaft.mesh, stock: BAR,
    params: { ...base, topZ: 58, bottomZ: 2 },
  });
  const mill = buildGcode('linuxcnc', [{ name: 'p', cl }]).text;
  const widest = Math.max(...allRadii(cl));
  const xWords = [...mill.matchAll(/X(-?[\d.]+)/g)].map((m) => Number(m[1]));
  assert.close(Math.max(...xWords), widest, 0.01,
    'a mill post writes the radius it was given, unchanged');
});

test('a turning program says what it did', () => {
  for (const [type, tool] of [['turnFace', INSERT], ['turnRough', INSERT],
    ['turnFinish', INSERT], ['turnPart', BLADE]]) {
    const cl = generateToolpath({
      type, name: type, tool, mesh: shaft.mesh, stock: BAR,
      params: { ...base, topZ: 60, bottomZ: 5 },
    });
    assert.ok(cl.notes.length > 0, `${type} produced no diagnosis at all`);
  }
});

// --- the program, run against material ---
//
// Everything above checks a toolpath against the geometry it was derived from,
// which cannot catch the two of them agreeing about the wrong thing. These
// check the *part that comes out*: the program is run through the material
// simulator and the finished bar is measured against the model.
//
// That is what caught the nose radius. Roughing compensated for it in Z and not
// in X while finishing compensated for both, so every diameter came out 0.4mm
// oversize — a scrapped part that no assertion about the toolpath could see,
// because both strategies were internally consistent and only disagreed with
// each other.

/** Run a whole turning program and hand back the finished profile. */
function machine(programme, { bar = { radius: 20, zMin: 0, zMax: 65 } } = {}) {
  const ops = programme.map(({ type, tool, params }) => ({
    tool,
    cl: generateToolpath({
      type, name: type, tool, mesh: shaft.mesh, stock: BAR, params: { ...base, ...params },
    }),
  }));
  const sim = simulateTurning({ bar, ops, samples: 1200 });
  const playback = new SimulationPlayback(sim);
  playback.seek(sim.stepCount);
  return {
    sim,
    radiusAt(z) {
      const i = Math.round((z - sim.zMin) / sim.dz);
      return playback.current[Math.max(0, Math.min(sim.count - 1, i))];
    },
  };
}

test('the part that comes out is the part that went in', () => {
  const cut = machine([
    { type: 'turnRough', tool: INSERT, params: { topZ: 60, bottomZ: 0, stepdown: 2, stockToLeave: 0.3 } },
    { type: 'turnFinish', tool: INSERT, params: { topZ: 60, bottomZ: 0, stockToLeave: 0 } },
  ]);

  // A finishing pass leaves the part, not the part plus the nose radius. The
  // profile is dilated by a sample on the way in, so a little proud is right
  // and anything under size is a part in the bin.
  for (const [z, want] of [[10, shaft.bigR], [25, shaft.bigR], [50, shaft.smallR]]) {
    const got = cut.radiusAt(z);
    assert.ok(got >= want - 1e-6, `at Z${z} the bar is ${got.toFixed(3)}, inside the ${want} part`);
    assert.ok(got < want + 0.25, `at Z${z} the bar is ${got.toFixed(3)}, ${want} was wanted`);
  }
});

test('roughing leaves its allowance, measured on the material', () => {
  const rough = (stockToLeave) => machine([{
    type: 'turnRough', tool: INSERT, params: { topZ: 60, bottomZ: 0, stepdown: 2, stockToLeave },
  }]).radiusAt(50);

  const none = rough(0);
  const some = rough(0.5);
  assert.ok(none < shaft.smallR + 0.25,
    `with no allowance roughing should reach the part, got ${none.toFixed(3)}`);
  assert.close(some - none, 0.5, 0.2, 'and the allowance is what it says it is');
});

test('a facing pass takes the end off the bar, right to the centre', () => {
  const cut = machine([{
    type: 'turnFace', tool: INSERT, params: { topZ: 62, bottomZ: 58, stepdown: 1 },
  }], { bar: { radius: 20, zMin: 0, zMax: 62 } });
  // everything past the faced plane is gone; the bar is untouched behind it
  assert.close(cut.radiusAt(61), 0, 0.3, 'the end is cut away to the axis');
  assert.close(cut.radiusAt(55), 20, 0.01, 'and the bar behind it is not touched');
});

test('parting off cuts a groove as wide as the blade, and no wider', () => {
  const cut = machine([{
    type: 'turnPart', tool: BLADE, params: { bottomZ: 30, peck: 0 },
  }]);
  assert.close(cut.radiusAt(30), 0, 1e-6, 'right through the middle');
  const half = BLADE.bladeWidth / 2;
  assert.close(cut.radiusAt(30 - half + 0.2), 0, 0.1, 'the groove is the blade width');
  assert.close(cut.radiusAt(30 + half + 0.5), 20, 0.01, 'and the bar either side is untouched');
});

// --- threading: the pitch has to be visible along the bar ---
//
// A threading pass is one straight move at one radius, marked as synchronised.
// Left at that, the only thing changing the pitch did was change the form depth
// it works out to — the tool appeared to move in X for a setting about Z, which
// is exactly what was reported. The simulator now cuts the form the helix
// leaves, so the pitch is a thing you can count.

const THREADER = {
  number: 3, type: 'threading', name: '60° threading', diameter: 12, bladeWidth: 2,
  tipAngle: 60, noseRadius: 0, maxDepth: 6, spindleRpm: 400, feedCut: 60, feedPlunge: 60,
};

/** Radii along the threaded stretch, at the simulation's own sample spacing. */
function threadProfile(cut, zLo, zHi) {
  const out = [];
  for (let z = zLo; z <= zHi; z += cut.sim.dz) out.push(cut.radiusAt(z));
  return out;
}

/** How many separate grooves are cut into a run of radii. */
function grooveCount(radii) {
  const max = Math.max(...radii);
  const min = Math.min(...radii);
  const level = min + (max - min) * 0.5;
  let count = 0;
  let below = false;
  for (const r of radii) {
    if (r < level && !below) count++;
    below = r < level;
  }
  return count;
}

test('a thread is cut as a form repeated once per pitch', () => {
  const cut = machine([{
    type: 'turnThread', tool: THREADER,
    params: { topZ: 55, bottomZ: 40, threadPitch: 1.5, threadPasses: 6, threadStartRadius: 10 },
  }]);
  const radii = threadProfile(cut, 42, 53);
  const depth = Math.max(...radii) - Math.min(...radii);
  assert.ok(depth > 0.5, `the form is ${depth.toFixed(3)}mm deep — a thread, not a groove`);
  // 11mm at a 1.5mm pitch is seven or eight crests
  const grooves = grooveCount(radii);
  assert.ok(grooves >= 6 && grooves <= 9, `${grooves} grooves in 11mm at a 1.5mm pitch`);
});

test('doubling the pitch halves the number of grooves', () => {
  const count = (threadPitch) => grooveCount(threadProfile(machine([{
    type: 'turnThread', tool: THREADER,
    params: { topZ: 55, bottomZ: 40, threadPitch, threadPasses: 6, threadStartRadius: 10 },
  }]), 42, 53));

  const fine = count(1);
  const coarse = count(2);
  assert.ok(coarse < fine, `a 2mm pitch cut ${coarse} grooves and a 1mm pitch ${fine}`);
  assert.close(fine / Math.max(1, coarse), 2, 0.6, 'and roughly half as many');
});

test('the threaded face is chosen rather than guessed', () => {
  // The shaft steps from bigR to smallR; a thread whose Z range spans the step
  // has two diameters to sit on, and which one is the operation's to say.
  const majorOf = (threadFace) => {
    const cl = generateToolpath({
      type: 'turnThread', name: 'thread', tool: THREADER, mesh: shaft.mesh, stock: BAR,
      params: { ...base, topZ: 50, bottomZ: 20, threadPitch: 1.5, threadFace },
    });
    return /⌀([\d.]+)/.exec(cl.notes.map((n) => n.text).join(' '))?.[1];
  };
  const start = Number(majorOf('start'));
  const end = Number(majorOf('end'));
  const auto = Number(majorOf('auto'));
  assert.ok(Math.abs(start - end) > 1, `the two faces are different diameters (${start} vs ${end})`);
  assert.close(auto, Math.max(start, end), 0.5, 'auto takes the surface the thread sits on');
});

test('the nose offset rounds a convex corner and trims a concave one', () => {
  // A ⌀30 diameter, a face, then a ⌀16 diameter — the shaft's own shoulder,
  // written by hand so the corners are exact rather than sampled.
  const profile = [[0, 15], [35, 15], [35.001, 8], [60, 8]];
  const nose = 0.4;
  const path = offsetProfile(profile, nose);

  // nothing on the path may put the nose circle inside the metal
  const solid = [[0, 35, 15], [35, 60, 8]];
  const distance = (z, r) => {
    let best = Infinity;
    for (const [z0, z1, rMax] of solid) {
      const dz = Math.max(z0 - z, 0, z - z1);
      const dr = Math.max(0, r - rMax);
      best = Math.min(best, Math.hypot(dz, dr));
    }
    return best;
  };
  let worst = 0;
  for (let i = 1; i < path.length; i++) {
    const [z0, r0] = path[i - 1];
    const [z1, r1] = path[i];
    const steps = Math.max(2, Math.ceil(Math.hypot(z1 - z0, r1 - r0) / 0.005));
    for (let k = 0; k <= steps; k++) {
      const z = z0 + ((z1 - z0) * k) / steps;
      const r = r0 + ((r1 - r0) * k) / steps;
      if (z < 0.5 || z > 59.5) continue;
      worst = Math.max(worst, nose - distance(z, r));
    }
  }
  assert.ok(worst < 1e-3, `the nose centre stays a nose radius off the part (dug in ${worst.toFixed(3)}mm)`);

  // the concave corner is a single crossing, not a dive down to the face
  const inner = path.filter(([z, r]) => r < 9 && z < 36);
  assert.ok(inner.every(([z]) => z > 35.3),
    `nothing on the ⌀16 side comes nearer the shoulder than the nose allows: ${JSON.stringify(inner)}`);

  // and the convex corner is gone round rather than cut across
  const round = path.filter(([z, r]) => z > 34.9 && z < 35.5 && r > 15 && r < 15.4);
  assert.ok(round.length >= 3, `the outer corner is an arc, got ${round.length} points`);
});

test('a groove exactly one blade wide is plunged once', () => {
  const cl = generateToolpath({
    type: 'turnGroove', name: 'groove', tool: BLADE, mesh: shaft.mesh, stock: BAR,
    params: { ...base, topZ: 50, bottomZ: 47, grooveRadius: 6, peck: 0 },
  });
  const zs = new Set();
  let plunges = 0;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.LINE && feed !== FEED.RAPID) { plunges++; zs.add(z.toFixed(4)); }
  });
  assert.eq(zs.size, 1, 'one Z');
  assert.eq(plunges, 1, `and one cut at it, not the same one twice — got ${plunges}`);
});

test('stock to leave in a groove is left on the walls as well as the floor', () => {
  // The same rule the milled slot follows: one number, the same distance from
  // every finished surface. Grooving read it for the floor alone.
  const cut = (stockToLeave) => {
    const cl = generateToolpath({
      type: 'turnGroove', name: 'groove', tool: BLADE, mesh: shaft.mesh, stock: BAR,
      params: { ...base, topZ: 50, bottomZ: 40, grooveRadius: 5, peck: 0, stockToLeave },
    });
    let zLo = Infinity; let zHi = -Infinity; let deepest = Infinity;
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (op !== OP.LINE || feed === FEED.RAPID) return;
      zLo = Math.min(zLo, z); zHi = Math.max(zHi, z); deepest = Math.min(deepest, x);
    });
    // the blade cuts half its width either side of the centres it plunges at
    return { from: zLo - BLADE.bladeWidth / 2, to: zHi + BLADE.bladeWidth / 2, floor: deepest };
  };
  const exact = cut(0);
  const rough = cut(0.4);
  assert.close(exact.from, 40, 0.01, 'with nothing to leave the groove is on size');
  assert.close(exact.to, 50, 0.01);
  assert.close(exact.floor, 5, 0.01, 'and down to the floor asked for');
  assert.close(rough.from, 40.4, 0.01, 'leaving 0.4 keeps the blade off the near wall');
  assert.close(rough.to, 49.6, 0.01, 'and off the far one');
  assert.close(rough.floor, 5.4, 0.01, 'and off the floor');
});

test('a groove no wider than the blade puts the allowance on the floor alone', () => {
  const cl = generateToolpath({
    type: 'turnGroove', name: 'groove', tool: BLADE, mesh: shaft.mesh, stock: BAR,
    params: { ...base, topZ: 50, bottomZ: 47, grooveRadius: 5, peck: 0, stockToLeave: 0.4 },
  });
  const zs = new Set();
  let deepest = Infinity;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE || feed === FEED.RAPID) return;
    zs.add(z.toFixed(4)); deepest = Math.min(deepest, x);
  });
  assert.eq(zs.size, 1, 'still one plunge');
  assert.close(Number([...zs][0]), 48.5, 0.01, 'centred in the groove, not shuffled along it');
  assert.close(deepest, 5.4, 0.01, 'with the allowance on the floor');
});
