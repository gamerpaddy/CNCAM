// Minimal OBJ parser → triangle soup Float32Array (9 floats per triangle).
// Supports v / f with polygon fan triangulation and negative indices.
// Ignores normals, texcoords, materials, groups.

export function parseOBJ(text) {
  const verts = [];
  const positions = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('v ')) {
      const p = line.slice(2).trim().split(/\s+/);
      verts.push(parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2]));
    } else if (line.startsWith('f ')) {
      const refs = line.slice(2).trim().split(/\s+/);
      const idx = refs.map((r) => {
        let vi = parseInt(r.split('/')[0], 10);
        if (vi < 0) vi = verts.length / 3 + vi + 1;
        return (vi - 1) * 3;
      });
      for (let i = 1; i < idx.length - 1; i++) {
        for (const j of [idx[0], idx[i], idx[i + 1]]) {
          positions.push(verts[j], verts[j + 1], verts[j + 2]);
        }
      }
    }
  }
  return new Float32Array(positions);
}
