import { test, assert } from './runner.js';
import { generateToolpath, toolpathStats } from '../engine/toolpath.js';
import { eachMove, OP, FEED, MOVE_STRIDE } from '../engine/cl.js';
import { orientLoop, leadInPoints } from '../engine/leads.js';
import { loopArea } from '../geom/clipper.js';
import { buildHeightmap, buildToolKernel, dropCutter, clearanceProfile } from '../geom/heightmap.js';
import { buildFaces, faceFootprint } from '../geom/faces.js';
import { pointInLoops } from '../geom/inside.js';
import { makeBox, makeMushroom, makePocketBlock, makeStepped, makeRamp } from './fixtures.js';
import { profileSteps } from '../engine/strategies/waterline.js';

const TOOL = { number: 1, diameter: 6, type: 'flat', spindleRpm: 10000, feedCut: 800, feedPlunge: 300 };
const BALL = { ...TOOL, type: 'ball' };

// --- cut direction & leads ---

test('climb runs an outer boundary clockwise, conventional counter-clockwise', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10]; // CCW
  assert.ok(loopArea(orientLoop(square, 'climb', false)) < 0, 'climb outer is CW');
  assert.ok(loopArea(orientLoop(square, 'conventional', false)) > 0, 'conventional outer is CCW');
});

test('a hole reverses the direction sense', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  const outer = orientLoop(square, 'climb', false);
  const hole = orientLoop(square, 'climb', true);
  assert.ok(loopArea(outer) * loopArea(hole) < 0, 'hole runs opposite to the outer');
});

test('arc lead-in approaches the start point from off the path', () => {
  const square = [0, 0, 20, 0, 20, 20, 0, 20];
  const pts = leadInPoints(square, { type: 'arc', radius: 3 });
  assert.ok(pts.length > 1, 'arc is polylined');
  const last = pts[pts.length - 1];
  assert.close(Math.hypot(last[0] - 0, last[1] - 0), 0, 0.2, 'ends on the loop start');
  const first = pts[0];
  assert.ok(Math.hypot(first[0], first[1]) > 1, 'starts clear of the wall');
});

test('lead type none produces no lead', () => {
  assert.eq(leadInPoints([0, 0, 10, 0, 10, 10], { type: 'none', radius: 5 }).length, 0);
  assert.eq(leadInPoints([0, 0, 10, 0, 10, 10], { type: 'arc', radius: 0 }).length, 0);
});

test('contour with leads emits LEAD moves and still closes the profile', () => {
  const cl = generateToolpath({
    type: 'contour2d', name: 'c', tool: TOOL, mesh: makeBox(30, 30, 10),
    params: {
      topZ: 10, bottomZ: 0, stepdown: 5, clearanceHeight: 20, stockToLeave: 0,
      rampAngle: 0, tolerance: 0.01, leadType: 'arc', leadRadius: 2, direction: 'climb',
    },
  });
  let leads = 0;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => { if (feed === FEED.LEAD) leads++; });
  assert.ok(leads > 0, 'lead moves present');
});

test('finish passes add extra passes only when stock is left', () => {
  const base = {
    type: 'contour2d', name: 'c', tool: TOOL, mesh: makeBox(30, 30, 10),
    params: {
      topZ: 10, bottomZ: 0, stepdown: 5, clearanceHeight: 20,
      rampAngle: 0, tolerance: 0.01, leadType: 'none', direction: 'climb',
    },
  };
  const plain = generateToolpath({ ...base, params: { ...base.params, stockToLeave: 0.5, finishPasses: 0 } });
  const finished = generateToolpath({ ...base, params: { ...base.params, stockToLeave: 0.5, finishPasses: 2 } });
  assert.ok(finished.count > plain.count, 'finish passes add motion');

  const noAllowance = generateToolpath({ ...base, params: { ...base.params, stockToLeave: 0, finishPasses: 2 } });
  const noneAtAll = generateToolpath({ ...base, params: { ...base.params, stockToLeave: 0, finishPasses: 0 } });
  assert.eq(noAllowance.count, noneAtAll.count, 'nothing to finish when no stock is left');
});

// --- heightmap / drop cutter ---

test('clearance profile matches the cutter shape', () => {
  assert.eq(clearanceProfile({ type: 'flat', diameter: 6 })(3), 0, 'flat is flat');
  const ball = clearanceProfile({ type: 'ball', diameter: 6 });
  assert.close(ball(0), 0, 1e-9, 'ball tip touches at the centre');
  assert.close(ball(3), 3, 1e-6, 'ball rises by its radius at the edge');
  const bull = clearanceProfile({ type: 'bull', diameter: 10, cornerRadius: 2 });
  assert.eq(bull(2), 0, 'flat within the corner radius');
  assert.close(bull(5), 2, 1e-6, 'rounded at the rim');
});

test('drop cutter rests a flat tool on a flat top', () => {
  const mesh = makeBox(40, 40, 10);
  const map = buildHeightmap(mesh, { cellSize: 0.5 });
  const kernel = buildToolKernel(TOOL, map.cellSize);
  assert.close(dropCutter(map, kernel, 20, 20), 10, 1e-3, 'sits on the top face');
});

test('drop cutter is blocked by a taller neighbour within the tool radius', () => {
  // the cap overhangs the post, so a tool near the cap edge cannot drop to the
  // lower surface — its body would be inside the cap
  const { mesh, cap, postHeight, capHeight } = makeMushroom();
  const map = buildHeightmap(mesh, { cellSize: 0.4 });
  const kernel = buildToolKernel(TOOL, map.cellSize);

  const onCap = dropCutter(map, kernel, 20, 20);
  assert.close(onCap, postHeight + capHeight, 0.1, 'rests on the cap top');

  // 2mm outside the cap edge: within the 3mm tool radius, so still blocked
  const justOutside = dropCutter(map, kernel, cap.max[0] + 2, 20);
  assert.close(justOutside, postHeight + capHeight, 0.2, 'held up by the cap');

  // well clear of the part
  const clear = dropCutter(map, kernel, cap.max[0] + 20, 20);
  assert.ok(!Number.isFinite(clear) || clear < 0, 'no material, no contact');
});

test('a ball nose drops lower than a flat tool at a convex edge', () => {
  const mesh = makeBox(40, 40, 10);
  const map = buildHeightmap(mesh, { cellSize: 0.25 });
  const flatZ = dropCutter(map, buildToolKernel(TOOL, map.cellSize), 42, 20);
  const ballZ = dropCutter(map, buildToolKernel(BALL, map.cellSize), 42, 20);
  assert.ok(ballZ < flatZ, `ball ${ballZ} should reach below flat ${flatZ}`);
});

// --- parallel 3D finishing ---

test('parallel3d rides the surface and never cuts above topZ', () => {
  const mesh = makeBox(40, 40, 10);
  const cl = generateToolpath({
    type: 'parallel3d', name: 'finish', tool: BALL, mesh,
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] },
    params: {
      topZ: 10, bottomZ: 0, stepover: 0.4, clearanceHeight: 25,
      stockToLeave: 0, tolerance: 0.05, pattern: 'zigzag', angleDeg: 0,
    },
  });
  let cuts = 0, maxZ = -Infinity, minZ = Infinity;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE) return;
    cuts++;
    maxZ = Math.max(maxZ, z);
    minZ = Math.min(minZ, z);
  });
  assert.ok(cuts > 20, `expected a raster, got ${cuts} cutting moves`);
  assert.ok(maxZ <= 10 + 1e-6, 'never above the top');
  assert.ok(minZ >= 0 - 1e-6, 'never below the bottom');
  assert.close(maxZ, 10, 0.2, 'follows the flat top');
});

test('parallel3d raster angle rotates the passes', () => {
  const common = {
    type: 'parallel3d', name: 'f', tool: BALL, mesh: makeBox(40, 20, 10),
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 20, 10] },
    params: {
      topZ: 10, bottomZ: 0, stepover: 0.5, clearanceHeight: 25,
      stockToLeave: 0, tolerance: 0.1, pattern: 'zigzag',
    },
  };
  const spanOf = (cl) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    eachMove(cl, (op, x, y) => {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    });
    return { x: x1 - x0, y: y1 - y0 };
  };
  const across = spanOf(generateToolpath({ ...common, params: { ...common.params, angleDeg: 0 } }));
  const along = spanOf(generateToolpath({ ...common, params: { ...common.params, angleDeg: 90 } }));
  assert.ok(across.x > 0 && along.y > 0, 'both cover the part');
  assert.ok(Math.abs(across.x - along.x) > 0.5 || Math.abs(across.y - along.y) > 0.5,
    'the two angles produce different coverage');
});

test('stock to leave lifts the whole finishing pass', () => {
  const base = {
    type: 'parallel3d', name: 'f', tool: BALL, mesh: makeBox(30, 30, 10),
    stock: { kind: 'box', min: [0, 0, 0], max: [30, 30, 10] },
    params: {
      topZ: 12, bottomZ: 0, stepover: 0.5, clearanceHeight: 25,
      tolerance: 0.1, pattern: 'zigzag', angleDeg: 0,
    },
  };
  const topOf = (cl) => {
    let z = -Infinity;
    eachMove(cl, (op, x, y, zz, i, j, k, feed) => {
      if (op === OP.LINE && feed !== FEED.RAPID) z = Math.max(z, zz);
    });
    return z;
  };
  const exact = topOf(generateToolpath({ ...base, params: { ...base.params, stockToLeave: 0 } }));
  const left = topOf(generateToolpath({ ...base, params: { ...base.params, stockToLeave: 0.4 } }));
  assert.close(left - exact, 0.4, 0.05, 'the pass floats by the allowance');
});

/**
 * Independent gouge check: sample the mesh surface densely and confirm no
 * sampled point ends up inside the tool.
 *
 * Deliberately avoids the heightmap — checking a heightmap against a heightmap
 * would hide exactly the rasterisation errors worth catching. Vertices alone
 * are not enough either: a box has no vertex along the middle of an edge, which
 * is precisely where a finishing pass rolls over and where gouges appear. So
 * triangles are sampled over their whole area, bucketed into a grid for lookup.
 */
function sampleSurface(mesh, spacing) {
  const points = [];
  const { positions, indices } = mesh;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const A = [positions[a], positions[a + 1], positions[a + 2]];
    const B = [positions[b], positions[b + 1], positions[b + 2]];
    const C = [positions[c], positions[c + 1], positions[c + 2]];
    const eAB = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
    const eAC = Math.hypot(C[0] - A[0], C[1] - A[1], C[2] - A[2]);
    const n = Math.max(2, Math.ceil(Math.max(eAB, eAC) / spacing));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        const u = i / n, v = j / n, w = 1 - u - v;
        points.push(
          A[0] * w + B[0] * u + C[0] * v,
          A[1] * w + B[1] * u + C[1] * v,
          A[2] * w + B[2] * u + C[2] * v,
        );
      }
    }
  }
  return points;
}

function buildGrid(points, cell) {
  const grid = new Map();
  for (let i = 0; i < points.length; i += 3) {
    const key = `${Math.floor(points[i] / cell)},${Math.floor(points[i + 1] / cell)}`;
    let bucket = grid.get(key);
    if (!bucket) { bucket = []; grid.set(key, bucket); }
    bucket.push(i);
  }
  return { grid, cell };
}

function worstGouge(cl, mesh, tool, spacing = 0.25) {
  const r = tool.diameter / 2;
  const profile = clearanceProfile(tool);
  const points = sampleSurface(mesh, spacing);
  const { grid, cell } = buildGrid(points, r);

  let worst = 0;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE || feed === FEED.RAPID) return;
    const gi = Math.floor(x / cell), gj = Math.floor(y / cell);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        for (const p of grid.get(`${gi + di},${gj + dj}`) ?? []) {
          const d = Math.hypot(points[p] - x, points[p + 1] - y);
          if (d > r) continue;
          // the tool's surface at this offset must stay above the material
          const required = points[p + 2] - profile(d);
          if (required - z > worst) worst = required - z;
        }
      }
    }
  });
  return worst;
}

test('the gouge checker detects a deliberately sunk toolpath', () => {
  // a checker that always returns zero would make the two tests below
  // meaningless, so prove it reacts to a known fault first
  const { mesh, postHeight, capHeight } = makeMushroom();
  const args = {
    type: 'parallel3d', name: 'finish', tool: BALL, mesh,
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, postHeight + capHeight] },
    params: {
      topZ: postHeight + capHeight, bottomZ: -5, stepover: 0.5,
      clearanceHeight: 25, stockToLeave: 0, tolerance: 0.05,
      pattern: 'zigzag', angleDeg: 0,
    },
  };
  const clean = generateToolpath(args);
  assert.ok(worstGouge(clean, mesh, BALL) < 0.1, 'baseline is clean');

  const sunk = { ...clean, moves: clean.moves.slice() };
  for (let n = 0; n < sunk.count; n++) sunk.moves[n * 8 + 3] -= 0.5;
  assert.ok(worstGouge(sunk, mesh, BALL) > 0.4, 'a 0.5mm sink is reported');
});

test('parallel3d never buries the cutter in the part', () => {
  const { mesh, postHeight, capHeight } = makeMushroom();
  const cl = generateToolpath({
    type: 'parallel3d', name: 'finish', tool: BALL, mesh,
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, postHeight + capHeight] },
    params: {
      topZ: postHeight + capHeight, bottomZ: 0, stepover: 0.25,
      clearanceHeight: 25, stockToLeave: 0, tolerance: 0.05,
      pattern: 'zigzag', angleDeg: 45,
    },
  });
  // the mushroom's cap is a sharp convex edge — the case that exposes a
  // heightmap sampled at cell centres
  const gouge = worstGouge(cl, mesh, BALL);
  assert.ok(gouge < 0.1, `cutter buried ${gouge.toFixed(3)}mm into the part`);
});

test('parallel3d clears a flat-bottomed cutter on a stepped part too', () => {
  const { mesh, postHeight, capHeight } = makeMushroom({ capSize: 24, postSize: 12 });
  const cl = generateToolpath({
    type: 'parallel3d', name: 'finish', tool: TOOL, mesh,
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, postHeight + capHeight] },
    params: {
      topZ: postHeight + capHeight, bottomZ: 0, stepover: 0.3,
      clearanceHeight: 25, stockToLeave: 0, tolerance: 0.05,
      pattern: 'oneway', angleDeg: 0,
    },
  });
  const gouge = worstGouge(cl, mesh, TOOL);
  assert.ok(gouge < 0.1, `flat cutter buried ${gouge.toFixed(3)}mm into the part`);
});

// --- staying down between passes ---
//
// A finishing raster over anything but a solid block breaks at every feature,
// and a break used to mean a climb to clearance and a plunge back in. The
// mushroom is the shape that shows it: its cap overhangs, so every raster line
// runs off the surface at both ends and the pass either side of the post
// breaks as well.

/**
 * Retracts that go all the way to the clearance plane, and shorter hops.
 *
 * A rapid is `OP.RAPID`, a whole opcode of its own — not `OP.LINE` carrying
 * `FEED.RAPID` — so this counts opcodes rather than filtering on the feed.
 */
function lifts(cl, clearance) {
  let toClearance = 0;
  let hops = 0;
  let last = null;
  eachMove(cl, (op, x, y, z) => {
    if (last !== null && op === OP.RAPID && z > last + 1e-6) {
      if (z >= clearance - 1e-6) toClearance++; else hops++;
    }
    last = z;
  });
  return { toClearance, hops };
}

const MUSHROOM_PARAMS = {
  topZ: 15, bottomZ: 0, stepover: 0.25, clearanceHeight: 25,
  stockToLeave: 0, tolerance: 0.05, pattern: 'zigzag', angleDeg: 0, entryGap: 1,
};

test('a finishing raster stops climbing to clearance at every break', () => {
  const { mesh } = makeMushroom();
  const run = (linkDistance) => generateToolpath({
    type: 'parallel3d', name: 'finish', tool: BALL, mesh,
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 15] },
    params: { ...MUSHROOM_PARAMS, linkDistance },
  });
  const never = lifts(run(0), 25);
  const linked = lifts(run(null), 25);
  // A precondition, not the claim: the mushroom has to break enough for
  // linking to be worth measuring. The number came down from 24 when the
  // raster started sampling adaptively — the old fixed stride stopped short
  // of the end of each row and left a fragment there that broke on its own.
  assert.ok(never.toClearance > 10, `the shape has breaks to link: ${never.toClearance}`);
  assert.ok(linked.toClearance * 4 < never.toClearance,
    `expected far fewer full retracts, got ${linked.toClearance} of ${never.toClearance}`);
});

// The link is only worth having if it cannot gouge, and the hop is the half the
// ordinary gouge check does not see — it looks at cutting moves, and a hop
// crosses the part at rapid. So this one checks *every* move.
test('nothing a linked pass does, at any feed, enters the part', () => {
  const { mesh } = makeMushroom();
  const cl = generateToolpath({
    type: 'parallel3d', name: 'finish', tool: BALL, mesh,
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 15] },
    params: { ...MUSHROOM_PARAMS, linkDistance: null },
  });
  const map = buildHeightmap(mesh, { cellSize: 0.2, floor: -Infinity });
  const kernel = buildToolKernel(BALL, map.cellSize);
  let worst = 0;
  eachMove(cl, (op, x, y, z) => {
    if (op === OP.DRILL) return;         // a raster has none, but be explicit
    const surface = dropCutter(map, kernel, x, y);
    if (Number.isFinite(surface) && surface - z > worst) worst = surface - z;
  });
  // one cell of the sampling grid is the resolution of the answer, not a gouge
  assert.ok(worst < 0.25, `a move sat ${worst.toFixed(3)}mm inside the part`);
});

test('a region-excluded gap is never driven across', () => {
  const { mesh } = makeMushroom();
  // exclude a band across the middle: the raster must not cut through it, and
  // "the ground is clear" is true there — only the region says no
  const cl = generateToolpath({
    type: 'parallel3d', name: 'finish', tool: BALL, mesh,
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 15] },
    params: { ...MUSHROOM_PARAMS, linkDistance: 50 },
    regions: { include: [], avoid: [[0, 18, 40, 18, 40, 22, 0, 22]] },
  });
  let inside = 0;
  eachMove(cl, (op, x, y, z) => {
    if (op !== OP.LINE) return;          // rapids cross it at clearance, legally
    if (y > 18 && y < 22 && z < 24) inside++;
  });
  assert.eq(inside, 0, 'no cutting move crosses the avoided band');
});

// --- faces & regions ---

test('buildFaces recovers a box as six flat faces', () => {
  const { faces, faceOfTriangle } = buildFaces(makeBox(10, 10, 10));
  assert.eq(faces.length, 6, 'one face per side');
  assert.eq(faceOfTriangle.length, 12, 'every triangle assigned');
  for (const f of faces) assert.eq(f.length, 2, 'two triangles per side');
});

test('faceFootprint projects a picked face to its XY outline', () => {
  const mesh = makeBox(10, 20, 5);
  const { faces } = buildFaces(mesh);
  // find the top face: all its triangles sit at z = 5
  const topId = faces.findIndex((tris) => tris.every((t) => {
    for (let e = 0; e < 3; e++) {
      if (Math.abs(mesh.positions[mesh.indices[t * 3 + e] * 3 + 2] - 5) > 1e-6) return false;
    }
    return true;
  }));
  assert.ok(topId >= 0, 'found the top face');
  const loops = faceFootprint(mesh, faces, [topId]);
  assert.ok(loops.length > 0, 'produced a footprint');
  assert.ok(pointInLoops(loops, 5, 10), 'centre is inside');
  assert.ok(!pointInLoops(loops, -5, 10), 'outside is outside');
});

test('an avoid region keeps the clearing path out of it', () => {
  const avoid = [[0, 0, 15, 0, 15, 40, 0, 40]]; // the whole left strip
  const cl = generateToolpath({
    type: 'clear2d', name: 'rough', tool: TOOL, mesh: makeBox(40, 40, 10),
    stock: { kind: 'box', min: [-10, -10, 0], max: [50, 50, 10] },
    params: {
      topZ: 10, bottomZ: 0, stepdown: 5, stepover: 0.5, clearanceHeight: 20,
      stockToLeave: 0, rampAngle: 0, tolerance: 0.05, direction: 'climb', leadType: 'none',
    },
    regions: { include: [], avoid },
  });
  let worstX = Infinity;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE || feed === FEED.RAPID) return;
    if (y > 0 && y < 40) worstX = Math.min(worstX, x);
  });
  // the region is grown by the tool radius, so cut centres stay 3mm clear of x=15
  assert.ok(worstX > 15 + 3 - 0.2, `cut reached x=${worstX}, expected to stay past 18`);
});

test('an include region confines the path to itself', () => {
  const include = [[0, 0, 20, 0, 20, 20, 0, 20]];
  const cl = generateToolpath({
    type: 'parallel3d', name: 'f', tool: BALL, mesh: makeBox(40, 40, 10),
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] },
    params: {
      topZ: 10, bottomZ: 0, stepover: 0.5, clearanceHeight: 25,
      stockToLeave: 0, tolerance: 0.1, pattern: 'zigzag', angleDeg: 0,
    },
    regions: { include, avoid: [] },
  });
  let maxX = -Infinity, cuts = 0;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE || feed === FEED.RAPID) return;
    cuts++;
    maxX = Math.max(maxX, x);
  });
  assert.ok(cuts > 0, 'still cuts something');
  assert.ok(maxX < 20, `stayed inside the region, reached x=${maxX}`);
});

test('a finishing pass stops at Bottom Z rather than flattening everything to it', () => {
  // Bottom Z above a pocket floor. Every point inside the pocket is below the
  // window, and the old behaviour clamped them all to Bottom Z — a plateau
  // hanging in mid air across the pocket, cut at feed, through nothing. The
  // same clamp is what put a lap round the base of an outside wall.
  const block = makePocketBlock({ size: 40, pocketSize: 20, height: 10, depth: 6 });
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] };
  const params = {
    clearanceHeight: 30, entryGap: 1, tolerance: 0.05, stockToLeave: 0,
    stepdown: 1, stepover: 0.3, direction: 'climb', topZ: 10, bottomZ: 6,
  };
  const run = (parallelBoundary) => generateToolpath({
    type: 'parallel3d', name: 'p', tool: BALL, mesh: block.mesh, stock,
    params: { ...params, parallelBoundary },
  });

  const plateau = (cl) => {
    let n = 0;
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      // inside the pocket, whose floor is at Z4 — anything cut at Z6 there is
      // cutting air
      if (op === OP.LINE && feed !== FEED.RAPID && Math.abs(z - 6) < 1e-6
        && x > 11 && x < 29 && y > 11 && y < 29) n++;
    });
    return n;
  };

  assert.ok(plateau(run('stock')) > 5, 'the old behaviour draws the plateau');
  assert.eq(plateau(run('part')), 0, 'and the default does not');

  // it still finishes the top face, which is the surface it is there for
  let onTop = 0;
  eachMove(run('part'), (op, x, y, z, i, j, k, feed) => {
    if (op === OP.LINE && feed !== FEED.RAPID && Math.abs(z - 10) < 0.01) onTop++;
  });
  assert.ok(onTop > 20, `only ${onTop} moves on the top face — the pass gave up too early`);
});

test('and the boundary limit does not throw away the inside of the part', () => {
  // The limit is the part's outline, and a pocket is a *hole* in the silhouette
  // it is taken from. Keeping the holes excluded the pocket floor from the pass
  // whose job is to finish it — measured, the floor of a 12mm pocket stopped
  // being cut at all, which is a far worse bug than the one being fixed.
  const block = makePocketBlock({ size: 40, pocketSize: 20, height: 20, depth: 12 });
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] };
  const params = {
    clearanceHeight: 40, entryGap: 1, tolerance: 0.05, stockToLeave: 0,
    stepdown: 2, stepover: 0.4, direction: 'climb', topZ: 20, bottomZ: 8,
  };
  const inside = (parallelBoundary) => {
    const cl = generateToolpath({
      type: 'parallel3d', name: 'p', tool: BALL, mesh: block.mesh, stock,
      params: { ...params, parallelBoundary },
    });
    let n = 0;
    let lowest = Infinity;
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (op !== OP.LINE || feed === FEED.RAPID) return;
      lowest = Math.min(lowest, z);
      if (x > 11 && x < 29 && y > 11 && y < 29) n++;
    });
    return { n, lowest };
  };

  const limited = inside('part');
  const whole = inside('stock');
  assert.eq(limited.n, whole.n, 'the pocket is machined the same either way');
  assert.close(limited.lowest, 8, 1e-6, 'and the pass still reaches the pocket floor');
});

/**
 * The raster is walked coarsely and refined where the surface does something,
 * which is only sound if what it skips is genuinely flat. Checked against the
 * drop-cutter surface itself rather than against the old sampling: walk every
 * cutting segment finely and ask how far the emitted path strays from where the
 * tool may actually go.
 */
test('adaptive raster sampling stays inside the chording tolerance', () => {
  const { mesh } = makeMushroom();
  const tolerance = 0.01;
  const cl = generateToolpath({
    type: 'parallel3d', name: 'finish', tool: BALL, mesh,
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 15] },
    params: {
      ...MUSHROOM_PARAMS, tolerance, stepover: 0.1, linkDistance: 0,
    },
  });
  const map = buildHeightmap(mesh, { cellSize: 0.05, floor: -Infinity });
  const kernel = buildToolKernel(BALL, map.cellSize);
  const d = cl.moves;
  let worst = 0;
  let previous = null;
  for (let n = 0; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    const q = [d[o + 1], d[o + 2], d[o + 3]];
    if (previous && d[o] !== OP.RAPID) {
      const span = Math.hypot(q[0] - previous[0], q[1] - previous[1]);
      const steps = Math.max(1, Math.ceil(span / 0.05));
      for (let m = 0; m <= steps; m++) {
        const u = m / steps;
        const x = previous[0] + (q[0] - previous[0]) * u;
        const y = previous[1] + (q[1] - previous[1]) * u;
        const z = previous[2] + (q[2] - previous[2]) * u;
        const surface = dropCutter(map, kernel, x, y);
        if (Number.isFinite(surface) && surface - z > worst) worst = surface - z;
      }
    }
    previous = q;
  }
  // the grid the check itself samples on is 0.05mm, so it cannot resolve better
  assert.ok(worst < tolerance + 0.05,
    `the refined path sat ${worst.toFixed(4)}mm inside the part`);
});

test('B-rep face ranges are read in the units the CAD worker writes them', () => {
  // occt-import-js reports a face as { first, last } **triangle** numbers, with
  // `last` inclusive — see workers/occt-worker.js. buildFaces used to read
  // `range.start` / `range.count` and divide by three, as though a range were an
  // offset into the index array: neither field exists, every bound came out NaN,
  // no range matched a triangle, and the fallback below handed back one face per
  // triangle. A STEP import — the one format that knows what its faces are —
  // picked worse than an STL, whose faces the flood fill recovers correctly.
  const mesh = makeBox(10, 10, 10);
  const ranges = [];
  for (let f = 0; f < 6; f++) ranges.push({ first: f * 2, last: f * 2 + 1, faceId: f });
  const { faces, faceOfTriangle } = buildFaces({ ...mesh, faceRanges: ranges });
  assert.eq(faces.length, 6, 'one face per declared B-rep face');
  for (const f of faces) assert.eq(f.length, 2, 'both of its triangles');
  assert.ok([...faceOfTriangle].every((id) => id >= 0), 'every triangle is pickable');
  // and the same mesh without the ranges must not come out better than with them
  assert.eq(buildFaces(mesh).faces.length, faces.length,
    'the B-rep grouping agrees with what the flood fill recovers');
});

test('a picked wall is a region, not nothing at all', () => {
  // A vertical face projects to a line, so its honest area is zero — and that is
  // what came back. Picking the riser of a step, or the walls of a pocket, gave
  // no loops at all: `avoid` then kept the cutter out of nowhere, and `include`
  // was worse than useless, because an empty include list read downstream as
  // "no restriction" and machined the whole part.
  const mesh = makeBox(10, 20, 5);
  const { faces } = buildFaces(mesh);
  const onPlaneX0 = (tris) => tris.every((t) => {
    for (let e = 0; e < 3; e++) {
      if (Math.abs(mesh.positions[mesh.indices[t * 3 + e] * 3]) > 1e-6) return false;
    }
    return true;
  });
  const wallId = faces.findIndex(onPlaneX0);
  assert.ok(wallId >= 0, 'found a vertical wall');

  assert.eq(faceFootprint(mesh, faces, [wallId]).length, 0,
    'it still casts no shadow, which is the truth about a wall');

  const band = faceFootprint(mesh, faces, [wallId], { wallBand: 2 });
  assert.ok(band.length > 0, 'and it is given the width it is machined at');
  assert.ok(pointInLoops(band, 0, 10), 'the wall itself is in it');
  assert.ok(pointInLoops(band, 1.5, 10), 'and so is the ground beside it');
  assert.ok(!pointInLoops(band, 4, 10), 'but not the far side of the part');
});

test('a floor is not widened by the wall band', () => {
  const mesh = makeBox(10, 20, 5);
  const { faces } = buildFaces(mesh);
  const topId = faces.findIndex((tris) => tris.every((t) => {
    for (let e = 0; e < 3; e++) {
      if (Math.abs(mesh.positions[mesh.indices[t * 3 + e] * 3 + 2] - 5) > 1e-6) return false;
    }
    return true;
  }));
  const banded = faceFootprint(mesh, faces, [topId], { wallBand: 2 });
  assert.ok(pointInLoops(banded, 5, 10), 'still covers the face');
  assert.ok(!pointInLoops(banded, -1, 10), 'and does not grow past its own edge');
});

test('a pick narrower than the cutter still restricts, and does not refuse', () => {
  // Two failures live at this one line, in opposite directions.
  //
  // It used to test `if (include.length)` on the list that came back from the
  // tool-radius erosion, so a pick that eroded away stopped restricting anything
  // and the pass machined the *whole part* — silently, in the one direction a
  // keep-out may never fail.
  //
  // Refusing outright is the other direction, and it is wrong for an outside
  // shoulder: eroding asks "where does the whole cutter fit inside the pick",
  // which the centre never does on a step it reaches from off the part. So the
  // pick stands as picked, and the strategy's own stock-minus-part region is
  // what keeps the cutter honest.
  const stock = { kind: 'box', min: [-10, -10, 0], max: [50, 50, 10] };
  const params = {
    topZ: 10, bottomZ: 0, stepdown: 5, clearanceHeight: 15,
    stepover: 0.5, tolerance: 0.01, stockToLeave: 0, rampAngle: 0,
  };
  const run = (regions) => generateToolpath({
    type: 'clear2d', name: 'rough', tool: TOOL, mesh: makeBox(40, 40, 10), stock, params, regions,
  });
  const free = toolpathStats(run(null)).cutLength;
  assert.ok(free > 0, 'the unrestricted pass cuts');

  // a strip far narrower than the ⌀6 cutter, along one edge of the billet
  const strip = [[-8, -8, -6, -8, -6, 48, -8, 48]];
  const restricted = toolpathStats(run({ include: strip, avoid: [], cleared: [] }));
  assert.ok(restricted.cutLength > 0, 'it machines the strip rather than refusing');
  assert.ok(restricted.cutLength < free * 0.5,
    `and it is still a restriction: ${restricted.cutLength.toFixed(0)} of ${free.toFixed(0)}mm`);
});

test('an outside shoulder narrower than the cutter is machined, not refused', () => {
  // A 10mm ledge round a boss, picked with a ⌀12 cutter. Eroding by the radius
  // emptied it and the pass reported that there was nowhere for the tool to go
  // — on a step any mill cuts without thinking about it.
  const wide = {
    number: 2, type: 'flat', diameter: 12, flutes: 3, fluteLength: 30,
    spindleRpm: 6000, feedCut: 900, feedPlunge: 300,
  };
  const part = makeStepped({ base: 40, top: 20, baseHeight: 10, topHeight: 10 });
  const stock = { kind: 'box', min: [-5, -5, 0], max: [45, 45, 20] };
  const params = {
    topZ: 20, bottomZ: 10, stepdown: 4, clearanceHeight: 30, entryGap: 1,
    stepover: 0.5, tolerance: 0.01, stockToLeave: 0, rampAngle: 0,
  };
  // the exposed ring of the base: outer boundary, with the boss as its hole
  const shoulder = [
    [0, 0, 40, 0, 40, 40, 0, 40],
    [10, 10, 10, 30, 30, 30, 30, 10],
  ];
  const cl = generateToolpath({
    type: 'clear2d', name: 'shoulder', tool: wide, mesh: part.mesh ?? part, stock, params,
    regions: { include: shoulder, avoid: [], cleared: [] },
  });
  const stats = toolpathStats(cl);
  assert.ok(stats.cutLength > 0,
    `expected the shoulder to be machined, got: ${stats.warnings.map((w) => w.text)}`);
});

test('and the same for a contour, which clips paths rather than areas', () => {
  const stock = { kind: 'box', min: [-10, -10, 0], max: [50, 50, 10] };
  const run = (regions) => generateToolpath({
    type: 'contour2d', name: 'profile', tool: TOOL, mesh: makeBox(40, 40, 10), stock,
    params: {
      topZ: 10, bottomZ: 0, stepdown: 5, clearanceHeight: 15,
      tolerance: 0.01, stockToLeave: 0, rampAngle: 0, side: 'outside', profile: 'outer',
    },
    regions,
  });
  assert.ok(toolpathStats(run(null)).cutLength > 0, 'the unrestricted profile cuts');
  assert.eq(toolpathStats(run({
    include: [[0, 0, 0.2, 0, 0.2, 40, 0, 40]], avoid: [], cleared: [],
  })).cutLength, 0, 'a profile restricted to nowhere goes nowhere');
});

// A waterline offsets each level's silhouette by the tool, and it was reading
// only the tool's *diameter* — so a ball nose, which is a point at its tip and
// only reaches full width a radius further up, was planned as the cylinder it
// is not and held a whole radius off a surface it touches with its nose. The
// tell was that a ⌀6 ball, a ⌀6 bull nose and a ⌀6 flat came out byte-identical.
test('waterline reads the cutter shape, not just its diameter', () => {
  const mesh = makeRamp(40, 40, 20);
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] };
  const at = (stepdown, tool) => generateToolpath({
    type: 'waterline',
    name: 'w',
    tool,
    mesh,
    stock,
    params: {
      topZ: 20, bottomZ: 0, stepdown, stockToLeave: 0, tolerance: 0.01,
      clearanceHeight: 30, entryGap: 1, direction: 'climb', leadType: 'none',
    },
  });

  // The ramp is the plane z = x/2, so the stock a pass leaves is a distance to
  // a plane and nothing has to be inferred. A ⌀6 ball is tangent to it when its
  // centre — a radius above the tip — is exactly 3mm away, and the pass at each
  // level stands off on the −X side, so the level's smallest X is the one that
  // touches the slope.
  // Signed, because both ends of it matter: positive is stock the pass did not
  // reach, negative is the cutter inside the finished surface.
  const gapUnderABall = (cl) => {
    const nearest = new Map();
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (op !== OP.LINE || feed === FEED.RAPID) return;
      const level = Math.round(z * 1000) / 1000;
      if (!(nearest.get(level) <= x)) nearest.set(level, x);
    });
    let left = 0;
    let into = 0;
    for (const [z, x] of nearest) {
      if (z < 3 || z > 17) continue;               // clear of both ends
      const gap = (2 * (z + 3) - x) / Math.sqrt(5) - 3;
      if (gap > left) left = gap;
      if (-gap > into) into = -gap;
    }
    return { left, into };
  };
  const stockLeftUnderABall = (cl) => gapUnderABall(cl).left;

  const flat = { ...TOOL, type: 'flat' };
  const ball = { ...TOOL, type: 'ball' };
  const bull = { ...TOOL, type: 'bull', cornerRadius: 1 };
  assert.ok(cutLengthOf(at(1, ball)) !== cutLengthOf(at(1, flat)),
    'a ball and a flat of the same diameter do not plan the same waterline');
  assert.ok(cutLengthOf(at(1, bull)) !== cutLengthOf(at(1, flat)),
    'nor do a bull nose and a flat');

  // Planned as the cylinder it is not, the ball never reaches the slope at all
  // — and no stepdown helps, because it is a shape error and not a sampling one.
  for (const stepdown of [1, 0.25]) {
    assert.close(stockLeftUnderABall(at(stepdown, flat)), 1.02, 0.05,
      'the cylinder answer leaves the same millimetre however fine the passes');
  }

  // The real answer's error *is* a sampling one: the profile is asked about on
  // the pass grid, so it shrinks with the stepdown and is always well inside
  // the cusp that stepdown leaves anyway (2mm and 0.5mm here).
  const coarse = stockLeftUnderABall(at(1, ball));
  const fine = stockLeftUnderABall(at(0.25, ball));
  assert.ok(coarse < 0.7, `a 1mm stepdown leaves ${coarse.toFixed(2)}mm, against 1.02`);
  assert.ok(fine < coarse * 0.7, `a 0.25mm one leaves ${fine.toFixed(2)}mm`);

  // And the direction that error is allowed to point, which is the whole reason
  // the residual above is what it is. Each band of the cutter's profile is
  // sampled at the *top* of the band, so the standoff is never less than the
  // geometry needs; sampled at the bottom it was 0.375mm short for a ⌀6 ball,
  // and the flank cut a third of a millimetre into a finished surface. A
  // residual is a second pass; a gouge is a scrapped part.
  for (const stepdown of [2, 1, 0.5, 0.25]) {
    for (const tool of [ball, bull, flat]) {
      const { into } = gapUnderABall(at(stepdown, tool));
      assert.eq(Math.round(into * 1000), 0,
        `a ${tool.type} at a ${stepdown}mm stepdown cuts ${into.toFixed(3)}mm into the slope`);
    }
  }
});

// …and the flat cutter's own answer must not have moved: it is the one shape
// the old single-offset question was right about.
test('waterline with a flat cutter is unchanged by the profile treatment', () => {
  const mesh = makeRamp(40, 40, 20);
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] };
  const params = {
    topZ: 20, bottomZ: 0, stepdown: 1, stockToLeave: 0, tolerance: 0.01,
    clearanceHeight: 30, entryGap: 1, direction: 'climb', leadType: 'none',
  };
  const flat = { ...TOOL, type: 'flat' };
  const steps = profileSteps(flat, 1);
  assert.eq(steps.length, 1, 'a flat cutter asks one question');
  assert.close(steps[0].dz, 0, 1e-9);
  assert.close(steps[0].radius, 3, 1e-9);

  const cl = generateToolpath({ type: 'waterline', name: 'w', tool: flat, mesh, stock, params });
  // the ramp's foot is at x=0 and a ⌀6 flat stands its radius off it
  let minX = Infinity;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.LINE && feed !== FEED.RAPID && x < minX) minX = x;
  });
  assert.close(minX, -3, 0.05, 'a flat cutter stands exactly its radius off the foot');
});

function cutLengthOf(cl) {
  let sum = 0;
  let prev = null;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (prev && op === OP.LINE && feed !== FEED.RAPID) {
      sum += Math.hypot(x - prev[0], y - prev[1], z - prev[2]);
    }
    prev = [x, y, z];
  });
  return sum;
}

// --- how a pass gets from one to the next ------------------------------------

test('a one-way raster does not cut its way back across the part', () => {
  // The raster's emitter is carried across rows so a zig-zag can cut the
  // stepover-long link at the end of each one. One-way rows all start at the
  // *same* side, so that link is the full width of the part — and with nothing
  // marking it as a link it was emitted as a cutting move in a straight line,
  // with Z interpolated between two points a part-width apart. On a ramp that
  // is a diagonal groove ploughed through the finished surface, once per row.
  const mesh = makeRamp(40, 40, 10);
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] };
  const params = {
    clearanceHeight: 30, entryGap: 1, tolerance: 0.05, stockToLeave: 0,
    stepover: 0.3, topZ: 10, bottomZ: 0, direction: 'climb', angleDeg: 0,
  };
  const run = (pattern) => generateToolpath({
    type: 'parallel3d', tool: BALL, mesh, stock, params: { ...params, pattern },
  });

  // The ramp rises along x, so a row runs up it and the return runs back down.
  // Anything cutting across more than half the part in one move is that return.
  const longCuts = (cl) => {
    let n = 0;
    let prev = null;
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (prev && op === OP.LINE && feed !== FEED.RAPID
        && Math.hypot(x - prev[0], y - prev[1]) > 20) n++;
      prev = [x, y, z];
    });
    return n;
  };
  assert.eq(longCuts(run('oneway')), 0, 'the return is a link, not a cut');
  assert.eq(longCuts(run('zigzag')), 0, 'and a zig-zag never had one');
});
