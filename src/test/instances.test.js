// Copies of the part on one table: the placements, the setup that holds them, and
// that the program a setup writes really does cover every one.
//
// The hole plate has four 6mm holes, a 10, a 20 and a blind 8 — seven in all — so
// an array of three has twenty-one, and a count that lands anywhere else says what
// went wrong. Each hole is then checked in the *simulated billet*, at the place the
// copy puts it, because a program that finds the holes and drills them somewhere
// else would count right and cut wrong.

import { test, assert } from './runner.js';
import { parseSTL } from '../io/stl.js';
import { meshFromSoup, computeBounds, mergeMeshes } from '../geom/mesh.js';
import { loadSampleBuffer } from './samples.js';
import { computeStock } from '../engine/stock.js';
import { resolveSetup } from '../engine/setup.js';
import {
  gridCopies, circleCopies, expandInstances, pivotOf, overlappingCopies, copyPlacements, MAX_COPIES,
} from '../engine/instances.js';
import { createSetup, createProject, createTool, createOperation, serializeProject, deserializeProject } from '../doc/schema.js';
import { generateToolpath } from '../engine/toolpath.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { OP, MOVE_STRIDE } from '../engine/cl.js';
import { findHoles } from '../engine/strategies/drill.js';
import { simulateRemoval } from '../engine/simulate.js';
import { buildGcode } from '../post/index.js';
import { recogniseFeatures } from '../engine/features.js';
import { makeBox } from './fixtures.js';
import { Document } from '../doc/document.js';
import { opFingerprint } from '../app/op-status.js';

async function plate() {
  return meshFromSoup(parseSTL(await loadSampleBuffer('test-hole-plate.stl')));      // 90 x 60 x 14
}

function setupWith(copies, origin = 'model') {
  const s = createSetup('Setup 1');
  s.instances = copies;
  s.orientation = { rotationDeg: [0, 0, 0], origin };
  return s;
}

test('a grid is the original and the cells after it, spaced as asked', () => {
  const g = gridCopies({ columns: 3, rows: 2, spacingX: 100, spacingY: 70 });
  assert.eq(g.length, 5, 'six cells, one of them the original');
  assert.eq(JSON.stringify(g.map((c) => [c.dx, c.dy])), '[[100,0],[200,0],[0,70],[100,70],[200,70]]');
  assert.ok(g.every((c) => c.rotZ === 0));
  assert.eq(gridCopies({ columns: 1, rows: 1 }).length, 0, 'one cell is no copies');
  assert.eq(gridCopies({ columns: 500, rows: 500 }).length, 50 * 50 - 1, 'and it is bounded');
});

test('a circle carries each copy round, and turns it as the carousel would', () => {
  const c = circleCopies({ count: 4, radius: 100, startDeg: 0, turn: true });
  assert.eq(c.length, 3);
  // the original is at angle 0 on a circle of radius 100: (100, 0) relative to the centre
  // the copy at 90 degrees is at (0, 100): moved by (-100, 100) and turned 90
  assert.close(c[0].dx, -100, 1e-9);
  assert.close(c[0].dy, 100, 1e-9);
  assert.close(c[0].rotZ, 90, 1e-9);
  assert.close(c[1].dx, -200, 1e-9, 'opposite side');
  assert.close(c[1].dy, 0, 1e-9);
  assert.eq(c[1].rotZ, 180);
  // every copy is a radius from the centre, wherever the original is
  const start = 30;
  const rotated = circleCopies({ count: 6, radius: 40, startDeg: start, turn: false });
  const centre = [-40 * Math.cos((start * Math.PI) / 180), -40 * Math.sin((start * Math.PI) / 180)];
  for (const k of rotated) {
    assert.close(Math.hypot(k.dx - centre[0], k.dy - centre[1]), 40, 1e-9, 'on the circle');
    assert.eq(k.rotZ, 0, 'not turned when told not to');
  }
  assert.ok(circleCopies({ count: 1000 }).length <= MAX_COPIES);
});

test('a copy is the part moved: same triangles, shifted, and the original untouched', () => {
  const box = makeBox(20, 10, 5);
  const pivot = pivotOf([box]);
  assert.eq(JSON.stringify(pivot), '[10,5]');
  const all = expandInstances([box], [{ dx: 50, dy: 30, rotZ: 0 }], pivot);
  assert.eq(all.length, 2);
  assert.ok(all[0] === box, 'the original is the very same mesh');
  const b = computeBounds(all[1].positions);
  assert.eq(JSON.stringify([b.min, b.max]), '[[50,30,0],[70,40,5]]');
  assert.eq(all[1].indices.length, box.indices.length, 'the same triangles');
  // turned a quarter about its own centre, then moved: a 20 x 10 footprint becomes 10 x 20
  const turned = expandInstances([box], [{ dx: 0, dy: 0, rotZ: 90 }], pivot)[1];
  const tb = computeBounds(turned.positions);
  assert.close(tb.max[0] - tb.min[0], 10, 1e-4);
  assert.close(tb.max[1] - tb.min[1], 20, 1e-4);
  assert.close((tb.min[0] + tb.max[0]) / 2, 10, 1e-4, 'about its own centre');
  assert.close((tb.min[1] + tb.max[1]) / 2, 5, 1e-4);
  assert.eq(expandInstances([box], [], pivot)[0], box);
  assert.eq(expandInstances([box], undefined, pivot).length, 1);
});

test('the setup resolves to the original and its copies, with the stock round all of them', async () => {
  const mesh = await plate();
  const single = resolveSetup(setupWith([]), [mesh], computeStock);
  assert.eq(single.meshes.length, 1);
  const copies = gridCopies({ columns: 3, rows: 1, spacingX: 100, spacingY: 0 });
  const three = resolveSetup(setupWith(copies), [mesh], computeStock);
  assert.eq(three.meshes.length, 3);
  // 90 wide, 100 apart: the three span 290, and the billet is a margin bigger than that
  const width = (st) => st.max[0] - st.min[0];
  assert.close(width(three.stock) - width(single.stock), 200, 1e-6, 'the billet grew by the two spacings');
  assert.close(three.stock.max[1] - three.stock.min[1], single.stock.max[1] - single.stock.min[1], 1e-6, 'and not in Y');
  // a lathe holds one bar
  const lathe = createSetup('L', 'turn');
  lathe.instances = copies;
  assert.eq(resolveSetup(lathe, [mesh], computeStock).meshes.length, 1);
});

test('the datum stays on the stock: zero is the stock\'s own corner however many copies there are', async () => {
  const mesh = await plate();
  const copies = gridCopies({ columns: 2, rows: 2, spacingX: 100, spacingY: 70 });
  const r = resolveSetup(setupWith(copies, 'stock-bottom-min'), [mesh], computeStock);
  assert.close(r.stock.min[0], 0, 1e-6);
  assert.close(r.stock.min[1], 0, 1e-6);
  assert.close(r.stock.min[2], 0, 1e-6);
});

test('holes are found on every copy, each where its copy puts it', async () => {
  const mesh = await plate();
  const single = resolveSetup(setupWith([]), [mesh], computeStock);
  const bounds = (m) => computeBounds(m.positions);
  const holesIn = (r) => {
    const merged = mergeMeshes(r.meshes);
    const b = bounds(merged);
    return findHoles(merged, { topZ: b.max[2], bottomZ: b.min[2], bounds: b });
  };
  const one = holesIn(single);
  assert.eq(one.length, 7);
  const copies = gridCopies({ columns: 3, rows: 1, spacingX: 100, spacingY: 0 });
  const three = holesIn(resolveSetup(setupWith(copies), [mesh], computeStock));
  assert.eq(three.length, 21, 'seven holes on each of three parts');
  // each hole of the original appears three times, 100 apart
  for (const h of one) {
    for (const k of [0, 1, 2]) {
      assert.ok(three.some((t) => Math.abs(t.cx - (h.cx + 100 * k)) < 0.05 && Math.abs(t.cy - h.cy) < 0.05 && Math.abs(t.r - h.r) < 0.02),
        `hole at (${h.cx}, ${h.cy}) not found at copy ${k}`);
    }
  }
});

test('a drill over the array drills every hole of every copy, in the billet, and nothing between', async () => {
  const mesh = await plate();
  const copies = gridCopies({ columns: 2, rows: 1, spacingX: 100, spacingY: 0 });
  const r = resolveSetup(setupWith(copies), [mesh], computeStock);
  const merged = mergeMeshes(r.meshes);
  const tool = { number: 1, type: 'drill', name: '6 drill', diameter: 6, tipAngle: 118, flutes: 2, fluteLength: 30, spindleRpm: 3000, feedCut: 200, feedPlunge: 200 };
  const params = { ...defaultParamsFor('drill', { stock: r.stock, tool }), clearanceHeight: r.stock.max[2] + 10 };
  const cl = generateToolpath({ type: 'drill', name: 'drill', tool, mesh: merged, stock: r.stock, params });
  const drilled = [];
  for (let i = 0; i < cl.count; i++) if (cl.moves[i * MOVE_STRIDE] === OP.DRILL) drilled.push([cl.moves[i * MOVE_STRIDE + 1], cl.moves[i * MOVE_STRIDE + 2]]);
  assert.eq(drilled.length, 8, 'four 6mm holes on each of two parts');
  const sim = simulateRemoval({ stock: r.stock, ops: [{ cl, tool }], maxCells: 160_000 });
  const heightAt = (x, y) => sim.final[Math.round((y - sim.origin[1]) / sim.cellSize) * sim.width + Math.round((x - sim.origin[0]) / sim.cellSize)];
  const top = r.stock.max[2];
  for (const [x, y] of drilled) assert.ok(heightAt(x, y) < top - 5, `the hole at (${x.toFixed(1)}, ${y.toFixed(1)}) is open in the billet`);
  // the stock between the two parts, and over the middle of a part, is untouched
  assert.close(heightAt(95, 30), top, 1e-6, 'the billet between the parts');
  assert.close(heightAt(30, 30), top, 1e-6, 'and the middle of a part');
});

test('one tool change serves every copy: the program over the array has the tool changes of one part', async () => {
  const mesh = await plate();
  const tools = [
    { number: 1, type: 'drill', name: '6 drill', diameter: 6, tipAngle: 118, flutes: 2, fluteLength: 30, spindleRpm: 3000, feedCut: 200, feedPlunge: 200 },
    { number: 2, type: 'drill', name: '10 drill', diameter: 10, tipAngle: 118, flutes: 2, fluteLength: 30, spindleRpm: 3000, feedCut: 200, feedPlunge: 200 },
  ];
  const changes = (copies) => {
    const r = resolveSetup(setupWith(copies), [mesh], computeStock);
    const merged = mergeMeshes(r.meshes);
    const ops = tools.map((tool, i) => ({
      name: `d${i}`,
      cl: generateToolpath({ type: 'drill', name: 'd', tool, mesh: merged, stock: r.stock, params: { ...defaultParamsFor('drill', { stock: r.stock, tool }), clearanceHeight: r.stock.max[2] + 10 } }),
    }));
    return (buildGcode('linuxcnc', ops).text.match(/\bM6\b/g) || []).length;
  };
  assert.eq(changes([]), 2);
  assert.eq(changes(gridCopies({ columns: 4, rows: 1, spacingX: 100, spacingY: 0 })), 2, 'four parts, the same two tool changes');
});

test('recognition sees every copy: three step plates have three pockets', async () => {
  const mesh = meshFromSoup(parseSTL(await loadSampleBuffer('test-step-plate.stl')));
  const copies = gridCopies({ columns: 3, rows: 1, spacingX: 120, spacingY: 0 });
  const r = resolveSetup(setupWith(copies), [mesh], computeStock);
  const found = recogniseFeatures(mergeMeshes(r.meshes), { stock: r.stock });
  const pocket = found.proposals.find((p) => p.id === 'pocket');
  assert.ok(pocket && /^3 pockets/.test(pocket.label), pocket?.label);
});

test('overlap is by the boxes, with room for the cutter between parts', () => {
  const b = { min: [0, 0, 0], max: [90, 60, 14] };
  const pivot = [45, 30];
  assert.eq(overlappingCopies(b, gridCopies({ columns: 2, spacingX: 100 }), pivot, 3).length, 0, '10mm apart');
  assert.eq(overlappingCopies(b, gridCopies({ columns: 2, spacingX: 92 }), pivot, 3).length, 1, 'only 2mm apart: too tight for a cutter');
  assert.eq(overlappingCopies(b, gridCopies({ columns: 2, spacingX: 80 }), pivot, 0).length, 1, 'overlapping');
  // a part turned a quarter is 60 wide in X
  assert.eq(overlappingCopies(b, [{ dx: 80, dy: 0, rotZ: 90 }], pivot, 3).length, 0, 'the turned copy is narrower in X');
  assert.eq(copyPlacements(gridCopies({ columns: 3 }), pivot).length, 2);
});

test('copies are saved, an old file has none, and nonsense is repaired and said so', () => {
  const project = createProject('p');
  const setup = createSetup('s');
  setup.instances = gridCopies({ columns: 2, rows: 2, spacingX: 100, spacingY: 80 });
  project.setups.push(setup);
  const back = deserializeProject(serializeProject(project));
  assert.eq(JSON.stringify(back.setups[0].instances), JSON.stringify(setup.instances), 'round trip');
  const raw = JSON.parse(serializeProject(project));
  delete raw.setups[0].instances;
  assert.eq(deserializeProject(JSON.stringify(raw)).setups[0].instances.length, 0, 'an old file');
  raw.setups[0].instances = [{ dx: 10, dy: 5 }, { dx: 'x', dy: 1 }, null, { dx: 1e9, dy: 0 }];
  const notes = [];
  const fixed = deserializeProject(JSON.stringify(raw), notes).setups[0].instances;
  assert.eq(JSON.stringify(fixed), '[{"dx":10,"dy":5,"rotZ":0}]', 'only the usable one is kept');
  assert.ok(notes.some((n) => /unusable copies/.test(n)), notes.join(' | '));
  raw.setups[0].instances = 'lots';
  assert.eq(deserializeProject(JSON.stringify(raw)).setups[0].instances.length, 0);
});

test('changing the copies marks the toolpaths out of date', () => {
  const doc = new Document();
  const tool = createTool('flat');
  doc.addTool(tool);
  const setup = createSetup('s');
  doc.addSetup(setup);
  const op = createOperation('pocket');
  op.toolId = tool.id;
  doc.addOperation(setup, op);
  const before = opFingerprint(doc, op, setup);
  doc.updateItem(setup, { instances: gridCopies({ columns: 2 }) }, 'array');
  assert.ok(opFingerprint(doc, op, setup) !== before, 'a different set of copies is a different program');
});
