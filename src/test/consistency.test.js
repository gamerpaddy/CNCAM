// One thing, said one way, wherever it appears.
//
// The 2026-09-25 UI round found the same fault in a dozen places: two parts of
// the app describing one fact differently. Three hole cycles read settings their
// panel had no field for; a tap showed a feed nothing posted; the same deletion
// was "Remove tool" in one place and "Delete Tool" in another; the toolbar's
// tooltips quoted their keys by hand, and half of them had not been told. These
// hold each of those to a single description.

import { test, assert } from './runner.js';
import { generateToolpath, IMPLEMENTED_OPS } from '../engine/toolpath.js';
import { createOperation, createTool } from '../doc/schema.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { OP_PARAM_GROUPS, paramApplies, tabsForOp } from '../app/op-params.js';
import { matchesShortcut, withKey, shortcuts } from '../app/shortcuts.js';
import { removalOf, nounFor } from '../app/item-labels.js';
import { eachMove, OP } from '../engine/cl.js';
import { makeTube } from './fixtures.js';

// --- the panel and the strategy read the same settings ---

const STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] };
const PLATE = makeTube(20, 20, 18, 2.5, 20);    // a ⌀5 hole: an M6 tapping drill
const BORED = makeTube(20, 20, 18, 5, 20);      // a ⌀10, for a thread mill to orbit in
const HOLE_TOOLS = {
  spot: [{ ...createTool('spot'), diameter: 8, tipAngle: 90 }, PLATE],
  drill: [{ ...createTool('drill'), diameter: 5 }, PLATE],
  tap: [{ ...createTool('tap'), diameter: 6, pitch: 1, spindleRpm: 300 }, PLATE],
  threadMill: [{ ...createTool('threadmill'), diameter: 4, pitch: 1 }, BORED],
};

function shownKeys(op) {
  const keys = new Set();
  for (const group of OP_PARAM_GROUPS) {
    for (const field of group.fields) if (field.key && paramApplies(field, op)) keys.add(field.key);
  }
  return keys;
}

function fingerprint(cl) {
  const moves = Array.from(cl.moves ?? [], (v) => Math.round(v * 1000)).join(',');
  return `${moves}|${(cl.notes ?? []).map((n) => n.text).join('|')}|${JSON.stringify(cl.events ?? [])}`;
}

function nudged(value) {
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value === 0 ? 0.7 : value * 1.6 + 0.3;
  if (typeof value === 'string') {
    return ({ climb: 'conventional', conventional: 'climb', right: 'left', left: 'right',
      hole: 'bottomZ', bottomZ: 'hole', off: 'flood', flood: 'off' })[value];
  }
  return undefined;
}

// Spot, tap and thread mill each rapid at Clearance Z and stop at the entry
// gap; spot dwells; a tap stops at each hole's own floor or at Bottom Z; a
// thread mill is chorded to a tolerance and climbs or does not. None of those
// had a field — whatever the default was, the program did, and nothing on
// screen could change it.
test('a hole cycle reads no setting its panel hides', () => {
  const stock = STOCK;
  const modelBounds = { min: [2, 2, 0], max: [38, 38, 20] };
  for (const [type, [tool, mesh]] of Object.entries(HOLE_TOOLS)) {
    const op = createOperation(type);
    Object.assign(op.params, defaultParamsFor(type, { stock, modelBounds, tool }));
    const shown = shownKeys(op);
    const run = (params) => fingerprint(generateToolpath({ type, name: type, tool, mesh, stock, params }));
    const base = run({ ...op.params });
    for (const [key, value] of Object.entries(op.params)) {
      if (shown.has(key)) continue;
      const other = nudged(value);
      if (other === undefined) continue;
      assert.eq(run({ ...op.params, [key]: other }), base,
        `${type} reads ${key}, and its panel has no field for it`);
    }
  }
});

test('the thread mill comes down to the entry gap, like the other three', () => {
  const [tool, mesh] = HOLE_TOOLS.threadMill;
  const lowest = (entryGap) => {
    const cl = generateToolpath({
      type: 'threadMill', name: 't', tool, mesh, stock: STOCK,
      params: {
        topZ: 20, bottomZ: 0, clearanceHeight: 30, tolerance: 0.01, entryGap,
        threadInternal: true, direction: 'climb', threadHand: 'right',
      },
    });
    let z = Infinity;
    eachMove(cl, (opcode, x, y, zz) => { if (opcode === OP.RAPID) z = Math.min(z, zz); });
    return z;
  };
  assert.close(lowest(1), 21, 1e-6, 'a 1mm gap stops rapiding 1mm above the billet');
  assert.close(lowest(3), 23, 1e-6, 'and a 3mm one, 3mm above');
});

test('a tap has no feed field, because nothing posts one', () => {
  const op = createOperation('tap');
  const shown = shownKeys(op);
  assert.ok(!shown.has('feedCut') && !shown.has('feedPlunge'),
    'a tap feeds at its pitch a turn; a feed field on it changes nothing');
  assert.ok(shown.has('spindleRpm'), 'the speed is the one number that sets it');
});

test('every operation opens on its Strategy tab', () => {
  // The order of the tabs exists so that selecting an operation shows what it
  // is before its depths. The hole cycles kept theirs on a "Drill" tab after
  // Speeds, so three of them opened on Heights.
  for (const type of IMPLEMENTED_OPS) {
    if (type === 'command') continue;   // no tabs at all: one box of G-code
    const tabs = tabsForOp(createOperation(type));
    assert.eq(tabs[0]?.key, 'strategy', `${type} opens on ${tabs[0]?.key ?? 'nothing'}`);
  }
});

test('one label for one setting across the two machines', () => {
  // the same key is declared by more than one descriptor where milling and
  // turning read it differently — but it is one number and one name
  const labels = new Map();
  for (const group of OP_PARAM_GROUPS) {
    for (const field of group.fields) {
      if (!field.key || !field.label || !['peck', 'dwell', 'diameterTol'].includes(field.key)) continue;
      if (!labels.has(field.key)) labels.set(field.key, new Set());
      labels.get(field.key).add(field.label);
    }
  }
  for (const [key, set] of labels) {
    assert.eq(set.size, 1, `${key} is labelled ${[...set].join(' and ')}`);
  }
});

// --- keys ---

test('the keys named for what is printed on them match what the browser sends', () => {
  const ev = (init) => ({ key: '', ctrlKey: false, metaKey: false, shiftKey: false, ...init });
  assert.ok(matchesShortcut('Space', ev({ key: ' ' })), 'Space is a space');
  assert.ok(matchesShortcut('←', ev({ key: 'ArrowLeft' })));
  assert.ok(matchesShortcut('→', ev({ key: 'ArrowRight' })));
  assert.ok(!matchesShortcut('→', ev({ key: 'ArrowLeft' })));
  assert.ok(matchesShortcut('Home', ev({ key: 'Home' })));
});

test('a tooltip quotes the key the table binds, and nothing when there is none', () => {
  assert.eq(withKey('Save the project', 'save'), 'Save the project (Ctrl+S)');
  assert.eq(withKey('Compute toolpaths', 'generate'), 'Compute toolpaths (Ctrl+G)');
  assert.eq(withKey('No key', 'nothing-by-this-name'), 'No key');
  // and every id the toolbar asks for is one the table has
  const ids = new Set(shortcuts({}).map((s) => s.id).filter(Boolean));
  for (const id of ['import', 'addOperation', 'machines', 'options', 'help', 'save', 'generate', 'simulate',
    'fit', 'undo', 'redo']) {
    assert.ok(ids.has(id), `the toolbar asks for "${id}" and the table has no such key`);
  }
});

test('the simulation keys only act while there is a simulation', () => {
  let played = 0;
  const timeline = { visible: false, togglePlay: () => { played++; }, step() {} };
  const ctx = { ui: { timeline }, doc: {}, actions: {} };
  const space = shortcuts(ctx).find((s) => s.keys === 'Space');
  assert.ok(space, 'Space is bound');
  assert.ok(!space.enabled(), 'and does nothing with the simulation closed');
  timeline.visible = true;
  assert.ok(space.enabled());
  space.run();
  assert.eq(played, 1);
});

// --- taking things away ---

test('a deletion is worded by what the thing is', () => {
  assert.eq(removalOf('tool').label, 'Remove tool');
  assert.eq(removalOf('model').label, 'Remove model');
  assert.eq(removalOf('op').label, 'Delete operation');
  assert.eq(removalOf('setup').label, 'Delete setup');
  assert.eq(removalOf('fixture', { kind: 'chuck' }).label, 'Delete chuck',
    'a chuck is not a clamp, whatever the document calls them both');
  assert.eq(nounFor('fixture', { kind: 'box' }), 'jaw');
  assert.eq(removalOf('tool').done, 'Removed');
  assert.eq(removalOf('op').done, 'Deleted');
});
