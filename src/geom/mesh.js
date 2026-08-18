// Triangle mesh utilities. A Mesh is a plain object:
//   { positions: Float32Array (xyz per vertex), indices: Uint32Array, normals?: Float32Array }
// Parsers produce triangle soup (positions only); weld() turns soup into an indexed mesh.

/** Weld duplicate vertices in a triangle soup by quantizing to `tol`. */
export function weld(soupPositions, tol = 1e-5) {
  const triCount = soupPositions.length / 9;
  const inv = 1 / tol;
  const map = new Map();
  const positions = [];
  const indices = new Uint32Array(triCount * 3);
  let next = 0;

  for (let i = 0; i < triCount * 3; i++) {
    const x = soupPositions[i * 3];
    const y = soupPositions[i * 3 + 1];
    const z = soupPositions[i * 3 + 2];
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = next++;
      map.set(key, idx);
      positions.push(x, y, z);
    }
    indices[i] = idx;
  }
  return { positions: new Float32Array(positions), indices };
}

/** Remove triangles that are degenerate after welding (repeated vertex indices). */
export function dropDegenerate(mesh) {
  const { indices } = mesh;
  const kept = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    if (a !== b && b !== c && a !== c) kept.push(a, b, c);
  }
  return { ...mesh, indices: new Uint32Array(kept) };
}

/** Area-weighted vertex normals. */
export function computeNormals(mesh) {
  const { positions, indices } = mesh;
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const v of [a, b, c]) {
      normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
  }
  return { ...mesh, normals };
}

/** Axis-aligned bounds: { min: [x,y,z], max: [x,y,z] }. */
export function computeBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/**
 * Every height at which the part has a horizontal face, with how much of one
 * there is.
 *
 * A depth level is a plane the cutter clears down to, and the planes are shared
 * out evenly between the top and the bottom of the cut. That is the right thing
 * to do with the *depth* and it takes no notice of the part: a pocket floor
 * 2mm below one level and 3mm above the next is cleared to the level above it
 * and then walled off — the pass below cannot reach in, because at that depth
 * the floor is solid part. So 2mm of stock stands on a finished floor and no
 * pass in the operation will ever take it off. See engine/stock.js depthPasses,
 * which is where these are folded into the levels.
 *
 * Only *horizontal* faces count, and that is what keeps a curved part from
 * producing a level per triangle: a tessellated dome has no horizontal facets
 * except at its pole. The area is returned with each height because a 0.2mm²
 * sliver where two surfaces meet is a tessellation artefact and not a floor.
 *
 * Which way a face points is deliberately *not* asked. It would be one line —
 * the sign of the triangle's cross product — and it would be a line that trusts
 * the winding, which nothing else here does: a mesh may arrive from an STL, an
 * OBJ, a CAD kernel or a hand-built fixture, and it may have passed through a
 * setup orientation whose matrix mirrors it, which inverts every triangle. A
 * missed floor is the bug this exists to fix; the cost of the other mistake is
 * a level at the underside of an overhang, which is a plane where the part's
 * shadow changes and so is a reasonable place to put a pass anyway.
 *
 * @param options.tolerance how flat counts as flat, in mm across the triangle
 * @returns [{ z, area }] highest first
 */
export function flatLevels(mesh, { tolerance = 0.002 } = {}) {
  const { positions, indices } = mesh;
  const byZ = new Map();          // z rounded to a micron -> area
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const az = positions[a + 2], bz = positions[b + 2], cz = positions[c + 2];
    if (Math.max(az, bz, cz) - Math.min(az, bz, cz) > tolerance) continue;
    // area of the triangle seen from above, which for a horizontal one is its
    // area: half the Z of (b-a) x (c-a)
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1];
    const area = Math.abs(ux * vy - uy * vx) / 2;
    if (!(area > 0)) continue;
    const z = (az + bz + cz) / 3;
    const key = Math.round(z * 1000);
    byZ.set(key, (byZ.get(key) ?? 0) + area);
  }
  return [...byZ.entries()]
    .map(([key, area]) => ({ z: key / 1000, area }))
    .sort((p, q) => q.z - p.z);
}

/** Merge indexed meshes into one (for multi-model setups feeding one strategy). */
export function mergeMeshes(meshes) {
  if (meshes.length === 1) return meshes[0];
  let vertexCount = 0, indexCount = 0;
  for (const m of meshes) { vertexCount += m.positions.length; indexCount += m.indices.length; }
  const positions = new Float32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  let vo = 0, io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo);
    const base = vo / 3;
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + base;
    vo += m.positions.length;
    io += m.indices.length;
  }
  return { positions, indices };
}

/** Triangle soup → clean indexed mesh with normals. */
export function meshFromSoup(soupPositions, tol = 1e-5) {
  return computeNormals(dropDegenerate(weld(soupPositions, tol)));
}
