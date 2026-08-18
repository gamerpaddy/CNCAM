// Building a cutter, one question at a time.
//
// The alternative was "+ Blank tool", which hands you a Ø6 flat end mill called
// "flat 6mm" and a panel of eighteen fields to correct — including four that do
// not apply to the family you actually wanted and two whose defaults will cook
// the cutter. That is not creating a tool, it is being handed a form.
//
// So: pick the shape first, because it decides which of the remaining questions
// exist. Then the sizes that shape needs, and nothing else. Speeds and feeds are
// computed from the family and the diameter as you type and can be overridden —
// a Ø1 cutter and a Ø20 cutter want spindle speeds two orders of magnitude
// apart, and defaulting both to 10000rpm is how a new tool arrives wrong.
//
// The drawing updates on every keystroke, which is the point: a corner radius
// bigger than the cutter, a point angle that makes a V bit 6mm long, a flute
// shorter than the depth you meant to cut — all of them are obvious in a
// picture and invisible in a number.

import { el } from './layout.js';
import { numberInput, parseNumber, formatNumber } from './number-input.js';
import { toolIcon, toolAssembly, describeTool, TYPE_COLORS } from './tool-shape.js';
import {
  toolFromPreset, suggestCutting, suggestName, machineForType,
  toolWarnings, cuttingReadout, defaultsForType,
} from '../doc/tool-library.js';
import { toolLength, reachCheck, latheReachOf, fluteLengthOf } from '../engine/tool-geometry.js';
import {
  isLatheTool, parseInsertCode,
  INSERT_LETTERS, INSERT_SHAPE_LABELS, INSERT_HANDS, INSERT_HAND_LABELS, INSERT_NOTES,
} from '../engine/insert.js';

/**
 * The families, in the order a machinist would think of them, with the one
 * sentence that distinguishes each from its neighbours.
 */
const FAMILIES = [
  { type: 'flat', label: 'Flat end mill', hint: 'Square corners and a flat floor. The default for 2.5D work.' },
  { type: 'ball', label: 'Ball nose', hint: 'A hemisphere. For 3D finishing, where a flat cutter leaves steps.' },
  { type: 'bull', label: 'Bull nose', hint: 'Flat with a radiused corner — stiffer than a ball, kinder than a flat.' },
  { type: 'chamfer', label: 'Chamfer / V bit', hint: 'A cone. Breaks edges, cuts V grooves, engraves.' },
  { type: 'drill', label: 'Drill', hint: 'Makes holes on centre. Cannot cut sideways.' },
  { type: 'face', label: 'Face mill', hint: 'Wide and shallow, for taking the skin off a billet.' },
  { type: 'turning', label: 'Turning insert', hint: 'Lathe. Turns and faces the outside of a spinning bar.' },
  { type: 'boring', label: 'Boring bar', hint: 'Lathe. An insert on a bar, for opening a hole out to size.' },
  { type: 'parting', label: 'Parting / grooving', hint: 'Lathe. A blade: parts off, and cuts grooves to width.' },
  { type: 'threading', label: 'Threading tool', hint: 'Lathe. Cuts a thread form, one pass per depth.' },
];

/**
 * Which sizes a family actually has. A nose radius on an end mill is a field
 * that does nothing, and a field that does nothing is worse than no field.
 */
const SIZE_FIELDS = [
  // An indexable insert is described by its ISO code, and the code is what is
  // written on the box. Typing it fills in the shape, the size and the nose
  // radius at once — the alternative is reading those three out of it by hand.
  {
    key: 'insertCode', label: 'ISO code', type: 'text',
    when: isInsert,
    hint: 'TNMG160408, WNMG080408, CCMT09T304 — the designation off the box.',
  },
  {
    key: 'insert', label: 'Insert shape', type: 'select',
    options: INSERT_LETTERS, labels: INSERT_SHAPE_LABELS,
    when: isInsert,
    hint: 'The first letter of the code, and the corner angle it stands for.',
  },
  {
    key: 'insertIc', label: 'Inscribed circle (mm)', step: 0.1, min: 1,
    when: isInsert,
    hint: 'The circle that fits inside the insert touching every edge — how big it is.',
  },
  {
    key: 'diameter', label: 'Diameter (mm)', step: 0.1, min: 0.05,
    when: (t) => !isInsert(t),
    hint: 'Across the cutting edge.',
  },
  {
    key: 'diameter', label: 'Bar ⌀ (mm)', step: 0.1, min: 0.5,
    when: (t) => t.type === 'boring',
    hint: 'The shank that goes down the hole. It is what limits the smallest bore.',
  },
  {
    key: 'cornerRadius', label: 'Corner radius (mm)', step: 0.1, min: 0,
    when: (t) => t.type === 'bull',
    hint: 'The radius ground on the corner. Bigger than half the diameter and it is a ball nose.',
  },
  {
    key: 'tipAngle', label: 'Point angle (°)', step: 1, min: 1, max: 179,
    when: (t) => t.type === 'drill' || t.type === 'chamfer',
    hint: 'The full included angle. 118° is a jobber drill; 90° a chamfer mill; 30° a fine V bit.',
  },
  {
    key: 'tipDiameter', label: 'Flat on the tip (mm)', step: 0.05, min: 0,
    when: (t) => t.type === 'drill' || t.type === 'chamfer',
    hint: 'Most V bits end in a small flat rather than a point. It sets the finest line the tool can hold.',
  },
  {
    key: 'noseRadius', label: 'Nose radius (mm)', step: 0.1, min: 0,
    when: isInsert,
    hint: 'The radius on the insert corner. A finishing pass is offset by it.',
  },
  {
    key: 'bladeWidth', label: 'Blade width (mm)', step: 0.1, min: 0.1,
    when: (t) => t.type === 'parting' || t.type === 'threading',
    hint: 'The groove the blade cuts — the material lost with every part.',
  },
  {
    key: 'hand', label: 'Hand', type: 'select',
    options: INSERT_HANDS, labels: INSERT_HAND_LABELS,
    when: isInsert,
    hint: 'Which way it cuts, and so which side of the cut the holder is on.',
  },
  {
    key: 'minBore', label: 'Smallest bore (mm)', step: 0.5, min: 0,
    when: (t) => t.type === 'boring' || t.type === 'threading',
    hint: 'The smallest hole this will go down at all. 0 if it never goes in one.',
  },
  {
    key: 'maxDepth', label: 'Reaches (mm)', step: 1, min: 0,
    when: isLathe,
    hint: 'How far into a hole or a groove before the overhang is more than it '
      + 'can hold. Boring stops here rather than chattering.',
  },
  {
    key: 'fluteLength', label: 'Cutting length (mm)', step: 1, min: 0.5,
    when: (t) => !isLathe(t),
    hint: 'How deep it can cut before the shank reaches the work.',
  },
  {
    key: 'flutes', label: 'Flutes', step: 1, min: 1, max: 12,
    when: (t) => !isLathe(t),
    hint: 'Cutting edges. More flutes, more feed at the same chip load — and less room for the chips.',
  },
  {
    key: 'shankDiameter', label: 'Shank ⌀ (mm)', step: 0.1, min: 0.5,
    when: (t) => !isLathe(t),
    hint: 'What goes in the collet. Wider than the cutter and it limits how deep you can go.',
  },
  {
    key: 'stickout', label: 'Stickout (mm)', step: 1, min: 1,
    when: (t) => !isLathe(t),
    hint: 'Tip to the bottom of the holder. Everything past this is holder, and holders crash.',
  },
];

function isLathe(draft) { return isLatheTool(draft.type); }

/** Tools whose geometry is an indexable insert rather than a ground end. */
function isInsert(draft) { return draft.type === 'turning' || draft.type === 'boring'; }

/** Sizes that other fields are computed from, so changing one re-derives. */
const DERIVING = new Set([
  'diameter', 'flutes', 'tipAngle', 'cornerRadius', 'noseRadius', 'bladeWidth',
]);

const SPEED_FIELDS = [
  { key: 'spindleRpm', label: 'Spindle (RPM)', step: 100, min: 1 },
  { key: 'feedCut', label: 'Feed (mm/min)', step: 10, min: 1 },
  { key: 'feedPlunge', label: 'Plunge (mm/min)', step: 10, min: 1 },
];

const SPEED_KEYS = new Set(SPEED_FIELDS.map((f) => f.key));

/**
 * @param machine 'mill' | 'turn' — which families to offer first
 * @param number the tool number to give it
 * @param tool an existing tool to edit rather than a blank one to build
 * @param onCreate (tool) => void
 * @param onSaveToLibrary optional (tool) => void, for the "keep this" tick
 */
export function openToolWizard({
  machine = 'mill', number = 1, tool: editing = null, onCreate, onSaveToLibrary,
}) {
  // The working record. Held as a flat draft rather than a tool so the shank
  // and holder — which the user thinks of as two numbers — stay two numbers.
  const draft = {
    type: machine === 'turn' ? 'turning' : 'flat',
    diameter: machine === 'turn' ? 12.7 : 6,
    cornerRadius: 0,
    tipAngle: 0,
    tipDiameter: 0,
    noseRadius: machine === 'turn' ? 0.8 : 0,
    bladeWidth: 0,
    // lathe inserts, by the code on the box
    insert: 'C',
    insertIc: 12.7,
    insertCode: '',
    hand: 'R',
    minBore: 0,
    maxDepth: 0,
    fluteLength: 20,
    flutes: 2,
    shankDiameter: 6,
    stickout: 45,
    spindleRpm: 10000,
    feedCut: 800,
    feedPlunge: 300,
    name: '',
    nameEdited: false,
  };
  // Editing a tool that exists is the same set of questions, and asking them in
  // the panel's flat list of eighteen fields — with no drawing, no warnings and
  // no sense of which of them this family even has — is what this dialog was
  // built to stop doing. So the draft is seeded, and everything already decided
  // about the tool counts as decided: nothing the user measured is re-derived
  // out from under them when the dialog opens.
  if (editing) {
    const shank = editing.shank?.[0];
    Object.assign(draft, {
      type: editing.type,
      diameter: editing.diameter ?? draft.diameter,
      cornerRadius: editing.cornerRadius ?? 0,
      tipAngle: editing.tipAngle ?? 0,
      tipDiameter: editing.tipDiameter ?? 0,
      noseRadius: editing.noseRadius ?? 0,
      bladeWidth: editing.bladeWidth ?? 0,
      insert: editing.insert ?? draft.insert,
      insertIc: editing.insertIc ?? draft.insertIc,
      insertCode: editing.insertCode ?? '',
      hand: editing.hand ?? 'R',
      minBore: editing.minBore ?? 0,
      maxDepth: editing.maxDepth ?? 0,
      fluteLength: fluteLengthOf(editing) || draft.fluteLength,
      flutes: editing.flutes ?? draft.flutes,
      shankDiameter: shank?.diameter ?? draft.shankDiameter,
      stickout: shank ? Math.round(fluteLengthOf(editing) + shank.length) : draft.stickout,
      spindleRpm: editing.spindleRpm ?? draft.spindleRpm,
      feedCut: editing.feedCut ?? draft.feedCut,
      feedPlunge: editing.feedPlunge ?? draft.feedPlunge,
      name: editing.name ?? '',
      nameEdited: true,
      fluteEdited: true,
      shankEdited: true,
      stickoutEdited: true,
      speedsEdited: true,
    });
  }

  const preview = el('div', { class: 'wiz-preview' });
  const sizeRows = el('div', { class: 'wiz-fields' });
  const speedRows = el('div', { class: 'wiz-fields' });
  const speedNote = el('div', { class: 'prop-note' });
  const nameInput = el('input', { type: 'text', class: 'wiz-name' });
  const saveToLibrary = el('input', { type: 'checkbox' });
  saveToLibrary.checked = true;

  const familyCards = FAMILIES.map((family) => {
    const card = el('button', {
      class: 'wiz-family',
      title: family.hint,
      onclick: () => setFamily(family.type),
    }, [
      el('span', { class: 'wiz-family-icon' }, []),
      el('span', { class: 'wiz-family-label' }, [family.label]),
      el('span', { class: 'wiz-family-hint' }, [family.hint]),
    ]);
    card.dataset.type = family.type;
    card.dataset.machine = machineForType(family.type);
    return card;
  });

  /**
   * Change family: reset the sizes that only that family has, then re-derive.
   *
   * The sizes themselves are `defaultsForType`, which the Type field in the
   * properties panel also uses — the card and the dropdown are the same
   * decision and used to answer it differently.
   */
  function setFamily(type) {
    if (type === draft.type) return;
    Object.assign(draft, defaultsForType(type, draft));
    // A flute length, a stickout or a spindle speed typed for an end mill says
    // nothing about a drill, so changing family hands them all back to the
    // suggestion — which is the one thing that must not happen merely because
    // the dialog opened on a tool that already existed.
    draft.fluteEdited = false;
    draft.shankEdited = false;
    draft.stickoutEdited = false;
    draft.speedsEdited = false;
    rederive();
    render();
  }

  /**
   * Recompute everything the user has not overridden.
   *
   * Speeds always follow the diameter, because a speed that no longer suits the
   * cutter is worse than no speed — it is a number that looks considered. The
   * name follows until it is typed in, and then it is theirs.
   */
  function rederive() {
    // An ISO code is the authority on the geometry it encodes, so typing one
    // overwrites the three fields it names rather than sitting beside them
    // disagreeing.
    const parsed = draft.insertCode ? parseInsertCode(draft.insertCode) : null;
    if (parsed && isInsert(draft)) Object.assign(draft, parsed);

    const suggested = suggestCutting({
      type: draft.type, diameter: draft.diameter, flutes: draft.flutes,
      tipAngle: draft.tipAngle,
    });
    draft.flutes = suggested.flutes;
    if (!draft.speedsEdited) {
      draft.spindleRpm = suggested.spindleRpm;
      draft.feedCut = suggested.feedCut;
      draft.feedPlunge = suggested.feedPlunge;
    }
    if (!draft.fluteEdited) draft.fluteLength = suggested.fluteLength;
    if (!draft.shankEdited) draft.shankDiameter = suggested.shank[0].diameter;
    if (!draft.stickoutEdited) {
      draft.stickout = Math.round(draft.fluteLength + suggested.shank[0].length);
    }
    if (!draft.nameEdited) draft.name = suggestName(draft);
  }

  function toolFromDraft() {
    // stickout is tip-to-holder, so the shank is whatever of it the flutes
    // do not already account for
    const shankLength = Math.max(1, draft.stickout - draft.fluteLength);
    const lathe = isLathe(draft);
    return toolFromPreset({
      name: draft.name || suggestName(draft),
      type: draft.type,
      diameter: draft.diameter,
      cornerRadius: draft.cornerRadius,
      tipAngle: draft.tipAngle,
      tipDiameter: draft.tipDiameter,
      noseRadius: draft.noseRadius,
      bladeWidth: draft.bladeWidth,
      insert: draft.insert,
      insertIc: draft.insertIc,
      insertCode: draft.insertCode,
      hand: draft.hand,
      minBore: draft.minBore,
      maxDepth: draft.maxDepth,
      fluteLength: draft.fluteLength,
      flutes: draft.flutes,
      // a lathe tool has no collet shank to describe; toolFromPreset drops
      // these for lathe families anyway, and passing them would only invite the
      // question of what they mean
      ...(lathe ? {} : { shank: [{ diameter: draft.shankDiameter, length: shankLength }] }),
      spindleRpm: draft.spindleRpm,
      feedCut: draft.feedCut,
      feedPlunge: draft.feedPlunge,
    }, number);
  }

  /**
   * One size. Most are numbers; the two that are not — the insert shape and the
   * hand — are choices from a fixed list, and offering those as numbers would
   * be asking the user to know that a trigon is a 4.
   */
  function fieldRow(spec) {
    if (spec.type === 'select') return selectRow(spec);
    if (spec.type === 'text') return textRow(spec);
    return numberRow(spec);
  }

  function labelOf(spec) { return spec.labelFor?.(draft) || spec.label; }

  function wrapRow(spec, input) {
    const row = el('label', { class: 'wiz-field', title: spec.hint ?? '' }, [
      el('span', {}, [labelOf(spec)]),
      input,
    ]);
    row.dataset.key = spec.key;
    return row;
  }

  function selectRow(spec) {
    const select = el('select', {}, spec.options.map((o) =>
      el('option', { value: String(o) }, [spec.labels?.[o] ?? String(o)])));
    select.value = String(draft[spec.key] ?? spec.options[0]);
    select.addEventListener('change', () => {
      draft[spec.key] = select.value;
      // choosing a shape by hand means the code no longer describes the insert
      if (spec.key === 'insert') draft.insertCode = '';
      rederive();
      render();
    });
    return wrapRow(spec, select);
  }

  function textRow(spec) {
    const input = el('input', { type: 'text', placeholder: 'e.g. CNMG120408' });
    input.value = String(draft[spec.key] ?? '');
    input.addEventListener('input', () => {
      draft[spec.key] = input.value;
      if (spec.key === 'insertCode' && !parseInsertCode(input.value)) return;
      rederive();
      render({ keepFocus: spec.key, keepText: input.value });
    });
    return wrapRow(spec, input);
  }

  function numberRow(spec) {
    const input = numberInput(spec);
    input.value = formatNumber(draft[spec.key] ?? 0);
    input.addEventListener('input', () => {
      const v = parseNumber(input.value);
      // half-typed is not wrong: "0," and "-" arrive here on the way to a
      // number, and the drawing simply does not move until one exists
      if (!Number.isFinite(v)) return;
      draft[spec.key] = Math.max(spec.min ?? -Infinity, Math.min(spec.max ?? Infinity, v));
      // a field the user has touched stops being derived from the others
      if (spec.key === 'fluteLength') draft.fluteEdited = true;
      if (spec.key === 'shankDiameter') draft.shankEdited = true;
      if (spec.key === 'stickout') draft.stickoutEdited = true;
      if (SPEED_KEYS.has(spec.key)) draft.speedsEdited = true;
      // Every size that feeds the name or the speeds re-derives them. Without
      // the angle in this list, typing 30° into a V bit left it named "90°".
      if (DERIVING.has(spec.key)) rederive();
      render({ keepFocus: spec.key, keepText: input.value });
    });
    return wrapRow(spec, input);
  }

  function render({ keepFocus = null, keepText = null } = {}) {
    for (const card of familyCards) {
      card.classList.toggle('active', card.dataset.type === draft.type);
      card.classList.toggle('other-machine', card.dataset.machine !== machine);
      const icon = card.querySelector('.wiz-family-icon');
      icon.replaceChildren(toolIcon(
        { ...draft, type: card.dataset.type, ...familyDefaults(card.dataset.type) },
        { width: 30, height: 34, color: TYPE_COLORS[card.dataset.type] },
      ));
    }

    sizeRows.replaceChildren(
      ...SIZE_FIELDS.filter((f) => !f.when || f.when(draft)).map(fieldRow),
    );
    speedRows.replaceChildren(...SPEED_FIELDS.map(numberRow));
    nameInput.value = draft.name;

    const tool = toolFromDraft();
    const lathe = isLathe(draft);
    // What "reaches" means is not the same question on the two machines. On a
    // mill it is where the shank stops fitting in the slot; on a lathe there is
    // no slot and no shank, and the number that matters is how far the tool can
    // work into a hole before the overhang runs the job.
    const reachText = lathe
      ? (Number.isFinite(latheReachOf(tool))
        ? `Works ${latheReachOf(tool).toFixed(0)}mm into a hole or groove`
        : 'Reach limited only by the slide')
      : `Reaches ${reachCheck(tool, Infinity).maxDepth.toFixed(0)}mm before the `
        + `${reachCheck(tool, Infinity).kind ?? 'holder'} meets the work · `
        + `${toolLength(tool).toFixed(0)}mm overall`;

    // A milling tool is drawn tall and narrow, so the description reads beside
    // it. A lathe tool is drawn lying down — 210 wide — and putting the same
    // description beside *that* leaves it about forty pixels of column to wrap
    // into, which was a 500px-tall paragraph and the reason the lathe wizard
    // needed 909px of a 619px dialog and came up with scroll bars.
    preview.classList.toggle('stacked', lathe);
    preview.replaceChildren(
      lathe
        ? toolAssembly(tool, { width: 210, height: 108 })
        : toolAssembly(tool, { width: 108, height: 210 }),
      el('div', { class: 'wiz-preview-text' }, [
        el('div', { class: 'wiz-preview-name' }, [tool.name]),
        el('div', { class: 'prop-note' }, [describeTool(tool)]),
        el('div', { class: 'prop-note' }, [reachText]),
        ...(isInsert(draft) && INSERT_NOTES[draft.insert]
          ? [el('div', { class: 'prop-note' }, [INSERT_NOTES[draft.insert]])] : []),
        ...toolWarnings(tool).map((w) => el('div', { class: 'prop-note warn' }, [w])),
      ]),
    );
    // The two numbers the speeds are actually judged by, kept next to the
    // fields they come out of. RPM and mm/min are what the control wants and
    // neither says whether the cut is sane — see cuttingReadout.
    const { vc, load, loadLabel } = cuttingReadout(tool);
    speedNote.replaceChildren(
      el('div', { class: 'wiz-readout' }, [
        `${vc.toFixed(0)} m/min surface speed · ${load.toFixed(3)}mm ${loadLabel}`,
      ]),
      el('div', {}, [machineForType(draft.type) === 'turn'
        ? 'Computed for a ⌀30 bar in free-cutting steel. Surface speed on a lathe '
          + 'is set by the work, so change these when the bar changes.'
        : `Computed from ${draft.diameter}mm at a light chip load in aluminium. `
          + 'Conservative on purpose — a starting point, not a recommendation.']),
    );

    if (keepFocus) {
      const field = sizeRows.querySelector(`[data-key="${keepFocus}"] input`)
        ?? speedRows.querySelector(`[data-key="${keepFocus}"] input`);
      if (field) {
        // Put back what was actually typed, not what the draft holds.
        //
        // Every keystroke rebuilds these rows, and a rebuilt row takes its text
        // from the draft — so a field being typed into is continuously
        // overwritten by the tidied version of itself. Type "0.5" and the
        // moment the full stop lands the draft still reads 0, the row is
        // rebuilt as "0", and the separator is gone before the 5 arrives. Same
        // for a comma, and for the leading "-" of a negative number. The draft
        // is the authority on the *value*; the person at the keyboard is the
        // authority on the text.
        if (keepText != null) field.value = keepText;
        field.focus();
        field.setSelectionRange?.(field.value.length, field.value.length);
      }
    }
  }

  /** Sizes a family needs to look like itself in a 30px card icon. */
  function familyDefaults(type) {
    const lathe = isLatheTool(type);
    return {
      diameter: type === 'boring' ? 12 : 6,
      cornerRadius: type === 'bull' ? 1.5 : 0,
      tipAngle: type === 'drill' ? 118 : type === 'chamfer' ? 60 : 0,
      tipDiameter: 0,
      // a card icon has to show the *family*, so the insert is drawn at the
      // shape and size the family is typically bought in rather than at
      // whatever the draft happens to hold
      insert: 'C',
      insertIc: type === 'boring' ? 6.35 : 12.7,
      hand: 'R',
      noseRadius: lathe && type !== 'parting' && type !== 'threading' ? 0.8 : 0,
      bladeWidth: type === 'parting' ? 3 : type === 'threading' ? 1.5 : 0,
      maxDepth: type === 'parting' ? 12 : type === 'boring' ? 40 : 0,
      fluteLength: 14,
      flutes: 2,
    };
  }

  const dialog = el('dialog', { class: 'lib-dialog wiz-dialog' });
  const create = el('button', { class: 'primary' }, [editing ? 'Save changes' : 'Create tool']);
  create.addEventListener('click', () => {
    const tool = toolFromDraft();
    dialog.close();
    if (!editing && saveToLibrary.checked) onSaveToLibrary?.(tool);
    onCreate?.(tool);
  });

  nameInput.addEventListener('input', () => {
    draft.nameEdited = true;
    draft.name = nameInput.value;
    const label = preview.querySelector('.wiz-preview-name');
    if (label) label.textContent = draft.name || suggestName(draft);
  });

  dialog.append(
    el('h2', {}, [editing ? `Edit T${editing.number} ${editing.name}` : 'New tool']),
    el('div', { class: 'wiz-body' }, [
      el('div', { class: 'wiz-families' }, familyCards),
      el('div', { class: 'wiz-columns' }, [
        el('div', { class: 'wiz-column' }, [
          el('h3', {}, ['Sizes']),
          sizeRows,
        ]),
        el('div', { class: 'wiz-column' }, [
          el('h3', {}, ['Speeds & feeds']),
          speedRows,
          speedNote,
        ]),
        el('div', { class: 'wiz-column wiz-column-preview' }, [
          el('h3', {}, ['This tool']),
          preview,
        ]),
      ]),
      el('label', { class: 'wiz-field wiz-name-row' }, [
        el('span', {}, ['Name']),
        nameInput,
      ]),
    ]),
    el('div', { class: 'lib-actions' }, [
      // Editing an existing tool is not the moment to offer to file a copy of
      // it: the tick is on by default, and the copy it would leave in the
      // library is of the tool as it was a moment ago.
      ...(editing ? [] : [el('label', { class: 'toggle', title: 'Keep it for other projects too' }, [
        saveToLibrary, 'Add to my library',
      ])]),
      el('span', { class: 'spacer' }),
      el('button', { onclick: () => dialog.close() }, ['Cancel']),
      create,
    ]),
  );
  dialog.addEventListener('close', () => dialog.remove());

  // `setFamily` returns early when the family is already what it says, so an
  // edit renders from the draft as it stands rather than being reset by it.
  if (editing) { rederive(); render(); } else setFamily(draft.type);
  document.body.append(dialog);
  dialog.showModal();
  nameInput.focus();
  return dialog;
}

