// Operations that cut where there is no material: a facing pass over a billet
// already at its height, a slot lane outside the billet, a contour with no stock
// around the part. Each is measured as feed travel that removes nothing.

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { eachMove, OP, FEED } from '../engine/cl.js';
import { makeBox } from './fixtures.js';
import { stockOutline } from '../engine/stock.js';
import { pointInLoops } from '../geom/inside.js';

const FLAT = {
  number: 1, type: 'flat', name: '6mm flat', diameter: 6, tipAngle: 0, tipDiameter: 0,
  fluteLength: 20, flutes: 2, spindleRpm: 10000, feedCut: 800, feedPlunge: 300,
};

/** Total length fed (not rapid) by a program. */
function feedLength(cl) {
  let prev = null, total = 0;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (prev && op === OP.LINE && feed !== FEED.RAPID) total += Math.hypot(x - prev[0], y - prev[1], z - prev[2]);
    prev = [x, y, z];
  });
  return total;
}

test('facing a billet already level with its pass feeds nothing and says so', () => {
  const stock = { kind: 'box', min: [-5, -5, 0], max: [45, 35, 10] };
  const run = (topZ, bottomZ) => generateToolpath({
    type: 'face', name: 'face', tool: FLAT, mesh: makeBox(40, 30, 10), stock,
    params: {
      topZ, bottomZ, stepdown: 1, stepover: 0.6, clearanceHeight: 20, tolerance: 0.05,
      stockToLeave: 0,
    },
  });
  const flush = run(10, 10);
  assert.eq(feedLength(flush), 0, `no feed travel over the finished face, got ${feedLength(flush).toFixed(0)}mm`);
  assert.ok(flush.notes.some((n) => /nothing to face/.test(n.text)), 'and it says why');
  // the same two equal heights with stock above them are a real cut
  const skim = run(5, 5);
  assert.ok(feedLength(skim) > 100, 'a single cut at a height inside the billet still cuts');
  assert.ok(!skim.notes.some((n) => /nothing to face/.test(n.text)), 'and does not claim otherwise');
  // a pass that starts and stops above the billet is air too
  const above = run(18, 14);
  assert.eq(feedLength(above), 0, 'a pass wholly above the billet cuts nothing');
});

/**
 * Feed length, below the billet top, whose cutter centre is farther from the
 * billet than the cutter is wide — it cannot be touching anything there.
 */
function airFeed(cl, stock, r) {
  const area = stockOutline(stock, r + 0.02);
  let prev = null, air = 0;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (prev && op === OP.LINE && feed !== FEED.RAPID && Math.min(z, prev[2]) < stock.max[2] - 1e-6) {
      const len = Math.hypot(x - prev[0], y - prev[1]);
      const n = Math.max(1, Math.ceil(len / 0.5));
      for (let s = 0; s < n; s++) {
        const t = (s + 0.5) / n;
        if (!pointInLoops(area, prev[0] + (x - prev[0]) * t, prev[1] + (y - prev[1]) * t)) air += len / n;
      }
    }
    prev = [x, y, z];
  });
  return air;
}

test('a slot wider than the billet does not cut the lanes that are off it', () => {
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 30, 10] };
  const tool = { ...FLAT, diameter: 3 };
  const cl = generateToolpath({
    type: 'slot', name: 'slot', tool, mesh: makeBox(40, 30, 10), stock,
    drawing: [{ points: [5, 15, 35, 15], closed: false }],
    params: {
      topZ: 10, bottomZ: 5, stepdown: 2.5, stepover: 0.5, clearanceHeight: 20,
      entryGap: 1, tolerance: 0.01, rampAngle: 3, direction: 'climb', slotWidth: 60,
    },
  });
  assert.eq(airFeed(cl, stock, 1.5).toFixed(0), '0', 'every lane is over the billet');
  assert.ok(feedLength(cl) > 500, 'and the ones that are still cut');
  // the lanes that are on it are untouched: the same slot, narrower, is unchanged
  const narrow = generateToolpath({
    type: 'slot', name: 'slot', tool, mesh: makeBox(40, 30, 10), stock,
    drawing: [{ points: [5, 15, 35, 15], closed: false }],
    params: {
      topZ: 10, bottomZ: 5, stepdown: 2.5, stepover: 0.5, clearanceHeight: 20,
      entryGap: 1, tolerance: 0.01, rampAngle: 3, direction: 'climb', slotWidth: 12,
    },
  });
  assert.ok(feedLength(narrow) > 500 && feedLength(narrow) < feedLength(cl), 'a narrower slot is less cutting');
});

test('an outside contour of a billet cut to the size of the part has nothing to cut and says so', () => {
  const run = (margin, side = 'outside') => generateToolpath({
    type: 'contour2d', name: 'cutout', tool: FLAT, mesh: makeBox(40, 30, 10),
    stock: { kind: 'box', min: [-margin, -margin, 0], max: [40 + margin, 30 + margin, 10] },
    params: {
      topZ: 10, bottomZ: 0, stepdown: 5, clearanceHeight: 20, stockToLeave: 0,
      tolerance: 0.01, side,
    },
  });
  const bare = run(0);
  assert.eq(feedLength(bare), 0, 'no lap round stock that is not there');
  assert.ok(bare.notes.some((n) => n.level === 'warn' && /no stock/.test(n.text)),
    `and a warning says why: ${JSON.stringify(bare.notes)}`);
  // grazing the billet is not cutting it, but real margin is
  assert.ok(feedLength(run(0.5)) > 100, '0.5mm of margin is something to take off');
  assert.ok(feedLength(run(3)) > 100, 'and so is 3mm');
  // the other sides of a part cut to size still have material to work on
  assert.ok(feedLength(run(0, 'inside')) > 100, 'inside is cut');
  assert.ok(feedLength(run(0, 'on')) > 100, 'on the line is cut');
});

test('a slot broken by a keep-out comes down a stepdown at a time, not from the top at every level', () => {
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 30, 10] };
  const tool = { ...FLAT, diameter: 3 };
  const run = (regions) => generateToolpath({
    type: 'slot', name: 'slot', tool, mesh: makeBox(40, 30, 10), stock, regions,
    drawing: [{ points: [3, 15, 37, 15], closed: false }],
    params: {
      topZ: 10, bottomZ: 2, stepdown: 1, stepover: 0.5, clearanceHeight: 20,
      entryGap: 1, tolerance: 0.01, rampAngle: 3, direction: 'climb', slotWidth: 0,
    },
  });
  const whole = feedLength(run(null));
  // a clamp 4mm wide across the middle of the line: two spans, each its own lap
  const keepOut = [18, 12, 22, 12, 22, 18, 18, 18];
  const split = feedLength(run({ include: [], avoid: [keepOut], cleared: [], edgePaths: [] }));
  assert.ok(split > 0.5 * whole, `both halves are cut (${split.toFixed(0)}mm of ${whole.toFixed(0)}mm)`);
  assert.ok(split < 2.5 * whole,
    `and each level starts from the one above (the short halves zigzag their ramps): ${split.toFixed(0)}mm against ${whole.toFixed(0)}mm unbroken`);
});
