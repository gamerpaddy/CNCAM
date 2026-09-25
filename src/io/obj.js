// Minimal OBJ parser → triangle soup Float32Array (9 floats per triangle).
// Supports v / f with polygon fan triangulation and negative indices.
// Ignores normals, texcoords, materials, groups.
//
// Faces are resolved after the whole file has been read. A positive index names
// a vertex anywhere in the file, and exporters that write their meshes group by
// group interleave `v` and `f` lines — resolving each face as it was read put
// NaN in every corner that named a vertex further down, and one NaN in the
// positions is a model with no bounds, a stock with no size and a program of
// nothing. A negative index is relative to where the face sits, so it is fixed
// at read time. A corner that names no vertex at all drops its face.
//
// Keywords are split on any whitespace, tabs included: `v\t0 0 0` is as much a
// vertex as `v 0 0 0`, and was being read as no geometry at all.

export function parseOBJ(text) {
  const verts = [];
  const faces = [];

  for (const rawLine of text.split('\n')) {
    const parts = rawLine.trim().split(/\s+/);
    const key = parts[0];
    if (key === 'v') {
      verts.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
    } else if (key === 'f') {
      const count = verts.length / 3;
      faces.push(parts.slice(1).map((r) => {
        const vi = parseInt(r.split('/')[0], 10);
        return vi < 0 ? count + vi : vi - 1;       // zero-based
      }));
    }
  }

  const count = verts.length / 3;
  const valid = (i) => Number.isInteger(i) && i >= 0 && i < count
    && Number.isFinite(verts[i * 3]) && Number.isFinite(verts[i * 3 + 1])
    && Number.isFinite(verts[i * 3 + 2]);
  const positions = [];
  for (const idx of faces) {
    if (idx.length < 3 || !idx.every(valid)) continue;
    for (let i = 1; i < idx.length - 1; i++) {
      for (const j of [idx[0], idx[i], idx[i + 1]]) {
        positions.push(verts[j * 3], verts[j * 3 + 1], verts[j * 3 + 2]);
      }
    }
  }
  return new Float32Array(positions);
}
