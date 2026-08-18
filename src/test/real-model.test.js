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
