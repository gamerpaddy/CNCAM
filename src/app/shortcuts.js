// Every key the app answers to, in one table.
//
// The keys used to be an if-ladder in main.js and the list of them was nowhere,
// which is two problems: a user cannot find out that Ctrl+D duplicates an
// operation, and a shortcut added to the ladder never reaches any help text
// because there is none to reach. Binding and documentation now come from the
// same array, so they cannot drift apart.
//
// `keys` is the spec and the label at once — 'Ctrl+G' both matches and reads.

import { openStrategyPicker } from './strategy-picker.js';
import { beginRename } from './tree.js';
import { getSetting } from './settings.js';

/**
 * @param ctx the app context (doc, actions, viewport…)
 * @returns [{ group, keys, label, run, whileTyping }]
 */
export function shortcuts(ctx) {
  const selectedOp = () => (ctx.doc.selection?.kind === 'op' ? ctx.doc.findSelected() : null);

  return [
    { group: 'Job', keys: 'Ctrl+G', label: 'Generate toolpaths', run: () => ctx.actions.generate() },
    {
      group: 'Job',
      keys: 'S',
      label: 'Simulate the program (generates first if needed)',
      run: () => ctx.actions.simulateOrGenerate(),
    },
    {
      group: 'Job',
      keys: 'Ctrl+E',
      label: 'Export G-code',
      run: () => ctx.actions.exportGcode(),
    },
    {
      group: 'Job',
      keys: 'Ctrl+S',
      label: 'Save the project',
      run: () => ctx.actions.saveProject(),
    },
    {
      group: 'Job',
      keys: 'Ctrl+I',
      label: 'Import a model',
      run: () => ctx.actions.openModel(),
    },

    {
      group: 'Operations',
      keys: 'A',
      label: 'Add an operation to the first setup',
      run: () => {
        const setup = ctx.doc.setups()[0];
        if (!setup) return ctx.ui.setStatus('Add a setup first', true);
        openStrategyPicker({
          title: `Add an operation to ${setup.name}`,
          mode: setup.mode ?? 'mill',
          onPick: (type) => ctx.actions.addOperationTo(setup, type),
        });
      },
    },
    {
      group: 'Operations',
      keys: 'Ctrl+D',
      label: 'Duplicate the selected operation',
      enabled: () => !!selectedOp(),
      run: () => ctx.actions.duplicateOperation(selectedOp()),
    },
    {
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
      group: 'Operations',
      keys: 'Shift+H',
      label: 'Show every path again',
      run: () => ctx.doc.showAllPaths(),
    },
    {
      group: 'Operations',
      keys: 'Delete',
      label: 'Delete the selected item',
      run: () => ctx.actions.deleteSelected(),
    },

    { group: 'Editing', keys: 'Ctrl+Z', label: 'Undo', run: () => ctx.doc.undo() },
    { group: 'Editing', keys: 'Ctrl+Y', label: 'Redo', run: () => ctx.doc.redo() },
    { group: 'Editing', keys: 'Ctrl+Shift+Z', label: 'Redo', run: () => ctx.doc.redo(), alias: true },

    {
      group: 'Operations',
      keys: 'F2',
      label: 'Rename whatever is selected',
      enabled: () => !!ctx.doc.selection,
      run: () => beginRename(ctx.doc, ctx.doc.selection.id),
    },

    { group: 'View', keys: 'F', label: 'Fit everything in view', run: () => ctx.actions.fitView() },
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
      keys: 'Ctrl+,',
      label: 'Options',
      run: () => ctx.actions.openOptions(),
    },
    {
      group: 'View',
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
    { group: 'View', keys: '?', label: 'This list', run: () => ctx.actions.showShortcuts() },
  ];
}

/**
 * Does this event fire this shortcut?
 *
 * Ctrl and Meta are treated as the same modifier so the app behaves on a Mac
 * without a second table. A spec with no Shift in it does not *forbid* Shift,
 * because '?' is Shift+/ on most layouts and would never match if it did.
 */
export function matchesShortcut(spec, event) {
  const parts = spec.split('+');
  const key = parts.pop();
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
