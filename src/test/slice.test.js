import { test, assert } from './runner.js';
import { sliceMeshZ } from '../geom/slice.js';
import { loopArea, loopsBounds, unionLoops } from '../geom/clipper.js';
import { makeBox, makePocketBlock, makeTube, makeStepped } from './fixtures.js';

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

// A slice reads the winding: `geom/slice.js` orients every segment by its
// triangle's normal, so an outer comes out one way round and a hole the other,
// and `unionLoops` then subtracts the hole under non-zero fill. Give it a mesh
// whose faces do not agree about which way is out and both loops come back the
// same way round — the hole is swallowed by the fill and the slice measures
// solid where the part has a void.
//
// Which is what the fixtures did. Three faces of every box were wound inward,
// so a box's signed volume came out 8000 where the box is 24000, and the pocket
// block sliced above its floor measured 1600mm² against the part's 1200. It
// never broke a strategy — the drill finds its holes whatever the winding,
// checked by flipping every triangle of a tube — but it meant the whole suite
// was proving the engine against meshes no CAD system would produce.
function windingOf(mesh) {
  const { positions: p, indices: ix } = mesh;
  let volume = 0;
  const edges = new Map();
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3;
    const b = ix[t + 1] * 3;
    const c = ix[t + 2] * 3;
    volume += (p[a] * (p[b + 1] * p[c + 2] - p[c + 1] * p[b + 2])
      - p[a + 1] * (p[b] * p[c + 2] - p[c] * p[b + 2])
      + p[a + 2] * (p[b] * p[c + 1] - p[c] * p[b + 1])) / 6;
    for (const [u, v] of [[ix[t], ix[t + 1]], [ix[t + 1], ix[t + 2]], [ix[t + 2], ix[t]]]) {
      const key = `${u}>${v}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  // An edge traversed twice the SAME way is two faces disagreeing about which
  // side the metal is on. (Traversed once only is a T-junction in the
  // tessellation, which is untidy but says nothing about orientation.)
  let disagreeing = 0;
  for (const n of edges.values()) if (n > 1) disagreeing += n - 1;
  return { volume, disagreeing };
}

test('the test meshes are wound outward, which is what a slice reads', () => {
  for (const [name, mesh, volume] of [
    ['a box', makeBox(40, 30, 20), 24000],
    // 40x40x20 less a 20x20 pocket 10 deep
    ['a pocket block', makePocketBlock({ size: 40, pocketSize: 20, height: 20, depth: 10 }).mesh, 28000],
    // a 40x40x10 plate under a 20x20x10 boss, as two boxes
    ['a stepped block', makeStepped({ base: 40, top: 20, baseHeight: 10, topHeight: 10 }).mesh, 20000],
  ]) {
    const { volume: got, disagreeing } = windingOf(mesh);
    assert.eq(disagreeing, 0, `${name}: ${disagreeing} edges have two faces disagreeing which way is out`);
    assert.close(got, volume, volume * 0.01,
      `${name}: signed volume ${got.toFixed(0)} — an inward face subtracts instead of adding`);
  }
});

test('and so a pocket slices as a hole rather than as solid', () => {
  const block = makePocketBlock({ size: 40, pocketSize: 20, height: 20, depth: 10 });
  const loops = sliceMeshZ(block.mesh, 15);          // above the pocket floor
  assert.eq(loops.length, 2, 'the outline and the pocket mouth');
  // opposite signs: that is what makes one of them a hole
  const areas = loops.map(loopArea);
  assert.ok(areas[0] * areas[1] < 0,
    `outer and hole must be wound opposite ways, got ${areas.map((a) => a.toFixed(0)).join(' and ')}`);
  const filled = unionLoops(loops).reduce((sum, l) => sum + loopArea(l), 0);
  assert.close(Math.abs(filled), 1200, 1,
    `40x40 less the 20x20 pocket is 1200mm², not ${Math.abs(filled).toFixed(0)}`);
});

test('a tube slices the same way, hole and all', () => {
  const loops = sliceMeshZ(makeTube(20, 20, 18, 6, 20, 64), 10);
  assert.eq(loops.length, 2);
  const areas = loops.map(loopArea);
  assert.ok(areas[0] * areas[1] < 0, 'outer and bore wound opposite ways');
  const filled = Math.abs(unionLoops(loops).reduce((sum, l) => sum + loopArea(l), 0));
  assert.close(filled, Math.PI * (18 * 18 - 6 * 6), 6, `an annulus, not a disc: ${filled.toFixed(0)}`);
});
