import { test, assert } from './runner.js';
import { offsetLoops, unionLoops, loopArea, loopsBounds } from '../geom/clipper.js';

const SQUARE = [0, 0, 1, 0, 1, 1, 0, 1]; // unit square, CCW

test('offset square outward by 1 (round joins)', () => {
  const out = offsetLoops([SQUARE], 1);
  assert.eq(out.length, 1);
  // area = 1 + perimeter*1 + pi*1^2
  assert.close(Math.abs(loopArea(out[0])), 5 + Math.PI, 0.05);
  const b = loopsBounds(out);
  assert.close(b.min[0], -1, 1e-3);
  assert.close(b.max[0], 2, 1e-3);
});

test('offset square inward shrinks it', () => {
  const out = offsetLoops([SQUARE], -0.25);
  assert.eq(out.length, 1);
  assert.close(Math.abs(loopArea(out[0])), 0.25, 1e-3);
});

test('offset inward past collapse yields nothing', () => {
  assert.eq(offsetLoops([SQUARE], -0.6).length, 0);
});

test('union of overlapping squares is one loop', () => {
  const shifted = [0.5, 0, 1.5, 0, 1.5, 1, 0.5, 1];
  const out = unionLoops([SQUARE, shifted]);
  assert.eq(out.length, 1);
  assert.close(Math.abs(loopArea(out[0])), 1.5, 1e-6);
});

test('offset handles reversed (CW) input the same', () => {
  const cw = [0, 0, 0, 1, 1, 1, 1, 0];
  const out = offsetLoops([cw], 1);
  assert.eq(out.length, 1);
  assert.close(Math.abs(loopArea(out[0])), 5 + Math.PI, 0.05);
});
