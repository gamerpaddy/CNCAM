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
  const needs = 84 + triCount * 50;
  if (buffer.byteLength === needs) return true;
  // Longer than it needs, by a few bytes of padding or a trailer some exporters
  // append: still binary, unless it reads as text. Demanding the exact size
  // sent such a file to the ASCII reader, which found no "vertex" in it and
  // imported a model of no triangles as though that were a success.
  if (triCount > 0 && buffer.byteLength > needs) {
    const head = new TextDecoder('latin1').decode(new Uint8Array(buffer, 0, Math.min(1024, buffer.byteLength)));
    return !/\bfacet\b|\bvertex\b/.test(head);
  }
  return false;
}

function parseBinary(buffer) {
  const view = new DataView(buffer);
  const triCount = view.getUint32(80, true);
  const positions = new Float32Array(triCount * 9);
  let offset = 84;
  let kept = 0;
  for (let t = 0; t < triCount; t++) {
    offset += 12; // skip facet normal (recomputed later)
    let finite = true;
    for (let i = 0; i < 9; i++) {
      const value = view.getFloat32(offset, true);
      positions[kept * 9 + i] = value;
      if (!Number.isFinite(value)) finite = false;
      offset += 4;
    }
    offset += 2; // attribute byte count
    // a corner that is not a number is a model with no bounds — see io/obj.js
    if (finite) kept++;
  }
  return kept === triCount ? positions : positions.slice(0, kept * 9);
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
