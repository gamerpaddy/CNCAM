// Rest machining: the second pass only goes where the first could not.
//
// The claim has two halves and they pull opposite ways. The program has to get
// *shorter* — otherwise the feature does nothing — and it still has to cut
// everything that is left, because a roughing pass that skips standing material
// is not an optimisation, it is a crash waiting for the finishing tool.

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { eachMove, OP, FEED, CLBuilder } from '../engine/cl.js';
import { clearedArea, clearedStack } from '../engine/rest.js';
import { makePocketBlock, makeStepped } from './fixtures.js';

const BIG = {
  number: 1, type: 'flat', name: '6mm flat', diameter: 6, flutes: 2,
  fluteLength: 30, spindleRpm: 12000, feedCut: 800, feedPlunge: 250,
};
const SMALL = { ...BIG, number: 2, name: '2mm flat', diameter: 2 };

const block = makePocketBlock({ size: 40, pocketSize: 24, height: 10, depth: 6 });
const STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] };
const params = {
  clearanceHeight: 25, entryGap: 1, tolerance: 0.05, stockToLeave: 0,
  stepdown: 2, stepover: 0.4, direction: 'climb', leadType: 'none',
  topZ: 10, bottomZ: block.floorZ,
};

function run(tool, regions = null) {
  return generateToolpath({
    type: 'pocket', name: 'p', tool, mesh: block.mesh, stock: STOCK, params, regions,
  });
}

function cutLength(cl) {
  let sum = 0;
  let prev = null;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (prev && op === OP.LINE && feed !== FEED.RAPID) {
      sum += Math.hypot(x - prev[0], y - prev[1], z - prev[2]);
    }
    prev = [x, y, z];
  });
  return sum;
}

test('what a program cleared is read off the program, not guessed at', () => {
  const first = run(BIG);
  const area = clearedArea([{ cl: first, tool: BIG }], params.bottomZ);
  assert.ok(area.length > 0, 'the big cutter cleared something');

  // The pocket is 24mm square from 8 to 32. A 6mm cutter working inside it
  // sweeps a band 3mm either side of its path, so the cleared area lands inside
  // the pocket and nowhere near the outside of the block.
  let minX = Infinity;
  let maxX = -Infinity;
  for (const loop of area) {
    for (let i = 0; i < loop.length; i += 2) {
      minX = Math.min(minX, loop[i]);
      maxX = Math.max(maxX, loop[i]);
    }
  }
  assert.ok(minX > 7.5, `cleared area reaches x=${minX.toFixed(2)}, outside the pocket`);
  assert.ok(maxX < 32.5, `cleared area reaches x=${maxX.toFixed(2)}, outside the pocket`);
});

test('a second cutter over the same pocket has almost nothing left to do', () => {
  const first = run(BIG);
  const naive = run(SMALL);
  const cleared = clearedArea([{ cl: first, tool: BIG }], params.bottomZ);
  const rest = run(SMALL, { include: [], avoid: [], cleared });

  const before = cutLength(naive);
  const after = cutLength(rest);
  assert.ok(before > 0 && after < before * 0.5,
    `${after.toFixed(0)}mm of cutting after, ${before.toFixed(0)}mm before`);
});

test('and it still visits the corners the big cutter could not reach', () => {
  // The 6mm cutter leaves a 3mm radius in each corner of a square pocket; the
  // 2mm one is there for exactly that, so the rest pass has to reach into them.
  const first = run(BIG);
  const cleared = clearedArea([{ cl: first, tool: BIG }], params.bottomZ);
  const rest = run(SMALL, { include: [], avoid: [], cleared });

  // the pocket runs 8..32; a corner is within 4mm of (8, 8)
  let nearCorner = 0;
  eachMove(rest, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.LINE && feed !== FEED.RAPID && Math.hypot(x - 8, y - 8) < 4) nearCorner++;
  });
  assert.ok(nearCorner > 0, 'the rest pass never goes near the corner it is for');
});

// One area was never enough. How much an earlier pass has taken off depends on
// how deep you ask — at the bottom of a part only the margin outside it has
// been cleared to there — and the deduction was taken once, at the operation's
// own Bottom Z. So a stepped part deducted a ring round the outside and nothing
// at the shallow levels, where the earlier pass really had emptied the billet.
test('what has been cleared depends on the depth it is asked about', () => {
  // A stepped part is the shape that shows it: near the top the roughing pass
  // has emptied everything outside the small boss, and at the floor only the
  // margin outside the whole part has been taken down that far. On a
  // straight-walled pocket the two are the same and the bug is invisible.
  const step = makeStepped({ base: 40, top: 20, baseHeight: 10, topHeight: 10 });
  const rough = generateToolpath({
    type: 'clear2d',
    name: 'r',
    tool: BIG,
    mesh: step.mesh,
    // The billet is a millimetre proud of the part, which is what the sentence
    // above means by "the margin outside it" and what a box-margin stock gives
    // you. It used to be exactly the part's own 40×40, so there was no margin
    // at all and nothing to clear below the boss — and the test passed anyway,
    // on a hairline of region left by a square-cornered stock outline meeting a
    // round-joined keep-out. Removing that sliver (see clear2d stockOutline)
    // took the floor slice with it.
    stock: { kind: 'box', min: [-1, -1, 0], max: [41, 41, 20] },
    params: { ...params, topZ: 20, bottomZ: 0, stepdown: 4 },
  });
  const stack = clearedStack([{ cl: rough, tool: BIG }], [16, 10, 4, 0]);
  assert.ok(stack.length >= 2, `a slice per level: ${stack.length}`);
  assert.ok(stack[0].z < stack[stack.length - 1].z, 'deepest first');

  // Signed, so a hole subtracts. Summing the absolute area of every loop counts
  // the middle of a frame as ground that has been cleared, which is the exact
  // opposite of what it is — and it made the ring round the outside of the part
  // measure *larger* than the whole area outside the boss.
  const area = (loops) => loops.reduce((sum, loop) => {
    let a = 0;
    for (let i = 0; i < loop.length; i += 2) {
      const j = (i + 2) % loop.length;
      a += loop[i] * loop[j + 1] - loop[j] * loop[i + 1];
    }
    return sum + a / 2;
  }, 0);
  const deep = area(stack[0].loops);
  const shallow = area(stack[stack.length - 1].loops);
  assert.ok(shallow > deep * 1.2,
    `more is cleared near the top than at the floor (${shallow.toFixed(0)} vs ${deep.toFixed(0)})`);
});

// The deduction is eroded by the cutter's radius, and on a ribbon that very
// nearly closes: what is left saves no cutting and cuts the region it comes out
// of in two, which the walker then walks separately. Switching rest machining
// on came out *longer* than leaving it off.
test('rest machining is never longer than not using it', () => {
  const first = run(BIG);
  const stack = clearedStack([{ cl: first, tool: BIG }], [10, 6, params.bottomZ]);
  const plain = cutLength(run(BIG));
  const rest = cutLength(run(BIG, { include: [], avoid: [], cleared: stack }));
  assert.ok(rest <= plain + 1e-6,
    `repeating a pass with rest machining on cut ${rest.toFixed(0)}mm `
    + `against ${plain.toFixed(0)}mm with it off`);
});

// "Never longer" is a weak claim and it passed while three quarters of the pass
// survived. A pass repeated with the same cutter has *nothing* left to do, so
// what it cuts is a direct reading of how much of the deduction arrives.
//
// It used to be a quarter of it. The deduction was buffered by the tool radius
// less a tenth of a millimetre — a blanket fudge for cutters narrower at the tip
// than at the shank — and that tenth is a ribbon left standing along the whole
// boundary between cleared and uncleared ground. A ribbon is a region, and a
// region gets a ring: measured on the app's step plate, a ⌀6 rest pass after ⌀12
// clearing fed 10.6 metres of its 10.8 and took off 0.2cm³ of corner.
test('a pass repeated with rest machining on cuts next to nothing', () => {
  const first = run(BIG);
  const stack = clearedStack([{ cl: first, tool: BIG }], [10, 6, params.bottomZ]);
  const plain = cutLength(run(BIG));
  const rest = cutLength(run(BIG, { include: [], avoid: [], cleared: stack }));
  assert.ok(rest < plain * 0.25,
    `repeating a pass with rest machining on cut ${rest.toFixed(0)}mm `
    + `against ${plain.toFixed(0)}mm with it off — ${(100 * rest / plain).toFixed(0)}%`);
});

// The other half of the same change, and the half that costs a cutter rather
// than an hour: what a *shaped* tool cleared is what it was wide at the height
// being asked about, not what it is called. A ⌀6 ball whose tip passed 1mm below
// this level was 4.47mm across up here, not 6.
test('a ball nose only cleared as wide as it was at that height', () => {
  const ball = { ...BIG, name: '6mm ball', type: 'ball' };
  const cl = new CLBuilder();
  cl.rapid(-20, 0, 5);
  cl.cut(-20, 0, 0);
  cl.cut(20, 0, 0);
  const pass = cl.finish();

  const halfWidth = (loops) => {
    let widest = 0;
    for (const loop of loops) {
      for (let i = 1; i < loop.length; i += 2) widest = Math.max(widest, Math.abs(loop[i]));
    }
    return widest;
  };

  // At the tip's own height the ball is a point, and a millimetre up it is
  // 2·√(2·1·3 − 1²) = 4.47mm across. Nothing here may claim the nominal 6.
  const atTip = clearedArea([{ cl: pass, tool: ball }], 0);
  const above = clearedArea([{ cl: pass, tool: ball }], 1);
  assert.ok(halfWidth(atTip) < 0.6, `the tip cleared ${halfWidth(atTip).toFixed(2)}mm either side`);
  assert.ok(halfWidth(above) > 1.9 && halfWidth(above) < 2.4,
    `1mm above the tip a ⌀6 ball cleared ${halfWidth(above).toFixed(2)}mm either side, `
    + 'and it is 2.24mm wide there');

  // A flat cutter is a cylinder and reaches its full radius at every height —
  // that is the case the fudge was costing, and it has to stay exact.
  const flat = clearedArea([{ cl: pass, tool: BIG }], 1);
  assert.ok(halfWidth(flat) >= 3, `a ⌀6 flat cleared only ${halfWidth(flat).toFixed(2)}mm either side`);
});

test('nothing generated above means nothing deducted', () => {
  // The safe direction to fail in: an operation whose predecessors have not run
  // is generated as though it were first.
  const area = clearedArea([], 0);
  assert.eq(area.length, 0, 'no earlier programs, no deduction');
  const none = clearedArea([{ cl: null, tool: BIG }], 0);
  assert.eq(none.length, 0, 'an operation with no toolpath contributes nothing');
});

// --- facing and the region it was ignoring ---------------------------------

test('facing goes round an avoided island instead of straight over it', () => {
  // A clamp in the middle of a plate is the case: the app turns it into an
  // avoid region, and facing used to take the *bounding box* of what survived
  // the filter and raster the whole of it. A keep-out at the edge shrank the
  // box; one in the middle did nothing at all.
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] };
  const island = [[15, 15, 25, 15, 25, 25, 15, 25]];
  const params = {
    clearanceHeight: 25, entryGap: 1, tolerance: 0.05, stockToLeave: 0,
    stepdown: 2, stepover: 0.4, topZ: 10, bottomZ: 8, pattern: 'zigzag',
  };
  const cl = generateToolpath({
    type: 'face', name: 'f', tool: BIG, stock, params,
    regions: { include: [], avoid: island, cleared: [] },
  });

  // No cutting move may bring the cutter within its own radius of the island.
  // Measured as a distance rather than against a box, because the keep-out is
  // the island grown by the radius and that has round corners — a rectangle
  // 3mm out from a square is a different, larger shape, and testing against it
  // fails by four hundredths of a millimetre on the corner arcs.
  const toIsland = (px, py) => {
    const dx = Math.max(15 - px, 0, px - 25);
    const dy = Math.max(15 - py, 0, py - 25);
    return Math.hypot(dx, dy);
  };
  let closest = Infinity;
  let prev = null;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (prev && op === OP.LINE && feed !== FEED.RAPID) {
      for (let s = 0; s <= 20; s++) {
        const t = s / 20;
        closest = Math.min(closest,
          toIsland(prev[0] + (x - prev[0]) * t, prev[1] + (y - prev[1]) * t));
      }
    }
    prev = [x, y, z];
  });
  assert.ok(closest > 3 - 0.1,
    `the cutter centre comes ${closest.toFixed(2)}mm from a keep-out it is 3mm wide`);

  // and it still faces the rest of the plate
  let cuts = 0;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.LINE && feed !== FEED.RAPID) cuts++;
  });
  assert.ok(cuts > 20, `only ${cuts} cutting moves — the pass gave up rather than routing round`);
});

// The leftover a rest pass is aimed at is a ribbon against the pocket wall, and
// its inner edge is a hole in the region that is *air* — the ground the first
// cutter emptied. `pocketSide` read the winding alone and called that a boss, so
// the wall pass ran conventional and swung its lead arc out through the wall it
// had been sent in to clean up: measured 1.94mm past finished size with a ⌀3
// cutter, ten millimetres deep. With rest machining off the same operation is
// clean, which is what kept it hidden.
test('a rest pass leads into the pocket, never out through its wall', () => {
  const SIZE = 60;
  const POCKET = 40;
  const big = { ...BIG, diameter: 12, name: '12mm flat' };
  const small = { ...BIG, number: 2, diameter: 3, name: '3mm flat' };
  const plate = makePocketBlock({ size: SIZE, pocketSize: POCKET, height: 20, depth: 10 });
  const stock = { kind: 'box', min: [0, 0, 0], max: [SIZE, SIZE, 20] };
  const shared = {
    clearanceHeight: 30, entryGap: 1, tolerance: 0.02, stockToLeave: 0,
    stepdown: 3, stepover: 0.4, direction: 'climb',
    // an arc lead is the thing that swung out; without one there is nothing to catch
    leadType: 'arc', leadRadius: 2,
    topZ: 19, bottomZ: plate.floorZ,
  };
  const make = (tool, regions) => generateToolpath({
    type: 'pocket', name: 'p', tool, mesh: plate.mesh, stock, params: shared, regions,
  });

  const rough = make(big, null);
  const cleared = clearedStack([{ cl: rough, tool: big }],
    [shared.topZ, 16, 13, shared.bottomZ], { tolerance: shared.tolerance });
  assert.ok(cleared.length > 0, 'the first pass cleared something to deduct');

  // the pocket walls, in model space
  const lo = (SIZE - POCKET) / 2;
  const hi = lo + POCKET;
  const outside = (cl) => {
    const r = small.diameter / 2;
    let worst = 0;
    let prev = null;
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (op === OP.DRILL) { prev = null; return; }
      if (prev && feed !== FEED.RAPID && z < shared.topZ - 1e-6) {
        for (const [px, py] of [[prev[0], prev[1]], [x, y]]) {
          worst = Math.max(worst, lo - (px - r), (px + r) - hi, lo - (py - r), (py + r) - hi);
        }
      }
      prev = [x, y, z];
    });
    return worst;
  };

  const off = make(small, null);
  const on = make(small, { cleared });
  assert.ok(outside(off) <= 1e-6,
    `without rest machining the pass stays inside: ${outside(off).toFixed(3)}mm past the wall`);
  assert.ok(outside(on) <= 1e-6,
    `and with it: ${outside(on).toFixed(3)}mm past the wall`);

  // and it is still doing its job — a "fix" that switched rest machining off
  // would pass the check above and be no fix at all
  assert.ok(cutLength(on) < cutLength(off) * 0.6,
    `the rest pass is still shorter: ${cutLength(on).toFixed(0)}mm against ${cutLength(off).toFixed(0)}mm`);
});

// A boss standing in the pocket is a hole in the region too, and that one really
// is metal: the answer for it must not change.
test('and an island in the pocket is still an island', () => {
  const stepped = makeStepped({ base: 40, top: 16, baseHeight: 6, topHeight: 8 });
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 14] };
  const cl = generateToolpath({
    type: 'pocket', name: 'p', tool: BIG, mesh: stepped.mesh, stock,
    params: {
      clearanceHeight: 25, entryGap: 1, tolerance: 0.05, stockToLeave: 0,
      stepdown: 2, stepover: 0.4, direction: 'climb', leadType: 'arc', leadRadius: 2,
      topZ: 14, bottomZ: 6,
    },
    regions: null,
  });
  // whatever it cuts, it must not cut into the boss
  let worst = 0;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.DRILL || feed === FEED.RAPID) return;
    const inBoss = Math.max(Math.abs(x - 20), Math.abs(y - 20)) < 8 - BIG.diameter / 2 - 1e-6;
    if (inBoss && z < 14 - 1e-6) worst = Math.max(worst, 14 - z);
  });
  assert.close(worst, 0, 1e-6, `the pass cut ${worst.toFixed(2)}mm into the boss`);
});

// The same fault with the shapes the other way round. Clearing runs between the
// stock edge and the part, so its outer boundary is a wall only where the part
// is beyond it — and rest machining adds a third kind that is neither the stock
// edge nor a wall: the rim of the hole the earlier pass emptied. "Not the stock
// edge" called that a pocket wall, and the ring took its lead off the wrong
// side and cut 1.9mm into the boss it had been sent in to clear round.
test('a rest pass clearing round a boss leads away from it, not into it', () => {
  const BASE = 40;
  const TOP = 20;
  const stepped = makeStepped({ base: BASE, top: TOP, baseHeight: 10, topHeight: 10 });
  const stock = { kind: 'box', min: [0, 0, 0], max: [BASE, BASE, 20] };
  const big = { ...BIG, diameter: 10, name: '10mm flat' };
  const small = { ...BIG, number: 2, diameter: 3, name: '3mm flat' };
  const shared = {
    clearanceHeight: 30, entryGap: 1, tolerance: 0.005, stockToLeave: 0,
    stepdown: 3, stepover: 0.5, direction: 'climb',
    leadType: 'arc', leadRadius: 2, topZ: 20, bottomZ: 10,
  };
  const make = (tool, regions) => generateToolpath({
    type: 'clear2d', name: 'c', tool, mesh: stepped.mesh, stock, params: shared, regions,
  });

  const rough = make(big, null);
  const cleared = clearedStack([{ cl: rough, tool: big }], [20, 17, 14, 10],
    { tolerance: shared.tolerance });
  assert.ok(cleared.length > 0, 'the first pass cleared something to deduct');

  // how far the cutter reaches inside the boss footprint, below the boss top
  const centre = BASE / 2;
  const half = TOP / 2;
  const intoBoss = (cl) => {
    const r = small.diameter / 2;
    let worst = 0;
    let prev = null;
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (op === OP.DRILL) { prev = null; return; }
      if (prev && feed !== FEED.RAPID && z < 20 - 1e-6) {
        for (const [px, py] of [[prev[0], prev[1]], [x, y]]) {
          worst = Math.max(worst, Math.min(half - Math.abs(px - centre),
            half - Math.abs(py - centre)) + r);
        }
      }
      prev = [x, y, z];
    });
    return worst;
  };

  // The boss corners are chorded, so a pass tangent to them reads a few tenths
  // inside the square footprint whatever it does — which is why this compares
  // the two runs rather than either against zero.
  const off = intoBoss(make(small, null));
  const on = intoBoss(make(small, { cleared }));
  assert.ok(on <= off + 0.02,
    `rest machining brought the cutter ${(on - off).toFixed(3)}mm further into the boss `
    + `(${on.toFixed(3)}mm against ${off.toFixed(3)}mm)`);
});
