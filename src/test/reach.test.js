// Reachability: a 3-axis cutter is blocked by everything above its tip, not
// just by the part's cross-section at the current depth. These tests pin the
// overhang case, where planning from a bare slice used to put cuts under the
// overhang where the tool can never get.

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { eachMove, OP, FEED } from '../engine/cl.js';
import { silhouetteAbove, projectTriangleBand, SilhouetteStack } from '../geom/silhouette.js';
import { loopsBounds, loopArea } from '../geom/clipper.js';
import { makeBox, makeMushroom, makePocketBlock, makeTube } from './fixtures.js';

const TOOL = {
  number: 1, diameter: 6, spindleRpm: 10000, feedCut: 800, feedPlunge: 300,
};

/** Distance from a point to a rect; 0 when inside. */
function distToRect([x, y], rect) {
  const dx = Math.max(rect.min[0] - x, 0, x - rect.max[0]);
  const dy = Math.max(rect.min[1] - y, 0, y - rect.max[1]);
  return Math.hypot(dx, dy);
}

// --- silhouette primitives ---

test('projectTriangleBand clips to the slab and drops what is outside', () => {
  const tri = [[0, 0, 0], [10, 0, 0], [0, 10, 10]];
  assert.eq(projectTriangleBand(tri, 20, Infinity), null, 'entirely below the slab');
  const full = projectTriangleBand(tri, -5, Infinity);
  assert.close(Math.abs(loopArea(full)), 50, 1e-3, 'unclipped area');
  const half = projectTriangleBand(tri, 5, Infinity);
  assert.ok(Math.abs(loopArea(half)) < 50, 'clipped band is smaller');
});

test('silhouette of a box is its footprint at every depth', () => {
  const mesh = makeBox(20, 30, 10);
  for (const z of [9, 5, 0.5]) {
    const b = loopsBounds(silhouetteAbove(mesh, z));
    assert.close(b.min[0], 0, 1e-3, `z=${z} minX`);
    assert.close(b.max[0], 20, 1e-3, `z=${z} maxX`);
    assert.close(b.max[1], 30, 1e-3, `z=${z} maxY`);
  }
});

test('silhouette below an overhang is the cap, not the post', () => {
  const { mesh, cap } = makeMushroom();
  // z=5 is halfway up the post; the cross-section there is the 10mm post, but
  // the shadow is the 30mm cap above it
  const b = loopsBounds(silhouetteAbove(mesh, 5));
  assert.close(b.min[0], cap.min[0], 1e-3, 'minX matches cap');
  assert.close(b.max[0], cap.max[0], 1e-3, 'maxX matches cap');
  assert.close(b.min[1], cap.min[1], 1e-3, 'minY matches cap');
  assert.close(b.max[1], cap.max[1], 1e-3, 'maxY matches cap');
});

test('silhouette complexity stays bounded as it descends', () => {
  // The regression this guards: real meshes are mostly near-vertical wall
  // triangles, whose projections are hairline slivers. Accumulating them across
  // levels grew the union without limit, and offsetting a few thousand slivers
  // with round joins took minutes — the strategy looked like it had hung.
  const { mesh } = makeMushroom({ postSize: 12, capSize: 30, postHeight: 20, capHeight: 6 });
  const stack = new SilhouetteStack(mesh, { tolerance: 0.01 });

  let worstLoops = 0;
  let worstVerts = 0;
  for (let z = 25; z >= 0; z -= 0.5) {
    const loops = stack.down(z);
    worstLoops = Math.max(worstLoops, loops.length);
    worstVerts = Math.max(worstVerts, loops.reduce((n, l) => n + l.length / 2, 0));
  }
  // the true silhouette here is one rectangle; anything near it is fine,
  // hundreds of loops means slivers are piling up again
  assert.ok(worstLoops <= 8, `silhouette fragmented into ${worstLoops} loops`);
  assert.ok(worstVerts <= 200, `silhouette grew to ${worstVerts} vertices`);
});

test('a wall of vertical triangles contributes no sliver loops', () => {
  // a vertical face casts no shadow: its projection is a line, not an area
  const wall = [[0, 0, 0], [10, 0, 0], [10, 0, 5]];
  assert.eq(projectTriangleBand(wall, -1, Infinity, 1e-4), null, 'dropped as degenerate');
  // but a sloped face genuinely does project, and must survive
  const slope = [[0, 0, 0], [10, 0, 0], [10, 4, 5]];
  assert.ok(projectTriangleBand(slope, -1, Infinity, 1e-4), 'sloped face kept');
});

// --- strategies must not plan under the overhang ---

test('clear2d keeps the cutter clear of the overhanging cap', () => {
  const { mesh, cap, postHeight, capHeight } = makeMushroom();
  const cl = generateToolpath({
    type: 'clear2d', name: 'rough', tool: TOOL, mesh,
    stock: { min: [0, 0, 0], max: [40, 40, postHeight + capHeight] },
    params: {
      topZ: postHeight + capHeight, bottomZ: 0, stepdown: 2, stepover: 0.5,
      clearanceHeight: 20, stockToLeave: 0, rampAngle: 0, tolerance: 0.01,
    },
  });

  const r = TOOL.diameter / 2;
  let cuts = 0;
  let worst = Infinity;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE || feed === FEED.RAPID) return;
    cuts++;
    worst = Math.min(worst, distToRect([x, y], cap));
  });

  assert.ok(cuts > 0, 'produced cutting moves');
  // every cut point must sit at least a tool radius away from the cap footprint
  assert.ok(worst > r - 0.05, `cut ${worst.toFixed(3)}mm from cap, need >= ${r}`);
});

test('contour2d follows the overhang shadow, not the narrow post', () => {
  const { mesh, cap, postHeight, capHeight } = makeMushroom();
  const cl = generateToolpath({
    type: 'contour2d', name: 'outline', tool: TOOL, mesh,
    params: {
      topZ: postHeight + capHeight, bottomZ: 0, stepdown: 2,
      clearanceHeight: 20, stockToLeave: 0, rampAngle: 0, tolerance: 0.01,
    },
  });

  const r = TOOL.diameter / 2;
  let worst = Infinity;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE || feed === FEED.RAPID) return;
    worst = Math.min(worst, distToRect([x, y], cap));
  });
  assert.ok(worst > r - 0.05, `contour ran ${worst.toFixed(3)}mm from cap`);
});

test('clear2d on a plain box still reaches the part wall', () => {
  // the reachability fix must not make cuts overly conservative on simple parts
  const part = { min: [10, 10], max: [30, 30] };
  const cl = generateToolpath({
    type: 'clear2d', name: 'rough', tool: TOOL,
    mesh: (() => {
      const { mesh } = makeMushroom({ postSize: 20, capSize: 20, center: [20, 20] });
      return mesh;
    })(),
    stock: { min: [0, 0, 0], max: [40, 40, 15] },
    params: {
      topZ: 15, bottomZ: 0, stepdown: 5, stepover: 0.5,
      clearanceHeight: 20, stockToLeave: 0, rampAngle: 0, tolerance: 0.01,
    },
  });
  const r = TOOL.diameter / 2;
  let closest = Infinity;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE || feed === FEED.RAPID) return;
    closest = Math.min(closest, distToRect([x, y], part));
  });
  // a straight-walled part: the tool should come right up to radius distance
  assert.ok(closest < r + 0.2, `expected a wall pass near the part, got ${closest.toFixed(3)}`);
  assert.ok(closest > r - 0.05, 'but never inside the part');
});

// --- a rim written with a T-junction ----------------------------------------
//
// The pocket block's top face is four strips round the mouth of the pocket, and
// the long strips run past the ends of the short ones: the corner of the mouth
// is a vertex on the edge of a strip that does not have it. Fine while the
// coordinates are exact. Turn the mesh - which is what a setup's rotation does,
// vertex by vertex, rounding each to float32 - and the corner lands a few
// nanometres off the edge it was on, the strips no longer meet, and the union
// keeps them apart: the rim is three pieces and the pocket is a notch in
// the outline, not a hole in it. Nothing downstream finds a hole that is not
// there.

/** The mesh turned about Z, every vertex rounded on its own as a setup does. */
function turnMesh(mesh, degrees) {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = mesh.positions[i];
    const y = mesh.positions[i + 1];
    positions[i] = x * c - y * s;
    positions[i + 1] = x * s + y * c;
    positions[i + 2] = mesh.positions[i + 2];
  }
  return { ...mesh, positions };
}

test('a pocket rim written with a T-junction is still a ring after the mesh is turned', () => {
  const { mesh } = makePocketBlock({ size: 40, pocketSize: 20, height: 20, depth: 10 });
  for (const degrees of [0, 17, 30, 45, 60, 82.5, 123, 200]) {
    const loops = silhouetteAbove(turnMesh(mesh, degrees), 15);
    const holes = loops.filter((loop) => loopArea(loop) < 0);
    assert.eq(loops.length, 2, `${degrees}°: the outline and the pocket, got ${loops.length} loops`);
    assert.eq(holes.length, 1, `${degrees}°: and the pocket is a hole`);
    const filled = loops.reduce((sum, loop) => sum + loopArea(loop), 0);
    assert.close(filled, 1200, 0.01, `${degrees}°: 40x40 less the 20x20 pocket`);
  }
});

test('a pocket in a mesh with a T-junction is found however the part is turned', () => {
  const block = makePocketBlock({ size: 40, pocketSize: 20, height: 20, depth: 10 });
  const cutters = { ...TOOL, diameter: 4, fluteLength: 20 };
  for (const degrees of [0, 30, 60, 82.5]) {
    const mesh = turnMesh(block.mesh, degrees);
    let lo = [Infinity, Infinity];
    let hi = [-Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      lo = [Math.min(lo[0], mesh.positions[i]), Math.min(lo[1], mesh.positions[i + 1])];
      hi = [Math.max(hi[0], mesh.positions[i]), Math.max(hi[1], mesh.positions[i + 1])];
    }
    const cl = generateToolpath({
      type: 'pocket', name: 'pocket', tool: cutters, mesh,
      stock: { min: [lo[0], lo[1], 0], max: [hi[0], hi[1], 20] },
      params: {
        topZ: 20, bottomZ: block.floorZ, stepdown: 3, stepover: 0.5, clearanceHeight: 30,
        stockToLeave: 0, tolerance: 0.01, leadType: 'none', direction: 'climb', rampAngle: 0,
      },
    });
    assert.ok(cl.count > 100, `${degrees}°: the pocket is cut (${cl.count} moves) - ${JSON.stringify(cl.notes)}`);
  }
});

test('only a mesh with an edge that is not shared by two triangles is healed', () => {
  // A closed mesh whose triangles all meet edge to edge has nowhere for a crack
  // to be, so its silhouette is left exactly as the union made it - and the
  // healing, which grows and shrinks the loops, costs it nothing.
  assert.eq(new SilhouetteStack(makeTube(0, 0, 20, 8, 15, 48), { tolerance: 0.01 }).crack, 0, 'a tube');
  assert.eq(new SilhouetteStack(makeBox(30, 20, 10), { tolerance: 0.01 }).crack, 0, 'a box');
  assert.ok(new SilhouetteStack(makePocketBlock().mesh, { tolerance: 0.01 }).crack > 0,
    'a rim with T-junctions is not');
});

test('healing leaves a ring that was never cracked exactly as it was', () => {
  // Growing a polygon and shrinking it back gives the same polygon to within a
  // grid step, and not the same vertices: a toolpath that starts where its ring
  // does would start somewhere else, and every pocket in a job would move by
  // nanometres for nothing. Only a crack that was really closed takes the
  // healed loops.
  const { mesh } = makePocketBlock({ size: 40, pocketSize: 20, height: 20, depth: 10 });
  const loops = silhouetteAbove(mesh, 15);
  assert.eq(loops.length, 2, 'the outline and the pocket');
  const on = (v) => [0, 10, 30, 40].some((edge) => Math.abs(v - edge) < 1e-9);
  assert.ok(loops.every((loop) => loop.every(on)),
    `every corner is where the model put it: ${JSON.stringify(loops)}`);
});
