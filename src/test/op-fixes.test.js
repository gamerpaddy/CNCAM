// A message about an operation is read for where to change it and what to press.
// These hold the reading to the panel it points into: a place that names a tab
// the field is not on, or a fix that changes nothing, is worse than no advice.

import { test, assert } from './runner.js';
import { adviceFor, placeOf } from '../app/op-fixes.js';
import { OP_PARAM_GROUPS, paramApplies } from '../app/op-params.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { constrainHeights } from '../engine/heights.js';

const stock = { min: [0, 0, 0], max: [50, 40, 20] };
const opOf = (type, patch = {}) => ({
  id: 'op1', type, toolId: 't1', enabled: true,
  params: { ...defaultParamsFor(type, { stock, modelBounds: stock }), ...patch },
});
const doc = {
  project: { tools: [{ id: 't1', name: '6mm ball', number: 1 }], setups: [] },
  findSetupOf: () => ({ fixtures: [{ id: 'f1', name: 'Vice' }] }),
};

test('op fixes: a field is found on the tab the panel puts it on', () => {
  const op = opOf('finish5');
  const place = placeOf(op, 'maxTilt');
  assert.eq(place.tab, 'strategy');
  assert.eq(place.tabLabel, 'Passes');
  assert.eq(place.label, 'Never more than', 'the unit in brackets is left off');
  assert.eq(placeOf(op, 'clearanceHeight').tab, 'heights');
  // a field the strategy does not have is no place at all
  assert.eq(placeOf(opOf('drill'), 'maxTilt'), null);
  // and every place named is a field that is really shown
  for (const key of ['maxTilt', 'stepover', 'tolerance', 'topZ', 'bottomZ']) {
    const where = placeOf(op, key);
    const group = OP_PARAM_GROUPS.find((g) => g.tab === where.tab
      && g.fields.some((f) => f.key === key && paramApplies(f, op)));
    assert.ok(group, `${key} is on ${where.tab}`);
  }
});

test('op fixes: a 5-axis holder collision offers less lean, and says where the lean is', () => {
  const op = opOf('finish5', { maxTilt: 45 });
  const { where, fixes } = adviceFor(doc, op,
    '5-axis finish: shank or holder collision at X1.000 Y2.000 Z3.000 after orientation adjustment; '
    + 'use a longer tool or restrict the machining region');
  assert.eq(fixes[0].patch.maxTilt, 23, 'half the lean');
  assert.eq(fixes[1].patch.maxTilt, 0, 'or none');
  assert.ok(where.some((w) => w.key === 'maxTilt' && w.tab === 'strategy'));
  assert.ok(where.some((w) => /^Tool › 6mm ball/.test(w.label) && typeof w.run === 'function'),
    'the cutter is not on the operation, and is still somewhere to go');
  // already upright: there is no lean left to take off, so it is not offered
  const upright = adviceFor(doc, opOf('finish5', { maxTilt: 0 }), 'shank or holder collision');
  assert.eq(upright.fixes.length, 0);
});

test('op fixes: a sample budget offers a wider stepover and a looser tolerance', () => {
  const op = opOf('finish5', { stepover: 0.05, tolerance: 0.01 });
  const { where, fixes } = adviceFor(doc, op,
    '5-axis finish exceeds sample budget; increase stepover or tolerance');
  assert.eq(fixes[0].patch.stepover, 0.1);
  assert.eq(fixes[1].patch.tolerance, 0.02);
  assert.eq(where.map((w) => w.key).join(), 'stepover,tolerance');
});

test('op fixes: a field that is not a number is pointed at by name, and can be cleared', () => {
  const op = opOf('finish5', { pattern: 'concentric', patternCenterX: NaN });
  const { where, fixes } = adviceFor(doc, op,
    'the setting patternCenterX is not a number — set it before generating');
  assert.ok(where.some((w) => w.key === 'patternCenterX'), 'the field is found from its key');
  assert.eq(fixes[0].patch.patternCenterX, null);
});

test('op fixes: clearance under a clamp is lifted over it in one press', () => {
  const op = opOf('pocket', { clearanceHeight: 10 });
  const { fixes, where } = adviceFor(doc, op,
    'Clearance is Z10 and Jaw stands to Z32.5 — a rapid at clearance goes through it.');
  assert.eq(fixes[0].patch.clearanceHeight, 37.5);
  assert.ok(where.some((w) => w.key === 'clearanceHeight' && w.tab === 'heights'));
});

test('op fixes: any message is read for the fields it names', () => {
  const op = opOf('pocket', { rampAngle: 0 });
  const ramp = adviceFor(doc, op, 'ramp angle is 0, so every pass enters by plunging into a full-width cut');
  assert.ok(ramp.where.some((w) => w.key === 'rampAngle' && w.tab === 'entry'));
  assert.eq(ramp.fixes[0].patch.rampAngle, 3);
  const depth = adviceFor(doc, opOf('slot'), 'the slot has no depth — Top Z is the surface and Bottom Z is its floor');
  assert.eq(depth.where.filter((w) => w.key === 'topZ' || w.key === 'bottomZ').length, 2);
  // one that asks for nothing gets nothing
  const plain = adviceFor(doc, op, '5-axis finishing leans the cutter 18.0° on average');
  assert.eq(plain.fixes.length, 0);
  // a crash into a fixture points at the fixture
  const crash = adviceFor(doc, op, 'the tool goes 2.0mm into Vice (4 moves, deepest near X1 Y2 Z3). Move the fixture');
  assert.ok(crash.where.some((w) => /^Fixture › Vice/.test(w.label)));
});

test('raising the top of the cut keeps the room clearance had over it', () => {
  const { patch } = constrainHeights({ topZ: 0, bottomZ: -10, clearanceHeight: 10 }, 'topZ', 30);
  assert.eq(patch.clearanceHeight, 40, 'ten over the old top is ten over the new one');
  // one that had no room to keep is given some: a micron over the top is no clearance
  const flat = constrainHeights({ topZ: 0, bottomZ: -10, clearanceHeight: 0 }, 'topZ', 5);
  assert.eq(flat.patch.clearanceHeight, 15);
});
