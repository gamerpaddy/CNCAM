// STEP/IGES import via the occt worker. Lazily spawns one worker and reuses it
// (the WASM module load is the expensive part).

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../workers/occt-worker.js', import.meta.url));
    worker.onmessage = (e) => {
      const { id, ok, meshes, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(meshes);
      else p.reject(new Error(error));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'occt worker failed'));
      pending.clear();
    };
  }
  return worker;
}

/**
 * @param {ArrayBuffer} buffer file contents
 * @param {'step'|'iges'} kind
 * @param {number} [linearDeflection] tessellation tolerance in mm
 * @returns {Promise<Array<{name, positions, normals, indices, faceRanges}>>}
 */
export function importCad(buffer, kind, linearDeflection) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, kind, buffer, linearDeflection }, [buffer]);
  });
}

export function kindFromName(name) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'step' || ext === 'stp') return 'step';
  if (ext === 'iges' || ext === 'igs') return 'iges';
  return null;
}
