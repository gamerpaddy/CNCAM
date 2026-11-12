// Feature recognition: what the part says it has, and the operations proposed
// for it. The parts are the round-numbered samples, so every count and size is a
// fact about the part and not about the answer: a hole plate with four 6mm holes,
// a 10mm, a 20mm and a blind 8mm; a step plate with one 36 x 20 pocket.
//
// Each proposal is then *generated* — the point of recognising a pocket is that
// the pocket strategy cuts it, not that a label said so.

import { test, assert } from './runner.js';
import { parseSTL } from '../io/stl.js';
import { meshFromSoup, computeBounds } from '../geom/mesh.js';
import { loadSampleBuffer } from './samples.js';
import { recogniseFeatures, inscribedDiameter, MILL_SIZES } from '../engine/features.js';
import { toolForSpec, millSizeFor } from '../doc/feature-tools.js';
import { createTool } from '../doc/schema.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { generateToolpath } from '../engine/toolpath.js';
import { OP, MOVE_STRIDE } from '../engine/cl.js';
import { makePocketAndHole } from './fixtures.js';

async function sample(name, margin = 1) {
  const mesh = meshFromSoup(parseSTL(await loadSampleBuffer(name)));
  const b = computeBounds(mesh.positions);
  const stock = { kind: 'box', min: [b.min[0] - margin, b.min[1] - margin, b.min[2]], max: [b.max[0] + margin, b.max[1] + margin, b.max[2] + margin] };
  return { mesh, stock, bounds: b };
}

const byId = (r, id) => r.proposals.find((p) => p.id === id);

test('a plate of holes: every size found, counted and told through from blind', async () => {
  const { mesh, stock } = await sample('test-hole-plate.stl');
  const r = recogniseFeatures(mesh, { stock });
  const d6 = byId(r, 'drill-6');
  assert.ok(d6 && /4 × ⌀6 \(through\)/.test(d6.label), d6?.label);
  assert.ok(/1 × ⌀8 \(blind\)/.test(byId(r, 'drill-8').label), byId(r, 'drill-8')?.label);
  assert.ok(/1 × ⌀10 \(through\)/.test(byId(r, 'drill-10').label));
  assert.ok(byId(r, 'bore-20'), 'a 20mm hole is bored, not drilled');
  assert.ok(!byId(r, 'drill-20'));
  // each drill op takes only its own size
  assert.ok(byId(r, 'drill-6').params.diameterTol <= 0.1);
  // the spot operation takes every hole, the 20mm one included, and says so
  assert.ok(/Spot the 7 holes/.test(byId(r, 'spot').label), byId(r, 'spot').label);
  assert.ok(/large one is only marked/.test(byId(r, 'spot').detail), byId(r, 'spot').detail);
  assert.eq(r.proposals.filter((p) => p.opType === 'drill').length, 3);
});

test('a plate with billet round it is faced and has its outline cut, in running order', async () => {
  const { mesh, stock } = await sample('test-hole-plate.stl', 2);
  const r = recogniseFeatures(mesh, { stock });
  const order = r.proposals.map((p) => p.opType);
  assert.eq(order[0], 'face');
  assert.eq(order[order.length - 1], 'contour2d', 'the outline frees the part, so it is last');
  assert.ok(order.indexOf('spot') < order.indexOf('drill'), 'spot before drill');
  assert.ok(/2 mm of billet/.test(byId(r, 'outline').label), byId(r, 'outline').label);
  assert.ok(/1 mm|2 mm/.test(byId(r, 'face').label));
  // with no stock there is nothing to face and nothing to cut round
  const bare = recogniseFeatures(mesh, {});
  assert.ok(!byId(bare, 'face') && !byId(bare, 'outline'));
  // and a stock exactly the part size has neither
  const b = computeBounds(mesh.positions);
  const exact = recogniseFeatures(mesh, { stock: { min: b.min, max: b.max } });
  assert.ok(!byId(exact, 'face') && !byId(exact, 'outline'));
});

test('a pocket is found with its floor and the narrowest width that limits the cutter', async () => {
  const { mesh, stock } = await sample('test-step-plate.stl');
  const r = recogniseFeatures(mesh, { stock });
  const pocket = byId(r, 'pocket');
  assert.ok(pocket, 'one pocket');
  assert.ok(/down to Z15/.test(pocket.label), pocket.label);
  // the pocket is 36 x 20 (x 32..68, y 25..45): 20 across at its narrowest
  assert.close(inscribedDiameter([32, 25, 68, 25, 68, 45, 32, 45]), 20, 0.1);
  assert.ok(Math.abs(pocket.toolSpec.maxDiameter - 18) < 0.3, `a cutter no wider than 90% of it: ${pocket.toolSpec.maxDiameter}`);
  assert.ok(!r.proposals.some((p) => p.opType === 'drill'), 'a plate with a pocket and no holes has no drills');
});

test('a hole the size of a tapping drill offers the tap, switched off', () => {
  const { mesh } = makePocketAndHole({ holeR: 2.5 });
  const r = recogniseFeatures(mesh, { stock: null });
  const tap = byId(r, 'tap-M6');
  assert.ok(tap, 'a 5.0mm hole is the M6x1 tapping drill');
  assert.eq(tap.enabled, false, 'and it is only offered');
  assert.eq(tap.toolSpec.pitch, 1);
  assert.ok(byId(r, 'drill-5').enabled, 'the drill is on');
  // an M8 is 6.75
  const m8 = recogniseFeatures(makePocketAndHole({ holeR: 3.375 }).mesh, { stock: null });
  assert.ok(byId(m8, 'tap-M8'), 'a 6.75mm hole');
  // 6.0 is no tapping drill
  assert.ok(!recogniseFeatures(makePocketAndHole({ holeR: 3 }).mesh, {}).proposals.some((p) => p.opType === 'tap'));
});

test('no part, and nothing on the part, are told, not thrown', () => {
  const none = recogniseFeatures(null, {});
  assert.eq(none.proposals.length, 0);
  assert.ok(none.warnings.length > 0);
  const empty = recogniseFeatures({ positions: new Float32Array(0), indices: new Uint32Array(0) }, {});
  assert.eq(empty.proposals.length, 0);
});

test('the cutter for a proposal is the rack one when the rack has it, and a new one, numbered clear, when it has not', () => {
  const rack = [
    Object.assign(createTool('drill'), { number: 3, diameter: 6, tipAngle: 118 }),
    Object.assign(createTool('flat'), { number: 5, diameter: 10 }),
    Object.assign(createTool('flat'), { number: 7, diameter: 3 }),
  ];
  const have = toolForSpec({ family: 'drill', diameter: 6 }, rack);
  assert.ok(!have.created && have.tool === rack[0]);
  const made = toolForSpec({ family: 'drill', diameter: 8 }, rack, { material: 'aluminium' });
  assert.ok(made.created);
  assert.eq(made.tool.type, 'drill');
  assert.eq(made.tool.diameter, 8);
  assert.eq(made.tool.number, 8, 'one past the highest number in use');
  assert.ok(/8mm drill/.test(made.tool.name));
  assert.ok(made.tool.spindleRpm > 0 && made.tool.feedCut > 0);
  // steel is slower than aluminium for the same drill
  assert.ok(toolForSpec({ family: 'drill', diameter: 8 }, rack, { material: 'stainless' }).tool.spindleRpm < made.tool.spindleRpm);
  // an end mill: the largest that fits
  assert.eq(toolForSpec({ family: 'flat', maxDiameter: 12 }, rack).tool, rack[1]);
  assert.eq(toolForSpec({ family: 'flat', maxDiameter: 5 }, rack).tool, rack[2], 'the 10 is too wide');
  const newMill = toolForSpec({ family: 'flat', maxDiameter: 2.4 }, rack);
  assert.ok(newMill.created && newMill.tool.diameter === 2, `a 2mm end mill, got ${newMill.tool.diameter}`);
  // taps are by thread, not by diameter alone
  const tap = toolForSpec({ family: 'tap', nominal: 6, pitch: 1 }, rack);
  assert.ok(tap.created && tap.tool.type === 'tap' && tap.tool.pitch === 1 && /M6/.test(tap.tool.name), tap.tool.name);
  assert.eq(millSizeFor(7), 6);
  assert.eq(millSizeFor(0.2), MILL_SIZES[0]);
});

/** Generate a proposal with the tool it would get and report what it did. */
function generate(proposal, mesh, stock, tool) {
  const params = { ...defaultParamsFor(proposal.opType, { stock, tool }), ...proposal.params };
  return generateToolpath({ type: proposal.opType, name: proposal.id, tool, mesh, stock, params });
}

function countDrills(cl) {
  let n = 0;
  for (let i = 0; i < cl.count; i++) if (cl.moves[i * MOVE_STRIDE] === OP.DRILL) n++;
  return n;
}

test('every proposed operation cuts what it was proposed for, and nothing warns that it found nothing', async () => {
  for (const [file, expectDrills] of [['test-hole-plate.stl', { 'drill-6': 4, 'drill-8': 1, 'drill-10': 1, spot: 7 }], ['test-step-plate.stl', {}]]) {
    const { mesh, stock } = await sample(file, 2);
    const r = recogniseFeatures(mesh, { stock });
    let rack = [];
    for (const p of r.proposals) {
      if (!p.enabled) continue;
      const got = toolForSpec(p.toolSpec, rack, { material: 'aluminium' });
      if (got.created) rack = [...rack, got.tool];
      const cl = generate(p, mesh, stock, got.tool);
      assert.ok(cl.count > 0, `${file}: ${p.id} produced no moves — ${cl.notes.map((n) => n.text).join(' | ')}`);
      const bad = cl.notes.filter((n) => n.level === 'warn' && /no round holes|no .* matches|found nothing|no pocket|nothing to/i.test(n.text));
      assert.eq(bad.length, 0, `${file}: ${p.id} warns ${bad.map((n) => n.text).join(' | ')}`);
      if (p.id in expectDrills) {
        assert.eq(countDrills(cl), expectDrills[p.id], `${file}: ${p.id} drills ${countDrills(cl)}`);
      }
    }
  }
});

// A real STEP file, through the same OpenCASCADE build the app loads, in Node. A
// cube has no holes and no pockets, so what is proposed must be only what the
// stock round it asks for — a recogniser that invents a feature on a plain cube
// is the failure this watches for.
test('a STEP cube read by OpenCASCADE has no features invented on it', async () => {
  if (typeof process === 'undefined' || !process.versions?.node) return;   // the browser has its own worker
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const require = createRequire(import.meta.url);
  const dir = fileURLToPath(new URL('../../vendor/occt/', import.meta.url));
  const source = readFileSync(`${dir}occt-import-js.js`, 'utf8');
  const factory = new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', `${source};return occtimportjs;`);
  const occt = await factory(require, { exports: {} }, {}, dir, `${dir}occt-import-js.js`, process)({
    locateFile: (f) => dir + f, wasmBinary: readFileSync(`${dir}occt-import-js.wasm`),
  });
  const result = occt.ReadStepFile(new Uint8Array(await loadSampleBuffer('cube.stp')), {
    linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.05, angularDeflection: 0.5,
  });
  assert.ok(result.success && result.meshes.length === 1, 'the file read');
  const m = result.meshes[0];
  const mesh = { positions: new Float32Array(m.attributes.position.array), indices: new Uint32Array(m.index.array) };
  const b = computeBounds(mesh.positions);
  assert.close(b.max[2] - b.min[2], 300, 1e-3, 'a 300mm cube');
  const r = recogniseFeatures(mesh, { stock: { min: [b.min[0] - 1, b.min[1] - 1, b.min[2]], max: [b.max[0] + 1, b.max[1] + 1, b.max[2] + 1] } });
  assert.eq(JSON.stringify(r.proposals.map((p) => p.opType)), '["face","contour2d"]');
});
