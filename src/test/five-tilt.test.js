// A tilted cutter: how low it reaches, and what it takes out of the stock.

import { test, assert } from './runner.js';
import { toolShells, lowestAbove, shellBox } from '../engine/five/tilt-kernel.js';
import {
  stampSpacing, scallopBudget, blendAxis, angleBetween, bodyTouchTilted,
} from '../engine/five/tilt-sweep.js';
import { simulateRemoval, SimulationPlayback, positionAtStep } from '../engine/simulate.js';
import { clearanceProfile } from '../engine/tool-geometry.js';
import { CLBuilder, FEED } from '../engine/cl.js';

const RAD = Math.PI / 180;
const BASE = { number: 1, diameter: 6, fluteLength: 20, spindleRpm: 10000, feedCut: 800, feedPlunge: 300 };
const TOOLS = {
  flat: { ...BASE, type: 'flat' },
  ball: { ...BASE, type: 'ball' },
  bull: { ...BASE, type: 'bull', cornerRadius: 1 },
  vee: { ...BASE, type: 'chamfer', tipAngle: 90 },
};
const axisAt = (tiltDeg, azimuthDeg = 0) => [
  Math.sin(tiltDeg * RAD) * Math.cos(azimuthDeg * RAD),
  Math.sin(tiltDeg * RAD) * Math.sin(azimuthDeg * RAD),
  Math.cos(tiltDeg * RAD),
];

for (const [name, tool] of Object.entries(TOOLS)) {
  test(`${name}: with the axis vertical the solve is the 3-axis profile lookup`, () => {
    const shells = toolShells(tool);
    const profile = clearanceProfile(tool);
    const R = tool.diameter / 2;
    for (let d = 0; d < R - 1e-3; d += 0.17) {
      for (const az of [0, 37, 90, 211]) {
        const ex = d * Math.cos(az * RAD);
        const ey = d * Math.sin(az * RAD);
        const z = lowestAbove(shells.cutting, 0, 0, 1, ex, ey);
        assert.close(z, profile(d), 2e-3, `${name} at ${d.toFixed(2)}`);
      }
    }
    assert.eq(lowestAbove(shells.cutting, 0, 0, 1, R + 0.5, 0), Infinity, 'outside the cutter');
  });
}

test('a tilted ball is the same sphere: its lowest height is the sphere\'s, whatever the tilt', () => {
  const shells = toolShells(TOOLS.ball);
  const R = 3;
  for (const [tilt, az] of [[0, 0], [20, 0], [35, 140], [60, 270], [-25, 10]]) {
    const a = axisAt(Math.abs(tilt), az + (tilt < 0 ? 180 : 0));
    // the sphere's centre is R up the axis from the tip
    const centre = [a[0] * R, a[1] * R, a[2] * R];
    for (const [ex, ey] of [[0, 0], [1, 0.5], [-1.2, 1.1], [centre[0], centre[1]], [centre[0] + 2, centre[1] - 1]]) {
      const d = Math.hypot(ex - centre[0], ey - centre[1]);
      const z = lowestAbove(shells.cutting, a[0], a[1], a[2], ex, ey);
      if (d >= R - 0.05) continue;     // the rim, where the polyline's facets show
      assert.close(z, centre[2] - Math.sqrt(R * R - d * d), 4e-3, `tilt ${tilt} at ${ex},${ey}`);
    }
  }
});

test('a tilted flat end mill reaches along the plane of its end face', () => {
  const shells = toolShells(TOOLS.flat);
  const a = axisAt(30, 0);
  // the end face is the plane a·p = 0 through the tip, so over a point inside
  // its ellipse the lowest height is where the vertical line crosses that plane
  for (const [ex, ey] of [[0, 0], [1, 1], [-1.5, 0.5], [0.3, -2]]) {
    const u = a[0] * ex + a[1] * ey;
    const z = -u / a[2];
    assert.ok(ex * ex + ey * ey + z * z <= 9, 'sanity: inside the face');
    assert.close(lowestAbove(shells.cutting, a[0], a[1], a[2], ex, ey), z, 1e-6, `${ex},${ey}`);
  }
});

test('the lowest point of a tilted cutter is not its tip', () => {
  const shells = toolShells(TOOLS.flat);
  const a = axisAt(40, 0);
  const box = shellBox(shells.cutting, a[0], a[1], a[2]);
  assert.ok(box.floor < -1, `a flat end tilted 40° digs its edge ${-box.floor.toFixed(2)}mm below the tip`);
  const vertical = shellBox(shells.cutting, 0, 0, 1);
  assert.close(vertical.floor, 0, 1e-9);
});

test('the spacing it stamps at leaves a scallop no taller than the budget', () => {
  for (const [R, cell] of [[3, 0.2], [1, 0.1], [6, 0.5], [0.5, 0.05]]) {
    const s = stampSpacing(R, cell);
    const scallop = (s * s) / (8 * R);
    assert.ok(scallop <= scallopBudget(cell) * 1.05 || s <= cell * 0.26,
      `R=${R}: ${s.toFixed(3)}mm apart leaves ${scallop.toFixed(4)}mm`);
  }
});

test('blending two axes stays a unit vector, and the angle between them adds up', () => {
  const a = axisAt(0);
  const b = axisAt(40, 30);
  assert.close(angleBetween(a, b), 40, 1e-9);
  for (const t of [0, 0.25, 0.5, 1]) {
    const m = blendAxis(a, b, t);
    assert.close(Math.hypot(m[0], m[1], m[2]), 1, 1e-12);
  }
  assert.close(angleBetween(a, blendAxis(a, b, 0.5)), 20, 0.2);
});

// --- through the simulator -------------------------------------------------

const STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] };

/** A groove cut along X at y=20 with the ball's *centre* at height zc, the axis tilted. */
function groove(axis, zc = 12.2, tool = TOOLS.ball) {
  const R = tool.diameter / 2;
  const tip = (x) => [x - R * axis[0], 20 - R * axis[1], zc - R * axis[2]];
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.setAxis(...axis);
  const start = tip(-8);
  cl.rapid(start[0], start[1], start[2] + 6);
  cl.rapid(...start);
  const end = tip(48);
  cl.cut(end[0], end[1], end[2]);
  return { cl: cl.finish(), tool };
}

function finalHeights(ops, maxCells = 40_000) {
  const sim = simulateRemoval({ stock: STOCK, ops, maxCells });
  const pb = new SimulationPlayback(sim);
  pb.seek(sim.stepCount);
  return { sim, heights: pb.current };
}

test('a groove cut with the ball centre on one path is the same whichever way the tool leans', () => {
  // the same ball-centre path, three spindle directions: the vertical one goes
  // through the analytic sweep, the other two are stamped — and a sphere cannot
  // tell them apart while only the sphere is in the metal
  const up = finalHeights([groove([0, 0, 1])]);
  assert.ok(up.sim.eventCount > 0, 'it cut something');
  assert.eq(up.sim.axis, null, 'a vertical program records no axis');
  for (const axis of [axisAt(30, 0), axisAt(35, 200), axisAt(25, 90)]) {
    const leaning = finalHeights([groove(axis)]);
    assert.ok(leaning.sim.axis, 'a tilted program records its axis');
    let worst = 0;
    for (let k = 0; k < up.heights.length; k++) {
      worst = Math.max(worst, Math.abs(up.heights[k] - leaning.heights[k]));
    }
    assert.ok(worst < 0.06, `${axis.map((v) => v.toFixed(2))}: heightmaps differ by ${worst.toFixed(3)}mm`);
  }
});

test('a hair of tilt routes through the stamped sweep and agrees with the analytic one', () => {
  // 0.003° is still "tilted" to the dispatcher but is the vertical cutter to the eye:
  // any gap between the two sweeps shows up here, undiluted by geometry
  const flat = finalHeights([groove([0, 0, 1], 12.2, TOOLS.bull)]);
  const hair = finalHeights([groove([5e-5, 0, 1], 12.2, TOOLS.bull)]);
  assert.ok(hair.sim.axis, 'the hair-tilted program took the tilted path');
  let worst = 0;
  for (let k = 0; k < flat.heights.length; k++) worst = Math.max(worst, Math.abs(flat.heights[k] - hair.heights[k]));
  assert.ok(worst < 0.05, `${worst.toFixed(3)}mm apart`);
});

test('a leaning flat end mill digs its low edge, not its centre, into a plane', () => {
  const flat = TOOLS.flat;
  const axis = axisAt(30, 0);       // leaning toward +X
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.setAxis(...axis);
  cl.rapid(20, 20, 15);
  cl.rapid(20, 20, 8);              // tip 2mm into the 10mm stock
  const sim = simulateRemoval({ stock: STOCK, ops: [{ cl: cl.finish(), tool: flat }], maxCells: 40_000 });
  const pb = new SimulationPlayback(sim);
  pb.seek(sim.stepCount);
  const at = (x, y) => pb.current[Math.round((y - sim.origin[1]) / sim.cellSize) * sim.width
    + Math.round((x - sim.origin[0]) / sim.cellSize)];
  // the end face is a tilted plane through the tip: height = 8 − (x−20)·tan(…) over its ellipse
  // z = tip_z − u/az with u = ax·(x−20)
  const expect = (x) => 8 - (axis[0] * (x - 20)) / axis[2];
  for (const x of [17.5, 19, 20, 21, 22.5]) {
    assert.close(at(x, 20), Math.max(0, Math.min(10, expect(x))), 0.08, `x=${x}`);
  }
});

test('the position at a step carries the spindle direction', () => {
  const axis = axisAt(30, 0);
  const { sim } = finalHeights([groove(axis)]);
  const tool = TOOLS.ball;
  const at = positionAtStep(sim, [{ tool }], sim.stepCount - 1);
  assert.close(at.axis[0], axis[0], 1e-5);
  assert.close(at.axis[2], axis[2], 1e-5);
  const plain = finalHeights([groove([0, 0, 1])]);
  assert.eq(positionAtStep(plain.sim, [{ tool }], 3).axis.join(), '0,0,1');
});

test('a tilted holder that comes down on the wall beside the cut is a collision', () => {
  const holder = {
    ...TOOLS.flat, fluteLength: 10,
    holder: [{ diameter: 24, length: 30 }],
  };
  const shells = toolShells(holder);
  assert.ok(shells.body.n > 0, 'the tool has a body above its flutes');
  const grid = { width: 60, height: 60, cellSize: 1, origin: [-30, -30] };
  const world = {
    heights: new Float32Array(60 * 60).fill(10), mask: new Uint8Array(60 * 60).fill(1), grid, columns: null,
  };
  // standing upright with the flutes just in the metal, the holder is clear of it
  assert.eq(bodyTouchTilted(world, [0, 0, 2], [0, 0, 1], shells, 10, 0.05), null);
  // the same tip leaning 40° swings the wide holder's edge down into the stock
  const hit = bodyTouchTilted(world, [0, 0, 2], axisAt(40, 0), shells, 10, 0.05);
  assert.ok(hit && hit.depth > 1, `the holder reached ${hit?.depth}`);
  assert.ok(['holder', 'shank'].includes(hit.kind), hit.kind);
});
