// Builds the static DOM shell and returns references to the mount points.
// No framework: plain elements, ids for the grid areas defined in styles.css.

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    // An attribute given no value is an attribute left off. `setAttribute`
    // writes whatever it is handed as a string, and for a boolean attribute
    // the string does not matter, only its presence: `disabled: undefined`
    // wrote disabled="undefined", which is disabled — the Machines dialog's
    // Remove button was greyed out with five machines in the list.
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export { el };

// imported after the export so timeline.js can import `el` from here
// eslint-disable-next-line import/first
import { buildTimeline } from './timeline.js';
// eslint-disable-next-line import/first
import {
  VIEW_PRESETS, viewsFor, extraViewsFor, PROJECTIONS, PROJECTION_LABELS,
  PROJECTION_HINTS,
} from '../view/views.js';
// eslint-disable-next-line import/first
import { openContextMenu, anchorBelow, anchorAbove } from './context-menu.js';
// eslint-disable-next-line import/first
import { getSetting } from './settings.js';
// eslint-disable-next-line import/first
import { describeMachine } from '../doc/machines.js';
// eslint-disable-next-line import/first
import { withKey, keyFor } from './shortcuts.js';
// eslint-disable-next-line import/first
import { icon } from './icons.js';

/**
 * A toolbar button: an icon and its word. The word goes on narrow windows and
 * the icon stays, so the name moves to `aria-label` as well as the tooltip —
 * a button that is only a drawing still has to be called something.
 *
 * @param collapse which widths lose the word first: 'early' goes first, then
 *   'late'; 'keep' never loses it
 */
function toolButton(iconName, label, attrs = {}, collapse = 'late') {
  const { class: extra = '', ...rest } = attrs;
  return el('button', {
    type: 'button',
    ...rest,
    class: `tb tb-${collapse} ${extra}`.trim(),
    'aria-label': label.replace(/…$/, ''),
  }, [icon(iconName), el('span', { class: 'tb-label' }, [label])]);
}

/** An icon with no word at all, named for whoever cannot see it. */
function iconButton(iconName, label, attrs = {}) {
  const { class: extra = '', ...rest } = attrs;
  return el('button', {
    type: 'button', ...rest, class: `tb tb-icon ${extra}`.trim(), 'aria-label': label,
  }, [icon(iconName)]);
}

/**
 * The way out of a dialog, in the corner every dialog keeps it.
 *
 * Every dialog here closes on Escape and has a Cancel or a Done at the bottom —
 * which is two ways out that you have to know about or scroll to. The corner
 * cross is the one you do not have to look for.
 */
export function dialogCloseButton(dialog, onClose = () => dialog.close()) {
  return el('button', {
    type: 'button',
    class: 'ghost-icon dialog-close',
    title: 'Close (Esc)',
    'aria-label': 'Close',
    onclick: onClose,
  }, [icon('close', 15)]);
}

/** A hairline between groups of buttons that belong together. */
function divider() {
  return el('span', { class: 'tb-sep', 'aria-hidden': 'true' });
}

/**
 * Panel sizes, remembered between sessions.
 *
 * A tree panel wide enough for your operation names and a G-code panel tall
 * enough to read is a per-person, per-screen answer, and having to drag it back
 * every time the app loads is the kind of small tax that makes a tool feel
 * cheap.
 */
const SIZE_KEY = 'cncam.panelSizes';
// The properties panel is wider than it was: the operation panel's tab bar
// needs about 330px to stand in one row, and at 300 it broke onto two rows
// whose second one held one or two orphans.
const DEFAULT_SIZES = { tree: 260, props: 340, gcode: 180 };

/**
 * Where the panels start, for a window this wide. On a laptop screen the part
 * gets the room: at 1024px the two side panels at their full width left the
 * viewport 414px across. Only a starting point — a drag is remembered.
 */
function defaultSizes() {
  const width = typeof window === 'undefined' ? 1440 : window.innerWidth;
  return width < 1200 ? { tree: 230, props: 300, gcode: 160 } : { ...DEFAULT_SIZES };
}
const SIZE_LIMITS = {
  tree: [180, 620],
  props: [260, 720],
  gcode: [80, 640],
};

function loadSizes() {
  try {
    const stored = JSON.parse(localStorage.getItem(SIZE_KEY) ?? '{}');
    return { ...defaultSizes(), ...(stored ?? {}) };
  } catch {
    return defaultSizes();
  }
}

function saveSizes(sizes) {
  try { localStorage.setItem(SIZE_KEY, JSON.stringify(sizes)); } catch { /* private mode */ }
}

function clampSize(name, value) {
  const [lo, hi] = SIZE_LIMITS[name];
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

/**
 * A splitter bar that resizes a panel by dragging.
 *
 * Pointer capture rather than document-level listeners, so a drag that leaves
 * the window still ends properly, and `user-select` is killed for the duration
 * — without that the drag selects every label it passes over and the panel
 * arrives resized and highlighted.
 *
 * @param axis 'x' resizes a side panel, 'y' the console at the bottom
 * @param sign +1 when dragging right/down makes the panel bigger
 */
function makeSplitter(name, axis, sign, apply) {
  const bar = el('div', {
    class: `splitter splitter-${axis}`,
    role: 'separator',
    'aria-orientation': axis === 'x' ? 'vertical' : 'horizontal',
    title: 'Drag to resize — double-click to reset',
  });
  let start = 0;
  let from = 0;

  bar.addEventListener('pointerdown', (e) => {
    start = axis === 'x' ? e.clientX : e.clientY;
    from = apply();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('dragging');
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => {
    if (!bar.classList.contains('dragging')) return;
    const now = axis === 'x' ? e.clientX : e.clientY;
    apply(from + (now - start) * sign);
  });
  const end = (e) => {
    if (!bar.classList.contains('dragging')) return;
    bar.classList.remove('dragging');
    document.body.classList.remove('resizing-x', 'resizing-y');
    try { bar.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    apply(undefined, true);
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', () => apply(defaultSizes()[name], true));
  return bar;
}

// Whether the checklist is folded, remembered between sessions. Somebody who
// has built a job before does not need it a second time, and somebody who is
// halfway through their first one should be able to put it away and get it back.
const HINT_KEY = 'cncam.hintFolded';
let hintFolded = (() => {
  try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; }
})();

/**
 * Mill or lathe, as the first thing in the machine group.
 *
 * This used to be an entry in the post-processor dropdown, which said that
 * turning was a way of writing the same program out. It is not: a lathe has its
 * own operations, its own coordinates, and a part that is a profile rather than
 * a solid. Switching here switches the whole app — the strategies on offer, the
 * setups listed, the program that gets posted — and leaves the other machine's
 * work untouched for when you switch back.
 */
const MACHINES = [
  { id: 'mill', label: 'Mill', hint: '3-axis milling: the part is held still and the cutter moves' },
  { id: 'turn', label: 'Lathe', hint: 'Turning: the part spins about Z and the tool moves in Z and X' },
];

function buildMachineTabs(actions) {
  const buttons = MACHINES.map(({ id, label, hint }) => el('button', {
    type: 'button',
    class: 'machine-tab',
    role: 'tab',
    title: hint,
    onclick: () => actions.setMachine(id),
  }, [label]));
  const bar = el('div', { class: 'machine-tabs', role: 'tablist', 'aria-label': 'Machine type' }, buttons);
  return {
    bar,
    sync(machine) {
      MACHINES.forEach(({ id }, i) => {
        buttons[i].classList.toggle('active', id === machine);
        buttons[i].setAttribute('aria-selected', id === machine ? 'true' : 'false');
      });
    },
  };
}

/**
 * The project's name, on the bar, as the thing you click to rename it.
 *
 * It was nowhere on screen. The name is what a save is called, what an export
 * is called and what the program's first comment says — and the only way to
 * find out it was "Untitled" was to export a file and look at the name it came
 * out with. A click turns it into a text box, the way a row in the tree does.
 */
function buildProjectName(onRename) {
  const button = el('button', {
    type: 'button',
    class: 'project-name',
    title: 'The project\'s name — what a save or an export is called. Click to rename.',
  }, ['Untitled']);
  let name = 'Untitled';
  let editing = null;

  const finish = (commit) => {
    if (!editing) return;
    const next = editing.value.trim();
    const box = editing;
    editing = null;
    box.replaceWith(button);
    if (commit && next && next !== name) onRename(next);
  };

  button.addEventListener('click', () => {
    if (editing) return;
    const box = el('input', { type: 'text', class: 'project-name-input', 'aria-label': 'Project name' });
    box.value = name;
    box.addEventListener('keydown', (e) => {
      // the single-key shortcuts are not for a box somebody is typing a name in
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    box.addEventListener('blur', () => finish(true));
    editing = box;
    button.replaceWith(box);
    box.focus();
    box.select();
  });

  return {
    node: button,
    set(next) {
      name = next || 'Untitled';
      button.textContent = name;
      if (typeof document !== 'undefined') document.title = `${name} — CNCAM`;
    },
  };
}

export function buildLayout(root, actions, project) {
  // Which machine this program is for. It used to be a list of G-code dialects,
  // which is the smallest part of what a machine is — the travel, the real
  // rapid rate and the spindle range all live on the record behind this and all
  // of them change what the app tells you. See doc/machines.js.
  const machineSelect = el('select', {
    class: 'machine-select',
    title: 'The machine this program will run on',
    'aria-label': 'Machine',
    onchange: (e) => actions.setMachineRecord(e.target.value),
  });
  const machineTabs = buildMachineTabs(actions);
  const projectName = buildProjectName((name) => actions.renameProject?.(name));

  const gcode = el('div', { id: 'gcode', class: 'collapsed' });

  // Undo and redo are the only buttons whose *availability* is information —
  // greyed out is how you know an edit was not recorded. They are updated from
  // refresh() through setHistory below.
  const undoButton = iconButton('undo', 'Undo', { onclick: actions.undo });
  const redoButton = iconButton('redo', 'Redo', { onclick: actions.redo });

  // Whether the panel is still allowed to open itself.
  //
  // Generating refreshes the listing, and refreshing it forced it open — so a
  // panel closed on purpose came straight back on the next Generate, and on the
  // one after that. Pressing Generate is a question about the paths in the
  // viewport; answering it by covering the bottom quarter of the screen every
  // time is the app overruling a decision the user already made. Closing it is
  // remembered; the button below and the Export flow still open it, because
  // those are the user asking.
  let dismissed = false;

  const gcodeToggle = iconButton('code', 'G-code', {
    class: 'tb-toggle',
    onclick: () => {
      const open = gcode.classList.contains('collapsed');
      dismissed = !open;
      setGcodeOpen(open);
    },
    title: 'Show or hide the G-code listing',
  });

  // --- File ---------------------------------------------------------------
  //
  // One menu, the way every desktop program has one. New, Open, Save and the
  // browser's drawer of projects were four buttons across the bar, which put
  // the least-used commands in the app — Clear was one of them, as a bin at
  // the far end — in the most expensive place there is, and pushed the things
  // a job is actually built with towards the edge of a 1280px screen. The
  // menu says each command's key, so it also teaches them.
  const fileMenu = () => [
    {
      label: 'New project',
      hint: 'Discard the models, tools, setups and operations and start again (asks first)',
      onclick: actions.clearProject,
    },
    {
      label: 'Open project file…',
      hint: 'Open a .cncam project from a file',
      onclick: () => actions.openProject(),
    },
    {
      label: 'Save project file',
      keys: keyFor('save'),
      hint: 'Save the project to a file, geometry included',
      onclick: actions.saveProject,
    },
    // Save and Open write files to disk; this is the drawer of jobs the browser
    // keeps for you, where every save is a version and nothing overwrites
    // anything. See doc/project-store.js.
    {
      label: 'Projects in this browser…',
      hint: 'Every save is a version: save, open, download or upload one',
      onclick: actions.browseProjects,
    },
    { separator: true },
    {
      label: 'Import model or drawing…',
      keys: keyFor('import'),
      hint: 'STEP, IGES, STL or OBJ — or a DXF, which lands as a drawing to engrave',
      // wrapped, not passed straight through: a click handler is called with
      // the event, and openModel's first argument is a file to import
      onclick: () => actions.openModel(),
    },
    {
      label: 'Check a G-code file…',
      hint: 'Open any .nc file: drawn, simulated against this setup\'s billet and checked',
      onclick: () => actions.checkGcode(),
    },
    { separator: true },
    ...exportItems(),
  ];

  // The two ways a program leaves the app, said in full. Shared by the File
  // menu and the Export button, which is the same question asked from the end
  // of the workflow rather than from the file.
  function exportItems() {
    return [
      {
        label: 'Export G-code — one file',
        keys: keyFor('export'),
        hint: 'One .ngc file: every enabled operation, in machining order',
        onclick: actions.exportGcode,
      },
      {
        label: 'Export G-code — a file per operation…',
        hint: 'One complete .ngc file per operation, numbered in machining order, '
          + 'into a folder you pick. For proving a program out one operation at a time.',
        onclick: actions.exportOperationsSeparately,
      },
    ];
  }

  const fileButton = toolButton('folder', 'File', {
    class: 'tb-menu',
    'aria-haspopup': 'menu',
    title: 'New, open and save the project; import a model; export the program',
    onclick: (e) => openContextMenu(anchorBelow(e), fileMenu()),
  }, 'keep');

  // --- the program: the end of the workflow, in the order it goes ----------
  //
  // Generate, Simulate and Export used to be in two places: the first two
  // floating over the bottom of the part and the third on the toolbar. They
  // are one sequence — compute it, watch it, write it out — so they sit
  // together, left to right in that order, and nothing floats over the part.
  const generateButton = el('button', {
    type: 'button',
    class: 'tb tb-keep tb-primary',
    onclick: (e) => actions.generate({ force: e.shiftKey }),
    title: `${withKey('Compute the toolpaths that changed', 'generate')} — Shift+click recomputes all of them`,
  }, [
    icon('bolt'),
    el('span', { class: 'tb-label' }, ['Generate']),
    // how many operations have no path, or a path from older settings
    el('span', { class: 'tb-count', hidden: '' }, []),
  ]);
  const generateCount = generateButton.querySelector('.tb-count');
  const simulateButton = toolButton('play', 'Simulate', {
    onclick: actions.simulateOrGenerate,
    title: withKey('Watch the stock being cut away; generates first if needed', 'simulate'),
  }, 'late');
  const exportButton = toolButton('download', 'Export', {
    class: 'tb-menu',
    'aria-haspopup': 'menu',
    title: 'Write the G-code — the whole program, or a file per operation',
    onclick: (e) => openContextMenu(anchorBelow(e), [
      ...exportItems(),
      { separator: true },
      // The other direction, and it lives here because this is the menu about
      // the *file*. A program is motion whichever way it is travelling, and
      // everything this app can say about a path it generated it can say about
      // one it is handed.
      {
        label: 'Check a G-code file…',
        hint: 'Open any .nc file: it is drawn, simulated against this setup\'s billet, '
          + 'measured against the model and checked for travels, clamps and rapids '
          + 'through the job. Ours or anybody else\'s.',
        onclick: () => actions.checkGcode(),
      },
    ]),
  }, 'late');

  const toolbar = el('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'CNCAM' }, [
    el('a', {
      class: 'brand',
      href: 'https://github.com/gamerpaddy/CNCAM',
      target: '_blank',
      rel: 'noopener noreferrer',
      title: 'CNCAM on GitHub',
    }, [el('span', { class: 'brand-mark', 'aria-hidden': 'true' }), el('span', { class: 'brand-word' }, ['CNCAM'])]),
    fileButton,
    projectName.node,
    divider(),
    // Which machine: the kind, then the one, then its settings. The group a
    // job starts from, so it comes before anything that goes into the job.
    machineTabs.bar,
    machineSelect,
    iconButton('machine', 'Machines', {
      onclick: actions.openMachines,
      title: withKey('Create and edit machines — travel, rapids, spindle range, dialect', 'machines'),
    }),
    divider(),
    // What the job is made of: the part, and the cutters
    toolButton('import', 'Import…', {
      onclick: () => actions.openModel(),
      title: withKey('Import a model (STEP, IGES, STL, OBJ) or a DXF drawing', 'import'),
    }),
    toolButton('cutter', 'Tools…', {
      onclick: actions.addToolsFromLibrary,
      title: 'Add cutters from the tool library',
    }),
    el('span', { class: 'spacer' }),
    undoButton,
    redoButton,
    divider(),
    generateButton,
    simulateButton,
    exportButton,
    gcodeToggle,
    divider(),
    iconButton('sliders', 'Options', {
      onclick: actions.openOptions,
      title: withKey('Options — simulation detail, what the viewport draws, and how the editor behaves', 'options'),
    }),
    iconButton('help', 'Help', {
      class: 'help-button',
      title: withKey('How a job goes together, and every keyboard shortcut', 'help'),
      onclick: actions.showShortcuts,
    }),
  ]);

  // The checklist lives above the tree, not over the part. It used to sit in
  // the middle of the viewport, which is the one place in the app whose whole
  // job is to show you the thing you are working on — a panel that explains the
  // app by covering it is a bad trade after the first thirty seconds, and there
  // was no way to put it away.
  const hint = el('div', { class: 'tree-hint' });
  const treeBody = el('div', { class: 'tree-body' });
  const tree = el('div', { id: 'tree', class: 'panel', 'aria-label': 'Project' }, [hint, treeBody]);

  // Fit is the way back from any camera you have lost yourself in, so it lives
  // in the viewport permanently rather than firing only on import. Without it,
  // a camera pointing away from the part is indistinguishable from a part that
  // failed to load, and there is nothing the user can do about either.
  //
  // The named views beside it are the other half of the same problem: orbiting
  // to "square on from the front" by hand is a game of degrees, and the answer
  // is one button on every other CAD package there is.
  const canvas = el('div', { id: 'viewport-canvas' });
  const viewButtons = el('div', { class: 'view-presets' });
  // The rest of the views, and the projection, one click behind a caret. Eleven
  // buttons on a bar is not a toolbar, it is a keypad — but "the isometric from
  // the other corner" and "square-on, so I can compare two diameters" are both
  // things you want without hunting through a settings dialog for them.
  const viewMenuButton = el('button', {
    type: 'button',
    class: 'view-preset view-more',
    title: 'More views, and perspective or orthographic',
    'aria-label': 'More views',
    onclick: (e) => openContextMenu(anchorBelow(e, 'right'), viewMenuItems()),
  }, [icon('chevron', 14)]);
  let currentMachine = project.machine ?? 'mill';
  // Which named view the camera is in, or null once it has been orbited away.
  // Shown on the bar the way the Mill/Lathe tabs show the machine: a row of
  // views with none of them lit gave no way to tell a square-on Front from a
  // nearly square one, which is the difference the buttons exist for.
  let activeView = null;
  const viewButtonFor = new Map();
  function syncViewButtons() {
    for (const [key, button] of viewButtonFor) button.classList.toggle('active', key === activeView);
    viewMenuButton.classList.toggle('active',
      activeView != null && !viewButtonFor.has(activeView));
  }

  function viewMenuItems() {
    const projection = getSetting('projection');
    const live = () => actions.liveProjection?.() ?? projection;
    return [
      ...extraViewsFor(currentMachine).map((key) => ({
        label: VIEW_PRESETS[key].label,
        hint: VIEW_PRESETS[key].hint,
        onclick: () => actions.setView(key),
      })),
      { separator: true },
      // The dot marks the preference; the note after "Automatic" says which
      // projection that is resolving to right now. Showing only the preference
      // is what let the menu read Perspective while the screen was square-on.
      ...PROJECTIONS.map((mode) => ({
        label: `${PROJECTION_LABELS[mode]}`
          + (mode === 'auto' ? ` (${PROJECTION_LABELS[live()]?.toLowerCase()} here)` : ''),
        checked: mode === projection,
        hint: PROJECTION_HINTS[mode],
        onclick: () => actions.setProjection(mode),
      })),
      { separator: true },
      {
        label: 'Clear toolpaths',
        hint: 'Throw the computed paths away — for when they are stale rather '
          + 'than in the way. The operations stay as they are.',
        onclick: () => { actions.clearToolpaths(); syncPathsButton(); },
      },
    ];
  }

  // Hiding the backplot is a view state, so it lives with the view buttons and
  // not in Options: it is something you reach for several times while checking
  // one surface, not something you set once.
  const pathsButton = el('button', {
    type: 'button',
    class: 'view-toggle on',
    title: 'Show or hide the toolpath backplot (the program is unchanged)',
    'aria-pressed': 'true',
    onclick: () => { actions.toggleToolpaths(); syncPathsButton(); },
  }, [icon('paths', 15), el('span', {}, ['Paths'])]);

  function syncPathsButton() {
    const shown = actions.toolpathsVisible?.() !== false;
    pathsButton.classList.toggle('off', !shown);
    pathsButton.classList.toggle('on', shown);
    pathsButton.setAttribute('aria-pressed', shown ? 'true' : 'false');
  }

  const viewTools = el('div', { class: 'viewport-tools' }, [
    viewButtons,
    pathsButton,
    el('button', {
      type: 'button',
      class: 'view-fit',
      onclick: () => actions.fitView(),
      title: withKey('Fit everything in view', 'fit'),
    }, [icon('fit', 15), el('span', {}, ['Fit'])]),
  ]);

  // Which setup the scene is showing. The viewport draws one fixturing at a
  // time — the part is somewhere else in the next one — and nothing on it said
  // which, so selecting an operation in the second setup turned the part round
  // with no word about why.
  const sceneLabel = el('div', { class: 'viewport-label', hidden: '' });

  // What an empty viewport says: where a part comes from. The checklist in the
  // tree says it too, but the viewport is where a newcomer is looking, and a
  // dark grid on its own reads as something that failed to load.
  const emptyState = el('div', { class: 'viewport-empty' }, [
    el('div', { class: 'viewport-empty-card' }, [
      icon('import', 26),
      el('div', { class: 'viewport-empty-title' }, ['Drop a part here']),
      el('div', { class: 'viewport-empty-detail' }, [
        'STEP, IGES, STL or OBJ — or a DXF to engrave.',
      ]),
      el('button', {
        type: 'button',
        class: 'primary',
        onclick: () => actions.openModel(),
        title: withKey('Import STEP, IGES, STL, OBJ or DXF', 'import'),
      }, ['Import a model…']),
    ]),
  ]);
  const viewport = el('div', { id: 'viewport' }, [canvas, sceneLabel, emptyState, viewTools]);
  const props = el('div', { id: 'props', class: 'panel', 'aria-label': 'Properties' });

  // --- the status line ------------------------------------------------------
  //
  // A message on the left, and on the right what the program in front of you
  // comes to. The message is the answer to the last thing you did and it is
  // replaced by the next one — which made a long report from Generate, the one
  // that names every operation that cut nothing, gone the moment anything else
  // said a word. The last few are kept, a click away.
  const statusText = el('span', { class: 'status-text' }, ['Ready']);
  const busy = el('span', { class: 'busy' });
  const log = [];
  const statusMessage = el('button', {
    type: 'button',
    class: 'status-message',
    title: 'Click for the recent messages',
    onclick: (e) => openContextMenu(anchorAbove(e), log.length
      ? log.slice().reverse().map((entry) => ({
        label: `${entry.time}  ${entry.text}`,
        className: entry.isError ? 'context-log error' : 'context-log',
        onclick: () => copyText(entry.text),
        hint: 'Click to copy this message',
      }))
      : [{ label: 'No messages yet', disabled: true }]),
  }, [busy, statusText]);
  const summary = el('span', { class: 'status-summary' }, []);
  const status = el('div', { class: 'status' }, [statusMessage, summary]);

  const timeline = buildTimeline(
    (step, seconds) => actions.seekSimulation(step, seconds),
    () => actions.closeSimulation(),
  );

  // --- resizable panels ---
  //
  // Sizes are CSS custom properties on the grid container, so a drag is one
  // style write and the browser does the rest. The splitters are grid cells of
  // their own rather than absolutely-positioned overlays: a panel that scrolls
  // cannot host a handle down its full height without the handle scrolling too.
  const sizes = loadSizes();
  const applySize = (name) => (value, commit = false) => {
    if (value !== undefined) {
      sizes[name] = clampSize(name, value);
      root.style.setProperty(`--${name}-size`, `${sizes[name]}px`);
      // the viewport is a fixed-size WebGL buffer, and every one of these
      // resizes it — a ResizeObserver would catch it too, a frame later
      actions.viewportResized?.();
    }
    if (commit) saveSizes(sizes);
    return sizes[name];
  };
  const setTree = applySize('tree');
  const setProps = applySize('props');
  const setGcode = applySize('gcode');
  for (const [name, value] of Object.entries(sizes)) {
    root.style.setProperty(`--${name}-size`, `${clampSize(name, value)}px`);
  }

  const gcodeSplitter = makeSplitter('gcode', 'y', -1, setGcode);
  gcodeSplitter.classList.add('collapsed');

  /** The console is a panel, so its splitter comes and goes with it. */
  function setGcodeOpen(open) {
    gcode.classList.toggle('collapsed', !open);
    gcodeSplitter.classList.toggle('collapsed', !open);
    gcodeToggle.classList.toggle('on', open);
    gcodeToggle.setAttribute('aria-pressed', open ? 'true' : 'false');
    actions.viewportResized?.();
  }
  // the listing's own close button asks for the same thing the toolbar does
  gcode.addEventListener('gcode-close', () => { dismissed = true; setGcodeOpen(false); });

  root.replaceChildren(
    toolbar,
    tree,
    makeSplitter('tree', 'x', 1, setTree),
    viewport,
    makeSplitter('props', 'x', -1, setProps),
    props,
    gcodeSplitter,
    gcode,
    timeline.root,
    status,
  );

  return {
    tree: treeBody,       // the tree redraws itself; the checklist above it must survive
    viewport: canvas,     // Viewport constructor still gets the raw canvas host
    props,
    gcode,
    timeline,
    machineSelect,
    /**
     * Point the toolbar at a machine: highlight its tab, list the machines of
     * that kind, and offer the views that machine is worth looking at from.
     */
    setMachine(machine, machines, currentId) {
      currentMachine = machine;
      machineTabs.sync(machine);
      machineSelect.replaceChildren(...machines.map((m) => el('option', {
        value: m.id, title: describeMachine(m),
      }, [m.name])));
      machineSelect.value = currentId ?? machines[0]?.id ?? '';
      const chosen = machines.find((m) => m.id === machineSelect.value);
      machineSelect.title = chosen
        ? `${chosen.name} — ${describeMachine(chosen)}`
        : 'No machine — add one in Machines';
      document.body.dataset.machine = machine;
      // the views worth having are not the same on the two machines: a lathe
      // wants the ZX plane square on, a mill wants six faces of a box
      viewButtonFor.clear();
      viewButtons.replaceChildren(
        ...viewsFor(machine).map((key) => {
          const preset = VIEW_PRESETS[key];
          const button = el('button', {
            type: 'button',
            class: 'view-preset',
            title: preset.hint,
            onclick: () => actions.setView(key),
          }, [preset.label]);
          viewButtonFor.set(key, button);
          return button;
        }),
        viewMenuButton,
      );
      syncViewButtons();
    },
    setGcodeOpen,
    /** The named view the camera is in, or null — see syncViewButtons. */
    setActiveView(name) {
      activeView = name ?? null;
      syncViewButtons();
    },
    showGcodePanel() { if (!dismissed) setGcodeOpen(true); },
    /** Whether there is nothing in the job to look at yet. */
    setEmpty(empty) { emptyState.classList.toggle('on', !!empty); },
    /** The project's name, on the bar and in the window title. */
    setProjectName(name) { projectName.set(name); },
    /** Which setup the scene is drawing, or null for none. */
    setSceneLabel(text) {
      sceneLabel.hidden = !text;
      sceneLabel.textContent = text ?? '';
    },
    /**
     * What the program in front of you comes to, and how much of it is not
     * computed yet.
     *
     * @param outdated operations whose path is missing or older than their
     *   settings — the number on the Generate button
     * @param text the summary at the right-hand end of the status line
     */
    setProgramState({
      outdated = 0, operations = 0, text = '', title = '',
    } = {}) {
      // the next step only when there is a program to compute: lit on an empty
      // job it pointed at the one button that could do nothing yet
      generateButton.classList.toggle('idle', operations === 0);
      generateCount.hidden = !(outdated > 0);
      generateCount.textContent = outdated > 0 ? String(outdated) : '';
      generateButton.classList.toggle('needed', outdated > 0);
      generateButton.setAttribute('aria-label', outdated > 0
        ? `Generate — ${outdated} to compute` : 'Generate');
      summary.textContent = text;
      summary.title = title || text;
    },
    setStatus(text, isError = false) {
      statusText.textContent = text;
      statusText.className = `status-text${isError ? ' error' : ''}`;
      statusMessage.title = `${text}\n\nClick for the recent messages`;
      // the same message twice in a row is one entry — a status set again by a
      // refresh is not news
      const last = log[log.length - 1];
      if (text && (!last || last.text !== text)) {
        const now = new Date();
        log.push({
          text,
          isError,
          time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
        });
        if (log.length > 30) log.shift();
      }
    },
    /**
     * Long jobs need to say they are running. Generating a heavy clearing pass
     * takes seconds during which nothing in the UI moves, and a frozen-looking
     * app invites a second click that queues a second identical job.
     */
    setBusy(on) {
      busy.classList.toggle('on', !!on);
      // the buttons that would start another job stand down while one runs
      generateButton.disabled = !!on;
      simulateButton.disabled = !!on;
      generateButton.classList.toggle('running', !!on);
    },
    /**
     * Reflect the undo stack. A button that is always live tells you nothing
     * about whether your last edit was recorded, and naming the edit it will
     * reverse turns "Undo" from a gamble into a decision.
     */
    setHistory({ canUndo, canRedo, undoLabel, redoLabel }) {
      undoButton.disabled = !canUndo;
      redoButton.disabled = !canRedo;
      undoButton.title = canUndo ? withKey(`Undo ${undoLabel}`, 'undo') : 'Nothing to undo';
      redoButton.title = canRedo ? withKey(`Redo ${redoLabel}`, 'redo') : 'Nothing to redo';
    },
    /**
     * The checklist at the top of the project tree, until there is a program.
     *
     * A list that ticks itself off answers both "what do I do now" and "how
     * much of this is there", and the step you are on is a button, so the
     * answer to "what now" is also the way to do it.
     *
     * It sits above the tree rather than over the viewport, and it can be
     * folded away. Where it was, it covered the part — and the one thing a new
     * user needs to see after importing a model is the model.
     *
     * @param steps [{ label, state: 'done'|'next'|'todo', onclick? }] — empty
     *   or null clears it
     */
    setHint(steps) {
      const list = Array.isArray(steps) ? steps : [];
      hint.classList.toggle('on', list.length > 0);
      if (list.length === 0) return hint.replaceChildren();

      const done = list.filter((s) => s.state === 'done').length;
      const body = el('ol', { class: 'hint-steps' }, list.map((step, i) => {
        const mark = step.state === 'done' ? icon('check', 12) : String(i + 1);
        return el('li', {}, [el(step.onclick ? 'button' : 'div', {
          class: `hint-step ${step.state}`,
          ...(step.onclick ? { type: 'button', onclick: step.onclick } : {}),
        }, [el('span', { class: 'hint-mark' }, [mark]), el('span', { class: 'hint-label' }, [step.label])])]);
      }));
      body.hidden = hintFolded;

      const fold = el('button', {
        type: 'button',
        class: `hint-fold${hintFolded ? ' folded' : ''}`,
        title: hintFolded ? 'Show the remaining steps' : 'Fold this away',
        'aria-expanded': hintFolded ? 'false' : 'true',
        onclick: () => {
          hintFolded = !hintFolded;
          try { localStorage.setItem(HINT_KEY, hintFolded ? '1' : '0'); } catch { /* private mode */ }
          this.setHint(steps);
        },
      }, [icon('chevron', 14), el('span', {}, ['Getting to a program']),
        el('span', { class: 'hint-count' }, [`${done} of ${list.length}`])]);

      // how far along, as a bar as well as a count
      const progress = el('div', { class: 'hint-progress', 'aria-hidden': 'true' }, [
        el('span', { style: `width:${Math.round((done / list.length) * 100)}%` }),
      ]);

      hint.replaceChildren(fold, progress, body);
      return undefined;
    },
  };
}

function copyText(text) {
  navigator.clipboard?.writeText(text).catch(() => {});
}
