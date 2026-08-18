// Making a mesh look like a part instead of like a balloon.
//
// `computeNormals` averages every face normal that meets at a vertex, without
// asking whether those faces are meant to be one smooth surface. On a welded
// STL that is every vertex, so the corner of a block gets the average of three
// perpendicular faces and shades as a soft bulge. A part drawn that way has no
// edges at all: you cannot see where a pocket begins, whether a face is flat,
// or which of two nearly-parallel surfaces you are looking at.
//
// A machinist reads a part by its edges. So two things live here, both purely
// for display and neither used by any strategy:
//
//   * crease normals — faces are averaged together only when the angle between
//     them is gentle enough to be one surface. A cylinder stays smooth, a block
//     gets its corners back, and a fillet still blends into what it joins.
//   * crease edges — the lines themselves, as segments to draw over the shading.
//     Shading tells you a corner is there; a drawn line tells you exactly where.
//
// Both are headless: no three.js, no DOM.

/** Faces meeting at less than this are one surface; more, and it is an edge. */
export const DEFAULT_CREASE_DEG = 35;

/**
 * Per-corner normals with hard edges preserved, as non-indexed geometry.
 *
 * Non-indexed because a crease *is* two different normals at the same point,
 * which an indexed mesh has no way to hold. Three times the vertex data, for
 * display only.
 *
 * The averaging is weighted by the angle the face subtends at the vertex, not
 * by face area or by count — that is what stops a fan of twenty slivers on one
 * side of a vertex from outvoting the one big face on the other.
 *
 * @returns { positions, normals } — 9 floats per triangle, in triangle order
 */
export function creaseNormals(mesh, { creaseDeg = DEFAULT_CREASE_DEG } = {}) {
  const { positions, indices } = mesh;
  const triangles = indices.length / 3;
  const faceNormals = new Float32Array(triangles * 3);
  const faceAreas = new Float32Array(triangles);

  for (let f = 0; f < triangles; f++) {
    const a = indices[f * 3] * 3;
    const b = indices[f * 3 + 1] * 3;
    const c = indices[f * 3 + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz);
    faceAreas[f] = len / 2;
    const inv = len > 0 ? 1 / len : 0;
    faceNormals[f * 3] = nx * inv;
    faceNormals[f * 3 + 1] = ny * inv;
    faceNormals[f * 3 + 2] = nz * inv;
  }

  const incident = facesByVertex(indices, positions.length / 3);
  const cosLimit = Math.cos((creaseDeg * Math.PI) / 180);

  const out = new Float32Array(triangles * 9);
  const outNormals = new Float32Array(triangles * 9);
  for (let f = 0; f < triangles; f++) {
    const fx = faceNormals[f * 3];
    const fy = faceNormals[f * 3 + 1];
    const fz = faceNormals[f * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const v = indices[f * 3 + k];
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (const g of incident[v]) {
        const gx = faceNormals[g * 3];
        const gy = faceNormals[g * 3 + 1];
        const gz = faceNormals[g * 3 + 2];
        // only faces this one could be part of the same surface as
        if (gx * fx + gy * fy + gz * fz < cosLimit) continue;
        const w = cornerAngle(positions, indices, g, v) * faceAreas[g];
        nx += gx * w; ny += gy * w; nz += gz * w;
      }
      const len = Math.hypot(nx, ny, nz);
      const inv = len > 1e-20 ? 1 / len : 0;
      const at = (f * 3 + k) * 3;
      out[at] = positions[v * 3];
      out[at + 1] = positions[v * 3 + 1];
      out[at + 2] = positions[v * 3 + 2];
      // a vertex whose neighbours all disagree keeps its own face normal
      outNormals[at] = inv ? nx * inv : fx;
      outNormals[at + 1] = inv ? ny * inv : fy;
      outNormals[at + 2] = inv ? nz * inv : fz;
    }
  }
  return { positions: out, normals: outNormals };
}

/**
 * The edges worth drawing: where two faces meet at more than the crease angle,
 * and where the mesh simply stops.
 *
 * A boundary edge is included because an open mesh — which most STL exports of
 * a machined part turn out to be somewhere — has holes whose rims are exactly
 * the feature you need to see.
 *
 * @returns Float32Array of 6 floats per segment
 */
export function creaseEdges(mesh, { creaseDeg = DEFAULT_CREASE_DEG } = {}) {
  const { positions, indices } = mesh;
  const triangles = indices.length / 3;
  const cosLimit = Math.cos((creaseDeg * Math.PI) / 180);

  // edge key -> { a, b, normals: [[x,y,z], …] }
  const edges = new Map();
  const normalOf = (f) => {
    const a = indices[f * 3] * 3;
    const b = indices[f * 3 + 1] * 3;
    const c = indices[f * 3 + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz) || 1;
    return [nx / len, ny / len, nz / len];
  };

  for (let f = 0; f < triangles; f++) {
    const n = normalOf(f);
    for (let k = 0; k < 3; k++) {
      const v0 = indices[f * 3 + k];
      const v1 = indices[f * 3 + ((k + 1) % 3)];
      const lo = Math.min(v0, v1);
      const hi = Math.max(v0, v1);
      const key = lo * 4294967296 + hi;   // two 32-bit indices in one number
      const found = edges.get(key);
      if (found) found.normals.push(n);
      else edges.set(key, { a: lo, b: hi, normals: [n] });
    }
  }

  const segments = [];
  for (const { a, b, normals } of edges.values()) {
    const hard = normals.length === 1       // a boundary: nothing on the far side
      || normals.length > 2                 // non-manifold; worth seeing
      || normals[0][0] * normals[1][0] + normals[0][1] * normals[1][1]
        + normals[0][2] * normals[1][2] < cosLimit;
    if (!hard) continue;
    segments.push(
      positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2],
      positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2],
    );
  }
  return Float32Array.from(segments);
}

/** For each vertex, the triangles that touch it. */
function facesByVertex(indices, vertexCount) {
  const lists = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) lists[i] = [];
  for (let f = 0; f < indices.length / 3; f++) {
    lists[indices[f * 3]].push(f);
    lists[indices[f * 3 + 1]].push(f);
    lists[indices[f * 3 + 2]].push(f);
  }
  return lists;
}

/** The angle triangle `f` subtends at vertex `v`, in radians. */
function cornerAngle(positions, indices, f, v) {
  const ids = [indices[f * 3], indices[f * 3 + 1], indices[f * 3 + 2]];
  const at = ids.indexOf(v);
  if (at < 0) return 0;
  const o = ids[at] * 3;
  const p = ids[(at + 1) % 3] * 3;
  const q = ids[(at + 2) % 3] * 3;
  const ux = positions[p] - positions[o];
  const uy = positions[p + 1] - positions[o + 1];
  const uz = positions[p + 2] - positions[o + 2];
  const vx = positions[q] - positions[o];
  const vy = positions[q + 1] - positions[o + 1];
  const vz = positions[q + 2] - positions[o + 2];
  const lu = Math.hypot(ux, uy, uz);
  const lv = Math.hypot(vx, vy, vz);
  if (lu < 1e-20 || lv < 1e-20) return 0;
  const cos = (ux * vx + uy * vy + uz * vz) / (lu * lv);
  return Math.acos(Math.min(1, Math.max(-1, cos)));
}
