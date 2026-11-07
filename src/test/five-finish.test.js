// 5-axis surface finishing, checked against a part whose surface is known exactly:
// a hemisphere. Whatever the strategy believes about gouging, the simulation
// (which sweeps the tilted cutter by its own, independent route) and the sphere's
// own equation have the last word.

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { simulateRemoval, SimulationPlayback } from '../engine/simulate.js';
import { MOVE_STRIDE, OP, eachMove } from '../engine/cl.js';
import { makeRevolved, makeStepped } from './fixtures.js';
import { createMachine, rotaryPreset } from '../doc/machines.js';
import { chooseAngles, recentre, unwindsBefore, liftedAfter } from '../engine/five/kinematics.js';
import { buildHeightmap } from '../geom/heightmap.js';
import { toolSections } from '../engine/tool-geometry.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { opBlockedReason } from '../app/op-status.js';
import { setSetting, resetSettings } from '../app/settings.js';
import { createTool, createOperation, createSetup } from '../doc/schema.js';
import { meshFromSoup } from '../geom/mesh.js';
import { buildGcode } from '../post/index.js';
import { fiveFor } from '../engine/five/post-data.js';
import { fiveChecks } from '../engine/five/checks.js';

const DOME_R = 10;
const STOCK = { kind: 'box', min: [-12, -12, 0], max: [12, 12, 11] };

/** a hemisphere of radius 14 standing on a disc, wound outward like every revolved fixture */
function dome() {
  const outline = [[0, 0], [DOME_R, 0]];
  for (let deg = 5; deg <= 90; deg += 5) {
    outline.push([DOME_R * Math.cos((deg * Math.PI) / 180), DOME_R * Math.sin((deg * Math.PI) / 180)]);
  }
  return makeRevolved(outline, 72);
}
const domeHeight = (x, y) => {
  const r2 = x * x + y * y;
  return r2 >= DOME_R * DOME_R ? 0 : Math.sqrt(DOME_R * DOME_R - r2);
};

const BALL = {
  number: 1, type: 'ball', diameter: 6, fluteLength: 20, spindleRpm: 12000, feedCut: 900, feedPlunge: 300,
};

function finish5(mesh, params = {}, tool = BALL) {
  return generateToolpath({
    type: 'finish5', name: 'finish', tool, mesh, stock: STOCK,
    params: {
      ...defaultParamsFor('finish5', { stock: STOCK, tool }),
      topZ: 11, bottomZ: 0.5, clearanceHeight: 20, stepover: 0.15, tolerance: 0.02,
      ...params,
    },
  });
}

function carved(cl, tool = BALL, maxCells = 50_000) {
  const sim = simulateRemoval({ stock: STOCK, ops: [{ cl, tool }], maxCells });
  const pb = new SimulationPlayback(sim);
  pb.seek(sim.stepCount);
  return { sim, heights: pb.current };
}

/** how far below the dome the carved surface went, and how much stood proud of it, over its middle */
function against(sim, heights, radius = 8) {
  let gouge = 0;
  let proud = 0;
  let sum = 0;
  let cells = 0;
  for (let j = 0; j < sim.height; j++) {
    for (let i = 0; i < sim.width; i++) {
      const x = sim.origin[0] + i * sim.cellSize;
      const y = sim.origin[1] + j * sim.cellSize;
      if (Math.hypot(x, y) > radius) continue;
      const truth = domeHeight(x, y);
      const got = heights[j * sim.width + i];
      gouge = Math.max(gouge, truth - got);
      proud = Math.max(proud, got - truth);
      sum += got - truth;
      cells++;
    }
  }
  return { gouge, proud, mean: sum / cells };
}

const axisOf = (cl, n) => [cl.moves[n * MOVE_STRIDE + 4], cl.moves[n * MOVE_STRIDE + 5], cl.moves[n * MOVE_STRIDE + 6]];
const tiltOf = (a) => (Math.acos(Math.min(1, a[2])) * 180) / Math.PI;

test('5-axis finishing leans the cutter, in unit vectors within its limit, and starts and ends upright', () => {
  const cl = finish5(dome(), { leadAngle: 8, maxTilt: 35 });
  assert.ok(cl.count > 50, `${cl.count} moves`);
  assert.eq(cl.fiveAxis, true);
  let worst = 0;
  let leaning = 0;
  for (let n = 0; n < cl.count; n++) {
    const a = axisOf(cl, n);
    assert.close(Math.hypot(a[0], a[1], a[2]), 1, 1e-4, `move ${n} axis is a unit vector`);
    const tilt = tiltOf(a);
    worst = Math.max(worst, tilt);
    if (tilt > 5) leaning++;
  }
  assert.ok(worst <= 35.6, `leans ${worst.toFixed(1)}° with a 35° limit`);
  assert.ok(leaning > cl.count / 3, 'it actually leans over most of the dome');
  assert.eq(tiltOf(axisOf(cl, 0)), 0, 'starts upright');
  assert.eq(tiltOf(axisOf(cl, cl.count - 1)), 0, 'ends upright');
  assert.eq(cl.moves[(cl.count - 1) * MOVE_STRIDE], OP.RAPID);
});

test('with the normal for a law the cutter leans out along the slope, as far as the surface does', () => {
  const cl = finish5(dome(), { leadAngle: 0, maxTilt: 50, flatBelow: 0, axisTol: 0 });
  let checked = 0;
  eachMove(cl, (op, x, y, z, i, j, k) => {
    if (op !== OP.LINE) return;
    const rho = Math.hypot(x, y);
    // well inside the dome: away from its crown (no slope), and short of its foot, where the
    // lean has to build up from the flat ground outside at the turn rate it was given
    if (rho < 3.5 || rho > 5.5) return;
    const slope = (Math.asin(rho / DOME_R) * 180) / Math.PI;
    const tilt = tiltOf([i, j, k]);
    assert.close(tilt, slope, 4, `at radius ${rho.toFixed(1)}`);
    // leaning out: the top of the cutter is further from the dome's axis than its tip
    assert.ok(i * x + j * y > 0, 'the spindle leans away from the middle of the dome');
    checked++;
  });
  assert.ok(checked > 20, `checked ${checked} moves`);
});

test('the surface it leaves is the dome: nothing gouged, and no more standing than a stepover leaves', () => {
  const cl = finish5(dome(), { leadAngle: 8, maxTilt: 35 });
  const { sim, heights } = carved(cl);
  // out to where the dome is 45° steep (radius 7 of 10): past that a raster's rows are spread
  // along the surface and leave their cusps — the parallel finish does the same
  const { gouge, proud } = against(sim, heights, 7);
  assert.ok(gouge < 0.05, `the cutter went ${gouge.toFixed(3)}mm below the dome`);
  assert.ok(proud < 0.4, `${proud.toFixed(3)}mm of stock left standing on the dome`);
});

test('a steeper limit does not trade the surface for the angle: still no gouging', () => {
  for (const [lead, side, maxTilt] of [[0, 0, 60], [15, 0, 45], [5, 10, 40]]) {
    const { sim, heights } = carved(finish5(dome(), { leadAngle: lead, tiltAngle: side, maxTilt }));
    const { gouge } = against(sim, heights);
    assert.ok(gouge < 0.06, `lead ${lead} tilt ${side} max ${maxTilt}: ${gouge.toFixed(3)}mm below the dome`);
  }
});

test('with the lean held at vertical it is the parallel finish — same surface, no tilt in the program', () => {
  const upright = finish5(dome(), { tiltMode: 'fixed', leadAngle: 0, tiltAngle: 0 });
  assert.eq(upright.fiveAxis, false, 'nothing tilts');
  const parallel = generateToolpath({
    type: 'parallel3d', name: 'p', tool: BALL, mesh: dome(), stock: STOCK,
    params: {
      ...defaultParamsFor('parallel3d', { stock: STOCK, tool: BALL }),
      topZ: 11, bottomZ: 0.5, clearanceHeight: 20, stepover: 0.15, tolerance: 0.02,
    },
  });
  const a = carved(upright);
  const b = carved(parallel);
  let worst = 0;
  for (let j = 0; j < a.sim.height; j++) {
    for (let i = 0; i < a.sim.width; i++) {
      if (Math.hypot(a.sim.origin[0] + i * a.sim.cellSize, a.sim.origin[1] + j * a.sim.cellSize) > 7) continue;
      const k = j * a.sim.width + i;
      worst = Math.max(worst, Math.abs(a.heights[k] - b.heights[k]));
    }
  }
  assert.ok(worst < 0.4, `the two surfaces differ by ${worst.toFixed(3)}mm`);
});

test('the lean changes no faster than it was told to', () => {
  const rate = 6;
  const cl = finish5(dome(), { leadAngle: 10, axisRate: rate });
  let prev = null;
  let worst = 0;
  eachMove(cl, (op, x, y, z, i, j, k) => {
    if (op === OP.LINE && prev) {
      const dist = Math.hypot(x - prev[0], y - prev[1], z - prev[2]);
      const turn = Math.acos(Math.min(1, Math.max(-1, i * prev[3] + j * prev[4] + k * prev[5]))) * 180 / Math.PI;
      // two degrees of slack for the axis being snapped to a grid of leanings, and
      // short moves left out: the rate is a statement about a stretch of path
      if (dist > 0.8) worst = Math.max(worst, (turn - 2) / dist);
    }
    prev = op === OP.LINE ? [x, y, z, i, j, k] : null;
  });
  assert.ok(worst <= rate * 1.05, `turned ${worst.toFixed(1)}°/mm against a limit of ${rate}`);
});

test('a wide holder is kept out of the part: no point of a leaning program puts it in the metal', () => {
  // a spherical bowl in a puck, with a cutter held at a fixed 35° lean toward +X:
  // its wide holder, low on the shank, swings down into the bowl's far wall
  const bowlZ = (r) => 1 + 20 - Math.sqrt(400 - r * r);
  // …with a flat rim round it, which is what the holder would meet
  const outline = [[0, 0], [30, 0], [30, bowlZ(17.5)]];
  for (let r = 17.5; r >= 0; r -= 2.5) outline.push([r, bowlZ(r)]);
  outline.push([0, 1]);
  const bowl = makeRevolved(outline, 96);
  const holderTool = {
    ...BALL, fluteLength: 10, shank: [{ diameter: 6, length: 1 }], holder: [{ diameter: 28, length: 20 }],
  };
  const cl = finish5(bowl, {
    tiltMode: 'fixed', leadAngle: -35, maxTilt: 45, bottomZ: 0.5,
  }, holderTool);
  assert.eq(cl.fiveAxis, true);
  assert.ok(cl.notes.some((n) => /eased/.test(n.text)), 'it had to ease some points toward upright');

  // checked by brute force, not by the code that chose the lean: sample the
  // holder's own surface and ask the part's height map whether each sample is inside
  const map = buildHeightmap(bowl, { cellSize: 0.2, floor: -Infinity, dilate: false });
  const sections = toolSections(holderTool).find((x) => x.kind === 'holder').points;
  const lo = Math.min(...sections.map((p) => p[1]));
  const hi = Math.max(...sections.map((p) => p[1]));
  const rad = Math.max(...sections.map((p) => p[0]));
  const at = (x, y) => {
    const i = Math.round((x - map.min[0]) / map.cellSize);
    const j = Math.round((y - map.min[1]) / map.cellSize);
    if (i < 0 || j < 0 || i >= map.width || j >= map.height) return -Infinity;
    return map.data[j * map.width + i];
  };
  let worst = 0;
  eachMove(cl, (op, x, y, z, ai, aj, ak) => {
    if (op !== OP.LINE) return;
    // two unit vectors square to the axis
    const t = Math.abs(ak) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let u = [aj * t[2] - ak * t[1], ak * t[0] - ai * t[2], ai * t[1] - aj * t[0]];
    const un = Math.hypot(...u);
    u = u.map((c) => c / un);
    const w = [aj * u[2] - ak * u[1], ak * u[0] - ai * u[2], ai * u[1] - aj * u[0]];
    for (let s = lo; s <= hi; s += 2) {
      for (const r of [rad, rad * 0.5]) {
        for (let a = 0; a < 24; a++) {
          const c = Math.cos((a / 24) * Math.PI * 2) * r;
          const d = Math.sin((a / 24) * Math.PI * 2) * r;
          const px = x + ai * s + u[0] * c + w[0] * d;
          const py = y + aj * s + u[1] * c + w[1] * d;
          const pz = z + ak * s + u[2] * c + w[2] * d;
          worst = Math.max(worst, at(px, py) - pz);
        }
      }
    }
  });
  assert.ok(worst < 0.3, `the holder is ${worst.toFixed(2)}mm inside the part`);
});

test('it says what it did', () => {
  const cl = finish5(dome(), { leadAngle: 8 });
  assert.ok(cl.notes.some((n) => /leans the cutter/.test(n.text)), cl.notes.map((n) => n.text).join(' | '));
});

test('with no part it says so rather than throwing', () => {
  const cl = finish5({ positions: new Float32Array(0), indices: new Uint32Array(0) });
  assert.ok(cl.notes.some((n) => n.level === 'warn'));
});

test('the 5-axis operation is refused while the beta is off and runs when it is on', () => {
  resetSettings();
  const tool = createTool('ball');
  const op = createOperation('finish5');
  op.toolId = tool.id;
  const doc = { project: { tools: [tool], models: [{}], drawings: [] }, meshes: new Map(), findSetupOf: () => null };
  assert.ok(/beta/.test(opBlockedReason(doc, op) ?? ''), 'blocked while off');
  setSetting('fiveAxisBeta', true);
  assert.eq(opBlockedReason(doc, op), null);
  resetSettings();
});

// --- how it follows the surface -----------------------------------------------

test('with no lead and no fade the axis is the sphere\'s own normal, to a couple of degrees', () => {
  // the part is a hemisphere, so the true normal at (x, y) is (x, y, √(R²−ρ²))/R and the
  // cutter has nothing to be wrong about except how it reads the surface
  const cl = finish5(dome(), { leadAngle: 0, flatBelow: 0, axisTol: 0, maxTilt: 60 });
  const errors = [];
  eachMove(cl, (op, x, y, z, i, j, k) => {
    if (op !== OP.LINE) return;
    const rho = Math.hypot(x, y);
    if (rho < 1.5 || rho > DOME_R * 0.75) return;      // the crown, where it has no direction, and the foot
    const t = Math.asin(rho / DOME_R);
    const n = [(Math.sin(t) * x) / rho, (Math.sin(t) * y) / rho, Math.cos(t)];
    errors.push((Math.acos(Math.min(1, n[0] * i + n[1] * j + n[2] * k)) * 180) / Math.PI);
  });
  errors.sort((a, b) => a - b);
  assert.ok(errors.length > 100, `${errors.length} moves`);
  const p90 = errors[Math.floor(errors.length * 0.9)];
  assert.ok(p90 < 3, `90% of moves within ${p90.toFixed(1)}° of the normal`);
  assert.ok(errors[errors.length - 1] < 8, `worst ${errors[errors.length - 1].toFixed(1)}°`);
});

test('the lead is the only thing between the axis and the normal where the surface is smooth', () => {
  const lead = 8;
  const cl = finish5(dome(), { leadAngle: lead, flatBelow: 0, axisTol: 0, maxTilt: 60 });
  const errors = [];
  eachMove(cl, (op, x, y, z, i, j, k) => {
    if (op !== OP.LINE) return;
    const rho = Math.hypot(x, y);
    if (rho < 2 || rho > DOME_R * 0.7) return;
    const t = Math.asin(rho / DOME_R);
    const n = [(Math.sin(t) * x) / rho, (Math.sin(t) * y) / rho, Math.cos(t)];
    errors.push((Math.acos(Math.min(1, n[0] * i + n[1] * j + n[2] * k)) * 180) / Math.PI);
  });
  errors.sort((a, b) => a - b);
  assert.close(errors[errors.length >> 1], lead, 2, 'median error is the lead');
  assert.ok(errors[Math.floor(errors.length * 0.9)] < lead + 4, 'and no more than a few degrees beyond it');
});

test('a cutter on a flat tread is not leaned over by the riser beside it', () => {
  // two terraces, each flat: the only reason for the cutter to lean on either is the lead.
  // A plain fit of the slope over the neighbourhood of a point at the edge of a tread sees the
  // riser as well and reports a wall.
  const { mesh, height } = makeStepped({ base: 40, top: 20, baseHeight: 10, topHeight: 10 });
  const stock = { kind: 'box', min: [-2, -2, 0], max: [42, 42, height + 2] };
  const cl = generateToolpath({
    type: 'finish5', name: 'steps', tool: BALL, mesh, stock,
    params: {
      ...defaultParamsFor('finish5', { stock, tool: BALL }),
      topZ: height + 2, bottomZ: 0.5, clearanceHeight: height + 12, stepover: 0.15, tolerance: 0.02, leadAngle: 8,
    },
  });
  let checked = 0;
  let worst = 0;
  eachMove(cl, (op, x, y, z, i, j, k) => {
    if (op !== OP.LINE) return;
    // on a tread: the top at z=20 or the base at z=10 (the tip stands on it, ball nose)
    if (Math.abs(z - 20) > 0.05 && Math.abs(z - 10) > 0.05) return;
    checked++;
    worst = Math.max(worst, (Math.acos(Math.min(1, k)) * 180) / Math.PI);
  });
  assert.ok(checked > 50, `${checked} moves on a tread`);
  assert.ok(worst < 8 + 4, `leans ${worst.toFixed(1)}° on a flat tread with an 8° lead`);
});

test('a row over a crown passes through the pole and does not spin the turntable round it', () => {
  const machine = createMachine({ kind: 'mill', rotary: rotaryPreset('AC') });
  const cl = finish5(dome(), { leadAngle: 8 });
  let angles = { A: 0, C: 0 };
  let prev = null;
  let blocks = 0;
  let big = 0;
  let worst = 0;
  eachMove(cl, (op, x, y, z, i, j, k, feedClass) => {
    const rapid = op === OP.RAPID || feedClass === 0;
    if (rapid) angles = recentre(chooseAngles([i, j, k], machine, angles).angles, machine);
    else {
      const next = chooseAngles([i, j, k], machine, angles);
      if (prev) {
        const turn = Math.max(Math.abs(next.angles.C - angles.C), Math.abs(next.angles.A - angles.A));
        blocks++;
        if (turn > 30) big++;
        worst = Math.max(worst, turn);
      }
      angles = next.angles;
    }
    prev = rapid ? null : 1;
  });
  // The turntable has to go round *somewhere* — a dome's normals face every way — but
  // not in a few blocks of a few degrees of lean each: only a handful of the cutting
  // blocks may turn an axis more than 30°, and none may turn one anywhere near a half turn.
  assert.ok(big <= Math.max(3, blocks * 0.01), `${big} of ${blocks} cutting blocks turn an axis more than 30°`);
  assert.ok(worst < 90, `a cutting block turns an axis ${worst.toFixed(0)}°`);
});

// --- a surface that rolls --------------------------------------------------------

/** z = f(x, y) over a W×D block, as a triangle soup on a grid */
function heightField(f, W, D, step = 0.5) {
  const nx = Math.round(W / step);
  const ny = Math.round(D / step);
  const soup = [];
  const p = (i, j) => [(i * W) / nx, (j * D) / ny, f((i * W) / nx, (j * D) / ny)];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
      soup.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }
  return meshFromSoup(new Float32Array(soup));
}

function rolling() {
  const top = 13.5;
  const mesh = heightField((x, y) => 10 + 3 * Math.sin(x / 4) * Math.cos(y / 5), 40, 30);
  const stock = { kind: 'box', min: [-2, -2, 0], max: [42, 32, top + 2] };
  const machine = createMachine({ kind: 'mill', rotary: rotaryPreset('AC') });
  const cl = generateToolpath({
    type: 'finish5', name: 'hills', tool: BALL, mesh, stock,
    params: {
      ...defaultParamsFor('finish5', { stock, tool: BALL }),
      topZ: top + 2, bottomZ: 0.5, clearanceHeight: top + 12,
    },
    five: { rotary: machine.rotary },
  });
  const setup = createSetup();
  setup.five = { enabled: true, pivot: [0, 0, -100] };
  return { cl, machine, five: fiveFor(setup, machine, cl) };
}

test('over hills and hollows the turntable is never run into its stop, and no cut flips branch', () => {
  const { cl, machine, five } = rolling();
  const checks = fiveChecks(cl, five);
  assert.eq(checks.stats.flips, 0, 'no cutting move turns a rotary axis more than 90° from the one before');
  const text = buildGcode('linuxcnc', [{
    name: 'hills', cl, wcs: 'G54', setup: 's', setupName: 's', orientation: null, wrap: null, five,
  }], {}).text;
  let worst = 0;
  for (const m of text.matchAll(/\bC(-?[\d.]+)/g)) worst = Math.max(worst, Math.abs(+m[1]));
  const stop = machine.rotary.find((a) => a.letter === 'C').max;
  assert.ok(worst < stop - 15, `C reaches ${worst.toFixed(0)}° of ±${stop}°`);
  assert.ok(!/jumps \d+ degrees/.test(text), 'and the file does not warn of a jump between cutting blocks');
});

test('the tool lifts out and starts again when the turntable runs out of room, and the post unwinds there', () => {
  const { cl, machine } = rolling();
  // walk it the way the post does and count the unwinds: more than one means a pass was
  // split where the turntable was nearly at its stop, and C came back within half a turn
  let angles = { A: 0, C: 0 };
  let prevAxis = null;
  let prevPoint = null;
  let lifted = false;
  let unwinds = 0;
  for (let n = 0; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    const rapid = cl.moves[o] === OP.RAPID;
    const axis = [cl.moves[o + 4], cl.moves[o + 5], cl.moves[o + 6]];
    const point = [cl.moves[o + 1], cl.moves[o + 2], cl.moves[o + 3]];
    const swings = prevAxis && Math.acos(Math.min(1, prevAxis[0] * axis[0] + prevAxis[1] * axis[1] + prevAxis[2] * axis[2])) > 1e-6;
    if (unwindsBefore({ lifted, rapid, swings })) {
      const home = recentre(angles, machine);
      if (Math.abs(home.C - angles.C) > 1e-9) unwinds++;
      angles = home;
    }
    lifted = liftedAfter({ lifted, rapid, rises: Boolean(prevPoint) && point[2] > prevPoint[2] + 1e-9 });
    angles = chooseAngles(axis, machine, angles).angles;
    prevAxis = axis;
    prevPoint = point;
  }
  assert.ok(unwinds >= 1, `${unwinds} unwinds: the hills wind the table more than a turn`);
});
