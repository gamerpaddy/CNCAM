// Typing a number, the way the person at the keyboard writes one.
//
// Every numeric field in this app used to be `<input type="number">`, which
// sounds like exactly the right control and is the reason "0,5" could not be
// entered. A number input parses and re-serialises through the *browser's*
// locale: on a German profile the decimal separator is a comma and a full stop
// is rejected, on an English one it is the other way round, and in both cases a
// rejected keystroke leaves `input.value` as the empty string. Every caller
// then read that empty string, got NaN, and put the old value back — so the
// field silently refused the number and gave no reason.
//
// A machinist reads 0.5 and 0,5 as the same size, and a CAM package that only
// accepts one of them is wrong wherever it is used. So the fields are plain
// text with `inputmode="decimal"` (which still brings up the numeric keypad on
// a touch device) and the parsing happens here, once, accepting both.
//
// What is given up is the spinner arrows. They are given back below by handling
// Up and Down directly, which also fixes something the native control never
// did: the step is applied from the value that is *there*, so nudging 6.35 by
// 0.1 gives 6.45 rather than snapping to the step grid.

import { el } from './layout.js';

/**
 * Read a number a person typed.
 *
 * Accepts a comma or a full stop as the decimal separator, tolerates spaces and
 * a leading `+`, and understands the half-typed states a live `input` handler
 * sees on the way past — "-", ".", "0," are all *not yet* a number rather than
 * errors, and come back as NaN so the caller leaves the value alone.
 *
 * A thousands separator is deliberately not supported: "1,234" is 1.234 here.
 * Guessing between 1.234 and 1234 from punctuation alone is a coin toss, and
 * the wrong answer is a cutter three orders of magnitude too big.
 *
 * @returns the number, or NaN when the text is not one
 */
export function parseNumber(text) {
  if (typeof text === 'number') return text;
  const cleaned = String(text ?? '').trim().replace(/\s+/g, '').replace(',', '.');
  if (cleaned === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

/** How a number is shown in a field: full stop, and no float noise. */
export function formatNumber(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'number') return String(value);
  if (!Number.isFinite(value)) return '';
  return String(Math.round(value * 1e6) / 1e6);
}

/**
 * A text field that holds a number.
 *
 * @param spec { step, min, max, placeholder } — the same shape the field tables
 *   already use; `min`/`max` are advisory here (they drive the arrow keys), and
 *   the caller still clamps, because a *typed* value has to be clamped on commit
 *   rather than fought with on every keystroke.
 * @param attrs extra element attributes (class, placeholder…)
 */
export function numberInput(spec = {}, attrs = {}) {
  const input = el('input', {
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    ...attrs,
  });
  bindArrowKeys(input, spec);
  return input;
}

/**
 * Up and Down nudge the value by `step`, as the native control did.
 *
 * Shift takes ten steps, which is the convention everywhere else and is what
 * makes a 100rpm step usable for a 4000rpm change. The synthesised `input` and
 * `change` events are what let the caller keep one listener for typing and for
 * nudging rather than two that have to agree.
 */
function bindArrowKeys(input, { step = 1, min = null, max = null } = {}) {
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const size = (Number(step) > 0 ? Number(step) : 1) * (event.shiftKey ? 10 : 1);
    const current = parseNumber(input.value);
    const from = Number.isFinite(current) ? current : 0;
    let next = from + (event.key === 'ArrowUp' ? size : -size);
    if (min != null && next < min) next = min;
    if (max != null && next > max) next = max;
    event.preventDefault();
    input.value = formatNumber(Math.round(next * 1e6) / 1e6);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
