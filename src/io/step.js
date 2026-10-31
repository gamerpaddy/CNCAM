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
      else p.reject(new Error(describeCadError(error, p.kind)));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) {
        p.reject(new Error(describeCadError(e.message || 'the CAD reader stopped', p.kind)));
      }
      pending.clear();
      // A WebAssembly module that has aborted stays aborted: the next file went
      // to the same dead worker and waited for ever with no word. Start over.
      worker.terminate();
      worker = null;
    };
  }
  return worker;
}

/**
 * What a failure of the STEP/IGES reader says, in words a person can act on.
 *
 * The reader is C++ in WebAssembly, and a bad file comes back as a bare number
 * (a thrown C++ exception is a pointer), as nothing, or as "could not read the
 * file" — "Import failed: 5263928" is not something anyone can do anything
 * about. The reader's own words are kept when it has some.
 */
export function describeCadError(error, kind = 'step') {
  const name = kind === 'iges' ? 'IGES' : 'STEP';
  const text = String(error ?? '').trim();
  if (!text || /^-?\d+$/.test(text) || /^occt could not read/i.test(text)) {
    return `the ${name} reader could not make sense of this file`
      + (text && !/^occt/i.test(text) ? ` (internal error ${text})` : '')
      + ` — it may be damaged, not really ${name === 'IGES' ? 'an' : 'a'} ${name} file, or use geometry the reader does not support. `
      + 'Export it again from the CAD package (AP203 or AP214 for STEP), or as STL';
  }
  if (/memory|allocate|abort/i.test(text)) {
    return `the ${name} file is too big for the reader to hold (${text}) — export a simpler version of the `
      + 'model, or as STL';
  }
  return text;
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
    pending.set(id, { resolve, reject, kind });
    getWorker().postMessage({ id, kind, buffer, linearDeflection }, [buffer]);
  });
}

export function kindFromName(name) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'step' || ext === 'stp') return 'step';
  if (ext === 'iges' || ext === 'igs') return 'iges';
  return null;
}
