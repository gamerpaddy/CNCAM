// The operation panel: strategy, cutter, result, regions, then the tabbed
// parameters for whichever strategy is in force.
//
// The order is the order the questions arrive in. What kind of cut is this;
// what is cutting it; what did it do last time; where on the part does it
// apply; and only then the numbers.

import { el } from '../layout.js';
import { strategyCard, opIcon, describeIntent } from '../op-catalog.js';
import { openStrategyPicker } from '../strategy-picker.js';
import { OP_PARAM_GROUPS, paramApplies, tabsForOp } from '../op-params.js';
import {
  PICK_MODES, PICK_KINDS, PICK_KIND_LABELS, regionCount,
} from '../regions-ui.js';
import { toolIcon, describeTool } from '../tool-shape.js';
import { machineCanHold } from '../../doc/tool-library.js';
import { paramRow, propRow } from './fields.js';
import { resultSection } from './reports.js';
import { snippetsFor, saveSnippet, deleteSnippet } from '../../doc/gcode-snippets.js';

/**
 * The strategy, shown as what it is rather than as an entry in a dropdown.
 *
 * A name in a select box is the least informative way to present the single
 * decision the rest of the panel depends on. This says what the operation does,
 * and opens the same card picker the tree uses to change it.
 */
function strategyRow(doc, op, app) {
  const card = strategyCard(op.type);
  return el('button', {
    class: 'strategy-current-card',
    title: 'Change the machining strategy',
    onclick: () => openStrategyPicker({
      current: op.type,
      title: `Strategy for ${op.name}`,
      confirm: 'Use',
      mode: doc.findSetupOf(op.id)?.mode ?? 'mill',
      onPick: (type) => type !== op.type && app.actions?.retypeOperation(op, type),
    }),
  }, [
    opIcon(op.type, 28),
    el('div', { class: 'strategy-current-text' }, [
      el('div', { class: 'strategy-name' }, [card.label]),
      el('div', { class: 'strategy-summary' }, [card.summary]),
    ]),
    el('span', { class: 'strategy-change' }, ['change…']),
  ]);
}

/**
 * What this operation, with these settings and this cutter, is going to do —
 * in a sentence, before any of the numbers.
 *
 * The panel is a grid of fields, and a grid of fields never says what the sum
 * of them comes to. Reading it back as prose is what catches the mismatch
 * between what you meant and what you typed, and it costs nothing to read.
 */
function intentRow(doc, op) {
  const tool = doc.project.tools.find((t) => t.id === op.toolId);
  const text = describeIntent(op, tool);
  if (!text) return null;
  return el('div', { class: 'op-intent' }, [text]);
}

/**
 * The operation panel, in three bands: what this operation is, which part of it
 * you are editing, and that part.
 *
 * The order used to be identity, then *result*, then *regions*, and only then
 * the tabs — which put the tab bar 542 pixels down a 649-pixel panel on a
 * roughing operation. Tabs you have to scroll to find are not tabs; they are a
 * section heading that happens to be clickable, and the panel read as one
 * endless column with a scrollbar. Result and Regions are now tabs of their own,
 * which is what they always were: two more things you might be looking at, not
 * two things you are always looking at.
 */
export function opSections(doc, op, app) {
  const rows = [strategyRow(doc, op, app)];
  const intent = intentRow(doc, op);
  if (intent) rows.push(intent);
  // A command has exactly one thing to set and no cutter to set it with, so it
  // gets neither the tool row nor the tab bar: every tab on it would be a page
  // of heights, stepovers and feeds that nothing reads. See the section below.
  if (op.type === 'command') {
    rows.push(...commandSection(doc, op, app));
    return rows;
  }
  rows.push(toolSelectRow(doc, op, app));

  // Regions are faces picked off the model, which is a milling idea: a turned
  // part is a profile — a radius for every Z — and there are no faces on it to
  // pick. Offering the controls anyway was two buttons that armed the viewport
  // for a click that could never mean anything.
  const milling = (doc.findSetupOf(op.id)?.mode ?? 'mill') !== 'turn';
  const tabs = [
    ...tabsForOp(op),
    ...(milling ? [{ key: 'regions', label: 'Regions' }] : []),
    { key: 'result', label: 'Result' },
  ];
  if (tabs.length === 0) return rows;

  // remember which tab was active per op so switching between ops does not
  // yank the user back to the first tab every time
  app.opTabs ??= new Map();
  const active = app.opTabs.get(op.id) ?? tabs[0].key;
  app.opTabs.set(op.id, tabs.some((t) => t.key === active) ? active : tabs[0].key);
  const current = app.opTabs.get(op.id);

  const badge = (key) => {
    if (key !== 'regions') return '';
    const picked = regionCount(op, 'include') + regionCount(op, 'avoid');
    return picked > 0 ? ` (${picked})` : '';
  };
  rows.push(el('div', { class: 'op-tabs' },
    tabs.map((t) => el('button', {
      class: `op-tab${current === t.key ? ' active' : ''}`,
      onclick: () => {
        app.opTabs.set(op.id, t.key);
        // Leaving Regions puts the picker away with it — the buttons that say
        // what a click on the model means are on that tab, so a click anywhere
        // else has nothing to mean. setPickMode re-renders and says so on the
        // status line; rerenderProps alone would leave both stale.
        if (t.key !== 'regions' && app.pickMode) app.setPickMode?.(null);
        else app.rerenderProps?.();
      },
    }, [`${t.label}${badge(t.key)}`]))));

  if (current === 'result') { rows.push(...resultSection(doc, op)); return rows; }
  if (current === 'regions') { rows.push(...regionSection(doc, op, app)); return rows; }

  const activeGroups = OP_PARAM_GROUPS.filter((g) => g.tab === current);
  for (const group of activeGroups) {
    const fields = group.fields.filter((f) => paramApplies(f, op));
    if (fields.length === 0) continue;
    rows.push(el('h2', {}, [group.title]));
    for (const f of fields) rows.push(paramRow(doc, op, f, app));
  }
  return rows;
}

/**
 * The whole of a command operation: the lines, and the presets they come from.
 *
 * A monospaced box rather than a field, because what goes in it is a program
 * and reading it back is half of trusting it. Nothing about it is validated —
 * see engine/strategies/command.js for why that is the point — so the panel's
 * job is to show exactly what will be written and where it will land.
 */
function commandSection(doc, op, app) {
  const rows = [];
  const machine = doc.machineRecord();
  const text = String(op.params?.gcode ?? '');

  const box = el('textarea', {
    class: 'gcode-command',
    rows: '8',
    spellcheck: 'false',
    placeholder: 'M5\nM0 (change to the 6mm cutter by hand, then Cycle Start)\nM3 S9000',
  });
  box.value = text;
  // On change rather than on input: every keystroke would be an undo step, and
  // an undo stack with one entry per character is an undo stack you cannot use.
  box.addEventListener('change', () => {
    if (box.value === text) return;
    doc.updateItem(op, { params: { ...op.params, gcode: box.value } }, `edit ${op.name}`);
  });
  rows.push(box);
  rows.push(el('div', { class: 'prop-hint' }, [
    'Written into the program exactly as typed, where this operation stands in '
    + 'the running order. Nothing here is checked against the machine, the '
    + 'dialect or the part — that is what it is for.',
  ]));

  // --- presets -------------------------------------------------------------
  //
  // Kept in this browser and not in the project, because the block that stops
  // the spindle for a hand tool change is the shop's and not this job's. See
  // doc/gcode-snippets.js.
  const saved = snippetsFor(machine);
  const chooser = el('select', { class: 'gcode-preset-list' }, [
    el('option', { value: '' }, [saved.length ? 'Choose a preset…' : 'No presets saved yet']),
    ...saved.map((s) => el('option', { value: s.id }, [
      // Which machine it belongs to, on the entry itself: two presets called
      // "tool change" — one general and one for the router — are otherwise the
      // same line twice, and picking the wrong one is a wrong M-code.
      s.machineId ? `${s.name} — ${s.machineName || 'this machine'}` : s.name,
    ])),
  ]);
  chooser.disabled = saved.length === 0;
  const chosen = () => saved.find((s) => s.id === chooser.value) ?? null;

  // Choosing does not load, and that is deliberate twice over: a select that
  // acts the moment it changes cannot also be the thing Delete reads, and it
  // makes browsing destructive — arrowing down five presets to see what is in
  // them would overwrite the box five times.
  const loadButton = el('button', {
    title: 'Put this preset\u2019s lines in the box above',
    onclick: () => {
      const snippet = chosen();
      if (!snippet) return app.ui?.setStatus?.('Choose a preset first', true);
      // Replacing what is in the box is a real loss, so it is asked about — but
      // only when there is something to lose, because asking on an empty box is
      // a dialog in the way of the ordinary case.
      if (box.value.trim() && !confirm(
        `Replace the G-code in ${op.name} with the preset "${snippet.name}"?`)) return undefined;
      doc.updateItem(op, { params: { ...op.params, gcode: snippet.gcode } },
        `load ${snippet.name}`);
      return app.ui?.setStatus?.(`"${snippet.name}" loaded into ${op.name}`);
    },
  }, ['Load']);
  loadButton.disabled = saved.length === 0;

  const deleteButton = el('button', {
    class: 'danger',
    title: 'Remove the chosen preset from this browser',
    onclick: () => {
      const snippet = chosen();
      if (!snippet) return app.ui?.setStatus?.('Choose the preset to delete first', true);
      if (!confirm(`Delete the preset "${snippet.name}"?\n\n`
        + 'It goes out of this browser. Operations already using it keep their '
        + 'own copy of the lines.')) return undefined;
      deleteSnippet(snippet.id);
      app.rerenderProps?.();
      return app.ui?.setStatus?.(`"${snippet.name}" deleted`);
    },
  }, ['\u2715']);
  deleteButton.disabled = saved.length === 0;

  // Stacked rather than in the panel's usual two columns. The properties panel
  // is 300px wide and a label takes a third of it, which left the preset list
  // showing three characters of a name — and a list of presets you cannot read
  // is a list you cannot choose from.
  rows.push(el('div', { class: 'gcode-preset-block' }, [
    el('label', {}, ['Presets']),
    el('div', { class: 'gcode-preset-row' }, [chooser, loadButton, deleteButton]),
  ]));

  const forAll = el('input', { type: 'checkbox' });
  const nameBox = el('input', { type: 'text', placeholder: 'Name this block' });
  const save = el('button', {
    title: 'Keep these lines for other projects — they are saved in this browser',
    onclick: () => {
      const name = nameBox.value.trim();
      if (!name) return app.ui?.setStatus?.('Give the preset a name first', true);
      if (!box.value.trim()) return app.ui?.setStatus?.('There is no G-code to save', true);
      const scope = forAll.checked ? null : machine;
      const snippet = saveSnippet(name, box.value, scope);
      if (!snippet) {
        return app.ui?.setStatus?.('Could not save it — browser storage is full or unavailable', true);
      }
      nameBox.value = '';
      app.rerenderProps?.();
      return app.ui?.setStatus?.(`"${name}" saved for `
        + (scope ? scope.name : 'every machine'));
    },
  }, ['Save as preset']);
  rows.push(el('div', { class: 'gcode-preset-block' }, [
    el('label', {}, ['Save these lines as a preset']),
    el('div', { class: 'gcode-preset-row' }, [nameBox, save]),
    el('label', { class: 'toggle gcode-preset-scope' }, [forAll, 'For every machine']),
  ]));
  rows.push(el('div', { class: 'prop-hint' }, [
    'Left unticked it is saved against ' + (machine?.name ?? 'this machine')
    + ' alone and never offered on another. An M-code that opens the guard on '
    + 'one control means something else on the next, so a preset only shows up '
    + 'where it was saved.',
  ]));

  return rows;
}

const PICK_LABELS = {
  include: { title: 'Machine only these', verb: 'machine' },
  avoid: { title: 'Never machine', verb: 'avoid' },
};

function regionSection(doc, op, app) {
  const rows = [];
  const active = app.pickMode;
  const kind = app.pickKind ?? 'face';
  const noun = kind === 'edge' ? 'edges' : 'faces';

  // What a click means, before what it does with it. An edge and the face it
  // bounds are both under the cursor at once, so the app has to be told which
  // one was meant — there is no reading of a single click that gets both.
  const kindRow = el('div', { class: 'seg-control' }, PICK_KINDS.map((k) => el('button', {
    class: k === kind ? 'seg-on' : '',
    title: k === 'edge'
      ? 'Pick the crease between two faces — for breaking a specific corner'
      : 'Pick a whole surface',
    onclick: () => app.setPickKind?.(k),
  }, [PICK_KIND_LABELS[k]])));
  rows.push(el('div', { class: 'prop-row' }, [el('label', {}, ['Pick']), kindRow]));

  for (const mode of PICK_MODES) {
    const count = regionCount(op, mode);
    const armed = active === mode;
    const button = el('button', {
      class: armed ? 'pick-active' : '',
      onclick: () => app.setPickMode?.(armed ? null : mode),
    }, [armed ? 'Picking… (click to stop)' : `Pick ${noun} to ${PICK_LABELS[mode].verb}`]);
    rows.push(el('div', { class: 'prop-row' }, [
      el('label', {}, [`${PICK_LABELS[mode].title} (${count})`]),
      button,
    ]));
  }

  const total = regionCount(op, 'include') + regionCount(op, 'avoid');
  if (total > 0) {
    rows.push(el('div', { class: 'prop-row' }, [
      el('label', {}, ['']),
      el('button', {
        onclick: () => doc.updateItem(op, { regions: { include: [], avoid: [] } }, 'clear regions'),
      }, ['Clear picks']),
    ]));
  }
  rows.push(el('div', { class: 'prop-note' }, [
    total === 0
      ? `Nothing picked — the whole part is machined. Pick ${noun} to narrow it down.`
      : kind === 'edge' && op.type === 'chamfer'
        ? 'A picked edge chamfers that edge and no other.'
        : 'Regions are grown by the tool radius, so the cutter stays off avoided faces.',
  ]));
  return rows;
}

function toolSelectRow(doc, op, app) {
  const machine = doc.findSetupOf(op.id)?.mode ?? 'mill';
  const chosen = doc.project.tools.find((t) => t.id === op.toolId);
  // Only what this machine can hold — offering an end mill to a turning pass is
  // offering a choice that cannot work. The tool already assigned stays in the
  // list whatever it is, because a wrong assignment you can see is better than
  // a dropdown that silently reads as empty.
  const tools = doc.project.tools.filter(
    (t) => machineCanHold(t.type, machine) || t.id === op.toolId);
  const select = el('select', {}, [
    el('option', { value: '' }, ['— select tool —']),
    ...tools.map((t) => el('option', { value: t.id }, [
      `T${t.number} ${t.name}${machineCanHold(t.type, machine) ? '' : ' (other machine)'}`,
    ])),
  ]);
  select.value = op.toolId ?? '';
  // Through the action rather than straight onto the document: a different
  // cutter takes the stepping that was derived from the old one with it, which
  // writing `toolId` alone silently did not — see actions/editing.js assignTool.
  select.addEventListener('change', () => {
    if (app?.actions?.assignTool) app.actions.assignTool(op, select.value || null);
    else doc.updateItem(op, { toolId: select.value || null }, 'assign tool');
  });

  const row = propRow('Tool', select);
  if (!chosen) return row;
  // which cutter is in the spindle decides what the operation can reach, so it
  // is shown rather than left as a name in a dropdown
  return el('div', {}, [
    row,
    el('div', { class: 'tool-inline' }, [
      toolIcon(chosen, { width: 30, height: 32 }),
      el('span', {}, [describeTool(chosen)]),
    ]),
  ]);
}
