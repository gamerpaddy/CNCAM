import { test, assert } from './runner.js';
import { cross, dot, normalize, len, dist, lerp } from '../geom/math.js';

test('cross product follows right-hand rule', () => {
  const [x, y, z] = cross([1, 0, 0], [0, 1, 0]);
  assert.eq(x, 0); assert.eq(y, 0); assert.eq(z, 1);
});

test('dot of perpendicular vectors is zero', () => {
  assert.eq(dot([1, 0, 0], [0, 1, 0]), 0);
});

test('normalize produces unit length', () => {
  assert.close(len(normalize([3, 4, 0])), 1);
});

test('normalize of zero vector is zero, not NaN', () => {
  const n = normalize([0, 0, 0]);
  assert.eq(n[0], 0); assert.eq(n[1], 0); assert.eq(n[2], 0);
});

test('dist and lerp', () => {
  assert.close(dist([0, 0, 0], [3, 4, 0]), 5);
  const m = lerp([0, 0, 0], [10, 20, 30], 0.5);
  assert.close(m[0], 5); assert.close(m[1], 10); assert.close(m[2], 15);
});
