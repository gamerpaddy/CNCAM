// Where an imported model lands: at the origin, and beside what is there.

import { test, assert } from './runner.js';
import { computeBounds } from '../geom/mesh.js';
import { placeImport, IMPORT_GAP } from '../engine/placement.js';
import { makeBox } from './fixtures.js';

/** A box mesh whose lowest corner is at (x, y, z) — a model drawn far from its origin. */
function boxAt(x, y, z, w = 20, d = 10, h = 5) {
  const m = makeBox(w, d, h);
  const b = computeBounds(m.positions);
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) { p[i] += x - b.min[0]; p[i + 1] += y - b.min[1]; p[i + 2] += z - b.min[2]; }
  return m;
}

test('the first model comes in centred on X0 Y0 with its lowest point on Z0, shape unchanged', () => {
  const m = boxAt(-250, -540, -23);
  const before = [...m.indices];
  const said = placeImport([m], []);
  const b = computeBounds(m.positions);
  assert.close((b.min[0] + b.max[0]) / 2, 0, 1e-4);
  assert.close((b.min[1] + b.max[1]) / 2, 0, 1e-4);
  assert.close(b.min[2], 0, 1e-4);
  assert.close(b.max[0] - b.min[0], 20, 1e-4);
  assert.eq(JSON.stringify([...m.indices]), JSON.stringify(before), 'the triangles are the same triangles');
  assert.ok(/X0 Y0 Z0/.test(said), said);
});

test('a second model is set down beside the first, clear of it, and the first does not move', () => {
  const a = boxAt(100, 100, 0);
  placeImport([a], []);
  const aBefore = computeBounds(a.positions);
  const b = boxAt(5000, -300, 40, 30, 8, 5);
  placeImport([b], [a]);
  const ab = computeBounds(a.positions);
  const bb = computeBounds(b.positions);
  assert.eq(JSON.stringify(ab), JSON.stringify(aBefore), 'the first stays where it was');
  assert.close(bb.min[0] - ab.max[0], IMPORT_GAP, 1e-3, 'a gap, not an overlap');
  assert.close((bb.min[1] + bb.max[1]) / 2, (ab.min[1] + ab.max[1]) / 2, 1e-3, 'on the same centreline');
  assert.close(bb.min[2], ab.min[2], 1e-3, 'on the same floor');
});

test('the bodies of one file move together and keep their distance from each other', () => {
  const p = boxAt(300, 300, 10);
  const q = boxAt(340, 310, 12);
  const gap = computeBounds(q.positions).min[0] - computeBounds(p.positions).max[0];
  placeImport([p, q], []);
  const gap2 = computeBounds(q.positions).min[0] - computeBounds(p.positions).max[0];
  assert.close(gap2, gap, 1e-4);
  const all = computeBounds(new Float32Array([...p.positions, ...q.positions]));
  assert.close((all.min[0] + all.max[0]) / 2, 0, 1e-3);
  assert.close(all.min[2], 0, 1e-4);
});

test('a model already at the origin does not move, and nothing to place is not an error', () => {
  const m = boxAt(-10, -5, 0);
  assert.eq(placeImport([m], []), null);
  assert.eq(placeImport([], []), null);
  assert.eq(placeImport([{ positions: new Float32Array(0), indices: new Uint32Array(0) }], []), null);
});
