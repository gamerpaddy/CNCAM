// Classic (non-module) worker wrapping occt-import-js (OpenCASCADE WASM).
// Receives: { id, kind: 'step'|'iges', buffer: ArrayBuffer, linearDeflection }
// Replies:  { id, ok: true, meshes: [{ name, positions, normals, indices, faceRanges }] }
//           { id, ok: false, error }
// faceRanges preserves B-rep face grouping: [{ first, last, faceId }] over triangle indices.

let occtPromise = null;

function getOcct() {
  if (!occtPromise) {
    importScripts('../../vendor/occt/occt-import-js.js');
    occtPromise = occtimportjs({
      locateFile: (file) => '../../vendor/occt/' + file,
    });
  }
  return occtPromise;
}

self.onmessage = async (e) => {
  const { id, kind, buffer, linearDeflection } = e.data;
  try {
    const occt = await getOcct();
    const params = {
      linearUnit: 'millimeter',
      linearDeflectionType: 'absolute_value',
      linearDeflection: linearDeflection ?? 0.05,
      angularDeflection: 0.5,
    };
    const data = new Uint8Array(buffer);
    const result = kind === 'iges'
      ? occt.ReadIgesFile(data, params)
      : occt.ReadStepFile(data, params);

    if (!result.success) throw new Error('occt could not read the file');

    const meshes = [];
    const transfers = [];
    for (const m of result.meshes) {
      const positions = new Float32Array(m.attributes.position.array);
      const normals = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
      const indices = new Uint32Array(m.index.array);
      const faceRanges = (m.brep_faces || []).map((f, i) => ({
        first: f.first, last: f.last, faceId: i,
      }));
      meshes.push({ name: m.name || 'part', positions, normals, indices, faceRanges });
      transfers.push(positions.buffer, indices.buffer);
      if (normals) transfers.push(normals.buffer);
    }
    self.postMessage({ id, ok: true, meshes }, transfers);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
