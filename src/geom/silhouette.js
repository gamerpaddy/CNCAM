// Downward silhouette: the XY shadow of everything in a mesh at or above a
// given Z. This is what makes 3-axis toolpaths reachable.
//
// A slice at z tells you the part's cross-section *at* z, but a vertical cutter
// approaching from +Z is blocked by anything above it too. Under an overhang
// the slice is small while the real obstruction is large, so planning from the
// slice alone puts cuts where the tool can never get. The silhouette is that
// obstruction: union over z' >= z of the part's cross-section at z'.
//
// Computed exactly rather than by sampling slices: a solid's shadow is the
// shadow of its boundary, so clipping each triangle to the slab and projecting
// it gives the same set with no risk of stepping over a feature between
// samples. SilhouetteStack sweeps top-down and accumulates, so each triangle is
// touched only in the bands it actually spans.

import {
  unionLoops, loopArea, cleanLoops, normalizedLoops, closeLoops,
} from './clipper.js';

/** The relative step between one float32 and the next. */
const FLOAT32_EPSILON = 2 ** -23;

/**
 * Whether any edge of the mesh belongs to other than two triangles.
 *
 * A triangle mesh in which every edge is shared by exactly two triangles has no
 * T-junctions and no cracks - there is nowhere for two triangles to meet along
 * an edge each of them writes differently - and its silhouette needs no
 * healing. A mesh that fails this is one that might, and asking costs a pass
 * over the edges once per mesh.
 */
function hasOpenEdges(mesh) {
  if (openEdgesOf.has(mesh)) return openEdgesOf.get(mesh);
  const { indices } = mesh;
  const count = new Map();
  const n = mesh.positions.length / 3;
  const touch = (a, b) => {
    const key = a < b ? a * n + b : b * n + a;
    count.set(key, (count.get(key) ?? 0) + 1);
  };
  for (let t = 0; t < indices.length; t += 3) {
    touch(indices[t], indices[t + 1]);
    touch(indices[t + 1], indices[t + 2]);
    touch(indices[t + 2], indices[t]);
  }
  let open = false;
  for (const uses of count.values()) {
    if (uses !== 2) { open = true; break; }
  }
  openEdgesOf.set(mesh, open);
  return open;
}
const openEdgesOf = new WeakMap();

/**
 * Clip a triangle to the slab zLow <= z <= zHigh and project it to XY.
 * @returns flat CCW loop [x0,y0,...] or null when the result has no area
 */
export function projectTriangleBand(tri, zLow, zHigh, minArea = 0) {
  let poly = tri;
  poly = clipHalfspace(poly, zLow, true);
  if (poly.length < 3) return null;
  if (zHigh !== Infinity) {
    poly = clipHalfspace(poly, zHigh, false);
    if (poly.length < 3) return null;
  }

  const loop = new Array(poly.length * 2);
  for (let i = 0; i < poly.length; i++) {
    loop[i * 2] = poly[i][0];
    loop[i * 2 + 1] = poly[i][1];
  }
  const area = loopArea(loop);
  // A vertical wall casts no shadow — its projection is a line. Real meshes are
  // full of near-vertical triangles whose projections are hairline slivers with
  // no useful area, and keeping them buries the union in junk loops.
  if (Math.abs(area) <= minArea) return null;
  if (area < 0) reverseLoop(loop);
  return loop;
}

/** Sutherland-Hodgman against a horizontal plane; keeps z for the next clip. */
function clipHalfspace(poly, zPlane, keepAbove) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const da = keepAbove ? a[2] - zPlane : zPlane - a[2];
    const db = keepAbove ? b[2] - zPlane : zPlane - b[2];
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const f = da / (da - db);
      out.push([
        a[0] + (b[0] - a[0]) * f,
        a[1] + (b[1] - a[1]) * f,
        a[2] + (b[2] - a[2]) * f,
      ]);
    }
  }
  return out;
}

function reverseLoop(loop) {
  const n = loop.length / 2;
  for (let i = 0; i < Math.floor(n / 2); i++) {
    const j = n - 1 - i;
    const x = loop[i * 2], y = loop[i * 2 + 1];
    loop[i * 2] = loop[j * 2]; loop[i * 2 + 1] = loop[j * 2 + 1];
    loop[j * 2] = x; loop[j * 2 + 1] = y;
  }
}

/**
 * Is this loop a shape, or a seam?
 *
 * Area alone cannot tell them apart. A sliver left where two triangles were
 * unioned is a hair wide and as long as the edge they shared, so it can have
 * more area than a small round hole while being nothing at all — and the
 * silhouette of a real part accumulated a hundred of them. What made that
 * expensive is that every later union has to carry them; what made it *wrong*
 * is what happens next: waterline offsets the silhouette outward by the tool
 * radius, and a sliver of no width becomes a full circle of toolpath. Measured
 * on clamp1.stl, 348 of the 464 closed passes in a finishing program were those
 * circles — 1.5mm across, 1.6 metres of cutting feed, all of it in mid-air.
 *
 * Area over perimeter is the loop's mean half-width, and it is small exactly
 * when the loop is a sliver whichever way round it is. Below the distance the
 * cleaner is already allowed to move a point, it is not a feature: an island
 * that thin is metal the pass may take, and a hole that thin is a pillar it
 * may cut through — both are inside the tolerance the whole silhouette is
 * built to.
 */
function isFeature(loop, { minArea, cleanDistance }) {
  const area = Math.abs(loopArea(loop));
  if (!(area > minArea)) return false;
  let perimeter = 0;
  const n = loop.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    perimeter += Math.hypot(loop[j * 2] - loop[i * 2], loop[j * 2 + 1] - loop[i * 2 + 1]);
  }
  return perimeter > 0 && area / perimeter > cleanDistance;
}

/**
 * Top-down accumulator. Call `down(z)` with strictly decreasing z; each call
 * returns the silhouette of all material at or above that z.
 *
 * Triangles are swept with an active list keyed on their z extents, so the
 * total work is proportional to triangle/band incidences rather than
 * triangles × levels.
 */
export class SilhouetteStack {
  constructor(mesh, { tolerance = 0.01 } = {}) {
    this.mesh = mesh;
    this.tolerance = tolerance;
    // What obstructs a cutter whose tip is at z is what stands *above* z, not
    // what lies exactly on it: a pocket floor at the final depth is the surface
    // the pass exists to cut, and counting it as keepout meant the last pass
    // found nothing to do and left the floor uncut. The band therefore starts a
    // hair above the tip — far inside tolerance, so nothing that could really
    // block the tool is let through.
    this.epsilon = tolerance / 2;
    // sub-tolerance detail cannot affect where the tool may go, and letting it
    // build up across levels is what turns this from linear into unusable
    this.minArea = tolerance * tolerance;
    this.cleanDistance = tolerance / 5;
    // How wide a crack between two triangles that meet may be and still be a
    // seam: the rounding of the mesh's own float32 coordinates, at the largest
    // of them, and the integer grid the union works on. Well under what the
    // cleaner may move a point, so nothing that is a feature is closed.
    let reach = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      reach = Math.max(reach, Math.abs(mesh.positions[i]), Math.abs(mesh.positions[i + 1]));
    }
    this.crack = hasOpenEdges(mesh)
      ? Math.min(this.cleanDistance, 2e-5 + 4 * reach * FLOAT32_EPSILON) : 0;
    this.accumulated = [];
    this.top = Infinity;

    // triangles sorted by zMax descending, so descending bands consume them in order
    const { positions, indices } = mesh;
    const tris = [];
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
      const za = positions[a + 2], zb = positions[b + 2], zc = positions[c + 2];
      tris.push({
        pts: [
          [positions[a], positions[a + 1], za],
          [positions[b], positions[b + 1], zb],
          [positions[c], positions[c + 1], zc],
        ],
        zMin: Math.min(za, zb, zc),
        zMax: Math.max(za, zb, zc),
      });
    }
    tris.sort((p, q) => q.zMax - p.zMax);
    this.tris = tris;
    this.cursor = 0;    // next triangle not yet activated
    this.active = [];   // triangles overlapping the bands seen so far
  }

  /**
   * The union of a band, with the cracks between triangles that meet closed.
   *
   * Triangles that meet along an edge each side writes differently — a
   * T-junction — leave a crack between them a few nanometres wide once the
   * mesh has been rotated and every vertex rounded on its own, and a crack is
   * all it takes to make a pocket's rim two pieces instead of a ring: the pocket
   * is then a notch in the outline and not a hole in it, and nothing finds it.
   * Closing them (closeLoops) is only worth taking when it changed the shape of
   * the answer - the number of loops that are features, or how many of them are
   * holes, once both are what the silhouette would hand on - because the closed
   * loops are the same polygons with other vertices, and every toolpath built
   * on them starts where they do. A keyhole whose slit is exactly closed is a
   * ring already, and the normalizing below makes it one.
   *
   * Only a mesh with an edge that does not belong to two triangles can have
   * such a crack (see hasOpenEdges); for any other this returns at once.
   */
  healed(loops) {
    if (!(this.crack > 0)) return loops;
    const shape = (set) => {
      const features = normalizedLoops(cleanLoops(set, this.cleanDistance))
        .filter((loop) => isFeature(loop, this));
      return [features.length, features.filter((loop) => loopArea(loop) < 0).length];
    };
    const closed = closeLoops(loops, this.crack);
    const [before, holesBefore] = shape(loops);
    const [after, holesAfter] = shape(closed);
    return before !== after || holesBefore !== holesAfter ? closed : loops;
  }

  /** Silhouette of everything above a tool tip at `z`, as normalized loops. */
  down(z) {
    const zLow = z + this.epsilon;
    const zHigh = this.top;
    // activate triangles that reach into this band
    while (this.cursor < this.tris.length && this.tris[this.cursor].zMax >= zLow) {
      this.active.push(this.tris[this.cursor++]);
    }

    const bandLoops = [];
    const stillActive = [];
    for (const tri of this.active) {
      const loop = projectTriangleBand(tri.pts, zLow, zHigh, this.minArea);
      if (loop) bandLoops.push(loop);
      // a triangle that bottoms out inside this band is spent
      if (tri.zMin < zLow) stillActive.push(tri);
    }
    this.active = stillActive;
    // bands stay flush: the next one ends where this one started, so no sliver
    // of geometry can slip between two levels and go unseen by both
    this.top = zLow;

    if (bandLoops.length > 0) {
      const merged = this.healed(unionLoops(
        this.accumulated.length > 0 ? [...this.accumulated, ...bandLoops] : bandLoops,
      ));
      // Union of many touching triangles leaves slivers along the seams, and
      // can pinch a ring into a self-touching keyhole. Both have to go before
      // this becomes the next level's input — and before anything offsets it,
      // which is where a keyhole turns into a gouge.
      this.accumulated = normalizedLoops(
        cleanLoops(merged, this.cleanDistance).filter((loop) => isFeature(loop, this)),
      );
    }
    return this.accumulated;
  }
}

/** One-shot silhouette of everything at or above `z` (no accumulation state). */
export function silhouetteAbove(mesh, z, options) {
  return new SilhouetteStack(mesh, options).down(z);
}
