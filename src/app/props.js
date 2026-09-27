// Properties panel: schema-driven editor for whatever the tree has selected.
//
// The panel itself is thin — it picks the field list for the selected kind,
// renders it, and appends whichever of the bigger sections apply. Those live in
// ./props/: the setup panel, the operation panel, the shared field renderer and
// the read-outs.

import { el } from './layout.js';
import { plural } from '../engine/text.js';
import { TOOL_TYPES, TOOL_TYPE_LABELS } from '../doc/schema.js';
import { toolIcon, toolAssembly, describeTool } from './tool-shape.js';
import {
  toolLength, toolMaxRadius, fluteLengthOf, reachCheck, latheReachOf,
} from '../engine/tool-geometry.js';
import {
  isLatheTool, insertIcOf, parseInsertCode,
  INSERT_LETTERS, INSERT_SHAPE_LABELS, INSERT_SHAPES, INSERT_NOTES,
  INSERT_HANDS, INSERT_HAND_LABELS,
} from '../engine/insert.js';
import {
  FIXTURE_KINDS, FIXTURE_KIND_LABELS, CHUCK_MODES, CHUCK_MODE_LABELS,
} from '../engine/fixtures.js';
import {
  DRAWING_ORIGINS, DRAWING_ORIGIN_LABELS, DRAWING_ORIGIN_HINTS,
  placedPaths, boundsOfPaths, overhangOf,
} from '../engine/drawing.js';
import { totalLength } from '../io/dxf.js';
import { computeBounds } from '../geom/mesh.js';
import {
  toolWarnings, cuttingReadout, defaultsForType, suggestCutting, machineCanHold,
} from '../doc/tool-library.js';
import { toolNumberClashes } from './op-status.js';
import { reportRows } from './props/reports.js';
import { fieldRow } from './props/fields.js';
import { setupSections } from './props/setup-panel.js';
import { opSections } from './props/op-panel.js';
import { removalOf } from './item-labels.js';
import { icon } from './icons.js';
import { opIcon } from './op-catalog.js';
import { openContextMenu, anchorBelow } from './context-menu.js';
import { menuForItem } from './tree.js';
import { withKey } from './shortcuts.js';
import { opStatus, opBlockedReason, formatTime } from './op-status.js';

// The name of whatever is selected is not a row in these lists: it is the
// title of the panel, typed into where it is shown — see inspectorHead.
const FIELDS = {
  model: [],
  // An imported DXF: where it lands on the billet, how big, and which way up.
  // The file's own coordinates are almost never the part's, so this is the
  // whole of what has to be said about a drawing. See engine/drawing.js.
  drawing: [
    {
      path: 'placement.origin', label: 'Placed', type: 'select',
      options: DRAWING_ORIGINS, labels: DRAWING_ORIGIN_LABELS,
      hintFor: (d) => DRAWING_ORIGIN_HINTS[d.placement?.origin ?? 'stock-center'],
    },
    { path: 'placement.offset.0', label: 'Shift X (mm)', type: 'number' },
    { path: 'placement.offset.1', label: 'Shift Y (mm)', type: 'number' },
    { path: 'placement.rotationDeg', label: 'Rotate (°)', type: 'number' },
    {
      path: 'placement.scale', label: 'Scale (×)', type: 'number', min: 0.001,
      hint: 'A drawing exported in inches from a package that did not say so '
        + 'arrives 25.4 times too small. This is where that is fixed.',
    },
    {
      path: 'placement.mirrorX', label: 'Mirror', type: 'checkbox',
      hint: 'For a stamp, a mould half, or the underside of a plate',
    },
  ],
  tool: [
    // A whole number from 1: T0 is "no tool" on most controls, and the post
    // writes the number into the length offset too — T0 M6 / G43 H0 is an
    // empty spindle with its length comp cancelled, and every Z after it off by
    // the length of the tool. A fraction is not a word any control reads.
    { path: 'number', label: 'Tool number', type: 'number', min: 1, step: 1, integer: true },
    {
      path: 'type', label: 'Type', type: 'select',
      options: TOOL_TYPES, labels: TOOL_TYPE_LABELS,
      // The wizard's family cards and this dropdown are the same decision, and
      // only the cards used to re-derive: retyping a ⌀6 flat as a boring bar
      // left a ⌀6 bar with no nose radius, no minimum bore and no reach — three
      // fields that decide whether it can cut at all, all silently zero.
      onChange: applyToolType,
    },
    {
      path: 'diameter', label: 'Diameter (mm)', type: 'number', min: 0.01, when: (t) => !isInsertTool(t),
      heading: 'Geometry',
    },
    // --- lathe inserts ---
    {
      path: 'insertCode', label: 'ISO code', type: 'text', when: isInsertTool,
      heading: 'Geometry',
      hint: 'Type the designation off the box — TNMG160408, WNMG080408 — and the '
        + 'shape, size and nose radius below fill themselves in.',
      onChange: applyInsertCode,
    },
    {
      path: 'insert', label: 'Insert shape', type: 'select',
      options: INSERT_LETTERS, labels: INSERT_SHAPE_LABELS, when: isInsertTool,
      hintFor: (t) => INSERT_NOTES[t.insert] ?? null,
    },
    {
      path: 'insertIc', label: 'Inscribed circle (mm)', type: 'number', when: isInsertTool,
      hint: 'The circle that fits inside the insert and touches every edge — how '
        + 'big it is, in the number catalogues quote.',
    },
    {
      path: 'hand', label: 'Hand', type: 'select',
      options: INSERT_HANDS, labels: INSERT_HAND_LABELS, when: isInsertTool,
      hint: 'Which way the tool cuts, and therefore which side of the cut its '
        + 'holder sits on',
    },
    {
      path: 'diameter', label: 'Bar diameter (mm)', type: 'number',
      when: (t) => t.type === 'boring',
    },
    {
      path: 'minBore', label: 'Smallest bore (mm)', type: 'number',
      when: (t) => t.type === 'boring' || t.type === 'parting' || t.type === 'threading',
      hint: 'The smallest hole this tool will go down at all',
    },
    {
      path: 'maxDepth', label: 'Reaches (mm)', type: 'number',
      when: (t) => isLatheTool(t.type),
      hint: 'How far it can work into a hole or a groove before the overhang is '
        + 'more than it can hold. Boring stops here rather than chattering.',
    },
    { path: 'cornerRadius', label: 'Corner radius (mm)', type: 'number', when: (t) => t.type === 'bull' },
    { path: 'tipAngle', label: 'Tip angle (°)', type: 'number', when: isPointed },
    {
      path: 'pitch', label: 'Pitch (mm)', type: 'number',
      when: (t) => t.type === 'tap' || t.type === 'threadmill',
      hint: 'Millimetres per turn. On a tap this is also the feed — one turn, one '
        + 'pitch — and no other number will do; on a thread mill it is the tooth '
        + 'form, so one cutter never does two pitches.',
    },
    {
      path: 'leadThreads', label: 'Lead (threads)', type: 'number',
      when: (t) => t.type === 'tap',
      hint: 'How many threads of the end are ground away as a taper. Those cut '
        + 'nothing at full depth, which is why a blind hole is tapped that much '
        + 'short of its floor.',
    },
    {
      path: 'tipDiameter', label: 'Flat on the tip (mm)', type: 'number', when: isPointed,
      hint: 'Most chamfer mills and V bits end in a small flat rather than a point. '
        + 'It shifts where the cone sits on the edge, so it is worth measuring.',
    },
    {
      path: 'noseRadius', label: 'Nose radius (mm)', type: 'number', when: isInsertTool,
      hint: 'The radius on the insert corner. A finishing pass is offset by it, '
        + 'and without it every face comes out a nose radius short.',
    },
    {
      path: 'bladeWidth', label: 'Blade width (mm)', type: 'number',
      when: (t) => t.type === 'parting' || t.type === 'threading',
      hint: 'The width of the groove the blade cuts — the material it takes out '
        + 'of the bar with every part.',
    },
    { path: 'fluteLength', label: 'Flute length (mm)', type: 'number', min: 0, when: (t) => !isLatheTool(t.type) },
    {
      path: 'flutes', label: 'Flutes', type: 'number', min: 1, step: 1, integer: true,
      when: (t) => !isLatheTool(t.type),
    },
    // None of these has a zero that means anything. A 0 rpm spindle posts
    // M3 S0 and feeds a stopped cutter into the work; a 0 feed was quietly
    // replaced by the plunge feed. See op-status.js opPreflight for a tool that
    // arrives with one from an older file.
    { path: 'spindleRpm', label: 'Spindle RPM', type: 'number', min: 1, heading: 'Speeds and feeds' },
    { path: 'feedCut', label: 'Feed (mm/min)', type: 'number', min: 1 },
    { path: 'feedPlunge', label: 'Plunge (mm/min)', type: 'number', min: 1 },
  ],
  // The work offset is with the zero point, in the setup panel's Orientation —
  // see props/setup-panel.js.
  setup: [],
  // Whether the tool is kept out of it is a switch in the panel's header, as
  // an operation's "in the program" is — see inspectorHead.
  fixture: [
    {
      path: 'kind', label: 'Holding', type: 'select',
      options: FIXTURE_KINDS, labels: FIXTURE_KIND_LABELS,
    },
    // --- chuck ---
    {
      path: 'chuckMode', label: 'Grips', type: 'select',
      options: CHUCK_MODES, labels: CHUCK_MODE_LABELS, when: isChuck,
      hint: 'Gripping a bore leaves the whole outside of the part reachable, and '
        + 'blocks the inside instead — which is exactly the opposite keep-out',
    },
    {
      path: 'jaws', label: 'Jaws', type: 'number', min: 2, max: 8, when: isChuck,
      hint: 'Three for round work, four for square. Only affects the drawing.',
    },
    {
      path: 'clampDiameter', label: 'Grips at ⌀ (mm)', type: 'number', min: 0.1, when: isChuck,
      hint: 'The diameter the jaws close on — the size the bar is where it is held',
    },
    {
      path: 'faceZ', label: 'Chuck face at Z (mm)', type: 'number', when: isChuck,
      hint: 'Where the front of the chuck body sits along the bar. Everything '
        + 'behind the jaws is out of reach.',
    },
    {
      path: 'jawLength', label: 'Jaws stand out (mm)', type: 'number', min: 0, when: isChuck,
      hint: 'How far the jaws project from the face. A turning pass stops here '
        + 'and says so rather than driving the tool into them.',
    },
    { path: 'jawWidth', label: 'Jaw width (mm)', type: 'number', min: 0.1, when: isChuck },
    { path: 'bodyDiameter', label: 'Chuck body ⌀ (mm)', type: 'number', min: 1, when: isChuck },
    { path: 'bodyLength', label: 'Body length (mm)', type: 'number', min: 1, when: isChuck },
    // --- clamps and jaws ---
    { path: 'center.0', label: 'Centre X (mm)', type: 'number', when: (f) => !isChuck(f) },
    { path: 'center.1', label: 'Centre Y (mm)', type: 'number', when: (f) => !isChuck(f) },
    {
      path: 'size.0', label: 'Width X (mm)', type: 'number', min: 0.1,
      when: (f) => f.kind === 'box',
    },
    {
      path: 'size.1', label: 'Depth Y (mm)', type: 'number', min: 0.1,
      when: (f) => f.kind === 'box',
    },
    {
      path: 'rotationDeg', label: 'Rotation (°)', type: 'number',
      when: (f) => f.kind === 'box',
    },
    {
      path: 'diameter', label: 'Diameter (mm)', type: 'number', min: 0.1,
      when: (f) => f.kind === 'cylinder',
    },
    { path: 'baseZ', label: 'Sits at Z (mm)', type: 'number', when: (f) => !isChuck(f) },
    { path: 'height', label: 'Height (mm)', type: 'number', min: 0.1, when: (f) => !isChuck(f) },
  ],
  op: [],
};

function isPointed(tool) {
  return tool.type === 'drill' || tool.type === 'chamfer' || tool.type === 'spot';
}

/** Tools whose geometry is an indexable insert rather than a ground end. */
function isInsertTool(tool) { return tool.type === 'turning' || tool.type === 'boring'; }

function isChuck(fixture) { return fixture.kind === 'chuck'; }

/**
 * Typing an ISO designation fills in the geometry it encodes.
 *
 * The code on the box is the thing a machinist actually has to hand, and
 * "TNMG160408" already says 60° triangle, 9.525 inscribed circle, 0.8 nose.
 * Making someone read those three out of it and retype them as three fields is
 * asking them to be the parser.
 */
function applyInsertCode(app, tool, value) {
  const doc = app?.doc;
  if (!doc) return;
  const parsed = parseInsertCode(value);
  doc.updateItem(tool, parsed
    ? { insertCode: value.trim().toUpperCase(), ...parsed }
    : { insertCode: value }, 'set insert code');
  app?.ui?.setStatus?.(parsed
    ? `${value.trim().toUpperCase()}: ${INSERT_SHAPES[parsed.insert].label}, `
      + `IC ${parsed.insertIc}, r${parsed.noseRadius} nose`
    : `"${value}" is not an ISO insert code — set the shape and size below instead`,
  !parsed);
}

/**
 * Changing the family re-derives the sizes only that family has.
 *
 * Shared with the wizard through `defaultsForType` — see the note on the Type
 * field above. What it deliberately does *not* touch is the name, the number
 * and the speeds: those are decisions about this tool, and a retype that
 * renamed the cutter under you would be worse than the fields it fixes.
 */
function applyToolType(app, tool, value) {
  const doc = app?.doc;
  if (!doc) return;
  doc.updateItem(tool, defaultsForType(value, tool), 'change tool type');
  const changed = Object.entries(defaultsForType(value, tool))
    .filter(([k]) => k !== 'type').length;
  app?.ui?.setStatus?.(`${tool.name} is now a ${TOOL_TYPE_LABELS[value] ?? value} — `
    + `${plural(changed, 'size')} re-derived for it. Check the speeds.`);
}

export function renderProps(container, doc, app = {}) {
  const item = doc.findSelected();
  if (!item) {
    const head = jobHead(doc, app);
    container.replaceChildren(head, ...jobSummary(doc, app), ...machineSection(doc, app));
    settleHead(container, head);
    return;
  }

  const kind = doc.selection.kind;
  // A field may open a section of its own. The tool's list was one run of
  // eighteen rows — its number, its shape, its sizes and its speeds — with
  // nothing between them to find your place by.
  const rows = (FIELDS[kind] ?? [])
    .filter((f) => !f.when || f.when(item))
    .flatMap((f) => [
      ...(f.heading ? [el('h2', {}, [f.heading])] : []),
      fieldRow(doc, item, f, null, null, app),
    ]);

  if (kind === 'tool') {
    rows.unshift(toolPreviewRow(item));
    // The same checks the wizard runs while the tool is being built. They used
    // to exist only there, so every one of them could be typed into an existing
    // tool without a word — a corner radius bigger than the cutter, a bar that
    // cannot enter its own minimum bore, a feed that is three times the chip
    // the edge can take.
    rows.push(...toolWarnings(item)
      .map((w) => el('div', { class: 'prop-note warn' }, [w])));
    rows.push(...speedSuggestion(doc, item));
    // Said where the number is typed, because that is where it gets fixed. A T
    // word is all the program says about which cutter to fit, and the post
    // drops a second change to a number already in the spindle — so two
    // cutters sharing one number means the wrong one cuts. See op-status.js.
    const sharing = toolNumberClashes(doc.project).get(item.number);
    if (sharing) {
      rows.push(el('div', { class: 'prop-note warn' }, [
        `T${item.number} is also ${sharing.filter((t) => t.id !== item.id)
          .map((t) => t.name).join(', ')}. The program cannot tell them apart, `
        + 'so whichever is loaded first stays in the spindle — give each its own number.',
      ]));
    }
    // A cutter you have measured and tuned is worth more than the preset it
    // started as; without this it lived and died with the project file.
    rows.push(el('div', { class: 'prop-actions' }, [
      // The same dialog the tool was made in. The fields above can change every
      // one of these numbers, but only the dialog draws the result, checks it,
      // and hides the fields this family does not have.
      el('button', {
        title: 'Open this cutter in the tool builder, with the drawing and the checks',
        onclick: () => app.actions?.editTool(item),
      }, ['Edit in the builder…']),
      el('button', {
        title: 'Keep this cutter for other projects — it joins "My tools" in the library',
        onclick: () => app.actions?.saveToolToLibrary(item),
      }, ['Save to my library']),
    ]));
  }
  if (kind === 'setup') rows.push(...setupSections(doc, item, app));
  if (kind === 'op') rows.push(...opSections(doc, item, app));
  if (kind === 'fixture') {
    // A chuck is not an area on the table with a tool radius round it; it is a
    // pair of jaws on the bar that the turning passes stop short of.
    rows.push(el('div', { class: 'prop-note' }, [isChuck(item)
      ? 'Every turning pass in this setup stops short of the jaws and the chuck '
        + 'body. Z is along the bar in setup coordinates — the same numbers the '
        + 'G-code uses, so measure from the part zero.'
      : 'Every operation in this setup keeps the cutter out of this area, grown by '
        + 'the tool radius. Positions are in setup coordinates — the same numbers '
        + 'the G-code uses, so measure from the part zero.',
    ]));
  }

  if (kind === 'drawing') rows.push(...drawingSummary(doc, item, app));
  if (kind === 'model') rows.push(...modelSummary(doc, item));

  const head = inspectorHead(doc, kind, item, app);
  container.replaceChildren(head, ...rows);
  settleHead(container, head);
}

/**
 * How tall the sticky header came out, for whatever sticks under it — the
 * operation panel's tabs stand just below it as the fields scroll.
 */
function settleHead(container, head) {
  container.style.setProperty('--inspector-height', `${head.offsetHeight}px`);
}

/** What each kind of thing is called at the top of the panel, and its drawing. */
const KINDS = {
  model: { label: 'Model', icon: 'cube' },
  drawing: { label: 'Drawing', icon: 'drawing' },
  tool: { label: 'Tool', icon: 'cutter' },
  setup: { label: 'Setup', icon: 'setup' },
  fixture: { label: 'Clamp', icon: 'clamp' },
  op: { label: 'Operation', icon: null },
};

/**
 * The top of the panel: what is selected, by kind and by name, and what can be
 * done to it.
 *
 * The name is a text box that looks like a title — the field that used to be
 * the first row of every list, moved to where the eye lands first. The menu
 * beside it is the one the item's row opens in the tree, from the same table
 * (tree.js menuForItem), so the two cannot offer different things; the bin is
 * the delete that was a button at the bottom of a panel that scrolls, worded by
 * the same table as the tree's menu and the status line after it.
 */
function inspectorHead(doc, kind, item, app) {
  const info = KINDS[kind] ?? { label: kind, icon: null };
  const chuck = kind === 'fixture' && item.kind === 'chuck';
  // an operation is called an operation here: its strategy is the card just
  // below, and its name is usually the strategy's until somebody renames it
  const label = chuck ? 'Chuck' : info.label;
  const glyph = kind === 'op' ? opIcon(item.type, 16) : icon(chuck ? 'chuck' : info.icon, 14);
  const where = whereIs(doc, kind, item);

  const nameBox = el('input', {
    type: 'text', class: 'inspector-name', 'aria-label': `${info.label} name`,
    title: 'The name — type to rename it',
    spellcheck: 'false',
  });
  nameBox.value = item.name ?? '';
  nameBox.addEventListener('change', () => {
    const next = nameBox.value.trim();
    if (!next) { nameBox.value = item.name ?? ''; return; }
    if (next !== item.name) doc.updateItem(item, { name: next }, 'rename');
  });
  nameBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameBox.blur(); }
    if (e.key === 'Escape') { nameBox.value = item.name ?? ''; nameBox.blur(); }
  });

  const removal = removalOf(kind, item).label;
  const title = el('div', { class: 'inspector-title' }, [
    nameBox,
    el('button', {
      type: 'button',
      class: 'ghost-icon',
      title: 'Everything you can do to it — the same menu as a right-click on its row',
      'aria-label': 'More actions',
      'aria-haspopup': 'menu',
      onclick: (e) => openContextMenu(anchorBelow(e, 'right'), menuForItem(doc, kind, item, app)),
    }, [icon('more', 16)]),
    el('button', {
      type: 'button',
      class: 'ghost-icon danger',
      title: `${removal} (Delete)`,
      'aria-label': removal,
      // deleteSelected confirms first where the deletion reaches past this row;
      // never fall through to a second, unconfirmed delete when it returns
      onclick: () => (app.actions ? app.actions.deleteSelected() : doc.removeSelected()),
    }, [icon('trash', 15)]),
  ]);

  const parts = [
    el('div', { class: 'inspector-kind' }, [
      glyph,
      el('span', {}, [label]),
      ...(where ? [el('span', { class: 'inspector-where' }, [`· ${where}`])] : []),
    ]),
    title,
  ];

  // The one switch each of these has, where the name is: whether the operation
  // is in the program, and whether the clamp is kept out of.
  if (kind === 'op' || kind === 'fixture') {
    const box = el('input', { type: 'checkbox' });
    box.checked = kind === 'op' ? !!item.enabled : item.enabled !== false;
    box.addEventListener('change', () => {
      doc.updateItem(item, { enabled: box.checked }, kind === 'op'
        ? (box.checked ? 'enable op' : 'disable op') : 'toggle clamp');
    });
    parts.push(el('label', {
      class: 'inspector-toggle',
      title: kind === 'op'
        ? 'A disabled operation is skipped when generating, posting and simulating'
        : 'Every operation in the setup keeps the cutter out of it — untick to see the program as if it were not there',
    }, [box, kind === 'op' ? 'In the program' : 'Keep the tool out of it']));
  }
  return el('div', { class: 'inspector-head' }, parts);
}

/** Where in the job an item sits, said after its kind. */
function whereIs(doc, kind, item) {
  if (kind === 'op') return doc.findSetupOf(item.id)?.name ?? '';
  if (kind === 'fixture') {
    return doc.project.setups.find((s) => (s.fixtures ?? []).includes(item))?.name ?? '';
  }
  if (kind === 'tool') return `T${item.number}`;
  if (kind === 'setup') return (item.mode ?? 'mill') === 'turn' ? 'Lathe' : 'Mill';
  return '';
}

/**
 * The panel with nothing selected: the job itself.
 *
 * It used to say "nothing selected" over the machine's numbers — true, and no
 * help. With nothing selected the thing in front of you is the project, so the
 * panel is about the project: its name, what is in it, and how far it is from
 * being a program.
 */
function jobHead(doc, app) {
  const nameBox = el('input', {
    type: 'text', class: 'inspector-name', 'aria-label': 'Project name',
    title: 'The project\'s name — what a save or an export is called',
    spellcheck: 'false',
  });
  nameBox.value = doc.project.name ?? '';
  nameBox.addEventListener('change', () => {
    const next = nameBox.value.trim();
    if (!next) { nameBox.value = doc.project.name ?? ''; return; }
    if (app.actions?.renameProject) app.actions.renameProject(next);
    else doc.updateItem(doc.project, { name: next }, 'rename project');
  });
  nameBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameBox.blur(); }
    if (e.key === 'Escape') { nameBox.value = doc.project.name ?? ''; nameBox.blur(); }
  });
  return el('div', { class: 'inspector-head' }, [
    el('div', { class: 'inspector-kind' }, [
      icon('layers', 14),
      el('span', {}, ['Project']),
      el('span', { class: 'inspector-where' }, [`· ${doc.machine === 'turn' ? 'Lathe' : 'Mill'}`]),
    ]),
    el('div', { class: 'inspector-title' }, [nameBox]),
  ]);
}

/** What is in the job, for the machine in front of you, and what is next. */
function jobSummary(doc, app) {
  const tools = doc.project.tools.filter((t) => machineCanHold(t.type, doc.machine));
  const setups = doc.setups();
  let ops = 0;
  let enabled = 0;
  let generated = 0;
  let seconds = 0;
  let blocked = 0;
  for (const { op } of doc.allOperations()) {
    ops++;
    if (!op.enabled) continue;
    enabled++;
    // blocked first, as the Generate button counts them: a path left over from
    // before its tool was deleted is not a generated operation
    if (opBlockedReason(doc, op)) { blocked++; continue; }
    const status = opStatus(doc, op);
    if (status) { generated++; seconds += status.seconds; }
  }
  const rows = [el('h2', {}, ['In this job'])];
  rows.push(reportRows([
    ['Models', `${doc.project.models.length}${(doc.project.drawings ?? []).length
      ? ` + ${plural(doc.project.drawings.length, 'drawing')}` : ''}`],
    ['Tools', String(tools.length)],
    ['Setups', String(setups.length)],
    ['Operations', ops === enabled ? String(ops) : `${ops} (${enabled} in the program)`],
    ['Generated', enabled ? `${generated} of ${enabled}` : '—'],
    ...(generated && generated === enabled ? [['Cutting time', `≈ ${formatTime(seconds)}`]] : []),
  ]));
  if (blocked) {
    rows.push(el('div', { class: 'prop-note warn' }, [
      `${plural(blocked, 'operation')} cannot be generated yet — the "!" on its row says why.`,
    ]));
  }
  rows.push(el('div', { class: 'prop-note' }, [
    'Select anything in the tree to edit it here. Right-click a row for everything '
    + 'that can be done to it.',
  ]));
  return rows;
}

/**
 * The cutter, drawn from the numbers below it — twice, because there are two
 * questions and one drawing cannot answer both.
 *
 * The business end, big, is what identifies a cutter: a corner radius bigger
 * than the tool, a tip angle that makes a drill blunt, a flute length shorter
 * than the cut. The whole assembly beside it, to scale, is the other question —
 * how far it sticks out, how much of that is edge, and how close the holder
 * comes to the work. Drawing only the flutes made the second unanswerable, and
 * a 40mm holder 20mm above the tip is a crash nothing on screen could show.
 */
function toolPreviewRow(tool) {
  // A lathe tool answers different questions and is a different shape, so it
  // gets one wide drawing rather than two tall ones — and the numbers under it
  // are the insert and the reach, not the flute length of something that has
  // no flutes.
  if (isLatheTool(tool.type)) return latheToolPreviewRow(tool);

  const lines = [
    ['Cutting edge', `${fluteLengthOf(tool).toFixed(0)} mm of ⌀${tool.diameter}`],
    ['Whole tool', `${toolLength(tool).toFixed(0)} mm, widest ⌀${(toolMaxRadius(tool) * 2).toFixed(0)}`],
    ['Reaches', describeReach(tool)],
    ['At these speeds', describeCutting(tool)],
  ];
  return el('div', {}, [
    el('div', { class: 'tool-preview' }, [
      toolIcon(tool, { width: 76, height: 84 }),
      toolAssembly(tool, { width: 62, height: 118 }),
      el('div', { class: 'tool-preview-text' }, [
        el('div', { class: 'tool-preview-name' }, [tool.name]),
        el('div', { class: 'tool-preview-meta' }, [describeTool(tool)]),
        el('div', { class: 'tool-legend' }, [
          legendSwatch('cutting', 'flutes'),
          legendSwatch('shank', 'shank'),
          legendSwatch('holder', 'holder'),
        ]),
      ]),
    ]),
    reportRows(lines),
  ]);
}

/**
 * The lathe tool, drawn in the plane it works in, with the numbers that decide
 * whether it can make the cut.
 *
 * Which way the insert faces is a fact about the tool that only a picture can
 * carry, and it is the fact that decides whether a pass can reach up to a
 * shoulder or has to stop short of one.
 */
function latheToolPreviewRow(tool) {
  const insert = tool.type === 'turning' || tool.type === 'boring';
  const reach = latheReachOf(tool);
  const lines = [];
  if (insert) {
    lines.push(['Insert', `${INSERT_SHAPES[tool.insert]?.label ?? '—'}, IC ${insertIcOf(tool)} mm`]);
    lines.push(['Corner angle', `${INSERT_SHAPES[tool.insert]?.cornerAngle ?? '—'}°`]);
    lines.push(['Nose radius', tool.noseRadius > 0
      ? `${tool.noseRadius} mm, compensated on finishing passes`
      : 'not set — every face would come out short']);
  } else {
    lines.push(['Cuts a groove', `${tool.bladeWidth || tool.diameter} mm wide`]);
  }
  if (tool.type === 'boring') lines.push(['Bar', `⌀${tool.diameter} mm`]);
  if (tool.minBore > 0) lines.push(['Needs a hole of', `⌀${tool.minBore} mm to get in`]);
  lines.push(['Reaches', Number.isFinite(reach) ? `${reach} mm` : 'as far as the slide goes']);
  lines.push(['At these speeds', describeCutting(tool)]);

  return el('div', {}, [
    el('div', { class: 'tool-preview tool-preview-lathe' }, [
      toolAssembly(tool, { width: 190, height: 96 }),
      el('div', { class: 'tool-preview-text' }, [
        el('div', { class: 'tool-preview-name' }, [tool.name]),
        el('div', { class: 'tool-preview-meta' }, [describeTool(tool)]),
        el('div', { class: 'tool-preview-meta' }, [
          `${INSERT_HAND_LABELS[tool.hand] ?? ''}`,
        ]),
      ]),
    ]),
    ...(insert && INSERT_NOTES[tool.insert]
      ? [el('div', { class: 'prop-note' }, [INSERT_NOTES[tool.insert]])] : []),
    reportRows(lines),
  ]);
}

/**
 * How deep this cutter can go before something that is not the cutter meets
 * the wall of the cut.
 *
 * Two different limits, and which one bites depends on the tool: a long-reach
 * end mill runs out of flute first, while a V bit on a 4mm collet shank runs
 * out of clearance after 8mm — and only one of those was ever mentioned
 * anywhere in the app.
 */
/**
 * What the speeds would be if they were derived for the cutter as it stands now.
 *
 * The wizard computes them from the diameter as you type; the panel does not,
 * and it must not — speeds someone measured are worth more than any formula, so
 * rewriting them under an edit would be the wrong kind of helpful. But a preset
 * ⌀6 whose diameter is changed to ⌀20 keeps 12000rpm, which is 754 m/min, and
 * nothing anywhere said so. Offering is the middle: the number is visible, and
 * taking it is a click.
 */
function speedSuggestion(doc, tool) {
  const want = suggestCutting({
    type: tool.type, diameter: tool.diameter, flutes: tool.flutes, tipAngle: tool.tipAngle,
  });
  const off = (a, b) => a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) > 0.35;
  if (!off(want.spindleRpm, tool.spindleRpm) && !off(want.feedCut, tool.feedCut)) return [];
  return [el('div', { class: 'prop-note' }, [
    el('div', {}, [`For a ⌀${tool.diameter} of this family the suggestion is `
      + `${want.spindleRpm} RPM and ${want.feedCut} mm/min.`]),
    el('button', {
      style: 'margin-top: 6px',
      onclick: () => doc.updateItem(tool, {
        spindleRpm: want.spindleRpm,
        feedCut: want.feedCut,
        feedPlunge: want.feedPlunge,
      }, 'use the suggested speeds'),
    }, ['Use these speeds']),
  ])];
}

/**
 * The speeds in the units they are judged in.
 *
 * RPM and mm/min are what the control wants, and neither of them says whether
 * the cut is sane: 10000rpm is fast for a ⌀20 and slow for a ⌀1, and 800mm/min
 * is a heavy chip on two flutes and a rubbing one on six. Surface speed and
 * chip load have the cutter's own size in them already, which is why the
 * catalogues quote those. See doc/tool-library.js cuttingReadout.
 */
function describeCutting(tool) {
  const { vc, load, loadLabel, workDiameter } = cuttingReadout(tool);
  if (!(tool.spindleRpm > 0)) return 'no spindle speed set';
  const on = workDiameter ? ` on a ⌀${workDiameter} bar` : '';
  return `${vc.toFixed(0)} m/min surface${on}, ${load.toFixed(3)} mm ${loadLabel}`;
}

function describeReach(tool) {
  const flute = fluteLengthOf(tool);
  const { maxDepth, kind } = reachCheck(tool, Infinity);
  if (!kind) return `${flute.toFixed(0)} mm — nothing above the flutes is wider`;
  if (maxDepth <= flute + 1e-6) {
    return `${maxDepth.toFixed(0)} mm — the ${kind} is wider than the cut`;
  }
  return `${flute.toFixed(0)} mm of flute, then the ${kind} at ${maxDepth.toFixed(0)} mm`;
}

function legendSwatch(kind, label) {
  return el('span', { class: `tool-legend-item tool-legend-${kind}` }, [
    el('i', {}), label,
  ]);
}

/**
 * What the placed drawing actually works out to, and whether it fits.
 *
 * The fields above say what you asked for; this says what you got. A logo
 * scaled by 10 is a valid drawing that engraves perfectly — off the side of the
 * billet and into the vice — and the size on the part is the number nobody can
 * work out from a scale factor and a file they have not opened.
 */
function drawingSummary(doc, drawing, app) {
  const setup = doc.setups()[0];
  const stock = setup ? app.actions?.setupStock?.(setup) ?? null : null;
  const placed = placedPaths(drawing, stock);
  const bounds = boundsOfPaths(placed);
  const rows = [el('h2', {}, ['On the part'])];

  if (!bounds) {
    rows.push(el('div', { class: 'tree-empty' }, ['the drawing is empty']));
    return rows;
  }
  const open = placed.filter((p) => !p.closed).length;
  rows.push(reportRows([
    ['Size', `${(bounds.max[0] - bounds.min[0]).toFixed(2)} × `
      + `${(bounds.max[1] - bounds.min[1]).toFixed(2)} mm`],
    ['Sits at X', `${bounds.min[0].toFixed(2)} … ${bounds.max[0].toFixed(2)}`],
    ['Sits at Y', `${bounds.min[1].toFixed(2)} … ${bounds.max[1].toFixed(2)}`],
    ['Paths', `${placed.length} (${placed.length - open} closed, ${open} open)`],
    ['Line length', `${(totalLength(placed) / 1000).toFixed(2)} m`],
  ]));

  const over = overhangOf(placed, stock);
  if (over) rows.push(el('div', { class: 'prop-note warn' }, [`${over} — nothing outside the billet can be machined.`]));
  else if (!stock) {
    rows.push(el('div', { class: 'prop-note' }, [
      'No stock yet, so the drawing is shown in its own coordinates. Add a setup '
      + 'and it will be placed against the billet.',
    ]));
  }

  rows.push(el('div', { class: 'prop-actions' }, [
    el('button', {
      class: 'primary-outline',
      title: 'Add an engraving pass already pointed at this drawing',
      onclick: () => app.actions?.engraveDrawing?.(drawing),
    }, ['Engrave this drawing']),
  ]));
  return rows;
}

/**
 * What a model is, in the numbers that decide whether it imported right.
 *
 * Its panel used to be a Name field and a delete button, which is nothing about
 * the part. The size says whether a file came in in inches (25 times too small)
 * or in metres; the faces say whether it came from a CAD kernel — a STEP keeps
 * its B-rep faces, so a click picks a whole face — or from a mesh, where every
 * triangle is its own; and the setups say what it is used for.
 */
function modelSummary(doc, model) {
  const mesh = doc.meshes.get(model.id);
  const rows = [el('h2', {}, ['Model'])];
  if (!mesh) {
    rows.push(el('div', { class: 'prop-note warn' }, [
      'Saved without its geometry — import the file again to machine it.',
    ]));
    return rows;
  }
  const { min, max } = computeBounds(mesh.positions);
  const size = [0, 1, 2].map((k) => (max[k] - min[k]).toFixed(2)).join(' × ');
  const triangles = (mesh.indices?.length ?? mesh.positions.length / 3) / 3;
  const faces = mesh.faceRanges?.length ?? 0;
  const setups = doc.project.setups.filter((s) => !s.modelIds?.length || s.modelIds.includes(model.id));
  rows.push(reportRows([
    ['File', model.sourceName ?? '—'],
    ['Size', `${size} mm`],
    ['Triangles', triangles.toLocaleString()],
    ['Faces', faces ? `${faces} (from the CAD file)` : 'none — each triangle picks alone'],
    ['Machined in', setups.length ? setups.map((s) => s.name).join(', ') : 'no setup yet'],
  ]));
  return rows;
}

/**
 * The machine this program is for, when nothing else is selected.
 *
 * The panel would otherwise sit empty, and these are the numbers that decide
 * what every estimate in the app means — a rapid rate five times slower than
 * the machine's turns a four minute job into a twenty minute one. Editing them
 * is a click away rather than here, because they belong to the machine and not
 * to whatever happens to be selected.
 */
function machineSection(doc, app) {
  const machine = doc.machineRecord();
  const rows = [el('h2', {}, ['Machine'])];
  if (!machine) {
    rows.push(el('div', { class: 'prop-note' }, ['No machine of this kind — add one in Machines.']));
  } else {
    const axes = doc.machine === 'turn'
      ? [['Swing over bed', `⌀${(machine.travel[0] * 2).toFixed(0)} mm`],
        ['Between centres', `${machine.travel[2].toFixed(0)} mm`]]
      : [['Travel', `${machine.travel.map((v) => v.toFixed(0)).join(' × ')} mm`]];
    rows.push(el('div', { class: 'prop-note' }, [machine.name]));
    rows.push(reportRows([
      ...axes,
      ['Rapid', `${machine.rapidFeed} mm/min, Z ${machine.rapidFeedZ}`],
      ['Spindle', `${machine.spindleMin}–${machine.spindleMax} rpm`],
      ['Tool change', machine.toolChanger === 'auto'
        ? `automatic, ${machine.toolChangeSeconds}s`
        : `by hand, ${machine.toolChangeSeconds}s`],
      ['Dialect', machine.post],
    ]));
  }
  rows.push(el('div', { class: 'prop-actions' }, [
    el('button', {
      title: withKey('Create and edit machines — travel, rapids, spindle range, dialect', 'machines'),
      onclick: () => app.actions?.openMachines?.(),
    }, ['Machines…']),
    el('button', {
      title: withKey('How the viewport draws and how the editor behaves', 'options'),
      onclick: () => app.actions?.openOptions?.(),
    }, ['Options…']),
  ]));
  return rows;
}
