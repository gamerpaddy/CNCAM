// Rest machining: the second pass only goes where the first could not.
//
// The claim has two halves and they pull opposite ways. The program has to get
// *shorter* — otherwise the feature does nothing — and it still has to cut
// everything that is left, because a roughing pass that skips standing material
// is not an optimisation, it is a crash waiting for the finishing tool.

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { eachMove, OP, FEED } from '../engine/cl.js';
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
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] },
    params: { ...params, topZ: 20, bottomZ: 0, stepdown: 4 },
  });
  const stack = clearedStack([{ cl: rough, tool: BIG }], [16, 10, 4, 0]);
  assert.ok(stack.length >= 2, `a slice per level: ${stack.length}`);
  assert.ok(stack[0].z < stack[stack.length - 1].z, 'deepest first');

  const area = (loops) => loops.reduce((sum, loop) => {
    let a = 0;
    for (let i = 0; i < loop.length; i += 2) {
      const j = (i + 2) % loop.length;
      a += loop[i] * loop[j + 1] - loop[j] * loop[i + 1];
    }
    return sum + Math.abs(a) / 2;
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
