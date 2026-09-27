// Every key the app answers to, in one table.
//
// The keys used to be an if-ladder in main.js and the list of them was nowhere,
// which is two problems: a user cannot find out that Ctrl+D duplicates an
// operation, and a shortcut added to the ladder never reaches any help text
// because there is none to reach. Binding and documentation now come from the
// same array, so they cannot drift apart.
//
// `keys` is the spec and the label at once — 'Ctrl+G' both matches and reads.

import { beginRename } from './tree.js';
import { getSetting } from './settings.js';

/**
 * @param ctx the app context (doc, actions, viewport…)
 * @returns [{ group, keys, label, run, whileTyping }]
 */
export function shortcuts(ctx) {
  const selectedOp = () => (ctx.doc.selection?.kind === 'op' ? ctx.doc.findSelected() : null);

  return [
    { id: 'generate', group: 'Job', keys: 'Ctrl+G', label: 'Generate toolpaths', run: () => ctx.actions.generate() },
    {
      group: 'Job',
      id: 'simulate',
      keys: 'S',
      label: 'Simulate the program (generates first if needed)',
      run: () => ctx.actions.simulateOrGenerate(),
    },
    {
      group: 'Job',
      id: 'export',
      keys: 'Ctrl+E',
      label: 'Export G-code',
      run: () => ctx.actions.exportGcode(),
    },
    {
      group: 'Job',
      id: 'save',
      keys: 'Ctrl+S',
      label: 'Save the project',
      run: () => ctx.actions.saveProject(),
    },
    {
      group: 'Job',
      id: 'import',
      keys: 'Ctrl+I',
      label: 'Import a model',
      run: () => ctx.actions.openModel(),
    },

    {
      id: 'addOperation',
      group: 'Operations',
      keys: 'A',
      label: 'Add an operation to the setup you are working in',
      // The same action as "+ Add operation…" in the tree: to the setup being
      // worked on — whatever is selected in it — and a first setup made if the
      // machine has none. This key used to refuse with "Add a setup first"
      // where the checklist quietly made one.
      run: () => ctx.actions.addOperation(),
    },
    {
      id: 'duplicate',
      group: 'Operations',
      keys: 'Ctrl+D',
      label: 'Duplicate the selected operation',
      enabled: () => !!selectedOp(),
      run: () => ctx.actions.duplicateOperation(selectedOp()),
    },
    {
      id: 'hidePath',
      group: 'Operations',
      keys: 'H',
      label: "Hide or show the selected operation's path",
      enabled: () => !!selectedOp(),
      run: () => {
        const op = selectedOp();
        ctx.doc.setPathVisible(op.id, !ctx.doc.isPathVisible(op.id));
      },
    },
    {
      id: 'showAllPaths',
      group: 'Operations',
      keys: 'Shift+H',
      label: 'Show every path again',
      run: () => ctx.doc.showAllPaths(),
    },
    {
      id: 'delete',
      group: 'Operations',
      keys: 'Delete',
      label: 'Delete the selected item',
      run: () => ctx.actions.deleteSelected(),
    },

    { id: 'undo', group: 'Editing', keys: 'Ctrl+Z', label: 'Undo', run: () => ctx.actions.undo() },
    { id: 'redo', group: 'Editing', keys: 'Ctrl+Y', label: 'Redo', run: () => ctx.actions.redo() },
    { group: 'Editing', keys: 'Ctrl+Shift+Z', label: 'Redo', run: () => ctx.actions.redo(), alias: true },

    {
      id: 'rename',
      group: 'Operations',
      keys: 'F2',
      label: 'Rename whatever is selected',
      enabled: () => !!ctx.doc.selection,
      run: () => beginRename(ctx.doc, ctx.doc.selection.id),
    },

    { id: 'fit', group: 'View', keys: 'F', label: 'Fit everything in view', run: () => ctx.actions.fitView() },
    {
      group: 'View',
      keys: 'P',
      label: 'Perspective or orthographic',
      // The key toggles what is *on screen*, which is not always what is
      // stored: on Automatic the setting says neither, and a toggle that read
      // the setting would need pressing twice to change anything.
      run: () => ctx.actions.setProjection(
        (ctx.actions.liveProjection?.() ?? getSetting('projection')) === 'orthographic'
          ? 'perspective' : 'orthographic'),
    },
    {
      group: 'View',
      id: 'options',
      keys: 'Ctrl+,',
      label: 'Options',
      run: () => ctx.actions.openOptions(),
    },
    {
      group: 'View',
      id: 'machines',
      keys: 'Ctrl+M',
      label: 'Machines',
      run: () => ctx.actions.openMachines(),
    },
    {
      group: 'View',
      keys: 'Escape',
      label: 'Stop picking faces / close a dialog',
      whileTyping: true,
      run: () => ctx.setPickMode(null),
      enabled: () => !!ctx.pickMode,
    },
    { id: 'help', group: 'View', keys: '?', label: 'This list', run: () => ctx.actions.showShortcuts() },

    // While the simulation is open, the keys every player has. Its five
    // buttons were the only transport in the app you could not drive from the
    // keyboard, and the one place you most want your eyes on the part rather
    // than on a row of small glyphs.
    ...[
      ['Space', 'Play or pause the simulation', (t) => t.togglePlay()],
      ['←', 'Step the simulation back one move', (t) => t.step(-1)],
      ['→', 'Step the simulation forward one move', (t) => t.step(1)],
      ['Home', 'Back to the start of the simulation', (t) => t.step(-Infinity)],
      ['End', 'Jump to the end of the simulation', (t) => t.step(Infinity)],
    ].map(([keys, label, act]) => ({
      group: 'Simulation',
      keys,
      label,
      enabled: () => !!ctx.ui?.timeline?.visible,
      run: () => act(ctx.ui.timeline),
    })),
  ];
}

/**
 * A tooltip with its key on the end — "Save the project (Ctrl+S)" — read from
 * the table above rather than typed into each button.
 *
 * Five of the toolbar's buttons said their key and six did not, because each
 * title was written by hand next to its button and nothing checked it against
 * the table. The table is the one place a key is bound, so it is the one place
 * a tooltip asks.
 *
 * @param id a shortcut's `id`
 */
export function withKey(title, id) {
  // the closures in the table are never called here, so an empty context is
  // enough to read the keys off it
  const entry = shortcuts({}).find((s) => s.id === id);
  return entry ? `${title} (${entry.keys})` : title;
}

/** The key a shortcut is bound to, as printed — for a menu row to show it. */
export function keyFor(id) {
  return shortcuts({}).find((s) => s.id === id)?.keys ?? null;
}

/**
 * Does this event fire this shortcut?
 *
 * Ctrl and Meta are treated as the same modifier so the app behaves on a Mac
 * without a second table. A spec with no Shift in it does not *forbid* Shift,
 * because '?' is Shift+/ on most layouts and would never match if it did.
 */
// Keys whose name in the table is what is printed on the key, not what the
// browser calls it.
const KEY_NAMES = { Space: ' ', '←': 'ArrowLeft', '→': 'ArrowRight' };

export function matchesShortcut(spec, event) {
  const parts = spec.split('+');
  const named = parts.pop();
  const key = KEY_NAMES[named] ?? named;
  const wantsCtrl = parts.includes('Ctrl');
  const wantsShift = parts.includes('Shift');
  if (wantsCtrl !== (event.ctrlKey || event.metaKey)) return false;
  if (wantsShift && !event.shiftKey) return false;
  if (!wantsShift && event.shiftKey && key.length === 1 && /[a-z]/i.test(key)) return false;
  return key.length === 1
    ? event.key.toLowerCase() === key.toLowerCase()
    : event.key === key;
}

/** Is this shortcut safe to fire while the caret is in a text field? */
export function firesWhileTyping(shortcut) {
  return shortcut.whileTyping || shortcut.keys.startsWith('Ctrl+');
}

/**
 * Bind the table to a target. Returns a stop function.
 *
 * A shortcut whose `enabled` says no is not swallowed — it simply does not
 * fire, so Delete in a text field still deletes a character.
 */
export function bindShortcuts(target, ctx) {
  const table = shortcuts(ctx);
  const onKeyDown = (event) => {
    // A modal dialog owns the keyboard. Every key here acts on the project
    // behind it, which the dialog is hiding: with a button focused in the
    // Machines dialog, Delete deleted the selected operation, S started a
    // simulation and A opened a second dialog on top of the first. Escape is
    // the dialog's own (it closes it), and nothing else is meant for the app.
    if (modalOpen()) return;
    const typing = /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)
      || event.target.isContentEditable;
    for (const shortcut of table) {
      if (!matchesShortcut(shortcut.keys, event)) continue;
      if (typing && !firesWhileTyping(shortcut)) continue;
      if (shortcut.enabled && !shortcut.enabled()) continue;
      event.preventDefault();
      shortcut.run();
      return;
    }
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}

/**
 * Whether a modal dialog is up — `:modal` where the browser knows it — or a
 * popup menu, which owns the keys the same way while it is open: Delete pressed
 * with a row's menu showing deleted the row and left its menu up, offering
 * "Duplicate" and "Delete" on an operation that was gone.
 */
function modalOpen() {
  if (typeof document === 'undefined') return false;
  if (document.querySelector('.context-menu')) return true;
  try {
    return !!document.querySelector('dialog:modal');
  } catch {
    return !!document.querySelector('dialog[open]');
  }
}

/** The table as the help dialog wants it: grouped, aliases folded away. */
export function shortcutGroups(ctx) {
  const groups = new Map();
  for (const shortcut of shortcuts(ctx)) {
    if (shortcut.alias) continue;
    if (!groups.has(shortcut.group)) groups.set(shortcut.group, []);
    groups.get(shortcut.group).push(shortcut);
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
}
