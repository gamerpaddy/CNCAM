// Is the tool, as it is leaning, in a clamp?
//
// A 3-axis program keeps its cutter out of a clamp by the *footprint*: the
// keep-out is the whole column above the clamp, grown by the widest the tool is
// (engine/fixtures.js, regions.js), because a vertical tool that must not touch
// a clamp must not be above it either. A leaning tool breaks the premise. Its
// holder is nowhere near the tip's column — it is a few centimetres off to one
// side, and may be low enough to meet a clamp the tip is nowhere near.
//
// So a tilted program is asked the real question, in 3D: with the tip here and
// the spindle leaning that way, is any part of the cutter, the shank or the
// holder inside a fixture? A fixture is a prism — its footprint between its base
// and its top — and the tool is sampled along its length and round its
// circumference. That is conservative about nothing and exact about nothing: a
// ring of eight points every few millimetres will not find a clamp corner that
// brushes the holder, and will find any clamp the holder is sunk into. It is
// there for the second kind of crash, which is the one that scraps the machine.

//
// An imported fixture — a vice or a chuck from an STL or STEP file — is asked the
// same question of every program, leaning or not. A drawn clamp is a column and
// the plan keeps a vertical tool out of the whole of it; a model is a shape the
// part sits inside, and the plan only keeps out of what stands beside the work
// (engine/fixtures.js fixtureKeepouts). Whether the holder comes down on a jaw,
// a through-cut goes on into the bed, or a rapid crosses a clamp screw is found
// here, on the finished path. The model is read as its top surface: everything
// under it is taken to be solid, which is what a tool arriving from above meets.

import { fixtureLoop } from '../fixtures.js';
import { pointInLoops } from '../../geom/inside.js';
import { buildHeightmap } from '../../geom/heightmap.js';
import { toolSections } from '../tool-geometry.js';
import { MOVE_STRIDE, OP, isTilted } from '../cl.js';

/** How far apart the samples are along the tool, in mm. */
const ALONG = 3;

/** Points round each ring. */
const AROUND = 16;

/** The grid an imported fixture's top surface is read on, in mm. */
const MODEL_CELL = 0.5;

/**
 * How far into a model a sample has to be to count. The surface is a raster of
 * a triangle mesh and the cutter a ring of points; a tool running along a jaw
 * face it was planned to clear by a hair is not in it.
 */
const MODEL_SKIN = 0.1;

const mapCache = new WeakMap();   // placed mesh -> heightmap

function modelMap(mesh) {
  let map = mapCache.get(mesh);
  if (!map) {
    // Not dilated: the drop cutter grows a surface by a cell so as never to be
    // invited into it, and here that would be a jaw half a millimetre fatter
    // than it is, which a cutter running along it would be said to be inside.
    map = buildHeightmap(mesh, { cellSize: MODEL_CELL, dilate: false });
    mapCache.set(mesh, map);
  }
  return map;
}

/**
 * The fixtures of a setup as prisms, ready to test: enabled clamps that stand on
 * the table. A chuck is a lathe's, and a mill's one is a body, drawn as a column.
 * An imported fixture is not a prism but a surface (`map`), between the same two
 * heights.
 *
 * @param fixtures resolved — see engine/fixtures.js resolveFixtures
 */
export function fixturePrisms(fixtures) {
  return (fixtures ?? [])
    .filter((f) => f && f.enabled !== false && (f.kind !== 'model' || f.mesh))
    .map((f) => (f.kind === 'model' ? {
      name: f.name ?? 'a fixture',
      map: modelMap(f.mesh),
      // How far inside the tool's own outline it is asked. A cut planned round a
      // jaw runs *along* it — tangent, to the hundredth — and the surface is
      // known to the nearest cell, so asked at its full radius the tool is in
      // the jaw on every pass that was planned to miss it. Brought in by a
      // little over half a cell, tangent is clear and anything more than that
      // far in is found.
      skin: modelMap(f.mesh).cellSize * 0.6 + 0.05,
      z0: f.mesh.bounds.min[2],
      z1: f.mesh.bounds.max[2],
    } : {
      name: f.name ?? 'a clamp',
      loops: [fixtureLoop(f)],
      z0: f.baseZ ?? 0,
      z1: (f.baseZ ?? 0) + Math.max(0, f.height ?? 0),
    }));
}

/** Only the imported ones: what a program that never tilts is still asked about. */
export function modelPrisms(fixtures) {
  return fixturePrisms(fixtures).filter((p) => p.map);
}

/** The top of a model at (x, y), or -Infinity where it is not. */
function surfaceAt(map, x, y) {
  const i = Math.round((x - map.min[0]) / map.cellSize);
  const j = Math.round((y - map.min[1]) / map.cellSize);
  if (i < 0 || j < 0 || i >= map.width || j >= map.height) return -Infinity;
  const h = map.data[j * map.width + i];
  return h === map.floor ? -Infinity : h;
}

/**
 * The cutter's silhouette as rings to sample: [height up the axis, radius].
 * Taken from the same description of the tool everything else reads.
 */
export function toolRings(tool) {
  const rings = [];
  const sections = toolSections(tool);
  for (const { points } of sections) {
    for (let i = 1; i < points.length; i++) {
      const [r0, s0] = points[i - 1];
      const [r1, s1] = points[i];
      const length = Math.hypot(r1 - r0, s1 - s0);
      const pieces = Math.max(1, Math.ceil(length / ALONG));
      for (let k = 0; k <= pieces; k++) {
        const t = k / pieces;
        rings.push([s0 + (s1 - s0) * t, r0 + (r1 - r0) * t]);
      }
    }
  }
  // how far from the axis any of it is, so a tool nowhere near a fixture can be
  // ruled out without walking its rings
  rings.reach = rings.reduce((m, [, r]) => Math.max(m, r), 0);
  rings.length_ = rings.reduce((m, [s]) => Math.max(m, s), 0);
  return rings;
}

/**
 * Which fixture, if any, the tool at this pose is inside.
 *
 * @param prisms from `fixturePrisms`
 * @param rings from `toolRings`
 * @returns { name, depth } — how far into the fixture's height the deepest
 *   sample is — or null
 */
export function fixtureHit(prisms, rings, tip, axis) {
  if (prisms.length === 0) return null;
  const [ax, ay, az] = axis;
  // Nothing of the tool is lower than its tip by more than its own width, so a
  // tool whose tip is that far over the tallest fixture is over all of them.
  // This is what makes asking a whole 3-axis program affordable: most of it is
  // spent well above the vice.
  if (az >= 0 && rings.reach !== undefined) {
    let top = -Infinity;
    for (const prism of prisms) if (prism.z1 > top) top = prism.z1;
    if (tip[2] - rings.reach > top) return null;
  }
  // two unit vectors square to the axis, to put the ring round it
  const t = Math.abs(az) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let ux = ay * t[2] - az * t[1];
  let uy = az * t[0] - ax * t[2];
  let uz = ax * t[1] - ay * t[0];
  const un = Math.hypot(ux, uy, uz) || 1;
  ux /= un; uy /= un; uz /= un;
  const wx = ay * uz - az * uy;
  const wy = az * ux - ax * uz;
  const wz = ax * uy - ay * ux;

  let best = null;
  for (const [s, r] of rings) {
    const cx = tip[0] + ax * s;
    const cy = tip[1] + ay * s;
    const cz = tip[2] + az * s;
    for (let k = 0; k < (r > 1e-6 ? AROUND : 1); k++) {
      const a = (k / AROUND) * Math.PI * 2;
      const c = Math.cos(a) * r;
      const d = Math.sin(a) * r;
      const x = cx + ux * c + wx * d;
      const y = cy + uy * c + wy * d;
      const z = cz + uz * c + wz * d;
      for (const prism of prisms) {
        if (z < prism.z0 || z > prism.z1) continue;
        let depth;
        if (prism.map) {
          const k = r > prism.skin ? (r - prism.skin) / r : 0;
          depth = surfaceAt(prism.map, cx + (x - cx) * k, cy + (y - cy) * k) - z;
          if (!(depth > MODEL_SKIN)) continue;
        } else {
          if (!pointInLoops(prism.loops, x, y)) continue;
          depth = Math.min(z - prism.z0, prism.z1 - z);
        }
        if (!best || depth > best.depth) best = { name: prism.name, depth, at: [x, y, z] };
      }
    }
  }
  return best;
}

/**
 * Does this finished path put the tool into an imported fixture?
 *
 * The whole path, rapids and all, walked in steps no longer than the cutter is
 * wide, with the whole tool — cutter, shank and holder — asked at each. It is
 * what is run on an operation the moment it is generated, so a crash is said on
 * the operation that has it and not first found in a simulation somebody has to
 * think to run.
 *
 * @param cl a finished CL program
 * @param prisms from `modelPrisms`
 * @returns null, or { count, depth, name, at: [x, y, z], move } — how many
 *   moves are in a fixture, the deepest any goes, and where that is
 */
export function fixtureCrashes(cl, tool, prisms) {
  if (!prisms?.length || !cl?.count) return null;
  const rings = toolRings(tool);
  if (rings.length === 0) return null;
  const stride = Math.max(1, Math.min(rings.reach * 2 || 1, 5));
  const UP = [0, 0, 1];
  const d = cl.moves;
  let prev = null;
  let found = null;
  // one straight piece of travel, asked along its length
  const walk = (from, to, axis) => {
    const pieces = Math.max(1, Math.ceil(
      Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) / stride,
    ));
    let worst = null;
    for (let s = 1; s <= pieces; s++) {
      const t = s / pieces;
      const at = [
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t,
      ];
      const hit = fixtureHit(prisms, rings, at, axis);
      if (hit && (!worst || hit.depth > worst.depth)) worst = hit;
    }
    return worst;
  };
  for (let n = 0; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    let worst;
    let p;
    if (d[o] === OP.DRILL) {
      // a cycle: across to the hole at the retract plane, then down it
      const over = [d[o + 1], d[o + 2], d[o + 4]];
      const across = prev ? walk(prev, over, UP) : null;
      const down = walk(over, [d[o + 1], d[o + 2], d[o + 3]], UP);
      worst = across && (!down || across.depth > down.depth) ? across : down;
      p = over;
    } else {
      p = [d[o + 1], d[o + 2], d[o + 3]];
      const axis = cl.fiveAxis && isTilted(d[o + 4], d[o + 5])
        ? unit(d[o + 4], d[o + 5], d[o + 6]) : UP;
      worst = walk(prev ?? p, p, axis);
    }
    if (worst) {
      if (!found) found = { count: 0, depth: 0, name: worst.name, at: worst.at, move: n };
      found.count++;
      if (worst.depth > found.depth) {
        found.depth = worst.depth;
        found.name = worst.name;
        found.at = worst.at;
        found.move = n;
      }
    }
    prev = p;
  }
  return found;
}

function unit(x, y, z) {
  const n = Math.hypot(x, y, z) || 1;
  return [x / n, y / n, z / n];
}
