import { test, assert } from './runner.js';
import { CLBuilder, eachMove, OP, FEED, MOVE_STRIDE, rapidRates } from '../engine/cl.js';
import { estimateSeconds } from '../engine/toolpath.js';

test('CLBuilder records moves with tool axis', () => {
  const b = new CLBuilder(2); // force a grow
  b.rapid(0, 0, 10);
  b.cut(10, 0, -2);
  b.setAxis(0, 1, 0);
  b.cut(10, 10, -2);
  const cl = b.finish();

  assert.eq(cl.count, 3);
  assert.eq(cl.moves.length, 3 * MOVE_STRIDE);

  const rows = [];
  eachMove(cl, (op, x, y, z, i, j, k, feed) => rows.push({ op, x, z, j, feed }));
  assert.eq(rows[0].op, OP.RAPID);
  assert.eq(rows[0].feed, FEED.RAPID);
  assert.eq(rows[1].op, OP.LINE);
  assert.close(rows[1].z, -2);
  assert.close(rows[1].j, 0, 1e-6, 'default axis is Z');
  assert.close(rows[2].j, 1, 1e-6, 'axis change applies to later moves');
});

test('events attach to the next move index', () => {
  const b = new CLBuilder();
  b.toolChange(1);
  b.rapid(0, 0, 10);
  b.spindle(12000);
  b.cut(5, 0, 0);
  const cl = b.finish();
  assert.eq(cl.events[0].index, 0);
  assert.eq(cl.events[1].index, 1);
  assert.eq(cl.events[1].rpm, 12000);
});

test('a rapid is clocked against both axis rates, not one', () => {
  // rapidFeedZ was on every machine record, editable in the manager, printed in
  // the panel — and read by nothing. Z is routinely half the table's rate, and
  // a job is mostly retracts, so every estimate ran short.
  const b = new CLBuilder();
  b.rapid(0, 0, 0);
  b.rapid(60, 0, 0);          // 60mm of XY at 6000 = 0.6s
  b.rapid(60, 0, -40);        // 40mm of Z at 4000 = 0.6s
  b.rapid(0, 0, -40);         // 60mm of XY again
  const cl = b.finish();

  assert.close(estimateSeconds(cl, 6000), (60 + 40 + 60) / 6000 * 60, 1e-6,
    'one rate still means one rate');
  assert.close(estimateSeconds(cl, { xy: 6000, z: 4000 }), 0.6 + 0.6 + 0.6, 1e-6,
    'the slow axis sets the pace of each move');

  // a move with both components takes as long as its slowest axis, not the sum
  const diagonal = new CLBuilder();
  diagonal.rapid(0, 0, 0);
  diagonal.rapid(60, 0, -40);
  assert.close(estimateSeconds(diagonal.finish(), { xy: 6000, z: 4000 }), 0.6, 1e-6);
});

test('rapidRates takes a number or a pair, and fills in a missing Z', () => {
  assert.eq(rapidRates(5000).z, 5000, 'one number is both axes');
  assert.eq(rapidRates({ xy: 4000 }).z, 4000, 'no Z rate means the XY rate');
  assert.eq(rapidRates({ xy: 4000, z: 2000 }).z, 2000);
  assert.eq(rapidRates(undefined).xy, 3000, 'and there is always a rate');
});
