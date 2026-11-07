// A cut the tool is too short for: found before it runs, found where it happens, and
// reported with the numbers that fix it.

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { simulateRemoval, positionAtStep, collisionAt } from '../engine/simulate.js';
import { makePocketBlock } from './fixtures.js';
import { opCollisionRisk, opPreflight } from '../app/op-status.js';
import { createOperation, createTool } from '../doc/schema.js';

// a flute of 10, a shank of 20 at the cutter's own width, then a holder 25 wide
const SHORT = {
  number: 1, type: 'flat', diameter: 6, fluteLength: 10, spindleRpm: 10000, feedCut: 800, feedPlunge: 300,
  shank: [{ diameter: 6, length: 20 }], holder: [{ diameter: 25, length: 40 }],
};

function deepPocket(depth) {
  const { mesh } = makePocketBlock({ size: 40, pocketSize: 20, height: 40, depth });
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 40] };
  const cl = generateToolpath({
    type: 'pocket', name: 'p', tool: SHORT, mesh, stock,
    params: {
      ...defaultParamsFor('pocket', { stock, tool: SHORT }),
      topZ: 40, bottomZ: 40 - depth, stepdown: 3, clearanceHeight: 50, stepover: 0.5,
    },
  });
  return { sim: simulateRemoval({ stock, ops: [{ cl, tool: SHORT }], maxCells: 60_000 }), stock };
}

test('a pocket the holder cannot go down is found by the simulation, with where each collision is', () => {
  const { sim } = deepPocket(36);
  assert.ok(sim.bodyCut.count > 0, 'the holder is in the metal');
  const holder = sim.findings.filter((f) => f.kind === 'holder');
  assert.ok(holder.length > 0, 'and each is a finding');
  for (const f of holder) {
    assert.ok(Array.isArray(f.at) && f.at.length === 3, 'with the metal it is in, to put a marker on');
    assert.ok(f.at[2] > 20, `the rim of the pocket, high up: ${f.at}`);
    assert.ok(f.depth > 0);
  }
});

test('a pocket within the tool\'s reach has none', () => {
  const { sim } = deepPocket(28);
  assert.eq(sim.bodyCut.count, 0);
  assert.eq(sim.findings.filter((f) => f.kind === 'holder').length, 0);
});

test('the playhead knows when it is inside a collision', () => {
  const { sim } = deepPocket(36);
  const hit = sim.findings.find((f) => f.kind === 'holder');
  assert.ok(collisionAt(sim, hit.step), 'at the step it was found');
  assert.eq(collisionAt(sim, 0), null, 'and not at the start');
  const at = positionAtStep(sim, [{ tool: SHORT }], hit.step);
  assert.ok(at.collision && at.collision.kind === 'holder', 'the cutter state says so, for the red glow');
  assert.eq(positionAtStep(sim, [{ tool: SHORT }], 0).collision, null);
});

function documentWith(tool, params) {
  const op = createOperation('pocket');
  op.toolId = tool.id;
  Object.assign(op.params, params);
  return { doc: { project: { tools: [tool], setups: [] }, findSetupOf: () => null }, op };
}

test('too deep for the tool is a risk with the numbers that fix it, before anything is generated', () => {
  const tool = Object.assign(createTool('flat'), SHORT);
  const { doc, op } = documentWith(tool, { topZ: 40, bottomZ: 4 });
  const risk = opCollisionRisk(doc, op);
  assert.ok(risk, 'it is a risk');
  assert.eq(risk.kind, 'holder');
  assert.close(risk.maxDepth, 30, 1e-6, 'the tool reaches 30mm: flute and shank');
  assert.close(risk.bottomZ, 10, 1e-6, 'so the deepest Bottom Z is 10');
  assert.ok(opPreflight(doc, op).includes(risk.text), 'and the preflight still says it');
});

test('within the reach there is no risk, and a lathe tool is not asked', () => {
  const tool = Object.assign(createTool('flat'), SHORT);
  const { doc, op } = documentWith(tool, { topZ: 40, bottomZ: 15 });
  assert.eq(opCollisionRisk(doc, op), null);
  const insert = createTool('turning');
  const turned = documentWith(insert, { topZ: 40, bottomZ: 4 });
  assert.eq(opCollisionRisk(turned.doc, turned.op), null);
});
