// User actions: everything a button, a key or a menu item can do.
//
// Assembled from four modules that split along the lines the work actually
// falls into — resolving a setup into machine coordinates, running the program,
// moving files, and editing the job. They are built in dependency order:
// clearing a project has to be able to close a simulation, and generating has
// to be able to resolve a setup.
//
// `ctx` is filled in by main.js: { doc, pool, ui, viewport } — ui and viewport
// arrive after the layout is built, which is why nothing here touches them at
// construction time.

import { openHelp } from './help.js';
import { openOptions as dialogOptions } from './options-dialog.js';
import { setSetting } from './settings.js';
import { PROJECTION_LABELS, PROJECTION_HINTS } from '../view/views.js';
import { makeSetupSpace } from './actions/setup-space.js';
import { makeProgramActions } from './actions/program.js';
import { makeFileActions } from './actions/files.js';
import { makeEditActions } from './actions/editing.js';
import { makeCheckActions } from './actions/check.js';

export function makeActions(ctx) {
  const { doc } = ctx;
  const space = makeSetupSpace(doc);
  const program = makeProgramActions(ctx, space);
  const files = makeFileActions(ctx, program);
  const editing = makeEditActions(ctx, space);
  const check = makeCheckActions(ctx, space);

  /** The key list and the running order of a job. Bound to ? and the toolbar. */
  function showShortcuts() {
    openHelp(ctx);
  }

  /** Put the camera where it can see the job. The way back from a lost view. */
  function fitView() {
    // asked of the viewport, which knows what is on screen: a drawing-only job
    // has no model and a great deal to look at
    if (!ctx.viewport.frameAll({ animate: true })) {
      return ctx.ui.setStatus('Nothing to fit — import a model', true);
    }
    return ctx.ui.setStatus('View fitted');
  }

  /**
   * Snap to a named view.
   *
   * Orbiting to "square on from the front" by hand is a game of degrees, and
   * getting it *nearly* square is worse than useless — a wall that looks
   * vertical from 3° off is a wall you cannot judge.
   */
  function setView(name) {
    const preset = ctx.viewport.setView(name, { animate: true });
    ctx.ui.setStatus(`${preset.label} view — ${preset.hint}`);
  }

  /**
   * Perspective or orthographic, remembered.
   *
   * A projection is a preference, not a property of the job: it belongs to the
   * person looking at it and it should still be what they chose next time they
   * open the app.
   */
  function setProjection(mode) {
    setSetting('projection', mode);
    // What is applied is not always what was asked for: 'auto' resolves against
    // the view the camera is in. The status line says what happened, because
    // "Automatic" on its own does not tell you which one you got.
    const applied = ctx.viewport.setProjectionMode(mode);
    const prefix = mode === 'auto' ? `${PROJECTION_LABELS.auto} — ` : '';
    ctx.ui.setStatus(`${prefix}${PROJECTION_LABELS[applied]} — ${PROJECTION_HINTS[applied]}`);
  }

  /** Which projection is on screen right now — not which one is preferred. */
  function liveProjection() {
    return ctx.viewport.projection;
  }

  function openOptions() {
    dialogOptions({
      onChange: (key) => {
        ctx.applySettings?.(key);
        // some of them change what the panels draw, not just the viewport
        if (key === 'hintStyle') ctx.rerenderProps?.();
      },
      onStatus: (message, isError = false) => ctx.ui.setStatus(message, isError),
    });
  }

  /** The WebGL buffer is a fixed size; a panel drag has to say so. */
  function viewportResized() {
    ctx.viewport?.resize();
  }

  return {
    ...program,
    ...files,
    ...editing,
    ...check,
    // the panel needs it too, to offer "snap this height to the top of the part"
    setupModelBounds: space.setupModelBounds,
    // and how far the part's own bore goes, which is what a drill down the axis
    // is aimed at — see actions/setup-space.js
    setupBoreBottom: space.setupBoreBottom,
    showShortcuts,
    fitView,
    setView,
    toolpathsVisible: () => ctx.viewport?.toolpathsVisible() ?? true,
    setProjection,
    liveProjection,
    openOptions,
    viewportResized,
    undo,
    redo,
  };

  /**
   * Undo, saying what was undone.
   *
   * Every other edit reports on the status line, and these two did not — so a
   * Ctrl+Z that reverted a stepover on a panel you were not looking at, or a
   * clamp in another setup, changed the job without a word. The button's
   * tooltip knew what it was about to undo; now the status line says what it
   * did. The key comes here too rather than straight to the document.
   */
  function undo() {
    const label = doc.undoStack.undoLabel;
    if (!label) return ctx.ui.setStatus('Nothing to undo');
    doc.undo();
    return ctx.ui.setStatus(`Undid ${label} — Ctrl+Y to redo`);
  }

  function redo() {
    const label = doc.undoStack.redoLabel;
    if (!label) return ctx.ui.setStatus('Nothing to redo');
    doc.redo();
    return ctx.ui.setStatus(`Redid ${label}`);
  }
}
