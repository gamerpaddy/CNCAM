// Where a pass comes down, and what it swings through on the way in and out.
//
// Every pass makes a claim about the metal under the place it comes down at
// rapid, and about the ground a lead swings across — and a claim that is only
// true of the case it was written for is a rapid into a wall beside it. These
// run each fix against the simulator and the app's own verification, on the
// parts and settings that made the wrong claim.

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { createOperation, createSetup } from '../doc/schema.js';
import { simulateRemoval } from '../engine/simulate.js';
import { verifyRun } from '../engine/verify.js';
import { resolveSetup } from '../engine/setup.js';
import { computeStock } from '../engine/stock.js';
import { parseSTL } from '../io/stl.js';
import { meshFromSoup, computeNormals, computeBounds } from '../geom/mesh.js';
import { offsetLoops } from '../geom/clipper.js';
import { silhouetteAbove } from '../geom/silhouette.js';
import { Ground, footprint, GRAZE } from '../engine/ground.js';
import { makeBoss, makePocketBlock, makeTwoPockets } from './fixtures.js';
import { loadSampleBuffer } from './samples.js';
import { cutsOf } from './cuts.js';

const FLAT = {
  number: 1, type: 'flat', diameter: 6, flutes: 2, fluteLength: 20,
  spindleRpm: 12000, feedCut: 800, feedPlunge: 250,
};
const BALL = { ...FLAT, number: 2, type: 'ball' };
const CHAMFER = {
  number: 3, type: 'chamfer', diameter: 6, tipAngle: 90, flutes: 2, fluteLength: 8,
  spindleRpm: 12000, feedCut: 600, feedPlunge: 200,
};

/** A mesh as a setup places it: turned about Z, the billet grown round it, top at Z0. */
function placed(raw, { rot = 0, margin = [1, 1, 1] } = {}) {
  const setup = createSetup();
  setup.orientation.rotationDeg = [0, 0, rot];
  setup.stock.margin = margin;
  const { meshes, stock } = resolveSetup(setup, [raw], computeStock);
  return { mesh: meshes[0], stock };
}

async function sample(name) {
  return computeNormals(meshFromSoup(parseSTL(await loadSampleBuffer(name))));
}

/** An operation's settings the way the app makes them, with `over` on top. */
function paramsFor(type, { mesh, stock }, tool, over = {}) {
  const b = computeBounds(mesh.positions);
  return {
    ...createOperation(type).params,
    ...defaultParamsFor(type, { stock, tool, modelBounds: { min: b.min, max: b.max } }),
    ...over,
  };
}

function generate(type, job, tool, over = {}, extra = {}) {
  const params = paramsFor(type, job, tool, over);
  const cl = generateToolpath({
    type, params, tool, stock: job.stock, mesh: job.mesh, regions: null, fixtures: [], ...extra,
  });
  return { cl, tool, params };
}

function simulate(job, ops) {
  const sim = simulateRemoval({
    stock: job.stock, ops: ops.map(({ cl, tool }) => ({ cl, tool })), maxCells: 90_000, record: 8,
  });
  assert.ok(!sim.truncated, 'the simulation ran to the end');
  return sim;
}

test('the ground: how high metal stands in a region, from what was cut and how deep', () => {
  const stock = { min: [0, 0, -10], max: [20, 10, 0] };
  const ground = new Ground({ stock, topZ: 0 });
  const box = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
  assert.eq(ground.topIn([box(30, 0, 40, 10)]), -Infinity, 'off the billet there is no metal');
  assert.eq(ground.topIn([box(2, 2, 4, 4)]), 0, 'where nothing was cut it stands at the top');
  ground.cut([box(0, 0, 10, 10)], -3);
  ground.cut([box(10, 0, 20, 10)], -6);
  assert.eq(ground.topIn([box(2, 2, 4, 4)]), -3, 'cut once, it stands where that cut left it');
  assert.eq(ground.topIn([box(8, 2, 12, 4)]), -3, 'across two cuts, as high as the higher');
  assert.eq(ground.topIn([box(12, 2, 14, 4)]), -6);
  ground.cut([box(0, 0, 20, 10)], -8);
  assert.eq(ground.topIn([box(8, 2, 12, 4)]), -8, 'a deeper cut over both takes both down');
  // A strip narrower than the graze between two cuts is two drawings of one edge.
  const g2 = new Ground({ stock, topZ: 0 });
  g2.cut([box(0, 0, 10 - GRAZE / 4, 10)], -5);
  g2.cut([box(10, 0, 20, 10)], -5);
  assert.eq(g2.topIn([box(8, 2, 12, 4)]), -5, 'a hairline left between two cuts is not metal');
  // but at rapid only the few thousandths two polygons disagree by are excused
  const g3 = new Ground({ stock, topZ: 0 });
  g3.cut([box(0, 0, 10 - 0.03, 10)], -5);
  g3.cut([box(10, 0, 20, 10)], -5);
  assert.eq(g3.topUnder(10, 5, 2), 0, 'a strip 0.03mm wide is metal under a rapid');
  assert.eq(new Ground({ stock, topZ: 0 }).topIn([footprint(5, 5, 2)]), 0);
});

test('a finish pass comes down beside the allowance it takes, and no more of the wall than the flutes reach', () => {
  // Entered "at depth" like any pass whose level above was cut, it rapided down
  // onto its own allowance — standing the full height of the wall at the point
  // it came down: 22mm down the side of the boss turned 30°. And it took the
  // whole 23mm wall in one lap with 20mm of flute, the top 3mm on the shank.
  const job = placed(makeBoss().mesh, { rot: 30 });
  for (const type of ['contour2d', 'clear2d']) {
    const op = generate(type, job, FLAT, { finishPasses: 1, stockToLeave: 0.3, leadType: 'none' });
    const sim = simulate(job, [op]);
    assert.eq(sim.rapidCut.count, 0, `${type}: ${sim.rapidCut.count} rapids into metal, `
      + `${sim.rapidCut.depth.toFixed(2)}mm`);
    const { overFlutes } = cutsOf(sim, FLAT.diameter / 2, FLAT.fluteLength);
    assert.ok(overFlutes <= 0.05, `${type}: metal ${overFlutes.toFixed(2)}mm above the flutes was cut`);
    // beyond the allowance the finish pass is taking, nothing more than a level
    const { deepest } = cutsOf(sim, FLAT.diameter / 2, FLAT.fluteLength, 0.3 * 1.5 + 0.05);
    assert.ok(deepest <= op.params.stepdown * 1.25 + 0.3,
      `${type}: a cut ${deepest.toFixed(2)}mm deep past the allowance`);
  }
});

test('each pocket is finished on its own floor, not at Bottom Z', () => {
  // Bottom Z is the bottom of the stock unless it is moved, which on a blind
  // pocket is solid part: the finish passes were planned there, found no pocket
  // and were dropped without a word — the allowance left on every wall.
  const job = placed(makePocketBlock().mesh);
  const { cl, params } = generate('pocket', job, FLAT, { finishPasses: 1, stockToLeave: 0.3 });
  // top of the block under a millimetre of stock, the pocket 6 deep, and the
  // allowance left on its floor as on its walls
  const floor = -1 - 6 + 0.3;
  const wall = 10 - FLAT.diameter / 2;
  let onWall = 0;
  for (let i = 0; i < cl.count; i++) {
    const o = i * 8;
    if (cl.moves[o] !== 1 || Math.abs(cl.moves[o + 3] - floor) > 1e-3) continue;
    if (Math.abs(Math.abs(cl.moves[o + 1]) - wall) < 0.02 || Math.abs(Math.abs(cl.moves[o + 2]) - wall) < 0.02) onWall++;
  }
  assert.ok(params.bottomZ < floor, 'Bottom Z is below the pocket');
  assert.ok(onWall >= 4, `the wall is walked at its finished size on the floor (${onWall} moves)`);
  assert.eq(simulate(job, [{ cl, tool: FLAT }]).rapidCut.count, 0, 'and entered without a rapid into it');
});

test('a contour that re-reads its outline every level never rapids into metal', async () => {
  // A loop counted as cut where the pass above had run within a radius of it —
  // true of a cutter sticking a whole radius past that pass into metal nobody
  // had touched. On the clamp part a rapid 5mm into it, then 9mm taken at once;
  // and every lead-in walked at the level above came down on ground its own
  // lead had cut only to the level above that.
  const job = placed(await sample('clamp1.stl'), { rot: 30 });
  const op = generate('contour2d', job, FLAT, { contourOutline: 'level', leadType: 'arc', leadRadius: 2 });
  const sim = simulate(job, [op]);
  assert.eq(sim.rapidCut.count, 0, `${sim.rapidCut.count} rapids into metal, ${sim.rapidCut.depth.toFixed(2)}mm`);
  const { deepest } = cutsOf(sim, FLAT.diameter / 2, FLAT.fluteLength);
  assert.ok(deepest <= op.params.stepdown * 1.25 + 0.3, `a cut ${deepest.toFixed(2)}mm deep`);
});

test('a contour does not lead out through a plate bigger than the part', async () => {
  // One helix down the loop leaves nothing cut beside it but the slot, and the
  // arc it led out on at the bottom swung through the full height of the plate:
  // 23mm deep with the side of the cutter, 3mm of it on the shank.
  const job = placed(await sample('test-step-plate.stl'), { rot: 30, margin: [8, 8, 1] });
  const op = generate('contour2d', job, FLAT, {});
  assert.eq(op.params.leadType, 'arc', 'the default contour leads in and out');
  const sim = simulate(job, [op]);
  const { deepest, overFlutes } = cutsOf(sim, FLAT.diameter / 2, FLAT.fluteLength);
  assert.ok(deepest <= op.params.stepdown * 1.25 + 0.3, `a cut ${deepest.toFixed(2)}mm deep`);
  assert.ok(overFlutes <= 0.05, `metal ${overFlutes.toFixed(2)}mm above the flutes was cut`);
  assert.ok(op.cl.notes.some((n) => /lead is left off/.test(n.text)), 'and it says where it left the lead off');
});

test('a lead never swings into the part', async () => {
  // A lead knows which side of its pass is air and nothing else: a 12mm arc
  // off a clearing ring swung round the corner of the step plate and 6.7mm into
  // it; a tangent lead in a pocket ran on past the wall, 4.75mm in.
  const job = placed(await sample('test-step-plate.stl'));
  for (const [type, lead] of [['clear2d', { leadType: 'arc', leadRadius: 12 }],
    ['pocket', { leadType: 'tangent', leadRadius: 6 }]]) {
    const op = generate(type, job, FLAT, lead);
    const sim = simulate(job, [op]);
    const verdict = verifyRun({ sim, mesh: job.mesh, stock: job.stock });
    assert.eq(verdict.gougeCells, 0, `${type} ${lead.leadType} ${lead.leadRadius}: `
      + `${verdict.gougeCells} cells cut into the part, ${verdict.worstGouge?.mm.toFixed(2)}mm`);
  }
});

test('a pocket that opens under the top face steps down into it from the top', async () => {
  // A level took everything between it and the last level that cut anything in
  // one pass. The step plate's pocket is open at the top face and closed a
  // millimetre under it, so its first level came in from the top of the stock
  // and took two stepdowns at once — and under 4mm of unfaced stock, 5.8mm.
  const raw = await sample('test-step-plate.stl');
  for (const [top, stepdown] of [[1, 1], [4, 3]]) {
    const job = placed(raw, { margin: [1, 1, top] });
    const op = generate('pocket', job, FLAT, { stepdown });
    const sim = simulate(job, [op]);
    const { deepest } = cutsOf(sim, FLAT.diameter / 2, FLAT.fluteLength);
    assert.ok(deepest <= stepdown * 1.25 + 0.3,
      `${top}mm on top: a cut ${deepest.toFixed(2)}mm deep on a ${stepdown}mm stepdown`);
    assert.eq(sim.rapidCut.count, 0);
  }
});

test('a pocket that opens below another is entered from its own metal, not the other\'s floor', () => {
  // Every pocket on a level was entered from the last level that cut anything.
  // The plate's pocket is a pocket only below the plate's top face, and the
  // last level that cut anything was the boss's pocket, 4mm higher: so it
  // rapided down to over the boss pocket's floor through the billet standing
  // over it, 6mm into it, and then took 9.5mm at once.
  const { mesh, boss, plate } = makeTwoPockets();
  const job = placed(mesh);
  const op = generate('pocket', job, FLAT, {});
  const sim = simulate(job, [op]);
  assert.eq(sim.rapidCut.count, 0, `${sim.rapidCut.count} rapids into metal, ${sim.rapidCut.depth.toFixed(2)}mm`);
  const { deepest } = cutsOf(sim, FLAT.diameter / 2, FLAT.fluteLength);
  assert.ok(deepest <= op.params.stepdown * 1.25 + 0.3, `a cut ${deepest.toFixed(2)}mm deep`);
  // and both are cut to their floors — the part's top is 20 up, under 1mm of stock
  for (const { floorZ } of [boss, plate]) {
    const z = floorZ - 20 - 1;
    let n = 0;
    for (let i = 0; i < op.cl.count; i++) {
      if (op.cl.moves[i * 8] === 1 && Math.abs(op.cl.moves[i * 8 + 3] - z) < 1e-3) n++;
    }
    assert.ok(n >= 4, `the pocket with its floor at Z${z} is cut to it (${n} moves)`);
  }
});

test('the tabs asked for are the tabs left standing, through every lap below their top', () => {
  // Each lap measured its windows from wherever it started: the descent starts
  // every level somewhere else, and a finish pass wherever its own loop does.
  // So each lap cut straight through the tabs the laps before it had left — a
  // full-width cut the height of the tab — and after a finish pass there were
  // no tabs at all, only its allowance where they should have been.
  const job = placed(makeBoss().mesh, { rot: 30 });
  const tab = { tabCount: 4, tabHeight: 5, tabWidth: 4, leadType: 'none' };
  for (const over of [tab, { ...tab, finishPasses: 1, stockToLeave: 0.3 }]) {
    const op = generate('contour2d', job, FLAT, over);
    const sim = simulate(job, [op]);
    const tabTop = op.params.bottomZ + op.params.tabHeight;
    const at = (x, y) => sim.final[Math.round((y - sim.origin[1]) / sim.cellSize) * sim.width
      + Math.round((x - sim.origin[0]) / sim.cellSize)];
    // round the part half a millimetre off it, where each tab joins it
    const [path] = offsetLoops(silhouetteAbove(job.mesh, op.params.bottomZ, { tolerance: 0.01 }), 0.5, 0.01);
    let line = '';
    const n = path.length / 2;
    for (let k = 0; k < n; k++) {
      const [ax, ay, bx, by] = [path[k * 2], path[k * 2 + 1], path[((k + 1) % n) * 2], path[((k + 1) % n) * 2 + 1]];
      const len = Math.hypot(bx - ax, by - ay);
      for (let u = 0; u < len; u += 0.5) line += at(ax + ((bx - ax) * u) / len, ay + ((by - ay) * u) / len) >= tabTop - 0.05 ? '#' : '.';
    }
    if (line.startsWith('#') && line.endsWith('#')) line = line.slice(line.indexOf('.')) + line.slice(0, line.indexOf('.'));
    const standing = (line.match(/#+/g) ?? []).length;
    assert.eq(standing, 4, `${JSON.stringify(over)}: ${standing} tabs standing to the tab top`);
    const { deepest } = cutsOf(sim, FLAT.diameter / 2, FLAT.fluteLength, 0.3 * 1.5 + 0.05);
    assert.ok(deepest <= op.params.stepdown * 1.25 + 0.3,
      `${JSON.stringify(over)}: a cut ${deepest.toFixed(2)}mm deep through a tab`);
  }
});

test('a chamfer and an engraving come down over stock left above the part at feed', () => {
  // They take the surface they work on to exist, and on a billet nobody has
  // faced it does not: with 4mm left on top, each rapided down to a millimetre
  // over the part, 3mm into the stock standing on it.
  const job = placed(makeBoss().mesh, { margin: [1, 1, 4] });
  const outline = generate('contour2d', job, FLAT, {});
  for (const type of ['chamfer', 'engrave']) {
    const op = generate(type, job, CHAMFER, {});
    const sim = simulate(job, [outline, op]);
    assert.eq(sim.rapidCut.count, 0, `${type}: ${sim.rapidCut.count} rapids into metal, `
      + `${sim.rapidCut.depth.toFixed(2)}mm`);
    assert.ok(op.cl.notes.some((n) => /stands 4\.00mm above Top Z/.test(n.text)),
      `${type} says the stock stands above the surface it cuts`);
  }
});

test('a finishing pass enters clear of the steps the roughing before it leaves', async () => {
  // The app raises a finishing pass's entry gap when it is added after a
  // roughing pass — and only then: a rough added after it, a stepdown raised,
  // a gap typed back down, and it rapided into the staircase the rough left,
  // 5.4mm deep on the sloped part after the default adaptive clear.
  const job = placed(await sample('test-slope.stl'));
  const rough = generate('adaptive', job, FLAT, {});
  const earlier = [{ type: 'adaptive', tool: FLAT, params: rough.params }];
  for (const type of ['waterline', 'parallel3d']) {
    const finish = generate(type, job, BALL, { entryGap: 1 }, { earlier });
    const sim = simulate(job, [rough, finish]);
    assert.eq(sim.rapidCut.count, 0, `${type}: ${sim.rapidCut.count} rapids into metal, `
      + `${sim.rapidCut.depth.toFixed(2)}mm`);
    assert.ok(finish.cl.notes.some((n) => /rather than 1mm/.test(n.text)),
      `${type} says why it entered higher than it was set to`);
    // and the steps the default adaptive leaves are 12.3mm tall, which on the
    // shallow slopes it meets whole — see heights.js stepsTooTallFor
    assert.ok(finish.cl.notes.some((n) => n.level === 'warn' && /up to 12\.3mm at once/.test(n.text)),
      `${type} warns that it takes the roughing's steps whole`);
  }
});
