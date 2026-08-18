import { test, assert } from './runner.js';
import { sliceMeshZ } from '../geom/slice.js';
import { loopArea, loopsBounds, unionLoops } from '../geom/clipper.js';
import { makeBox } from './fixtures.js';

test('slicing a box mid-height gives one square loop', () => {
  const loops = sliceMeshZ(makeBox(10, 10, 5), 2.5);
  assert.eq(loops.length, 1);
  assert.close(Math.abs(loopArea(loops[0])), 100, 0.1);
  const b = loopsBounds(loops);
  assert.close(b.min[0], 0, 1e-3);
  assert.close(b.max[1], 10, 1e-3);
});

test('slice above/below the box is empty', () => {
  const box = makeBox(10, 10, 5);
  assert.eq(sliceMeshZ(box, 6).length, 0);
  assert.eq(sliceMeshZ(box, -1).length, 0);
});

test('slice loops survive unionLoops normalization', () => {
  const loops = unionLoops(sliceMeshZ(makeBox(4, 6, 2), 1));
  assert.eq(loops.length, 1);
  assert.close(Math.abs(loopArea(loops[0])), 24, 0.1);
});
