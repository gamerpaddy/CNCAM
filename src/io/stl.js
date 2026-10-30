// STL parser (binary + ASCII) → triangle soup Float32Array (9 floats per triangle).
// In-house rather than three.js STLLoader so the compute core stays UI-agnostic.

export function parseSTL(buffer) {
  if (isBinary(buffer)) return parseBinary(buffer);
  const short = truncatedBinary(buffer);
  if (short) {
    throw new Error(`binary STL is cut short: its header promises ${short.promised} triangles `
      + `and the file holds ${short.held} — download or export it again`);
  }
  return parseAscii(buffer);
}

/**
 * A binary STL whose header promises more triangles than the file has bytes for.
 *
 * It is not ASCII (nothing in it reads as `facet` or `vertex`), so the text
 * reader found no triangles and the import said "has no triangles in it" — about
 * a file that has thousands. A part with its tail missing is also not one to
 * machine from whatever came in: the open end is a hole in the model, and the
 * stock, the roughing and the finish would all be planned round it.
 */
function truncatedBinary(buffer) {
  if (buffer.byteLength < 84) return null;
  const promised = new DataView(buffer).getUint32(80, true);
  const held = Math.floor((buffer.byteLength - 84) / 50);
  if (promised <= held) return null;
  const head = new TextDecoder('latin1').decode(new Uint8Array(buffer, 0, Math.min(1024, buffer.byteLength)));
  if (/\bfacet\b|\bvertex\b/.test(head)) return null;
  return { promised, held };
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
  // The three words after `vertex` are taken as they are and read as numbers
  // afterwards, rather than matched against what a number looks like. The
  // pattern used here only knew digits, so a corner an exporter wrote as `nan`
  // or `inf` was not seen at all — one vertex short, a facet that no longer
  // lined up with the next, and the whole import refused for the want of three
  // letters. A facet with a corner that is not a number is dropped, as the
  // binary reader does (see io/obj.js for why a NaN cannot be let through).
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  const corners = [];
  let m;
  while ((m = re.exec(text)) !== null) corners.push(Number(m[1]), Number(m[2]), Number(m[3]));
  if (corners.length % 9 !== 0) {
    throw new Error(`ASCII STL: ${corners.length / 3} vertices is not a whole number of triangles`
      + ' — the file looks cut short');
  }
  // converted first, so a value too big for a float (1e39) is as much an
  // infinity as one written that way
  const all = new Float32Array(corners);
  const positions = new Float32Array(all.length);
  let kept = 0;
  for (let t = 0; t < all.length; t += 9) {
    let finite = true;
    for (let i = 0; i < 9; i++) if (!Number.isFinite(all[t + i])) finite = false;
    if (!finite) continue;
    positions.set(all.subarray(t, t + 9), kept * 9);
    kept++;
  }
  return kept * 9 === all.length ? positions : positions.slice(0, kept * 9);
}
