import { test, assert } from './runner.js';
import { computeStock, stockOutline, createStock } from '../engine/stock.js';
import { resolveSetup, rotationMatrix, transformMesh, applyMatrix } from '../engine/setup.js';
import { computeBounds } from '../geom/mesh.js';
import { loopsBounds, loopArea } from '../geom/clipper.js';
import { MOVE_STRIDE, OP } from '../engine/cl.js';
import { deserializeProject, createSetup, PROJECT_VERSION } from '../doc/schema.js';
import {
  toolFromPreset, deserializeLibrary, serializeLibrary, allPresets, machineForType,
} from '../doc/tool-library.js';
import { generateToolpath } from '../engine/toolpath.js';
import { buildGcode } from '../post/index.js';
import { makeBox } from './fixtures.js';

// --- stock kinds ---

test('box-margin stock grows the model bounds per axis', () => {
  const stock = computeStock([makeBox(20, 30, 10)], {
    kind: 'box-margin', margin: [2, 3, 4], marginBottom: 1,
  });
  assert.close(stock.min[0], -2, 1e-6, 'X margin');
  assert.close(stock.max[1], 33, 1e-6, 'Y margin');
  assert.close(stock.max[2], 14, 1e-6, 'top margin');
  assert.close(stock.min[2], -1, 1e-6, 'bottom margin');
});

test('a sized billet is placed against the part, not at absolute coordinates', () => {
  // makeBox spans 0..20 in X, 0..30 in Y, 0..10 in Z
  const stock = computeStock([makeBox(20, 30, 10)], {
    kind: 'box', box: { size: [40, 50, 25], align: 'center', offset: [0, 0, 0] },
  });
  assert.close(stock.max[0] - stock.min[0], 40, 1e-6, 'the width asked for');
  assert.close(stock.max[1] - stock.min[1], 50, 1e-6, 'the depth asked for');
  assert.close(stock.max[2] - stock.min[2], 25, 1e-6, 'the height asked for');
  // centred in XY on the part, and hung from the top of it in Z
  assert.close((stock.min[0] + stock.max[0]) / 2, 10, 1e-6, 'centred in X');
  assert.close((stock.min[1] + stock.max[1]) / 2, 15, 1e-6, 'centred in Y');
  assert.close(stock.max[2], 10, 1e-6, 'top of the billet meets the top of the part');
});

test('billet alignment registers the part to a corner', () => {
  const spec = (align) => computeStock([makeBox(20, 30, 10)], {
    kind: 'box', box: { size: [40, 50, 25], align, offset: [0, 0, 0] },
  });
  assert.close(spec('min').min[0], 0, 1e-6, 'part at the X- corner');
  assert.close(spec('max').max[0], 20, 1e-6, 'part at the X+ corner');
});

test('a shift moves the billet off its alignment by a measurable amount', () => {
  const stock = computeStock([makeBox(20, 30, 10)], {
    kind: 'box', box: { size: [40, 50, 25], align: 'center', offset: [5, 0, -2] },
  });
  assert.close((stock.min[0] + stock.max[0]) / 2, 15, 1e-6, 'shifted 5mm in X');
  assert.close(stock.max[2], 8, 1e-6, 'and dropped 2mm in Z');
});

test('cylinder stock reports a square bounding box and a round outline', () => {
  // a 20×20×10 part centred at (10, 10), in Ø40 × 25 bar
  const stock = computeStock([makeBox(20, 20, 10)], {
    kind: 'cylinder', cylinder: { diameter: 40, height: 25, align: 'center' },
  });
  assert.close(stock.min[0], -10, 1e-6, 'bbox min X');
  assert.close(stock.max[0], 30, 1e-6, 'bbox max X');
  assert.close(stock.max[2], 10, 1e-6, 'top of the bar meets the top of the part');

  const [loop] = stockOutline(stock, 0);
  const b = loopsBounds([loop]);
  assert.close(b.max[0], 30, 0.05, 'outline reaches the rim');
  // every point sits on the circle, which a box outline would not
  for (let i = 0; i < loop.length; i += 2) {
    assert.close(Math.hypot(loop[i] - 10, loop[i + 1] - 10), 20, 0.05, 'on the rim');
  }
});

test('stockOutline grows by the tool radius', () => {
  const stock = computeStock([makeBox(20, 20, 10)], { kind: 'box-margin', margin: [0, 0, 0] });
  const b = loopsBounds(stockOutline(stock, 3));
  assert.close(b.min[0], -3, 1e-6);
  assert.close(b.max[0], 23, 1e-6);
});

// --- orientation ---

test('rotationMatrix turns +Z into -Z for a 180° X flip', () => {
  const m = rotationMatrix([180, 0, 0]);
  const v = applyMatrix(m, [0, 0, 1]);
  assert.close(v[2], -1, 1e-9, 'Z flipped');
});

test('flipping a setup puts the model bottom on top', () => {
  const mesh = makeBox(20, 20, 10);
  const flipped = transformMesh(mesh, rotationMatrix([180, 0, 0]));
  const b = computeBounds(flipped.positions);
  assert.close(b.min[2], -10, 1e-5, 'was the top, now the bottom');
  assert.close(b.max[2], 0, 1e-5);
});

test('origin mode lands the chosen datum on zero', () => {
  const setup = { ...createSetup(), stock: { ...createStock(), margin: [0, 0, 0] } };
  const meshes = [makeBox(20, 30, 10)];

  setup.orientation = { rotationDeg: [0, 0, 0], origin: 'stock-top-center' };
  let out = resolveSetup(setup, meshes, computeStock);
  assert.close(out.stock.max[2], 0, 1e-6, 'top at Z0');
  assert.close((out.stock.min[0] + out.stock.max[0]) / 2, 0, 1e-6, 'centred in X');

  setup.orientation = { rotationDeg: [0, 0, 0], origin: 'stock-top-min' };
  out = resolveSetup(setup, meshes, computeStock);
  assert.close(out.stock.min[0], 0, 1e-6, 'corner at X0');
  assert.close(out.stock.min[1], 0, 1e-6, 'corner at Y0');
  assert.close(out.stock.max[2], 0, 1e-6, 'top at Z0');

  setup.orientation = { rotationDeg: [0, 0, 0], origin: 'stock-bottom-min' };
  out = resolveSetup(setup, meshes, computeStock);
  assert.close(out.stock.min[2], 0, 1e-6, 'bottom at Z0');
});

test('resolveSetup returns meshes in the same frame as the stock', () => {
  const setup = {
    ...createSetup(),
    stock: { ...createStock(), margin: [0, 0, 0] },
    orientation: { rotationDeg: [180, 0, 0], origin: 'stock-top-center' },
  };
  const { meshes, stock } = resolveSetup(setup, [makeBox(20, 30, 10)], computeStock);
  const b = computeBounds(meshes[0].positions);
  assert.close(b.max[2], stock.max[2], 1e-5, 'mesh top matches stock top');
  assert.close(b.max[2], 0, 1e-5, 'and sits on the datum');
});

// --- project migration ---

test('a v1 project migrates to the current schema without losing settings', () => {
  const v1 = JSON.stringify({
    version: 1, name: 'old', units: 'mm', models: [], tools: [],
    setups: [{
      id: 's1', name: 'Setup 1', wcs: 'G55',
      stock: { kind: 'box-margin', margin: [2, 2, 2], explicit: null },
      modelIds: [],
      operations: [{ id: 'o1', type: 'contour2d', name: 'c', enabled: true, toolId: null, geometry: [], params: { topZ: 3, bottomZ: -4 } }],
    }],
  });
  const p = deserializeProject(v1);
  assert.eq(p.version, PROJECT_VERSION, 'version bumped');
  assert.eq(p.setups[0].wcs, 'G55', 'kept wcs');
  assert.close(p.setups[0].stock.margin[0], 2, 1e-9, 'kept margin');
  // pre-orientation projects were authored in model coordinates, so migrating
  // must not silently move the part
  assert.eq(p.setups[0].orientation.origin, 'model', 'no datum shift introduced');
  const op = p.setups[0].operations[0];
  assert.close(op.params.topZ, 3, 1e-9, 'kept explicit params');
  assert.eq(op.params.direction, 'climb', 'gained new defaults');
  assert.ok(Array.isArray(op.regions.avoid), 'gained regions');
});

// --- work offsets ---

test('the post states the setup work offset once, and again when it changes', () => {
  const cl = generateToolpath({
    type: 'contour2d', name: 'c', tool: { number: 1, diameter: 6, spindleRpm: 9000, feedCut: 700, feedPlunge: 200 },
    mesh: makeBox(20, 20, 10),
    params: { topZ: 10, bottomZ: 0, stepdown: 5, clearanceHeight: 20, tolerance: 0.05, rampAngle: 0, leadType: 'none' },
  });
  const { text } = buildGcode('linuxcnc', [
    { name: 'a', cl, wcs: 'G54' },
    { name: 'b', cl, wcs: 'G54' },
    { name: 'c', cl, wcs: 'G55' },
  ], { programName: 'wcs test' });

  const lines = text.split('\n').map((l) => l.trim());
  assert.eq(lines.filter((l) => l === 'G54').length, 1, 'stated once while it holds');
  assert.eq(lines.filter((l) => l === 'G55').length, 1, 'restated when it changes');
  assert.ok(lines.indexOf('G54') < lines.indexOf('G55'), 'in program order');
});

test('an op with no work offset emits none', () => {
  const cl = generateToolpath({
    type: 'contour2d', name: 'c', tool: { number: 1, diameter: 6, spindleRpm: 9000, feedCut: 700, feedPlunge: 200 },
    mesh: makeBox(20, 20, 10),
    params: { topZ: 10, bottomZ: 0, stepdown: 5, clearanceHeight: 20, tolerance: 0.05, rampAngle: 0, leadType: 'none' },
  });
  const { text } = buildGcode('linuxcnc', [{ name: 'a', cl }], {});
  assert.ok(!/^G5[4-9]$/m.test(text), 'no work offset invented');
});

/** One short square pass, the same one twice, so only the joins differ. */
function squarePass() {
  return generateToolpath({
    type: 'contour2d', name: 'c', tool: { number: 1, diameter: 6, spindleRpm: 9000, feedCut: 700, feedPlunge: 200 },
    mesh: makeBox(20, 20, 10),
    params: { topZ: 10, bottomZ: 0, stepdown: 5, clearanceHeight: 20, tolerance: 0.05, rampAngle: 0, leadType: 'none' },
  });
}

/** The first motion block after `from`, whatever letters survived modality. */
function firstMoveAfter(text, from) {
  const lines = text.split('\n').map((l) => l.trim());
  return lines.slice(lines.indexOf(from) + 1).find((l) => /^(G0|G1|[XYZ])/.test(l));
}

test('a work offset change restates every axis, because the numbers moved under them', () => {
  // Modal words are numbers in *some* coordinate system, and G55 changes which
  // one. Two setups sharing a cutter — rough the top, flip, rough the bottom —
  // wrote `G55` and then a bare `X10`: Y and Z happened to match the last block
  // of the previous offset, so they were dropped, and the machine held a Y and
  // a Z that now mean somewhere else entirely. The next block plunged there.
  const cl = squarePass();
  const { text } = buildGcode('linuxcnc', [
    { name: 'a', cl, wcs: 'G54' },
    { name: 'b', cl, wcs: 'G55' },
  ], { programName: 'restated' });

  const move = firstMoveAfter(text, 'G55');
  assert.ok(/X/.test(move) && /Y/.test(move) && /Z/.test(move),
    `the first block in a new offset states X, Y and Z — got "${move}"`);
});

test('crossing into another setup stops the program so the part can be re-fixtured', () => {
  // Generate and Export both span every setup on the machine, and the file ran
  // straight from the last operation of one into the first of the next —
  // through the moment the part is supposed to come out and be turned over.
  // A second *setup* is the signal, not a second work offset: every setup the
  // app makes starts on G54, so two of them wrote no marker at all.
  const cl = squarePass();
  const { text } = buildGcode('linuxcnc', [
    { name: 'a', cl, wcs: 'G54', setup: 's1', setupName: 'Setup 1' },
    { name: 'b', cl, wcs: 'G54', setup: 's2', setupName: 'Setup 2' },
  ], { programName: 'two setups' });
  const lines = text.split('\n').map((l) => l.trim());

  assert.eq(lines.filter((l) => l === 'M0').length, 1, 'one stop, at the one boundary');
  assert.ok(lines.some((l) => /re-fixture the part for Setup 2/.test(l)),
    'and it says what it is waiting for');
  assert.ok(lines.indexOf('M5') < lines.indexOf('M0'),
    'the spindle is stopped before the operator is asked to reach in');
  const move = firstMoveAfter(text, 'M0');
  assert.ok(/X/.test(move) && /Y/.test(move) && /Z/.test(move),
    `nothing about where the tool is survives an operator — got "${move}"`);

  // and one setup's worth of operations is still one uninterrupted program
  const { text: single } = buildGcode('linuxcnc', [
    { name: 'a', cl, wcs: 'G54', setup: 's1', setupName: 'Setup 1' },
    { name: 'b', cl, wcs: 'G54', setup: 's1', setupName: 'Setup 1' },
  ], { programName: 'one setup' });
  assert.ok(!/^M0$/m.test(single), 'two operations in one fixturing do not stop');
});

test('an operation that cuts nothing does not use up the setup boundary', () => {
  // A drill that matched no hole writes its comment and touches nothing else
  // (see post/core.js `silent`). If it were allowed to claim the boundary, the
  // first operation that really cuts in the new fixturing would start with the
  // part still clamped the old way round.
  const cl = squarePass();
  const empty = generateToolpath({
    type: 'drill', name: 'no holes',
    tool: { number: 9, type: 'drill', diameter: 3, spindleRpm: 3000, feedCut: 300, feedPlunge: 100 },
    mesh: makeBox(20, 20, 10),
    params: { topZ: 10, bottomZ: 0, diameterTol: 0.01, clearanceHeight: 20 },
  });
  assert.eq(empty.count, 0, 'the fixture really does produce no motion');

  const { text } = buildGcode('linuxcnc', [
    { name: 'a', cl, wcs: 'G54', setup: 's1', setupName: 'Setup 1' },
    { name: 'dud', cl: empty, wcs: 'G55', setup: 's2', setupName: 'Setup 2' },
    { name: 'b', cl, wcs: 'G55', setup: 's2', setupName: 'Setup 2' },
  ], { programName: 'silent' });
  const lines = text.split('\n').map((l) => l.trim());

  assert.eq(lines.filter((l) => l === 'M0').length, 1, 'still exactly one stop');
  assert.ok(lines.indexOf('M0') < lines.indexOf('G55'), 'before the new datum is selected');
  assert.ok(lines.indexOf('(operation: b)') < lines.indexOf('M0'),
    'and inside the operation that actually cuts, not the one that did nothing');
});

// --- tool library ---

test('presets materialise into complete tools', () => {
  const presets = allPresets();
  assert.ok(presets.length > 5, 'library is populated');
  for (const preset of presets) {
    const tool = toolFromPreset(preset, 4);
    assert.eq(tool.number, 4);
    assert.ok(tool.diameter > 0, `${preset.name} has a diameter`);
    assert.ok(tool.feedCut > 0, `${preset.name} has a feed`);
    // A lathe tool has no collet shank and no spindle holder. Inventing one for
    // it is what drew every insert as a revolved end mill, so the absence is
    // the assertion here rather than an exception to it.
    if (machineForType(tool.type) === 'turn') {
      assert.eq(tool.shank.length, 0, `${preset.name} is a lathe tool, so it has no shank`);
      assert.ok(tool.insertIc > 0 || tool.bladeWidth > 0,
        `${preset.name} says what its insert or blade is`);
    } else {
      assert.ok(tool.shank[0].diameter >= tool.diameter, `${preset.name} shank fits the cutter`);
    }
  }
});

test('tool library round-trips through JSON and re-ids on import', () => {
  const tools = [toolFromPreset({ name: 'a', type: 'flat', diameter: 6 }, 1)];
  const back = deserializeLibrary(serializeLibrary(tools));
  assert.eq(back.length, 1);
  assert.eq(back[0].name, 'a');
  assert.eq(back[0].diameter, 6);
  assert.ok(back[0].id !== tools[0].id, 'imported tools get fresh ids');
});

test('a bare array is accepted as a library, junk is rejected', () => {
  assert.eq(deserializeLibrary('[{"name":"x","type":"ball","diameter":4}]').length, 1);
  assert.throws(() => deserializeLibrary('{"nope":1}'));
});

test("a tube's bore is a hole in the stock footprint", () => {
  // Nothing inside the bore is material, which is exactly what the panel's own
  // field says the number is for — and every milling strategy asks this function
  // where the stock is. Left out, roughing rastered back and forth across the
  // hole cutting air and the simulation showed a solid disc.
  const stock = computeStock([makeBox(20, 20, 10)], {
    kind: 'tube', cylinder: { diameter: 100, innerDiameter: 40, height: 25, align: 'center' },
  });
  const loops = stockOutline(stock, 0);
  assert.eq(loops.length, 2, 'the rim and the bore');
  assert.ok(loopArea(loops[0]) > 0, 'the rim is wound one way');
  assert.ok(loopArea(loops[1]) < 0, 'and the bore the other, which is what makes it a hole');
  assert.close(Math.abs(loopArea(loops[1])), Math.PI * 20 * 20, 5, 'the bore is its own size');

  // both edges are edges the cutter may hang over, by the same amount
  const grown = stockOutline(stock, 6);
  assert.close(Math.abs(loopArea(grown[1])), Math.PI * 14 * 14, 4, 'the bore shrinks by the growth');
  assert.ok(loopArea(grown[0]) > loopArea(loops[0]), 'while the rim grows');

  // a bore the cutter simply covers is not an edge at all
  const narrow = computeStock([makeBox(20, 20, 10)], {
    kind: 'tube', cylinder: { diameter: 100, innerDiameter: 8, height: 25, align: 'center' },
  });
  assert.eq(stockOutline(narrow, 6).length, 1, 'a ⌀8 bore is nothing to a ⌀12 cutter');

  // and solid bar is unchanged
  const bar = computeStock([makeBox(20, 20, 10)], {
    kind: 'cylinder', cylinder: { diameter: 100, height: 25, align: 'center' },
  });
  assert.eq(stockOutline(bar, 0).length, 1);
});

test('a facing pass over round stock does not raster the corners of its bounding box', () => {
  const stock = computeStock([makeBox(20, 20, 10)], {
    kind: 'tube', cylinder: { diameter: 100, innerDiameter: 40, height: 25, align: 'center' },
  });
  const tool = { number: 1, type: 'flat', diameter: 12, fluteLength: 30 };
  const cl = generateToolpath({
    type: 'face', name: 'face', tool, stock, mesh: makeBox(20, 20, 10),
    params: {
      topZ: stock.max[2], bottomZ: stock.max[2] - 1, stepdown: 2, stepover: 0.6,
      clearanceHeight: stock.max[2] + 10, entryGap: 1, tolerance: 0.01, angleDeg: 0,
    },
  });
  // rows used to span the full square bounds whenever no region was picked, so
  // the pass drove through four corners of air and straight over the bore
  const centre = [(stock.min[0] + stock.max[0]) / 2, (stock.min[1] + stock.max[1]) / 2];
  const overrun = tool.diameter / 2 + 1;
  let previous = null;
  const d = cl.moves;
  for (let n = 0; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    const p = [d[o + 1], d[o + 2]];
    if (previous && d[o] !== OP.RAPID) {
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        const r = Math.hypot(previous[0] + (p[0] - previous[0]) * t - centre[0],
          previous[1] + (p[1] - previous[1]) * t - centre[1]);
        // the outline is a 96-gon, so a chord sits a hundredth inside the circle
        assert.ok(r <= 50 + overrun + 0.05, `a cut ran ${r.toFixed(2)}mm out on a ⌀100 bar`);
        assert.ok(r >= 20 - overrun - 0.05, `a cut ran ${r.toFixed(2)}mm in, inside a ⌀40 bore`);
      }
    }
    previous = p;
  }
});
