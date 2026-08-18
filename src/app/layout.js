// Builds the static DOM shell and returns references to the mount points.
// No framework: plain elements, ids for the grid areas defined in styles.css.

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
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
import { openContextMenu } from './context-menu.js';
// eslint-disable-next-line import/first
import { getSetting } from './settings.js';
// eslint-disable-next-line import/first
import { describeMachine } from '../doc/machines.js';

/**
 * Panel sizes, remembered between sessions.
 *
 * A tree panel wide enough for your operation names and a G-code panel tall
 * enough to read is a per-person, per-screen answer, and having to drag it back
 * every time the app loads is the kind of small tax that makes a tool feel
 * cheap.
 */
const SIZE_KEY = 'cncam.panelSizes';
const DEFAULT_SIZES = { tree: 260, props: 300, gcode: 160 };
const SIZE_LIMITS = {
  tree: [170, 620],
  props: [220, 700],
  gcode: [70, 640],
};

function loadSizes() {
  try {
    const stored = JSON.parse(localStorage.getItem(SIZE_KEY) ?? '{}');
    return { ...DEFAULT_SIZES, ...(stored ?? {}) };
  } catch {
    return { ...DEFAULT_SIZES };
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
  bar.addEventListener('dblclick', () => apply(DEFAULT_SIZES[name], true));
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
 * Mill or lathe, as the first thing on the toolbar.
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
    class: 'machine-tab',
    title: hint,
    onclick: () => actions.setMachine(id),
  }, [label]));
  const bar = el('div', { class: 'machine-tabs', role: 'tablist' }, buttons);
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

export function buildLayout(root, actions, project) {
  // Which machine this program is for. It used to be a list of G-code dialects,
  // which is the smallest part of what a machine is — the travel, the real
  // rapid rate and the spindle range all live on the record behind this and all
  // of them change what the app tells you. See doc/machines.js.
  const machineSelect = el('select', {
    class: 'machine-select',
    title: 'The machine this program will run on',
    onchange: (e) => actions.setMachineRecord(e.target.value),
  });
  const machineTabs = buildMachineTabs(actions);

  const arcToggle = el('input', {
    type: 'checkbox',
    onchange: (e) => actions.setPostOption('arcs', e.target.checked),
  });
  arcToggle.checked = project.postOptions?.arcs ?? true;
  const arcs = el('label', {
    class: 'toggle',
    title: 'Post curves as G2/G3 arcs — smaller files and smoother motion. '
      + 'Turn off for controllers with unreliable arc support.',
  }, [arcToggle, 'Arcs']);

  const gcode = el('div', { id: 'gcode', class: 'collapsed' });

  // Undo and redo are the only buttons whose *availability* is information —
  // greyed out is how you know an edit was not recorded. They are updated from
  // refresh() through setHistory below.
  const undoButton = el('button', { onclick: actions.undo }, ['Undo']);
  const redoButton = el('button', { onclick: actions.redo }, ['Redo']);

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

  const gcodeToggle = el('button', {
    onclick: () => {
      const open = gcode.classList.contains('collapsed');
      dismissed = !open;
      setGcodeOpen(open);
    },
    title: 'Show or hide the G-code preview',
  }, ['G-code ▾']);

  const toolbar = el('div', { class: 'toolbar' }, [
    el('a', {
      class: 'brand',
      href: 'https://github.com/gamerpaddy/CNCAM',
      target: '_blank',
      rel: 'noopener noreferrer',
      title: 'CNCAM on GitHub',
    }, ['CNCAM']),
    machineTabs.bar,
    // wrapped, not passed straight through: a click handler is called with the
    // event, and openModel's first argument is a file to import
    el('button', { onclick: () => actions.openModel(), title: 'Import STEP, IGES, STL, OBJ or DXF' }, ['Model…']),
    el('button', { onclick: actions.addToolsFromLibrary, title: 'Add cutters from the preset library' }, ['Tools…']),
    machineSelect,
    el('button', {
      class: 'icon-button',
      onclick: actions.openMachines,
      title: 'Create and edit machines — travel, rapids, spindle range, dialect',
    }, ['⚙']),
    arcs,
    // One button that opens a chooser, spelling both choices out in full.
    //
    // This has been all three ways round. "Export" with a caret beside it hid
    // the second choice behind an affordance nobody clicked. Splitting it into
    // "Export all" and "Export each" made both visible, but two buttons whose
    // labels differ by one word is a thing you have to stop and read, and it
    // was the pair of them that pushed Save, Open and Clear off the right-hand
    // edge of a 1280px screen.
    //
    // The trailing ellipsis is the app's own convention for a button that asks
    // before it acts — Model… and Tools… are two along the same bar — so the
    // choice is where you would look for it, and the menu can afford to say
    // what each one does rather than hinting at it in a label.
    el('button', {
      onclick: (e) => openContextMenu(e, [
        {
          label: 'Export all — one file',
          hint: 'One .ngc file: every enabled operation, in machining order (Ctrl+S)',
          onclick: actions.exportGcode,
        },
        {
          label: 'Export each — one file per operation',
          hint: 'One complete .ngc file per operation, numbered in machining order, '
            + 'into a folder you pick. For proving a program out one operation at a time.',
          onclick: actions.exportOperationsSeparately,
        },
      ]),
      title: 'Write the G-code — as one file, or one file per operation',
    }, ['Export…']),
    gcodeToggle,
    el('span', { class: 'spacer' }),
    el('button', {
      onclick: actions.openOptions,
      title: 'Simulation detail, what the viewport draws, and how the editor behaves',
    }, ['Options']),
    el('button', {
      class: 'help-button',
      title: 'How a job goes together, and every keyboard shortcut (?)',
      onclick: actions.showShortcuts,
    }, ['?']),
    undoButton,
    redoButton,
    el('button', { onclick: actions.saveProject, title: 'Save the project, geometry included' }, ['Save']),
    el('button', { onclick: actions.openProject, title: 'Open a .cncam project' }, ['Open']),
    el('button', { class: 'danger', onclick: actions.clearProject, title: 'Discard everything and start over' }, ['Clear']),
  ]);

  // The checklist lives above the tree, not over the part. It used to sit in
  // the middle of the viewport, which is the one place in the app whose whole
  // job is to show you the thing you are working on — a panel that explains the
  // app by covering it is a bad trade after the first thirty seconds, and there
  // was no way to put it away.
  const hint = el('div', { class: 'tree-hint' });
  const treeBody = el('div', { class: 'tree-body' });
  const tree = el('div', { id: 'tree', class: 'panel' }, [hint, treeBody]);

  // The viewport hosts its own action buttons at the bottom — actions belong
  // where the eyes already are, not on a distant toolbar
  const canvas = el('div', { id: 'viewport-canvas' });
  const overlay = el('div', { class: 'viewport-overlay' }, [
    el('button', { class: 'primary', onclick: actions.generate, title: 'Compute toolpaths (Ctrl+G)' }, ['Generate']),
    el('button', {
      onclick: actions.simulateOrGenerate,
      title: 'Watch the stock being cut away; generates first if needed',
    }, ['Simulate']),
  ]);

  // Fit is the way back from any camera you have lost yourself in, so it lives
  // in the viewport permanently rather than firing only on import. Without it,
  // a camera pointing away from the part is indistinguishable from a part that
  // failed to load, and there is nothing the user can do about either.
  //
  // The named views beside it are the other half of the same problem: orbiting
  // to "square on from the front" by hand is a game of degrees, and the answer
  // is one button on every other CAD package there is.
  const viewButtons = el('div', { class: 'view-presets' });
  // The rest of the views, and the projection, one click behind a caret. Eleven
  // buttons on a bar is not a toolbar, it is a keypad — but "the isometric from
  // the other corner" and "square-on, so I can compare two diameters" are both
  // things you want without hunting through a settings dialog for them.
  const viewMenuButton = el('button', {
    class: 'view-preset view-more',
    title: 'More views, and perspective or orthographic',
    onclick: (e) => openContextMenu(e, viewMenuItems()),
  }, ['▾']);
  let currentMachine = project.machine ?? 'mill';

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
        label: `${mode === projection ? '● ' : '○ '}${PROJECTION_LABELS[mode]}`
          + (mode === 'auto' ? ` (${PROJECTION_LABELS[live()]?.toLowerCase()} here)` : ''),
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
    class: 'view-toggle',
    title: 'Show or hide the toolpath backplot (the program is unchanged)',
    onclick: () => { actions.toggleToolpaths(); syncPathsButton(); },
  }, ['Paths']);

  function syncPathsButton() {
    pathsButton.classList.toggle('off', actions.toolpathsVisible?.() === false);
  }

  const viewTools = el('div', { class: 'viewport-tools' }, [
    viewButtons,
    pathsButton,
    el('button', { onclick: () => actions.fitView(), title: 'Fit everything in view (F)' }, ['⤢ Fit']),
  ]);
  const viewport = el('div', { id: 'viewport' }, [canvas, viewTools, overlay]);
  const props = el('div', { id: 'props', class: 'panel' });

  const statusText = el('span', {}, ['Ready']);
  const busy = el('span', { class: 'busy' });
  const status = el('div', { class: 'status' }, [busy, statusText]);

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
    gcodeToggle.textContent = open ? 'G-code ▴' : 'G-code ▾';
    actions.viewportResized?.();
  }

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
    arcToggle,
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
        : 'No machine — add one from Options ⚙';
      document.body.dataset.machine = machine;
      // the views worth having are not the same on the two machines: a lathe
      // wants the ZX plane square on, a mill wants six faces of a box
      viewButtons.replaceChildren(
        ...viewsFor(machine).map((key) => {
          const preset = VIEW_PRESETS[key];
          return el('button', {
            class: 'view-preset',
            title: preset.hint,
            onclick: () => actions.setView(key),
          }, [preset.label]);
        }),
        viewMenuButton,
      );
    },
    setGcodeOpen,
    showGcodePanel() { if (!dismissed) setGcodeOpen(true); },
    setStatus(text, isError = false) {
      statusText.textContent = text;
      statusText.className = isError ? 'error' : '';
      status.title = text;   // long messages get cut off; the tooltip has it all
    },
    /**
     * Long jobs need to say they are running. Generating a heavy clearing pass
     * takes seconds during which nothing in the UI moves, and a frozen-looking
     * app invites a second click that queues a second identical job.
     */
    setBusy(on) {
      busy.classList.toggle('on', !!on);
      overlay.classList.toggle('busy', !!on);
    },
    /**
     * Reflect the undo stack. A button that is always live tells you nothing
     * about whether your last edit was recorded, and naming the edit it will
     * reverse turns "Undo" from a gamble into a decision.
     */
    setHistory({ canUndo, canRedo, undoLabel, redoLabel }) {
      undoButton.disabled = !canUndo;
      redoButton.disabled = !canRedo;
      undoButton.title = canUndo ? `Undo ${undoLabel} (Ctrl+Z)` : 'Nothing to undo';
      redoButton.title = canRedo ? `Redo ${redoLabel} (Ctrl+Y)` : 'Nothing to redo';
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
      const body = el('div', { class: 'hint-steps' }, list.map((step) => {
        const mark = { done: '✓', next: '▸', todo: '·' }[step.state] ?? '·';
        return el(step.onclick ? 'button' : 'div', {
          class: `hint-step ${step.state}`,
          ...(step.onclick ? { onclick: step.onclick } : {}),
        }, [el('span', { class: 'hint-mark' }, [mark]), step.label]);
      }));
      body.hidden = hintFolded;

      const fold = el('button', {
        class: 'hint-fold',
        title: hintFolded ? 'Show the remaining steps' : 'Fold this away',
        onclick: () => {
          hintFolded = !hintFolded;
          try { localStorage.setItem(HINT_KEY, hintFolded ? '1' : '0'); } catch { /* private mode */ }
          this.setHint(steps);
        },
      }, [hintFolded ? '▸' : '▾']);

      hint.replaceChildren(
        el('div', { class: 'hint-title' }, [
          fold,
          el('span', {}, ['Getting to a program']),
          el('span', { class: 'hint-count' }, [`${done}/${list.length}`]),
        ]),
        body,
      );
      return undefined;
    },
  };
}
