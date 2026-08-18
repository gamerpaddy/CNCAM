import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { eachMove, OP, FEED } from '../engine/cl.js';
import { cutLoopWithRamp } from '../engine/linking.js';
import { CLBuilder } from '../engine/cl.js';
import { fitCircle } from '../engine/strategies/drill.js';
import { makeBox, makeTube } from './fixtures.js';

const TOOL = {
  number: 1, diameter: 6, spindleRpm: 10000, feedCut: 800, feedPlunge: 300,
};

// --- ramp entry ---

test('ramp entry descends along the loop, then cuts a full perimeter', () => {
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 800, plunge: 300 });
  const loop = [0, 0, 20, 0, 20, 20, 0, 20]; // 20mm square
  cutLoopWithRamp(cl, loop, 0, -2, 10);
  let rampMoves = 0, minZ = Infinity, plungeDrop = 0;
  eachMove(cl.finish(), (op, x, y, z, i, j, k, feed) => {
    if (feed === FEED.RAMP) rampMoves++;
    if (feed === FEED.PLUNGE) plungeDrop++;
    minZ = Math.min(minZ, z);
  });
  assert.ok(rampMoves >= 1, 'has ramp moves');
  assert.close(minZ, -2, 1e-6, 'reaches target depth');
  assert.eq(plungeDrop, 1, 'only the air move to material top is a plunge');
});

test('ramp angle 0 falls back to straight plunge', () => {
  const cl = new CLBuilder();
  cutLoopWithRamp(cl, [0, 0, 10, 0, 10, 10, 0, 10], 0, -2, 0);
  const out = cl.finish();
  let ramps = 0;
  eachMove(out, (op, x, y, z, i, j, k, feed) => { if (feed === FEED.RAMP) ramps++; });
  assert.eq(ramps, 0);
});

// --- clear2d ---

test('clear2d clears between stock and part, walls last', () => {
  const cl = generateToolpath({
    type: 'clear2d', name: 'rough', tool: TOOL,
    mesh: makeBox(20, 20, 10),
    stock: { min: [-10, -10, 0], max: [30, 30, 10] },
    params: { topZ: 10, bottomZ: 8, stepdown: 2, stepover: 0.5, stockToLeave: 0.5,
              clearanceHeight: 20, tolerance: 0.01, rampAngle: 0 },
  });
  assert.ok(cl.count > 20, 'produces passes');
  let minDistToPart = Infinity;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE || feed !== FEED.CUT) return;
    assert.close(z, 8, 1e-6, 'single depth');
    // distance from part footprint (0..20 square) in XY
    const dx = Math.max(0 - x, 0, x - 20);
    const dy = Math.max(0 - y, 0, y - 20);
    minDistToPart = Math.min(minDistToPart, Math.hypot(dx, dy));
  });
  // closest approach = radius + stockToLeave = 3.5
  assert.close(minDistToPart, 3.5, 0.05, 'respects stock to leave');
});

test('clear2d rapids travel above the stock, not through it', () => {
  // This used to insist every travelling rapid was at clearance, which is a
  // stricter claim than safety needs and cost a full climb and descent between
  // every ring of every level — 36 of them on a 24mm-deep pocket. What has to
  // be true is that a travelling rapid is above everything the job is made of,
  // and the stock top is that height by definition. See crossingPlane.
  const stockTop = 10;
  const cl = generateToolpath({
    type: 'clear2d', name: 'rough', tool: TOOL,
    mesh: makeBox(20, 20, 10),
    stock: { min: [-5, -5, 0], max: [25, 25, stockTop] },
    params: { topZ: 10, bottomZ: 6, stepdown: 2, stepover: 0.5, stockToLeave: 0,
              clearanceHeight: 20, entryGap: 1, tolerance: 0.01, rampAngle: 0 },
  });
  let prev = null;
  let travels = 0;
  eachMove(cl, (op, x, y, z) => {
    if (op === OP.RAPID && prev) {
      const moved = Math.hypot(x - prev.x, y - prev.y) > 1e-6;
      if (moved) {
        travels++;
        assert.ok(Math.min(z, prev.z) > stockTop,
          `a rapid travels at z=${Math.min(z, prev.z)}, into ${stockTop}mm of stock`);
      }
    }
    prev = { x, y, z };
  });
  assert.ok(travels > 0, 'there are travelling rapids to check');

  // and with a clamp in the setup it gives that up and uses clearance
  const clamped = generateToolpath({
    type: 'clear2d', name: 'rough', tool: TOOL,
    mesh: makeBox(20, 20, 10),
    stock: { min: [-5, -5, 0], max: [25, 25, stockTop] },
    fixtures: [{ kind: 'box', name: 'jaw', min: [-5, -15, 0], max: [25, -5, 25] }],
    params: { topZ: 10, bottomZ: 6, stepdown: 2, stepover: 0.5, stockToLeave: 0,
              clearanceHeight: 20, entryGap: 1, tolerance: 0.01, rampAngle: 0 },
  });
  let prevZ = null;
  eachMove(clamped, (op, x, y, z) => {
    if (op === OP.RAPID) {
      assert.ok(z === 20 || prevZ === 20 || prevZ === null, `rapid at z=${z} from ${prevZ}`);
    }
    prevZ = z;
  });
});

// --- drill ---

test('fitCircle accepts circles and rejects squares', () => {
  const circle = [];
  for (let i = 0; i < 24; i++) {
    circle.push(5 + 3 * Math.cos((i / 24) * 2 * Math.PI), 7 + 3 * Math.sin((i / 24) * 2 * Math.PI));
  }
  const fit = fitCircle(circle);
  assert.ok(fit, 'circle fits');
  assert.close(fit.cx, 5, 1e-6);
  assert.close(fit.cy, 7, 1e-6);
  assert.close(fit.r, 3, 0.01);
  assert.eq(fitCircle([0, 0, 10, 0, 10, 10, 0, 10, 5, 5, 2, 8]), null, 'square-ish rejected');
});

test('drill finds the tube hole and emits a DRILL move', () => {
  const cl = generateToolpath({
    type: 'drill', name: 'holes', tool: TOOL, // Ø6 drill
    mesh: makeTube(15, 10, 10, 3, 8),         // hole Ø6 at (15,10)
    stock: { min: [0, 0, 0], max: [30, 20, 8] },
    params: { topZ: 8, bottomZ: -1, clearanceHeight: 15, entryGap: 2, peck: 2 },
  });
  const drills = [];
  eachMove(cl, (op, x, y, z, i, j) => {
    if (op === OP.DRILL) drills.push({ x, y, z, retract: i, peck: j });
  });
  assert.eq(drills.length, 1);
  assert.close(drills[0].x, 15, 0.05);
  assert.close(drills[0].y, 10, 0.05);
  assert.close(drills[0].z, -1, 1e-6, 'drills to bottomZ');
  assert.close(drills[0].retract, 10, 1e-6, 'retract 2 above top');
  assert.close(drills[0].peck, 2, 1e-6);
});

test('drill skips holes that do not match the tool diameter', () => {
  const cl = generateToolpath({
    type: 'drill', name: 'holes', tool: TOOL,   // Ø6 drill vs Ø10 hole
    mesh: makeTube(15, 10, 10, 5, 8),
    stock: { min: [0, 0, 0], max: [30, 20, 8] },
    params: { topZ: 8, bottomZ: -1, clearanceHeight: 15, peck: 0 },
  });
  let drills = 0;
  eachMove(cl, (op) => { if (op === OP.DRILL) drills++; });
  assert.eq(drills, 0);
});

test('drill takes its hole positions from a drawing when it is given one', () => {
  // A hole position is a thing you draw. Recognition off the solid is what a
  // modelled part gives, and it was the only thing drilling could read — so a
  // plate whose holes arrive as circles on a DXF could not be drilled at all,
  // while engraving and slotting had followed drawings all along.
  const circle = (cx, cy, r, n = 64) => {
    const points = [];
    for (let i = 0; i <= n; i++) {          // closed: the first point repeats
      const a = (i / n) * Math.PI * 2;
      points.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    return { points, closed: true };
  };
  const drawing = [
    circle(8, 8, 3),
    circle(22, 12, 3),
    { points: [0, 0, 30, 20], closed: false },      // a line is not a hole
    circle(15, 4, 6),                               // and ⌀12 is not this drill
  ];
  const cl = generateToolpath({
    type: 'drill', tool: TOOL, mesh: makeBox(30, 20, 8),
    stock: { min: [0, 0, 0], max: [30, 20, 8] },
    params: { topZ: 8, bottomZ: 0, clearanceHeight: 15, entryGap: 2 },
    drawing,
  });
  const drills = [];
  eachMove(cl, (op, x, y, z) => { if (op === OP.DRILL) drills.push([x, y, z]); });
  assert.eq(drills.length, 2, 'the two ⌀6 circles, and neither the line nor the ⌀12');
  const at = drills.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).sort().join(' ');
  assert.eq(at, '22.0,12.0 8.0,8.0', 'at the centres they were drawn at');
});

test('and says so when the drawing has no circles in it', () => {
  const cl = generateToolpath({
    type: 'drill', tool: TOOL, mesh: makeBox(30, 20, 8),
    stock: { min: [0, 0, 0], max: [30, 20, 8] },
    params: { topZ: 8, bottomZ: 0, clearanceHeight: 15 },
    drawing: [{ points: [0, 0, 30, 20], closed: false }],
  });
  let drills = 0;
  eachMove(cl, (op) => { if (op === OP.DRILL) drills++; });
  assert.eq(drills, 0);
  assert.ok(cl.notes.some((n) => /no circles in the drawing/.test(n.text)),
    `said why: ${JSON.stringify(cl.notes)}`);
});
