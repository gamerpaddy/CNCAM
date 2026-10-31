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

import { el, dialogCloseButton } from './layout.js';
import {
  toolIcon, toolAssembly, describeTool, coatingLegend, coatingOf, COATINGS,
  toolCalloutsEnabled,
} from './tool-shape.js';
import { getSetting, setSetting } from './settings.js';
import { TOOL_TYPE_LABELS } from '../doc/schema.js';
import {
  presetsFor, userCatalogsFor, removeUserTool, machineCanHold, BUILTIN_CATALOGS,
  catalogById, createCatalog, renameCatalog, deleteCatalog, saveUserTool,
  loadCatalogs, DEFAULT_CATALOG,
  serializeLibrary, deserializeCatalog, toolFromPreset, cuttingReadout,
} from '../doc/tool-library.js';
import { openContextMenu } from './context-menu.js';
import { openToolWizard } from './tool-wizard.js';
import { isPhoto, pickPhotoFile, capturePhoto } from './tool-photo.js';

const ALL = 'all';

// Favourites and recents are per-browser conveniences, like the library itself:
// kept by name, because a catalogue entry has no id until it is in a project.
// Every read and write is guarded — private windows and blocked storage throw.
const FAVOURITES_KEY = 'cncam.toolFavourites';
const RECENT_KEY = 'cncam.toolRecent';
const RECENT_MAX = 16;

function readList(key) {
  try {
    const list = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* the star lasts this session only */ }
}

/** Remember that these were pulled into a project, newest first. */
function rememberTools(tools) {
  const names = tools.map((t) => t.name);
  writeList(RECENT_KEY, [...names, ...readList(RECENT_KEY).filter((n) => !names.includes(n))]
    .slice(0, RECENT_MAX));
}

// The size bands are where tools are bought in: 3mm and under for fine work,
// the middle two for most of a job, and everything big enough to rough with.
const SIZE_BANDS = [
  { id: 'xs', label: '≤ 3', test: (d) => d <= 3 },
  { id: 's', label: '3 – 6', test: (d) => d > 3 && d <= 6 },
  { id: 'm', label: '6 – 12', test: (d) => d > 6 && d <= 12 },
  { id: 'l', label: '> 12', test: (d) => d > 12 },
];

const shortType = (type) => (TOOL_TYPE_LABELS[type] ?? type).split(' (')[0];

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
  const main = el('div', { class: 'lib-main' });
  const count = el('span', { class: 'lib-count' }, ['']);
  const catalogBar = el('div', { class: 'lib-catalogs' });
  let checkboxes = [];
  // What is ticked, by where it came from and what it is called — held apart
  // from the checkboxes, which are thrown away on every rebuild. They used to be
  // the only record, so typing in the search box untied everything: tick the
  // end mill, search for the drill, tick that, clear the search, and "Add"
  // added nothing. Pulling several cutters at once is what the ticks are for,
  // and the search is how anybody finds the second one.
  const picked = new Map();          // key → tool
  const keyOf = (tool, source) => `${source ?? ''}/${tool.name}`;
  let query = '';
  // The filters narrow what is on screen and nothing else — they are not saved,
  // because a picker that opens already filtered looks like a library that has
  // lost half its tools. The layout and the order are kept: those are taste.
  const typeFilter = new Set();
  let sizeFilter = null;
  let onlyFavourites = false;
  let onlyRecent = false;
  let view = getSetting('toolPickerView') === 'list' ? 'list' : 'grid';
  let sortBy = getSetting('toolPickerSort');
  let favourites = new Set(readList(FAVOURITES_KEY));
  let recent = readList(RECENT_KEY);
  // which drawer is open. 'all' is every one of them at once, which is what the
  // dialog did before catalogues existed and is still the right default: most
  // people have one drawer and never touch this.
  let selected = ALL;

  function say(message, isError = false) { onStatus?.(message, isError); }

  /** Every way a tool gets into the project goes through here, so it is remembered. */
  function addTools(tools) {
    rememberTools(tools);
    onAdd(tools);
  }

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

  /** The search box and the chips together — a tool has to pass both. */
  function visible(tool) {
    if (!matches(tool)) return false;
    if (typeFilter.size && !typeFilter.has(tool.type)) return false;
    if (sizeFilter && !SIZE_BANDS.find((b) => b.id === sizeFilter).test(tool.diameter ?? 0)) return false;
    if (onlyFavourites && !favourites.has(tool.name)) return false;
    if (onlyRecent && !recent.includes(tool.name)) return false;
    return true;
  }

  /** Favourites first, then the chosen order; a stable sort keeps the catalogue's own. */
  function ordered(tools) {
    const by = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      diameter: (a, b) => (a.diameter ?? 0) - (b.diameter ?? 0),
      type: (a, b) => a.type.localeCompare(b.type) || (a.diameter ?? 0) - (b.diameter ?? 0),
      recent: (a, b) => {
        const rank = (t) => { const i = recent.indexOf(t.name); return i < 0 ? 1e6 : i; };
        return rank(a) - rank(b);
      },
    }[sortBy];
    return [...tools].sort((a, b) =>
      (favourites.has(b.name) - favourites.has(a.name)) || (by ? by(a, b) : 0));
  }

  function toggleFavourite(tool) {
    if (favourites.has(tool.name)) favourites.delete(tool.name); else favourites.add(tool.name);
    writeList(FAVOURITES_KEY, [...favourites]);
    build();
  }

  // --- the filter bar: layout, order and chips --------------------------------

  const filterBar = el('div', { class: 'lib-filters' });
  const sortSelect = el('select', { class: 'lib-sort', title: 'Order inside each group' }, [
    ['catalogue', 'Catalogue order'], ['name', 'Name'], ['diameter', 'Diameter'],
    ['type', 'Kind of tool'], ['recent', 'Recently used'],
  ].map(([value, label]) => el('option', { value }, [label])));
  sortSelect.value = sortBy;
  sortSelect.addEventListener('change', () => {
    sortBy = sortSelect.value;
    setSetting('toolPickerSort', sortBy);
    build();
  });

  function chip(label, active, onclick, title = '') {
    const node = el('button', {
      type: 'button', class: `lib-chip${active ? ' active' : ''}`, title, onclick,
    }, [label]);
    node.setAttribute('aria-pressed', String(active));
    return node;
  }

  function viewButton(mode, label, title) {
    const node = el('button', {
      type: 'button', class: `lib-view${view === mode ? ' active' : ''}`, title,
      onclick: () => { view = mode; setSetting('toolPickerView', mode); build(); },
    }, [label]);
    node.setAttribute('aria-pressed', String(view === mode));
    return node;
  }

  function buildFilterBar(everything) {
    const types = [...new Set(everything.map((t) => t.type))];
    const count = (fn) => everything.filter(fn).length;
    const anyFilter = typeFilter.size || sizeFilter || onlyFavourites || onlyRecent;
    filterBar.replaceChildren(
      el('div', { class: 'lib-view-toggle' }, [
        viewButton('grid', 'Cards', 'Big drawings, three or four across'),
        viewButton('list', 'List', 'Rows, with the whole tool drawn to scale beside them'),
      ]),
      sortSelect,
      chip(`★ Favourites ${count((t) => favourites.has(t.name))}`, onlyFavourites, () => {
        onlyFavourites = !onlyFavourites; build();
      }, 'Only the tools you have starred'),
      chip(`Recent ${count((t) => recent.includes(t.name))}`, onlyRecent, () => {
        onlyRecent = !onlyRecent; build();
      }, 'Tools you have added to a project lately'),
      el('span', { class: 'lib-chip-sep' }),
      ...types.map((type) => chip(`${shortType(type)} ${count((t) => t.type === type)}`,
        typeFilter.has(type), () => {
          if (typeFilter.has(type)) typeFilter.delete(type); else typeFilter.add(type);
          build();
        })),
      el('span', { class: 'lib-chip-sep' }),
      el('span', { class: 'lib-chip-label' }, ['⌀ mm']),
      ...SIZE_BANDS.map((band) => chip(band.label, sizeFilter === band.id, () => {
        sizeFilter = sizeFilter === band.id ? null : band.id; build();
      }, 'Diameter of the cutter, or the inscribed circle of an insert')),
      ...(anyFilter ? [el('button', {
        type: 'button', class: 'lib-chip lib-chip-clear', onclick: clearFilters,
      }, ['Clear filters'])] : []),
    );
  }

  function clearFilters() {
    typeFilter.clear(); sizeFilter = null; onlyFavourites = false; onlyRecent = false;
    search.value = ''; query = '';
    build();
  }

  // --- the preview beside the list ------------------------------------------

  const pane = el('aside', { class: 'lib-pane' });
  let paneTool = null;

  /**
   * The whole tool, to scale, with its dimensions — the list's answer to "which
   * one is this, and how far does it stick out". Drawn from the materialised
   * tool, because a catalogue entry has no shank or holder of its own and the
   * assembly is the thing that shows them.
   */
  function showInPane(tool) {
    if (view !== 'list') return;
    paneTool = tool;
    if (!tool) {
      pane.replaceChildren(el('div', { class: 'lib-pane-empty' }, [
        'Point at a tool to see it whole — flutes, shank, holder and the numbers between them.']));
      return;
    }
    const full = toolFromPreset(tool);
    pane.replaceChildren(
      toolAssembly(full, { width: 232, height: 270, callouts: toolCalloutsEnabled() }),
      el('div', { class: 'lib-pane-name' }, [tool.name]),
      el('div', { class: 'lib-meta wrap' }, [describeTool(tool)]),
      el('div', { class: 'lib-meta wrap' }, [cuttingHint(full)]),
      el('div', { class: 'lib-meta wrap' }, [
        `${COATINGS[coatingOf(tool)].label} — ${COATINGS[coatingOf(tool)].note}`]),
      coatingLegend(tool),
    );
  }

  /** The speeds a card quotes, plus the surface speed they work out to — computed, not looked up. */
  function cuttingHint(tool) {
    if (!(tool.spindleRpm > 0)) return 'no speeds set';
    const { vc, load, loadLabel } = cuttingReadout(tool);
    const lathe = tool.type === 'turning' || tool.type === 'boring'
      || tool.type === 'parting' || tool.type === 'threading';
    return `${tool.spindleRpm} rpm · F${tool.feedCut ?? '—'} · ${vc.toFixed(0)} m/min`
      + `${lathe ? ' on ⌀30 bar' : ''} · ${load.toFixed(3)}mm ${loadLabel}`;
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
        source: group.catalog,
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

    favourites = new Set(readList(FAVOURITES_KEY));
    recent = readList(RECENT_KEY);
    buildFilterBar(everything);
    const nodes = [];
    const shown = [];
    for (const group of groups) {
      const here = ordered(group.tools.filter(visible));
      if (here.length === 0) continue;
      shown.push(...here);
      nodes.push(el('div', { class: 'lib-group' }, [
        el('h3', {}, [group.title, el('span', { class: 'lib-group-count' }, [` ${here.length}`])]),
        el('div', { class: `lib-grid${view === 'list' ? ' list' : ''}` }, here.map((tool) => card(tool, widest, {
          catalogId: group.catalogId ?? null,
          catalogName: group.title,
          source: group.catalogId ?? group.source,
          onDelete: group.catalogId
            ? () => removeFromCatalog(tool, group.catalogId, group.title)
            : null,
        }))),
      ]));
    }

    if (nodes.length === 0) nodes.push(emptyState(everything.length));
    body.replaceChildren(...nodes);
    main.classList.toggle('with-pane', view === 'list');
    if (view === 'list') showInPane(shown.find((t) => t === paneTool) ?? shown[0] ?? null);
    const narrowed = query || typeFilter.size || sizeFilter || onlyFavourites || onlyRecent;
    count.textContent = narrowed
      ? `${shown.length} of ${everything.length}`
      : `${everything.length} tools`;
    updateAddLabel();
  }

  /**
   * What an empty list says: why it is empty, and the one thing to do about it.
   * "Nothing here" with no way out was the whole message before.
   */
  function emptyState(total) {
    const note = (text, ...buttons) => el('div', { class: 'lib-empty' }, [
      el('div', { class: 'lib-empty-text' }, [text]),
      el('div', { class: 'lib-empty-actions' }, buttons),
    ]);
    const clear = el('button', { onclick: clearFilters }, ['Clear filters']);
    if (total > 0 && onlyFavourites && !query) {
      return note('No favourites here yet. Press the star on a tool to keep it at the top '
        + 'of its group, in every project.', clear);
    }
    if (total > 0 && onlyRecent && !query) {
      return note('Nothing used lately. Tools you add to a project turn up here.', clear);
    }
    if (total > 0) {
      return note(query
        ? `Nothing matches “${search.value}” with these filters.`
        : 'No tool passes these filters.', clear);
    }
    if (selected === ALL) return note('No tools for this machine.');
    return note('This catalogue is empty. Build a tool and tick “Add to my library”, '
      + 'or import one from a file.',
    el('button', { class: 'primary-outline', onclick: () => { dialog.close(); onNew?.(); } },
      ['+ New tool…']));
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
  function card(tool, widest, {
    onDelete, catalogId = null, catalogName = '', source = null,
  }) {
    const key = keyOf(tool, source);
    const box = el('input', { type: 'checkbox', class: 'lib-check' });
    box.checked = picked.has(key);
    checkboxes.push({ box, tool });

    const starred = favourites.has(tool.name);
    const star = el('button', {
      type: 'button',
      class: `lib-star${starred ? ' on' : ''}`,
      title: starred ? 'Remove from favourites' : 'Add to favourites',
    }, [starred ? '★' : '☆']);
    star.setAttribute('aria-pressed', String(starred));
    star.addEventListener('click', (e) => {
      // inside a <label>: the click would otherwise tick the box as well
      e.preventDefault();
      e.stopPropagation();
      toggleFavourite(tool);
    });
    const children = [
      box,
      star,
      el('div', { class: 'lib-preview' }, [
        toolIcon(tool, {
          width: view === 'list' ? 104 : 168, height: view === 'list' ? 44 : 78,
          scaleTo: widest, orientation: 'horizontal',
        }),
      ]),
      el('div', { class: 'lib-text' }, [
        el('span', { class: 'lib-name' }, [tool.name]),
        el('span', { class: 'lib-meta' }, [describeTool(tool)]),
        el('span', { class: 'lib-speeds', title: 'Speeds from the library; surface speed is worked out from them' }, [
          tool.spindleRpm > 0
            ? `${tool.spindleRpm} rpm · F${tool.feedCut ?? '—'} · ${cuttingReadout(tool).vc.toFixed(0)} m/min`
            : 'no speeds set',
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

    const node = el('label', {
      class: `lib-item${box.checked ? ' checked' : ''}`, title: describeTool(tool),
    }, children);
    box.addEventListener('change', () => {
      node.classList.toggle('checked', box.checked);
      if (box.checked) picked.set(key, tool);
      else picked.delete(key);
      updateAddLabel();
    });
    node.addEventListener('mouseenter', () => showInPane(tool));
    node.addEventListener('focusin', () => showInPane(tool));
    // double-click is "this one, now" — the same shortcut the strategy picker has
    node.addEventListener('dblclick', () => {
      dialog.close();
      addTools([tool]);
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
      onclick: () => { dialog.close();
      addTools([tool]); },
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
        onclick: () => removeFromCatalog(tool, catalogId, catalogName),
      },
    ];
  }

  /**
   * Take a cutter out of one of the user's drawers — asked about first, from
   * the menu and from the ✕ on the card alike. The ✕ used to remove it on the
   * spot: the same loss behind a smaller button, with no undo, since the
   * library lives in this browser and nowhere else.
   */
  function removeFromCatalog(tool, catalogId, catalogName) {
    if (!confirm(`Remove ${tool.name} from ${catalogName}?\n\n`
      + 'It goes out of this browser’s library. Projects already using it '
      + 'keep their own copy, and the built-in presets are untouched.')) return;
    removeUserTool(tool.name, catalogId);
    picked.delete(keyOf(tool, catalogId));
    say(`${tool.name} removed from ${catalogName}`);
    refresh();
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
    // Named for what they act on. "New…", "Import…" and "Export…" up here sat
    // over "+ New tool…", "Import to project…" and "Export project tools" down
    // at the bottom, and nothing said the top three were about catalogues.
    const buttons = [
      el('button', {
        title: 'A new, empty drawer to keep tools in',
        onclick: newCatalog,
      }, ['New catalogue…']),
      ...(files ? [el('button', {
        title: 'Read a catalogue file into a drawer of your own',
        onclick: importCatalog,
      }, ['Import catalogue…'])] : []),
      ...(files ? [el('button', {
        title: selected === ALL
          ? 'Write every cutter you have to one file'
          : `Write ${builtin?.name ?? own?.name} to a file`,
        onclick: exportCatalog,
      }, [selected === ALL ? 'Export all…' : 'Export catalogue…'])] : []),
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
          ? 'Yours: tools here can be edited away, and written to a file.'
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
      ? `Empty “${catalog.name}”? Its ${catalog.tools.length} tools are thrown away.`
      : `Delete “${catalog.name}” and its ${catalog.tools.length} tools?`;
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
    say(`Copied ${tools.length} tools into “${made.name}”`);
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
      say(`Imported ${tools.length} tools into “${made.name}”`);
    } catch (err) {
      say(`Catalogue import failed: ${err.message}`, true);
    }
  }

  async function exportCatalog() {
    const catalog = selected === ALL
      ? { name: 'All my tools', tools: userCatalogsFor(machine).flatMap((c) => c.tools) }
      : catalogById(selected);
    if (!catalog || catalog.tools.length === 0) {
      return say('That catalogue has no tools in it', true);
    }
    const file = `${catalog.name.replace(/[^\w.-]+/g, '-').toLowerCase()}-tools.json`;
    if (!(await files.save(file, serializeLibrary(catalog.tools, catalog.name)))) return undefined;
    return say(`Exported ${catalog.tools.length} tools from “${catalog.name}”`);
  }

  const add = el('button', { class: 'primary' }, ['Add selected']);
  function updateAddLabel() {
    const n = picked.size;
    add.textContent = n === 0 ? 'Add selected' : `Add ${n} tool${n === 1 ? '' : 's'}`;
    add.disabled = n === 0;
  }
  add.addEventListener('click', () => {
    const chosen = [...picked.values()];
    dialog.close();
    if (chosen.length) addTools(chosen);
  });

  main.append(body, pane);
  buildCatalogBar();
  build();
  dialog.append(
    dialogCloseButton(dialog),
    el('div', { class: 'lib-head' }, [
      el('h2', {}, [machine === 'turn' ? 'Lathe tooling' : 'Tool library']),
      count,
      search,
    ]),
    catalogBar,
    filterBar,
    main,
    el('div', { class: 'lib-legend-row' }, [
      el('span', { class: 'lib-chip-label' }, ['Colour = material']),
      coatingLegend(),
      el('span', { class: 'spacer' }),
      el('span', { class: 'lib-hint' }, ['set per tool in the builder']),
    ]),
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
      }, ['Export project tools…']),
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
