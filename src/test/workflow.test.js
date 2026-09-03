// The parts of this round that are behaviour rather than geometry: the strategy
// catalogue, the picker, path visibility, drag-to-reorder and the key table.
//
// Most of these are contracts *between* modules rather than inside one — every
// implemented strategy needs a catalogue entry, every bound key needs a line in
// the help, hiding a path must not disable the operation. Those are exactly the
// things that rot silently when a strategy or a shortcut is added and only half
// the app is told.

import { test, assert } from './runner.js';
import {
  IMPLEMENTED_OPS, MILLING_OPS, TURNING_OPS, OP_LABELS, opsForMode,
  BOTH_MACHINES,
} from '../engine/toolpath.js';
import { OP_CATALOG, OP_GROUPS, strategyCard } from '../app/op-catalog.js';
import { shortcuts, shortcutGroups, matchesShortcut, firesWhileTyping } from '../app/shortcuts.js';
import { Document } from '../doc/document.js';
import { createSetup, createOperation, createTool, OP_TYPES } from '../doc/schema.js';
import { pickToolFor, noSideToCutWith } from '../engine/tool-match.js';

const inBrowser = typeof document !== 'undefined';

// --- the catalogue has to keep up with the engine ---

test('every implemented strategy is described, grouped and drawn', () => {
  for (const type of IMPLEMENTED_OPS) {
    const card = strategyCard(type);
    assert.ok(OP_CATALOG[type], `${type} has no catalogue entry — the picker would show a blank card`);
    assert.ok(card.summary.length > 20, `${type} needs a summary of what it does`);
    assert.ok(card.when.length > 20, `${type} needs a line on when to reach for it`);
    assert.ok(card.cutter.length > 3, `${type} needs to say what cutter it expects`);
    assert.ok(card.icon.length > 10, `${type} needs an icon`);
    assert.ok(OP_GROUPS.includes(card.group), `${type} is in group "${card.group}", which no picker shows`);
  }
});

test('every strategy belongs to one machine, or is named as belonging to both', () => {
  // A turning operation in a milling setup is meaningless and the pickers must
  // never offer one, which is what this guards. The single exception is named
  // rather than tolerated: a command is a block of G-code somebody typed, so it
  // is not about what is being cut and appears in both lists. See BOTH_MACHINES.
  const both = IMPLEMENTED_OPS.filter((t) => MILLING_OPS.includes(t) && TURNING_OPS.includes(t));
  assert.eq(both.join(','), [...BOTH_MACHINES].join(','), 'only the named ones are in both lists');
  assert.eq(MILLING_OPS.length + TURNING_OPS.length - BOTH_MACHINES.size,
    IMPLEMENTED_OPS.length, 'and none is left out of both');
  for (const type of BOTH_MACHINES) {
    assert.ok(IMPLEMENTED_OPS.includes(type), `${type} is named for both machines but does not exist`);
  }
  assert.eq(opsForMode('turn').join(','), TURNING_OPS.join(','));
  assert.eq(opsForMode('mill').join(','), MILLING_OPS.join(','));
  assert.eq(opsForMode(undefined).join(','), MILLING_OPS.join(','), 'an old setup mills');
});

test('the schema and the engine agree on which operations exist', () => {
  for (const type of IMPLEMENTED_OPS) {
    assert.ok(OP_TYPES.includes(type), `${type} generates but is not in OP_TYPES`);
    assert.ok(OP_LABELS[type], `${type} needs a short label`);
  }
  for (const type of OP_TYPES) {
    assert.ok(IMPLEMENTED_OPS.includes(type), `${type} is offered but has no strategy`);
  }
});

// --- which cutter a new operation arrives holding ---

const RACK = [
  { id: 'a', number: 1, name: '6mm flat', type: 'flat', diameter: 6, tipAngle: 0 },
  { id: 'b', number: 2, name: '12mm flat', type: 'flat', diameter: 12, tipAngle: 0 },
  { id: 'c', number: 3, name: '3mm ball', type: 'ball', diameter: 3, tipAngle: 0 },
  { id: 'd', number: 4, name: '6mm ball', type: 'ball', diameter: 6, tipAngle: 0 },
  { id: 'e', number: 5, name: '6mm drill', type: 'drill', diameter: 6, tipAngle: 118 },
  { id: 'f', number: 6, name: '6mm chamfer', type: 'chamfer', diameter: 6, tipAngle: 90 },
  { id: 'g', number: 7, name: '40mm face mill', type: 'face', diameter: 40, tipAngle: 0 },
];

test('a new operation arrives holding a cutter that can do the job', () => {
  const pick = (type) => pickToolFor(type, RACK).name;
  assert.eq(pick('chamfer'), '6mm chamfer', 'a chamfer needs a point angle');
  assert.eq(pick('engrave'), '6mm chamfer', 'so does engraving to a line width');
  assert.eq(pick('drill'), '6mm drill');
  assert.eq(pick('face'), '40mm face mill');
  assert.eq(pick('parallel3d'), '3mm ball', 'a round cutter rides a curved surface');
  assert.eq(pick('waterline'), '3mm ball');
  assert.eq(pick('bore'), '12mm flat', 'a helix in a hole needs a cylinder, not a drill');
  assert.eq(pick('clear2d'), '12mm flat', 'roughing takes the stiffest cutter there is');
});

test('with nothing suitable in the rack, the operation is still editable', () => {
  const onlyFlats = RACK.filter((t) => t.type === 'flat');
  // a chamfer cannot cut with any of these, and says so in preflight — but an
  // operation with no tool at all cannot even be looked at
  assert.eq(pickToolFor('chamfer', onlyFlats).name, '6mm flat');
  assert.eq(pickToolFor('contour2d', []), null);
  assert.eq(pickToolFor('contour2d', null), null);
});

test('a drill is never chosen for an operation that mills', () => {
  const rack = [RACK[4], RACK[0]];   // drill first in the list
  for (const type of ['bore', 'contour2d', 'pocket', 'clear2d', 'adaptive', 'face']) {
    assert.ok(pickToolFor(type, rack).type !== 'drill', `${type} picked a drill`);
  }
  assert.eq(pickToolFor('drill', rack).type, 'drill');
});

// --- shortcut table ---

const stubCtx = () => ({
  doc: new Document(),
  ui: { setStatus() {} },
  actions: new Proxy({}, { get: () => () => {} }),
  setPickMode() {},
  pickMode: null,
});

test('every bound key is documented, and every documented key is bound', () => {
  const ctx = stubCtx();
  const bound = shortcuts(ctx).filter((s) => !s.alias);
  const listed = shortcutGroups(ctx).flatMap((g) => g.items);
  assert.eq(listed.length, bound.length, 'the help list and the bindings come from one table');
  for (const item of listed) {
    assert.ok(item.label.length > 3, `${item.keys} has no description`);
  }
});

test('a shortcut spec matches the key it reads as', () => {
  const ev = (init) => ({ key: '', ctrlKey: false, metaKey: false, shiftKey: false, ...init });
  assert.ok(matchesShortcut('Ctrl+G', ev({ key: 'g', ctrlKey: true })));
  assert.ok(matchesShortcut('Ctrl+G', ev({ key: 'G', metaKey: true })), 'Meta counts as Ctrl');
  assert.ok(!matchesShortcut('Ctrl+G', ev({ key: 'g' })), 'the modifier is required');
  assert.ok(!matchesShortcut('G', ev({ key: 'g', ctrlKey: true })), 'and forbidden when absent');
  assert.ok(matchesShortcut('Shift+H', ev({ key: 'H', shiftKey: true })));
  assert.ok(!matchesShortcut('H', ev({ key: 'H', shiftKey: true })), 'Shift+H is not H');
  assert.ok(matchesShortcut('Delete', ev({ key: 'Delete' })));
  // '?' is Shift+/ on most layouts, so it must not be excluded by a stray Shift
  assert.ok(matchesShortcut('?', ev({ key: '?', shiftKey: true })));
});

test('only modified keys fire while the caret is in a text field', () => {
  const ctx = stubCtx();
  for (const s of shortcuts(ctx)) {
    if (s.keys.length === 1) {
      assert.ok(!firesWhileTyping(s), `${s.keys} would fire while typing a name`);
    }
  }
  assert.ok(firesWhileTyping({ keys: 'Ctrl+G' }));
});

// --- path visibility is a view filter, not an edit ---

function docWithTwoOps() {
  const doc = new Document();
  const setup = createSetup('S');
  doc.addSetup(setup);
  doc.addTool(createTool());
  const ops = ['a', 'b'].map((n) => {
    const op = createOperation('contour2d');
    op.name = n;
    doc.addOperation(setup, op);
    doc.toolpaths.set(op.id, { version: 0, moves: new Float32Array(0), count: 0, events: [], notes: [] });
    return op;
  });
  return { doc, setup, ops };
}

test('hiding a path leaves the operation in the program', () => {
  const { doc, ops } = docWithTwoOps();
  assert.eq(doc.visibleToolpaths().length, 2);
  const undoLabel = doc.undoStack.undoLabel;

  doc.setPathVisible(ops[0].id, false);
  assert.eq(doc.visibleToolpaths().length, 1, 'the viewport drops it');
  assert.eq(doc.enabledToolpaths().length, 2, 'but it is still generated, posted and simulated');
  assert.eq(ops[0].enabled, true, 'and it is not disabled');
  assert.eq(doc.undoStack.undoLabel, undoLabel,
    'looking at something is not an edit, so it must not land on the undo stack');

  doc.setPathVisible(ops[0].id, true);
  assert.eq(doc.visibleToolpaths().length, 2);
});

test('solo shows one path, and shows them all again when repeated', () => {
  const { doc, ops } = docWithTwoOps();
  doc.soloPath(ops[1].id);
  assert.eq(doc.visibleToolpaths().length, 1);
  assert.eq(doc.isPathVisible(ops[1].id), true);
  assert.eq(doc.isPathVisible(ops[0].id), false);

  doc.soloPath(ops[1].id);
  assert.eq(doc.visibleToolpaths().length, 2, 'soloing the same one again is the way back');
});

test('the toolpath signature changes when a path is hidden', () => {
  const { doc, ops } = docWithTwoOps();
  const before = doc.toolpathSignature();
  doc.setPathVisible(ops[0].id, false);
  assert.ok(doc.toolpathSignature() !== before, 'or the viewport would never redraw');
});

// --- the strategy picker ---

test('the picker offers the strategies this setup can use, and marks the current one', async () => {
  if (!inBrowser) return;
  const { openStrategyPicker } = await import('../app/strategy-picker.js');
  let picked = null;
  const dialog = openStrategyPicker({ current: 'bore', onPick: (t) => { picked = t; } });
  try {
    const cards = [...dialog.querySelectorAll('.strategy-card')];
    assert.eq(cards.length, MILLING_OPS.length, 'one card per milling strategy');
    const checked = cards.filter((c) => c.classList.contains('checked'));
    assert.eq(checked.length, 1, 'exactly one is selected on open');
    assert.ok(checked[0].textContent.includes(OP_LABELS.bore), 'and it is the current strategy');
    assert.eq(dialog.querySelectorAll('.strategy-current').length, 1, 'labelled as current');

    // choosing is two steps: select, then confirm — a stray click must not retype
    const face = cards.find((c) => c.textContent.startsWith(OP_LABELS.face));
    face.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert.eq(picked, null, 'selecting a card does not commit it');
    dialog.querySelector('button.primary').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert.eq(picked, 'face');
  } finally {
    dialog.close();
  }
});

// --- drag to reorder ---

/** A DataTransfer stand-in; jsdom-free and enough for the tree's handlers. */
function dragData(id) {
  const store = new Map([['text/cncam-op', id]]);
  return {
    effectAllowed: '', dropEffect: '',
    types: [...store.keys()],
    setData: (t, v) => store.set(t, v),
    getData: (t) => store.get(t) ?? '',
  };
}

test('dragging an operation onto another moves it in the program', async () => {
  if (!inBrowser) return;
  const { renderTree } = await import('../app/tree.js');
  const { doc, setup, ops } = docWithTwoOps();
  const third = createOperation('contour2d');
  third.name = 'c';
  doc.addOperation(setup, third);

  const moves = [];
  const container = document.createElement('div');
  document.body.append(container);
  try {
    renderTree(container, doc, {
      actions: { reorderOperation: (s, from, to) => moves.push([from, to]) },
    });
    const rows = [...container.querySelectorAll('.tree-op')];
    assert.eq(rows.length, 3, 'three operation rows');

    // drag the first row onto the bottom half of the last: it lands at the end
    const target = rows[2];
    const r = target.getBoundingClientRect();
    const dataTransfer = dragData(ops[0].id);
    target.dispatchEvent(Object.assign(
      new MouseEvent('drop', { bubbles: true, cancelable: true, clientY: r.top + r.height }),
      { dataTransfer },
    ));
    assert.eq(moves.length, 1, 'the drop asked for a move');
    // removing index 0 first shifts everything after it, so "after the last" is 2
    assert.eq(moves[0].join(','), '0,2');

    // a drop on itself is not a move
    moves.length = 0;
    rows[1].dispatchEvent(Object.assign(
      new MouseEvent('drop', { bubbles: true, cancelable: true, clientY: r.top }),
      { dataTransfer: dragData(ops[1].id) },
    ));
    assert.eq(moves.length, 0);
  } finally {
    container.remove();
  }
});

test('an operation row shows its strategy, and hidden paths look different', async () => {
  if (!inBrowser) return;
  const { renderTree } = await import('../app/tree.js');
  const { doc, ops } = docWithTwoOps();
  const container = document.createElement('div');
  document.body.append(container);
  try {
    renderTree(container, doc, { actions: {} });
    assert.eq(container.querySelectorAll('.tree-op .op-icon').length, 2, 'each row names its strategy by shape');
    assert.eq(container.querySelectorAll('.tree-op .tree-eye').length, 2, 'and carries a visibility toggle');
    assert.eq(container.querySelectorAll('.tree-op.path-hidden').length, 0);

    doc.setPathVisible(ops[0].id, false);
    renderTree(container, doc, { actions: {} });
    assert.eq(container.querySelectorAll('.tree-op.path-hidden').length, 1);
    assert.eq(container.querySelectorAll('.tree-op.disabled').length, 0,
      'hidden must not read as disabled — the operation is still machined');
  } finally {
    container.remove();
  }
});

test('a lathe setup is offered turning strategies and nothing else', async () => {
  if (!inBrowser) return;
  const { openStrategyPicker } = await import('../app/strategy-picker.js');
  // A turning operation in a milling setup is meaningless and the reverse is
  // too, so the picker has to be told which machine it is choosing for.
  const turn = openStrategyPicker({ mode: 'turn' });
  try {
    // matched whole, not by prefix: "Face the end" starts with "Face"
    const names = [...turn.querySelectorAll('.strategy-name')].map((n) => n.textContent);
    assert.eq(names.length, TURNING_OPS.length, `got ${names.join(', ')}`);
    for (const type of TURNING_OPS) {
      assert.ok(names.includes(OP_LABELS[type]), `${type} is missing`);
    }
    for (const type of MILLING_OPS) {
      assert.ok(!names.includes(OP_LABELS[type]),
        `${type} is a milling strategy and should not be offered on a lathe`);
    }
  } finally {
    turn.close();
  }
});

test('every strategy icon draws something', async () => {
  if (!inBrowser) return;
  const { opIcon } = await import('../app/op-catalog.js');
  for (const type of IMPLEMENTED_OPS) {
    const svg = opIcon(type, 24);
    assert.ok(svg.children.length > 0, `${type} drew an empty icon`);
    assert.ok(svg.getAttribute('viewBox') === '0 0 24 24');
  }
});

test('a cutter with no side is not silently given a pass that feeds it sideways', () => {
  // `pickToolFor` prefers its way past a drill for anything that mills, and
  // there is a test above that says so — but it is a *preference* and it falls
  // back to whatever is held so a new operation is editable rather than blank.
  // With a drill or a tap as the only cutter in the project, a new pocket
  // therefore arrives holding one and generates a complete toolpath that drives
  // it through metal edgeways. Nothing downstream refuses it: a pocket asks the
  // tool for its diameter, and a tap has one.
  const drill = { id: 'e', number: 5, name: '6mm drill', type: 'drill', diameter: 6, tipAngle: 118 };
  const tap = { id: 't', number: 6, name: 'M6 tap', type: 'tap', diameter: 6, pitch: 1, tipAngle: 0 };
  const flat = { id: 'a', number: 1, name: '6mm flat', type: 'flat', diameter: 6, tipAngle: 0 };
  const sideCutting = ['face', 'contour2d', 'pocket', 'clear2d', 'adaptive',
    'slot', 'bore', 'engrave', 'parallel3d', 'waterline'];

  for (const type of sideCutting) {
    // it is still assigned — an operation with no tool cannot even be looked at
    assert.ok(pickToolFor(type, [tap]), `${type} still arrives holding something`);
    for (const tool of [drill, tap]) {
      assert.ok(noSideToCutWith(type, tool), `${type} with a ${tool.type} says nothing`);
    }
    assert.eq(noSideToCutWith(type, flat), null, `${type} with an end mill is fine`);
  }

  // and the two that sink a point into the work on purpose are not caught by it
  for (const type of ['drill', 'spot', 'chamfer']) {
    assert.eq(noSideToCutWith(type, drill), null, `${type} is a point going down`);
  }
  // a thread mill has a side, and it is a thread
  assert.ok(/thread form/.test(noSideToCutWith('pocket', { type: 'threadmill', diameter: 6 }) ?? ''),
    'a slot cut with a thread mill comes out threaded');

  // with an end mill in the rack as well, the preference never gets here
  assert.eq(pickToolFor('pocket', [drill, flat]).type, 'flat', 'the end mill wins');
});
