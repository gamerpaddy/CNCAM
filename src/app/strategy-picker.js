// Choosing a machining strategy, with the choice explained on screen.
//
// This replaced a dropdown of eleven names. A dropdown is the right control for
// a decision you already know the answer to, and the wrong one for a decision
// that *is* the operation — "clear2d" and "adaptive" both read as roughing,
// "parallel3d" and "waterline" both read as finishing, and the difference in
// each pair is the whole point.
//
// So: a card each, grouped by the stage of the job, with a picture of the cut,
// what it does, when to reach for it, and the cutter it expects. Same dialog
// for creating an operation and for changing an existing one's strategy, since
// they are the same question asked at different times.

import { el, dialogCloseButton } from './layout.js';
import { opsForMode } from '../engine/toolpath.js';
import { OP_GROUPS, strategyCard, opIcon } from './op-catalog.js';

/**
 * @param options.current the strategy already chosen, marked as such
 * @param options.title heading — says whether this creates or changes
 * @param options.confirm label for the button
 * @param options.onPick (type) => void, called only on confirm
 * @returns the open dialog
 */
export function openStrategyPicker({
  current = null, title = 'Add an operation', confirm = 'Add operation',
  mode = 'mill', onPick,
} = {}) {
  // A turning operation in a milling setup is meaningless and the reverse is
  // too, so the picker offers one set or the other rather than a list with four
  // entries that cannot work here.
  const cards = opsForMode(mode).map(strategyCard);
  // With nothing chosen yet, the first card *as laid out* — the top-left one,
  // under "Prepare the stock". It was the first in the engine's list, which
  // since the command operation arrived is "Command (G-code)" on both machines:
  // "Add operation" opened with the one strategy that cuts nothing selected, in
  // the last group at the bottom of the dialog, and a click on the button made
  // one.
  const laidOut = OP_GROUPS.flatMap((group) => cards.filter((c) => c.group === group));
  let chosen = current ?? (laidOut[0] ?? cards[0]).type;

  const dialog = el('dialog', { class: 'lib-dialog strategy-dialog' });
  const accept = el('button', { class: 'primary' }, [confirm]);
  const nodes = new Map();

  const select = (type) => {
    chosen = type;
    for (const [t, node] of nodes) node.classList.toggle('checked', t === type);
    accept.textContent = `${confirm} — ${cards.find((c) => c.type === type).label}`;
  };

  const groups = OP_GROUPS
    .map((group) => [group, cards.filter((c) => c.group === group)])
    .filter(([, list]) => list.length > 0)
    .map(([group, list]) => el('div', { class: 'lib-group' }, [
      el('h3', {}, [group]),
      el('div', { class: 'strategy-grid' }, list.map((card) => {
        const node = el('button', {
          class: 'strategy-card',
          type: 'button',
          onclick: () => select(card.type),
          ondblclick: () => { dialog.close(); onPick?.(card.type); },
        }, [
          el('div', { class: 'strategy-head' }, [
            opIcon(card.type, 30),
            el('span', { class: 'strategy-name' }, [card.label]),
            ...(card.type === current
              ? [el('span', { class: 'strategy-current' }, ['current'])] : []),
          ]),
          el('div', { class: 'strategy-summary' }, [card.summary]),
          el('div', { class: 'strategy-when' }, [card.when]),
          el('div', { class: 'strategy-cutter' }, [`Cutter: ${card.cutter}`]),
        ]);
        nodes.set(card.type, node);
        return node;
      })),
    ]));

  accept.addEventListener('click', () => { dialog.close(); onPick?.(chosen); });

  // The keyboard gets the same dialog the mouse does. It opened with focus on
  // the scrolling list rather than on a card, so Enter — the one key anybody
  // presses to accept the choice already highlighted — did nothing, and the
  // cards could be reached only by tabbing through every one of them. Now focus
  // is the choice: arrows move it through the cards in the order they are laid
  // out, and Enter on a card takes it, as a double-click does.
  const order = laidOut.map((c) => c.type).filter((t) => nodes.has(t));
  for (const [type, node] of nodes) {
    node.addEventListener('focus', () => select(type));
  }
  dialog.addEventListener('keydown', (e) => {
    const card = e.target.closest?.('.strategy-card');
    if (!card) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      dialog.close();
      onPick?.(chosen);
      return;
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const at = order.indexOf(chosen);
    const next = order[Math.max(0, Math.min(order.length - 1, at + step))];
    nodes.get(next)?.focus();
    nodes.get(next)?.scrollIntoView?.({ block: 'nearest' });
  });

  dialog.append(
    dialogCloseButton(dialog),
    el('h2', {}, [title]),
    el('div', { class: 'lib-body' }, groups),
    el('div', { class: 'lib-actions' }, [
      el('span', { class: 'lib-hint' }, ['Double-click a card, or press Enter, to pick it straight away']),
      el('span', { class: 'spacer' }),
      el('button', { type: 'button', onclick: () => dialog.close() }, ['Cancel']),
      accept,
    ]),
  );
  dialog.addEventListener('close', () => dialog.remove());

  document.body.append(dialog);
  dialog.showModal();
  select(chosen);
  nodes.get(chosen)?.focus({ preventScroll: true });
  // scrolling the current choice into view matters when changing a strategy —
  // otherwise the dialog opens on "Face" whatever the operation actually is
  nodes.get(chosen)?.scrollIntoView?.({ block: 'nearest' });
  return dialog;
}
