// Shared test geometry.

import { meshFromSoup } from '../geom/mesh.js';

/**
 * Tube (cylinder with a coaxial through-hole) centered at (cx, cy), from z=0
 * to z=h. Slicing it yields an outer circle + an inner hole loop — used for
 * drill hole-recognition tests.
 */
export function makeTube(cx, cy, outerR, innerR, h, segments = 24) {
  const soup = [];
  const ring = (r, i) => {
    const a = (i / segments) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const quad = (a, b, c, e) => soup.push(...a, ...b, ...c, ...a, ...c, ...e);
  for (let i = 0; i < segments; i++) {
    const [ox0, oy0] = ring(outerR, i), [ox1, oy1] = ring(outerR, i + 1);
    const [ix0, iy0] = ring(innerR, i), [ix1, iy1] = ring(innerR, i + 1);
    quad([ox0, oy0, 0], [ox1, oy1, 0], [ox1, oy1, h], [ox0, oy0, h]); // outer wall
    quad([ix0, iy0, 0], [ix0, iy0, h], [ix1, iy1, h], [ix1, iy1, 0]); // inner wall
    quad([ox0, oy0, h], [ox1, oy1, h], [ix1, iy1, h], [ix0, iy0, h]); // top annulus
    quad([ox0, oy0, 0], [ix0, iy0, 0], [ix1, iy1, 0], [ox1, oy1, 0]); // bottom annulus
  }
  return meshFromSoup(new Float32Array(soup));
}

/** Axis-aligned box soup spanning min → max, as a flat vertex array. */
function boxSoup([x0, y0, z0], [x1, y1, z1]) {
  // corners passed in cyclic order; quad (a,b,c,e) → triangles (a,b,c) + (a,c,e)
  const q = (a, b, c, e) => [...a, ...b, ...c, ...a, ...c, ...e];
  const v = (x, y, z) => [x, y, z];
  return [
    ...q(v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0)),   // bottom
    ...q(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)),   // top
    ...q(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)),   // front
    ...q(v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1)),   // back
    ...q(v(x0, y0, z0), v(x0, y1, z0), v(x0, y1, z1), v(x0, y0, z1)),   // left
    ...q(v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)),   // right
  ];
}

/**
 * A round boss standing on a square plate — the outside of a thread, which is
 * the one round feature that is not a hole.
 *
 * The plate is what makes it a boss rather than a bar: below `plateHeight` the
 * slice is the plate's square outline, and only above it does the circle stand
 * on its own. A finder that looks for round loops of *material* has to see one
 * feature here and not two, and has to put its base at the plate.
 *
 * @returns { mesh, cx, cy, diameter, base, top }
 */
export function makeBoss({
  plate = 60, plateHeight = 10, diameter = 20, height = 12,
  center = [0, 0], segments = 64,
} = {}) {
  const [cx, cy] = center;
  const r = diameter / 2;
  const base = plateHeight;
  const top = plateHeight + height;
  const soup = [...boxSoup([cx - plate / 2, cy - plate / 2, 0],
    [cx + plate / 2, cy + plate / 2, base])];
  const ring = (i) => {
    const a = (i / segments) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  for (let i = 0; i < segments; i++) {
    const [x0, y0] = ring(i);
    const [x1, y1] = ring(i + 1);
    soup.push(x0, y0, base, x1, y1, base, x1, y1, top);
    soup.push(x0, y0, base, x1, y1, top, x0, y0, top);
    soup.push(cx, cy, top, x0, y0, top, x1, y1, top);
  }
  return {
    mesh: meshFromSoup(new Float32Array(soup)), cx, cy, diameter, base, top,
  };
}

/** Axis-aligned box mesh from (0,0,0) to (w,d,h). */
export function makeBox(w, d, h) {
  return meshFromSoup(new Float32Array(boxSoup([0, 0, 0], [w, d, h])));
}

/**
 * A wedge rising steadily along +X: z = (x / w) * h over a w × d footprint.
 * A single consistent slope, so "did the pass follow the slope or cut across
 * it?" has an unambiguous answer.
 */
export function makeRamp(w = 40, d = 40, h = 10) {
  const q = (a, b, c, e) => [...a, ...b, ...c, ...a, ...c, ...e];
  const v = (x, y, z) => [x, y, z];
  const soup = [
    ...q(v(0, 0, 0), v(w, 0, 0), v(w, d, 0), v(0, d, 0)),   // base
    ...q(v(0, 0, 0), v(w, 0, h), v(w, d, h), v(0, d, 0)),   // sloped top
    ...q(v(w, 0, 0), v(w, d, 0), v(w, d, h), v(w, 0, h)),   // tall end
    ...q(v(0, 0, 0), v(w, 0, 0), v(w, 0, h), v(0, 0, 0)),   // front skirt
    ...q(v(0, d, 0), v(w, d, 0), v(w, d, h), v(0, d, 0)),   // back skirt
  ];
  return meshFromSoup(new Float32Array(soup));
}

/**
 * A block with a rectangular pocket sunk into its top. The pocket is a genuine
 * enclosed void — surrounded on all sides — which is what pocketing has to find.
 *
 * @returns { mesh, pocket, top } with pocket as { min: [x,y], max: [x,y] }
 */
export function makePocketBlock({ size = 40, pocketSize = 20, height = 10, depth = 6 } = {}) {
  const inset = (size - pocketSize) / 2;
  const pocket = {
    min: [inset, inset],
    max: [inset + pocketSize, inset + pocketSize],
  };
  const floorZ = height - depth;
  const q = (a, b, c, e) => [...a, ...b, ...c, ...a, ...c, ...e];
  const v = (x, y, z) => [x, y, z];
  const [px0, py0] = pocket.min;
  const [px1, py1] = pocket.max;

  const soup = [
    ...q(v(0, 0, 0), v(size, 0, 0), v(size, size, 0), v(0, size, 0)),        // base
    ...q(v(0, 0, 0), v(size, 0, 0), v(size, 0, height), v(0, 0, height)),    // outer walls
    ...q(v(0, size, 0), v(size, size, 0), v(size, size, height), v(0, size, height)),
    ...q(v(0, 0, 0), v(0, size, 0), v(0, size, height), v(0, 0, height)),
    ...q(v(size, 0, 0), v(size, size, 0), v(size, size, height), v(size, 0, height)),
    // top face as four strips around the pocket mouth
    ...q(v(0, 0, height), v(size, 0, height), v(size, py0, height), v(0, py0, height)),
    ...q(v(0, py1, height), v(size, py1, height), v(size, size, height), v(0, size, height)),
    ...q(v(0, py0, height), v(px0, py0, height), v(px0, py1, height), v(0, py1, height)),
    ...q(v(px1, py0, height), v(size, py0, height), v(size, py1, height), v(px1, py1, height)),
    // pocket walls and floor
    ...q(v(px0, py0, floorZ), v(px1, py0, floorZ), v(px1, py0, height), v(px0, py0, height)),
    ...q(v(px0, py1, floorZ), v(px1, py1, floorZ), v(px1, py1, height), v(px0, py1, height)),
    ...q(v(px0, py0, floorZ), v(px0, py1, floorZ), v(px0, py1, height), v(px0, py0, height)),
    ...q(v(px1, py0, floorZ), v(px1, py1, floorZ), v(px1, py1, height), v(px1, py0, height)),
    ...q(v(px0, py0, floorZ), v(px1, py0, floorZ), v(px1, py1, floorZ), v(px0, py1, floorZ)),
  ];
  return { mesh: meshFromSoup(new Float32Array(soup)), pocket, top: height, floorZ };
}

/**
 * A block with a pocket and a round through-hole a stated distance from one of
 * its walls — two features close enough to be confused for each other and far
 * enough apart that no cutter working on one reaches the other.
 *
 * That gap is the whole fixture. A region is a place on the part, and what gets
 * restricted is where the *tool* may be, so every list is moved by a tool number
 * before it is used; pick the wrong number and features this far apart start
 * changing each other. See engine/op-reach.js.
 *
 * The top is tessellated as a grid with the pocket mouth left out and the hole's
 * annulus landing on the grid's own vertices, so it welds into a single flat
 * face rather than a field of T-junctions.
 *
 * @returns { mesh, pocket, hole, top, floorZ, gap }
 *   pocket as { min: [x, y], max: [x, y] }, hole as { x, y, r }
 */
export function makePocketAndHole({
  size = 60, pocketSize = 20, height = 10, depth = 6, holeR = 3, gap = 5, step = 2,
} = {}) {
  const inset = (size - pocketSize) / 2;
  const pocket = { min: [inset, inset], max: [inset + pocketSize, inset + pocketSize] };
  // a tile of whole grid squares round the hole, wide enough to hold the circle
  const tile = Math.ceil((holeR + step) / step) * step;
  const hole = { x: pocket.max[0] + gap + holeR, y: size / 2, r: holeR };
  const floorZ = height - depth;
  const q = (a, b, c, e) => [...a, ...b, ...c, ...a, ...c, ...e];
  const v = (x, y, z) => [x, y, z];
  const [px0, py0] = pocket.min;
  const [px1, py1] = pocket.max;
  const soup = [
    ...q(v(0, 0, 0), v(size, 0, 0), v(size, 0, height), v(0, 0, height)),
    ...q(v(size, 0, 0), v(size, size, 0), v(size, size, height), v(size, 0, height)),
    ...q(v(size, size, 0), v(0, size, 0), v(0, size, height), v(size, size, height)),
    ...q(v(0, size, 0), v(0, 0, 0), v(0, 0, height), v(0, size, height)),
    // pocket walls and floor
    ...q(v(px0, py0, floorZ), v(px1, py0, floorZ), v(px1, py0, height), v(px0, py0, height)),
    ...q(v(px1, py1, floorZ), v(px0, py1, floorZ), v(px0, py1, height), v(px1, py1, height)),
    ...q(v(px0, py1, floorZ), v(px0, py0, floorZ), v(px0, py0, height), v(px0, py1, height)),
    ...q(v(px1, py0, floorZ), v(px1, py1, floorZ), v(px1, py1, height), v(px1, py0, height)),
    ...q(v(px0, py0, floorZ), v(px1, py0, floorZ), v(px1, py1, floorZ), v(px0, py1, floorZ)),
  ];

  // the hole: its wall, and the annulus tying the circle to the grid round it
  const ring = [];
  const n = (8 * tile) / step;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 4;                    // 0..4, one unit per side of the tile
    const side = Math.floor(t);
    const f = (t - side) * 2 - 1;             // -1..1 along that side
    const [ux, uy] = [[1, f], [-f, 1], [-1, -f], [f, -1]][side];
    ring.push([hole.x + ux * tile, hole.y + uy * tile]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = (i / n) * Math.PI * 2;
    const b = (j / n) * Math.PI * 2;
    const p = [hole.x + holeR * Math.cos(a), hole.y + holeR * Math.sin(a)];
    const s = [hole.x + holeR * Math.cos(b), hole.y + holeR * Math.sin(b)];
    soup.push(...q(v(p[0], p[1], 0), v(p[0], p[1], height), v(s[0], s[1], height), v(s[0], s[1], 0)));
    soup.push(...q(v(p[0], p[1], height), v(ring[i][0], ring[i][1], height),
      v(ring[j][0], ring[j][1], height), v(s[0], s[1], height)));
    soup.push(...q(v(p[0], p[1], 0), v(s[0], s[1], 0),
      v(ring[j][0], ring[j][1], 0), v(ring[i][0], ring[i][1], 0)));
  }

  const covered = (x, y) => (x >= px0 && x < px1 && y >= py0 && y < py1)
    || (x >= hole.x - tile && x < hole.x + tile && y >= hole.y - tile && y < hole.y + tile);
  for (let x = 0; x < size; x += step) {
    for (let y = 0; y < size; y += step) {
      if (covered(x, y)) continue;
      soup.push(...q(v(x, y, height), v(x + step, y, height),
        v(x + step, y + step, height), v(x, y + step, height)));
      soup.push(...q(v(x, y, 0), v(x, y + step, 0), v(x + step, y + step, 0), v(x + step, y, 0)));
    }
  }
  return { mesh: meshFromSoup(new Float32Array(soup)), pocket, hole, top: height, floorZ, gap };
}

/**
 * Mushroom: a narrow post carrying a wider cap that overhangs it on all sides.
 * The overhang is the point — at any z inside the post the part's cross-section
 * is just the post, but a vertical cutter is blocked by the cap footprint, so
 * this is the shape that catches keepout computed from a bare slice.
 *
 * @returns { mesh, post, cap } with post/cap as { min: [x,y], max: [x,y] }
 */
export function makeMushroom({
  postSize = 10, capSize = 30, postHeight = 10, capHeight = 5, center = [20, 20],
} = {}) {
  const [cx, cy] = center;
  const rect = (s) => ({ min: [cx - s / 2, cy - s / 2], max: [cx + s / 2, cy + s / 2] });
  const post = rect(postSize);
  const cap = rect(capSize);
  const soup = [
    ...boxSoup([post.min[0], post.min[1], 0], [post.max[0], post.max[1], postHeight]),
    ...boxSoup([cap.min[0], cap.min[1], postHeight],
      [cap.max[0], cap.max[1], postHeight + capHeight]),
  ];
  return { mesh: meshFromSoup(new Float32Array(soup)), post, cap, postHeight, capHeight };
}

/**
 * A stepped block: a small box sitting on a bigger one. Narrow at the top,
 * wide at the bottom.
 *
 * The footprint of this part is not the same at every depth, which is the whole
 * point — it is the shape that tells a contour following the *part's* outline
 * apart from one following the profile at each level. On a plain box the two
 * are identical and every test passes either way.
 *
 * @returns { mesh, base, top, baseHeight, topHeight }
 */
export function makeStepped({ base = 40, top = 20, baseHeight = 10, topHeight = 10 } = {}) {
  const inset = (base - top) / 2;
  const soup = [
    ...boxSoup([0, 0, 0], [base, base, baseHeight]),
    ...boxSoup([inset, inset, baseHeight],
      [inset + top, inset + top, baseHeight + topHeight]),
  ];
  return {
    mesh: meshFromSoup(new Float32Array(soup)),
    base, top, baseHeight, topHeight,
    height: baseHeight + topHeight,
  };
}

/**
 * A stepped shaft on the Z axis: a small diameter at the free (+Z) end and a
 * bigger one behind it. The turning fixture.
 *
 * `groove` cuts a square recess into the big diameter — `{ z, width, radius }`.
 * A recess is the one profile feature a turning pass cannot reach, whichever
 * end it comes from, because a bigger diameter stands in front of it on both
 * sides; a plain step has no such thing and every test on one passes whether
 * that is understood or not.
 *
 * @returns { mesh, bigR, smallR, zMin, zStep, zMax, groove }
 */
/**
 * A bar with a two-diameter bore in one end: the counterbore that boring opens
 * and the drilled hole it opens it from.
 *
 * The pair is the point. A single-diameter bore says nothing about what was
 * there before it, and what turnBore has to work out on solid stock is exactly
 * that — see boreSmallestRadius in strategies/turning.js.
 */
export function makeSteppedBore({
  outerDiameter = 44, boreDiameter = 20, pilotDiameter = 12,
  length = 50, boreDepth = 20, segments = 48,
} = {}) {
  const soup = [];
  const q = (a, b, c, e) => soup.push(...a, ...b, ...c, ...a, ...c, ...e);
  const at = (r, i, z) => {
    const a = (i / segments) * Math.PI * 2;
    return [r * Math.cos(a), r * Math.sin(a), z];
  };
  const R = outerDiameter / 2;
  const bore = boreDiameter / 2;
  const pilot = pilotDiameter / 2;
  // the bore is open at z = length and the pilot runs on to the far end
  for (let i = 0; i < segments; i++) {
    const o0 = at(R, i, 0);
    const o1 = at(R, i + 1, 0);
    const b0 = at(bore, i, 0);
    const b1 = at(bore, i + 1, 0);
    const p0 = at(pilot, i, 0);
    const p1 = at(pilot, i + 1, 0);
    const z = (v, zz) => [v[0], v[1], zz];
    q(z(o0, 0), z(o1, 0), z(o1, length), z(o0, length));              // outside
    q(z(o0, length), z(o1, length), z(b1, length), z(b0, length));    // end face
    q(z(b0, length), z(b1, length), z(b1, length - boreDepth), z(b0, length - boreDepth));
    q(z(b0, length - boreDepth), z(b1, length - boreDepth),           // step down to the pilot
      z(p1, length - boreDepth), z(p0, length - boreDepth));
    q(z(p0, length - boreDepth), z(p1, length - boreDepth), z(p1, 0), z(p0, 0));
    q([0, 0, 0], z(p0, 0), z(p1, 0), [0, 0, 0]);                      // far end capped
    q([0, 0, 0], z(o1, 0), z(o0, 0), [0, 0, 0]);
  }
  return meshFromSoup(new Float32Array(soup));
}

export function makeShaft({
  bigDiameter = 30, smallDiameter = 16, length = 60, stepAt = 25, segments = 48,
  groove = null,
} = {}) {
  const soup = [];
  const q = (a, b, c, e) => soup.push(...a, ...b, ...c, ...a, ...c, ...e);
  const ring = (r, i, z) => {
    const a = (i / segments) * Math.PI * 2;
    return [r * Math.cos(a), r * Math.sin(a), z];
  };
  const bigR = bigDiameter / 2;
  const smallR = smallDiameter / 2;
  const zStep = length - stepAt;

  // the big diameter, as the runs of it a groove leaves behind
  const gz0 = groove ? groove.z - groove.width / 2 : 0;
  const gz1 = groove ? groove.z + groove.width / 2 : 0;
  const bigRuns = groove ? [[0, gz0], [gz1, zStep]] : [[0, zStep]];

  for (let i = 0; i < segments; i++) {
    const [bx0, by0] = ring(bigR, i, 0);
    const [bx1, by1] = ring(bigR, i + 1, 0);
    const [sx0, sy0] = ring(smallR, i, 0);
    const [sx1, sy1] = ring(smallR, i + 1, 0);
    for (const [za, zb] of bigRuns) {
      q([bx0, by0, za], [bx1, by1, za], [bx1, by1, zb], [bx0, by0, zb]);
    }
    if (groove) {
      const [gx0, gy0] = ring(groove.radius, i, 0);
      const [gx1, gy1] = ring(groove.radius, i + 1, 0);
      q([bx0, by0, gz0], [bx1, by1, gz0], [gx1, gy1, gz0], [gx0, gy0, gz0]);   // wall
      q([gx0, gy0, gz0], [gx1, gy1, gz0], [gx1, gy1, gz1], [gx0, gy0, gz1]);   // floor
      q([gx0, gy0, gz1], [gx1, gy1, gz1], [bx1, by1, gz1], [bx0, by0, gz1]);   // wall
    }
    // the shoulder
    q([bx0, by0, zStep], [bx1, by1, zStep], [sx1, sy1, zStep], [sx0, sy0, zStep]);
    // the small diameter out to the free end
    q([sx0, sy0, zStep], [sx1, sy1, zStep], [sx1, sy1, length], [sx0, sy0, length]);
    // both ends capped
    q([0, 0, 0], [bx0, by0, 0], [bx1, by1, 0], [0, 0, 0]);
    q([0, 0, length], [sx0, sy0, length], [sx1, sy1, length], [0, 0, length]);
  }
  return {
    mesh: meshFromSoup(new Float32Array(soup)),
    bigR, smallR, zMin: 0, zStep, zMax: length, groove,
  };
}
