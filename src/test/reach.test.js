// Reachability: a 3-axis cutter is blocked by everything above its tip, not
// just by the part's cross-section at the current depth. These tests pin the
// overhang case, where planning from a bare slice used to put cuts under the
// overhang where the tool can never get.

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { eachMove, OP, FEED } from '../engine/cl.js';
import { silhouetteAbove, projectTriangleBand, SilhouetteStack } from '../geom/silhouette.js';
import { loopsBounds, loopArea } from '../geom/clipper.js';
import { makeBox, makeMushroom } from './fixtures.js';

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
