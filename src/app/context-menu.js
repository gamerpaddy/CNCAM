// Popup menu — right-click on a tree row, or left-click an affordance that has
// several things it could do.
//
// Items are `{ label, onclick, danger?, separator?, disabled?, hint?, keys?,
// checked?, className? }` so a caller can describe what should happen without
// touching the DOM. `keys` is the shortcut, printed at the right-hand end of
// the row the way every desktop menu prints it — a menu is where a key is
// learnt. `checked` marks the one of a set that is in force.
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
      class: `context-item${item.danger ? ' danger' : ''}${item.className ? ` ${item.className}` : ''}`,
      type: 'button',
      role: item.checked != null ? 'menuitemradio' : 'menuitem',
      onclick: () => {
        closeContextMenu();
        item.onclick?.();
      },
    }, [
      el('span', { class: 'context-check', 'aria-hidden': 'true' }, [item.checked ? '●' : '']),
      el('span', { class: 'context-label' }, [item.label]),
      ...(item.keys ? [el('span', { class: 'context-keys' }, [item.keys])] : []),
    ]);
    if (item.checked != null) button.setAttribute('aria-checked', item.checked ? 'true' : 'false');
    if (item.disabled) button.disabled = true;
    if (item.hint) button.title = item.hint;
    menu.append(button);
    if (!item.disabled) buttons.push(button);
  }

  // Into the open dialog, when there is one.
  //
  // A modal <dialog> is in the browser's top layer, and everything outside it
  // paints behind the backdrop no matter what z-index it carries. So a menu
  // appended to the body from inside a dialog — right-clicking a cutter in the
  // tool library, say — was built, positioned and dismissible, and completely
  // invisible: the click looked like it had done nothing, which is exactly how
  // "there is no context menu here" looks. The menu is `position: fixed`, so
  // moving it inside the dialog costs nothing.
  const dialogs = document.querySelectorAll('dialog[open]');
  (dialogs[dialogs.length - 1] ?? document.body).append(menu);
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

/**
 * Put the menu at the pointer, pulled back from whichever edge it would cross.
 *
 * A menu opened from a button is handed an anchor rather than the pointer:
 * `alignRight` lines its right edge up with the point (a button at the right of
 * a bar drops its menu leftwards, into the window) and `above` stands it on the
 * point (a button on the status line opens upwards).
 */
function position(menu, event) {
  const rect = menu.getBoundingClientRect();
  const x = event?.clientX ?? 0;
  const y = event?.clientY ?? 0;
  const left = event?.alignRight ? x - rect.width : x;
  menu.style.left = `${Math.max(4, Math.min(left, window.innerWidth - rect.width - 4))}px`;
  // flip above the pointer rather than run off the bottom of a short window
  const below = !event?.above && y + rect.height + 4 <= window.innerHeight;
  menu.style.top = `${Math.max(4, below ? y : y - rect.height)}px`;
}

/**
 * A menu opened from a button drops from the button's bottom edge, the way a
 * menu bar's does, rather than from wherever inside it the pointer happened to
 * be. `align: 'right'` lines the menu's right edge up with the button's, for a
 * button at the right-hand end of something.
 */
export function anchorBelow(event, align = 'left') {
  const r = event?.currentTarget?.getBoundingClientRect?.();
  if (!r) return event;
  return { clientX: align === 'right' ? r.right : r.left, clientY: r.bottom + 4, alignRight: align === 'right' };
}

/** The same, upwards, for a button on the status line at the bottom. */
export function anchorAbove(event) {
  const r = event?.currentTarget?.getBoundingClientRect?.();
  if (!r) return event;
  return { clientX: r.left, clientY: r.top - 4, above: true };
}

export function closeContextMenu() {
  if (!active) return;
  active.dispose();
  active.menu.remove();
  active = null;
}
