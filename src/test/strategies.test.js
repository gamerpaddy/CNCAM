import { test, assert } from './runner.js';
import { generateToolpath, estimateSeconds } from '../engine/toolpath.js';
import { depthPasses, depthLevelsFor, withFlatLevels } from '../engine/stock.js';
import { eachMove, OP, FEED } from '../engine/cl.js';
import { buildGcode } from '../post/index.js';
import { makeBox, makeStepped } from './fixtures.js';

const TOOL = {
  number: 1, diameter: 6, spindleRpm: 10000, feedCut: 800, feedPlunge: 300,
};

function contourArgs() {
  return {
    type: 'contour2d', name: 'cutout', tool: TOOL,
    mesh: makeBox(10, 10, 5),
    stock: { min: [0, 0, 0], max: [10, 10, 5] },
    params: { topZ: 5, bottomZ: 0, stepdown: 2, clearanceHeight: 15, stockToLeave: 0, tolerance: 0.01 },
  };
}

// The stepdown is a limit, not a quantum: the depth is shared out evenly into
// passes that are all at most the stepdown, rather than stepped by exactly it
// with the remainder left over. 5mm at a 2mm stepdown is three passes of 1.667
// and not 2, 2, 1 — and, the case that motivated it, 9.02mm at 3mm is three of
// 3.007 rather than three of 3 and a 0.02mm shaving at the bottom of the cut.
test('depthPasses shares the depth out evenly and always ends at bottomZ', () => {
  const d = depthPasses(5, 0, 2);
  assert.eq(d.length, 3);
  assert.close(d[0], 10 / 3); assert.close(d[1], 5 / 3); assert.close(d[2], 0);

  const exact = depthPasses(6, 0, 2);
  assert.eq(exact.length, 3, 'an exact multiple is not rounded up to a fourth pass');
  assert.close(exact[0], 4); assert.close(exact[2], 0);

  const sliver = depthPasses(9.02, 0, 3);
  assert.eq(sliver.length, 4);
  for (let i = 0; i < sliver.length; i++) {
    const step = (i === 0 ? 9.02 : sliver[i - 1]) - sliver[i];
    assert.ok(step <= 3 + 1e-9 && step > 1, `pass ${i} was ${step}mm`);
  }
  assert.eq(depthPasses(5, 5, 2).length, 1);
});

// The stepdown shares the depth out evenly and knows nothing about the part, so
// a floor between two levels is cleared to the level above it and then walled
// off from the one below — the stock in between stands on a finished surface
// and no pass in the operation ever reaches it. "There is 2mm left and the
// stepdown is 5mm, so it gets ignored."
test('a flat face between two levels gets a pass of its own', () => {
  const { mesh } = makeStepped({ base: 40, top: 20, baseHeight: 10, topHeight: 10 });
  const params = { topZ: 20, bottomZ: 0, stepdown: 7 };

  const even = depthLevelsFor({ ...params, flatPasses: false }, mesh, TOOL);
  assert.ok(!even.some((z) => Math.abs(z - 10) < 1e-6),
    `no level lands on the step face: ${even.join(', ')}`);

  const withFlat = depthLevelsFor(params, mesh, TOOL);
  assert.ok(withFlat.some((z) => Math.abs(z - 10) < 1e-6),
    `the step face at Z10 got a level: ${withFlat.join(', ')}`);
  // adding one can only make passes shallower, never deeper than the stepdown
  let previous = 20;
  for (const z of withFlat) {
    assert.ok(previous - z <= 7 + 1e-9, `pass ${previous}→${z} is within the stepdown`);
    previous = z;
  }
});

test('a level is added at a flat only when it is worth a whole pass', () => {
  // eleven faces a tenth of a millimetre apart: a level for each is a program
  // of shavings, which is what the gap exists to prevent
  const flats = [];
  for (let i = 0; i < 11; i++) flats.push({ z: 5 + i * 0.1, area: 100 });
  const swarm = withFlatLevels(depthPasses(20, 0, 7), 20, 7, { flats });
  assert.ok(swarm.length <= 5, `11 near-identical flats added at most one level (${swarm.length})`);

  // At every allowance, not only at none. The gap used to be consulted only
  // where nothing was promised, so the same eleven faces with 0.3mm asked for
  // got a level each — the protection was off in the case a user is most
  // likely to be in.
  const asked = withFlatLevels(depthPasses(20, 0, 7), 20, 7, { flats, leaves: 0.3 });
  assert.ok(asked.length <= 5,
    `the same eleven faces with an allowance asked for (${asked.length})`);

  // and a flat sitting on a level that already exists adds nothing
  const onLevel = withFlatLevels(depthPasses(20, 0, 5), 20, 5, { flats: [{ z: 10, area: 100 }] });
  assert.eq(onLevel.length, 4, 'Z10 is already a pass');

  // a sliver too small for the cutter to stand on is not a floor
  const sliver = withFlatLevels(depthPasses(20, 0, 7), 20, 7,
    { flats: [{ z: 10, area: 0.4 }], minFlatArea: 28 });
  assert.eq(sliver.length, 3, 'a 0.4mm² horizontal sliver is a tessellation artefact');
});

// A level *under* a floor is at a depth where the floor is solid part: the
// silhouette walls the cutter out and the pass takes nothing off it. Counting
// one as clearing the floor left the whole step standing, and the amount was
// not small — 3mm on a 0.3mm allowance, on a plain stepped plate.
test('a pass below a flat does not count as clearing it', () => {
  // stepdown 6 over 0..23 gives 5.75, 11.5, 17.25, 23 — 11.5 lands half a
  // millimetre under the 11mm step, and 0.5 is inside the 1.2mm gap
  const levels = withFlatLevels(depthPasses(23, 0, 6), 23, 6, {
    flats: [{ z: 12, area: 100 }, { z: 22, area: 100 }],
  });
  assert.ok(levels.some((z) => Math.abs(z - 12) < 1e-6),
    `the step at Z12 got its own pass despite Z11.5 just below it: ${levels.join(', ')}`);
  // and the top of the cut is not a pass either: a face 1mm below it has 1mm
  // of stock on it that nothing else removes
  assert.ok(levels.some((z) => Math.abs(z - 22) < 1e-6),
    `the face at Z22 got a pass despite topZ 1mm above it: ${levels.join(', ')}`);

  // A pass *above* a flat does clear it, to within what the operation said it
  // would leave — which is what decides it, not the gap. Half a millimetre
  // under a pass, with half a millimetre asked for, is a floor already done.
  const under = withFlatLevels(depthPasses(23, 0, 6), 23, 6,
    { flats: [{ z: 11, area: 100 }], leaves: 0.5 });
  assert.ok(!under.some((z) => Math.abs(z - 11) < 1e-6),
    `Z11.5 is 0.5 above the Z11 flat and clears it: ${under.join(', ')}`);

  // …and with nothing asked for, it does not: an allowance of none is the
  // strictest instruction there is, and it used to be read as no instruction at
  // all, which left this floor 0.5mm proud and adaptive's 2mm proud.
  const toSize = withFlatLevels(depthPasses(23, 0, 6), 23, 6,
    { flats: [{ z: 11, area: 100 }] });
  assert.ok(toSize.some((z) => Math.abs(z - 11) < 1e-6),
    `Z11 was left to the pass at Z11.5 with no allowance asked for: ${toSize.join(', ')}`);

  // and the allowance caps the gap: 20% of adaptive's two-diameter stepdown is
  // 4.8mm, which counted a floor 3mm under a pass as cleared
  const deep = withFlatLevels(depthPasses(23, 0, 24), 23, 24,
    { flats: [{ z: 12, area: 100 }, { z: 15, area: 100 }], leaves: 0.3 });
  assert.ok(deep.some((z) => Math.abs(z - 12.3) < 1e-6),
    `Z12 gets a pass though Z15 is 3mm above it: ${deep.join(', ')}`);
});

// A roughing pass that cuts a floor to size has taken the last cut on that
// surface with the roughing cutter and left the finishing pass nothing to do.
test('a flat pass leaves the allowance on the floor, not the part', () => {
  const bare = withFlatLevels(depthPasses(23, 0, 6), 23, 6,
    { flats: [{ z: 12, area: 100 }] });
  assert.ok(bare.some((z) => Math.abs(z - 12) < 1e-6),
    `with no allowance the pass lands on the floor: ${bare.join(', ')}`);

  const left = withFlatLevels(depthPasses(23, 0, 6), 23, 6,
    { flats: [{ z: 12, area: 100 }], leaves: 0.4 });
  assert.ok(left.some((z) => Math.abs(z - 12.4) < 1e-6),
    `0.4mm asked for is 0.4mm above the floor: ${left.join(', ')}`);
  assert.ok(!left.some((z) => Math.abs(z - 12) < 1e-6), 'and nothing lands on it');
});

// The property the two tests above are instances of, and the one that was
// false: asking for a *tighter* allowance must never leave more stock standing.
// It used to break at exactly zero, where the promise was read as no promise —
// 0.001mm left a floor to size and 0 left it 2mm proud.
test('a tighter allowance never leaves more on a floor than a looser one', () => {
  const floors = [
    { z: 12, area: 100 }, { z: 11.6, area: 100 }, { z: 8, area: 100 }, { z: 3.2, area: 100 },
  ];
  for (const stepdown of [3, 6, 24]) {
    let worseThan = null;
    let previous = -1;
    for (const leaves of [0, 0.05, 0.1, 0.3, 0.5, 1, 2]) {
      const levels = withFlatLevels(depthPasses(23, 0, stepdown), 23, stepdown,
        { flats: floors, leaves });
      // the most any floor is left standing under these levels
      let worst = 0;
      for (const f of floors) {
        const above = levels.filter((z) => z > f.z - 1e-6).sort((a, b) => a - b)[0];
        if (above != null) worst = Math.max(worst, above - f.z);
      }
      if (worst < previous - 1e-6) {
        worseThan = `${stepdown}mm stepdown: ${leaves}mm asked for leaves `
          + `${worst.toFixed(2)}mm, but the allowance below it left ${previous.toFixed(2)}mm`;
      }
      previous = worst;
      // and nothing is left with more than was asked for, bar the span of a run
      // of faces close enough together to be one face — these are 0.4mm apart,
      // so none of them is
      assert.ok(worst <= leaves + 1e-6,
        `${stepdown}mm stepdown, ${leaves}mm asked for, ${worst.toFixed(2)}mm left`);
    }
    assert.eq(worseThan, null, worseThan ?? '');
  }
});

test('clearing machines the flat face instead of leaving stock standing on it', () => {
  const { mesh } = makeStepped({ base: 40, top: 20, baseHeight: 10, topHeight: 10 });
  const stock = { min: [0, 0, 0], max: [40, 40, 20] };
  const params = {
    topZ: 20, bottomZ: 0, stepdown: 7, stepover: 0.5, engagement: 0.2,
    clearanceHeight: 30, stockToLeave: 0, tolerance: 0.01, direction: 'climb', rampAngle: 3,
  };
  for (const type of ['clear2d', 'adaptive']) {
    // Cutting moves only. A ramp descending from one level to the next passes
    // *through* the step face's height on its way, and its vertices land where
    // the ring geometry happens to put them — four of them exactly on Z10 the
    // day the ring spacing changed. That is a pass going past, not a pass at
    // this level, and counting it made the test report a flat pass nobody added.
    const at = (flatPasses) => {
      let moves = 0;
      eachMove(generateToolpath({
        type, name: type, tool: TOOL, mesh, stock, params: { ...params, flatPasses },
      }), (op, x, y, z, i, j, k, feed) => {
        if (op === OP.LINE && feed === FEED.CUT && Math.abs(z - 10) < 1e-6) moves++;
      });
      return moves;
    };
    assert.eq(at(false), 0, `${type} leaves the step face uncut when the option is off`);
    assert.ok(at(true) > 10, `${type} machines the step face (${at(true)} moves at Z10)`);
  }
});

test('contour cuts at every depth, offset by tool radius', () => {
  const cl = generateToolpath(contourArgs());
  assert.ok(cl.count > 10, 'produces moves');

  const cutZ = new Set();
  let minX = Infinity, maxX = -Infinity;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE || feed === FEED.PLUNGE) return;
    cutZ.add(Math.round(z * 100) / 100);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
  });
  assert.eq([...cutZ].sort((a, b) => b - a).join(','), '3.33,1.67,0');
  assert.close(minX, -3, 0.01, 'offset outward by radius');
  assert.close(maxX, 13, 0.01);
});

test('contour never travels sideways below clearance height', () => {
  // What matters is not that every rapid sits at clearance — dropping straight
  // down the hole the tool is about to enter is both safe and the point of the
  // feed plane. What must never happen is a rapid *crossing* the job below it.
  const cl = generateToolpath(contourArgs());
  let prev = null;
  eachMove(cl, (op, x, y, z) => {
    if (op === OP.RAPID && prev) {
      const travelled = Math.hypot(x - prev[0], y - prev[1]);
      if (travelled > 1e-6) assert.close(z, 15, 1e-6, 'rapid crossed the job below clearance');
    }
    prev = [x, y, z];
  });
});

test('face covers the stock and cuts at bottomZ only', () => {
  const cl = generateToolpath({
    type: 'face', name: 'face', tool: TOOL,
    stock: { min: [0, 0, 0], max: [10, 10, 5] },
    params: { topZ: 5, bottomZ: 5, stepdown: 2, stepover: 0.5, clearanceHeight: 15 },
  });
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE) return;
    assert.close(z, 5, 1e-6, 'single pass at bottomZ');
    if (feed === FEED.PLUNGE) return;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  });
  assert.ok(minX <= 0 - 3 && maxX >= 10 + 3, 'X runs past stock');
  assert.ok(minY - 3 <= 0, 'first row covers stock front edge');
  assert.ok(maxY + 3 >= 10, 'last row covers stock back edge');
});

test('the facing raster sits on the billet at both ends', () => {
  // Marching rows out at the full stepover from one edge leaves whatever does
  // not divide evenly at the other: a ⌀25 mill at 0.6 over 70mm of stock put
  // its last row 9.25mm past the far edge and took a third of a bite there,
  // while the first row sat exactly on the near one. Spread across the span
  // instead — same number of rows, all of them on the work.
  const face = { number: 2, type: 'face', diameter: 25, flutes: 4, spindleRpm: 6000, feedCut: 1500, feedPlunge: 300 };
  for (const depth of [70, 62, 51.5, 40, 24]) {
    const cl = generateToolpath({
      type: 'face', name: 'face', tool: face,
      stock: { min: [0, 0, 0], max: [100, depth, 5] },
      params: { topZ: 5, bottomZ: 5, stepdown: 2, stepover: 0.6, clearanceHeight: 15 },
    });
    const ys = new Set();
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (op === OP.LINE && feed !== FEED.PLUNGE) ys.add(Math.round(y * 1000) / 1000);
    });
    const rows = [...ys].sort((a, b) => a - b);
    const overLow = 0 - rows[0];
    const overHigh = rows[rows.length - 1] - depth;
    assert.close(overLow, overHigh, 0.01,
      `${depth}mm of stock: the raster hangs ${overLow.toFixed(2)}mm off one edge `
      + `and ${overHigh.toFixed(2)}mm off the other (rows ${rows.join(', ')})`);
    // and the bites are all the same, not full-width with a shaving at the end
    const gaps = rows.slice(1).map((v, n) => v - rows[n]);
    if (gaps.length > 1) {
      assert.close(Math.min(...gaps), Math.max(...gaps), 0.01,
        `${depth}mm of stock: uneven stepover ${gaps.map((g) => g.toFixed(2)).join(', ')}`);
    }
  }
});

test('unknown operation type throws', () => {
  assert.throws(() => generateToolpath({ type: 'nope' }));
});

test('estimateSeconds is positive and uses feeds', () => {
  const seconds = estimateSeconds(generateToolpath(contourArgs()));
  assert.ok(seconds > 1, `got ${seconds}`);
});

test('GRBL post emits sane program', () => {
  const cl = generateToolpath(contourArgs());
  const gcode = buildGcode('grbl', [{ name: 'cutout', cl }], { programName: 'test' }).text;
  assert.ok(gcode.startsWith('(test)'), 'program name comment');
  assert.ok(gcode.includes('G21 G90 G94 G17'), 'safety header');
  assert.ok(gcode.includes('M3 S10000'), 'spindle on');
  assert.ok(/G1 [^\n]*F300/.test(gcode), 'plunge feed');
  assert.ok(/F800/.test(gcode), 'cut feed');
  assert.ok(gcode.includes('M5'), 'spindle off');
  assert.ok(gcode.trimEnd().endsWith('M2'), 'program end');
  assert.ok(!/undefined|NaN/.test(gcode), 'no formatting garbage');
});

// --- slotting ---
//
// A slot is the one 2.5D operation whose *width* is the deliverable, and the
// one where entering wrongly breaks the cutter. Both are checked here: the
// outermost lanes have to land exactly on the wall, and nothing may arrive at
// depth without ramping to it.

const SLOT_TOOL = { number: 1, type: 'flat', diameter: 6, fluteLength: 20, flutes: 3 };

function slotArgs(params = {}) {
  return {
    type: 'slot',
    name: 'slot',
    tool: SLOT_TOOL,
    mesh: makeBox(10, 10, 5),
    stock: { min: [0, 0, 0], max: [10, 10, 5] },
    // a straight line across the billet, as a DXF would give it
    drawing: [{ points: [1, 5, 9, 5], closed: false }],
    params: {
      topZ: 5, bottomZ: 2, stepdown: 1.5, stepover: 0.5, clearanceHeight: 15,
      entryGap: 1, tolerance: 0.01, rampAngle: 3, direction: 'climb', slotWidth: 0,
    },
  };
}

test('a slot no wider than the cutter is one lane down the line', () => {
  const cl = generateToolpath(slotArgs());
  const ys = new Set();
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.LINE && feed !== FEED.RAPID) ys.add(Math.round(y * 100) / 100);
  });
  assert.eq([...ys].join(','), '5', 'the cutter centre stays on the line');
});

test('a wider slot is cut down the middle and then out to each wall', () => {
  // 10mm slot, 6mm cutter: the walls are 2mm either side of the centreline
  const cl = generateToolpath(slotArgs({ }));
  const wide = generateToolpath({
    ...slotArgs(), params: { ...slotArgs().params, slotWidth: 10 },
  });
  const lanes = new Set();
  eachMove(wide, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.LINE && feed !== FEED.RAPID) lanes.add(Math.round(y * 100) / 100);
  });
  const sorted = [...lanes].sort((a, b) => a - b);
  assert.close(sorted[0], 3, 0.01, 'the outermost lane lands on the wall');
  assert.close(sorted[sorted.length - 1], 7, 0.01, 'and so does the other one');
  assert.ok(lanes.has(5), 'and the middle is cut');
  assert.ok(wide.count > cl.count, 'a wider slot is more work than a single lane');
});

test('a slot ramps down rather than plunging into a full-width cut', () => {
  // Top 5, bottom 2, 1.5mm stepdown: two levels, at 3.5 and 2. A plunge to a
  // *previous* level's floor is through the slot the last pass already cut and
  // is fine; a plunge to the depth this pass is about to cut at is the cutter
  // being used as a drill, in the one place that is worst for it.
  const cl = generateToolpath(slotArgs());
  const levels = depthPasses(5, 2, 1.5);
  const plungedTo = [];
  let ramps = 0;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE) return;
    if (feed === FEED.RAMP) ramps++;
    if (feed === FEED.PLUNGE) plungedTo.push(Math.round(z * 1000) / 1000);
  });
  assert.ok(ramps > 0, 'the entry ramps');
  assert.ok(plungedTo.length > 0, 'and it does get down to the material somehow');
  for (const z of plungedTo) {
    assert.ok(z >= levels[levels.length - 1] + 1e-6 || z >= 5 - 1e-6,
      `plunged to Z${z}, which is the depth the pass cuts at`);
  }
});

test('a slot narrower than the cutter is refused, not silently widened', () => {
  const cl = generateToolpath({
    ...slotArgs(), params: { ...slotArgs().params, slotWidth: 3 },
  });
  const warned = cl.notes.filter((n) => n.level === 'warn').map((n) => n.text).join(' ');
  assert.ok(/never narrower/.test(warned), `expected a refusal, got "${warned}"`);
});
