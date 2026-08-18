// Autosave to localStorage, so a reload does not cost you an afternoon of setup.
//
// Tools, setups, operations and their parameters are small and pure JSON, so
// they round-trip through the existing project schema. Meshes do not: a real
// import is megabytes of typed array, well past what localStorage will hold. So
// geometry is stored separately and only when it fits, and the project restores
// with its machining intent intact whether or not the models came back.
//
// Saves are debounced — every keystroke in a number field is a document change,
// and serialising the project on each one would be silly.

import { serializeProject, deserializeProject } from './schema.js';
import { encodeMesh, decodeMesh, meshCost } from './mesh-codec.js';

const PROJECT_KEY = 'cncam.project';
const MESH_KEY = 'cncam.meshes';
const SAVE_DELAY = 400;
const MESH_BUDGET = 3_000_000;   // characters of base64; keeps us inside quota

export function loadSaved() {
  try {
    const json = localStorage.getItem(PROJECT_KEY);
    if (!json) return null;
    return { project: deserializeProject(json), meshes: loadMeshes() };
  } catch (err) {
    console.warn('discarding unreadable autosave', err);
    clearSaved();
    return null;
  }
}

function loadMeshes() {
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

export function clearSaved() {
  localStorage.removeItem(PROJECT_KEY);
  localStorage.removeItem(MESH_KEY);
}

/**
 * Watch a document and persist it. Returns a stop function.
 * Quota failures are reported once and then tolerated — losing the autosave is
 * an annoyance, but it must never break the session that is running.
 */
export function attachAutosave(doc, { onError } = {}) {
  let timer = null;
  let warned = false;

  const save = () => {
    timer = null;
    try {
      localStorage.setItem(PROJECT_KEY, serializeProject(doc.project));
      saveMeshes(doc);
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
function saveMeshes(doc) {
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
