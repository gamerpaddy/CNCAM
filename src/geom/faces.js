// Pickable faces: the unit a user clicks on in the viewport.
//
// A raycast hits one triangle, but nobody wants to select triangles — they want
// "that pocket floor" or "that boss top". CAD imports already carry B-rep face
// ranges from the occt worker, so those are used directly. Meshes without them
// (STL, OBJ) get faces recovered by flooding across shared edges while the
// normal holds steady, which recovers flats and gentle curves as single faces.

import { projectTriangleBand } from './silhouette.js';
import { unionLoops, bufferOpenPaths } from './clipper.js';

const DEFAULT_BREAK_ANGLE = 25; // degrees of normal change that ends a face

/**
 * Group a mesh's triangles into faces.
 * @returns { faceOfTriangle: Int32Array, faces: number[][] } triangle indices per face
 */
export function buildFaces(mesh, { breakAngleDeg = DEFAULT_BREAK_ANGLE } = {}) {
  const triCount = mesh.indices.length / 3;
  const faceOfTriangle = new Int32Array(triCount).fill(-1);
  const faces = [];

  if (mesh.faceRanges?.length) {
    // `first` and `last` are **triangle** numbers and `last` is inclusive —
    // occt-import-js's own shape, written straight through by the occt worker.
    // This used to read `range.start` and `range.count` and divide them by 3, as
    // though a range were an offset into the index array. Neither field exists,
    // so every bound came out NaN, every range matched no triangles, and the
    // "anything the ranges missed" sweep below handed back one face per
    // triangle: a picked cube face was a *triangle* of a cube face, and a STEP
    // import — the one format that knows what its faces are — picked worse than
    // an STL, whose faces the flood fill recovers correctly.
    for (const range of mesh.faceRanges) {
      const tris = [];
      const start = Math.max(0, Math.floor(range.first));
      const end = Math.min(triCount - 1, Math.floor(range.last));
      for (let t = start; t <= end; t++) {
        if (faceOfTriangle[t] !== -1) continue;
        faceOfTriangle[t] = faces.length;
        tris.push(t);
      }
      if (tris.length) faces.push(tris);
    }
    // anything the ranges missed still needs to be pickable
    for (let t = 0; t < triCount; t++) {
      if (faceOfTriangle[t] === -1) { faceOfTriangle[t] = faces.length; faces.push([t]); }
    }
    return { faceOfTriangle, faces };
  }

  const normals = triangleNormals(mesh);
  const adjacency = buildAdjacency(mesh, triCount);
  const cosBreak = Math.cos((breakAngleDeg * Math.PI) / 180);

  for (let seed = 0; seed < triCount; seed++) {
    if (faceOfTriangle[seed] !== -1) continue;
    const id = faces.length;
    const tris = [];
    const stack = [seed];
    faceOfTriangle[seed] = id;

    while (stack.length) {
      const t = stack.pop();
      tris.push(t);
      for (const n of adjacency[t] ?? []) {
        if (faceOfTriangle[n] !== -1) continue;
        const dot = normals[t * 3] * normals[n * 3]
          + normals[t * 3 + 1] * normals[n * 3 + 1]
          + normals[t * 3 + 2] * normals[n * 3 + 2];
        if (dot < cosBreak) continue;
        faceOfTriangle[n] = id;
        stack.push(n);
      }
    }
    faces.push(tris);
  }
  return { faceOfTriangle, faces };
}

/**
 * The mesh's pickable *edges*: the creases between two faces.
 *
 * A face is what you point at to say "this surface"; an edge is what you point
 * at to say "break this corner", and a chamfer is about the second. Picking the
 * face and inferring its boundary works — it is what chamfer does — but it
 * chamfers the whole boundary, and a part usually wants three of its twelve
 * edges broken and not the other nine.
 *
 * An edge here is one continuous crease between the *same pair of faces*: walk
 * every triangle pair whose two triangles belong to different faces, take the
 * edge they share, and join those segments up where they meet at a vertex. That
 * gives the loop round a boss top as one edge and each side of a slot as its
 * own, which is the granularity a click means.
 *
 * @returns { edges, edgeOfSegment } — `edges[i].segments` is a list of
 *   [vertexA, vertexB]; `edgeOfSegment` maps an "a_b" vertex key to its edge id
 */
export function buildEdges(mesh, faces, faceOfTriangle) {
  const { indices } = mesh;
  const triCount = indices.length / 3;
  const byEdge = new Map();
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e];
      const b = indices[t * 3 + ((e + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const found = byEdge.get(key);
      if (found === undefined) byEdge.set(key, { a: Math.min(a, b), b: Math.max(a, b), tris: [t] });
      else found.tris.push(t);
    }
  }

  // the creases: a shared edge whose two triangles are in different faces, and
  // a boundary edge with only one triangle (an open mesh, or the rim of a sheet)
  const creases = [];
  for (const seg of byEdge.values()) {
    const [t0, t1] = seg.tris;
    const f0 = faceOfTriangle[t0];
    const f1 = t1 === undefined ? -1 : faceOfTriangle[t1];
    if (t1 !== undefined && f0 === f1) continue;
    creases.push({ ...seg, pair: f1 < 0 ? `${f0}_open` : `${Math.min(f0, f1)}_${Math.max(f0, f1)}` });
  }

  // join creases into chains: same face pair, and meeting at a vertex. Union by
  // vertex within a pair, which is what makes the rim of a boss one edge rather
  // than thirty-two.
  const groupOf = new Map();       // `${pair}@${vertex}` -> group id
  const parent = [];
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (i, j) => { const a = find(i); const b = find(j); if (a !== b) parent[b] = a; };
  creases.forEach((seg, i) => {
    parent[i] = i;
    for (const v of [seg.a, seg.b]) {
      const key = `${seg.pair}@${v}`;
      const other = groupOf.get(key);
      if (other === undefined) groupOf.set(key, i);
      else union(other, i);
    }
  });

  const byRoot = new Map();
  creases.forEach((seg, i) => {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(seg);
  });

  const edges = [];
  const edgeOfSegment = new Map();
  for (const segs of byRoot.values()) {
    const id = edges.length;
    edges.push({ segments: segs.map((s) => [s.a, s.b]), faces: segs[0].pair });
    for (const s of segs) edgeOfSegment.set(`${s.a}_${s.b}`, id);
  }
  return { edges, edgeOfSegment };
}

/**
 * Which edge a click on a triangle meant: the crease of that triangle nearest
 * the point that was hit.
 *
 * A raycast lands on a face, not on a line, so "the edge you clicked" is the
 * crease bounding that triangle that the hit point is closest to. Returns null
 * when the triangle has no crease on it — clicking the middle of a large flat
 * is not a way of asking for one of its distant corners.
 */
export function edgeAtPoint(mesh, edgeOfSegment, triangleIndex, point) {
  const { positions, indices } = mesh;
  let best = null;
  let bestDistance = Infinity;
  for (let e = 0; e < 3; e++) {
    const a = indices[triangleIndex * 3 + e];
    const b = indices[triangleIndex * 3 + ((e + 1) % 3)];
    const key = `${Math.min(a, b)}_${Math.max(a, b)}`;
    const id = edgeOfSegment.get(key);
    if (id === undefined) continue;
    const d = pointToSegment(point, positions, a * 3, b * 3);
    if (d < bestDistance) { bestDistance = d; best = id; }
  }
  return best;
}

function pointToSegment([px, py, pz], positions, a, b) {
  const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
  const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = dx * dx + dy * dy + dz * dz;
  const t = len > 0
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len))
    : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t), pz - (az + dz * t));
}

/**
 * The XY band a picked edge stands for, as closed loops in setup space.
 *
 * The segments are joined end to end first, so a crease that runs round a boss
 * comes out as one polyline rather than thirty-two two-point ones — otherwise
 * the round ends of the band show up as scallops along a straight edge.
 *
 * @param halfWidth how wide either side of the line the region reaches. It has
 *   to cover the tool centre's standoff from the edge, which is the operation's
 *   business, so the caller passes it.
 */
export function edgeFootprint(mesh, edges, edgeIds, halfWidth) {
  const paths = [];
  for (const id of edgeIds) {
    const edge = edges[id];
    if (!edge) continue;
    for (const chain of chainSegments(edge.segments)) {
      const flat = [];
      for (const v of chain) flat.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1]);
      if (flat.length >= 4) paths.push(flat);
    }
  }
  return paths.length ? bufferOpenPaths(paths, halfWidth) : [];
}

/**
 * The picked edges as what they actually are: polylines in space.
 *
 * `edgeFootprint` flattens them into an XY band, which is all a *filter* needs —
 * and it is the reason a chamfer on a sloped edge came out in the wrong place,
 * or nowhere at all. A band says where the edge is in plan and nothing about how
 * far down it is, so the pass fell back to slicing the part at one Z: on an edge
 * that spirals down a bore, that plane crosses it at a single point and the
 * operation reported that it had nothing to cut. The height is not a detail of
 * the edge, it is half of it.
 *
 * @returns [[x, y, z, x, y, z, …]] in the coordinates of the mesh passed in
 */
export function edgePolylines(mesh, edges, edgeIds) {
  const out = [];
  for (const id of edgeIds) {
    const edge = edges[id];
    if (!edge) continue;
    for (const chain of chainSegments(edge.segments)) {
      const flat = [];
      for (const v of chain) {
        flat.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      }
      if (flat.length >= 6) out.push(flat);
    }
  }
  return out;
}

/** Join [a, b] segments into runs of vertices, following shared endpoints. */
function chainSegments(segments) {
  const neighbours = new Map();
  const add = (v, w) => {
    if (!neighbours.has(v)) neighbours.set(v, []);
    neighbours.get(v).push(w);
  };
  for (const [a, b] of segments) { add(a, b); add(b, a); }

  const used = new Set();
  const key = (a, b) => `${Math.min(a, b)}_${Math.max(a, b)}`;
  const chains = [];
  // start from an end (one neighbour) where there is one, so an open crease is
  // walked from its end rather than from the middle; closed rims start anywhere
  const starts = [...neighbours.keys()].sort(
    (v, w) => neighbours.get(v).length - neighbours.get(w).length,
  );
  for (const start of starts) {
    for (const first of neighbours.get(start)) {
      if (used.has(key(start, first))) continue;
      const chain = [start];
      let prev = start;
      let at = first;
      for (;;) {
        used.add(key(prev, at));
        chain.push(at);
        const next = (neighbours.get(at) ?? []).find((v) => !used.has(key(at, v)));
        if (next === undefined) break;
        prev = at;
        at = next;
      }
      chains.push(chain);
    }
  }
  return chains;
}

function triangleNormals(mesh) {
  const { positions, indices } = mesh;
  const out = new Float32Array(indices.length);
  for (let t = 0; t < indices.length / 3; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const l = Math.hypot(nx, ny, nz) || 1;
    out[t * 3] = nx / l; out[t * 3 + 1] = ny / l; out[t * 3 + 2] = nz / l;
  }
  return out;
}

function buildAdjacency(mesh, triCount) {
  const byEdge = new Map();
  const adjacency = Array.from({ length: triCount }, () => []);
  const { indices } = mesh;
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e];
      const b = indices[t * 3 + ((e + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const other = byEdge.get(key);
      if (other === undefined) byEdge.set(key, t);
      else { adjacency[t].push(other); adjacency[other].push(t); }
    }
  }
  return adjacency;
}

/**
 * Steeper than this and a face is a wall rather than a floor.
 *
 * The number is |nz| of the face normal, so it is the cosine of the tilt from
 * horizontal: 0.25 is 75.5°. A 45° chamfer face is a floor — the cutter can run
 * over it — and anything approaching vertical is not.
 */
const WALL_COS = 0.25;

/**
 * XY footprint of the given faces, as closed loops in setup space.
 * This is the shape a strategy's include/avoid filter works against.
 *
 * **A wall casts no shadow.** Its projection is a line, so the honest area of a
 * picked vertical face is zero — and that is what came back: picking the riser
 * of a step, or the walls of a pocket, produced no loops at all. `avoid` then
 * kept the cutter out of nowhere, and `include` was worse than useless, because
 * an empty include list read downstream as "no restriction" and machined the
 * whole part (see engine/regions.js). Both silently. On `clamp1.stl` the five
 * vertical faces of fourteen resolved to nothing, and a sixth — near-vertical —
 * to 2mm² of hairline sliver that the tool-radius offset then wiped out.
 *
 * So a wall is given the width it is machined at instead: `wallBand` either
 * side of the line it projects to. The caller sizes that, because it depends on
 * what the region *means* — a wall you are machining is reached by a cutter
 * whose centre stands off it, and a wall you are avoiding is one the cutter must
 * stay clear of. See app/regions-ui.js.
 *
 * @param options.wallBand half-width for near-vertical triangles; 0 keeps the
 *   old area-only behaviour, which is what a caller measuring a *shadow* wants
 */
export function faceFootprint(mesh, faces, faceIds, { wallBand = 0 } = {}) {
  const { positions, indices } = mesh;
  const loops = [];
  const walls = [];
  for (const id of faceIds) {
    for (const t of faces[id] ?? []) {
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
      const tri = [
        [positions[a], positions[a + 1], positions[a + 2]],
        [positions[b], positions[b + 1], positions[b + 2]],
        [positions[c], positions[c + 1], positions[c + 2]],
      ];
      // The geometric normal, not the mesh's: a smoothed vertex normal says
      // what the surface looks like, and this question is about what the
      // triangle covers.
      if (wallBand > 0 && Math.abs(triangleCosZ(tri)) < WALL_COS) {
        walls.push(longestProjectedSpan(tri));
        continue;
      }
      const loop = projectTriangleBand(tri, -Infinity, Infinity);
      if (loop) loops.push(loop);
    }
  }
  if (walls.length) loops.push(...bufferOpenPaths(walls, wallBand));
  return loops.length ? unionLoops(loops) : [];
}

/** |nz| of a triangle's own normal — 1 flat, 0 vertical. */
function triangleCosZ([p, q, s]) {
  const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
  const vx = s[0] - p[0], vy = s[1] - p[1], vz = s[2] - p[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return len > 0 ? nz / len : 0;
}

/**
 * The line a wall triangle projects to: its two projected corners furthest
 * apart. The third lies on that line to within the sliver's own width, which is
 * what being a wall means.
 */
function longestProjectedSpan([p, q, s]) {
  const flat = [[p[0], p[1]], [q[0], q[1]], [s[0], s[1]]];
  let best = [0, 1];
  let far = -1;
  for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
    const d = Math.hypot(flat[i][0] - flat[j][0], flat[i][1] - flat[j][1]);
    if (d > far) { far = d; best = [i, j]; }
  }
  return [flat[best[0]][0], flat[best[0]][1], flat[best[1]][0], flat[best[1]][1]];
}
