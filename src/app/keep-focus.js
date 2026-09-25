// Rebuilding a panel without losing the gesture that caused it.
//
// Every panel in this app is rebuilt from the document rather than patched, and
// a field commits on `change` — which fires as the field *loses* focus, in the
// middle of whatever took the focus away: the click on the next field, the Tab
// to it, the click on a tree row, the arrow key that nudges it. Rebuilding right
// there replaced the control being clicked before the click reached it. Nothing
// got the focus, the caret went to <body>, and whatever was typed next was read
// as a shortcut — the Delete pressed to clear the next field deleted the
// operation, and an arrow key nudged a number once and never again.
//
// Two things fix it, and both live here so every panel gets the same answer:
//
//   * `whenSettled` holds a rebuild back while the gesture is still going on —
//     a pointer that went down in the panel and has not come up, or an edit in
//     it whose `change` is still being dispatched — and runs it once the click
//     has landed and the focus has finished moving.
//   * `rebuildKeepingFocus` notes which control had the caret, rebuilds, and
//     puts the caret on the same control in the new panel.

const FOCUSABLE = 'input, select, textarea, button';

let installed = false;
let pointerTarget = null;      // where the pointer that is down went down
let committing = null;         // a control whose `change` is being dispatched
const pending = new Map();     // key → { within, run }

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('pointerdown', (e) => { pointerTarget = e.target; }, true);
  // After the click, not at the release: `click` is dispatched after
  // `pointerup`, and it has to reach the control the pointer went down on.
  const release = () => {
    if (!pointerTarget) return;
    pointerTarget = null;
    setTimeout(flush, 0);
  };
  for (const type of ['pointerup', 'pointercancel', 'dragend']) {
    window.addEventListener(type, release, true);
  }
  // The window losing focus mid-press — not a field losing it, which is the
  // very event being waited out.
  window.addEventListener('blur', (e) => { if (e.target === window) release(); });
  // A Tab out of a field is invisible to a focus check: the browser takes the
  // focus off the field *before* it dispatches the field's `change`, so for the
  // length of that event the caret is on <body>. The target says where it was.
  window.addEventListener('change', (e) => {
    committing = e.target;
    setTimeout(() => { if (committing === e.target) committing = null; }, 0);
  }, true);
}

function inside(within, node) {
  return !!node && node !== document.body && within.some((c) => c?.contains(node));
}

function busy(within) {
  return inside(within, pointerTarget) || inside(within, committing)
    || inside(within, document.activeElement);
}

function flush() {
  for (const [key, job] of [...pending]) {
    if (inside(job.within, pointerTarget)) continue;   // a new press has begun
    pending.delete(key);
    job.run();
  }
}

/**
 * Run `run` now, or — if a gesture in one of the `within` containers is still
 * under way — as soon as it has finished. Calls under one `key` collapse into
 * the last one, so a burst of document changes is one rebuild.
 */
export function whenSettled(key, within, run) {
  install();
  if (!busy(within)) {
    pending.delete(key);
    run();
    return;
  }
  const waitingForPointer = inside(within, pointerTarget);
  pending.set(key, { within, run });
  if (!waitingForPointer) setTimeout(flush, 0);
}

/** What a control is called, so its replacement can be found by name. */
function controlName(node) {
  return (node.labels?.[0]?.textContent ?? node.getAttribute('placeholder')
    ?? node.getAttribute('title') ?? node.textContent ?? '').trim();
}

/** Rebuild `container` with `render`, and put the caret back where it was. */
export function rebuildKeepingFocus(container, render) {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  let focus = null;
  if (active && active !== document.body && container.contains(active)) {
    const all = [...container.querySelectorAll(FOCUSABLE)];
    const name = controlName(active);
    const same = all.filter((n) => n.tagName === active.tagName && controlName(n) === name);
    focus = {
      tag: active.tagName,
      name,
      nth: same.indexOf(active),
      index: all.indexOf(active),
      caret: typeof active.selectionStart === 'number'
        ? [active.selectionStart, active.selectionEnd] : null,
    };
  }
  render();
  if (!focus) return;
  const all = [...container.querySelectorAll(FOCUSABLE)];
  const same = all.filter((n) => n.tagName === focus.tag && controlName(n) === focus.name);
  const target = same[focus.nth]
    ?? (all[focus.index]?.tagName === focus.tag ? all[focus.index] : null);
  if (!target || target.disabled) return;
  target.focus({ preventScroll: true });
  if (focus.caret && typeof target.selectionStart === 'number') {
    const end = target.value.length;
    try {
      target.setSelectionRange(Math.min(focus.caret[0], end), Math.min(focus.caret[1], end));
    } catch { /* not a text control */ }
  }
}
