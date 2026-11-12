// Copies of the part on one table: a setup that machines the same part N times.
//
// A job with six of one part is one setup with six placements, not six setups: the
// billet is one piece, the work offset is one number, and — the point of it — an
// operation is generated once over all of them, so one tool change serves every
// copy instead of being repeated for each. The strategies already work on one merged
// mesh, so holes, pockets and outlines are found on every copy without a line of
// change in any of them; all that is needed is for the copies to exist in the mesh
// the strategies are given.
//
// A placement is { dx, dy, rotZ }: the part turned `rotZ` degrees about the centre of
// the original (in the frame the table sees it, after the setup's own orientation),
// then moved by (dx, dy). The original stays where it is and is not in the list —
// the list is the *copies*, so an empty one is an ordinary setup.
//
// Placements are in the machine's X and Y, not the part's: "move 40 along the
// table" means the same thing whichever way up the part was fixtured.

import { transformMesh } from './setup.js';
import { computeBounds } from '../geom/mesh.js';

/** More than this is a mistake, not a layout: each copy is geometry every operation must read. */
export const MAX_COPIES = 200;

/** A placement as a rotation matrix and an offset about a pivot, for `transformMesh`. */
function placementOf(copy, pivot) {
  const a = ((copy.rotZ ?? 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const matrix = [c, -s, 0, s, c, 0, 0, 0, 1];
  // rotate about the pivot, then move: R(p - pivot) + pivot + d
  const offset = [
    pivot[0] - (c * pivot[0] - s * pivot[1]) + (copy.dx ?? 0),
    pivot[1] - (s * pivot[0] + c * pivot[1]) + (copy.dy ?? 0),
    0,
  ];
  return { matrix, offset };
}

/** The XY centre of a set of meshes, which is what a copy turns about. */
export function pivotOf(meshes) {
  const live = meshes.filter((m) => m?.positions?.length);
  if (live.length === 0) return [0, 0];
  const min = [Infinity, Infinity];
  const max = [-Infinity, -Infinity];
  for (const mesh of live) {
    const b = computeBounds(mesh.positions);
    for (let k = 0; k < 2; k++) {
      if (b.min[k] < min[k]) min[k] = b.min[k];
      if (b.max[k] > max[k]) max[k] = b.max[k];
    }
  }
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
}

/**
 * The meshes with their copies after them.
 *
 * @param meshes the setup's meshes in setup space (after orientation, before the datum shift)
 * @param copies [{ dx, dy, rotZ }]
 * @param pivot the XY the copies turn about — see `pivotOf`
 */
export function expandInstances(meshes, copies, pivot) {
  if (!copies?.length) return meshes;
  const out = [...meshes];
  for (const copy of copies.slice(0, MAX_COPIES)) {
    const { matrix, offset } = placementOf(copy, pivot);
    for (const mesh of meshes) out.push(transformMesh(mesh, matrix, offset));
  }
  return out;
}

/** The same placement as a mesh transform, for anything that moves a single mesh. */
export function copyPlacements(copies, pivot) {
  return (copies ?? []).slice(0, MAX_COPIES).map((c) => placementOf(c, pivot));
}

/**
 * A grid of copies: `columns` along X, `rows` along Y, the original being the
 * first cell. `spacing` is the distance between neighbouring centres.
 */
export function gridCopies({ columns = 2, rows = 1, spacingX = 50, spacingY = 50 } = {}) {
  const out = [];
  const nc = Math.max(1, Math.min(columns | 0, 50));
  const nr = Math.max(1, Math.min(rows | 0, 50));
  for (let r = 0; r < nr; r++) {
    for (let c = 0; c < nc; c++) {
      if (r === 0 && c === 0) continue;
      out.push({ dx: c * spacingX, dy: r * spacingY, rotZ: 0 });
    }
  }
  return out;
}

/**
 * Copies on a circle through the original: `count` parts in all, spaced evenly,
 * the original at `startDeg`. With `turn` each copy is also turned to face the
 * centre as the circle carries it round, like a part on a carousel.
 */
export function circleCopies({ count = 4, radius = 50, startDeg = 0, turn = true } = {}) {
  const n = Math.max(2, Math.min(count | 0, MAX_COPIES));
  const a0 = (startDeg * Math.PI) / 180;
  // the original is at the angle `start`; centre of the circle is a radius away from it
  const out = [];
  for (let k = 1; k < n; k++) {
    const turnBy = (360 * k) / n;
    const a = a0 + (2 * Math.PI * k) / n;
    // positions on the circle, relative to the original's
    const dx = radius * (Math.cos(a) - Math.cos(a0));
    const dy = radius * (Math.sin(a) - Math.sin(a0));
    out.push({ dx, dy, rotZ: turn ? turnBy : 0 });
  }
  return out;
}

/** The boxes of the original and every copy, in XY, for the overlap test and the preview. */
export function copyBoxes(bounds, copies, pivot) {
  const corners = [
    [bounds.min[0], bounds.min[1]], [bounds.max[0], bounds.min[1]],
    [bounds.max[0], bounds.max[1]], [bounds.min[0], bounds.max[1]],
  ];
  const boxes = [{ min: [bounds.min[0], bounds.min[1]], max: [bounds.max[0], bounds.max[1]], index: 0 }];
  copyPlacements(copies, pivot).forEach(({ matrix, offset }, n) => {
    const moved = corners.map(([x, y]) => [
      matrix[0] * x + matrix[1] * y + offset[0], matrix[3] * x + matrix[4] * y + offset[1],
    ]);
    boxes.push({
      min: [Math.min(...moved.map((p) => p[0])), Math.min(...moved.map((p) => p[1]))],
      max: [Math.max(...moved.map((p) => p[0])), Math.max(...moved.map((p) => p[1]))],
      index: n + 1,
    });
  });
  return boxes;
}

/**
 * Which pairs of parts overlap, by their boxes — conservative on a turned part, whose
 * box is bigger than it is. Two parts that overlap are cut as one lump, which is
 * never what a layout means.
 *
 * @param clearance how far apart they must be, mm — the cutter has to get between
 */
export function overlappingCopies(bounds, copies, pivot, clearance = 0) {
  const boxes = copyBoxes(bounds, copies, pivot);
  const out = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.min[0] < b.max[0] + clearance && b.min[0] < a.max[0] + clearance
        && a.min[1] < b.max[1] + clearance && b.min[1] < a.max[1] + clearance) out.push([i, j]);
    }
  }
  return out;
}
