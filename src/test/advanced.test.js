// Tabs, per-op speeds/feeds, and other things the properties panel exposes.

import { test, assert } from './runner.js';
import { generateToolpath, estimateSeconds } from '../engine/toolpath.js';
import { CLBuilder, MOVE_STRIDE, OP, FEED, eachMove } from '../engine/cl.js';
import { cutPerimeterWithTabs } from '../engine/tabs.js';
import { effectiveCutting, cuttingReport } from '../engine/cutting.js';
import { createOperation } from '../doc/schema.js';
import { makeBox, makeStepped } from './fixtures.js';

const FLAT = {
  number: 1, type: 'flat', diameter: 6, flutes: 2, fluteLength: 20,
  spindleRpm: 10000, feedCut: 800, feedPlunge: 300,
};

function cutPoints(cl) {
  const pts = [];
  const d = cl.moves;
  for (let n = 0; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    if (d[o] === OP.LINE && d[o + 7] !== FEED.RAPID) pts.push([d[o + 1], d[o + 2], d[o + 3]]);
  }
  return pts;
}

// --- holding tabs ---

test('cutPerimeterWithTabs lifts the tool in tab windows and drops back to depth', () => {
  const cl = new CLBuilder();
  const square = [0, 0, 100, 0, 100, 100, 0, 100];   // 400mm perimeter
  cutPerimeterWithTabs(cl, square, -5, { count: 4, width: 6, height: 1.5 });

  const zs = new Set();
  for (const [, , z] of cutPoints(cl.finish())) zs.add(z);
  assert.ok(zs.has(-5), 'still cuts at depth');
  assert.ok(zs.has(-3.5), 'rises to tab height');
});

test('tabs cover the right fraction of the perimeter', () => {
  const cl = new CLBuilder();
  const square = [0, 0, 100, 0, 100, 100, 0, 100];
  cutPerimeterWithTabs(cl, square, -5, { count: 4, width: 6, height: 1.5 });

  const pts = cutPoints(cl.finish());
  let atDepth = 0;
  let onTab = 0;
  // the caller positions the tool at loop[0] before calling; measuring from
  // there is what makes the walked distance the whole perimeter
  let prev = [square[0], square[1], -5];
  for (const p of pts) {
    if (prev) {
      const d = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      if (p[2] < -4.5) atDepth += d; else onTab += d;
    }
    prev = p;
  }
  const perimeter = 400;
  // 4 tabs × 6mm = 24mm of tab shelf out of 400mm
  assert.close(onTab, 24, 3, `tabs total ${onTab.toFixed(1)}, want ~24`);
  // tabs consume a few mm of the last edge to close back on the starting point;
  // for the loop-coverage check we care about the walked distance being close
  assert.close(atDepth + onTab, perimeter, 5, 'walks close to the full loop');
});

test('a contour with tabs still produces the same shape at final depth on other levels', () => {
  const mesh = makeBox(40, 40, 10);
  const common = {
    type: 'contour2d', name: 'c', tool: FLAT, mesh,
    params: {
      topZ: 10, bottomZ: 0, stepdown: 5, clearanceHeight: 20,
      stockToLeave: 0, rampAngle: 0, tolerance: 0.05,
      leadType: 'none', direction: 'climb',
    },
  };
  const withoutTabs = generateToolpath({ ...common });
  const withTabs = generateToolpath({
    ...common,
    params: { ...common.params, tabCount: 4, tabWidth: 4, tabHeight: 1 },
  });

  const zsAt = (cl) => new Set(cutPoints(cl).map((p) => +p[2].toFixed(2)));
  const plain = zsAt(withoutTabs);
  const tabbed = zsAt(withTabs);
  // tabs add exactly one new Z at the shelf height (bottom + 1)
  assert.ok(tabbed.has(1), 'tab shelf sits at bottomZ + tabHeight');
  assert.ok(!plain.has(1), 'plain contour never rises there');
});

test('zero tabs is the same as no tabs', () => {
  const mesh = makeBox(30, 30, 8);
  const common = {
    type: 'contour2d', name: 'c', tool: FLAT, mesh,
    params: {
      topZ: 8, bottomZ: 0, stepdown: 8, clearanceHeight: 20,
      stockToLeave: 0, rampAngle: 0, tolerance: 0.05, leadType: 'none', direction: 'climb',
    },
  };
  const off = generateToolpath({ ...common }).count;
  const zero = generateToolpath({
    ...common,
    params: { ...common.params, tabCount: 0, tabWidth: 4, tabHeight: 1 },
  }).count;
  assert.eq(off, zero, 'no extra motion when tabs are disabled');
});

// --- per-op speeds & feeds ---

test('an operation inherits its tool speeds unless it overrides them', () => {
  const op = createOperation('contour2d');
  const c = effectiveCutting(op, FLAT);
  assert.eq(c.spindleRpm, FLAT.spindleRpm, 'RPM inherits');
  assert.eq(c.feedCut, FLAT.feedCut, 'feed inherits');

  op.params.spindleRpm = 6000;
  op.params.feedCut = 400;
  const overridden = effectiveCutting(op, FLAT);
  assert.eq(overridden.spindleRpm, 6000, 'override wins');
  assert.eq(overridden.feedCut, 400, 'override wins');
  assert.eq(overridden.feedPlunge, FLAT.feedPlunge, 'unset stays inherited');
});

test('a blank override (null or zero) means inherit', () => {
  const op = createOperation('contour2d');
  op.params.spindleRpm = null;
  op.params.feedCut = 0;
  const c = effectiveCutting(op, FLAT);
  assert.eq(c.spindleRpm, FLAT.spindleRpm);
  assert.eq(c.feedCut, FLAT.feedCut);
});

test('cuttingReport surfaces the derived numbers a machinist reads', () => {
  const op = createOperation('contour2d');
  const r = cuttingReport(op, FLAT);
  // 10000rpm * pi * 6mm = ~188 m/min
  assert.close(r.surfaceSpeed, 188.5, 0.5);
  // 800 mm/min / (10000rpm * 2 flutes) = 0.04 mm/tooth
  assert.close(r.feedPerTooth, 0.04, 1e-4);
  assert.eq(r.flutes, 2);
});

test('generated toolpath uses the effective speed on the wire', () => {
  const op = createOperation('contour2d');
  op.params.topZ = 10; op.params.bottomZ = 0; op.params.stepdown = 5;
  op.params.clearanceHeight = 20; op.params.tolerance = 0.05;
  op.params.rampAngle = 0; op.params.leadType = 'none';
  op.params.spindleRpm = 4200;
  op.params.feedCut = 350;

  const cl = generateToolpath({
    type: 'contour2d', name: 'c', tool: FLAT, mesh: makeBox(20, 20, 10), params: op.params,
  });
  const spindle = cl.events.find((e) => e.type === 'spindle');
  const feeds = cl.events.find((e) => e.type === 'feeds');
  assert.eq(spindle.rpm, 4200, 'spindle event carries the override');
  assert.eq(feeds.cut, 350, 'feeds event carries the override');
});

// --- waterline no longer traces the flat bottom face ---

test('waterline stops above a flat bottom instead of tracing its triangulation', () => {
  // an axis-aligned box has a coarsely-tessellated flat bottom; the old
  // waterline landed on it and cut across the mesh's chord edges. The new
  // one lifts the deepest pass just above the mesh bottom.
  const mesh = makeBox(30, 30, 5);
  const cl = generateToolpath({
    type: 'waterline', name: 'wl', tool: { ...FLAT, type: 'ball' }, mesh,
    params: {
      topZ: 5, bottomZ: 0, stepdown: 1, clearanceHeight: 15,
      stockToLeave: 0, tolerance: 0.02, direction: 'climb', leadType: 'none',
    },
  });
  let deepest = Infinity;
  for (const [, , z] of cutPoints(cl)) deepest = Math.min(deepest, z);
  assert.ok(deepest > 0.001, `waterline cut down to ${deepest}, expected to stay above the bottom`);
});

// --- what a tab actually leaves standing ---
//
// "Tab width" is the width of the bridge left in the part. It used to be the
// length of the lift, which is a different number: a round cutter removes
// material for a radius either side of its centre, so lifting over exactly the
// tab width leaves width − diameter of material, and nothing at all for any tab
// narrower than the cutter. A 3mm tab with a 6mm cutter was 3mm in the settings
// and 0mm in the part.

/** Arc-length spans of a walked perimeter that sit above the cutting depth. */
function tabSpans(points, depth) {
  const spans = [];
  let run = 0;
  let prev = null;
  for (const p of points) {
    if (prev) {
      const d = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      if (p[2] > depth + 1e-6 && prev[2] > depth + 1e-6) run += d;
      else if (run > 1e-6) { spans.push(run); run = 0; }
    }
    prev = p;
  }
  if (run > 1e-6) spans.push(run);
  return spans;
}

test('the standing tab is as wide as the width asked for, whatever the cutter', () => {
  const square = [0, 0, 100, 0, 100, 100, 0, 100];
  for (const [width, diameter] of [[6, 6], [3, 6], [2, 10], [12, 6]]) {
    const cl = new CLBuilder();
    cutPerimeterWithTabs(cl, square, -5, {
      count: 4, width, height: 1.5, toolDiameter: diameter, topZ: -3.5,
    });
    const pts = [[square[0], square[1], -5], ...cutPoints(cl.finish())];
    // the lift spans the tab plus the cutter, so the material left is the tab
    const spans = tabSpans(pts, -5).filter((s) => s > 0.5);
    for (const span of spans) {
      assert.close(span - diameter, width, 0.6,
        `a ${width}mm tab with a ⌀${diameter} cutter left ${(span - diameter).toFixed(2)}mm`);
    }
    assert.eq(spans.length, 4, `expected 4 tabs, got ${spans.length}`);
  }
});

test('a tab is flat on top, not a ridge the tool climbs over', () => {
  const square = [0, 0, 100, 0, 100, 100, 0, 100];
  const cl = new CLBuilder();
  cutPerimeterWithTabs(cl, square, -5, {
    count: 4, width: 10, height: 2, toolDiameter: 6, topZ: -3,
  });
  const pts = cutPoints(cl.finish());

  // every move that travels in XY must be level: either along the floor or
  // along the top of a tab. A move that changes Z while it moves is a diagonal
  // climb, which leaves a wedge rather than a bridge.
  let prev = [square[0], square[1], -5];
  for (const p of pts) {
    const travelled = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    if (travelled > 1e-6) {
      assert.close(p[2], prev[2], 1e-6,
        `the tool changed height by ${(p[2] - prev[2]).toFixed(2)}mm while moving `
        + `${travelled.toFixed(2)}mm — that is a ramp, not a tab`);
    }
    prev = p;
  }
});

test('no tab sits on the point the tool enters at', () => {
  // the loop starts where the plunge or the ramp finished; a tab centred there
  // is a tab the entry has already cut through
  const square = [0, 0, 100, 0, 100, 100, 0, 100];
  const cl = new CLBuilder();
  cutPerimeterWithTabs(cl, square, -5, {
    count: 4, width: 8, height: 2, toolDiameter: 6, topZ: -3,
  });
  const first = cutPoints(cl.finish())[0];
  assert.close(first[2], -5, 1e-6, 'the walk starts at cutting depth, not on a tab');
});

// --- which outline a contour follows ---

/**
 * XY bounding box of the lap at each depth.
 *
 * A lap is the run of cutting moves at one Z. Splitting on that rather than on
 * retracts is what makes this read the same whether the contour goes level by
 * level (a rapid between laps) or in one continuous descent (a step down between
 * them, no rapid) — either way, a change of depth starts a new lap.
 */
function passBoxes(cl) {
  const laps = [];
  let cur = null;
  let curZ = null;
  const flush = () => { if (cur && cur.length > 2) laps.push(cur); cur = null; curZ = null; };
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (feed === FEED.RAPID) { flush(); return; }
    if (curZ !== null && Math.abs(z - curZ) > 1e-6) flush();
    (cur ??= []).push([x, y, z]);
    curZ = z;
  });
  flush();
  return laps.map((r) => ({
    z: r[r.length - 1][2],
    width: Math.max(...r.map((p) => p[0])) - Math.min(...r.map((p) => p[0])),
    depth: Math.max(...r.map((p) => p[1])) - Math.min(...r.map((p) => p[1])),
  }));
}

function steppedContour(contourOutline) {
  const { mesh, height } = makeStepped();
  return generateToolpath({
    type: 'contour2d', name: 'cut out', tool: FLAT, mesh,
    stock: { min: [-2, -2, 0], max: [42, 42, height] },
    params: {
      topZ: height, bottomZ: 0, stepdown: 5, clearanceHeight: height + 10, entryGap: 1,
      tolerance: 0.02, stockToLeave: 0, direction: 'climb', profile: 'outer',
      side: 'outside', contourOutline, rampAngle: 0, leadType: 'none', finishPasses: 0,
      tabCount: 0,
    },
  });
}

test('cutting a part free follows one outline, the whole part\'s, at every depth', () => {
  const boxes = passBoxes(steppedContour('part'));
  assert.ok(boxes.length >= 3, `expected several depth passes, got ${boxes.length}`);
  // 40mm base + a ⌀6 cutter running outside it = 46 across, at every level
  for (const box of boxes) {
    assert.close(box.width, 46, 0.6, `pass at Z${box.z.toFixed(1)} is ${box.width.toFixed(1)} wide`);
    assert.close(box.depth, 46, 0.6);
  }
});

test('following the profile per depth is a different cut, and still available', () => {
  const boxes = passBoxes(steppedContour('level'));
  // the top of this part is a 20mm block: the first pass hugs it
  assert.close(boxes[0].width, 26, 0.6, 'the top pass follows the top step');
  assert.close(boxes[boxes.length - 1].width, 46, 0.6, 'and the bottom one the base');
});

test('the cut-out never enters the footprint of the part it is freeing', () => {
  // The failure this exists for: on a part that widens as it goes down, a
  // contour reading the profile at each level starts by carving a groove
  // through the middle of the billet, which is a clearing pass wearing a
  // contour's name.
  const { base } = makeStepped();
  for (const box of passBoxes(steppedContour('part'))) {
    assert.ok(box.width > base, `pass at Z${box.z.toFixed(1)} is inside the part's ${base}mm footprint`);
  }
});

test('a contour steps a loop down without rapiding across the part between passes', () => {
  // Taking a loop's depth passes as one continuous descent must not be bought by
  // leaving the tool down and rapiding laterally back to the start of the next
  // lap — that rapid crosses the part at cutting depth. A shipped attempt did
  // exactly that (a 34mm rapid at z9 on a 20mm cut-out whose top is z12), so the
  // rule is blunt: no rapid may move in XY while it is below the stock top.
  const stockTop = 12;
  const cl = generateToolpath({
    type: 'contour2d', name: 'cut out', tool: FLAT,
    mesh: makeBox(20, 20, stockTop), stock: { min: [0, 0, 0], max: [20, 20, stockTop] },
    params: {
      topZ: stockTop, bottomZ: 0, stepdown: 3, clearanceHeight: 25, entryGap: 1,
      tolerance: 0.02, stockToLeave: 0, direction: 'climb', side: 'outside',
      profile: 'outer', contourOutline: 'part', leadType: 'arc', leadRadius: 2, rampAngle: 3,
    },
  });
  let prev = null;
  let levels = 0;
  let prevZ = null;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (feed === FEED.RAPID && prev) {
      const dxy = Math.hypot(x - prev.x, y - prev.y);
      const below = Math.max(prev.z, z) < stockTop - 1e-6;
      assert.ok(!(dxy > 0.5 && below),
        `a rapid moved ${dxy.toFixed(1)}mm in XY at z${Math.max(prev.z, z).toFixed(1)}, `
        + 'below the stock top — that is a rapid through the part');
    }
    if (feed !== FEED.RAPID && prevZ !== null && z < prevZ - 1e-6) levels++;
    prev = { x, y, z };
    prevZ = z;
  });
  // and it really did step down — several times, not one plunge to the floor
  assert.ok(levels >= 3, `expected the loop to step down several times, saw ${levels}`);
});

// --- feeds change partway through a program ---

test('a feed change partway through is honoured from that move on', () => {
  // Two 100mm cutting moves: the first at 600mm/min, the second at 60. The
  // cursor that finds the current feeds replaced a scan of every event on
  // every move — it has to land on exactly the same answer.
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(0, 0, 5);
  cl.cut(0, 0, 0, FEED.PLUNGE);
  cl.cut(100, 0, 0);
  cl.event('feeds', { cut: 60, plunge: 200 });
  cl.cut(200, 0, 0);
  const program = cl.finish();

  const seconds = estimateSeconds(program, 3000);
  // 100mm at 600mm/min = 10s, 100mm at 60mm/min = 100s, plus a 5mm plunge at
  // 200mm/min = 1.5s and a rapid from nowhere (the first move has no previous)
  assert.close(seconds, 10 + 100 + 1.5, 0.01, `got ${seconds.toFixed(2)}s`);
});

test('estimating a program is linear in its length, not quadratic', () => {
  // The regression this guards: the feeds lookup used to re-scan every event on
  // every move, so a program with many events took time proportional to their
  // product. Ten times the events must not cost ten times the time per move.
  const build = (moves, events) => {
    const cl = new CLBuilder();
    cl.event('feeds', { cut: 600, plunge: 200 });
    cl.rapid(0, 0, 5);
    for (let i = 0; i < moves; i++) {
      if (i % Math.max(1, Math.floor(moves / events)) === 0) cl.comment(`n${i}`);
      cl.cut(i * 0.1, 0, 0);
    }
    return cl.finish();
  };
  const few = build(20000, 5);
  const many = build(20000, 5000);
  const time = (p) => { const t = performance.now(); estimateSeconds(p); return performance.now() - t; };
  time(few); time(many);                       // let the JIT settle
  const ratio = (time(many) + 0.1) / (time(few) + 0.1);
  assert.ok(ratio < 8, `1000x the events cost ${ratio.toFixed(1)}x the time`);
});
