import { test, assert } from './runner.js';
import { weld, meshFromSoup, computeBounds, dropDegenerate } from '../geom/mesh.js';

// Two triangles sharing an edge: quad (0,0,0)-(10,0,0)-(10,10,0)-(0,10,0)
const QUAD_SOUP = new Float32Array([
  0, 0, 0, 10, 0, 0, 10, 10, 0,
  0, 0, 0, 10, 10, 0, 0, 10, 0,
]);

test('weld merges shared vertices', () => {
  const mesh = weld(QUAD_SOUP);
  assert.eq(mesh.positions.length / 3, 4, 'unique vertices');
  assert.eq(mesh.indices.length, 6);
});

test('weld tolerance merges near-coincident vertices', () => {
  const soup = new Float32Array(QUAD_SOUP);
  soup[9] += 1e-7; // nudge the duplicated (0,0,0)
  assert.eq(weld(soup, 1e-5).positions.length / 3, 4);
});

test('dropDegenerate removes collapsed triangles', () => {
  const mesh = { positions: new Float32Array(9), indices: new Uint32Array([0, 0, 1, 0, 1, 2]) };
  assert.eq(dropDegenerate(mesh).indices.length, 3);
});

test('meshFromSoup produces unit normals', () => {
  const mesh = meshFromSoup(QUAD_SOUP);
  assert.close(mesh.normals[2], 1, 1e-6, 'flat quad normal is +Z');
});

test('computeBounds', () => {
  const { min, max } = computeBounds(QUAD_SOUP);
  assert.eq(min[0], 0); assert.eq(max[0], 10); assert.eq(max[2], 0);
});
