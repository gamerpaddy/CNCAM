// What the stock is made of: the material table, the speeds it suggests, the
// chip thinning of a light cut, the power a cut takes, and that none of it moves
// a toolpath. Every figure that can be worked out by hand is worked out by hand
// here, so the table is checked against arithmetic and not against itself.

import { test, assert } from './runner.js';
import {
  MATERIALS, DEFAULT_MATERIAL, materialOf, isMaterialId, chipThinningFactor, cuttingPowerKw, removalRate, speedKindOf,
} from '../doc/materials.js';
import { suggestCutting } from '../doc/tool-library.js';
import { createProject, createSetup, createTool, createOperation, serializeProject, deserializeProject } from '../doc/schema.js';
import { createMachine, MACHINE_PRESETS } from '../doc/machines.js';
import { Document } from '../doc/document.js';
import { opFingerprint } from '../app/op-status.js';
import { cutCheck, cutWidths } from '../engine/cut-check.js';

const FAMILIES = ['flat', 'ball', 'bull', 'face', 'chamfer', 'drill', 'spot', 'tap', 'threadmill'];

test('every material is a usable record, and an unknown id falls back to the default', () => {
  assert.ok(MATERIALS.length >= 6);
  const ids = new Set();
  for (const m of MATERIALS) {
    assert.ok(!ids.has(m.id), `${m.id} is listed once`);
    ids.add(m.id);
    for (const k of ['mill', 'drill', 'turn']) assert.ok(m.speed[k] > 0 && Number.isFinite(m.speed[k]), `${m.id} speed ${k}`);
    assert.ok(m.chip > 0 && m.kc > 0 && typeof m.look === 'string', m.id);
  }
  assert.eq(materialOf('nonsense').id, DEFAULT_MATERIAL);
  assert.eq(materialOf(undefined).id, DEFAULT_MATERIAL);
  assert.ok(isMaterialId('stainless') && !isMaterialId('unobtainium'));
  // the baseline the library's tables are written for is exactly 1
  assert.eq(materialOf('aluminium').speed.mill, 1);
  assert.eq(materialOf('aluminium').chip, 1);
});

test('without a material the suggestion is what it always was; aluminium gives the same on a mill', () => {
  for (const type of FAMILIES) {
    const base = suggestCutting({ type, diameter: 6, pitch: 1 });
    const alu = suggestCutting({ type, diameter: 6, pitch: 1, material: 'aluminium' });
    assert.eq(alu.spindleRpm, base.spindleRpm, `${type}: rpm`);
    assert.eq(alu.feedCut, base.feedCut, `${type}: feed`);
  }
});

test('a harder material is slower in rpm and in chip, in every family, and always a usable number', () => {
  for (const type of FAMILIES) {
    const alu = suggestCutting({ type, diameter: 10, pitch: 1.5, material: 'aluminium' });
    for (const id of ['mild-steel', 'stainless', 'titanium']) {
      const hard = suggestCutting({ type, diameter: 10, pitch: 1.5, material: id });
      assert.ok(hard.spindleRpm > 0 && hard.feedCut > 0 && Number.isFinite(hard.feedCut), `${type}/${id} usable`);
      assert.ok(hard.spindleRpm <= alu.spindleRpm, `${type}/${id}: not faster than aluminium`);
      assert.ok(hard.feedCut <= alu.feedCut, `${type}/${id}: not a heavier feed than aluminium`);
    }
  }
  // by hand: an end mill at 0.3 of aluminium's 250 m/min is 75 m/min; at D6 that is 3979 rpm
  const steel = suggestCutting({ type: 'flat', diameter: 6, material: 'mild-steel' });
  assert.close(steel.spindleRpm, 1000 * 75 / (Math.PI * 6), 50, 'rpm from the surface speed');
});

test('a tap feed stays rpm times pitch in any material, because the arithmetic is not a preference', () => {
  for (const m of MATERIALS) {
    const tap = suggestCutting({ type: 'tap', diameter: 6, pitch: 1, material: m.id });
    assert.eq(tap.feedCut, Math.round(tap.spindleRpm * 1), `${m.id}`);
  }
});

test('chip thinning: none at half the diameter or more, the textbook factor below it, capped', () => {
  assert.eq(chipThinningFactor(0.5), 1);
  assert.eq(chipThinningFactor(1), 1, 'a slot is the full chip');
  assert.eq(chipThinningFactor(undefined), 1);
  assert.eq(chipThinningFactor(0), 1);
  assert.close(chipThinningFactor(0.1), 1 / Math.sqrt(1 - 0.8 ** 2), 1e-9, '10% radial is 1.667x');
  assert.close(chipThinningFactor(0.25), 1 / Math.sqrt(1 - 0.5 ** 2), 1e-9);
  assert.eq(chipThinningFactor(0.001), 2.5, 'capped');
  // and it raises the suggested feed by that factor, where asked to
  const full = suggestCutting({ type: 'flat', diameter: 6, material: 'aluminium' });
  const light = suggestCutting({ type: 'flat', diameter: 6, material: 'aluminium', radialEngagement: 0.1 });
  assert.close(light.feedCut / full.feedCut, chipThinningFactor(0.1), 0.02);
  assert.eq(light.spindleRpm, full.spindleRpm, 'the speed does not change');
  // never for a drill
  assert.eq(suggestCutting({ type: 'drill', diameter: 6, radialEngagement: 0.1 }).feedCut,
    suggestCutting({ type: 'drill', diameter: 6 }).feedCut);
});

test('power is the removal rate times the specific cutting force, over the efficiency', () => {
  // 6 wide x 3 deep x 1000 mm/min = 18000 mm3/min = 18 cm3/min
  assert.close(removalRate({ ae: 6, ap: 3, feed: 1000 }), 18, 1e-9);
  // 18000 * 700 N/mm2 / (60e6) = 0.21 kW at the tool, 0.2625 at the spindle
  assert.close(cuttingPowerKw({ ae: 6, ap: 3, feed: 1000, material: 'aluminium' }), 0.2625, 1e-9);
  assert.close(cuttingPowerKw({ ae: 6, ap: 3, feed: 1000, material: 'aluminium', efficiency: 1 }), 0.21, 1e-9);
  assert.ok(cuttingPowerKw({ ae: 6, ap: 3, feed: 1000, material: 'stainless' })
    > 3 * cuttingPowerKw({ ae: 6, ap: 3, feed: 1000, material: 'aluminium' }), 'steel takes far more');
  assert.eq(cuttingPowerKw({ ae: 0, ap: 3, feed: 1000, material: 'aluminium' }), 0);
  assert.eq(cuttingPowerKw({ ae: NaN, ap: 3, feed: 1000 }), 0);
});

test('a setup has a material, an old project gets the default and a bad one is repaired and said so', () => {
  assert.eq(createSetup('a').material, DEFAULT_MATERIAL);
  assert.eq(createSetup('a', 'turn').material, 'mild-steel', 'a lathe is fed steel bar');
  const project = createProject('p');
  project.setups.push(createSetup('s'));
  const text = JSON.parse(serializeProject(project));
  assert.eq(text.setups[0].material, DEFAULT_MATERIAL, 'saved');
  // a file from before the field
  delete text.setups[0].material;
  assert.eq(deserializeProject(JSON.stringify(text)).setups[0].material, DEFAULT_MATERIAL);
  // a file with nonsense in it
  text.setups[0].material = 'cheese';
  const notes = [];
  assert.eq(deserializeProject(JSON.stringify(text), notes).setups[0].material, DEFAULT_MATERIAL);
  assert.ok(notes.some((n) => /material/.test(n)), `said so: ${notes.join(' | ')}`);
  // a good one survives the round trip
  text.setups[0].material = 'titanium';
  assert.eq(deserializeProject(JSON.stringify(text)).setups[0].material, 'titanium');
});

test('changing the material moves no toolpath: the fingerprint does not see it', () => {
  const doc = new Document();
  const tool = createTool('flat');
  doc.addTool(tool);
  const setup = createSetup('s');
  doc.addSetup(setup);
  const op = createOperation('pocket');
  op.toolId = tool.id;
  doc.addOperation(setup, op);
  const before = opFingerprint(doc, op, setup);
  doc.updateItem(setup, { material: 'stainless' }, 'material');
  assert.eq(opFingerprint(doc, op, setup), before, 'still up to date');
});

test('a machine states its spindle power; one from before the field says 0 (not stated)', () => {
  for (const preset of MACHINE_PRESETS) assert.ok(preset.spindlePower > 0, `${preset.name} states a power`);
  assert.eq(createMachine({ kind: 'mill' }).spindlePower, 2.2);
  assert.eq(createMachine({ kind: 'mill', spindlePower: 0.5 }).spindlePower, 0.5);
  assert.eq(createMachine({ kind: 'mill', spindlePower: -3 }).spindlePower, 2.2, 'a negative is not a power');
  assert.eq(speedKindOf('tap'), 'drill');
  assert.eq(speedKindOf('boring'), 'turn');
  assert.eq(speedKindOf('ball'), 'mill');
});

function opWith(type, params, toolOver = {}) {
  const tool = Object.assign(createTool('flat'), { diameter: 6, flutes: 2, spindleRpm: 12000, feedCut: 1000 }, toolOver);
  const op = createOperation(type);
  op.toolId = tool.id;
  Object.assign(op.params, params);
  return { op, tool };
}

test('the cut check names a spindle that will stall, and only when the machine says what it has', () => {
  const { op, tool } = opWith('pocket', { stepover: 1, stepdown: 6 }, { feedCut: 1500 });
  const small = createMachine({ kind: 'mill', spindlePower: 0.4 });
  const stall = cutCheck(op, tool, 'aluminium', small);
  assert.ok(stall.powerKw > 0.4, `needs ${stall.powerKw}`);
  assert.ok(stall.warnings.some((w) => /stall/.test(w)), stall.warnings.join(' | '));
  const strong = createMachine({ kind: 'mill', spindlePower: 7 });
  assert.ok(!cutCheck(op, tool, 'aluminium', strong).warnings.some((w) => /stall/.test(w)));
  const unstated = { ...createMachine({ kind: 'mill' }), spindlePower: 0 };
  assert.eq(cutCheck(op, tool, 'aluminium', unstated).spindleKw, null);
  assert.ok(!cutCheck(op, tool, 'aluminium', unstated).warnings.some((w) => /stall/.test(w)), 'silent, not guessing');
});

test('aluminium speeds in steel are burnt edges, and the check says so; the right speeds are quiet', () => {
  const { op, tool } = opWith('contour2d', {}, { spindleRpm: 12000, feedCut: 1000 });
  const bad = cutCheck(op, tool, 'stainless', null);
  assert.ok(bad.warnings.some((w) => /burn/.test(w)), bad.warnings.join(' | '));
  const right = suggestCutting({ type: 'flat', diameter: 6, flutes: 2, material: 'stainless' });
  const ok = opWith('contour2d', {}, { spindleRpm: right.spindleRpm, feedCut: right.feedCut });
  assert.eq(cutCheck(ok.op, ok.tool, 'stainless', null).warnings.length, 0, 'the table agrees with itself');
});

test('a lathe tool and no tool are not asked; widths come from what the strategy states', () => {
  assert.eq(cutCheck(createOperation('pocket'), null, 'aluminium'), null);
  const lathe = createTool('turning');
  assert.eq(cutCheck(createOperation('turnRough'), lathe, 'aluminium'), null);
  const { op, tool } = opWith('adaptive', { engagement: 0.2, stepdown: 12 });
  const w = cutWidths(op, tool);
  assert.close(w.ae, 1.2, 1e-9);
  assert.eq(w.ap, 12);
  assert.eq(cutWidths(opWith('contour2d', {}).op, tool).ae, null, 'a contour has no stated width');
  assert.close(cutWidths(opWith('slot', { stepdown: 2 }).op, tool).ae, 6, 1e-9, 'a slot is the whole cutter');
});
