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
import {
  toolWarnings, cuttingReadout, defaultsForType, suggestCutting,
} from '../doc/tool-library.js';
import { toolNumberClashes } from './op-status.js';
import { reportRows } from './props/reports.js';
import { fieldRow } from './props/fields.js';
import { setupSections } from './props/setup-panel.js';
import { opSections } from './props/op-panel.js';

const FIELDS = {
  model: [
    { path: 'name', label: 'Name', type: 'text' },
  ],
  // An imported DXF: where it lands on the billet, how big, and which way up.
  // The file's own coordinates are almost never the part's, so this is the
  // whole of what has to be said about a drawing. See engine/drawing.js.
  drawing: [
    { path: 'name', label: 'Name', type: 'text' },
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
    { path: 'name', label: 'Name', type: 'text' },
    { path: 'number', label: 'Tool number', type: 'number' },
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
      path: 'diameter', label: 'Diameter (mm)', type: 'number', when: (t) => !isInsertTool(t),
    },
    // --- lathe inserts ---
    {
      path: 'insertCode', label: 'ISO code', type: 'text', when: isInsertTool,
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
    { path: 'cornerRadius', label: 'Corner radius', type: 'number', when: (t) => t.type === 'bull' },
    { path: 'tipAngle', label: 'Tip angle (°)', type: 'number', when: isPointed },
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
    { path: 'fluteLength', label: 'Flute length', type: 'number', when: (t) => !isLatheTool(t.type) },
    { path: 'flutes', label: 'Flutes', type: 'number', when: (t) => !isLatheTool(t.type) },
    { path: 'spindleRpm', label: 'Spindle (RPM)', type: 'number' },
    { path: 'feedCut', label: 'Feed (mm/min)', type: 'number' },
    { path: 'feedPlunge', label: 'Plunge (mm/min)', type: 'number' },
  ],
  setup: [
    { path: 'name', label: 'Name', type: 'text' },
    { path: 'wcs', label: 'WCS', type: 'select', options: ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'] },
  ],
  fixture: [
    { path: 'name', label: 'Name', type: 'text' },
    { path: 'enabled', label: 'Keep out', type: 'checkbox' },
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
  op: [
    { path: 'name', label: 'Name', type: 'text' },
    { path: 'enabled', label: 'In the program', type: 'checkbox' },
  ],
};

function isPointed(tool) { return tool.type === 'drill' || tool.type === 'chamfer'; }

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
    container.replaceChildren(
      el('h2', {}, ['Properties']),
      el('div', { class: 'tree-empty' }, ['nothing selected']),
      ...machineSection(doc, app),
    );
    return;
  }

  const kind = doc.selection.kind;
  const rows = (FIELDS[kind] ?? [])
    .filter((f) => !f.when || f.when(item))
    .map((f) => fieldRow(doc, item, f, null, null, app));

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
    rows.push(el('div', { class: 'prop-row', style: 'margin-top: 12px' }, [
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
    rows.push(el('div', { class: 'prop-note' }, [
      'Every operation in this setup keeps the cutter out of this area, grown by '
      + 'the tool radius. Positions are in setup coordinates — the same numbers '
      + 'the G-code uses, so measure from the part zero.',
    ]));
  }

  if (kind === 'drawing') rows.push(...drawingSummary(doc, item, app));

  const kindLabel = {
    model: 'Model',
    drawing: 'Drawing',
    tool: 'Tool',
    setup: 'Setup',
    op: 'Operation',
    fixture: 'Clamp',
  }[kind];
  rows.push(el('div', { class: 'prop-row', style: 'margin-top: 12px' }, [
    el('button', {
      class: 'danger',
      // deleteSelected confirms first where the deletion reaches past this row;
      // never fall through to a second, unconfirmed delete when it returns
      onclick: () => (app.actions ? app.actions.deleteSelected() : doc.removeSelected()),
    }, [`Delete ${kindLabel}`]),
  ]));

  container.replaceChildren(el('h2', {}, ['Properties']), ...rows);
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

  rows.push(el('div', { class: 'prop-row', style: 'margin-top: 8px' }, [
    el('button', {
      class: 'primary-outline',
      title: 'Add an engraving pass already pointed at this drawing',
      onclick: () => app.actions?.engraveDrawing?.(drawing),
    }, ['Engrave this drawing']),
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
    rows.push(el('div', { class: 'tree-empty' }, ['no machine — add one']));
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
  rows.push(el('div', { class: 'prop-row', style: 'margin-top: 8px' }, [
    el('button', { onclick: () => app.actions?.openMachines?.() }, ['Machines…']),
    el('button', { onclick: () => app.actions?.openOptions?.() }, ['Options…']),
  ]));
  return rows;
}
