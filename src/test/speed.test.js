// The shortcuts taken to make things fast, held to the answers they replaced.
//
// Each of these made something several times quicker by *not* doing work: not
// scanning cells one by one with a bounds test, not re-counting a toolpath
// that has not changed, not sending thirty thousand small objects between
// threads. A shortcut that changes the answer is a bug with a stopwatch on it,
// so each is checked against the slow way it stands in for.

import { test, assert } from './runner.js';
import { buildHeightmap, buildToolKernel, dropCutter } from '../geom/heightmap.js';
import { packLineMap, PackedLineMap } from '../post/index.js';
import { Document } from '../doc/document.js';
import { createSetup, createOperation } from '../doc/schema.js';
import { makeMushroom, makePocketBlock } from './fixtures.js';

/** The drop-cutter the obvious way: every offset of the disc, bounds-tested. */
function dropCutterByHand(map, kernel, x, y) {
  const ci = Math.round((x - map.min[0]) / map.cellSize);
  const cj = Math.round((y - map.min[1]) / map.cellSize);
  let best = -Infinity;
  for (let n = 0; n < kernel.count; n++) {
    const i = ci + kernel.offsets[n * 3];
    const j = cj + kernel.offsets[n * 3 + 1];
    if (i < 0 || j < 0 || i >= map.width || j >= map.height) continue;
    const h = map.data[j * map.width + i];
    if (h === map.floor) continue;
    best = Math.max(best, h - kernel.offsets[n * 3 + 2]);
  }
  return best === -Infinity ? map.floor : best;
}

test('the drop-cutter walks each row of the disc as one run and gets the same answer', () => {
  // Rows are clipped to the map once instead of testing every cell — which
  // only matters at the edges, so most of the probes are near them and some
  // are off the map altogether.
  // (the builders hand back the mesh with the dimensions they were built to)
  const parts = [makeMushroom(), makePocketBlock()].map((part) => part.mesh ?? part);
  const tools = [
    { type: 'ball', diameter: 6 },
    { type: 'flat', diameter: 10 },
    { type: 'bull', diameter: 8, cornerRadius: 1.5 },
  ];
  let checked = 0;
  for (const mesh of parts) {
    const map = buildHeightmap(mesh, { cellSize: 0.4 });
    const [x0, y0] = map.min;
    const x1 = x0 + (map.width - 1) * map.cellSize;
    const y1 = y0 + (map.height - 1) * map.cellSize;
    for (const tool of tools) {
      const kernel = buildToolKernel(tool, map.cellSize);
      for (let k = 0; k < 400; k++) {
        // a spread from well off the map to well inside it, edges included
        const u = ((k * 37) % 101) / 100 * 1.4 - 0.2;
        const v = ((k * 61) % 97) / 96 * 1.4 - 0.2;
        const x = x0 + u * (x1 - x0);
        const y = y0 + v * (y1 - y0);
        assert.eq(dropCutter(map, kernel, x, y), dropCutterByHand(map, kernel, x, y),
          `${tool.type} ⌀${tool.diameter} at (${x.toFixed(2)}, ${y.toFixed(2)})`);
        checked++;
      }
    }
  }
  assert.ok(checked === 2400, 'every probe was asked');
});

test('the packed line map reads back exactly what it was packed from', () => {
  // The G-code panel's line map crosses from a worker as two typed arrays
  // rather than a Map of small objects; the panel reads it with get().
  const map = new Map([[0, { op: 0, move: 0 }], [3, { op: 0, move: 7 }],
    [4, { op: 1, move: 2 }], [9, { op: 2, move: 41 }]]);
  const packed = new PackedLineMap(packLineMap(map));
  assert.eq(packed.size, map.size, 'as many lines as were mapped');
  for (let line = 0; line < 12; line++) {
    assert.eq(JSON.stringify(packed.get(line)), JSON.stringify(map.get(line)), `line ${line}`);
  }
  assert.eq(JSON.stringify([...packed.entries()]), JSON.stringify([...map.entries()]),
    'and walks them in order');
});

test('replacing a toolpath is a change the viewport and the G-code panel can see', () => {
  // Regenerating an operation leaves the list of which operations have paths
  // exactly as it was. What the preview and the backplot are keyed on has to
  // move anyway, or a Generate that only replaced paths would redraw nothing
  // and post the old program.
  const doc = new Document();
  const setup = createSetup('Setup 1', 'mill');
  const op = createOperation('face');
  setup.operations.push(op);
  doc.project.setups.push(setup);
  doc.toolpaths.set(op.id, { moves: new Float32Array(0), count: 0 });
  const before = doc.toolpathSignature(false);
  doc.toolpaths.set(op.id, { moves: new Float32Array(0), count: 0 });
  assert.ok(doc.toolpathSignature(false) !== before, 'a replaced path is a different program');
  const after = doc.toolpathSignature(false);
  doc.toolpaths.get(op.id);
  doc.toolpaths.delete('nothing by this name');
  assert.eq(doc.toolpathSignature(false), after, 'and looking, or deleting nothing, is not');
});
