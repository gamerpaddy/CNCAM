// The running order: what it may change, what it must not, and that it never
// makes a program slower. The constraint tests use plain cutting lines so each
// rule is exercised alone; the last tests run the original and the reordered
// programs through the simulator and compare the metal they leave.

import { test, assert } from './runner.js';
import { CLBuilder } from '../engine/cl.js';
import { planOrder, mustStayOrdered } from '../engine/order.js';
import { simulateRemoval } from '../engine/simulate.js';

const STOCK = { kind: 'box', min: [0, 0, 0], max: [100, 40, 10] };
const RADIUS = 2;

/** An operation that cuts one straight line at depth, with the given tool. */
function cut(id, toolNumber, [x0, y0, x1, y1], extra = {}) {
  const cl = new CLBuilder();
  cl.toolChange(toolNumber);
  cl.spindle(9000);
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(x0, y0, 12);
  cl.cut(x0, y0, 5, FEED_PLUNGE);
  cl.cut(x1, y1, 5);
  cl.rapid(x1, y1, 12);
  return {
    id, type: extra.type ?? 'contour2d', enabled: extra.enabled ?? true, toolNumber, radius: RADIUS,
    params: extra.params ?? {}, cl: extra.noToolpath ? null : cl.finish(),
  };
}
const FEED_PLUNGE = 4;

const names = (plan) => plan.order.join(',');
const OPTS = { stock: STOCK, rapid: { xy: 3000, z: 3000 }, changeSeconds: 30 };

test('operations in different places with different tools are grouped by tool', () => {
  const ops = [cut('a', 1, [5, 20, 15, 20]), cut('b', 2, [45, 20, 55, 20]), cut('c', 1, [85, 20, 95, 20])];
  const plan = planOrder(ops, OPTS);
  assert.ok(plan.changed, 'it found a better order');
  assert.eq(names(plan), 'a,c,b');
  assert.eq(plan.before.changes, 3);
  assert.eq(plan.after.changes, 2);
  assert.ok(plan.after.seconds < plan.before.seconds, 'and the clock agrees');
});

test('a pass that works from what the others left is not moved, nor is anything moved across it', () => {
  const rest = cut('c', 1, [85, 20, 95, 20], { params: { restMachining: true } });
  const ops = [cut('a', 1, [5, 20, 15, 20]), cut('b', 2, [45, 20, 55, 20]), rest];
  assert.ok(mustStayOrdered(ops[1], rest, { stockBottom: 0, footprints: new Map() }), 'by the rule');
  assert.eq(names(planOrder(ops, OPTS)), 'a,b,c');
  // and a finishing strategy that reads earlier operations is the same
  const finish = cut('f', 1, [85, 20, 95, 20], { type: 'waterline' });
  assert.eq(names(planOrder([ops[0], ops[1], finish], OPTS)), 'a,b,f');
});

test('two operations that cut the same ground keep their order; the rest are still free', () => {
  // c overlaps a, so c stays after a — but b is nowhere near either
  const ops = [cut('a', 1, [5, 20, 15, 20]), cut('b', 2, [45, 20, 55, 20]), cut('c', 1, [8, 20, 18, 20])];
  const plan = planOrder(ops, OPTS);
  assert.eq(names(plan), 'a,c,b');
  // and if b and c overlap, b has to come before c, and nothing is left to gain
  const ops2 = [cut('a', 1, [5, 20, 15, 20]), cut('b', 2, [45, 20, 55, 20]), cut('c', 1, [48, 20, 58, 20])];
  const plan2 = planOrder(ops2, OPTS);
  assert.eq(names(plan2), 'a,b,c');
  assert.ok(!plan2.changed);
});

test('a hole is spotted, then drilled, then tapped, whatever else would have been cheaper', () => {
  const tap = cut('tap', 3, [5, 20, 5, 22], { type: 'tap' });
  const spot = cut('spot', 1, [60, 20, 60, 22], { type: 'spot' });
  const drill = cut('drill', 2, [80, 20, 80, 22], { type: 'drill' });
  const ops = [spot, drill, tap, cut('x', 1, [30, 20, 35, 20]), cut('y', 2, [90, 30, 95, 30])];
  const plan = planOrder(ops, OPTS);
  const at = (id) => plan.order.indexOf(id);
  assert.ok(at('spot') < at('drill') && at('drill') < at('tap'), names(plan));
});

test('the cut that frees the part is not crossed', () => {
  const out = cut('out', 1, [2, 2, 98, 2], { params: { bottomZ: 0 } });
  const ops = [cut('a', 1, [20, 20, 30, 20]), out, cut('b', 2, [50, 30, 60, 30])];
  assert.eq(names(planOrder(ops, OPTS)), 'a,out,b', 'nothing moves above or below it');
  // a contour that stops short of the bottom is an ordinary one
  const shallow = cut('out', 1, [2, 2, 98, 2], { params: { bottomZ: 4 } });
  const ops2 = [cut('a', 1, [20, 20, 30, 20]), cut('b', 2, [50, 30, 60, 30]), cut('d', 1, [75, 30, 85, 30])];
  assert.eq(names(planOrder(ops2, OPTS)), 'a,d,b');
  assert.ok(shallow);
});

test('a command is an instruction about when, and nothing moves across it; a disabled operation is skipped', () => {
  const cmd = { id: 'cmd', type: 'command', enabled: true, toolNumber: null, params: {}, cl: null, radius: 0 };
  const ops = [cut('a', 1, [5, 20, 15, 20]), cut('b', 2, [45, 20, 55, 20]), cmd, cut('c', 1, [85, 20, 95, 20])];
  assert.eq(names(planOrder(ops, OPTS)), 'a,b,cmd,c');
  const off = cut('off', 2, [45, 30, 55, 30], { enabled: false });
  const ops2 = [cut('a', 1, [5, 20, 15, 20]), off, cut('b', 2, [45, 20, 55, 20]), cut('c', 1, [85, 20, 95, 20])];
  const plan = planOrder(ops2, OPTS);
  assert.ok(plan.order.includes('off'), 'still in the list');
  assert.eq(plan.order.indexOf('off'), 1, 'and where it was');
  assert.eq(plan.order.filter((id) => id !== 'off').join(','), 'a,c,b');
});

test('an operation not generated yet is assumed to cut anywhere, so it holds its place', () => {
  const ops = [cut('a', 1, [5, 20, 15, 20]), cut('b', 2, [45, 20, 55, 20], { noToolpath: true }), cut('c', 1, [85, 20, 95, 20])];
  assert.eq(names(planOrder(ops, OPTS)), 'a,b,c');
});

test('it never makes the program slower: a good order is left alone, and so is a gain of nothing', () => {
  const good = [cut('a', 1, [5, 20, 15, 20]), cut('c', 1, [85, 20, 95, 20]), cut('b', 2, [45, 20, 55, 20])];
  const plan = planOrder(good, OPTS);
  assert.ok(!plan.changed);
  assert.eq(names(plan), 'a,c,b');
  assert.eq(planOrder(good.slice(0, 2), OPTS).changed, false, 'two operations: nothing to do');
  // a stock it cannot place the operations on is answered, not guessed at
  assert.ok(!planOrder(good, { ...OPTS, stock: null }).changed);
});

test('within one tool the nearest start goes next, which saves rapids and no tool change', () => {
  const ops = [cut('a', 1, [5, 20, 10, 20]), cut('far', 1, [90, 20, 95, 20]), cut('near', 1, [20, 20, 25, 20])];
  const plan = planOrder(ops, { ...OPTS, changeSeconds: 0 });
  assert.eq(names(plan), 'a,near,far');
  assert.ok(plan.after.travelSeconds < plan.before.travelSeconds);
});

test('the same metal comes out whichever order the program is run in', () => {
  const tool = { number: 1, type: 'flat', diameter: 2 * RADIUS, flutes: 2, fluteLength: 15, spindleRpm: 9000, feedCut: 600, feedPlunge: 200 };
  const ops = [cut('a', 1, [5, 20, 25, 20]), cut('b', 2, [45, 10, 55, 30]), cut('c', 1, [75, 20, 95, 20]), cut('d', 2, [30, 35, 40, 35])];
  const plan = planOrder(ops, OPTS);
  assert.ok(plan.changed && names(plan) !== 'a,b,c,d', `reordered: ${names(plan)}`);
  const run = (order) => simulateRemoval({
    stock: STOCK, maxCells: 60_000,
    ops: order.map((id) => ({ cl: ops.find((o) => o.id === id).cl, tool: { ...tool, number: ops.find((o) => o.id === id).toolNumber } })),
  });
  const a = run(ops.map((o) => o.id));
  const b = run(plan.order);
  assert.eq(a.final.length, b.final.length);
  let same = true;
  for (let i = 0; i < a.final.length; i++) if (a.final[i] !== b.final[i]) { same = false; break; }
  assert.ok(same, 'the finished surface is bit for bit the same');
  let removed = 0;
  for (let i = 0; i < a.final.length; i++) if (a.final[i] < STOCK.max[2] - 1e-6) removed++;
  assert.ok(removed > 50, 'and it is a surface with something cut in it, or this proves nothing');
});
