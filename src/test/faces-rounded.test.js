// Face recovery on a mesh with no B-rep (an STL): a plate with rounded corners is
// a top, a bottom, four flat sides and four corners — not one face.

import { test, assert } from './runner.js';
import { meshFromSoup } from '../geom/mesh.js';
import { buildFaces, faceFootprint } from '../geom/faces.js';
import { loopArea } from '../geom/clipper.js';
import { makeRevolved } from './fixtures.js';

/** A w × d × h plate with its vertical corners rounded to r, each corner `seg` triangles round. */
function roundedPlate(w, d, h, r, seg) {
  const pts = [];
  const corners = [[w / 2 - r, d / 2 - r, 0], [-w / 2 + r, d / 2 - r, 90], [-w / 2 + r, -d / 2 + r, 180], [w / 2 - r, -d / 2 + r, 270]];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = ((a0 + (90 * i) / seg) * Math.PI) / 180;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  const s = [];
  const tri = (a, b, c) => s.push(...a, ...b, ...c);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    tri([p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], h]);
    tri([p[0], p[1], 0], [q[0], q[1], h], [p[0], p[1], h]);
    tri([0, 0, h], [p[0], p[1], h], [q[0], q[1], h]);
    tri([0, 0, 0], [q[0], q[1], 0], [p[0], p[1], 0]);
  }
  return meshFromSoup(new Float32Array(s));
}

test('a finely rounded corner is its own face: the top, the bottom, the sides and the corners come apart', () => {
  // 16 segments a quarter turn is 5.6° a step, which a neighbour-to-neighbour 25° test never breaks
  const { faces } = buildFaces(roundedPlate(100, 60, 12, 6, 16));
  assert.eq(faces.length, 10, `faces: ${faces.map((f) => f.length)}`);
  const sizes = faces.map((f) => f.length).sort((a, b) => a - b);
  assert.eq(sizes[sizes.length - 1], 68, 'the top is the whole top');
  assert.eq(sizes.filter((n) => n === 32).length, 4, 'four corners, each one face');
});

test('a bore stays one face however many triangles it has, and a cone does too', () => {
  const ring = buildFaces(makeRevolved([[10, 0], [30, 0], [30, 12], [10, 12], [10, 0]], 96));
  // outer wall, inner wall, top, bottom
  assert.eq(ring.faces.length, 4, `ring faces: ${ring.faces.map((f) => f.length)}`);
  const cone = buildFaces(makeRevolved([[10, 0], [30, 0], [22, 12], [10, 12], [10, 0]], 96));
  assert.eq(cone.faces.length, 4, `cone faces: ${cone.faces.map((f) => f.length)}`);
});

test('the footprint of a wall of many slivers is the band round its line, however many slivers there are', () => {
  // 400 segments a corner: every wall triangle is a sliver of about 0.1mm
  const mesh = roundedPlate(100, 60, 12, 6, 400);
  const { faces } = buildFaces(mesh);
  const bySize = faces.map((f, i) => [f.length, i]).sort((a, b) => b[0] - a[0]);
  // at 400 segments a corner turns under half a degree a step: the sides and the corners are one smooth wall
  const walls = [bySize[0][1]];
  const loops = faceFootprint(mesh, faces, walls, { wallBand: 1 });
  // the band is a ring: its outer loop and its hole wind opposite ways, so the signed areas subtract
  const area = Math.abs(loops.reduce((sum, l) => sum + loopArea(l), 0));
  // the outline is 2 x (88 + 48) + 2 pi 6 round, and the band is 2mm wide on it
  const perimeter = 2 * (88 + 48) + 2 * Math.PI * 6;
  assert.close(area, perimeter * 2, perimeter * 2 * 0.03, 'the band, not a sliver of it');
});
