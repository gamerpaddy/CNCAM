// The tool library: a modal list of cutters to pull into the project.
//
// Two kinds of entry, and the difference matters. The built-in presets are a
// starting point that is always there — you cannot delete them, and nothing you
// do to a project changes them. Your own tools are the ones you built in the
// wizard or kept out of a project, they live in this browser, and they can be
// thrown away again.
//
// Laid out as a grid of cards rather than a list of rows. A tool list is read by
// scanning for a *shape*, and a row gives a shape sixty pixels of a four-hundred
// pixel line and then a third of a line of whitespace after the text — so the
// thing you are scanning for is the smallest thing on screen, and there is a
// screenful of gap between one and the next. A card gives the drawing the room
// and puts the numbers under it, which fits three times as many cutters in the
// same dialog and makes each one twice the size.
//
// Uses <dialog> so focus trapping, Escape and the backdrop come from the
// platform rather than being reimplemented. Multiple tools can be ticked and
// added in one go, since setting up a job usually means pulling several.

import { el } from './layout.js';
import { toolIcon, describeTool } from './tool-shape.js';
import {
  presetsFor, loadUserTools, removeUserTool, machineCanHold,
} from '../doc/tool-library.js';

/**
 * @param machine 'mill' | 'turn' — which cutters this machine can hold
 * @param handlers { onAdd(tools), onNew?(), onImport?, onExport? }
 * @returns the dialog element, already appended and open
 */
export function openToolPicker({
  machine = 'mill', onAdd, onNew, onImport, onExport,
}) {
  const dialog = el('dialog', { class: 'lib-dialog' });
  const body = el('div', { class: 'lib-body' });
  const count = el('span', { class: 'lib-count' }, ['']);
  let checkboxes = [];
  let query = '';

  // Searching a library of forty cutters by eye is the thing the grid above
  // makes fast and this makes unnecessary. Matches the name, the ISO code and
  // the family, because those are the three ways anybody refers to a tool.
  const search = el('input', {
    type: 'search',
    class: 'lib-search',
    placeholder: 'Search — name, ISO code, 6mm, ball, CNMG…',
  });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); build(); });

  function matches(tool) {
    if (!query) return true;
    const haystack = [
      tool.name, tool.type, tool.insertCode, tool.insert, describeTool(tool),
      `${tool.diameter}mm`, `⌀${tool.diameter}`,
    ].filter(Boolean).join(' ').toLowerCase();
    // every word has to appear somewhere, so "6 ball" finds the 6mm ball nose
    return query.split(/\s+/).every((word) => haystack.includes(word));
  }

  function build() {
    checkboxes = [];
    const mine = loadUserTools().filter((t) => machineCanHold(t.type, machine));
    const groups = presetsFor(machine);
    const everything = [...mine, ...groups.flatMap((g) => g.tools)];
    // one scale across the whole library, so a Ø3 next to a Ø12 looks like a Ø3
    // next to a Ø12 rather than two icons of the same size
    const widest = Math.max(8, ...everything.map((t) => t.diameter ?? 0));

    const sections = [];
    const shown = [];
    const section = (title, tools, options = {}) => {
      const visible = tools.filter(matches);
      if (visible.length === 0) return;
      shown.push(...visible);
      sections.push(el('div', { class: 'lib-group' }, [
        el('h3', {}, [title, el('span', { class: 'lib-group-count' }, [` ${visible.length}`])]),
        el('div', { class: 'lib-grid' }, visible.map((tool) => card(tool, widest, options))),
      ]));
    };

    section('My tools', mine, {
      onDelete: (tool) => { removeUserTool(tool.name); build(); },
    });
    for (const group of groups) section(group.group, group.tools);

    if (sections.length === 0) {
      sections.push(el('div', { class: 'tree-empty' }, [query
        ? `Nothing matches “${search.value}”.`
        : 'No cutters for this machine.']));
    }
    body.replaceChildren(...sections);
    count.textContent = query
      ? `${shown.length} of ${everything.length}`
      : `${everything.length} cutters`;
    updateAddLabel();
  }

  /**
   * One cutter: its shape, big enough to recognise, and what it is underneath.
   *
   * The whole card is the label, so clicking anywhere on it ticks the box —
   * a checkbox you have to hit exactly is a checkbox you miss.
   */
  function card(tool, widest, { onDelete }) {
    const box = el('input', { type: 'checkbox', class: 'lib-check' });
    checkboxes.push({ box, tool });

    const children = [
      box,
      el('div', { class: 'lib-preview' }, [
        toolIcon(tool, { width: 168, height: 78, scaleTo: widest, orientation: 'horizontal' }),
      ]),
      el('div', { class: 'lib-text' }, [
        el('span', { class: 'lib-name' }, [tool.name]),
        el('span', { class: 'lib-meta' }, [describeTool(tool)]),
        el('span', { class: 'lib-speeds' }, [
          `${tool.spindleRpm ?? '—'} rpm · F${tool.feedCut ?? '—'}`,
        ]),
      ]),
    ];

    if (onDelete) {
      const remove = el('button', {
        class: 'lib-remove',
        type: 'button',
        title: `Remove ${tool.name} from your library`,
      }, ['✕']);
      // inside a <label>, so the click has to be stopped from ticking the box
      remove.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onDelete(tool);
      });
      children.push(remove);
    }

    const node = el('label', { class: 'lib-item', title: describeTool(tool) }, children);
    box.addEventListener('change', () => {
      node.classList.toggle('checked', box.checked);
      updateAddLabel();
    });
    // double-click is "this one, now" — the same shortcut the strategy picker has
    node.addEventListener('dblclick', () => {
      dialog.close();
      onAdd([tool]);
    });
    return node;
  }

  const add = el('button', { class: 'primary' }, ['Add selected']);
  function updateAddLabel() {
    const n = checkboxes.filter((c) => c.box.checked).length;
    add.textContent = n === 0 ? 'Add selected' : `Add ${n} tool${n === 1 ? '' : 's'}`;
    add.disabled = n === 0;
  }
  add.addEventListener('click', () => {
    const chosen = checkboxes.filter((c) => c.box.checked).map((c) => c.tool);
    dialog.close();
    if (chosen.length) onAdd(chosen);
  });

  build();
  dialog.append(
    el('div', { class: 'lib-head' }, [
      el('h2', {}, [machine === 'turn' ? 'Lathe tooling' : 'Tool library']),
      count,
      search,
    ]),
    body,
    el('div', { class: 'lib-actions' }, [
      el('button', {
        class: 'primary-outline',
        title: 'Build a cutter: pick the shape, then only the sizes it has',
        onclick: () => { dialog.close(); onNew?.(); },
      }, ['+ New tool…']),
      el('button', { onclick: () => { dialog.close(); onImport?.(); } }, ['Import…']),
      el('button', { onclick: () => { dialog.close(); onExport?.(); } }, ['Export project tools']),
      el('span', { class: 'lib-hint' }, ['double-click a cutter to add just that one']),
      el('span', { class: 'spacer' }),
      el('button', { onclick: () => dialog.close() }, ['Cancel']),
      add,
    ]),
  );
  dialog.addEventListener('close', () => dialog.remove());

  document.body.append(dialog);
  dialog.showModal();
  // the search box is where anybody who knows what they want starts
  search.focus();
  return dialog;
}
