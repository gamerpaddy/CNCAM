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
