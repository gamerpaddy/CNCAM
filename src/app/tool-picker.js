// The tool library: a modal list of cutters to pull into the project.
//
// Two kinds of entry, and the difference matters. The built-in catalogues are a
// starting point that is always there — you cannot delete them, and nothing you
// do to a project changes them. Your own catalogues are the cutters you built in
// the wizard, kept out of a project or imported from a file; they live in this
// browser and they can be thrown away again.
//
// A *catalogue* is a named drawer rather than one long list, because a shop does
// not have "my tools": it has what is in the mill's carousel, what is in the
// lathe's turret, and a box of specials for the job that comes back every March.
// The picker shows one drawer at a time, or all of them, and any drawer can be
// written to a file and read back — which is what makes this a library rather
// than a heap.
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
  presetsFor, userCatalogsFor, removeUserTool, machineCanHold, BUILTIN_CATALOGS,
  catalogById, createCatalog, renameCatalog, deleteCatalog, saveUserTool,
  loadCatalogs, DEFAULT_CATALOG,
  serializeLibrary, deserializeCatalog,
} from '../doc/tool-library.js';
import { openContextMenu } from './context-menu.js';
import { openToolWizard } from './tool-wizard.js';
import { isPhoto, pickPhotoFile, capturePhoto } from './tool-photo.js';

const ALL = 'all';

/**
 * @param machine 'mill' | 'turn' — which cutters this machine can hold
 * @param handlers { onAdd(tools), onNew?(), onImport?, onExport?, files?, onStatus? }
 *   `files` is { open(), save(name, text) } — the catalogue buttons do their own
 *   reading and writing, because what goes in the file is a catalogue and only
 *   this dialog knows which one is being looked at.
 * @returns the dialog element, already appended and open
 */
export function openToolPicker({
  machine = 'mill', onAdd, onNew, onImport, onExport, files = null, onStatus = null,
}) {
  const dialog = el('dialog', { class: 'lib-dialog' });
  const body = el('div', { class: 'lib-body' });
  const count = el('span', { class: 'lib-count' }, ['']);
  const catalogBar = el('div', { class: 'lib-catalogs' });
  let checkboxes = [];
  let query = '';
  // which drawer is open. 'all' is every one of them at once, which is what the
  // dialog did before catalogues existed and is still the right default: most
  // people have one drawer and never touch this.
  let selected = ALL;

  function say(message, isError = false) { onStatus?.(message, isError); }

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

  /**
   * The sections to draw, in the order they are read: your own drawers first,
   * because they are the ones you filled, then the built-in ones.
   *
   * A built-in group's heading says which catalogue it came from whenever more
   * than one is on screen — two catalogues both have a group called "End mills",
   * and a heading that does not say which is a heading that lies.
   */
  function sections() {
    const out = [];
    for (const catalog of userCatalogsFor(machine)) {
      if (selected !== ALL && selected !== catalog.id) continue;
      out.push({ title: catalog.name, tools: catalog.tools, catalogId: catalog.id });
    }
    for (const group of presetsFor(machine)) {
      if (selected !== ALL && selected !== group.catalog) continue;
      out.push({
        title: selected === ALL ? `${group.catalogName} · ${group.group}` : group.group,
        tools: group.tools,
      });
    }
    return out;
  }

  function build() {
    checkboxes = [];
    const groups = sections();
    const everything = groups.flatMap((g) => g.tools);
    // one scale across the whole library, so a Ø3 next to a Ø12 looks like a Ø3
    // next to a Ø12 rather than two icons of the same size
    const widest = Math.max(8, ...everything.map((t) => t.diameter ?? 0));

    const nodes = [];
    const shown = [];
    for (const group of groups) {
      const visible = group.tools.filter(matches);
      if (visible.length === 0) continue;
      shown.push(...visible);
      nodes.push(el('div', { class: 'lib-group' }, [
        el('h3', {}, [group.title, el('span', { class: 'lib-group-count' }, [` ${visible.length}`])]),
        el('div', { class: 'lib-grid' }, visible.map((tool) => card(tool, widest, {
          catalogId: group.catalogId ?? null,
          catalogName: group.title,
          onDelete: group.catalogId
            ? () => {
              removeUserTool(tool.name, group.catalogId);
              say(`${tool.name} removed from ${group.title}`);
              refresh();
            }
            : null,
        }))),
      ]));
    }

    if (nodes.length === 0) {
      nodes.push(el('div', { class: 'tree-empty' }, [query
        ? `Nothing matches “${search.value}”.`
        : selected === ALL
          ? 'No cutters for this machine.'
          : 'This catalogue is empty — build a tool and tick “Add to my library”, '
            + 'or import one from a file.']));
    }
    body.replaceChildren(...nodes);
    count.textContent = query
      ? `${shown.length} of ${everything.length}`
      : `${everything.length} cutters`;
    updateAddLabel();
  }

  /** Rebuild the catalogue bar as well — after anything that adds or removes one. */
  function refresh() {
    buildCatalogBar();
    build();
  }

  /**
   * One cutter: its shape, big enough to recognise, and what it is underneath.
   *
   * The whole card is the label, so clicking anywhere on it ticks the box —
   * a checkbox you have to hit exactly is a checkbox you miss.
   */
  function card(tool, widest, { onDelete, catalogId = null, catalogName = '' }) {
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
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu(e, menuForCard(tool, catalogId, catalogName));
    });
    return node;
  }

  /**
   * What you can do to a cutter in the library, on the card it is on.
   *
   * Right-clicking one did nothing at all, and every way of changing a tool was
   * somewhere else: pull it into a project, correct it there, save it back,
   * delete the old entry. The card is where you are looking when you decide a
   * tool is wrong, so this is where the answer belongs.
   *
   * The two kinds of card get different menus, because they are genuinely
   * different things: your own catalogue entries can be changed, and the
   * built-in presets cannot be, by anything, ever. So a preset is not offered a
   * greyed-out Edit — it is offered the copy that would be editable.
   */
  function menuForCard(tool, catalogId, catalogName) {
    const add = {
      label: 'Add to the project',
      hint: 'The same as ticking it and pressing Add — double-clicking does it too',
      onclick: () => { dialog.close(); onAdd([tool]); },
    };
    if (!catalogId) {
      return [
        add,
        { separator: true },
        {
          label: 'Copy to my library',
          hint: 'Built-in presets cannot be changed — a copy in your own catalogue can',
          onclick: () => copyToMine(tool, false),
        },
        {
          label: 'Copy to my library and edit…',
          hint: 'The copy, opened in the builder',
          onclick: () => copyToMine(tool, true),
        },
      ];
    }
    const others = loadCatalogs().filter((c) => c.id !== catalogId);
    return [
      add,
      { separator: true },
      { label: 'Edit…', onclick: () => editCatalogTool(tool, catalogId, catalogName) },
      {
        label: 'Duplicate',
        hint: `A second copy in ${catalogName}, to change without losing this one`,
        onclick: () => {
          const copy = { ...tool, name: uniqueName(`${tool.name} copy`, catalogId) };
          saveUserTool(copy, catalogId);
          say(`${copy.name} added to ${catalogName}`);
          refresh();
        },
      },
      // Moving a cutter between drawers is most of what having drawers is for:
      // a special that turned out to be general belongs in the carousel now.
      ...others.map((c) => ({
        label: `Copy to ${c.name}`,
        onclick: () => {
          saveUserTool({ ...tool, name: uniqueName(tool.name, c.id) }, c.id);
          say(`${tool.name} copied to ${c.name}`);
          refresh();
        },
      })),
      { separator: true },
      {
        label: isPhoto(tool.image) ? 'Replace the photo…' : 'Add a photo…',
        hint: 'A picture of the real cutter, shown instead of the drawing',
        onclick: () => setPhoto(tool, catalogId, catalogName, 'file'),
      },
      {
        label: 'Photograph it…',
        hint: 'Hold the cutter up to the webcam',
        onclick: () => setPhoto(tool, catalogId, catalogName, 'camera'),
      },
      ...(isPhoto(tool.image) ? [{
        label: 'Remove the photo',
        onclick: () => setPhoto(tool, catalogId, catalogName, null),
      }] : []),
      { separator: true },
      {
        label: `Remove from ${catalogName}`, danger: true,
        onclick: () => {
          if (!confirm(`Remove ${tool.name} from ${catalogName}?\n\n`
            + 'It goes out of this browser’s library. Projects already using it '
            + 'keep their own copy, and the built-in presets are untouched.')) return;
          removeUserTool(tool.name, catalogId);
          say(`${tool.name} removed from ${catalogName}`);
          refresh();
        },
      },
    ];
  }

  /**
   * Edit an entry in place.
   *
   * The wizard is the same dialog the tool was built in, and what comes back is
   * a full tool record — with an id and a number, which a catalogue entry does
   * not have: those belong to the project it is pulled into. So they are
   * dropped on the way back in, and a rename takes the old entry with it, since
   * `saveUserTool` matches on the name and would otherwise leave the cutter in
   * the drawer twice under two names.
   */
  function editCatalogTool(tool, catalogId, catalogName) {
    openToolWizard({
      machine,
      tool,
      onCreate: (next) => {
        const { id, number, ...record } = next;
        if (record.name !== tool.name) removeUserTool(tool.name, catalogId);
        saveUserTool(record, catalogId);
        say(`${record.name} updated in ${catalogName} — ${describeTool(record)}`);
        refresh();
      },
    });
  }

  /** A preset copied into a drawer you own — optionally straight into the builder. */
  function copyToMine(tool, thenEdit) {
    const mine = loadCatalogs();
    const target = mine.find((c) => c.id === DEFAULT_CATALOG) ?? mine[0];
    if (!target) return say('Could not reach your library', true);
    const copy = { ...tool, name: uniqueName(tool.name, target.id) };
    if (!saveUserTool(copy, target.id)) {
      return say('Could not save to your library — browser storage is full or unavailable', true);
    }
    say(`${copy.name} copied to ${target.name}`);
    refresh();
    if (thenEdit) editCatalogTool(copy, target.id, target.name);
    return undefined;
  }

  function setPhoto(tool, catalogId, catalogName, source) {
    const write = (image) => {
      saveUserTool({ ...tool, image }, catalogId);
      say(image
        ? `${tool.name} in ${catalogName} now shows its photo`
        : `${tool.name} is drawn from its numbers again`);
      refresh();
    };
    if (source === null) return write(null);
    const onError = (message) => say(message, true);
    return (source === 'camera' ? capturePhoto({ onError }) : pickPhotoFile({ onError }))
      .then((image) => { if (image) write(image); });
  }

  /** A name nothing in that drawer already has — saving on top of one replaces it. */
  function uniqueName(base, catalogId) {
    const taken = new Set((catalogById(catalogId)?.tools ?? []).map((t) => t.name));
    if (!taken.has(base)) return base;
    const stem = base.replace(/ \d+$/, '');
    for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}`)) return `${stem} ${n}`;
  }

  // --- the catalogue bar ---------------------------------------------------

  const catalogSelect = el('select', { class: 'lib-catalog-select' });
  catalogSelect.addEventListener('change', () => {
    selected = catalogSelect.value;
    refresh();
  });

  function buildCatalogBar() {
    const mine = userCatalogsFor(machine);
    // A catalogue that has gone — deleted from under the selection — falls back
    // to all of them rather than showing an empty dialog with no way out.
    if (selected !== ALL && !mine.some((c) => c.id === selected)
      && !BUILTIN_CATALOGS.some((c) => c.id === selected)) {
      selected = ALL;
    }
    catalogSelect.replaceChildren(
      el('option', { value: ALL }, ['All catalogues']),
      el('optgroup', { label: 'Mine' }, mine.map((c) =>
        el('option', { value: c.id }, [`${c.name} (${c.tools.length})`]))),
      el('optgroup', { label: 'Built in' }, BUILTIN_CATALOGS.map((c) =>
        el('option', { value: c.id }, [c.name]))),
    );
    catalogSelect.value = selected;

    const builtin = BUILTIN_CATALOGS.find((c) => c.id === selected);
    const own = mine.find((c) => c.id === selected);
    const buttons = [
      el('button', {
        title: 'A new, empty drawer to keep cutters in',
        onclick: newCatalog,
      }, ['New…']),
      ...(files ? [el('button', {
        title: 'Read a catalogue file into a drawer of your own',
        onclick: importCatalog,
      }, ['Import…'])] : []),
      ...(files ? [el('button', {
        title: selected === ALL
          ? 'Write every cutter you have to one file'
          : `Write ${builtin?.name ?? own?.name} to a file`,
        onclick: exportCatalog,
      }, ['Export…'])] : []),
    ];
    if (own) {
      buttons.push(
        el('button', { onclick: () => renameSelected(own) }, ['Rename…']),
        el('button', {
          title: own.id === 'mine'
            ? 'Empty this drawer — it is where a tool goes when nobody says where, so it stays'
            : `Throw ${own.name} away`,
          onclick: () => removeSelected(own),
        }, [own.id === 'mine' ? 'Empty' : 'Delete']),
      );
    }
    if (builtin) {
      buttons.push(el('button', {
        title: 'Copy it into a drawer of your own, where it can be edited',
        onclick: () => duplicate(builtin),
      }, ['Duplicate to mine']));
    }

    catalogBar.replaceChildren(
      el('span', { class: 'lib-catalog-label' }, ['Catalogue']),
      catalogSelect,
      ...buttons,
      el('span', { class: 'spacer' }),
      el('span', { class: 'lib-hint' }, [builtin
        ? builtin.note
        : own
          ? 'Yours: cutters here can be edited away, and written to a file.'
          : 'Everything at once — your own drawers first, then the built-in ones.']),
    );
  }

  function newCatalog() {
    const name = window.prompt('Name for the new catalogue', 'Carousel');
    if (name == null) return;
    const made = createCatalog(name);
    if (!made) return say('Could not make a catalogue (browser storage is unavailable)', true);
    selected = made.id;
    refresh();
    say(`Catalogue “${made.name}” created`);
  }

  function renameSelected(catalog) {
    const name = window.prompt('Name for this catalogue', catalog.name);
    if (name == null) return;
    if (!renameCatalog(catalog.id, name)) return;
    refresh();
    say(`Renamed to “${name.trim()}”`);
  }

  function removeSelected(catalog) {
    const emptying = catalog.id === 'mine';
    const what = emptying
      ? `Empty “${catalog.name}”? Its ${catalog.tools.length} cutters are thrown away.`
      : `Delete “${catalog.name}” and its ${catalog.tools.length} cutters?`;
    if (catalog.tools.length > 0 && !window.confirm(what)) return;
    deleteCatalog(catalog.id);
    if (!emptying) selected = ALL;
    refresh();
    say(emptying ? `${catalog.name} emptied` : `${catalog.name} deleted`);
  }

  /**
   * A built-in catalogue, copied into one of the user's.
   *
   * The built-ins cannot be edited, which is the point of them — but "start from
   * the standard set and change six things" is how a shop's own drawer actually
   * gets built, and the alternative was typing forty cutters in from nothing.
   */
  function duplicate(builtin) {
    const full = catalogById(builtin.id);
    const tools = full.tools.filter((t) => machineCanHold(t.type, machine));
    // "(copy)" rather than letting the name clash and come back as
    // "Imperial / inch 2", which reads as a second edition of the catalogue
    // rather than as your copy of it
    const made = createCatalog(`${builtin.name} (copy)`, tools.map((t) => ({ ...t })));
    if (!made) return say('Could not copy the catalogue (browser storage is unavailable)', true);
    selected = made.id;
    refresh();
    say(`Copied ${tools.length} cutters into “${made.name}”`);
  }

  async function importCatalog() {
    const file = await files.open();
    if (!file) return;
    try {
      const { name, tools } = deserializeCatalog(new TextDecoder().decode(file.buffer));
      // The name inside the file wins, because it is the name whoever exported
      // it chose; a file called `tools (3).json` is not a name anybody meant.
      const made = createCatalog(name || file.name.replace(/\.json$/i, ''), tools);
      if (!made) throw new Error('browser storage is unavailable');
      selected = made.id;
      refresh();
      say(`Imported ${tools.length} cutters into “${made.name}”`);
    } catch (err) {
      say(`Catalogue import failed: ${err.message}`, true);
    }
  }

  async function exportCatalog() {
    const catalog = selected === ALL
      ? { name: 'All my tools', tools: userCatalogsFor(machine).flatMap((c) => c.tools) }
      : catalogById(selected);
    if (!catalog || catalog.tools.length === 0) {
      return say('That catalogue has no cutters in it', true);
    }
    const file = `${catalog.name.replace(/[^\w.-]+/g, '-').toLowerCase()}-tools.json`;
    await files.save(file, serializeLibrary(catalog.tools, catalog.name));
    say(`Exported ${catalog.tools.length} cutters from “${catalog.name}”`);
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

  buildCatalogBar();
  build();
  dialog.append(
    el('div', { class: 'lib-head' }, [
      el('h2', {}, [machine === 'turn' ? 'Lathe tooling' : 'Tool library']),
      count,
      search,
    ]),
    catalogBar,
    body,
    el('div', { class: 'lib-actions' }, [
      el('button', {
        class: 'primary-outline',
        title: 'Build a cutter: pick the shape, then only the sizes it has',
        onclick: () => { dialog.close(); onNew?.(); },
      }, ['+ New tool…']),
      el('button', {
        title: 'Read a file straight into this project’s tool list',
        onclick: () => { dialog.close(); onImport?.(); },
      }, ['Import to project…']),
      el('button', {
        title: 'Write this project’s tools to a file',
        onclick: () => { dialog.close(); onExport?.(); },
      }, ['Export project tools']),
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
