// App entry: boots the document, layout, viewport, worker pool, and refresh loop.
// User actions live in actions.js.

import { Document } from '../doc/document.js';
import { plural } from '../engine/text.js';
import {
  loadSaved, attachAutosave, clearSaved, sessionProjectId, setSessionProjectId,
} from '../doc/autosave.js';
import { computeNormals, mergeMeshes } from '../geom/mesh.js';
import { sliceMeshZ } from '../geom/slice.js';
import { transformMesh } from '../engine/setup.js';
import { Viewport } from '../view/viewport.js';
import { WorkerPool } from '../workers/pool.js';
import { computeStock } from '../engine/stock.js';
import { resolveSetup } from '../engine/setup.js';
import { buildLayout } from './layout.js';
import { renderTree } from './tree.js';
import { renderProps } from './props.js';
import { makeActions } from './actions.js';
import { syncRegionOverlays, togglePicked, invalidateFaces } from './regions-ui.js';
import { machinesFor } from '../doc/machines.js';
import { machineCanHold } from '../doc/tool-library.js';
import { placedPaths } from '../engine/drawing.js';
import { heightLimits, constrainHeights, snapTargets } from '../engine/heights.js';
import { bindShortcuts } from './shortcuts.js';
import { installDropImport } from './drop-import.js';
import { whenSettled, rebuildKeepingFocus } from './keep-focus.js';
import { getSetting } from './settings.js';
import { paramApplies, OP_PARAM_GROUPS } from './op-params.js';
import { setupModelIds } from './actions/setup-space.js';
import {
  opStatus, opBlockedReason, formatTime, toolChangesIn,
} from './op-status.js';
import { BUILD } from '../version.js';

/**
 * The meshes a setup machines, as one question asked in one place.
 *
 * "`modelIds` if it has any, everything in the project otherwise" was written
 * out three times in this file alone — and `setupModelIds` exists precisely
 * because a fourth copy of it (in `opFingerprint`) read the raw field and so
 * never noticed a model being imported. A rule stated four times is a rule that
 * will be corrected in three places. See actions/setup-space.js.
 */
function setupMeshes(setup) {
  return setupModelIds(setup, ctx.doc.project)
    .map((id) => ctx.doc.meshes.get(id)).filter(Boolean);
}

const ctx = {
  doc: new Document(),
  pool: new WorkerPool(),
  ui: null,
  viewport: null,
  lastProgram: null,
  pickMode: null,              // 'include' | 'avoid' | null — transient UI state
  pickKind: 'face',            // 'face' | 'edge' — what a click selects
  // The project in the browser's store this job is a version of — kept with
  // the session, so a reload still saves into the drawer it came from.
  get storeProjectId() { return sessionProjectId(); },
  set storeProjectId(id) { setSessionProjectId(id); },
  opTabs: new Map(),           // opId -> which properties tab is open
  setPickMode: (mode, kind) => setPickMode(mode, kind),
  setPickKind: (kind) => setPickMode(ctx.pickMode, kind),
  rerenderProps: () => {
    renderPropsKeepingFocus();
    syncHeightGizmoVisibility();
  },
  // The tree on its own, for news that changes nothing but its badges — a
  // Generate marking which passes are still running, and then each one done.
  renderTree: () => {
    whenSettled('tree', [ctx.ui.tree], () => renderTree(ctx.ui.tree, ctx.doc, ctx));
  },
  // The named Z values a height can be snapped to — the top of the part, the
  // bottom of the billet. See engine/heights.js snapTargets.
  snapTargetsFor: (op) => {
    const setup = ctx.doc.findSetupOf(op.id);
    if (!setup) return [];
    return snapTargets(resolvedStock(setup), ctx.actions?.setupModelBounds?.(setup) ?? null);
  },
};

function refresh(kind) {
  const { doc, ui, viewport } = ctx;
  // picking targets one operation; keep it from leaking onto the next selection
  if (kind === 'selection' && doc.selection?.kind !== 'op') ctx.pickMode = null;
  // …and onto the next operation, whose Regions tab may not even be the one
  // open. renderProps below settles which tab that is, so the handler is
  // re-derived after it rather than before — see pickingLive.
  const wasPicking = ctx.pickMode;

  renderPanels();
  ui.setMachine(doc.machine, machinesFor(doc.project, doc.machine),
    doc.machineRecord()?.id ?? null);
  // A lathe is not a mill seen from another angle: Z runs along the bar and X
  // is the cross-slide going in. The viewport draws and frames accordingly.
  viewport.setMachine(doc.machine);
  if (kind === 'selection') {
    viewport.setHighlight(doc.selection?.kind === 'model' ? doc.selection.id : null);
  }
  syncViewportModels();
  syncStock();
  syncDrawings();
  syncToolpaths();
  // the selected operation's path stands out from the rest of the setup's
  viewport.setToolpathFocus(doc.selection?.kind === 'op' ? doc.toolpaths.get(doc.selection.id) : null);
  ctx.actions?.syncGcodePreview?.();
  syncRegionOverlays(doc, viewport);
  syncHeightGizmos(kind);
  syncHeightGizmoVisibility();
  syncFixtureGizmo();
  // the arming state follows the handler: leaving it set while the handler is
  // off is what made the Regions buttons say "Picking…" on a tab that was not
  // listening for clicks
  if (wasPicking && !pickingLive()) ctx.pickMode = null;
  applyPickHandler();
  syncHint();
  syncProgramState();
  ui.setHistory(doc.undoStack);
  ui.setProjectName(doc.project.name);
}

/**
 * What the program in front of you comes to, and what is still to compute.
 *
 * Two answers that used to need a Generate to find out: how many operations
 * have no path — or a path from settings that have since changed — and how
 * long the whole thing takes. The first is the number on the Generate button,
 * the second the right-hand end of the status line. Both are for the machine
 * in front of you, the way the tree's counts are, and the time is the one the
 * Generate report gives: the paths at this machine's rapid rate, plus its tool
 * changes.
 */
function syncProgramState() {
  const { doc, ui } = ctx;
  let enabled = 0;
  let outdated = 0;
  let generated = 0;
  let blocked = 0;
  let seconds = 0;
  const ops = [];
  for (const { op } of doc.allOperations()) {
    if (!op.enabled) continue;
    enabled++;
    ops.push(op);
    if (doc.pending?.has(op.id)) continue;
    // One that cannot be generated is not waiting on Generate, whatever path it
    // still shows — its row says why, and the next Generate drops that path.
    // Counted as waiting, a deleted tool put a 1 on the button that pressing it
    // could never clear.
    if (opBlockedReason(doc, op)) { blocked++; continue; }
    const status = opStatus(doc, op);
    if (status) {
      generated++;
      seconds += status.seconds;
      if (status.stale) outdated++;
    } else {
      outdated++;
    }
  }
  const setups = doc.setups();
  const machine = doc.machineRecord();
  let text = '';
  let title = '';
  if (enabled > 0) {
    const ran = ops.filter((op) => doc.toolpaths.has(op.id));
    const changes = toolChangesIn(doc, ran).changes;
    const total = seconds + changes * (machine?.toolChangeSeconds ?? 0);
    const count = `${enabled} operation${enabled === 1 ? '' : 's'}`;
    const stuck = blocked ? ` · ${blocked} cannot generate` : '';
    if (generated === 0) {
      text = `${count} · not generated${stuck}`;
      title = blocked ? 'The "!" on a row in the tree says why it cannot' : '';
    } else if (generated < enabled || outdated > 0) {
      text = `${count} · ${generated} of ${enabled} generated${stuck}`;
      title = `${outdated} to compute — Generate does only those`
        + (blocked ? '. The "!" on a row in the tree says why it cannot generate' : '');
    } else {
      text = `${count} · ≈ ${formatTime(total)}`;
      title = `Cycle time on ${machine?.name ?? 'this machine'}, including `
        + `${changes} tool change${changes === 1 ? '' : 's'}`
        + (setups.length > 1 ? `, across ${setups.length} setups` : '');
    }
  }
  ui.setProgramState({ outdated, operations: enabled, text, title });
}

// --- rebuilding the side panels without losing the gesture that caused it ---
//
// A field commits as it loses focus, which is in the middle of the click or Tab
// that is moving to the next one — and the tree and the panel are rebuilt on
// every document change. See app/keep-focus.js for what that used to cost.
function renderPanels() {
  const { ui } = ctx;
  whenSettled('panels', [ui.tree, ui.props], () => {
    renderTree(ui.tree, ctx.doc, ctx);
    renderPropsKeepingFocus();
    // what the panel settles (which tab is open) decides these two
    syncHeightGizmoVisibility();
    applyPickHandler();
  });
}

function renderPropsKeepingFocus() {
  rebuildKeepingFocus(ctx.ui.props, () => renderProps(ctx.ui.props, ctx.doc, ctx));
}

/**
 * What still has to happen before there is a program, ticked off as it does.
 *
 * An empty dark viewport is the first thing a new user sees and it explains
 * none of itself. Naming only the next step answers "what now" but not "how
 * much of this is there"; the whole list answers both, and the step you are on
 * is the button that does it. It stands down once there is a program.
 */
function syncHint() {
  const { doc, ui, actions } = ctx;
  const setup = doc.setups()[0];
  // Every count is for the machine in front of you, as the tree's are. Counted
  // across the project, a job with a mill half switched to the lathe opened on
  // "✓ Pull a cutter" over a Tools list reading "no tools", and "✓ Generate"
  // with nothing generated on this machine at all.
  const operations = [...doc.allOperations()];
  const steps = [
    {
      // a DXF on its own is a job — an engraved plate has no solid in it — and
      // everything after this step already accepts one, so this step does too
      label: 'Import a model or a drawing',
      done: doc.project.models.length > 0 || (doc.project.drawings ?? []).length > 0,
      onclick: () => actions.openModel(),
    },
    {
      label: 'Pull a cutter from the library',
      done: doc.project.tools.some((t) => machineCanHold(t.type, doc.machine)),
      onclick: () => actions.addToolsFromLibrary(),
    },
    {
      label: 'Check the stock and where zero is',
      // a setup arrives with the first operation, so this is ticked as soon as
      // there is one to check — and when there is not, the step makes one,
      // rather than being the one button in the list that did nothing
      done: !!setup,
      onclick: () => (setup ? doc.select('setup', setup.id) : actions.addSetup()),
    },
    {
      label: 'Add operations, in machining order',
      done: operations.length > 0,
      onclick: () => actions.addOperation(),
    },
    {
      label: 'Generate the toolpaths',
      done: operations.some(({ op }) => doc.toolpaths.has(op.id)),
      onclick: () => actions.generate(),
    },
  ];

  // nothing to look at yet: the viewport says where a part comes from
  ui.setEmpty?.(!steps[0].done);
  if (steps.every((s) => s.done)) return ui.setHint(null);
  const next = steps.findIndex((s) => !s.done);
  ui.setHint(steps.map((step, i) => ({
    label: step.label,
    state: step.done ? 'done' : i === next ? 'next' : 'todo',
    // only the step you are on is clickable: the ones ahead of it need this one
    onclick: i === next ? step.onclick : null,
  })));
}

/** Height gizmos are only helpful on the Heights tab — noise anywhere else. */
function syncHeightGizmoVisibility() {
  const { doc, viewport, opTabs } = ctx;
  const op = doc.selection?.kind === 'op' ? doc.findSelected() : null;
  const activeTab = op ? opTabs.get(op.id) : null;
  viewport.heights.setVisible(activeTab === 'heights');
}

/**
 * Which heights this operation has, asked of the same descriptors the panel
 * builds its boxes from — so a handle in the scene and a box in the panel are
 * one decision rather than two lists that drift apart.
 */
function heightKeysFor(op) {
  const heights = OP_PARAM_GROUPS.find((g) => g.tab === 'heights');
  return (heights?.fields ?? [])
    .filter((f) => paramApplies(f, op))
    .map((f) => f.key);
}

/**
 * Show draggable height planes for the selected operation.
 *
 * Rebuilt only when the selection changes — during a drag the document is
 * updating continuously, and tearing down the handle being held would drop the
 * drag on its first frame.
 */
function syncHeightGizmos(kind) {
  const { doc, viewport } = ctx;
  const op = doc.selection?.kind === 'op' ? doc.findSelected() : null;
  if (!op) {
    if (shownGizmoOpId !== null) { viewport.heights.clear(); shownGizmoOpId = null; }
    return;
  }

  const setup = doc.findSetupOf(op.id);
  const stock = setup ? resolvedStock(setup) : null;
  if (shownGizmoOpId !== op.id) {
    shownGizmoOpId = op.id;
    viewport.heights.show(op.params, stock, heightKeysFor(op));
    // what the plane cuts through, so a height is a picture and not a number
    viewport.heights.setSectionSource(setup ? makeSectionSource(setup) : null);
    wireGizmoCallbacks(op);
  } else if (!viewport.heights.dragging) {
    viewport.heights.sync(op.params);
  }
}

/**
 * The part's cross-section at any Z, in the frame the gizmos live in.
 *
 * Built once per selection and cached by plane: dragging a handle asks for a
 * section on every pointer move, and slicing a mesh is linear in its triangles.
 * The mesh is moved into setup space first, because that is the frame the
 * toolpaths, the stock and the height planes are all already in — slicing the
 * raw CAD geometry would draw the section of a part that is somewhere else.
 */
function makeSectionSource(setup) {
  const meshes = setupMeshes(setup);
  if (meshes.length === 0) return null;
  const { matrix, offset } = resolveSetup(setup, meshes, computeStock);
  const merged = transformMesh(mergeMeshes(meshes), matrix, offset);
  let cachedKey = null;
  let cachedLoops = [];
  return (z) => {
    const key = Math.round(z * 200);   // five microns; finer than a drag can aim
    if (key === cachedKey) return cachedLoops;
    cachedKey = key;
    cachedLoops = sliceMeshZ(merged, z);
    return cachedLoops;
  };
}

/**
 * Handles on the selected clamp, so it can be dragged rather than retyped.
 *
 * Rebuilt only when the selection changes; while the same clamp stays selected
 * the handles are moved to follow whatever the panel does to it, so typing a
 * number and dragging a handle are two ways of saying the same thing rather
 * than two states that can disagree.
 */
function syncFixtureGizmo() {
  const { doc, viewport } = ctx;
  const gizmo = viewport.moveGizmo;
  const selected = doc.selection?.kind === 'fixture' ? doc.findSelected() : null;
  // A chuck does not move. It is the machine: the spindle axis is the origin of
  // everything on a lathe, and a chuck sitting anywhere but on that axis is not
  // a fixture in an unusual place, it is a drawing of a machine that does not
  // exist. What a chuck has is a *face* — how far the bar sticks out of it —
  // and that is a Z, typed or dragged on the height gizmo, not an XY handle.
  // Offering the handles invited a move that could only ever be wrong.
  const fixture = selected?.kind === 'chuck' ? null : selected;
  if (!fixture) {
    if (shownFixtureId !== null) { gizmo.clear(); shownFixtureId = null; }
    return;
  }

  const [x, y] = fixture.center ?? [0, 0];
  // a chuck is drawn on its face, a clamp on its base
  const z = fixture.kind === 'chuck'
    ? (fixture.faceZ ?? 0)
    : (fixture.baseZ ?? 0) + Math.max(0.5, fixture.height ?? 20);
  if (shownFixtureId !== fixture.id) {
    shownFixtureId = fixture.id;
    gizmo.show(x, y, z, fixtureScale(fixture));
    gizmo.onChange = (nx, ny) => {
      fixture.center = [round(nx), round(ny)];
      syncStock();                     // the clamp in the scene follows the handle
      renderProps(ctx.ui.props, doc, ctx);
    };
    gizmo.onCommit = (nx, ny, from) => {
      fixture.center = from;           // rewind, then record the move as one edit
      doc.updateItem(fixture, { center: [round(nx), round(ny)] }, 'move clamp');
    };
  } else {
    gizmo.sync(x, y, z);
  }
}

function fixtureScale(fixture) {
  if (fixture.kind === 'chuck') return Math.max(20, (fixture.bodyDiameter ?? 125) * 0.35);
  if (fixture.kind === 'cylinder') return Math.max(12, (fixture.diameter ?? 20) * 1.2);
  return Math.max(12, Math.max(...(fixture.size ?? [40, 20])) * 0.9);
}

function wireGizmoCallbacks(op) {
  const { doc, viewport } = ctx;
  let startedAt = null;

  // The param is written directly during the drag so the panel and the path
  // preview track the handle. That means the pre-drag value has to be captured
  // up front — by release it is long gone, and an undo entry recorded then
  // would "restore" the dragged value and do nothing.
  viewport.heights.onDragStart = (key) => { startedAt = op.params[key]; };

  // the handle cannot be dragged into an order that will not machine
  viewport.heights.limitsFor = (key) => heightLimits(op.params, key);

  viewport.heights.onChange = (key, z) => {
    op.params[key] = round(z);
    renderProps(ctx.ui.props, doc, ctx);
    viewport.requestRender();
  };

  viewport.heights.onCommit = (key, z) => {
    const original = startedAt;
    startedAt = null;
    const final = round(z);
    if (original === null || original === final) return;
    op.params[key] = original;                       // rewind, then record the move
    const { patch } = constrainHeights(op.params, key, final);
    doc.updateItem(op.params, patch, `drag ${key}`);
  };
}

function round(z) { return Math.round(z * 1000) / 1000; }

function resolvedStock(setup) {
  return resolveSetup(setup, setupMeshes(setup), computeStock).stock;
}

function setPickMode(mode, kind = ctx.pickKind) {
  ctx.pickMode = mode;
  ctx.pickKind = kind === 'edge' ? 'edge' : 'face';
  applyPickHandler();
  renderProps(ctx.ui.props, ctx.doc, ctx);
  const what = ctx.pickKind === 'edge' ? 'edges' : 'faces';
  ctx.ui.setStatus(mode
    ? `Click ${what} to ${mode === 'avoid' ? 'avoid' : 'machine'} — click again to unpick`
    : 'Picking off');
}

/**
 * Picking is armed by a button on the Regions tab, so it is only live while
 * that tab is the one being looked at.
 *
 * Leaving the tab used to leave the viewport armed: the buttons that say what a
 * click means were off screen, the status line still said "click faces", and
 * every click on the model went on adding and removing regions from an
 * operation whose region controls were not in front of anybody. Checked here
 * rather than unset on the way out, so there is one rule instead of one rule
 * and a list of the ways out.
 */
function pickingLive() {
  const { doc } = ctx;
  if (!ctx.pickMode || doc.selection?.kind !== 'op') return false;
  return ctx.opTabs.get(doc.selection.id) === 'regions';
}

function applyPickHandler() {
  const { doc, viewport } = ctx;
  if (!pickingLive()) {
    return viewport.setPickHandler(null);
  }
  viewport.setPickHandler((hit) => {
    const op = doc.findSelected();
    if (!op) return;
    const result = togglePicked(doc, op, ctx.pickMode, hit, ctx.pickKind);
    // A click in edge mode that landed nowhere near a crease is a miss, not a
    // pick of the nearest one — say so rather than selecting something the
    // user was not pointing at.
    if (result?.missed) {
      ctx.ui.setStatus('No edge there — click nearer the corner you want broken');
    }
  });
}

let shownToolpathKeys = '';
let shownGizmoOpId = null;
let shownFixtureId = null;

/**
 * Redraw toolpaths when what should be drawn changes — a delete, an undo, a
 * load, or an operation being enabled or disabled.
 */
function syncToolpaths() {
  const keys = ctx.doc.toolpathSignature();
  if (keys === shownToolpathKeys) return;
  shownToolpathKeys = keys;
  ctx.viewport.setToolpaths(ctx.doc.visibleToolpaths());
  ctx.viewport.setMarker(null);
  // a simulation is only true for the program it was built from
  if (ctx.simulation) ctx.actions?.closeSimulation();
  ctx.actions?.refreshGcodePreview(false);
}

/** Keep viewport objects in sync with the document (handles undo/redo/load). */
function syncViewportModels() {
  const { doc, viewport } = ctx;
  const ids = new Set(doc.project.models.map((m) => m.id));
  for (const id of [...viewport.modelObjects.keys()]) {
    if (!ids.has(id)) { viewport.removeModel(id); invalidateFaces(id); }
  }
  for (const model of doc.project.models) {
    if (!viewport.modelObjects.has(model.id) && doc.meshes.has(model.id)) {
      viewport.addModel(model.id, doc.meshes.get(model.id));
    }
  }
}

/**
 * Show stock and setup orientation for whichever setup is being worked on.
 * Both come from the same resolve the generator uses, so what is on screen is
 * what gets cut.
 */
/**
 * Show imported drawings where they will actually be cut.
 *
 * On the top of the billet, because that is the face an engraving pass works
 * on and because "shift X by 4" means nothing until you can see what it moved.
 * The selected one is picked out, so editing a placement with three drawings
 * loaded is not a guessing game.
 */
function syncDrawings() {
  const { doc, viewport } = ctx;
  const drawings = doc.project.drawings ?? [];
  if (drawings.length === 0) return viewport.setDrawings(null);

  const setup = doc.activeSetup();
  const stock = setup ? resolvedStock(setup) : null;
  // a hair above the face, or it z-fights the surface it is drawn on
  const z = (stock ? stock.max[2] : 0) + 0.05;
  const selectedId = doc.selection?.kind === 'drawing' ? doc.selection.id : null;
  viewport.setDrawings(drawings.map((drawing) => ({
    paths: placedPaths(drawing, stock),
    z,
    selected: drawing.id === selectedId,
  })));
  return undefined;
}

function syncStock() {
  const { doc, viewport } = ctx;
  const setup = doc.activeSetup();
  // which fixturing the scene is drawn in — said only when there is a choice
  // of more than one, where it is the answer to "why did the part turn round"
  const setups = doc.setups();
  ctx.ui.setSceneLabel(setup && setups.length > 1
    ? `${setup.name} · ${setup.wcs ?? 'G54'} — ${setups.indexOf(setup) + 1} of ${setups.length} setups`
    : null);
  // the part this setup machines, and not the rest of the project's models
  viewport.setModelsShown(setup ? setupModelIds(setup, doc.project) : null);
  if (!setup) {
    viewport.setSetupTransform(null);
    viewport.setFixtures(null);
    return viewport.setStock(null);
  }
  const { matrix, offset, stock } = resolveSetup(setup, setupMeshes(setup), computeStock);
  viewport.setSetupTransform(matrix, offset);
  viewport.setStock(stock);
  // clamps are held in setup space, which is the frame the scene is already in
  viewport.setFixtures(setup.fixtures);
}

/**
 * Push the preferences into the things that answer to them.
 *
 * One place, called at boot and again on every change, so a setting cannot be
 * a switch that is read once and then quietly ignored. Anything added to
 * app/settings.js that the viewport has to know about belongs here.
 */
function applySettings(key = null) {
  const { viewport, doc } = ctx;
  if (!viewport) return;
  const touches = (name) => key === null || key === name;

  if (touches('projection')) viewport.setProjectionMode(getSetting('projection'));
  if (touches('showGrid') || touches('showAxes')) {
    // Held on the viewport rather than written straight onto the objects: the
    // grid and the axes are rebuilt whenever the job changes scale or the
    // machine changes, and a `visible` written onto the old object is lost the
    // first time that happens — which reads as a setting that stops working
    // after you import something.
    viewport.setEnvironmentVisible({
      grid: getSetting('showGrid'),
      axes: getSetting('showAxes'),
    });
  }
  if (touches('showTriad')) viewport.triad.enabled = getSetting('showTriad');
  if (touches('showRapids') || touches('pathBrightness')) {
    viewport.setToolpathStyle({
      rapids: getSetting('showRapids'),
      brightness: getSetting('pathBrightness'),
    });
    shownToolpathKeys = '';          // force a rebuild with the new style
    syncToolpaths();
  }
  if (touches('simSmooth')) viewport.simulation.setSmooth(getSetting('simSmooth'));
  if (touches('showHolder')) viewport.simulation.setShowHolder(getSetting('showHolder'));
  if (touches('ghostTool')) viewport.simulation.setGhostTool(getSetting('ghostTool'));
  if (touches('showCutMarker')) viewport.simulation.setShowCutMarker(getSetting('showCutMarker'));
  if (touches('autosave')) keepSession(getSetting('autosave'));
  if (touches('hintStyle') && key !== null) {
    ctx.hintStyle = getSetting('hintStyle');
    ctx.rerenderProps?.();
  }
  viewport.requestRender();
}

/**
 * Start or stop keeping the session, as the setting says — now, not after a
 * reload. Switched off, what was kept is thrown away as well, because a session
 * file nothing is updating is a stale job waiting to be restored.
 */
let stopAutosave = null;
function keepSession(on) {
  if (on && !stopAutosave) {
    stopAutosave = attachAutosave(ctx.doc, {
      onError: (err) => ctx.ui.setStatus(`Autosave failed (${err.name}) — export to keep your work`, true),
    });
  } else if (!on && stopAutosave) {
    stopAutosave();
    stopAutosave = null;
    clearSaved();
  }
}

function boot() {
  const actions = makeActions(ctx);
  ctx.actions = actions;  // needs to be visible before renderTree runs
  ctx.ui = buildLayout(document.getElementById('app'), actions, ctx.doc.project);
  ctx.viewport = new Viewport(ctx.ui.viewport);
  // the viewport has always said when the view changed; now the bar hears it
  ctx.viewport.onViewChange = (name) => ctx.ui.setActiveView(name);
  ctx.ui.setActiveView(ctx.viewport.viewName);
  ctx.applySettings = applySettings;
  ctx.hintStyle = getSetting('hintStyle');
  ctx.doc.addEventListener('change', (e) => refresh(e.detail.kind));

  // Every key lives in shortcuts.js, so the help dialog and the bindings come
  // from one table and cannot drift apart.
  bindShortcuts(window, ctx);
  // and every file the toolbar can open can also be dropped on the window
  installDropImport(ctx);

  // Only when the session is being kept. With the switch off, the file left
  // behind by the last session that kept one was restored on every reload
  // anyway — the same stale job, forever, since nothing was writing it.
  if (getSetting('autosave')) {
    restoreSaved();   // async: the store is a filesystem, and the boot does not wait on it
  }

  refresh('boot');
  applySettings();
  ctx.actions = actions;
  window.cncam = ctx; // debug/testing handle (live reference)

  registerServiceWorker();
  showBuildBadge();

  // Compile the engine in the workers now, while the user is opening a model
  // and picking cutters. Left until Generate, this is most of the wait: a
  // trivial job on a cold worker takes two seconds. See workers/pool.js.
  ctx.pool.warm();
}

/**
 * Register the cache-busting service worker (see sw.js).
 *
 * It fetches every module fresh from the network, so a push is visible on the
 * next reload without a Ctrl-F5. `updateViaCache: 'none'` keeps the worker
 * script itself out of the HTTP cache; the path is resolved from this module's
 * URL so it works both at the site root and under a GitHub Pages project path.
 * It is a progressive enhancement — a browser without service workers, or the
 * file: protocol, simply loads as before.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  const url = new URL('../../sw.js', import.meta.url);
  navigator.serviceWorker.register(url, { updateViaCache: 'none' }).catch(() => {});
}

/**
 * The build stamp, in the bottom-right corner — so "am I looking at the version
 * I just pushed?" has an answer on screen. A link to the repository, because the
 * next question after "which build" is usually "what changed in it".
 */
function showBuildBadge() {
  const badge = document.createElement('a');
  badge.id = 'build-badge';
  badge.textContent = `build ${BUILD.revision}`;
  badge.href = 'https://github.com/gamerpaddy/CNCAM';
  badge.target = '_blank';
  badge.rel = 'noopener';
  badge.title = `CNCAM build ${BUILD.revision} — click for the repository`;
  // at the end of the status line, which gives way to it, rather than floating
  // over the line and covering the end of whatever it was saying
  (document.querySelector('.status') ?? document.body).append(badge);
}

/**
 * Bring back the previous session.
 *
 * The autosave is a file in the browser's own filesystem now, so it is read
 * asynchronously and the boot does not wait: the app comes up empty and the
 * restore lands a moment later, through the same change event any other load
 * goes through. A session saved by an older build — or by a browser with no
 * file store — still comes back from localStorage, where its geometry may not
 * have fitted; the setups and operations are the expensive part to recreate,
 * and those survive either way.
 */
async function restoreSaved() {
  const saved = await loadSaved();
  if (!saved) {
    // nothing came back, so there is no job for a remembered drawer to be of
    ctx.storeProjectId = null;
    return;
  }
  const meshes = new Map();
  for (const [id, mesh] of saved.meshes) meshes.set(id, computeNormals(mesh));
  ctx.doc.restore(saved.project, meshes);

  // Frame what came back. Restoring puts models in the scene without ever
  // touching the camera, and the setup transform then shifts the camera by the
  // same delta it shifts the part — which keeps a *framed* part framed, and
  // sends a default camera that was never looking at the part even further from
  // it. The result is a project that loads perfectly and shows an empty
  // viewport, which reads as "my model did not load".
  ctx.viewport.frameAll();

  const total = saved.project.models.length;
  const missing = total - meshes.size;
  ctx.ui.setStatus(missing
    ? `Restored last session — re-import ${missing} of ${plural(total, 'model')}`
    : 'Restored last session');
}

boot();
