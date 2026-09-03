// The Projects dialog: the jobs kept in this browser, and their history.
//
// Save and Open have always meant "write a .cncam somewhere on disk", which is
// the right answer for handing a job to somebody else and the wrong one for the
// twelve times a day you save your own. This is the other half: a drawer of
// projects that lives with the app, every save a new version, and nothing ever
// overwritten.
//
// Three things it must never let you believe:
//
//   * That the store is a backup. It is inside the browser — clearing site data
//     takes it — so Download is on every row and the header says so out loud.
//   * That a version is gone when it is only older. The history is the feature;
//     versions are listed with their size and the note you left, and any of them
//     opens.
//   * That opening one is free. It replaces the project in front of you, so it
//     asks first when there is anything to lose.

import { el } from './layout.js';
import {
  listProjects, readVersion, saveVersion, deleteProject,
  deleteVersion, renameProject, usage, storeAvailable, MAX_VERSIONS,
} from '../doc/project-store.js';

/**
 * @param currentName  what the open project is called, to seed the save box
 * @param currentJSON  () => the open project as a .cncam string
 * @param currentId    the store id this project was last saved to, or null
 * @param hasWork      whether opening something would discard anything
 * @param onOpen       (json, meta) => void — load it into the app
 * @param onSaved      (id, name) => void — so the app can remember where it went
 * @param onStatus     (message, isError) => void
 * @param files        { open, save } — the app's file pickers, for up/download
 */
export function openProjectBrowser({
  currentName = 'Untitled', currentJSON, currentId = null, hasWork = false,
  onOpen, onSaved, onStatus, files,
}) {
  const dialog = el('dialog', { class: 'lib-dialog proj-dialog' });
  const body = el('div', { class: 'lib-body proj-body' });
  const note = el('span', { class: 'lib-hint' });
  const expanded = new Set();
  // Seeded with wherever this project was last saved, so the second save of a
  // session adds a version rather than starting a second drawer of the same job.
  let saveAs = currentId;

  const nameInput = el('input', { class: 'lib-search proj-name', type: 'text' });
  nameInput.value = currentName;
  const saveButton = el('button', { class: 'primary' }, ['Save a version']);
  saveButton.addEventListener('click', () => save());

  async function refresh() {
    if (!storeAvailable()) {
      body.replaceChildren(el('div', { class: 'tree-empty' }, [
        'This browser has no private file system, so projects cannot be kept here. '
        + 'Save and Open still write .cncam files to disk.',
      ]));
      return;
    }
    let projects = [];
    try {
      projects = await listProjects();
    } catch (err) {
      body.replaceChildren(el('div', { class: 'tree-empty' }, [`Could not read the store: ${err.message}`]));
      return;
    }
    body.replaceChildren(...(projects.length
      ? projects.map(projectRow)
      : [el('div', { class: 'tree-empty' }, [
        'Nothing kept here yet. "Save a version" puts the project you have open '
        + 'into this browser; it stays until you delete it or clear site data.',
      ])]));

    const { stored, quota } = await usage();
    note.textContent = quota
      ? `${plural(projects.length, 'project')} · ${size(stored)} of about ${size(quota)} available`
      : `${plural(projects.length, 'project')} · ${size(stored)}`;
  }

  /** One job: what it is, when it was last touched, and what can be done to it. */
  function projectRow(meta) {
    const open = expanded.has(meta.id);
    const bytes = meta.versions.reduce((s, v) => s + v.bytes, 0);
    const head = el('div', { class: 'proj-head' }, [
      el('button', {
        class: 'proj-twisty',
        title: open ? 'Hide the history' : `Show all ${meta.versions.length} versions`,
        onclick: () => { toggle(meta.id); },
      }, [open ? '▾' : '▸']),
      el('div', { class: 'proj-id' }, [
        el('div', { class: 'proj-name-text' }, [meta.name]),
        el('div', { class: 'proj-meta' }, [
          `v${meta.versions[0].v} · ${when(meta.updated)} · `
          + `${plural(meta.versions.length, 'version')} · ${size(bytes)}`,
        ]),
      ]),
      el('button', {
        class: 'primary',
        title: 'Load the newest version into the app',
        onclick: () => openVersion(meta, meta.versions[0].v),
      }, ['Open']),
      el('button', {
        title: 'Write the newest version out as a .cncam file',
        onclick: () => download(meta, meta.versions[0].v),
      }, ['Download']),
      el('button', {
        title: 'Further saves of the open project go into this project',
        class: saveAs === meta.id ? 'active' : '',
        onclick: () => {
          saveAs = saveAs === meta.id ? null : meta.id;
          nameInput.value = saveAs ? meta.name : currentName;
          refresh();
        },
      }, [saveAs === meta.id ? 'Saving here' : 'Save into']),
      el('button', { title: 'Rename it', onclick: () => rename(meta) }, ['Rename']),
      el('button', {
        class: 'danger',
        title: 'Delete this project and every version of it',
        onclick: () => remove(meta),
      }, ['Delete']),
    ]);
    return el('div', { class: `proj-item${open ? ' open' : ''}` }, [
      head,
      ...(open ? [el('div', { class: 'proj-versions' },
        meta.versions.map((v) => versionRow(meta, v)))] : []),
    ]);
  }

  function versionRow(meta, v) {
    return el('div', { class: 'proj-version' }, [
      el('span', { class: 'proj-v' }, [`v${v.v}`]),
      el('span', { class: 'proj-when' }, [when(v.at)]),
      el('span', { class: 'proj-size' }, [size(v.bytes)]),
      el('span', { class: 'proj-note' }, [v.note || '']),
      el('button', { onclick: () => openVersion(meta, v.v) }, ['Open']),
      el('button', { onclick: () => download(meta, v.v) }, ['Download']),
      el('button', {
        class: 'danger',
        title: meta.versions.length < 2
          ? 'The only version left — delete the project instead'
          : `Delete v${v.v}`,
        onclick: () => removeVersion(meta, v),
      }, ['✕']),
    ]);
  }

  /**
   * Throw one version away — asked about first.
   *
   * Deleting the project asks; deleting a version did not, and it is the same
   * loss on a smaller scale and behind a smaller button. A ✕ sitting between
   * Open and Download on a dense row is exactly the button a mis-aimed click
   * lands on, and there is no undo here: the store is the only copy of that
   * version unless it has been downloaded. So it says which one, how old it is
   * and how big — a history of eight rows is unreadable without them — and it
   * checks the "only version left" rule before asking, rather than asking a
   * question whose answer turns out not to matter.
   */
  async function removeVersion(meta, v) {
    if (meta.versions.length < 2) {
      onStatus?.('That is the only version left — delete the project instead', true);
      return;
    }
    const newest = v.v === meta.versions[0].v;
    if (!confirm(
      `Delete ${meta.name} v${v.v}, saved ${when(v.at)} (${size(v.bytes)})?

`
      + (newest
        ? `This is the newest version, so Open on ${meta.name} will give you `
          + `v${meta.versions[1].v} instead.

`
        : '')
      + 'It cannot be undone, and this browser is the only copy unless you have '
      + 'downloaded it.')) return;
    if (!(await deleteVersion(meta.id, v.v))) {
      onStatus?.('That is the only version left — delete the project instead', true);
      return;
    }
    await refresh();
    onStatus?.(`${meta.name} v${v.v} deleted`);
  }

  function toggle(id) {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    refresh();
  }

  // --- what the buttons do -------------------------------------------------

  async function save() {
    const name = nameInput.value.trim() || 'Untitled';
    try {
      const { id, v, dropped } = await saveVersion({
        id: saveAs, name, json: currentJSON(),
      });
      saveAs = id;
      onSaved?.(id, name);
      expanded.add(id);
      await refresh();
      onStatus?.(`${name} saved as v${v}`
        + (dropped ? ` — the oldest ${plural(dropped, 'version')} aged out at ${MAX_VERSIONS}` : ''));
    } catch (err) {
      onStatus?.(`Could not save into this browser: ${err.message}`, true);
    }
  }

  /**
   * Load one version. Destructive, so it asks — but only while there is
   * something in front of you worth asking about.
   */
  async function openVersion(meta, v) {
    if (hasWork && !confirm(
      `Open ${meta.name} v${v}?\n\nThe project you have open is replaced. `
      + 'Save it here first if you want to keep it.')) return;
    try {
      const json = await readVersion(meta.id, v);
      dialog.close();
      onOpen?.(json, { ...meta, version: v });
    } catch (err) {
      onStatus?.(`Could not open it: ${err.message}`, true);
    }
  }

  async function download(meta, v) {
    try {
      const json = await readVersion(meta.id, v);
      const suffix = v === meta.versions[0].v ? '' : `-v${v}`;
      await files.save(`${meta.name}${suffix}.cncam`, json);
      onStatus?.(`${meta.name} v${v} written out`);
    } catch (err) {
      onStatus?.(`Download failed: ${err.message}`, true);
    }
  }

  /**
   * Read a .cncam from disk into the store.
   *
   * It lands as a project rather than being opened, because the two are
   * different intentions: this one is "keep this where the others are", and the
   * file it came from is already open-able through Open. The name comes from
   * the project inside the file, not the filename — those disagree often enough
   * that the drawer would fill up with "bracket (2) final REAL".
   */
  async function upload() {
    const file = await files.open();
    if (!file) return;
    const json = new TextDecoder().decode(file.buffer);
    let name = file.name.replace(/\.[^.]+$/, '');
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed?.version !== 'number') throw new Error('not a CNCAM project');
      if (typeof parsed.name === 'string' && parsed.name) name = parsed.name;
    } catch (err) {
      onStatus?.(`${file.name} is not a project file (${err.message})`, true);
      return;
    }
    try {
      const { id, v } = await saveVersion({ name, json, note: `from ${file.name}` });
      expanded.add(id);
      await refresh();
      onStatus?.(`${name} added to this browser as v${v}`);
    } catch (err) {
      onStatus?.(`Could not store it: ${err.message}`, true);
    }
  }

  async function rename(meta) {
    const next = prompt('Call this project:', meta.name);
    if (next == null || !next.trim() || next.trim() === meta.name) return;
    await renameProject(meta.id, next.trim());
    refresh();
  }

  async function remove(meta) {
    if (!confirm(
      `Delete ${meta.name} and all ${plural(meta.versions.length, 'version')}?\n\n`
      + 'This cannot be undone, and the store is the only copy unless you have '
      + 'downloaded it.')) return;
    await deleteProject(meta.id);
    expanded.delete(meta.id);
    if (saveAs === meta.id) saveAs = null;
    refresh();
  }

  dialog.append(
    el('div', { class: 'lib-head' }, [
      el('h2', {}, ['Projects in this browser']),
      note,
      el('span', { class: 'spacer' }),
      el('span', { class: 'lib-hint' }, [
        'Kept by the browser, not on your disk — clearing site data clears these. '
        + 'Download anything you cannot lose.',
      ]),
    ]),
    el('div', { class: 'lib-catalogs proj-save' }, [
      el('span', { class: 'lib-catalog-label' }, ['Save the open project as']),
      nameInput,
      saveButton,
      el('span', { class: 'spacer' }),
      el('span', { class: 'lib-hint' }, [
        'Every save is a new version; the old ones stay. It goes into the project '
        + 'marked "Saving here", or starts a new one.',
      ]),
    ]),
    body,
    el('div', { class: 'lib-actions' }, [
      el('button', { onclick: upload, title: 'Read a .cncam file into this browser' }, ['Upload a file…']),
      el('span', { class: 'spacer' }),
      el('button', { class: 'primary', onclick: () => dialog.close() }, ['Done']),
    ]),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  refresh();
  return dialog;
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  // The quota this is also used for is measured in gigabytes, and "4298.2 MB"
  // is a number nobody reads as "plenty".
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * When, said the way a person would.
 *
 * A history of eight rows all reading "03/09/2026" tells you nothing about
 * which one you want; "12 minutes ago" and "yesterday 14:20" do.
 */
function when(at) {
  const ms = Date.now() - at;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const midnight = new Date().setHours(0, 0, 0, 0);
  if (at >= midnight) return `today ${time}`;
  if (at >= midnight - 86_400_000) return `yesterday ${time}`;
  return `${date.toLocaleDateString()} ${time}`;
}
