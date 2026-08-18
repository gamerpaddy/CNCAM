// Making a part look like a part: crease normals and the edges they imply.
//
// The bug these exist for is not a crash. It is a viewport where a machined
// block and a beach ball shade identically, because every face normal at a
// vertex was averaged with every other regardless of the angle between them.

import { test, assert } from './runner.js';
import { creaseNormals, creaseEdges } from '../geom/shading.js';
import { computeNormals } from '../geom/mesh.js';
import { makeBox, makeTube, makeRamp } from './fixtures.js';

/** Every normal in the buffer, as [x, y, z]. */
function normalsOf(shaded) {
  const out = [];
  for (let i = 0; i < shaded.normals.length; i += 3) {
    out.push([shaded.normals[i], shaded.normals[i + 1], shaded.normals[i + 2]]);
  }
  return out;
}

function isAxisAligned([x, y, z]) {
  const axes = [Math.abs(x), Math.abs(y), Math.abs(z)].sort((a, b) => b - a);
  return axes[0] > 0.999 && axes[1] < 0.001;
}

test('a block keeps its corners instead of shading like a balloon', () => {
  const box = makeBox(40, 30, 20);
  const shaded = creaseNormals(box);
  const normals = normalsOf(shaded);
  assert.eq(normals.length, box.indices.length, 'one normal per triangle corner');
  for (const n of normals) {
    assert.ok(isAxisAligned(n), `a face of a box points along an axis, not ${n.map((v) => v.toFixed(2))}`);
  }

  // and this is the difference: the smoothed normals it arrives with do not
  const smoothed = computeNormals(box).normals;
  let bulged = 0;
  for (let i = 0; i < smoothed.length; i += 3) {
    if (!isAxisAligned([smoothed[i], smoothed[i + 1], smoothed[i + 2]])) bulged++;
  }
  assert.ok(bulged > 0, 'the plain average really does round the corners off');
});

test('a curved surface stays smooth — this is not just flat shading', () => {
  const tube = makeTube(0, 0, 20, 10, 15, 48);
  const shaded = creaseNormals(tube);
  const flat = creaseNormals(tube, { creaseDeg: 0.1 });
  // On the wall of a 48-sided tube, neighbouring facets are 7.5° apart, so they
  // are one surface. Averaged, the corner normals of a facet differ from each
  // other; faceted, they are identical.
  const varies = (mesh) => {
    let n = 0;
    for (let f = 0; f < mesh.normals.length / 9; f++) {
      const at = f * 9;
      const same = [1, 2].every((k) => [0, 1, 2].every(
        (c) => Math.abs(mesh.normals[at + c] - mesh.normals[at + k * 3 + c]) < 1e-6));
      if (!same) n++;
    }
    return n;
  };
  assert.ok(varies(shaded) > 20, `only ${varies(shaded)} triangles are smooth-shaded`);
  assert.eq(varies(flat), 0, 'and at a zero crease angle everything is faceted');
});

test('every crease normal is a unit vector, whatever the mesh', () => {
  for (const mesh of [makeBox(10, 10, 10), makeTube(0, 0, 8, 4, 6), makeRamp()]) {
    for (const n of normalsOf(creaseNormals(mesh))) {
      assert.close(Math.hypot(...n), 1, 1e-5, `not unit length: ${n}`);
    }
  }
});

test('the crease edges of a box are its twelve edges, and not its diagonals', () => {
  const edges = creaseEdges(makeBox(40, 30, 20));
  assert.eq(edges.length / 6, 12, `expected 12 edges, got ${edges.length / 6}`);
  // every one of them runs along an axis, which the face diagonals do not
  for (let i = 0; i < edges.length; i += 6) {
    const d = [edges[i + 3] - edges[i], edges[i + 4] - edges[i + 1], edges[i + 5] - edges[i + 2]];
    const moving = d.filter((v) => Math.abs(v) > 1e-6).length;
    assert.eq(moving, 1, `a box edge runs along one axis, not ${d}`);
  }
});

test('a tube shows its rims and not the facets of its wall', () => {
  const segments = 48;
  const edges = creaseEdges(makeTube(0, 0, 20, 10, 15, segments));
  const count = edges.length / 6;
  // four rims of `segments` each: outside top and bottom, inside top and bottom
  assert.eq(count, segments * 4, `expected the four rims, got ${count} segments`);
  // nothing vertical: a wall facet boundary is not an edge at 7.5°
  for (let i = 0; i < edges.length; i += 6) {
    assert.close(edges[i + 5], edges[i + 2], 1e-6, 'every drawn edge lies in a Z plane');
  }
});

test('the crease angle is what decides, and it can be turned all the way down', () => {
  const segments = 48;
  const tube = makeTube(0, 0, 20, 10, 15, segments);
  const vertical = (deg) => {
    const edges = creaseEdges(tube, { creaseDeg: deg });
    let n = 0;
    for (let i = 0; i < edges.length; i += 6) {
      if (Math.abs(edges[i + 5] - edges[i + 2]) > 1e-6) n++;
    }
    return n;
  };
  // the wall facets are 7.5° apart: an edge below that threshold, one surface above
  assert.eq(vertical(60), 0, 'a gentle crease sees the wall as one round surface');
  assert.eq(vertical(1), segments * 2, 'a strict one sees every facet, inside and out');
});
