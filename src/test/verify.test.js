import { test, assert } from './runner.js';
import { simulateRemoval } from '../engine/simulate.js';
import { verifyRun, lastTouch } from '../engine/verify.js';
import { CLBuilder, FEED } from '../engine/cl.js';
import { rotationMatrix } from '../engine/setup.js';
import { cutFromSimulation } from '../engine/workpiece.js';
import { makeBox, makeStepped } from './fixtures.js';
import { meshFromSoup } from '../geom/mesh.js';

const FLAT = {
  number: 1, type: 'flat', diameter: 8, fluteLength: 20,
  spindleRpm: 10000, feedCut: 800, feedPlunge: 300,
};
const BIG = { ...FLAT, diameter: 20 };

const IDENTITY = { matrix: rotationMatrix([0, 0, 0]), offset: [0, 0, 0] };

/**
 * A 40×40 part 8mm tall, in a billet 10mm tall: the program has to take 2mm
 * off the top and leave a flat face at exactly z = 8.
 */
const PART = makeBox(40, 40, 8);
const STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] };

/** Raster the whole top of the billet flat at height z, with a 20mm cutter. */
function faceTo(z, tool = BIG) {
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  const r = tool.diameter / 2;
  cl.rapid(-r, 0, z + 5);
  cl.cut(-r, 0, z, FEED.PLUNGE);
  for (let y = 0; y <= 40 + r; y += tool.diameter * 0.6) {
    cl.cut(40 + r, y, z);
    cl.cut(40 + r, Math.min(y + tool.diameter * 0.6, 40 + r), z);
    cl.cut(-r, Math.min(y + tool.diameter * 0.6, 40 + r), z);
  }
  return { cl: cl.finish(), tool };
}

function verified(ops, { mesh = PART, tolerance = 0.05 } = {}) {
  const sim = simulateRemoval({ stock: STOCK, ops, frame: IDENTITY });
  const cuts = [cutFromSimulation(sim, sim.final, IDENTITY)];
  return { sim, result: verifyRun({ sim, mesh, stock: STOCK, cuts, frame: IDENTITY, tolerance }) };
}

test('a program that lands on the model reports nothing', () => {
  const { result } = verified([faceTo(8)]);
  assert.eq(result.gougeCells, 0, `no gouge (worst ${result.worstGouge?.mm ?? 0})`);
  assert.eq(result.excessCells, 0, `no excess (worst ${result.worstExcess?.mm ?? 0})`);
  assert.ok(result.checked > 1000, 'and it looked at the part rather than at nothing');
});

test('a pass 1mm too deep is a gouge, and says how deep', () => {
  const { result } = verified([faceTo(7)]);
  assert.ok(result.gougeCells > 1000, `the whole face is gouged, got ${result.gougeCells}`);
  assert.close(result.worstGouge.mm, 1, 0.05, 'by the millimetre it went too far');
  assert.eq(result.excessCells, 0, 'and nothing is left standing');
});

test('a pass 1mm short is excess, and says how much', () => {
  const { result } = verified([faceTo(9)]);
  assert.ok(result.excessCells > 1000, `the whole face is proud, got ${result.excessCells}`);
  assert.close(result.worstExcess.mm, 1, 0.05, 'by the millimetre it did not take');
  assert.eq(result.gougeCells, 0, 'and nothing is cut into the part');
});

test('stock never touched at all is excess of the whole depth', () => {
  const { result } = verified([faceTo(12)]);      // above the billet: cuts nothing
  assert.close(result.worstExcess.mm, 2, 0.05, 'the 2mm that should have come off');
});

test('a gouge is traced back to the operation that made it', () => {
  const sim = simulateRemoval({
    stock: STOCK, ops: [faceTo(9), faceTo(7)], frame: IDENTITY,
  });
  const cuts = [cutFromSimulation(sim, sim.final, IDENTITY)];
  const result = verifyRun({ sim, mesh: PART, stock: STOCK, cuts, frame: IDENTITY });
  assert.ok(result.worstGouge, 'there is a gouge');
  assert.eq(result.worstGouge.op, 1, 'and it was the second pass that cut it');
  assert.ok(result.worstGouge.step > 0, 'at a step the timeline can be sent to');
});

test('a cell nothing ever touched has no step to name', () => {
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(20, 20, 15);
  cl.cut(20, 20, 5, FEED.PLUNGE);          // one plunge in the middle, nowhere else
  const sim = simulateRemoval({
    stock: STOCK, ops: [{ cl: cl.finish(), tool: FLAT }], frame: IDENTITY,
  });
  assert.eq(lastTouch(sim, 0).step, -1, 'the far corner is outside every pass');
  const middle = Math.round((20 - sim.origin[1]) / sim.cellSize) * sim.width
    + Math.round((20 - sim.origin[0]) / sim.cellSize);
  assert.ok(lastTouch(sim, middle).step > 0, 'and the plunge names its own step');
});

test('a wall is not a gouge', () => {
  // A stepped part: a 20mm boss standing 10mm proud of a 40mm base. Every cell
  // along the boss wall holds both heights, and a check that judged a cell by
  // its own model sample would call the whole perimeter a 10mm gouge.
  const step = makeStepped({ base: 40, top: 20, baseHeight: 10, topHeight: 10 });
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] };
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  // clear the ledge round the boss down to the base height, in rings that stop
  // clear of the boss
  const r = 4;
  cl.rapid(-r, -r, 15);
  for (const inset of [0, 3, 6]) {
    const a = inset - r;
    const b = 40 - inset + r;
    cl.cut(a, a, 10, FEED.PLUNGE);
    cl.cut(b, a, 10);
    cl.cut(b, b, 10);
    cl.cut(a, b, 10);
    cl.cut(a, a, 10);
  }
  const sim = simulateRemoval({
    stock, ops: [{ cl: cl.finish(), tool: FLAT }], frame: IDENTITY,
  });
  const cuts = [cutFromSimulation(sim, sim.final, IDENTITY)];
  const result = verifyRun({ sim, mesh: step.mesh, stock, cuts, frame: IDENTITY });
  assert.eq(result.gougeCells, 0,
    `the ledge is on the model, so nothing is gouged (worst ${result.worstGouge?.mm ?? 0})`);
});

/**
 * A 20×20 block 10mm tall on nothing, its walls a few hundredths of a degree
 * off vertical the way a CAD export leaves them, in a billet with air round it.
 */
function leaningBlock(lean) {
  const h = 10;
  const w = 10;
  const d = Math.tan((lean * Math.PI) / 180) * h;
  const lo = [[-w, -w], [w, -w], [w, w], [-w, w]];
  // each side leans the other way from the one before it
  const hi = [[-w - d, -w + d], [w + d, -w - d], [w - d, w + d], [-w + d, w - d]];
  const soup = [];
  const q = (a, b, c, e) => soup.push(...a, ...b, ...c, ...a, ...c, ...e);
  for (let k = 0; k < 4; k++) {
    const n = (k + 1) % 4;
    q([...lo[k], -h], [...lo[n], -h], [...hi[n], 0], [...hi[k], 0]);
  }
  q([...hi[0], 0], [...hi[1], 0], [...hi[2], 0], [...hi[3], 0]);
  q([...lo[0], -h], [...lo[3], -h], [...lo[2], -h], [...lo[1], -h]);
  return meshFromSoup(new Float32Array(soup));
}

/** One lap round the block at z = −5, the cutter `into` millimetres into its wall. */
function lapRound(into) {
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  const o = 10 + 3 - into;
  cl.rapid(-o, -o - 5, 5);
  cl.rapid(-o, -o - 5, -5);
  cl.cut(-o, -o, -5);
  for (const [x, y] of [[o, -o], [o, o], [-o, o], [-o, -o]]) cl.cut(x, y, -5);
  cl.rapid(-o, -o, 5);
  return { cl: cl.finish(), tool: { ...FLAT, diameter: 6 } };
}

test('a wall cut to size on the outline of the part is not a gouge', () => {
  // Two faults, both on the part's outline, where the cells beside it have no
  // model at all and so cannot widen the range a cell is judged against:
  //  - a wall a few hundredths of a degree off vertical covers a sliver of
  //    plan, and a cell centre landing in it read a height from half-way up;
  //  - a column is cut or not, so the cutter running along the wall on size
  //    took cells whose centres were a micron inside it.
  // On clamp1 both were reported as gouges 2 to 10mm deep.
  const stock = { kind: 'box', min: [-20, -20, -10], max: [20, 20, 0] };
  for (const lean of [0, 0.03]) {
    const mesh = leaningBlock(lean);
    const check = (into) => {
      const sim = simulateRemoval({ stock, ops: [lapRound(into)], maxCells: 250000 });
      return verifyRun({ sim, mesh, stock });
    };
    const onSize = check(0);
    assert.eq(onSize.gougeCells, 0,
      `walls leaning ${lean}°, cut on size: ${onSize.gougeCells} cells, worst ${onSize.worstGouge?.mm}`);
    // and a real one is still a real one
    const into = check(0.1);
    assert.ok(into.gougeCells > 100, `walls leaning ${lean}°, 0.1mm in: only ${into.gougeCells} cells`);
    assert.close(into.worstGouge.mm, 5, 0.05, 'the whole 5mm of wall below the cut');
  }
});

test('a tighter tolerance finds what a loose one forgives', () => {
  const tight = verified([faceTo(8.2)], { tolerance: 0.05 }).result;
  const loose = verified([faceTo(8.2)], { tolerance: 0.5 }).result;
  assert.ok(tight.excessCells > 0, 'two tenths is out at five hundredths');
  assert.eq(loose.excessCells, 0, 'and in at half a millimetre');
});

test('metal a later setup will remove is not excess', () => {
  // Setup 1 faces to 9 — a millimetre proud of the 8mm part. On its own that is
  // excess; with the flipped setup that takes it off, it is not.
  const first = simulateRemoval({ stock: STOCK, ops: [faceTo(9)], frame: IDENTITY });
  const alone = verifyRun({
    sim: first,
    mesh: PART,
    stock: STOCK,
    cuts: [cutFromSimulation(first, first.final, IDENTITY)],
    frame: IDENTITY,
  });
  assert.ok(alone.excessCells > 1000, 'on its own the face is proud');

  // A second setup, the same way up, that takes the last millimetre
  const second = simulateRemoval({
    stock: STOCK,
    ops: [faceTo(8)],
    frame: IDENTITY,
    cuts: [cutFromSimulation(first, first.final, IDENTITY)],
  });
  const both = verifyRun({
    sim: first,
    mesh: PART,
    stock: STOCK,
    cuts: [
      cutFromSimulation(first, first.final, IDENTITY),
      cutFromSimulation(second, second.final, IDENTITY),
    ],
    frame: IDENTITY,
  });
  assert.eq(both.excessCells, 0, 'with the setup that removes it, there is none');
});
