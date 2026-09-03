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

import { serializeProject, deserializeProject, extractMeshes } from './schema.js';
import { encodeMesh, decodeMesh, meshCost } from './mesh-codec.js';
import {
  storeAvailable, saveSession, loadSession, clearSession,
} from './project-store.js';

const PROJECT_KEY = 'cncam.project';
const MESH_KEY = 'cncam.meshes';
const SAVE_DELAY = 400;
const MESH_BUDGET = 3_000_000;   // characters of base64; keeps us inside quota

/**
 * The previous session, or null.
 *
 * Reads the file store first and the old localStorage pair second, so a browser
 * that has been running this app since before the store existed comes back with
 * what it had — and then, on its first save, moves to the store for good.
 *
 * @returns { project, meshes } — meshes as a Map of modelId → mesh, without
 *   normals; the caller computes those.
 */
export async function loadSaved() {
  if (storeAvailable()) {
    try {
      const json = await loadSession();
      if (json) {
        const project = deserializeProject(json);
        return { project, meshes: extractMeshes(project) };
      }
    } catch (err) {
      console.warn('discarding unreadable autosave', err);
      await clearSession();
      return null;
    }
  }
  return loadLegacy();
}

function loadLegacy() {
  try {
    const json = localStorage.getItem(PROJECT_KEY);
    if (!json) return null;
    return { project: deserializeProject(json), meshes: loadLegacyMeshes() };
  } catch (err) {
    console.warn('discarding unreadable autosave', err);
    clearSaved();
    return null;
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

/** Forget the session — both where it lives now and where it used to. */
export function clearSaved() {
  localStorage.removeItem(PROJECT_KEY);
  localStorage.removeItem(MESH_KEY);
  return storeAvailable() ? clearSession() : Promise.resolve();
}

/**
 * Watch a document and persist it. Returns a stop function.
 *
 * Failures are reported once and then tolerated — losing the autosave is an
 * annoyance, but it must never break the session that is running.
 */
export function attachAutosave(doc, { onError } = {}) {
  let timer = null;
  let warned = false;
  let writing = null;

  const save = async () => {
    timer = null;
    try {
      if (storeAvailable()) {
        // One write of one file, exactly what "Save" would have produced. The
        // writes are chained rather than overlapped: two createWritable() calls
        // racing on the same file is a truncated project, and the later one is
        // the only one anybody wants anyway.
        writing = (writing ?? Promise.resolve())
          .then(() => saveSession(serializeProject(doc.project, doc.meshes)));
        await writing;
      } else {
        localStorage.setItem(PROJECT_KEY, serializeProject(doc.project));
        saveLegacyMeshes(doc);
      }
      warned = false;
    } catch (err) {
      if (!warned) { warned = true; onError?.(err); }
    }
  };

  const onChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY);
  };

  doc.addEventListener('change', onChange);
  return () => {
    doc.removeEventListener('change', onChange);
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
