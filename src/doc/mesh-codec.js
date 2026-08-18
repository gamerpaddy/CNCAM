// Typed arrays ⇄ text, so geometry can travel inside JSON.
//
// A project file that does not carry its geometry is a set of instructions for
// machining a part you have to go and find again — open it on another machine,
// or six months later, and the operations are all there pointing at nothing. So
// meshes are embedded, as base64 of the raw buffers.
//
// Normals are not stored: they are a derivative of the positions and indices,
// recomputed on load for a fraction of what they cost to carry. B-rep face
// grouping is, because nothing can recover it — it comes from the STEP file and
// is what face picking selects on.

const CHUNK = 0x8000;   // stay inside the argument limit of String.fromCharCode

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Base64 of a typed array's bytes. */
export function encodeArray(array) {
  return toBase64(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
}

export function decodeFloats(text) {
  return new Float32Array(fromBase64(text).buffer);
}

export function decodeInts(text) {
  return new Uint32Array(fromBase64(text).buffer);
}

/** Mesh → plain JSON-safe object. */
export function encodeMesh(mesh) {
  const out = {
    positions: encodeArray(mesh.positions),
    indices: encodeArray(mesh.indices),
  };
  if (mesh.faceRanges?.length) out.faceRanges = mesh.faceRanges;
  return out;
}

/**
 * Plain object → mesh. Normals are left off; the caller runs computeNormals,
 * which keeps this module free of any dependency on the geometry layer.
 */
export function decodeMesh(record) {
  if (!record?.positions || !record?.indices) return null;
  const mesh = {
    positions: decodeFloats(record.positions),
    indices: decodeInts(record.indices),
  };
  if (record.faceRanges?.length) mesh.faceRanges = record.faceRanges;
  return mesh;
}

/** Roughly how many characters a mesh costs to store — for quota decisions. */
export function meshCost(mesh) {
  return Math.ceil((mesh.positions.byteLength + mesh.indices.byteLength) * 4 / 3);
}
