// Does any operation drive the cutter through material that is still there?
//
// "The tool ran through the object" is the failure that scraps a part or breaks
// a cutter, and the tests elsewhere check linking a strategy at a time, on a
// fixture chosen to show that strategy linking well. This checks the other side,
// the way sanity.test.js does for absurd output: run every milling strategy on
// parts with real vertical features — a step, a walled pocket, an overhanging
// cap — and assert that no *rapid* passes the cutter through material that has
// not been cut away yet.
//
// The check is dynamic, not a comparison against the finished part: a rapid
// below the part's top surface is fine over ground a pass has already cleared,
// and a crash over ground it has not. So it plays the program into a heightmap —
// cut moves lower the material, rapids are tested against what is left — which
// is what the simulation does, in miniature and per move. Roughers run on the
// raw billet; finishing and profiling run on a roughed billet, because that is
// the material the machine actually meets when they run.
//
// It is measured at the tool *centre* (a small disc), because that is the
// unambiguous crash: the cutter body inside solid material. A round tool's rim
// grazing an internal corner it cannot reach by a few tenths is normal and is
// not what this is looking for.

import { test, assert } from './runner.js';
import { generateToolpath, MILLING_OPS } from '../engine/toolpath.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { MOVE_STRIDE, OP, FEED } from '../engine/cl.js';
import { regionReachFor } from '../engine/op-reach.js';
import { fixtureLoops } from '../engine/fixtures.js';
import { offsetLoops } from '../geom/clipper.js';
import { makeStepped, makePocketBlock, makeMushroom, makeBox } from './fixtures.js';
import { simulateRemoval } from '../engine/simulate.js';
import { loadSampleBuffer } from './samples.js';
import { parseSTL } from '../io/stl.js';
import { meshFromSoup, computeNormals } from '../geom/mesh.js';
import { resolveSetup } from '../engine/setup.js';
import { computeStock } from '../engine/stock.js';
import { createSetup } from '../doc/schema.js';
import { cutsOf } from './cuts.js';

const TOOLS = {
  flat: { number: 1, type: 'flat', diameter: 6, flutes: 2, fluteLength: 30, spindleRpm: 12000, feedCut: 800, feedPlunge: 250 },
  ball: { number: 2, type: 'ball', diameter: 4, flutes: 2, fluteLength: 30, spindleRpm: 12000, feedCut: 800, feedPlunge: 250 },
  vee: { number: 4, type: 'chamfer', diameter: 6, tipAngle: 90, tipDiameter: 0, flutes: 1, fluteLength: 10, spindleRpm: 10000, feedCut: 600, feedPlunge: 200 },
};
const toolFor = (t) => ((t === 'chamfer' || t === 'engrave') ? TOOLS.vee
  : (t === 'parallel3d' || t === 'waterline') ? TOOLS.ball : TOOLS.flat);

const PARTS = {
  stepped: { mesh: makeStepped({ base: 40, top: 20, baseHeight: 10, topHeight: 10 }).mesh, stock: { min: [0, 0, 0], max: [40, 40, 20] }, top: 20 },
  pocket: { mesh: makePocketBlock({ size: 40, pocketSize: 20, height: 20, depth: 12 }).mesh, stock: { min: [0, 0, 0], max: [40, 40, 20] }, top: 20 },
  mushroom: { mesh: makeMushroom({ postSize: 10, capSize: 30, postHeight: 10, capHeight: 5, center: [20, 20] }).mesh, stock: { min: [0, 0, 0], max: [40, 40, 15] }, top: 15 },
};

// The strategies that remove bulk, so they run on the raw billet and clear their
// own way ahead; everything else runs after one of these has roughed.
const ROUGHERS = new Set(['face', 'contour2d', 'pocket', 'slot', 'clear2d', 'adaptive']);

// --- a heightmap the size of the billet, cut moves lower it, rapids read it ---

function makeGrid(stock, cell = 0.3) {
  const w = Math.ceil((stock.max[0] - stock.min[0]) / cell) + 1;
  const h = Math.ceil((stock.max[1] - stock.min[1]) / cell) + 1;
  return { w, h, cell, min: [stock.min[0], stock.min[1]], data: new Float32Array(w * h).fill(stock.max[2]) };
}
function discCells(g, x, y, r, fn) {
  const i0 = Math.max(0, Math.floor((x - r - g.min[0]) / g.cell));
  const i1 = Math.min(g.w - 1, Math.ceil((x + r - g.min[0]) / g.cell));
  const j0 = Math.max(0, Math.floor((y - r - g.min[1]) / g.cell));
  const j1 = Math.min(g.h - 1, Math.ceil((y + r - g.min[1]) / g.cell));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const cx = g.min[0] + i * g.cell;
      const cy = g.min[1] + j * g.cell;
      if ((cx - x) ** 2 + (cy - y) ** 2 <= r * r) fn(j * g.w + i);
    }
  }
}
/** Lower the material under a flat disc to z — what a cut move takes off. */
function cutDisc(g, x, y, z, r) {
  discCells(g, x, y, r, (k) => { if (z < g.data[k]) g.data[k] = z; });
}
/** The tallest material remaining under a disc — what a rapid would hit. */
function maxUnder(g, x, y, r) {
  let m = -Infinity;
  discCells(g, x, y, r, (k) => { if (g.data[k] > m) m = g.data[k]; });
  return m;
}

/**
 * Play a program into the grid; report how far any rapid of the flagged
 * operations drove the cutter *centre* into standing material.
 */
function deepestGouge(grid, ops, flag) {
  let worst = 0;
  let where = null;
  ops.forEach((op, oi) => {
    const { cl, tool } = op;
    const rCut = tool.diameter / 2;
    // the centre disc: small, so this is "the cutter body is in solid material",
    // not a rim grazing a corner it was never going to reach
    const rCheck = Math.min(0.3, rCut * 0.3);
    const d = cl.moves;
    let prev = null;
    for (let n = 0; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      if (d[o] === OP.DRILL) { cutDisc(grid, d[o + 1], d[o + 2], d[o + 3], rCut); prev = [d[o + 1], d[o + 2], d[o + 4]]; continue; }
      const p = [d[o + 1], d[o + 2], d[o + 3]];
      const feed = d[o + 7];
      if (prev) {
        const len = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        const steps = Math.max(1, Math.ceil(len / grid.cell));
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const x = prev[0] + (p[0] - prev[0]) * t;
          const y = prev[1] + (p[1] - prev[1]) * t;
          const z = prev[2] + (p[2] - prev[2]) * t;
          if (feed === FEED.RAPID) {
            if (flag.has(oi)) {
              const pen = maxUnder(grid, x, y, rCheck) - z;
              if (pen > worst) { worst = pen; where = [x, y, z]; }
            }
          } else {
            cutDisc(grid, x, y, z, rCut);
          }
        }
      }
      prev = p;
    }
  });
  return { worst, where };
}

function clFor(type, part, tool) {
  const params = {
    ...defaultParamsFor(type, { stock: part.stock, tool }),
    tolerance: 0.05, clearanceHeight: part.top + 15, topZ: part.top, bottomZ: 0,
  };
  return generateToolpath({ type, name: type, tool, mesh: part.mesh, stock: part.stock, params, fixtures: [] });
}

test('no milling operation rapids the cutter through standing material', () => {
  // A rougher (⌀6 flat) to sit under the finishing and profiling passes, so they
  // meet the billet the way they would in a real program rather than full stock.
  const roughs = {};
  for (const [name, part] of Object.entries(PARTS)) roughs[name] = clFor('clear2d', part, TOOLS.flat);

  for (const type of MILLING_OPS) {
    if (type === 'drill' || type === 'bore') continue;   // vertical-axis; own holes
    const tool = toolFor(type);
    for (const [name, part] of Object.entries(PARTS)) {
      const cl = clFor(type, part, tool);
      if (cl.count === 0) continue;                        // nothing to cut here
      const grid = makeGrid(part.stock);
      const ops = [];
      if (!ROUGHERS.has(type) && roughs[name].count) ops.push({ cl: roughs[name], tool: TOOLS.flat });
      const flag = new Set([ops.length]);
      ops.push({ cl, tool });
      const { worst, where } = deepestGouge(grid, ops, flag);
      // 0.3mm of slack for the grid's own coarseness — a real plunge-through is
      // millimetres, not tenths (measured worst across every op here was 0).
      assert.ok(worst <= 0.3,
        `${type} on the ${name} rapids ${worst.toFixed(2)}mm into material at `
        + `(${where?.map((v) => v.toFixed(1)).join(', ')})`);
    }
  }
});

test('indexed operations carry the same collision safety (same toolpath)', () => {
  // Indexing changes nothing about the toolpath — the cutting moves are
  // byte-identical tilted or flat (see indexing.test.js) — so the check above
  // covers the tilted case too. This states the dependency out loud: the moment
  // an indexed op's motion could differ from its flat one, that guarantee is
  // gone and this file would need to run in the tilted frame as well.
  const part = PARTS.pocket;
  const flat = clFor('pocket', part, TOOLS.flat);
  const feeds = (cl) => {
    const out = [];
    const d = cl.moves;
    for (let n = 0; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      if (d[o] !== OP.DRILL && d[o + 7] !== FEED.RAPID) out.push([d[o + 1], d[o + 2], d[o + 3]].join(','));
    }
    return out.join(';');
  };
  // regenerating the same op is deterministic, so its cutting moves are its own
  assert.eq(feeds(flat), feeds(clFor('pocket', part, TOOLS.flat)),
    'the toolpath a collision check would see is stable');
});

// --- clamps: the whole cutter must miss the jaw, not just its axis -----------
//
// A clamp is a keep-out for the whole tool, and the app grows it accordingly —
// `resolveRegions` offsets the jaw footprint by `body − cutRadius` and the
// strategy grows it by `cutRadius`, so the axis stays a full radius clear. The
// one strategy that broke this was engrave marking *on* the line: it clips its
// lines against a keep-out with radius zero, so it ran the cutter's whole radius
// over the jaw — the mark stopped where its *axis* met the clamp. This replays
// the app's own clamp→keep-out math and checks the axis clears the jaw below its
// top, cutting and rapiding alike.

const CLAMP = { x0: -2, y0: -2, x1: 10, y1: 42, top: 28 };
const CLAMP_FIXTURE = {
  kind: 'box', name: 'jaw', enabled: true,
  center: [(CLAMP.x0 + CLAMP.x1) / 2, (CLAMP.y0 + CLAMP.y1) / 2],
  size: [CLAMP.x1 - CLAMP.x0, CLAMP.y1 - CLAMP.y0], rotationDeg: 0, baseZ: 0, height: CLAMP.top,
};

/** The keep-out the app hands a strategy for these clamps — see regions-ui.js. */
function clampAvoid(type, tool, params, fixtures = [CLAMP_FIXTURE]) {
  const body = Math.max(0, (tool.diameter ?? 0) / 2);
  const { cutRadius } = regionReachFor({ type, params }, tool);
  const loops = fixtureLoops(fixtures);
  return body > cutRadius + 1e-9 ? offsetLoops(loops, body - cutRadius, 0.01) : loops;
}

const overClamp = (x, y) => x >= CLAMP.x0 && x <= CLAMP.x1 && y >= CLAMP.y0 && y <= CLAMP.y1;

test('no operation drives the cutter axis over a clamp below its top', () => {
  const parts = {
    pocket: { mesh: makePocketBlock({ size: 40, pocketSize: 16, height: 20, depth: 12 }).mesh, stock: { min: [0, 0, 0], max: [40, 40, 20] }, top: 20 },
    stepped: { mesh: makeStepped({ base: 40, top: 20, baseHeight: 10, topHeight: 10 }).mesh, stock: { min: [0, 0, 0], max: [40, 40, 20] }, top: 20 },
    box: { mesh: makeBox(40, 40, 10), stock: { min: [0, 0, 0], max: [40, 40, 10] }, top: 10 },
  };
  for (const type of MILLING_OPS) {
    if (type === 'drill' || type === 'bore') continue;   // handled by point keep-outs
    const tool = toolFor(type);
    for (const [name, part] of Object.entries(parts)) {
      const params = {
        ...defaultParamsFor(type, { stock: part.stock, tool }),
        tolerance: 0.05, clearanceHeight: part.top + 15, retractHeight: part.top + 3, topZ: part.top, bottomZ: 0,
      };
      let cl;
      try {
        cl = generateToolpath({
          type, name: type, tool, mesh: part.mesh, stock: part.stock, params,
          fixtures: [CLAMP_FIXTURE],
          regions: { include: [], avoid: clampAvoid(type, tool, params), cleared: [], edgePaths: [] },
        });
      } catch { continue; }
      if (cl.count === 0) continue;
      const d = cl.moves;
      let prev = null;
      let worstCut = 0;
      let worstRapid = 0;
      let at = null;
      for (let n = 0; n < cl.count; n++) {
        const o = n * MOVE_STRIDE;
        if (d[o] === OP.DRILL) { prev = [d[o + 1], d[o + 2], d[o + 4]]; continue; }
        const p = [d[o + 1], d[o + 2], d[o + 3]];
        const feed = d[o + 7];
        if (prev) {
          const len = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
          const steps = Math.max(1, Math.ceil(len / 0.5));
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const x = prev[0] + (p[0] - prev[0]) * t;
            const y = prev[1] + (p[1] - prev[1]) * t;
            const z = prev[2] + (p[2] - prev[2]) * t;
            if (!overClamp(x, y)) continue;
            if (feed === FEED.RAPID) {
              const pen = CLAMP.top - z;
              if (pen > worstRapid) { worstRapid = pen; at = [x, y, z]; }
            } else {
              const depth = part.top - z;
              if (depth > worstCut) { worstCut = depth; at = [x, y, z]; }
            }
          }
        }
        prev = p;
      }
      assert.ok(worstCut <= 0.1,
        `${type} on the ${name} cuts with its axis over the clamp, ${worstCut.toFixed(1)}mm `
        + `below the part top at (${at?.map((v) => v.toFixed(1)).join(', ')})`);
      assert.ok(worstRapid <= 0.1,
        `${type} on the ${name} rapids with its axis over the clamp, ${worstRapid.toFixed(1)}mm `
        + `below the jaw top at (${at?.map((v) => v.toFixed(1)).join(', ')})`);
    }
  }
});

test('no milling op traverses below a clamp taller than its clearance', () => {
  // A clamp is a keep-out for the whole column above its footprint, so a
  // traverse plane below the tallest clamp rapids through it — and the cut moves
  // route around the clamp perfectly, which is what hid it. The op asks for a
  // clearance *below* the jaw here (a toe clamp standing proud of a thin part
  // with the default stock+10 clearance); the dispatch floors the traverse to
  // clear the jaw anyway (see toolpath.js clampSafeArgs).
  const TALL = {
    kind: 'box', name: 'toe', enabled: true, center: [20, 20], size: [8, 8], rotationDeg: 0,
    baseZ: 0, height: 30,   // stands to Z30 — well above the part and the clearance
  };
  const part = { mesh: makeBox(40, 40, 8), stock: { min: [0, 0, 0], max: [40, 40, 8] }, top: 8 };
  const overToe = (x, y) => x >= 16 && x <= 24 && y >= 16 && y <= 24;
  for (const type of MILLING_OPS) {
    if (type === 'drill' || type === 'bore') continue;
    const tool = toolFor(type);
    const params = {
      ...defaultParamsFor(type, { stock: part.stock, tool }),
      tolerance: 0.05, clearanceHeight: 18, retractHeight: 11, topZ: part.top, bottomZ: 0,
    };
    const avoid = clampAvoid(type, tool, params, [TALL]);
    let cl;
    try {
      cl = generateToolpath({
        type, name: type, tool, mesh: part.mesh, stock: part.stock, params,
        fixtures: [TALL],
        regions: { include: [], avoid, cleared: [], edgePaths: [] },
      });
    } catch { continue; }
    if (cl.count === 0) continue;
    const d = cl.moves;
    let prev = null;
    let worst = 0;
    for (let n = 0; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      if (d[o] === OP.DRILL) { prev = [d[o + 1], d[o + 2], d[o + 4]]; continue; }
      const p = [d[o + 1], d[o + 2], d[o + 3]];
      if (prev) {
        const steps = Math.max(1, Math.ceil(Math.hypot(p[0] - prev[0], p[1] - prev[1]) / 0.5));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const x = prev[0] + (p[0] - prev[0]) * t;
          const y = prev[1] + (p[1] - prev[1]) * t;
          const z = prev[2] + (p[2] - prev[2]) * t;
          if (overToe(x, y)) worst = Math.max(worst, TALL.height - z);
        }
      }
      prev = p;
    }
    assert.ok(worst <= 0.1, `${type} passes ${worst.toFixed(1)}mm below the Z${TALL.height} toe clamp`);
  }
});

// --- what a level takes, measured by the simulator ---------------------------
//
// A Z-level pass cuts one level at a time on the promise that the level above
// took its ground down to itself. Where it did not — a strip beside a vise jaw
// it skipped, a gap too narrow for adaptive to open — the level below cut that
// stock at the depth of two or three levels, and dropped onto it at rapid
// first. Measured on the real simulator's own record, which is what a user
// sees: every cell a step lowered, how far it came down under the cutter that
// lowered it, and whether that was above the top of the flutes.

/** Two vise jaws gripping a billet across its X ends, a millimetre off it and taller than it. */
function viseJaws(stock) {
  const cy = (stock.min[1] + stock.max[1]) / 2;
  const jaw = (x) => ({
    kind: 'box', name: 'Jaw', enabled: true, center: [x, cy],
    size: [10, (stock.max[1] - stock.min[1]) * 0.6], rotationDeg: 0,
    baseZ: stock.min[2], height: stock.max[2] - stock.min[2] + 15,
  });
  return [jaw(stock.min[0] - 6), jaw(stock.max[0] + 6)];
}

/** One roughing op the way the app generates it, simulated from the raw billet. */
function roughAndMeasure(type, mesh, stock, fixtures, over = {}) {
  const tool = { ...TOOLS.flat, fluteLength: 20 };
  const params = { ...defaultParamsFor(type, { stock, tool }), tolerance: 0.02, ...over };
  const cl = generateToolpath({
    type, name: type, tool, mesh, stock, params, fixtures,
    regions: fixtures.length
      ? { include: [], avoid: clampAvoid(type, tool, params, fixtures), cleared: [], edgePaths: [] }
      : null,
  });
  const sim = simulateRemoval({ stock, ops: [{ cl, tool }], maxCells: 90_000, record: 8 });
  return { cl, sim, params, ...cutsOf(sim, tool.diameter / 2, tool.fluteLength) };
}

test('Z-level roughing beside clamps cuts no deeper than a level', () => {
  // The outermost ring was dropped at every level wherever it counted as the
  // billet's edge, which cuts nothing — and a ring counted as that if it was
  // mostly edge, so the stretch of it round a clamp's keep-out went too. That
  // stretch runs inside the billet and is the only pass that reaches the strip
  // of stock beside the clamp. The strip stood the whole height of the part until
  // the level where the base came out far enough for a wall ring to reach it,
  // which cut it in one pass: 12mm deep on this stepped block, 24mm on the clamp
  // part — and the level below dropped into it at rapid, 9.7mm deep.
  const { mesh } = makeStepped({ base: 40, top: 20, baseHeight: 10, topHeight: 10 });
  const stock = { kind: 'box-margin', min: [-1, -1, 0], max: [41, 41, 21] };
  const toe = {
    kind: 'box', name: 'Toe', enabled: true, center: [stock.min[0] - 4, 20], size: [6, 6],
    rotationDeg: 0, baseZ: 0, height: 40,
  };
  for (const [name, fixtures] of [['a pair of vise jaws', viseJaws(stock)], ['a toe clamp', [toe]]]) {
    const { sim, params, deepest } = roughAndMeasure('clear2d', mesh, stock, fixtures);
    assert.ok(!sim.truncated, 'the simulation ran to the end');
    assert.eq(sim.rapidCut.count, 0, `beside ${name}, ${sim.rapidCut.count} rapids through stock, `
      + `${sim.rapidCut.depth.toFixed(2)}mm deep`);
    assert.ok(deepest <= params.stepdown * 1.25 + 0.3,
      `beside ${name}, a cut ${deepest.toFixed(2)}mm deep on a ${params.stepdown}mm stepdown`);
  }
});

test('adaptive between vise jaws neither drops onto nor ploughs through stock a level above left', async () => {
  // On the sloped part the gap between a jaw's keep-out and the part's was
  // narrower than a bite, so no front of the peel landed in it and the wall pass
  // would not drive along it with stock on both sides: a band beside the part
  // stood at the top of the billet. The next level rapided 9.3mm into it at its
  // feed plane and cut it 20.7mm deep, past the end of the flutes.
  //
  // Kept out of the level below, the band is still there to be come down
  // beside: at a 0.4xD bite the level below dropped to its feed plane over it
  // at rapid, 9.3mm into it, until the drop was raised over what stands there
  // (see adaptive.js topAt).
  //
  // And the band was never out of reach. The wall pass runs beside it at every
  // level; it was asked whether it removed anything at twelve points 37mm
  // apart, missed the band between them, and was dropped whole — and at a
  // 0.4xD bite the strip of billet between the band and the edge of the stock
  // was narrower than the raster could see at all (see adaptive.js
  // removesMaterial, geom/coverage.js ClearingMap). Now it is taken a level at
  // a time, and there is nothing tall left to report.
  const raw = computeNormals(meshFromSoup(parseSTL(await loadSampleBuffer('test-slope.stl'))));
  const { meshes, stock } = resolveSetup(createSetup(), [raw], computeStock);
  for (const over of [{}, { engagement: 0.25 }, { engagement: 0.4 }]) {
    const { sim, params, deepest, overFlutes } = roughAndMeasure('adaptive', meshes[0], stock,
      viseJaws(stock), over);
    const at = JSON.stringify(over);
    assert.ok(!sim.truncated, 'the simulation ran to the end');
    assert.eq(sim.rapidCut.count, 0,
      `${at}: ${sim.rapidCut.count} rapids through stock, ${sim.rapidCut.depth.toFixed(2)}mm deep`);
    assert.ok(deepest <= params.stepdown * 1.25 + 0.3,
      `${at}: a cut ${deepest.toFixed(2)}mm deep on a ${params.stepdown}mm stepdown`);
    assert.ok(overFlutes <= 0.05, `${at}: stock ${overFlutes.toFixed(2)}mm above the top of the flutes was cut`);
  }
});

test('adaptive takes the strip of billet a tight margin leaves, a level at a time', async () => {
  // Placed with 0.6mm to spare, the sloped part leaves a strip of billet 0.3mm
  // wide beside it once the allowance is off, and at a 0.4xD bite the raster's
  // cells are 0.8mm: no cell centre fell in the strip, the pass saw air there,
  // and a level near the bottom took the whole of it at once — 20.7mm deep,
  // past the end of the flutes. See geom/coverage.js ClearingMap.
  const raw = computeNormals(meshFromSoup(parseSTL(await loadSampleBuffer('test-slope.stl'))));
  const setup = createSetup();
  setup.stock.margin = [0.6, 0.6, 1];
  const { meshes, stock } = resolveSetup(setup, [raw], computeStock);
  const { sim, params, deepest, overFlutes } = roughAndMeasure('adaptive', meshes[0], stock, [],
    { engagement: 0.4 });
  assert.ok(!sim.truncated, 'the simulation ran to the end');
  assert.eq(sim.rapidCut.count, 0, `${sim.rapidCut.count} rapids through stock`);
  assert.ok(deepest <= params.stepdown * 1.25 + 0.3,
    `a cut ${deepest.toFixed(2)}mm deep on a ${params.stepdown}mm stepdown`);
  assert.ok(overFlutes <= 0.05, `stock ${overFlutes.toFixed(2)}mm above the top of the flutes was cut`);
});

test('adaptive keeps its links out of an allowance taller than its flutes', async () => {
  // A stay-down link may stray into the stock-to-leave, which saves a lift and a
  // re-entry and costs a scratch on stock the finishing pass is going to take
  // anyway. But the allowance is a wall as tall as the part beside it, and at a
  // level deeper than the flutes reach the thing that strays into it is the
  // shank: a 76mm link at the bottom of the sloped part ran 0.2mm into a 31mm
  // wall with 11mm of plain shank above the flutes.
  const raw = computeNormals(meshFromSoup(parseSTL(await loadSampleBuffer('test-slope.stl'))));
  const { meshes, stock } = resolveSetup(createSetup(), [raw], computeStock);
  const { sim, overFlutes } = roughAndMeasure('adaptive', meshes[0], stock, []);
  assert.ok(!sim.truncated, 'the simulation ran to the end');
  assert.eq(sim.rapidCut.count, 0, `${sim.rapidCut.count} rapids through stock`);
  assert.ok(overFlutes <= 0.05, `stock ${overFlutes.toFixed(2)}mm above the top of the flutes was cut`);
});

// --- a cut that starts under the top of the billet -----------------------------
//
// Top Z is where the cut starts, and it is not always the top of the billet: a
// cut can begin four millimetres down, after something else has taken the top
// off. Every one of these strategies comes down onto its first pass at rapid,
// and an operation does not know what came before it - if the metal over Top Z
// is still there, the rapid goes into it (three millimetres of it, here). What
// it can do is say what it counted on, so that it is on the page next to the
// simulation that shows whether it held.

test('a cut that starts under the top of the billet says what it counts on', () => {
  const { mesh } = makeStepped({ base: 40, top: 20, baseHeight: 10, topHeight: 10 });
  const stock = { kind: 'box-margin', min: [-1, -1, 0], max: [41, 41, 23] };
  const tool = { ...TOOLS.flat, fluteLength: 20 };
  for (const type of ['pocket', 'clear2d', 'adaptive', 'contour2d', 'slot']) {
    const params = { ...defaultParamsFor(type, { stock, tool }), tolerance: 0.05, topZ: 19 };
    const cl = generateToolpath({ type, name: type, tool, mesh, stock, params, fixtures: [] });
    if (!cl.count) continue;
    assert.ok(cl.notes.some((n) => /billet stands 4mm above Top Z \(Z19, against Z23\)/.test(n.text)),
      `${type}: ${JSON.stringify(cl.notes.map((n) => n.text.slice(0, 70)))}`);
  }
});

test('and one that starts at the top of the billet has nothing to say about it', () => {
  const { mesh } = makeStepped({ base: 40, top: 20, baseHeight: 10, topHeight: 10 });
  const stock = { kind: 'box-margin', min: [-1, -1, 0], max: [41, 41, 23] };
  const tool = { ...TOOLS.flat, fluteLength: 20 };
  for (const type of ['pocket', 'clear2d', 'adaptive', 'contour2d', 'slot']) {
    const params = { ...defaultParamsFor(type, { stock, tool }), tolerance: 0.05 };
    const cl = generateToolpath({ type, name: type, tool, mesh, stock, params, fixtures: [] });
    assert.ok(!cl.notes.some((n) => /billet stands/.test(n.text)), `${type}: nothing to say`);
  }
});
