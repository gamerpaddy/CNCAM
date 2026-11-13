// Where an imported model lands.
//
// A model arrives at the coordinates it was drawn at. A CAD export is routinely
// hundreds of millimetres from its own origin (clamp1.stl stands at X-250 Y-540),
// so it showed up nowhere near the zero point, and a second one landed wherever
// *its* file put it. Models carry no placement of their own to correct that, so
// the correction is made once, on the way in, to the triangles.
//
// A file is moved as a whole, never body by body: the parts of a multi-body STEP
// stand in a relation to each other that is the design.

import { computeBounds } from '../geom/mesh.js';

/** Between a model and the ones already there, mm. */
export const IMPORT_GAP = 10;

function boundsOfAll(meshes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    if (!m?.positions?.length) continue;
    const b = computeBounds(m.positions);
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]); }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/**
 * Move the parts of one file, together, to where a new model belongs: footprint
 * centred on X0 Y0 and its lowest point on Z0 when it is the first, else beside
 * what is there — to the right of it, on the same centreline, on the same floor.
 *
 * @param parts the file's meshes; their positions are moved in place
 * @param existing the meshes already in the project
 * @returns a description of where it went, or null when it did not move
 */
export function placeImport(parts, existing = []) {
  const own = boundsOfAll(parts);
  if (!own) return null;
  const there = boundsOfAll(existing);
  const centre = (b, k) => (b.min[k] + b.max[k]) / 2;
  const target = there
    ? [there.max[0] + IMPORT_GAP + (own.max[0] - own.min[0]) / 2, centre(there, 1), there.min[2]]
    : [0, 0, 0];
  const shift = [target[0] - centre(own, 0), target[1] - centre(own, 1), target[2] - own.min[2]];
  if (shift.every((v) => Math.abs(v) < 1e-9)) return null;
  for (const m of parts) {
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) { p[i] += shift[0]; p[i + 1] += shift[1]; p[i + 2] += shift[2]; }
  }
  const r = (v) => Math.round(v * 10) / 10;
  return there ? `X${r(target[0])} Y${r(target[1])}, beside the model already there` : 'X0 Y0 Z0';
}
