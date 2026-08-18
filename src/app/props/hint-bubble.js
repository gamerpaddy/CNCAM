// The explanation, on hover, next to the thing being explained.
//
// The hints in this app are good and there are a lot of them, and printed under
// every field they turned the operation panel into an essay: on a roughing
// operation they were 572 of its 1400 pixels, and the fields they explain were
// pushed three screens apart by their own explanations. The two obvious answers
// are both bad — deleting them loses the app's best feature, and hiding them in
// `title` puts them behind a browser tooltip that arrives after a second, wraps
// where it likes and cannot hold a drawing.
//
// So: one floating bubble, shown on hover or focus, holding the hint *and* the
// diagram for that setting where there is one. Position fixed, and exactly one
// of them for the whole app — a bubble parented inside the properties panel is
// clipped by the panel's own scrolling, which is how this kind of thing usually
// ends up being reinvented as a tooltip.

import { diagramFor } from './diagrams.js';

let bubble = null;
let hideTimer = null;

function ensureBubble() {
  if (bubble) return bubble;
  bubble = document.createElement('div');
  bubble.className = 'hint-bubble';
  bubble.setAttribute('role', 'tooltip');
  // Hovering the bubble itself keeps it up, so a long explanation can be read
  // at leisure and a diagram can be looked at rather than glimpsed.
  bubble.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  bubble.addEventListener('mouseleave', () => hideBubble());
  document.body.append(bubble);
  return bubble;
}

export function hideBubble() {
  clearTimeout(hideTimer);
  if (bubble) bubble.classList.remove('open');
}

/**
 * Put the bubble beside its anchor, inside the window.
 *
 * Left of the anchor by default, because the panel it explains is on the right
 * — a bubble to the right of a right-hand panel is off screen. It flips when
 * there is no room, and it is nudged rather than clipped when it would run off
 * the top or bottom, since a hint whose last line is under the taskbar is a
 * hint with a missing last line.
 */
function place(anchor) {
  const box = anchor.getBoundingClientRect();
  const own = bubble.getBoundingClientRect();
  const margin = 8;

  let left = box.left - own.width - margin;
  if (left < margin) left = Math.min(box.right + margin, window.innerWidth - own.width - margin);
  left = Math.max(margin, left);

  let top = box.top + box.height / 2 - own.height / 2;
  top = Math.max(margin, Math.min(top, window.innerHeight - own.height - margin));

  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
}

function showBubble(anchor, { title, text, artKey }) {
  const node = ensureBubble();
  clearTimeout(hideTimer);
  node.replaceChildren();

  if (title) {
    const heading = document.createElement('div');
    heading.className = 'hint-bubble-title';
    heading.textContent = title;
    node.append(heading);
  }
  const art = artKey ? diagramFor(artKey) : null;
  if (art) node.append(art);
  if (text) {
    const body = document.createElement('div');
    body.className = 'hint-bubble-text';
    body.textContent = text;
    node.append(body);
  }

  node.classList.add('open');
  place(anchor);
}

/**
 * Attach hover help to a row.
 *
 * Both hover and focus, so the keyboard reaches it: tabbing into a field is the
 * same "I am about to change this and do not know what it is" that hovering is.
 *
 * @param anchor the element the bubble points at — usually the whole row
 */
export function attachHint(anchor, { title, text, artKey } = {}) {
  if (!text && !artKey) return anchor;
  const open = () => showBubble(anchor, { title, text, artKey });
  const close = () => {
    clearTimeout(hideTimer);
    // A moment's grace so the pointer can travel from the row to the bubble,
    // which is the whole reason the bubble can be hovered at all.
    hideTimer = setTimeout(() => bubble?.classList.remove('open'), 120);
  };
  anchor.addEventListener('mouseenter', open);
  anchor.addEventListener('mouseleave', close);
  anchor.addEventListener('focusin', open);
  anchor.addEventListener('focusout', close);
  anchor.classList.add('has-hint');
  return anchor;
}
