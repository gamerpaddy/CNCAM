// Z-plane slicing: mesh × (z = const) → closed 2D loops.
// Segments are oriented by the triangle normal (t = n × ẑ), so on a mesh with
// consistent outward winding, outer loops come out CCW and holes CW — which is
// what clipper.js's non-zero fill expects. Loops are in CNCAM flat format
// [x0, y0, x1, y1, ...], implicitly closed.

const QUANT = 1e-3; // endpoint stitch tolerance (mm)

export function sliceMeshZ(mesh, z) {
  const { positions, indices } = mesh;
  const segments = [];

  for (let t = 0; t < indices.length; t += 3) {
    const pts = [];
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e] * 3;
      const b = indices[t + ((e + 1) % 3)] * 3;
      const za = positions[a + 2], zb = positions[b + 2];
      if ((za < z) === (zb < z)) continue; // edge doesn't cross the plane
      const f = (z - za) / (zb - za);
      pts.push([
        positions[a] + (positions[b] - positions[a]) * f,
        positions[a + 1] + (positions[b + 1] - positions[a + 1]) * f,
      ]);
    }
    if (pts.length !== 2) continue;

    // orient the segment along t = n_tri × ẑ = (ny, -nx)
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1], abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const dx = pts[1][0] - pts[0][0], dy = pts[1][1] - pts[0][1];
    if (dx * ny - dy * nx < 0) pts.reverse();
    segments.push(pts);
  }
  return stitch(segments);
}

function key(p) {
  return `${Math.round(p[0] / QUANT)},${Math.round(p[1] / QUANT)}`;
}

/**
 * Chain segments into closed loops by endpoint matching. Prefers following
 * segment direction (keeps orientation); falls back to reversed segments so
 * meshes with imperfect winding still stitch. Open chains are dropped.
 */
function stitch(segments) {
  const adjacency = new Map(); // endpoint key -> [{ seg, end }]
  const link = (p, seg, end) => {
    const k = key(p);
    if (!adjacency.has(k)) adjacency.set(k, []);
    adjacency.get(k).push({ seg, end });
  };
  for (const seg of segments) {
    link(seg[0], seg, 0);
    link(seg[1], seg, 1);
  }

  const used = new Set();
  const loops = [];

  for (const seed of segments) {
    if (used.has(seed)) continue;
    used.add(seed);
    const loop = [seed[0]];
    let tip = seed[1];
    const startKey = key(seed[0]);

    while (key(tip) !== startKey) {
      const candidates = (adjacency.get(key(tip)) ?? []).filter((c) => !used.has(c.seg));
      // prefer a segment that starts here (forward direction)
      const next = candidates.find((c) => c.end === 0) ?? candidates[0];
      if (!next) break; // open chain — drop
      used.add(next.seg);
      loop.push(tip);
      tip = next.seg[1 - next.end];
    }

    if (loop.length >= 3 && key(tip) === startKey) {
      const flat = new Array(loop.length * 2);
      for (let i = 0; i < loop.length; i++) {
        flat[i * 2] = loop[i][0];
        flat[i * 2 + 1] = loop[i][1];
      }
      loops.push(flat);
    }
  }
  return loops;
}
