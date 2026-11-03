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

import { fixtureLoop } from '../fixtures.js';
import { pointInLoops } from '../../geom/inside.js';
import { toolSections } from '../tool-geometry.js';

/** How far apart the samples are along the tool, in mm. */
const ALONG = 3;

/** Points round each ring. */
const AROUND = 8;

/**
 * The fixtures of a setup as prisms, ready to test: enabled clamps that stand on
 * the table. A chuck is a lathe's, and a mill's one is a body, drawn as a column.
 */
export function fixturePrisms(fixtures) {
  return (fixtures ?? [])
    .filter((f) => f && f.enabled !== false)
    .map((f) => ({
      name: f.name ?? 'a clamp',
      loops: [fixtureLoop(f)],
      z0: f.baseZ ?? 0,
      z1: (f.baseZ ?? 0) + Math.max(0, f.height ?? 0),
    }));
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
        if (!pointInLoops(prism.loops, x, y)) continue;
        const depth = Math.min(z - prism.z0, prism.z1 - z);
        if (!best || depth > best.depth) best = { name: prism.name, depth };
      }
    }
  }
  return best;
}
