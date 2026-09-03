// Project tree panel: models, tools, setups/operations. Rebuilt on doc change
// (fine at this scale; virtualize later if needed).
//
// Operations sit under their setup with a "+ Add" affordance next to it, which
// is the natural place to think "what should happen in this setup?". Every row
// gets a right-click menu to delete it — a delete button per row would be
// louder than useful.

import { el } from './layout.js';
import { plural } from '../engine/text.js';
import { openContextMenu } from './context-menu.js';
import { opStatus, opBlockedReason, opPreflight } from './op-status.js';
import { OP_LABELS } from '../engine/toolpath.js';
import { toolIcon, describeTool } from './tool-shape.js';
import { isPhoto } from './tool-photo.js';
import { opIcon, OP_CATALOG } from './op-catalog.js';
import { openStrategyPicker } from './strategy-picker.js';
import { machineCanHold } from '../doc/tool-library.js';

// Which row is being renamed, if any.
//
// Module state rather than state on the row, because the tree is rebuilt
// wholesale on every document change and a text box living on a node would be
// destroyed by the first keystroke committed into it. Held by id, so the
// rebuild puts the box back where it was.
let renamingId = null;
let renameFresh = false;
// What has been typed but not committed, and where the caret is. Both have to
// outlive the box: see below, the box does not survive a document change.
let renameDraft = null;
let renameCaret = null;

/** Start renaming an item. The tree redraws with a text box in that row. */
export function beginRename(doc, id) {
  renamingId = id;
  renameFresh = true;
  renameDraft = null;
  renameCaret = null;
  doc.emitChange('rename');
}

function endRename(doc) {
  if (renamingId === null) return;
  renamingId = null;
  renameFresh = false;
  renameDraft = null;
  renameCaret = null;
  doc.emitChange('rename');
}

/**
 * The name cell of a row: text, or a text box while it is being renamed.
 *
 * Double-click is the gesture everything else in the world uses for this — a
 * file in a file manager, a layer in a drawing program, a tab in a browser —
 * and having to select a row and then find its Name field in a side panel to
 * change "Contour 2" to "profile the outside" is the kind of friction that
 * leaves every operation in a program called after its strategy.
 */
function nameCell(doc, item, { className = 'tree-op-name', prefix = '' } = {}) {
  if (item.id !== renamingId) {
    // No handler of its own: the click lands on the row, which is where the
    // gesture is counted — see renameOnDoubleClick. A second copy here would be
    // a `dblclick` listener that can never fire, which is what was here before.
    // The name first, because the row is narrow and long names are clipped to
    // an ellipsis: a tooltip that says only how to rename a thing is no help at
    // all when what you wanted was to read what it is called.
    return el('span', {
      class: className,
      title: `${prefix}${item.name}
Double-click to rename`,
    }, [`${prefix}${item.name}`]);
  }

  const input = el('input', {
    class: `${className} tree-rename`,
    type: 'text',
  });
  input.value = renameDraft ?? item.name;
  // the row underneath is a select-and-open target; a click in the box is not
  for (const type of ['click', 'dblclick', 'pointerdown']) {
    input.addEventListener(type, (e) => e.stopPropagation());
  }
  // Every keystroke and every caret move is parked in module state, because the
  // box itself is thrown away and rebuilt by the next document change — see the
  // blur handler.
  const remember = () => {
    renameDraft = input.value;
    renameCaret = [input.selectionStart, input.selectionEnd];
  };
  for (const type of ['input', 'keyup', 'select', 'mouseup']) {
    input.addEventListener(type, remember);
  }
  const commit = () => {
    const next = input.value.trim();
    if (next && next !== item.name) doc.updateItem(item, { name: next }, 'rename');
    endRename(doc);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();          // Delete and the single-key shortcuts are not for us
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); endRename(doc); }
  });
  /**
   * Clicking away commits. **Being torn down does not.**
   *
   * The tree is rebuilt wholesale on every document change, and a document
   * change is not a rare event — an autosave, a status refresh, a hint, a
   * finished generate. Each one replaces the focused box with an identical
   * unfocused one, and the removal fires `blur`. Read as "the user clicked
   * away", that closed the rename half a second after it opened and threw away
   * whatever had been typed, which is exactly what "double-click doesn't rename
   * anything" looks like from the outside. Measured: after one unrelated
   * `emitChange`, `document.activeElement` was BODY and the box was gone.
   *
   * A box that is no longer in the document was not left by the user.
   */
  input.addEventListener('blur', () => {
    if (input.isConnected) commit();
  });
  // Focus on *every* render while this row is being renamed, not only the
  // first, so a rebuild mid-rename puts the caret back where it was.
  const fresh = renameFresh;
  renameFresh = false;
  // after the tree is in the document, or there is nothing to focus
  queueMicrotask(() => {
    if (renamingId !== item.id || !input.isConnected) return;
    input.focus();
    if (fresh || !renameCaret) input.select();
    else input.setSelectionRange(renameCaret[0], renameCaret[1]);
  });
  return input;
}

export function renderTree(container, doc, app = {}) {
  const { project, selection } = doc;
  const nodes = [];

  nodes.push(sectionHeader('Models'));
  if (project.models.length === 0) nodes.push(empty('no models'));
  for (const model of project.models) {
    nodes.push(row(doc, 'model', model, () => doc.select('model', model.id),
      () => menuForModel(doc, model, app)));
  }

  // Drawings only appear once there is one. A section reading "no drawings" on
  // every milling job is a permanent answer to a question nobody asked.
  const drawings = project.drawings ?? [];
  if (drawings.length > 0) {
    nodes.push(sectionHeader('Drawings'));
    for (const drawing of drawings) {
      nodes.push(row(doc, 'drawing', drawing, () => doc.select('drawing', drawing.id),
        () => menuForDrawing(doc, drawing, app), 'tree-drawing'));
    }
  }

  // Two ways in, because they are two different intentions: reach for a cutter
  // you already have, or make one you do not.
  nodes.push(sectionHeader('Tools', {
    actions: [
      {
        label: 'Library', title: 'Pick cutters from the library',
        onclick: () => app.actions?.addToolsFromLibrary(),
      },
      {
        label: '+ New', class: 'tree-add-primary',
        title: 'Build a cutter: pick the shape, then only the sizes it has',
        onclick: () => app.actions?.newTool(),
      },
    ],
  }));
  // Only the cutters this machine can hold. A 40mm face mill listed in a lathe
  // turret is a tool you can select, assign to a roughing pass and generate
  // nothing with — the rack is shared between the two machines, but the drawer
  // you reach into is not. Drills are in both, because a lathe drills on its
  // centreline from the tailstock.
  const tools = project.tools.filter((t) => machineCanHold(t.type, doc.machine));
  const otherTools = project.tools.length - tools.length;
  if (tools.length === 0) nodes.push(empty('no tools'));
  const widest = Math.max(8, ...tools.map((t) => t.diameter || 0));
  for (const tool of tools) {
    nodes.push(toolRow(doc, tool, app, widest));
  }
  if (otherTools > 0) {
    nodes.push(empty(`${otherTools} more for the ${doc.machine === 'turn' ? 'mill' : 'lathe'}`));
  }

  // Only this machine's setups. The others are still in the project — a shaft
  // that is turned and then has a flat milled on it is one part and two jobs —
  // but a lathe setup listed under a mill is a program you cannot run.
  const setups = doc.setups();
  const elsewhere = project.setups.length - setups.length;
  nodes.push(sectionHeader(doc.machine === 'turn' ? 'Lathe setups' : 'Mill setups', {
    action: {
      label: '+ Setup',
      title: 'Another fixturing of the part — its own stock, clamps and zero',
      onclick: () => app.actions?.addSetup(),
    },
  }));
  if (setups.length === 0) nodes.push(empty('no setups'));
  if (elsewhere > 0) {
    nodes.push(empty(`${plural(elsewhere, 'setup')} on the ${doc.machine === 'turn' ? 'mill' : 'lathe'}`));
  }

  for (const setup of setups) {
    nodes.push(row(doc, 'setup', setup, () => doc.select('setup', setup.id),
      () => menuForSetup(doc, setup, app)));

    // clamps first: they constrain everything below them, and reading the
    // setup top to bottom should say "held like this, then cut like this"
    for (const fixture of setup.fixtures ?? []) {
      nodes.push(fixtureRow(doc, setup, fixture, app));
    }

    for (const op of setup.operations) {
      nodes.push(operationRow(doc, setup, op, app));
    }

    // + Add operation, right where operations live. It asks which strategy
    // rather than always making a contour and leaving the user to retype it —
    // the strategy is the first thing you know about an operation, and picking
    // it afterwards used to mean re-doing the parameters as well.
    nodes.push(el('div', {
      class: 'tree-add-op',
      title: 'Choose a machining strategy',
      onclick: () => openAddOperation(setup, app),
    }, ['+ Add operation…']));

    const turning = (setup.mode ?? 'mill') === 'turn';
    nodes.push(el('div', {
      class: 'tree-add-op',
      title: turning
        ? 'How the bar is held, and how far along it the tool can reach'
        : 'Clamps and jaws the tool must keep out of',
      // On a lathe there is exactly one thing to add, so the caret is a lie and
      // the menu is a click in the way of the only answer.
      onclick: (e) => (turning
        ? app.actions?.addFixture(setup, 'chuck')
        : openContextMenu(e, holdingMenu(setup, app, turning))),
    }, [turning ? '+ Add chuck' : '+ Add clamp ▾']));
  }

  container.replaceChildren(...nodes);
}

/**
 * What holds the work, offered in the order that machine actually uses.
 *
 * A lathe holds bar in a chuck. Offering it "rectangular jaw" first — and
 * having no chuck at all — meant the commonest piece of workholding in the shop
 * had to be faked as a round clamp that took away the wrong thing: a patch of
 * the XY plane, when what a chuck takes away is everything past a Z.
 */
function holdingMenu(setup, app, turning) {
  const chuck = {
    label: 'Chuck',
    hint: 'Grips the bar at one end. Turning passes stop at the jaws.',
    onclick: () => app.actions?.addFixture(setup, 'chuck'),
  };
  const jaw = {
    label: 'Rectangular jaw',
    hint: 'A keep-out every operation in this setup respects',
    onclick: () => app.actions?.addFixture(setup, 'box'),
  };
  const clamp = {
    label: 'Round clamp',
    onclick: () => app.actions?.addFixture(setup, 'cylinder'),
  };
  // A lathe holds work in the spindle. A toe clamp or a vice jaw is a milling
  // idea — there is no table to bolt one to and nothing that would hold still
  // if there were — and offering them here was offering a fixture that could
  // only produce a keep-out in a place the tool never goes.
  return turning ? [chuck] : [jaw, clamp, chuck];
}

function sectionHeader(title, options = {}) {
  const parts = [el('span', {}, [title])];
  for (const action of options.actions ?? (options.action ? [options.action] : [])) {
    parts.push(el('button', {
      class: `tree-add${action.class ? ` ${action.class}` : ''}`,
      title: action.title ?? action.label,
      onclick: (e) => { e.stopPropagation(); action.onclick(); },
    }, [action.label]));
  }
  return el('h2', { class: 'tree-h2' }, parts);
}

function empty(text) {
  return el('div', { class: 'tree-empty' }, [text]);
}

/**
 * A tool row: its shape, its number and its name — recognisable at a glance.
 *
 * The cutter is drawn lying down with its tip to the left, because a row is
 * wide and short and a cutter stood on end in one is a two-pixel sliver. Laid
 * sideways it gets the whole width of the row, which is enough to tell a ball
 * nose from a V bit without reading anything.
 */
function toolRow(doc, tool, app, widest) {
  const selected = doc.selection?.kind === 'tool' && doc.selection.id === tool.id;
  const node = el('div', {
    class: `tree-item tree-tool${selected ? ' selected' : ''}`,
    title: describeTool(tool),
    onclick: () => doc.select('tool', tool.id),
  }, [
    el('span', { class: 'tree-tool-number' }, [`T${tool.number}`]),
    // Big enough to tell a ball nose from a V bit from a CNMG without reading
    // anything. At the 54×18 it used to be, every cutter in the list was a
    // smudge and the drawing may as well not have been there.
    toolIcon(tool, {
      width: 68, height: 30, scaleTo: widest, orientation: 'horizontal',
    }),
    nameCell(doc, tool),
    el('span', { class: 'tree-tool-size' }, [`⌀${tool.diameter}`]),
    // Removing a tool was previously only in the right-click menu, which is
    // not somewhere anybody looks for a delete button.
    el('button', {
      class: 'tree-row-remove',
      title: `Remove ${tool.name} from this project`,
      onclick: (e) => { e.stopPropagation(); app.actions?.deleteItem('tool', tool.id); },
    }, ['✕']),
  ]);
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    doc.select('tool', tool.id);
    openContextMenu(e, menuForTool(doc, tool, app));
  });
  return node;
}

/** How long after a click on a row a second one still counts as a double. */
const DOUBLE_CLICK_MS = 450;

// The last row clicked, by *item id* rather than by node. See below.
let lastClick = { id: null, at: -Infinity };

/**
 * Double-click anywhere on a row to rename it.
 *
 * The gesture was already on the name *span*, which is as wide as the text —
 * so double-clicking a row named "Face" meant hitting a 30-pixel target, and
 * double-clicking the 200 pixels of empty row beside it did nothing. A row is
 * what you point at; the text is just where its name happens to be drawn.
 *
 * **Counted from the clicks, not taken from `dblclick`.** A click on a row
 * selects it, selecting emits a change, and a change rebuilds the whole tree —
 * so the row the *first* click landed on has been discarded and replaced by the
 * time the second one arrives, and the browser will not raise `dblclick` across
 * two different nodes. That is the whole of this bug: the handler was correct,
 * was attached, and could never fire, and every test that dispatched a
 * `dblclick` directly passed while the real gesture did nothing. Measured:
 * after one `.click()` on a tree row, `document.contains(row)` is false.
 *
 * The thing that survives a rebuild is the item's id, so the gesture is tracked
 * against that.
 *
 * Controls on the row keep their own behaviour: a double-click on the enable
 * box is two clicks on the enable box, and turning it into a rename would be
 * the row second-guessing a control the user hit deliberately.
 */
function renameOnDoubleClick(node, doc, item) {
  node.addEventListener('click', (e) => {
    if (e.target.closest('input, button, select, .tree-eye')) return;
    const now = e.timeStamp;
    if (lastClick.id === item.id && now - lastClick.at < DOUBLE_CLICK_MS) {
      lastClick = { id: null, at: -Infinity };   // a triple-click is not a third rename
      beginRename(doc, item.id);
      return;
    }
    lastClick = { id: item.id, at: now };
  });
  return node;
}

function row(doc, kind, item, onSelect, menuBuilder, extraClass = '') {
  const selected = doc.selection?.kind === kind && doc.selection.id === item.id;
  const node = el('div', {
    class: `tree-item${selected ? ' selected' : ''}${extraClass ? ` ${extraClass}` : ''}`,
    title: `${kind === 'tool' ? `T${item.number} ` : ''}${item.name}
Double-click to rename`,
    onclick: onSelect,
  }, [nameCell(doc, item, { prefix: kind === 'tool' ? `T${item.number} ` : '' })]);
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    onSelect();
    openContextMenu(e, menuBuilder());
  });
  return renameOnDoubleClick(node, doc, item);
}

/**
 * A clamp row. Shown with the same enable toggle operations get, because
 * "generate this program as if the clamps were off" is a real question when you
 * are working out where they can go.
 */
function fixtureRow(doc, setup, fixture, app) {
  const selected = doc.selection?.kind === 'fixture' && doc.selection.id === fixture.id;
  const toggle = el('input', {
    type: 'checkbox',
    class: 'tree-toggle',
    title: 'Keep the tool out of this clamp',
    onclick: (e) => e.stopPropagation(),
  });
  toggle.checked = fixture.enabled !== false;
  toggle.addEventListener('change', () => {
    doc.updateItem(fixture, { enabled: toggle.checked }, 'toggle clamp');
  });
  const chuck = fixture.kind === 'chuck';
  const node = el('div', {
    class: `tree-item tree-op tree-fixture${selected ? ' selected' : ''}`
      + `${fixture.enabled === false ? ' disabled' : ''}`,
    // a chuck's whole meaning is where it grips and how far it reaches, so the
    // row says both rather than making you select it to find out
    title: chuck
      ? `Grips ⌀${fixture.clampDiameter} at Z${fixture.faceZ}; `
        + `the tool cannot pass Z${(fixture.faceZ ?? 0) + (fixture.jawLength ?? 0)}`
      : 'A keep-out every operation in this setup respects',
    onclick: () => doc.select('fixture', fixture.id),
  }, [
    toggle,
    el('span', { class: 'tree-op-name' }, [`${chuck ? '⊙' : '⛒'} ${fixture.name}`]),
    ...(chuck ? [el('span', { class: 'tree-tool-size' }, [`⌀${fixture.clampDiameter}`])] : []),
  ]);
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    doc.select('fixture', fixture.id);
    openContextMenu(e, [
      {
        label: fixture.enabled === false ? 'Enable' : 'Disable',
        onclick: () => doc.updateItem(fixture, { enabled: fixture.enabled === false }, 'toggle clamp'),
      },
      { separator: true },
      {
        label: 'Delete clamp', danger: true,
        onclick: () => app?.actions?.deleteItem('fixture', fixture.id),
      },
    ]);
  });
  return node;
}

function operationRow(doc, setup, op, app) {
  const selected = doc.selection?.kind === 'op' && doc.selection.id === op.id;
  const catalog = OP_CATALOG[op.type];
  const toggle = el('input', {
    type: 'checkbox',
    class: 'tree-toggle',
    title: 'Include this operation in the program',
    onclick: (e) => e.stopPropagation(),
  });
  toggle.checked = !!op.enabled;
  toggle.addEventListener('change', () => {
    doc.updateItem(op, { enabled: toggle.checked }, op.enabled ? 'disable op' : 'enable op');
  });

  // The strategy is what the operation *is*, and until now it appeared nowhere
  // in the tree — an operation called "Finish 2" told you its author's mood and
  // nothing else. The icon puts it back without spending a line on it.
  const icon = opIcon(op.type, 18);
  icon.setAttribute('class', `${icon.getAttribute('class')} tree-op-icon`);

  const visible = doc.isPathVisible(op.id);
  const eye = el('button', {
    class: `tree-eye${visible ? '' : ' off'}`,
    title: visible
      ? 'Hide this path in the viewport (it is still machined) — Alt-click to show only this one'
      : 'Show this path again',
    onclick: (e) => {
      e.stopPropagation();
      if (e.altKey) doc.soloPath(op.id); else doc.setPathVisible(op.id, !visible);
    },
  }, [visible ? '◉' : '○']);

  const node = el('div', {
    class: `tree-item tree-op${selected ? ' selected' : ''}${op.enabled ? '' : ' disabled'}`
      + `${visible ? '' : ' path-hidden'}`,
    title: catalog ? `${OP_LABELS[op.type]} — ${catalog.summary}` : OP_LABELS[op.type] ?? op.type,
    onclick: () => doc.select('op', op.id),
  }, [
    toggle,
    icon,
    nameCell(doc, op),
    ...statusBadges(doc, op),
    ...(doc.toolpaths.has(op.id) ? [eye] : []),
  ]);
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    doc.select('op', op.id);
    openContextMenu(e, menuForOperation(doc, setup, op, app));
  });
  renameOnDoubleClick(node, doc, op);
  makeReorderable(node, doc, setup, op, app);
  return node;
}

/**
 * Drag an operation row to move it in the program.
 *
 * Machining order is program order, so reordering is a real edit — and doing it
 * through a context menu two clicks at a time is the kind of thing that makes
 * people leave the order wrong. HTML5 drag and drop, so the cursor, the drag
 * image and the drop target all come from the platform.
 */
function makeReorderable(node, doc, setup, op, app) {
  node.setAttribute('draggable', 'true');
  node.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/cncam-op', op.id);
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => node.classList.remove('dragging'));

  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/cncam-op')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // which half of the row the pointer is over decides above or below, so a
    // drop lands where the line is drawn
    const r = node.getBoundingClientRect();
    node.classList.toggle('drop-above', e.clientY < r.top + r.height / 2);
    node.classList.toggle('drop-below', e.clientY >= r.top + r.height / 2);
  });
  const clear = () => node.classList.remove('drop-above', 'drop-below');
  node.addEventListener('dragleave', clear);

  node.addEventListener('drop', (e) => {
    const movedId = e.dataTransfer.getData('text/cncam-op');
    clear();
    if (!movedId || movedId === op.id) return;
    e.preventDefault();
    const from = setup.operations.findIndex((o) => o.id === movedId);
    if (from < 0) return;    // dragged in from another setup; not supported yet
    const r = node.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    let to = setup.operations.indexOf(op) + (before ? 0 : 1);
    if (from < to) to -= 1;  // removing the dragged row first shifts everything after it
    if (to !== from) app?.actions?.reorderOperation?.(setup, from, to);
  });
}

/**
 * The badge on the right of an operation row.
 *
 * An operation that generated nothing looks exactly like one that has not been
 * generated yet — both show an empty viewport. A "!" that says so, on the row
 * itself, is what turns "some toolpaths don't do anything" from a mystery into
 * a message.
 */
function statusBadges(doc, op) {
  const blocked = opBlockedReason(doc, op);
  if (blocked && blocked !== 'disabled') {
    return [el('span', { class: 'tree-badge warn', title: `Cannot generate: ${blocked}` }, ['!'])];
  }
  const status = opStatus(doc, op);
  if (!status) {
    // never generated: say whether it *would* work, so a problem is found
    // while the settings are on screen rather than after a wait
    const problems = opPreflight(doc, op);
    return problems.length
      ? [el('span', { class: 'tree-badge warn', title: problems.join('\n') }, ['!'])]
      : [];
  }
  if (status.level === 'warn') {
    const why = status.warnings[0]?.text ?? 'this operation produced no cutting moves';
    return [el('span', { class: 'tree-badge warn', title: why }, ['!'])];
  }
  if (status.stale) {
    // the drawn path is not the path these settings describe any more
    return [el('span', {
      class: 'tree-badge stale',
      title: 'Settings changed since this was generated — the path on screen is the old one',
    }, ['↻'])];
  }
  return [el('span', {
    class: 'tree-badge',
    title: `${status.cuts} cutting moves · ${status.lengthText} of cut`,
  }, [status.timeText])];
}

/**
 * The strategy picker behind "+ Add operation".
 *
 * The strategy is the first thing you know about an operation and the thing
 * every parameter depends on, so it is asked up front, on cards that say what
 * each one is for — see strategy-picker.js for why that is not a dropdown.
 */
function openAddOperation(setup, app) {
  openStrategyPicker({
    title: `Add an operation to ${setup.name}`,
    confirm: 'Add operation',
    mode: setup.mode ?? 'mill',
    onPick: (type) => app?.actions?.addOperationTo?.(setup, type),
  });
}

// --- context menus per kind ---

/** The menu entry that does what a double-click on the row does. */
function renameItem(doc, item) {
  return {
    label: 'Rename',
    hint: 'Or double-click the row',
    onclick: () => beginRename(doc, item.id),
  };
}

function menuForModel(doc, model, app) {
  return [
    renameItem(doc, model),
    {
      label: 'Remove from project', danger: true,
      onclick: () => app?.actions?.deleteItem('model', model.id),
    },
  ];
}

function menuForDrawing(doc, drawing, app) {
  const { operations } = doc.usageOf('drawing', drawing.id);
  return [
    renameItem(doc, drawing),
    {
      label: 'Engrave this drawing',
      hint: 'Adds an engraving pass already pointed at it',
      onclick: () => app?.actions?.engraveDrawing?.(drawing),
    },
    { separator: true },
    {
      label: 'Remove drawing',
      danger: true,
      hint: operations ? `${plural(operations, 'operation')} ${operations === 1 ? 'follows' : 'follow'} it` : undefined,
      onclick: () => app?.actions?.deleteItem('drawing', drawing.id),
    },
  ];
}

/**
 * Everything you can do to a cutter, on the row it is on.
 *
 * This used to be rename and delete, which is a strange pair to offer on its
 * own: renaming a tool is the one thing about it that changes nothing, and the
 * thing you actually right-click a tool for — open it and change it — was
 * reachable only by selecting the row and finding a button at the bottom of the
 * properties panel. Editing goes first, because it is the answer to the
 * question that made you right-click.
 */
function menuForTool(doc, tool, app) {
  const { operations } = doc.usageOf('tool', tool.id);
  const actions = app?.actions;
  const hasPhoto = isPhoto(tool.image);
  return [
    {
      label: 'Edit in the builder…',
      hint: 'The dialog it was made in — every size, with the drawing and the checks',
      onclick: () => actions?.editTool(tool),
    },
    renameItem(doc, tool),
    { separator: true },
    {
      label: 'Duplicate tool',
      hint: 'The same cutter on the next free T number — for one size held twice',
      onclick: () => actions?.duplicateTool(tool),
    },
    {
      label: 'Save to my library',
      hint: 'Keep this cutter for other projects — it joins "My tools" in the library',
      onclick: () => actions?.saveToolToLibrary(tool),
    },
    { separator: true },
    // A photo is a label you add to a tool you already have, usually while
    // holding it — so it is offered where the tool is, not eight clicks into
    // the builder. See app/tool-photo.js.
    {
      label: hasPhoto ? 'Replace the photo…' : 'Add a photo…',
      hint: 'An image file — the picture stands in for the drawing wherever this tool is listed',
      onclick: () => actions?.setToolPhoto(tool, 'file'),
    },
    {
      label: 'Photograph it…',
      hint: 'Hold the cutter up to the webcam',
      onclick: () => actions?.setToolPhoto(tool, 'camera'),
    },
    ...(hasPhoto ? [{
      label: 'Remove the photo',
      hint: 'Go back to the drawing generated from its numbers',
      onclick: () => actions?.setToolPhoto(tool, null),
    }] : []),
    { separator: true },
    {
      label: 'Remove tool', danger: true,
      hint: operations ? `${plural(operations, 'operation')} ${operations === 1 ? 'uses' : 'use'} this tool` : undefined,
      onclick: () => actions?.deleteItem('tool', tool.id),
    },
  ];
}

function menuForSetup(doc, setup, app) {
  const turning = (setup.mode ?? 'mill') === 'turn';
  return [
    renameItem(doc, setup),
    { label: 'Add operation…', onclick: () => openAddOperation(setup, app) },
    ...holdingMenu(setup, app, turning).map((item) => (item.separator ? item : {
      ...item, label: `Add ${item.label.toLowerCase()}`,
    })),
    { separator: true },
    {
      label: 'Duplicate setup',
      hint: 'Stock, fixturing, clamps and every operation — the start of a second op',
      onclick: () => app?.actions?.duplicateSetup(setup),
    },
    { separator: true },
    {
      label: 'Delete setup', danger: true,
      onclick: () => app?.actions?.deleteItem('setup', setup.id),
    },
  ];
}

function menuForOperation(doc, setup, op, app) {
  const index = setup.operations.indexOf(op);
  const actions = app?.actions;
  const visible = doc.isPathVisible(op.id);
  return [
    renameItem(doc, op),
    {
      label: 'Change strategy…',
      hint: OP_CATALOG[op.type]?.summary,
      onclick: () => openStrategyPicker({
        current: op.type,
        title: `Strategy for ${op.name}`,
        confirm: 'Use',
        mode: setup.mode ?? 'mill',
        onPick: (type) => type !== op.type && actions?.retypeOperation(op, type),
      }),
    },
    {
      label: op.enabled ? 'Disable' : 'Enable',
      hint: 'A disabled operation is skipped when generating, posting and simulating',
      onclick: () => doc.updateItem(op, { enabled: !op.enabled }, 'toggle op'),
    },
    ...(doc.toolpaths.has(op.id) ? [
      {
        label: visible ? 'Hide this path' : 'Show this path',
        hint: 'Only changes what is drawn — the operation is still machined',
        onclick: () => doc.setPathVisible(op.id, !visible),
      },
      { label: 'Show only this path', onclick: () => doc.soloPath(op.id) },
      { label: 'Show every path', onclick: () => doc.showAllPaths() },
    ] : []),
    { label: 'Duplicate', onclick: () => actions?.duplicateOperation(op) },
    { separator: true },
    // machining order is program order, so moving an operation is a real edit
    ...(index > 0
      ? [{ label: 'Move up', onclick: () => actions?.moveOperation(op, -1) }] : []),
    ...(index < setup.operations.length - 1
      ? [{ label: 'Move down', onclick: () => actions?.moveOperation(op, 1) }] : []),
    { separator: true },
    { label: 'Delete operation', danger: true, onclick: () => actions?.deleteItem('op', op.id) },
  ];
}
