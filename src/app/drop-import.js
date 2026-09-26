// Files dropped on the window: a part, a drawing, a project or a program.
//
// Every one of these used to be a toolbar button, a file dialog and a walk
// through the folders to a file that was already open in Explorer next to the
// browser. Dropping it is the same import — the very same actions, handed the
// file the dialog would have handed them — without the walk.

import { ACCEPT } from '../io/files.js';
import { el } from './layout.js';

/** Which action a file goes to, by its extension. */
const ROUTES = [
  { accept: ACCEPT.model, run: (actions, file) => actions.openModel(file) },
  { accept: ACCEPT.project, run: (actions, file) => actions.openProject(file) },
  { accept: ACCEPT.gcode, run: (actions, file) => actions.checkGcode(file) },
];

function routeFor(name) {
  const lower = name.toLowerCase();
  return ROUTES.find(({ accept }) => accept.extensions.some((ext) => lower.endsWith(ext))) ?? null;
}

/**
 * Listen for files being dragged over the window, show where they can go, and
 * open them when they are dropped.
 *
 * Stands aside for anything else that takes a drop: an operation dragged to a
 * new place in the tree carries no files, and a photograph dropped on the tool
 * wizard is handled — and its default prevented — before it gets here. With a
 * dialog open, a drop means that dialog, not the job behind it.
 */
export function installDropImport(ctx) {
  const overlay = el('div', { class: 'drop-overlay', 'aria-hidden': 'true' }, [
    el('div', { class: 'drop-card' }, [
      el('div', { class: 'drop-title' }, ['Drop to open']),
      el('div', { class: 'drop-detail' }, [
        'A part (STEP, IGES, STL, OBJ), a drawing (DXF), a .cncam project, or a G-code file to check',
      ]),
    ]),
  ]);
  document.body.append(overlay);

  const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  const dialogOpen = () => !!document.querySelector('dialog[open]');
  let depth = 0;
  const show = (on) => overlay.classList.toggle('on', on);

  window.addEventListener('dragenter', (e) => {
    if (!carriesFiles(e) || dialogOpen()) return;
    depth++;
    show(true);
  });
  window.addEventListener('dragleave', (e) => {
    if (!carriesFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  });
  window.addEventListener('dragover', (e) => {
    if (!carriesFiles(e) || dialogOpen() || e.defaultPrevented) return;
    e.preventDefault();          // what says "this window takes a drop"
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', async (e) => {
    depth = 0;
    show(false);
    if (!carriesFiles(e) || dialogOpen() || e.defaultPrevented) return;
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    const refused = [];
    // One at a time, in the order they were dropped: each import can ask a
    // question (a second part replacing the first), and two at once would ask
    // both over each other.
    for (const file of files) {
      const route = routeFor(file.name);
      if (!route) { refused.push(file.name); continue; }
      // eslint-disable-next-line no-await-in-loop
      const buffer = await file.arrayBuffer();
      // eslint-disable-next-line no-await-in-loop
      await route.run(ctx.actions, { name: file.name, buffer, handle: null });
    }
    if (refused.length) {
      ctx.ui.setStatus(`Cannot open ${refused.join(', ')} — drop a STEP, IGES, STL, OBJ, DXF, `
        + '.cncam or G-code file', true);
    }
  });
}
