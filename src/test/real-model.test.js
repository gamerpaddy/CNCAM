// End-to-end checks against a real CAD export.
//
// clamp1.stl is here because it broke things the synthetic fixtures could not:
// it sits far from the origin (x -250, y -540), and its tessellation produces
// sliver polygons that made the silhouette grow without bound. Contour and
// Z-level clearing appeared to generate nothing at all — they were in fact
// still grinding through a union that had swollen to hundreds of loops.

import { test, assert } from './runner.js';
import { loadSampleBuffer } from './samples.js';
import { parseSTL } from '../io/stl.js';
import { meshFromSoup, computeBounds } from '../geom/mesh.js';
import { createSetup, createOperation } from '../doc/schema.js';
import { resolveSetup } from '../engine/setup.js';
import { computeStock, depthPasses } from '../engine/stock.js';
import { SilhouetteStack } from '../geom/silhouette.js';
import { generateToolpath } from '../engine/toolpath.js';
import { eachMove, OP, FEED } from '../engine/cl.js';
import { toolFromPreset, allPresets } from '../doc/tool-library.js';

let cached = null;

async function clampSetup() {
  if (cached) return cached;
  const mesh = meshFromSoup(parseSTL(await loadSampleBuffer('clamp1.stl')));
  const { meshes, stock } = resolveSetup(createSetup(), [mesh], computeStock);
  cached = { mesh: meshes[0], stock, bounds: computeBounds(meshes[0].positions) };
  return cached;
}

function toolFor(name) {
  return toolFromPreset(allPresets().find((p) => p.name === name), 1);
}

function paramsFor(type, stock, bounds) {
  const op = createOperation(type);
  op.params.topZ = stock.max[2];
  op.params.bottomZ = bounds.min[2];
  op.params.clearanceHeight = stock.max[2] + 10;
  op.params.tolerance = 0.02;
  return op.params;
}

test('a model placed far from the origin lands on its setup datum', async () => {
  const { bounds, stock } = await clampSetup();
  // authored around (-250, -540); the default datum centres it on the stock top
  assert.close(stock.max[2], 0, 1e-6, 'stock top on Z zero');
  assert.close((stock.min[0] + stock.max[0]) / 2, 0, 1e-6, 'centred in X');
  assert.close((stock.min[1] + stock.max[1]) / 2, 0, 1e-6, 'centred in Y');
  assert.ok(bounds.min[0] > -60 && bounds.max[0] < 60, 'model moved with it');
});

test('silhouette of a real mesh does not fragment as it descends', async () => {
  const { mesh, stock, bounds } = await clampSetup();
  const stack = new SilhouetteStack(mesh, { tolerance: 0.02 });

  let worstLoops = 0;
  for (const z of depthPasses(stock.max[2], bounds.min[2], 1)) {
    worstLoops = Math.max(worstLoops, stack.down(z).length);
  }
  // with sliver control this settles well under a hundred; without it, this
  // mesh climbed past five hundred loops and offsetting them took minutes
  assert.ok(worstLoops < 120, `silhouette fragmented into ${worstLoops} loops`);
});

test('contour and Z-level clearing both produce real cuts on a real model', async () => {
  const { mesh, stock, bounds } = await clampSetup();
  const tool = toolFor('6mm flat 2FL');

  for (const type of ['contour2d', 'clear2d']) {
    const cl = generateToolpath({
      type, name: type, tool, stock, mesh, params: paramsFor(type, stock, bounds),
    });
    let cuts = 0;
    let lowest = Infinity;
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (op !== OP.LINE || feed === FEED.RAPID) return;
      cuts++;
      lowest = Math.min(lowest, z);
    });
    assert.ok(cuts > 100, `${type} produced only ${cuts} cutting moves`);
    assert.close(lowest, bounds.min[2], 0.001, `${type} reaches the bottom of the part`);
  }
});

test('every strategy runs on the real model without throwing', async () => {
  const { mesh, stock, bounds } = await clampSetup();
  const tools = { parallel3d: toolFor('6mm ball'), drill: toolFor('6mm drill') };
  for (const type of ['face', 'contour2d', 'clear2d', 'adaptive', 'drill', 'parallel3d']) {
    const cl = generateToolpath({
      type, name: type, tool: tools[type] ?? toolFor('6mm flat 2FL'),
      stock, mesh, params: paramsFor(type, stock, bounds),
    });
    assert.ok(cl.count >= 0, `${type} returned a program`);
  }
});

test('Z-level clearing never leaves a spine for the next level to rapid into', async () => {
  // Rings further apart than the cutter's radius do not meet where one bends
  // away from the next, and the stock left there stood through every level —
  // each level below entered over it at rapid, as though the level above had
  // cleared it. Measured on the slope part turned 30°: a 0.7×D stepover put
  // three rapids through metal, the deepest 11.5mm.
  const { simulateRemoval } = await import('../engine/simulate.js');
  const { defaultParamsFor } = await import('../engine/op-defaults.js');
  const raw = meshFromSoup(parseSTL(await loadSampleBuffer('test-slope.stl')));
  const setup = createSetup();
  setup.orientation.rotationDeg = [0, 0, 30];
  const { meshes, stock } = resolveSetup(setup, [raw], computeStock);
  const bounds = computeBounds(meshes[0].positions);
  const tool = toolFor('12mm flat 3FL');
  const params = {
    ...createOperation('clear2d').params,
    ...defaultParamsFor('clear2d', { stock, modelBounds: bounds, tool }),
    stepover: 0.7,
    stockToLeave: 0,
  };
  const cl = generateToolpath({ type: 'clear2d', params, tool, stock, mesh: meshes[0] });
  const sim = simulateRemoval({ stock, ops: [{ cl, tool }], maxCells: 150000 });
  assert.eq(sim.rapidCut.count, 0,
    `no rapid takes metal — deepest ${sim.rapidCut.depth.toFixed(2)}mm`);
  assert.ok((cl.notes ?? []).some((n) => /rather than the 0\.70×D asked for/.test(n.text)),
    'and the pass says it stepped less than it was asked to, and why');
});
