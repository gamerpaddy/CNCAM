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
import { paramRow, hintStyle, propRow } from './fields.js';
import { setSetting } from '../settings.js';
import { resultSection } from './reports.js';

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
 * How settings are explained, remembered between sessions.
 *
 * Three states, and the middle one is the default: hover a field and a bubble
 * beside it says what it does, with a drawing of it where the setting is a
 * distance on a picture — which most of them are. See props/hint-bubble.js.
 */
const HINT_STYLES = [
  ['bubble', 'On hover', 'A bubble beside the field, with a diagram where there is one'],
  ['inline', 'Always', 'Printed under every field — thorough, and long'],
  ['off', 'Off', 'No explanations anywhere'],
];

function helpToggleRow(app) {
  const style = hintStyle(app);
  const seg = el('div', { class: 'seg-control' }, HINT_STYLES.map(([key, text, why]) =>
    el('button', {
      class: key === style ? 'seg-on' : '',
      title: why,
      onclick: () => {
        app.hintStyle = key;
        setSetting('hintStyle', key);
        app.rerenderProps?.();
      },
    }, [text])));
  return el('div', { class: 'prop-row op-help-toggle' }, [
    el('label', {}, ['Explain settings']), seg,
  ]);
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

  rows.push(helpToggleRow(app));
  const activeGroups = OP_PARAM_GROUPS.filter((g) => g.tab === current);
  for (const group of activeGroups) {
    const fields = group.fields.filter((f) => paramApplies(f, op));
    if (fields.length === 0) continue;
    rows.push(el('h2', {}, [group.title]));
    for (const f of fields) rows.push(paramRow(doc, op, f, app));
  }
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
