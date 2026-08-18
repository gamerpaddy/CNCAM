// Popup menu — right-click on a tree row, or left-click an affordance that has
// several things it could do.
//
// Items are `{ label, onclick, danger?, separator?, disabled?, hint? }` so a
// caller can describe what should happen without touching the DOM.
//
// Dismissal is the whole difficulty here. The menu has to close when you press
// anywhere else, which means listening for a press on the document — but a
// press *on a menu item* is also a press on the document, and closing there
// removes the button before the browser can deliver its `click`. The result is
// a menu that opens, highlights under the cursor, and does nothing at all: no
// error, no clue. Stopping propagation on the menu is not a fix either, because
// a listener registered in the capture phase sees the press on the way down
// regardless of what the target does with it afterwards.
//
// So the outside-press listener asks whether the press landed inside the menu,
// and closes only when it did not. That is the one formulation that survives
// capture, bubbling and stopPropagation alike.

import { el } from './layout.js';

let active = null;

export function openContextMenu(event, items) {
  closeContextMenu();
  const usable = (items ?? []).filter(Boolean);
  if (usable.length === 0) return;

  const menu = el('div', { class: 'context-menu', role: 'menu' });
  const buttons = [];

  for (const item of usable) {
    if (item.separator) {
      menu.append(el('div', { class: 'context-sep' }));
      continue;
    }
    const button = el('button', {
      class: `context-item${item.danger ? ' danger' : ''}`,
      type: 'button',
      onclick: () => {
        closeContextMenu();
        item.onclick?.();
      },
    }, [item.label]);
    if (item.disabled) button.disabled = true;
    if (item.hint) button.title = item.hint;
    menu.append(button);
    if (!item.disabled) buttons.push(button);
  }

  document.body.append(menu);
  position(menu, event);

  // keyboard: Up/Down/Enter/Escape, so the menu is usable without the mouse
  let index = -1;
  const focusAt = (n) => {
    if (buttons.length === 0) return;
    index = (n + buttons.length) % buttons.length;
    buttons[index].focus();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeContextMenu(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(index + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(index - 1); }
    else if (e.key === 'Tab') closeContextMenu();
  };

  // A press inside the menu is the user choosing something — leave it alone so
  // the click can land. Anything else dismisses.
  const onPointerDown = (e) => {
    if (!menu.contains(e.target)) closeContextMenu();
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', closeContextMenu);
  window.addEventListener('resize', closeContextMenu);

  active = {
    menu,
    dispose: () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', closeContextMenu);
      window.removeEventListener('resize', closeContextMenu);
    },
  };
}

/** Put the menu at the pointer, pulled back from whichever edge it would cross. */
function position(menu, event) {
  const rect = menu.getBoundingClientRect();
  const x = event?.clientX ?? 0;
  const y = event?.clientY ?? 0;
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  // flip above the pointer rather than run off the bottom of a short window
  const below = y + rect.height + 4 <= window.innerHeight;
  menu.style.top = `${Math.max(4, below ? y : y - rect.height)}px`;
}

export function closeContextMenu() {
  if (!active) return;
  active.dispose();
  active.menu.remove();
  active = null;
}
