// The generic field editor behind every panel in here.
//
// A row is described by a path or a param key plus a type, and this turns that
// into a labelled input that writes back through the undo stack. Everything
// panel-specific — what the fields *are* — lives with the panel that shows
// them; this file only knows how to render one and how to record the edit.

import { el } from '../layout.js';
import {
  constrainHeights, heightRefusal, HEIGHT_ORDER, HEIGHT_LABELS,
} from '../../engine/heights.js';
import { REPORTS, cuttingReportRow } from './reports.js';
import { getSetting, setSetting } from '../settings.js';
import { attachHint } from './hint-bubble.js';
import { numberInput, parseNumber, formatNumber } from '../number-input.js';

let rowSeq = 0;

/**
 * A label and the control it names, tied together.
 *
 * This was written out at five call sites as `[el('label', {}, [label]),
 * control]` — two siblings that look associated and are not. Nothing joined
 * them, so clicking "Skip what earlier passes cleared" did nothing at all: the
 * only target for that setting was the 15px box beside it, when the sentence
 * next to it is what the eye and the pointer both go to. `for`/`id` is what
 * makes a label a second, large hit area for its control, and it is the same
 * attribute a screen reader needs to read the two as one thing.
 */
export function propRow(labelText, control, { className = 'prop-row' } = {}) {
  if (!control.id) {
    rowSeq += 1;
    control.id = `prop-${rowSeq}`;
  }
  return el('div', { class: className }, [
    el('label', { for: control.id }, [labelText]),
    control,
  ]);
}

/** Resolve 'a.b.0' to its owning object and final key, creating nothing. */
export function resolvePath(root, path) {
  const parts = path.split('.');
  let owner = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (owner == null) return null;
    owner = owner[parts[i]];
  }
  return owner == null ? null : { owner, key: parts[parts.length - 1] };
}

/**
 * Every length in this app is a millimetre value held to a micron.
 *
 * A micron is the resolution of the machines this writes programs for, and
 * anything past it is float noise pretending to be a measurement: a stock
 * diameter typed as 25.4 and derived from a bounding box comes back as
 * 25.400000000000002, which reads as a number somebody chose. Rounding at the
 * point of entry means the document only ever holds numbers a person could have
 * typed, and the G-code only ever holds numbers a control can act on.
 */
export function roundMicron(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v;
}

/** One labelled input bound to a dotted path on `item`. */
export function fieldRow(doc, item, field, beforeEdit, afterEdit, app) {
  const at = resolvePath(item, field.path);
  const value = at ? at.owner[at.key] : '';
  let input;

  // some edits are more than a property write — changing an operation's
  // strategy has to bring the strategy's parameters with it, and typing an ISO
  // insert code has to fill in the geometry it encodes
  const custom = (next) => {
    if (!field.onChange) return false;
    field.onChange(app, item, next);
    return true;
  };

  if (field.type === 'select') {
    input = el('select', {}, field.options.map((o) =>
      el('option', { value: String(o) }, [field.labels?.[o] ?? String(o)])));
    input.value = String(value);
    input.addEventListener('change', () => {
      if (custom(input.value)) return;
      beforeEdit?.();
      const target = resolvePath(item, field.path);
      doc.updateItem(target.owner, { [target.key]: input.value }, `edit ${field.label}`);
      afterEdit?.();
    });
  } else if (field.type === 'checkbox') {
    input = el('input', { type: 'checkbox' });
    input.checked = !!value;
    input.addEventListener('change', () => {
      if (custom(input.checked)) return;
      const target = resolvePath(item, field.path);
      doc.updateItem(target.owner, { [target.key]: input.checked }, `edit ${field.label}`);
    });
  } else {
    // A number is typed, not stepped through — see app/number-input.js for why
    // this is a text field and not `type="number"`.
    input = field.type === 'number'
      ? numberInput(field, { value: formatNumber(value) })
      : el('input', { type: field.type, value: value ?? '' });
    input.addEventListener('change', () => {
      if (field.type !== 'number') {
        if (custom(input.value)) return;
        beforeEdit?.();
        const target = resolvePath(item, field.path);
        doc.updateItem(target.owner, { [target.key]: input.value }, `edit ${field.label}`);
        return afterEdit?.();
      }
      const parsed = parseNumber(input.value);
      // an unreadable entry puts the old value back rather than silently
      // becoming zero — see paramRow below for why that matters
      if (!Number.isFinite(parsed)) {
        input.value = formatNumber(value);
        return undefined;
      }
      let next = roundMicron(parsed);
      if (field.min != null && next < field.min) next = field.min;
      if (field.max != null && next > field.max) next = field.max;
      if (custom(next)) return undefined;
      beforeEdit?.();
      const target = resolvePath(item, field.path);
      doc.updateItem(target.owner, { [target.key]: next }, `edit ${field.label}`);
      return afterEdit?.();
    });
  }
  if (field.min != null) input.min = String(field.min);
  if (field.max != null) input.max = String(field.max);

  const row = propRow(field.label, input);
  return withHint(row, field, item, app);
}

/**
 * The label and hint this field wears on *this* strategy.
 *
 * Top Z is the top of the cut on a pocket and the edge being broken on a
 * chamfer; the field is the same, the decision is not. See HEIGHT_LABELS_BY_OP.
 */
function labelOf(field, op) { return field.labelFor?.(op) || field.label; }

function hintOf(field, op) { return field.hintFor?.(op) || field.hint; }

/**
 * Hints are on until the user turns them off.
 *
 * The opposite default hides every explanation in the app behind a hover on a
 * control you have to already understand to know you should hover over it.
 */
export function hintStyle(app) {
  // Not every caller has the app object — a panel rendered for a test, or one
  // that only wants a labelled input.
  if (!app) return 'bubble';
  if (app.hintStyle != null) return app.hintStyle;
  // One preference, in one place, so the control on the operation panel and the
  // one in Options are the same switch rather than two that disagree.
  app.hintStyle = getSetting('hintStyle');
  return app.hintStyle;
}

/** Kept for callers that only want to know whether anything is explained. */
export function hintsOn(app) {
  return hintStyle(app) !== 'off';
}

/**
 * A field with its explanation attached, when explanations are on.
 *
 * The hint used to be a `title`, which is a tooltip on a control you have to
 * already understand in order to know you should hover over it. Under the field
 * it is simply read, and the toggle is there for the day you no longer need it.
 */
function withHint(row, field, op, app) {
  const hint = hintOf(field, op);
  const style = hintStyle(app);
  if (!hint || style === 'off') return row;
  if (style === 'inline') {
    return el('div', { class: 'prop-field' }, [row, el('div', { class: 'prop-hint' }, [hint])]);
  }
  return attachHint(row, { title: labelOf(field, op), text: hint, artKey: field.key });
}

export function paramRow(doc, op, field, app) {
  const label = labelOf(field, op);
  if (field.type === 'select') {
    const options = field.filterOptions ? field.filterOptions(op) : field.options;
    const select = el('select', {}, options.map((o) =>
      el('option', { value: String(o) }, [field.labels?.[o] ?? String(o)])));
    select.value = String(op.params[field.key] ?? options[0]);
    select.addEventListener('change', () => {
      doc.updateItem(op.params, { [field.key]: select.value }, `edit ${label}`);
    });
    return withHint(propRow(label, select), field, op, app);
  }
  if (field.type === 'checkbox') {
    const box = el('input', { type: 'checkbox' });
    box.checked = !!op.params[field.key];
    box.addEventListener('change', () => {
      doc.updateItem(op.params, { [field.key]: box.checked }, `edit ${label}`);
    });
    return withHint(propRow(label, box), field, op, app);
  }
  if (field.type === 'report') {
    return (REPORTS[field.key] ?? cuttingReportRow)(doc, op);
  }
  if (field.type === 'drawing') {
    // Which imported drawing this pass follows, or the part's own outline. The
    // list is short and the empty entry is the default, so a project with no
    // DXF in it sees one option and reads as if the feature is not there.
    const drawings = doc.project.drawings ?? [];
    const select = el('select', {}, [
      el('option', { value: '' }, ['The part\'s own outline']),
      ...drawings.map((d) => el('option', { value: d.id }, [d.name])),
    ]);
    select.value = op.params[field.key] ?? '';
    select.addEventListener('change', () => {
      doc.updateItem(op.params, { [field.key]: select.value || null }, `edit ${label}`);
    });
    const row = propRow(label, select);
    if (drawings.length === 0) {
      return withHint(el('div', {}, [row, el('div', { class: 'prop-hint' }, [
        'No drawings imported. Open Model takes a .dxf and brings it in as one.',
      ])]), field, op, app);
    }
    return withHint(row, field, op, app);
  }

  const raw = op.params[field.key];
  const input = numberInput(field, {
    value: formatNumber(raw),
    // An empty nullable field means "work it out", and *what* gets worked out
    // is worth saying: "inherit" is true of every one of them and tells you
    // nothing about this one.
    placeholder: field.nullable ? (field.placeholder ?? 'inherit') : '',
  });
  input.addEventListener('change', () => {
    let next;
    if (field.nullable && input.value.trim() === '') next = null;
    else if (input.value.trim() === '') next = 0;
    else {
      const parsed = parseNumber(input.value);
      // a field that will not take "-5" because parseFloat("-5")||0 is -5 but
      // parseFloat("")||0 is 0 is fine; one that turns "abc" into 0 silently is
      // not, so an unreadable entry puts the old value back instead
      if (!Number.isFinite(parsed)) {
        input.value = formatNumber(raw);
        return;
      }
      next = roundMicron(parsed);
    }

    // heights are not four independent numbers — see engine/heights.js
    if (HEIGHT_ORDER.includes(field.key)) {
      const { patch, adjusted, rejected } = constrainHeights(op.params, field.key, next);
      if (rejected) {
        input.value = formatNumber(raw);        // put the working value back
        app?.ui?.setStatus?.(`Kept ${label} at ${raw} — ${heightRefusal(field.key)}`, true);
        return;
      }
      doc.updateItem(op.params, patch, `edit ${label}`);
      if (adjusted.length) {
        app?.ui?.setStatus?.(`${adjusted.map((k) => HEIGHT_LABELS[k]).join(' and ')} moved up to `
          + 'stay clear of the cut');
      }
      return;
    }

    if (field.min != null && next < field.min) next = field.min;
    if (field.max != null && next > field.max) next = field.max;
    doc.updateItem(op.params, { [field.key]: next }, `edit ${label}`);
  });
  if (field.min != null) input.min = String(field.min);
  if (field.max != null) input.max = String(field.max);
  const row = propRow(label, input);
  if (field.key === 'topZ' || field.key === 'bottomZ' || field.key === 'clearanceHeight') {
    return withHint(el('div', {}, [row, snapRow(doc, op, field.key, label, app)]),
      field, op, app);
  }
  return withHint(row, field, op, app);
}

/**
 * One-click heights: the top of the part, the bottom of the billet, and so on.
 *
 * Every one of these numbers is already known to the app, and typing it in by
 * hand means going to find it first — reading it off the stock summary, or
 * guessing and generating twice to see whether the pass reached the floor.
 * They are also exactly the values the drag handles are hardest to hit, being
 * the ones where the tool is level with a surface rather than near it.
 */
function snapRow(doc, op, key, label, app) {
  const targets = app?.snapTargetsFor?.(op) ?? [];
  if (targets.length === 0) return el('span', {});
  const current = op.params[key];
  return el('div', { class: 'prop-snaps' }, [
    el('span', { class: 'prop-snaps-label' }, ['snap to']),
    ...targets.map((target) => {
      const here = Math.abs(current - target.z) < 0.0005;
      return el('button', {
        class: `prop-snap${here ? ' at' : ''}`,
        title: `${target.hint} — Z${roundMicron(target.z)}`,
        onclick: () => {
          const { patch, rejected } = constrainHeights(op.params, key, roundMicron(target.z));
          if (rejected) {
            return app?.ui?.setStatus?.(
              `${label} cannot go to ${target.label} — ${heightRefusal(key)}`, true);
          }
          doc.updateItem(op.params, patch, `snap ${label}`);
          app?.ui?.setStatus?.(`${label} set to ${target.label}, Z${roundMicron(target.z)}`);
        },
      }, [target.label]);
    }),
  ]);
}


/**
 * What the tab settings come to on the machine.
 *
 * The two numbers a machinist wants are how much material is holding the part
 * and how far the tool has to lift for it — neither of which is any of the
 * three fields above on its own.
 */
