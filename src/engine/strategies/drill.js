// Drilling with hole recognition.
//
// The model is sliced at a series of depths; on each slice, loops that enclose
// no material (negative area after union) and fit a circle are candidate holes.
// Matching ones become DRILL cycle moves, which posts turn into G81/G82/G83
// (LinuxCNC) or long-hand moves (GRBL).
//
// Scanning a *range* rather than a single slice under the top face is what lets
// the strategy see a hole that starts partway down — in the floor of a pocket,
// on a step, under a counterbore. A single top slice finds only holes that
// break the top surface, which is a minority of the holes on a real part, and
// the operation looked broken rather than limited.
//
// The scan also measures how deep each hole goes, so `depthMode: 'hole'` can
// drill each one to its own bottom instead of taking every hole to a single
// Bottom Z — which is either too shallow for the deep ones or drills air (and
// through the fixture) for the shallow ones.

import { CLBuilder } from '../cl.js';
import { plural, verb, allOf } from '../text.js';
import { computeBounds } from '../../geom/mesh.js';
import { sliceMeshZ } from '../../geom/slice.js';
import { unionLoops, loopArea } from '../../geom/clipper.js';
import { applyCutting } from '../cutting.js';
import { holeApproachZ } from '../heights.js';
import { regionAllowsPoint } from '../regions.js';
import { tipLengthOf, tipAngleOf } from '../tool-geometry.js';

const EPS = 1e-3;
const MAX_SLICES = 96;      // scan budget; slicing a real mesh is not free

export function generateDrill({
  mesh, tool, params, regions, drawing, stock,
}) {
  const clearance = params.clearanceHeight;
  const cl = new CLBuilder();
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  // A drawing of circles is a job with no part in it — a plate of hole positions
  // imported as a DXF and nothing else — and then the billet is all there is to
  // measure the depth against. The app passes no mesh at all for such a project,
  // and reading its positions threw.
  const hasPart = !!mesh?.positions?.length;
  if (!hasPart && !(drawing && stock?.min && stock?.max)) {
    cl.warn('there is no model to find holes in — import one, or point this at a drawing of circles');
    return cl.finish();
  }
  const bounds = hasPart ? computeBounds(mesh.positions) : { min: stock.min, max: stock.max };
  const topZ = Math.min(params.topZ, bounds.max[2]);
  const bottomZ = Math.max(params.bottomZ, bounds.min[2]);
  const matchTol = Math.max(0, params.diameterTol ?? 0.5);

  // Where the holes are. A drawing wins when there is one, for the same reason
  // it does in engraving and slotting: hole positions are a thing you draw, and
  // on a plate that is *how* they arrive — a circle per hole on a DXF, which
  // until now the drill could not be pointed at. Recognition off the solid is
  // what a modelled part gives, and it stays the default.
  const drawn = drawing?.length ? holesFromDrawing(drawing) : null;
  if (drawing && drawing.length === 0) {
    cl.warn('the drawing has no lines in it — check the DXF imported what you expected');
  }
  if (drawn && drawn.length === 0) {
    cl.warn('no circles in the drawing to drill — a hole position is a circle, and '
      + 'this one has only open lines in it');
    return cl.finish();
  }
  const found = drawn ?? (hasPart ? findHoles(mesh, { topZ, bottomZ, bounds }) : []);
  const matched = found.filter((h) => Math.abs(h.r * 2 - tool.diameter) <= matchTol);

  if (matched.length === 0) {
    cl.warn(found.length === 0
      ? `no round holes found between Z${topZ.toFixed(2)} and Z${bottomZ.toFixed(2)}`
      : `no ${drawn ? 'circle' : 'hole'} matches ⌀${tool.diameter}±${matchTol} — `
        + `this ${drawn ? 'drawing' : 'part'} has ${describeSizes(found)}`);
    return cl.finish();
  }

  // A hole under a clamp is still a hole, and a drill cycle is the one thing in
  // here that will happily go down through one — see engine/regions.js. The
  // radius asked about is the drill's own, because that is the material this
  // operation removes.
  const holes = matched.filter((h) => regionAllowsPoint(regions, h.cx, h.cy, {
    radius: tool.diameter / 2, tolerance: params.tolerance ?? 0.01,
  }));
  const blocked = matched.length - holes.length;
  if (holes.length === 0) {
    cl.warn(`${allOf(matched.length, 'matching hole')} `
      + `${verb(matched.length, 'is', 'are')} under a clamp or outside the `
      + 'picked regions — nothing here can be drilled');
    return cl.finish();
  }
  if (blocked > 0) {
    cl.info(`${plural(blocked, 'hole')} skipped — under a clamp or outside the picked regions`);
  }

  // Where the cycle lifts to between holes: the same gap above the job that
  // every other entry uses. It used to be read from `params.retract`, which no
  // schema ever wrote, so every program retracted to exactly 2mm whatever the
  // field said.
  // Above the billet as well as the part — see heights.js holeSurfaceZ.
  const retractZ = holeApproachZ(topZ, stock, params, 0.5);

  orderHoles(holes);
  const perHole = (params.depthMode ?? 'bottomZ') === 'hole';

  // One rapid to clearance, before the first hole and not between them. G98
  // retracts to the Z the cycle started at, so that one move is what sets the
  // return plane — while a rapid between holes only breaks the cycle, and the
  // post has to close it with a G80 and open a fresh one for every hole. Back
  // to back, the holes after the first post as bare X/Y lines, which is what a
  // canned cycle is for.
  // A drill does not leave a flat bottom, and on a hole that comes out the
  // other side that is not a detail: stopping the tip on the underside leaves a
  // cone of material the full length of the point, so the hole is not through.
  // Taking it that much further is the whole of the difference, and it is the
  // tool's own geometry rather than a number to be typed. See tool-geometry.js.
  const point = tipLengthOf(tool);
  const underside = bounds.min[2];
  let brokeThrough = 0;
  cl.rapid(holes[0].cx, holes[0].cy, clearance);
  for (const h of holes) {
    // a blind hole modelled to its own floor should be drilled to that floor,
    // not to a Bottom Z that belongs to some other hole on the part
    let z = perHole ? Math.max(h.bottom, bottomZ) : params.bottomZ;
    if (point > 0 && h.bottom <= underside + EPS * 2 && z <= underside + EPS * 2) {
      z -= point;
      brokeThrough++;
    }
    cl.drill(h.cx, h.cy, z, {
      retractZ,
      peck: params.peck ?? 0,
      dwell: params.dwell ?? 0,
    });
  }
  cl.info(`${plural(holes.length, 'hole')} at ⌀${(holes[0].r * 2).toFixed(2)}`
    + (found.length > holes.length
      ? ` — ${plural(found.length - holes.length, 'other hole')} `
        + `${verb(found.length - holes.length, 'needs', 'need')} a different drill`
      : ''));
  if (brokeThrough > 0) {
    cl.info(`${plural(brokeThrough, 'through hole')} taken ${point.toFixed(2)}mm past the `
      + `underside, so the ${tipAngleOf(tool)}° point clears it`);
  }
  return cl.finish();
}

/**
 * Put holes in the order they are visited, in place: the shortest route between
 * them that a cheap search finds.
 *
 * Every hole operation walked its holes sorted by Y and then X. That is a
 * raster, and a raster is the shortest route only for holes that already sit in
 * rows: on fourteen holes scattered over a plate it ran 323mm between them
 * where the nearest-neighbour route with 2-opt on top runs 196, and a Y that
 * differs in the third decimal puts two holes of one row on different "rows",
 * which sends the tool back and forth across the part between them. Each of
 * those is a rapid at clearance height, and none of it removes metal.
 *
 * It starts where the sort used to — lowest Y, then lowest X — so a plate whose
 * holes are in a grid is walked the way it always was and only a layout that
 * was being walked badly changes. An open route, not a tour: the tool does not
 * have to come back to the first hole. 2-opt is capped because it is O(n²) per
 * sweep, and a part with a few hundred holes is a pattern whose
 * nearest-neighbour order is already a good one.
 */
export function orderHoles(holes) {
  const n = holes.length;
  if (n < 3) {
    holes.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    return holes;
  }
  const first = holes.reduce((best, h) => (
    h.cy < best.cy - 1e-9 || (Math.abs(h.cy - best.cy) <= 1e-9 && h.cx < best.cx) ? h : best));
  const left = holes.filter((h) => h !== first);
  let route = [first];
  while (left.length) {
    const at = route[route.length - 1];
    let pick = 0;
    let best = Infinity;
    for (let i = 0; i < left.length; i++) {
      const d = (left[i].cx - at.cx) ** 2 + (left[i].cy - at.cy) ** 2;
      if (d < best - 1e-12) { best = d; pick = i; }
    }
    route.push(left.splice(pick, 1)[0]);
  }
  if (n <= 200) route = twoOpt(route);
  for (let i = 0; i < n; i++) holes[i] = route[i];
  return holes;
}

/**
 * Reverse stretches of an open route while that makes it shorter. The first hole
 * stays where it is; the far end is free to move.
 */
function twoOpt(route) {
  const n = route.length;
  const d = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
  let improved = true;
  let sweeps = 0;
  while (improved && sweeps++ < 50) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        // reversing i..j swaps edges (i-1,i) and (j,j+1) for (i-1,j) and (i,j+1);
        // at the end of the route there is no second edge to swap
        const before = d(route[i - 1], route[i]) + (j + 1 < n ? d(route[j], route[j + 1]) : 0);
        const after = d(route[i - 1], route[j]) + (j + 1 < n ? d(route[i], route[j + 1]) : 0);
        if (after < before - 1e-9) {
          for (let a = i, b = j; a < b; a++, b--) [route[a], route[b]] = [route[b], route[a]];
          improved = true;
        }
      }
    }
  }
  return route;
}

/**
 * The circles in a drawing, as holes to drill.
 *
 * A drawn hole has a centre and a size and no depth at all, so its floor is
 * −Infinity — "no floor of its own", which leaves `depthMode: 'hole'` taking
 * Bottom Z rather than a floor the drawing does not have. Nothing else about a
 * drawn hole differs from a recognised one, which is why they meet here and not
 * further down.
 *
 * A closed path counts as a circle when every vertex is the same distance from
 * its centre. The tolerance is a share of the radius rather than an absolute: a
 * DXF circle arrives already chorded, finely for a small one and coarsely for a
 * big one, and a fixed figure would refuse one end or admit squares at the
 * other. What is left over at 2% is the chord sagitta, which is what a circle
 * chorded at all has and a square does not.
 *
 * The centre is the middle of the bounding box and **not** the average of the
 * vertices. A closed path repeats its first point at the end, and one extra
 * vertex out of sixty-four drags the average a sixty-fourth of a radius off
 * centre — which reads as a 3% spread on a circle that is exact, and refused
 * every drawn hole there was.
 */
const ROUNDNESS = 0.02;

function holesFromDrawing(paths) {
  const out = [];
  for (const { points, closed } of paths) {
    const n = points.length / 2;
    if (!closed || n < 6) continue;          // a triangle is not a hole position
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = points[i * 2];
      const y = points[i * 2 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(points[i * 2] - cx, points[i * 2 + 1] - cy);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    const r = (lo + hi) / 2;
    if (r > 1e-6 && hi - lo <= r * ROUNDNESS) out.push({ cx, cy, r, bottom: -Infinity });
  }
  return out;
}

/**
 * Every round hole in the depth range, with the depth it reaches.
 *
 * Holes are collected across slices and merged by centre: the same hole appears
 * on every slice it passes through, and what we want is one entry per hole
 * carrying its top (where it first appears) and its bottom (the last slice that
 * still shows it).
 */
export function findHoles(mesh, opts) {
  return findRoundFeatures(mesh, { ...opts, outward: false });
}

/**
 * The same scan, asked for round *bosses* instead — a spigot, a turned pad, the
 * outside of a round part.
 *
 * A boss is the same measurement as a hole with one sign flipped: a slice's
 * loops are unioned, and the ones enclosing material have positive area where a
 * hole's enclose none. Everything after that is identical, which is why it is
 * this function with a flag rather than a second scan — external thread milling
 * used to be handed the *holes* and told to orbit outside them, which put the
 * cutter through the wall of every hole on the part.
 *
 * `bottom` is where the feature stops being its own loop, which for a boss is
 * where it meets whatever it stands on. That is its base, which is the number
 * the caller wants.
 */
export function findBosses(mesh, opts) {
  return findRoundFeatures(mesh, { ...opts, outward: true });
}

function findRoundFeatures(mesh, { topZ, bottomZ, bounds, outward = false }) {
  const hi = Math.min(topZ, bounds.max[2]) - EPS;
  const lo = Math.max(bottomZ, bounds.min[2]) + EPS;
  if (!(hi > lo)) return [];

  // Fine enough to catch a shallow hole, capped so a tall part stays quick —
  // and stepped so the *last* slice lands exactly on `lo`. Walking down from
  // `hi` by a fixed step stops wherever the arithmetic runs out: on a 20mm
  // through hole the deepest slice sat 0.25mm above the underside, so the hole
  // measured 0.25mm shallow and `depthMode: 'hole'` drilled it that far short
  // of breaking through.
  const span = hi - lo;
  const steps = Math.max(1, Math.ceil(span / Math.max(span / MAX_SLICES, 0.25)));
  const step = span / steps;
  const merged = [];

  // The round features on one slice. Kept, because the depth refinement below
  // asks about the same heights again and again, and a slice is not free.
  const seen = new Map();
  const circlesAt = (at) => {
    if (!seen.has(at)) {
      const found = [];
      for (const loop of unionLoops(sliceMeshZ(mesh, at))) {
        // a hole encloses no material and comes back negative; a boss is the
        // other sign of the same test
        if (outward ? loopArea(loop) <= 0 : loopArea(loop) >= 0) continue;
        const circle = fitCircle(loop);
        if (circle) found.push(circle);
      }
      seen.set(at, found);
    }
    return seen.get(at);
  };
  const sameFeature = (h, circle) => Math.hypot(h.cx - circle.cx, h.cy - circle.cy) < h.r * 0.5
    && Math.abs(h.r - circle.r) < Math.max(0.1, h.r * 0.1);

  for (let i = 0; i <= steps; i++) {
    const at = hi - step * i;
    for (const circle of circlesAt(at)) {
      // the same hole, seen one slice further down
      const same = merged.find((h) => sameFeature(h, circle));
      if (same) same.bottom = Math.min(same.bottom, at);
      else merged.push({ ...circle, top: at, bottom: at });
    }
  }
  // The scan is inset by EPS at both ends so the slices do not land exactly on
  // a face. A hole seen on the first or last slice runs to the end of the range
  // and is reported there, rather than a thousandth short of it — the numbers
  // downstream are depths of cut, not sample positions.
  for (const h of merged) {
    if (h.bottom <= lo + 1e-9) h.bottom = lo - EPS;
    if (h.top >= hi - 1e-9) h.top = hi + EPS;
  }
  // a "hole" seen on a single slice is a chamfer or a tessellation artefact,
  // not something to put a drill into — unless the scan was that shallow. The
  // same is true of a boss: one slice of a round pad is a fillet.
  const real = merged.filter((h) => h.top - h.bottom >= step * 1.5);
  const out = real.length ? real : merged;

  // A slice says a hole is there; it does not say where it stops. The floor of
  // a blind hole lies somewhere in the step below the last slice that saw it,
  // and the top of one that opens in a pocket floor or under a counterbore
  // somewhere in the step above the first — and on a part a hundred millimetres
  // tall a step is a millimetre. Taking the slice for the answer drilled a
  // blind hole 0.5mm short of its floor and spotted from a surface that was
  // 0.8mm lower than the real one. The ends are found by halving the step:
  // seven slices, and an answer good to a hundredth.
  //
  // A hole at the end of the scanned range is not one of these — it was seen on
  // the first or last slice, and is reported where the range stops.
  const present = (h, at) => circlesAt(at).some((c) => sameFeature(h, c));
  const REFINE = 7;
  for (const h of out) {
    if (h.bottom > lo + 1e-9) {
      let seenAt = h.bottom;
      let goneAt = h.bottom - step;
      for (let k = 0; k < REFINE; k++) {
        const mid = (seenAt + goneAt) / 2;
        if (present(h, mid)) seenAt = mid; else goneAt = mid;
      }
      h.bottom = (seenAt + goneAt) / 2;
    } else {
      // The scan ran out before the hole did — or the hole ran out exactly there.
      // Whether it goes on is what a tap needs to know (a thread in a blind hole
      // stops short of the floor, in a through one it goes beyond the underside),
      // and the underside of the part answers it without another slice.
      const below = Math.max(bounds.min[2] + EPS, lo - Math.max(step, 0.5));
      h.runsOn = lo - EPS <= bounds.min[2] + 2 * EPS || (below < lo - EPS && present(h, below));
    }
    if (h.top < hi - 1e-9) {
      let seenAt = h.top;
      let goneAt = h.top + step;
      for (let k = 0; k < REFINE; k++) {
        const mid = (seenAt + goneAt) / 2;
        if (present(h, mid)) seenAt = mid; else goneAt = mid;
      }
      h.top = (seenAt + goneAt) / 2;
    }
  }
  return out;
}

/** "⌀5.00 ×2, ⌀8.20" — what sizes are actually there, so a drill can be picked. */
function describeSizes(holes) {
  const counts = new Map();
  for (const h of holes) {
    const key = (h.r * 2).toFixed(2);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([d, n]) => `⌀${d}${n > 1 ? ` ×${n}` : ''}`)
    .join(', ');
}

/**
 * Least-squares (Kåsa) circle fit on a closed loop; null unless the loop is
 * convincingly circular. Exact for points on a circle regardless of how
 * unevenly the tessellation distributed them.
 */
export function fitCircle(loop) {
  const n = loop.length / 2;
  if (n < 6) return null;

  // solve x² + y² = A·x + B·y + C  (normal equations, 3×3)
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    const x = loop[i * 2], y = loop[i * 2 + 1];
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    sxz += x * z; syz += y * z; sz += z;
  }
  const sol = solve3([
    [sxx, sxy, sx, sxz],
    [sxy, syy, sy, syz],
    [sx, sy, n, sz],
  ]);
  if (!sol) return null;
  const [A, B, C] = sol;
  const cx = A / 2, cy = B / 2;
  const r2 = C + cx * cx + cy * cy;
  if (r2 <= 0) return null;
  const r = Math.sqrt(r2);

  const tol = Math.max(0.05, r * 0.03); // tessellation-tolerant roundness check
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(loop[i * 2] - cx, loop[i * 2 + 1] - cy);
    if (Math.abs(d - r) > tol) return null;
  }
  return { cx, cy, r };
}

/** Gaussian elimination on a 3×4 augmented matrix. */
function solve3(m) {
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const f = m[row][col] / m[col][col];
      for (let k = col; k < 4; k++) m[row][k] -= f * m[col][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}
