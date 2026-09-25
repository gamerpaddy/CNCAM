import { test, assert } from './runner.js';
import { parseOBJ } from '../io/obj.js';

test('OBJ triangle', () => {
  const p = parseOBJ('v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n');
  assert.eq(p.length, 9);
  assert.close(p[3], 10);
});

test('OBJ quad fan-triangulates', () => {
  const p = parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n');
  assert.eq(p.length / 9, 2);
});

test('OBJ negative and slash indices', () => {
  const p = parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3/1 -2/2 -1/3\n');
  assert.eq(p.length, 9);
  assert.close(p[3], 1);
});

test('OBJ faces may name vertices further down the file, and never make NaN', () => {
  // Resolved as they were read, a corner naming a later vertex came out NaN —
  // and one NaN is a model with no bounds and a stock with no size.
  const later = parseOBJ('v 0 0 0\nv 1 0 0\nf 1 2 3\nv 0 1 0\n');
  assert.eq(later.length, 9, 'the face is there');
  assert.ok([...later].every(Number.isFinite), 'with every corner a number');
  assert.close(later[7], 1, 1e-9, 'and the third corner is the vertex it named');

  const outOfRange = parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n');
  assert.eq(outOfRange.length, 0, 'a face naming a vertex that does not exist is dropped');

  const tabbed = parseOBJ('v\t0 0 0\nv\t1 0 0\nv\t0 1 0\nf\t1 2 3\n');
  assert.eq(tabbed.length, 9, 'tab-separated lines are lines');
});
