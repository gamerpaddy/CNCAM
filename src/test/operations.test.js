import { test, assert } from './runner.js';
import { Document } from '../doc/document.js';
import { createSetup, createOperation, createTool } from '../doc/schema.js';
import { generateToolpath, IMPLEMENTED_OPS, OP_LABELS } from '../engine/toolpath.js';
import { eachMove, OP, FEED, CLBuilder } from '../engine/cl.js';
import { downhillAt, buildHeightmap } from '../geom/heightmap.js';
import {
  unionLoops, loopArea, loopsBounds, enclosedVoids, unionWithHoles,
} from '../geom/clipper.js';
import { makeBox, makeMushroom, makeRamp, makePocketBlock, makeStepped } from './fixtures.js';

const FLAT = { number: 1, type: 'flat', diameter: 6, fluteLength: 20, spindleRpm: 10000, feedCut: 800, feedPlunge: 300 };
const BALL = { ...FLAT, type: 'ball' };

function cutPoints(cl) {
  const pts = [];
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.LINE && feed !== FEED.RAPID) pts.push([x, y, z]);
  });
  return pts;
}

// --- registry ---

test('every implemented operation has a label', () => {
  for (const type of IMPLEMENTED_OPS) {
    assert.ok(OP_LABELS[type], `${type} needs a label for the strategy picker`);
  }
});

// --- waterline ---

test('waterline cuts level contours, not sloped passes', () => {
  const { mesh, postHeight, capHeight } = makeMushroom();
  const cl = generateToolpath({
    type: 'waterline', name: 'wl', tool: FLAT, mesh,
    params: {
      topZ: postHeight + capHeight, bottomZ: 0, stepdown: 1,
      clearanceHeight: 25, stockToLeave: 0, tolerance: 0.05,
      direction: 'climb', leadType: 'none',
    },
  });
  const pts = cutPoints(cl);
  assert.ok(pts.length > 50, `expected contours, got ${pts.length} points`);

  // group by Z: a waterline pass holds one depth for its whole loop
  const levels = new Set(pts.map((p) => Math.round(p[2] * 100) / 100));
  assert.ok(levels.size > 3, 'stepped through several levels');
  assert.ok(levels.size < pts.length / 5, 'but each level holds many points at one Z');
});

test('waterline stepdown controls how many levels are cut', () => {
  const { mesh, postHeight, capHeight } = makeMushroom();
  const run = (stepdown) => generateToolpath({
    type: 'waterline', name: 'wl', tool: FLAT, mesh,
    params: {
      topZ: postHeight + capHeight, bottomZ: 0, stepdown,
      clearanceHeight: 25, stockToLeave: 0, tolerance: 0.05,
      direction: 'climb', leadType: 'none',
    },
  });
  const coarse = new Set(cutPoints(run(4)).map((p) => p[2].toFixed(2))).size;
  const fine = new Set(cutPoints(run(1)).map((p) => p[2].toFixed(2))).size;
  assert.ok(fine > coarse, `finer stepdown should add levels (${fine} vs ${coarse})`);
});

// --- enclosed voids ---

test('enclosedVoids finds a hole that the flat loop list hides', () => {
  // four strips tiling a ring around a 20x20 hole, the shape a pocket's top
  // face makes. Clipper unions this into a single self-touching "keyhole" path:
  // the net area is right, but there is no negative-area loop to find, so
  // hunting for holes by orientation comes up empty.
  const strips = [
    [0, 0, 40, 0, 40, 10, 0, 10],
    [0, 30, 40, 30, 40, 40, 0, 40],
    [0, 10, 10, 10, 10, 30, 0, 30],
    [30, 10, 40, 10, 40, 30, 30, 30],
  ];
  const merged = unionLoops(strips);
  const totalArea = merged.reduce((sum, loop) => sum + loopArea(loop), 0);
  assert.close(Math.abs(totalArea), 1200, 1, 'the ring has the right area either way');

  const voids = enclosedVoids(strips);
  assert.eq(voids.length, 1, 'exactly one enclosed void');
  const b = loopsBounds(voids);
  assert.close(b.min[0], 10, 0.01, 'void min X');
  assert.close(b.max[0], 30, 0.01, 'void max X');
  assert.close(b.min[1], 10, 0.01, 'void min Y');
  assert.close(b.max[1], 30, 0.01, 'void max Y');
});

test('a solid shape has no enclosed voids', () => {
  assert.eq(enclosedVoids([[0, 0, 10, 0, 10, 10, 0, 10]]).length, 0);
});

test('unionWithHoles reports islands inside holes as their own outers', () => {
  // a ring with a smaller solid island floating in its middle
  const ring = [
    [0, 0, 40, 0, 40, 40, 0, 40],       // outer
    [10, 10, 10, 30, 30, 30, 30, 10],   // hole (wound the other way)
  ];
  const island = [[18, 18, 22, 18, 22, 22, 18, 22]];
  const regions = unionWithHoles([...ring, ...island]);
  assert.eq(regions.length, 2, 'the block and the island are both outers');
  const withHole = regions.find((r) => r.holes.length > 0);
  assert.ok(withHole, 'the block keeps its hole');
});

// --- pocket ---

test('pocket clears an enclosed void and stays off its walls', () => {
  const { mesh, pocket, top } = makePocketBlock();
  const cl = generateToolpath({
    type: 'pocket', name: 'pkt', tool: FLAT, mesh,
    params: {
      topZ: top, bottomZ: 0, stepdown: 2, stepover: 0.4,
      clearanceHeight: top + 10, stockToLeave: 0, tolerance: 0.05,
      rampAngle: 0, direction: 'climb', leadType: 'none',
    },
  });
  const pts = cutPoints(cl);
  assert.ok(pts.length > 20, `pocket produced ${pts.length} cutting points`);

  const r = FLAT.diameter / 2;
  for (const [x, y] of pts) {
    assert.ok(x > pocket.min[0] + r - 0.1 && x < pocket.max[0] - r + 0.1,
      `cut at x=${x.toFixed(2)} escaped the pocket walls`);
    assert.ok(y > pocket.min[1] + r - 0.1 && y < pocket.max[1] - r + 0.1,
      `cut at y=${y.toFixed(2)} escaped the pocket walls`);
  }
});

test('pocket on a solid block with no void cuts nothing', () => {
  const cl = generateToolpath({
    type: 'pocket', name: 'pkt', tool: FLAT, mesh: makeBox(40, 40, 10),
    params: {
      topZ: 10, bottomZ: 0, stepdown: 2, stepover: 0.4,
      clearanceHeight: 20, stockToLeave: 0, tolerance: 0.05,
      rampAngle: 0, direction: 'climb', leadType: 'none',
    },
  });
  assert.eq(cutPoints(cl).length, 0, 'nothing enclosed, nothing to clear');
  assert.ok(cl.events.some((e) => e.type === 'comment' && /no enclosed region/.test(e.text)),
    'and it says so');
});

// --- slope-following finish ---

test('downhill points down the slope of a ramp', () => {
  const map = buildHeightmap(makeRamp(), { cellSize: 0.5 });
  // the ramp rises with +X, so downhill runs toward -X
  const i = Math.round(map.width / 2);
  const j = Math.round(map.height / 2);
  const down = downhillAt(map, i, j);
  assert.ok(down, 'a slope has a downhill direction');
  assert.ok(down[0] < -0.8, `expected -X, got [${down.map((v) => v.toFixed(2))}]`);
});

test('downhill is null on a flat top', () => {
  const map = buildHeightmap(makeBox(40, 40, 10), { cellSize: 0.5 });
  const down = downhillAt(map, Math.round(map.width / 2), Math.round(map.height / 2));
  assert.eq(down, null, 'flat ground has no slope to follow');
});

test('flow finishing runs along the slope where zigzag runs across it', () => {
  const mesh = makeRamp();
  const common = {
    tool: BALL, mesh,
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 12] },
    params: {
      topZ: 12, bottomZ: 0, stepover: 0.4, clearanceHeight: 25,
      stockToLeave: 0, tolerance: 0.05,
    },
  };
  // a raster at 90° runs along +Y, i.e. across a ramp that falls along X
  const across = generateToolpath({
    ...common, type: 'parallel3d', name: 'across',
    params: { ...common.params, pattern: 'zigzag', angleDeg: 90 },
  });
  const flow = generateToolpath({
    ...common, type: 'parallel3d', name: 'flow',
    params: { ...common.params, pattern: 'flow' },
  });

  assert.ok(cutPoints(flow).length > 20, 'flow produced passes');

  // measure how much each pass changes height as it travels: following the
  // slope means descending steadily, cutting across it means staying level
  const descentRatio = (cl) => {
    let travel = 0;
    let drop = 0;
    let prev = null;
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (op !== OP.LINE || feed === FEED.RAPID) { prev = null; return; }
      if (prev) {
        travel += Math.hypot(x - prev[0], y - prev[1]);
        drop += Math.abs(z - prev[2]);
      }
      prev = [x, y, z];
    });
    return travel > 0 ? drop / travel : 0;
  };

  const flowRatio = descentRatio(flow);
  const acrossRatio = descentRatio(across);
  assert.ok(flowRatio > acrossRatio * 2,
    `flow should descend along the slope (${flowRatio.toFixed(3)}) far more than a cross raster (${acrossRatio.toFixed(3)})`);
});

/** Fraction of the part footprint that lies within `reach` of some cut point. */
/**
 * Every point a cutting move passes through, at most `step` apart.
 *
 * Coverage is a question about where the tool *goes*, not about where the
 * program happens to put its points. Strategies merge collinear runs on the way
 * out (see engine/simplify.js), so a pass straight across a flat top is two
 * points — and asking whether a plateau was machined by looking for points near
 * it would answer no for a pass that swept the whole thing.
 */
function cutPath(cl, step) {
  const pts = [];
  let prev = null;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE || feed === FEED.RAPID) { prev = null; return; }
    if (prev) {
      const n = Math.max(1, Math.ceil(Math.hypot(x - prev[0], y - prev[1]) / step));
      for (let p = 1; p < n; p++) {
        const t = p / n;
        pts.push([prev[0] + (x - prev[0]) * t, prev[1] + (y - prev[1]) * t]);
      }
    }
    pts.push([x, y, z]);
    prev = [x, y, z];
  });
  return pts;
}

function surfaceCoverage(cl, footprint, reach) {
  const cuts = cutPath(cl, reach / 2);
  const index = new Map();
  for (const [x, y] of cuts) {
    const key = `${Math.floor(x / reach)},${Math.floor(y / reach)}`;
    let bucket = index.get(key);
    if (!bucket) { bucket = []; index.set(key, bucket); }
    bucket.push(x, y);
  }

  let total = 0;
  let hit = 0;
  for (let y = footprint.min[1]; y <= footprint.max[1]; y += reach / 2) {
    for (let x = footprint.min[0]; x <= footprint.max[0]; x += reach / 2) {
      total++;
      const gi = Math.floor(x / reach), gj = Math.floor(y / reach);
      let ok = false;
      for (let dj = -1; dj <= 1 && !ok; dj++) {
        for (let di = -1; di <= 1 && !ok; di++) {
          const bucket = index.get(`${gi + di},${gj + dj}`);
          if (!bucket) continue;
          for (let n = 0; n < bucket.length; n += 2) {
            if (Math.hypot(bucket[n] - x, bucket[n + 1] - y) <= reach) { ok = true; break; }
          }
        }
      }
      if (ok) hit++;
    }
  }
  return total > 0 ? hit / total : 0;
}

test('flow finishing covers the whole surface, not just the sloped parts', () => {
  // The regression this guards: streamlines have no direction to follow on a
  // flat, so an early version abandoned them there and left plateaus uncut —
  // a hole in a *finishing* pass, which is uncut material, not a cosmetic issue.
  const run = (mesh, top) => generateToolpath({
    type: 'parallel3d', name: 'flow', tool: BALL, mesh,
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, top] },
    params: {
      topZ: top, bottomZ: 0, stepover: 0.25, clearanceHeight: top + 10,
      stockToLeave: 0, tolerance: 0.05, pattern: 'flow',
    },
  });
  const footprint = { min: [2, 2], max: [38, 38] };
  const reach = 0.25 * BALL.diameter;

  const flat = surfaceCoverage(run(makeBox(40, 40, 10), 10), footprint, reach);
  assert.ok(flat > 0.95, `flat top only ${(flat * 100).toFixed(0)}% covered`);

  const sloped = surfaceCoverage(run(makeRamp(), 12), footprint, reach);
  assert.ok(sloped > 0.95, `ramp only ${(sloped * 100).toFixed(0)}% covered`);
});

test('flow passes stay about a stepover apart', () => {
  // evenly-spaced streamline placement is the point: without it passes bunch up
  // in the valleys and leave gaps on the flanks
  const cl = generateToolpath({
    type: 'parallel3d', name: 'flow', tool: BALL, mesh: makeRamp(),
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 12] },
    params: {
      topZ: 12, bottomZ: 0, stepover: 0.25, clearanceHeight: 25,
      stockToLeave: 0, tolerance: 0.05, pattern: 'flow',
    },
  });
  // the ramp falls along X, so passes run along X and are spaced in Y
  const ys = [...new Set(cutPoints(cl)
    .filter(([x]) => x > 15 && x < 25)
    .map(([, y]) => Math.round(y * 4) / 4))].sort((a, b) => a - b);
  assert.ok(ys.length > 5, 'several passes crossed the middle');

  const gaps = [];
  for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] > 0.3) gaps.push(ys[i] - ys[i - 1]);
  const worst = Math.max(...gaps, 0);
  const stepover = 0.25 * BALL.diameter;
  assert.ok(worst < stepover * 2.2, `largest gap between passes was ${worst.toFixed(2)}mm`);
});

test('flow finishing does not walk back over ground it has just cut', () => {
  // Where a plateau meets a descent, steepest descent points back the way the
  // pass came: the flat carries the heading straight on, the tool crosses onto
  // the shoulder, and the downhill there is *outward*. The pass turned round
  // and retraced itself, so it cut a multiple of the raster's distance over
  // less of the surface than the raster covered — and every extra lap is a
  // pass over a finished face with the cutter still down.
  //
  // Both patterns finish the same surface at the same stepover, so the raster's
  // cutting distance is what the streamlines should cost too, give or take the
  // slack a curved path takes over a straight one.
  const { mesh, height } = makeStepped();
  const common = {
    type: 'parallel3d', tool: BALL, mesh,
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, height] },
    params: {
      topZ: height, bottomZ: 0, stepover: 0.25, clearanceHeight: height + 10,
      stockToLeave: 0, tolerance: 0.05,
    },
  };
  const distance = (cl) => {
    let travel = 0;
    let prev = null;
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (op !== OP.LINE || feed === FEED.RAPID) { prev = null; return; }
      if (prev) travel += Math.hypot(x - prev[0], y - prev[1], z - prev[2]);
      prev = [x, y, z];
    });
    return travel;
  };
  const raster = distance(generateToolpath({
    ...common, name: 'zigzag', params: { ...common.params, pattern: 'zigzag' },
  }));
  const flow = distance(generateToolpath({
    ...common, name: 'flow', params: { ...common.params, pattern: 'flow' },
  }));
  // 1.26x the raster with the reversal stopped; 2.90x without it.
  assert.ok(flow < raster * 1.6,
    `flow cut ${flow.toFixed(0)}mm to finish what the raster finished in ${raster.toFixed(0)}mm`);
});

test('flow finishing links its passes instead of retracting between them', () => {
  // A streamline pass is one of hundreds, and each one used to get its own
  // emitter state and a climb to clearance after it — so the tool went to the
  // top of the job and back for every pass, and the passes came out in seed
  // order, which put the next one nowhere near the last. Ordered end to end,
  // the gap between passes is a stepover and the tool can stay down for it.
  const { mesh, height } = makeStepped();
  const cl = generateToolpath({
    type: 'parallel3d', name: 'flow', tool: BALL, mesh,
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, height] },
    params: {
      topZ: height, bottomZ: 0, stepover: 0.25, clearanceHeight: height + 10,
      stockToLeave: 0, tolerance: 0.05, pattern: 'flow',
    },
  });
  // The tool is either cutting or getting somewhere. What the retracts cost is
  // the distance spent on the second, and it is the one number that does not
  // depend on how many streamlines the surface happened to want.
  let cut = 0;
  let air = 0;
  let toClearance = 0;
  let prev = null;
  eachMove(cl, (op, x, y, z) => {
    const here = [x, y, z];
    if (prev) {
      const d = Math.hypot(x - prev[0], y - prev[1], z - prev[2]);
      if (op === OP.RAPID) air += d; else cut += d;
    }
    if (op === OP.RAPID && z >= height + 10 - 1e-6) toClearance++;
    prev = here;
  });
  // Ordered and linked: 0.11x cut in air over 5 climbs. Emitted in seed order
  // with a retract after each pass: 1.36x cut in air over 89 climbs.
  assert.ok(cut > 500, `only ${cut.toFixed(0)}mm of cutting — the part is not being finished`);
  assert.ok(air < cut * 0.25,
    `${air.toFixed(0)}mm of rapid to lay down ${cut.toFixed(0)}mm of cut`);
  assert.ok(toClearance < 20, `${toClearance} climbs to full clearance`);
});

test('flow finishing does not gouge the ramp', () => {
  const mesh = makeRamp();
  const cl = generateToolpath({
    type: 'parallel3d', name: 'flow', tool: BALL, mesh,
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 12] },
    params: {
      topZ: 12, bottomZ: 0, stepover: 0.4, clearanceHeight: 25,
      stockToLeave: 0, tolerance: 0.05, pattern: 'flow',
    },
  });
  // the ramp surface is z = x * slope over its run; check every cut sits on
  // or above the ball's contact height there
  const r = BALL.diameter / 2;
  for (const [x, y, z] of cutPoints(cl)) {
    const surface = rampHeightAt(x);
    assert.ok(z >= surface - r - 0.15,
      `cut at (${x.toFixed(1)}, ${y.toFixed(1)}) sank to ${z.toFixed(2)}, surface ${surface.toFixed(2)}`);
  }
});

function rampHeightAt(x) {
  const clamped = Math.min(Math.max(x, 0), 40);
  return (clamped / 40) * 10;
}

// --- disabled operations ---

test('a disabled operation contributes no toolpath anywhere', () => {
  const doc = new Document();
  const setup = createSetup();
  doc.project.setups.push(setup);
  const a = createOperation('contour2d');
  const b = createOperation('clear2d');
  setup.operations.push(a, b);

  const stub = () => new CLBuilder().finish();
  doc.toolpaths.set(a.id, stub());
  doc.toolpaths.set(b.id, stub());
  assert.eq(doc.enabledToolpaths().length, 2, 'both enabled to start');

  b.enabled = false;
  assert.eq(doc.enabledToolpaths().length, 1, 'disabling drops it from the backplot');
  // the path is kept so re-enabling is instant
  assert.ok(doc.toolpaths.has(b.id), 'but the generated path is retained');
  b.enabled = true;
  assert.eq(doc.enabledToolpaths().length, 2, 're-enabling brings it straight back');
});

test('the toolpath signature changes when an operation is toggled', () => {
  const doc = new Document();
  const setup = createSetup();
  doc.project.setups.push(setup);
  const op = createOperation('contour2d');
  setup.operations.push(op);
  doc.toolpaths.set(op.id, new CLBuilder().finish());

  const before = doc.toolpathSignature();
  op.enabled = false;
  assert.ok(doc.toolpathSignature() !== before, 'the viewport must know to redraw');
});

// --- clearing the project ---

test('clearing the document empties it and resets undo', () => {
  const doc = new Document();
  doc.addTool(createTool());
  doc.addSetup(createSetup());
  assert.eq(doc.project.tools.length, 1);

  doc.clear();
  assert.eq(doc.project.tools.length, 0, 'tools gone');
  assert.eq(doc.project.setups.length, 0, 'setups gone');
  assert.eq(doc.meshes.size, 0, 'meshes gone');
  assert.eq(doc.selection, null, 'selection cleared');
  doc.undo();
  assert.eq(doc.project.tools.length, 0, 'undo cannot resurrect a cleared project');
});
