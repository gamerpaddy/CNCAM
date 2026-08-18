// STL parser (binary + ASCII) → triangle soup Float32Array (9 floats per triangle).
// In-house rather than three.js STLLoader so the compute core stays UI-agnostic.

export function parseSTL(buffer) {
  return isBinary(buffer) ? parseBinary(buffer) : parseAscii(buffer);
}

function isBinary(buffer) {
  if (buffer.byteLength < 84) return false;
  const view = new DataView(buffer);
  const triCount = view.getUint32(80, true);
  // A well-formed binary STL has exactly this size; ASCII files starting with
  // "solid" will not match. Size check beats sniffing the "solid" keyword,
  // because some binary exporters also write "solid" into the header.
  return buffer.byteLength === 84 + triCount * 50;
}

function parseBinary(buffer) {
  const view = new DataView(buffer);
  const triCount = view.getUint32(80, true);
  const positions = new Float32Array(triCount * 9);
  let offset = 84;
  for (let t = 0; t < triCount; t++) {
    offset += 12; // skip facet normal (recomputed later)
    for (let i = 0; i < 9; i++) {
      positions[t * 9 + i] = view.getFloat32(offset, true);
      offset += 4;
    }
    offset += 2; // attribute byte count
  }
  return positions;
}

function parseAscii(buffer) {
  const text = new TextDecoder().decode(buffer);
  const positions = [];
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    positions.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
  }
  if (positions.length % 9 !== 0) {
    throw new Error(`ASCII STL: vertex count ${positions.length / 3} is not a multiple of 3`);
  }
  return new Float32Array(positions);
}
