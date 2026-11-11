// Autosave, so a reload does not cost you an afternoon of setup.
//
// This used to be two localStorage keys: the project as JSON in one, and as
// many meshes as would fit a three-megabyte budget in the other. The budget was
// the problem. A single STEP import is comfortably past it, so the geometry was
// dropped — quietly, because dropping it was the design — and a reload came
// back with every setup and operation intact, pointing at a part that was no
// longer there.
//
// It writes to the browser's own filesystem now (see doc/project-store.js),
// where quota is measured in hundreds of megabytes and a project is a file
// rather than a string in a key. So the session is saved the way a .cncam file
// is saved: whole, geometry included, with no budget to fall off the end of.
// A browser without an OPFS still gets the old behaviour rather than nothing.
//
// Saves are debounced — every keystroke in a number field is a document change,
// and serialising the project on each one would be silly.

import {
  serializeProject, deserializeProject, extractMeshes, extractFixtureMeshes,
} from './schema.js';
import { encodeMesh, decodeMesh, meshCost } from './mesh-codec.js';
import {
  storeAvailable, saveSession, loadSession, clearSession,
} from './project-store.js';

const PROJECT_KEY = 'cncam.project';
const MESH_KEY = 'cncam.meshes';
const STORE_ID_KEY = 'cncam.sessionProject';
const SAVE_DELAY = 400;
const MESH_BUDGET = 3_000_000;   // characters of base64; keeps us inside quota

/**
 * The previous session, or null.
 *
 * Reads the file store first and the old localStorage pair second, so a browser
 * that has been running this app since before the store existed comes back with
 * what it had — and then, on its first save, moves to the store for good.
 *
 * @returns { project, meshes, repairs } — meshes as a Map of modelId → mesh,
 *   without normals; the caller computes those. `repairs` is what had to be
 *   dropped or reset to make the saved file usable (see doc/repair.js). A
 *   session that cannot be read at all comes back as `{ unreadable }` — the
 *   reason, for the caller to say — rather than as nothing: an autosave that
 *   vanished without a word is a job lost without a word.
 */
export async function loadSaved() {
  if (storeAvailable()) {
    try {
      const json = await loadSession();
      if (json) {
        const repairs = [];
        const project = deserializeProject(json, repairs);
        return {
          project,
          meshes: extractMeshes(project, repairs),
          fixtureMeshes: extractFixtureMeshes(project, repairs),
          repairs,
        };
      }
    } catch (err) {
      console.warn('unreadable autosave', err);
      // A session written by a newer build is not damaged, only ahead of this
      // one: left where it is, so going back to that build brings it back.
      // Keep the unreadable session available for recovery.
      return { unreadable: err.message };
    }
  }
  return loadLegacy();
}

function loadLegacy() {
  // no storage to read (blocked by the browser, or none at all) is not a
  // session that was damaged
  let json = null;
  try { json = localStorage.getItem(PROJECT_KEY); } catch { return null; }
  if (!json) return null;
  try {
    const repairs = [];
    return { project: deserializeProject(json, repairs), meshes: loadLegacyMeshes(), repairs };
  } catch (err) {
    console.warn('unreadable autosave', err);
    if (!/this build reads up to/.test(err.message)) {
      try { clearSaved(); } catch { /* nothing to clear it from */ }
    }
    return { unreadable: err.message };
  }
}

function loadLegacyMeshes() {
  const meshes = new Map();
  try {
    const raw = localStorage.getItem(MESH_KEY);
    if (!raw) return meshes;
    for (const [id, record] of Object.entries(JSON.parse(raw))) {
      const mesh = decodeMesh(record);
      if (mesh) meshes.set(id, mesh);
    }
  } catch (err) {
    console.warn('could not restore saved meshes', err);
  }
  return meshes;
}

/**
 * Which project in the browser's store the session is a version of, or null.
 *
 * Kept beside the session rather than only in memory: the session survives a
 * reload, and a session that forgot where it was filed made its next "Save a
 * version" a second drawer of the same job instead of the next version in the
 * first. Not in the project itself, because a project goes out as a file and
 * this is a fact about one browser.
 */
export function sessionProjectId() {
  try {
    return localStorage.getItem(STORE_ID_KEY) || null;
  } catch {
    return null;
  }
}

export function setSessionProjectId(id) {
  try {
    if (id) localStorage.setItem(STORE_ID_KEY, id);
    else localStorage.removeItem(STORE_ID_KEY);
  } catch { /* no storage: the link lasts as long as the page */ }
}

/** Forget the session — both where it lives now and where it used to. */
export function clearSaved() {
  try {
    localStorage.removeItem(PROJECT_KEY);
    localStorage.removeItem(MESH_KEY);
  } catch { /* storage may be blocked independently of OPFS */ }
  setSessionProjectId(null);
  return storeAvailable() ? clearSession() : Promise.resolve();
}

/**
 * Watch a document and persist it. Returns a stop function.
 *
 * Failures are reported once and then tolerated — losing the autosave is an
 * annoyance, but it must never break the session that is running.
 */
export function attachAutosave(doc, { onError, onState, delay = SAVE_DELAY } = {}) {
  // `delay` is how long the document must be quiet before it is written (ms):
  // a preference, because serialising a large model on every pause is a cost a
  // slow disk may want paid less often. A pending save is still made when the
  // page is hidden, whatever the delay.
  let timer = null;
  let warned = false;
  let writing = null;
  let revision = 0;
  let stopped = false;

  const save = async () => {
    timer = null;
    if (stopped) return;
    const savingRevision = revision;
    onState?.('saving');
    try {
      if (storeAvailable()) {
        // One write of one file, exactly what "Save" would have produced. The
        // writes are chained rather than overlapped: two createWritable() calls
        // racing on the same file is a truncated project, and the later one is
        // the only one anybody wants anyway.
        //
        // The chain is joined past any earlier failure: `.then` on a rejected
        // promise never calls its callback, so one write that failed (a full
        // disk, a moment's lock) used to leave `writing` rejected for good and
        // every save after it skipped — silently, because the warning is only
        // given once. A failed write is reported by the save that made it.
        writing = (writing ?? Promise.resolve())
          .catch(() => {})
          .then(() => saveSession(serializeProject(doc.project, doc.meshes, doc.fixtureMeshes)));
        await writing;
      } else {
        localStorage.setItem(PROJECT_KEY, serializeProject(doc.project));
        saveLegacyMeshes(doc);
      }
      warned = false;
      if (!stopped) onState?.(timer || revision !== savingRevision ? 'changed' : 'saved');
    } catch (err) {
      if (!stopped) onState?.('error');
      if (!warned) { warned = true; onError?.(err); }
    }
  };

  const onChange = (event) => {
    if (['selection', 'toolpaths', 'visibility'].includes(event?.detail?.kind)) return;
    revision++;
    onState?.('changed');
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, delay);
  };

  // A save still waiting on its debounce when the page goes away is an edit
  // lost: change a number and press F5, or close the tab, inside the delay —
  // and a hidden tab's timers are throttled by the browser, so "inside the
  // delay" can be a minute. Hidden is the last moment a page is reliably given
  // to finish work, so a pending save is made there rather than waited for.
  const flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    save();
  };
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush();
  };
  const hasWindow = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (hasWindow) {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
  }

  doc.addEventListener('change', onChange);
  return () => {
    stopped = true;
    doc.removeEventListener('change', onChange);
    if (hasWindow) {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    }
    if (timer) clearTimeout(timer);
  };
}

// Encoded through doc/mesh-codec.js, which is also what a saved project file
// uses. It had a second copy of the base64 pair here, and the copy did not know
// about `faceRanges` — so a STEP import came back from a reload with its B-rep
// face grouping gone, and face picking fell back to one face per triangle on
// exactly the models that know what their faces are.
function saveLegacyMeshes(doc) {
  const out = {};
  let budget = MESH_BUDGET;
  for (const model of doc.project.models) {
    const mesh = doc.meshes.get(model.id);
    if (!mesh) continue;
    // a model too big to store is skipped rather than blowing the whole save;
    // it reimports from file, while the setup around it survives
    const cost = meshCost(mesh);
    if (cost > budget) continue;
    budget -= cost;
    out[model.id] = encodeMesh(mesh);
  }
  localStorage.setItem(MESH_KEY, JSON.stringify(out));
}
