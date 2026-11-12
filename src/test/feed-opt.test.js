// Feed from engagement: the feed follows how much of the cutter is in the metal,
// and nothing else about the program moves.
//
// The measure of "how much" here is a second implementation, written for this
// file: a heightmap of the billet that each move carves, as in engagement.test.js.
// It shares no code with the simulator that feeds the optimiser, so when the
// two agree about a bite the agreement is evidence and not an echo.

import { test, assert } from './runner.js';
import { generateToolpath, estimateSeconds } from '../engine/toolpath.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { simulateRemoval, simulateProgram } from '../engine/simulate.js';
import { eachMove, OP, FEED, MOVE_STRIDE, CLBuilder } from '../engine/cl.js';
import { optimiseFeeds, refusal, FEED_OPT } from '../engine/feed-opt.js';
import { cuttingPowerKw } from '../doc/materials.js';
import { createMachine } from '../doc/machines.js';
import { buildGcode } from '../post/index.js';
import { checkPost } from '../engine/backplot.js';
import { makePocketBlock } from './fixtures.js';

const TOOL = {
  number: 1, type: 'flat', name: '6mm flat', diameter: 6, flutes: 2,
  fluteLength: 20, spindleRpm: 12000, feedCut: 800, feedPlunge: 250,
};
const STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] };

function pocketProgram({ stepover = 0.4, size = 24 } = {}) {
  const { mesh } = makePocketBlock({ size: 40, pocketSize: size, height: 20, depth: 8 });
  const params = { ...defaultParamsFor('pocket', { stock: STOCK, tool: TOOL }), stepover, stepdown: 4, clearanceHeight: 30 };
  const cl = generateToolpath({ type: 'pocket', name: 'pocket', tool: TOOL, mesh, stock: STOCK, params });
  return { cl, params };
}

function simulate(cl, moveLoad = true) {
  const run = simulateRemoval({ stock: STOCK, ops: [{ cl, tool: TOOL }], maxCells: 160_000, moveLoad });
  return run;
}

/** The independent measurer: a flat cutter carving a heightmap, one move at a time. */
function measure(cl, cell = 0.1) {
  const pad = 6;
  const w = Math.ceil((STOCK.max[0] - STOCK.min[0] + 2 * pad) / cell) + 1;
  const h = Math.ceil((STOCK.max[1] - STOCK.min[1] + 2 * pad) / cell) + 1;
  const top = new Float32Array(w * h).fill(-1e9);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = STOCK.min[0] - pad + i * cell;
      const y = STOCK.min[1] - pad + j * cell;
      if (x >= STOCK.min[0] && x <= STOCK.max[0] && y >= STOCK.min[1] && y <= STOCK.max[1]) top[j * w + i] = STOCK.max[2];
    }
  }
  const r = TOOL.diameter / 2;
  const out = new Array(cl.count).fill(null);
  let prev = null;
  eachMove(cl, (op, x, y, z, i, j, k, feed, index) => {
    if (op === OP.DRILL || !prev) { prev = [x, y, z]; return; }
    const len = Math.hypot(x - prev[0], y - prev[1]);
    const rapid = op === OP.RAPID || feed === FEED.RAPID;
    const descending = z < prev[2] - 1e-6 && prev[2] - z > len * 0.02;
    const n = Math.max(1, Math.ceil(len / 0.25));
    let area = 0;
    let travel = 0;
    let deepest = 0;
    for (let p = 1; p <= n; p++) {
      const t0 = (p - 1) / n;
      const t1 = p / n;
      const ax = prev[0] + (x - prev[0]) * t0;
      const ay = prev[1] + (y - prev[1]) * t0;
      const bx = prev[0] + (x - prev[0]) * t1;
      const by = prev[1] + (y - prev[1]) * t1;
      const az = prev[2] + (z - prev[2]) * t0;
      const bz = prev[2] + (z - prev[2]) * t1;
      const plane = Math.min(az, bz) + 1e-4;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - (STOCK.min[0] - pad)) / cell));
      const i1 = Math.min(w - 1, Math.ceil((Math.max(ax, bx) + r - (STOCK.min[0] - pad)) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r - (STOCK.min[1] - pad)) / cell));
      const j1 = Math.min(h - 1, Math.ceil((Math.max(ay, by) + r - (STOCK.min[1] - pad)) / cell));
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      let cells = 0;
      for (let jj = j0; jj <= j1; jj++) {
        const py = STOCK.min[1] - pad + jj * cell;
        for (let ii = i0; ii <= i1; ii++) {
          const px = STOCK.min[0] - pad + ii * cell;
          let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          if (Math.hypot(px - (ax + dx * t), py - (ay + dy * t)) > r) continue;
          const surface = az + (bz - az) * t;
          const was = top[jj * w + ii];
          if (was <= surface + 1e-6) continue;
          if (was > -1e8) {
            if (was - surface > deepest) deepest = was - surface;
            if (was > plane && surface <= plane) cells++;
          }
          top[jj * w + ii] = surface;
        }
      }
      area += cells * cell * cell;
      travel += Math.hypot(dx, dy);
    }
    out[index] = rapid || descending || travel < 1e-9 ? null
      : { width: Math.min(area / travel, 2 * r), depth: deepest, length: len };
    prev = [x, y, z];
  });
  return out;
}

/** The cutting feed in force at each move, from the events. */
function feedAt(cl) {
  const events = cl.events.filter((e) => e.type === 'feeds').sort((a, b) => a.index - b.index);
  const out = new Float64Array(cl.count);
  let k = 0;
  let cut = 0;
  for (let n = 0; n < cl.count; n++) {
    while (k < events.length && events[k].index <= n) cut = events[k++].cut;
    out[n] = cut;
  }
  return out;
}

test('the simulation reports what each move took, and it agrees with a second measurer', () => {
  const { cl } = pocketProgram();
  const run = simulate(cl);
  assert.ok(run.moveLoad && run.moveLoad.length === 1, 'one record per operation');
  const rec = run.moveLoad[0];
  assert.eq(rec.width.length, cl.count);
  const truth = measure(cl);
  let compared = 0;
  let worst = 0;
  let heavyAgreed = 0;
  let heavyTruth = 0;
  for (let n = 0; n < cl.count; n++) {
    const t = truth[n];
    if (!t || t.length < 1 || rec.kind[n] !== 0) continue;
    compared++;
    worst = Math.max(worst, Math.abs(t.width - rec.width[n]));
    if (t.width > 4.5) { heavyTruth++; if (rec.width[n] > 3.5) heavyAgreed++; }
  }
  assert.ok(compared > 20, `compared ${compared} moves`);
  // two heightmaps on different grids: agreement to a few tenths of a millimetre
  assert.ok(worst < 1.2, `worst disagreement ${worst.toFixed(2)}mm on a 6mm cutter`);
  if (heavyTruth > 0) assert.ok(heavyAgreed / heavyTruth > 0.8, 'the heavy bites are heavy in both');
});

test('asking for the load changes nothing else about the simulation', () => {
  const { cl } = pocketProgram();
  const a = simulate(cl, false);
  const b = simulate(cl, true);
  assert.ok(!('moveLoad' in a), 'not recorded, and not even a key, unless asked for');
  assert.eq(a.stepCount, b.stepCount);
  assert.eq(a.final.length, b.final.length);
  let same = true;
  for (let i = 0; i < a.final.length; i++) if (a.final[i] !== b.final[i]) { same = false; break; }
  assert.ok(same, 'the surface is bit for bit the same');
  const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const job = simulateProgram({ setups: [{ stock: STOCK, ops: [{ cl, tool: TOOL }], frame: { matrix: IDENTITY, offset: [0, 0, 0] } }], moveLoad: true, maxCells: 40_000 });
  assert.ok(Array.isArray(job.moveLoads) && job.moveLoads[0]?.length === 1, 'and per setup through simulateProgram');
});

test('heavy bites are fed slower and light ones faster, and every move is inside the limits', () => {
  const { cl, params } = pocketProgram();
  const rec = simulate(cl).moveLoad[0];
  const machine = createMachine({ kind: 'mill' });
  const r = optimiseFeeds(cl, rec, {
    op: { params }, tool: TOOL, material: 'aluminium', machine,
    nominalWidth: 0.4 * TOOL.diameter, nominalDepth: 4,
  });
  assert.ok(r.changed, `changed (${r.refused})`);
  assert.ok(r.stats.slowest < TOOL.feedCut && r.stats.fastest > TOOL.feedCut * 0.99, JSON.stringify(r.stats));
  const feed = feedAt(r.cl);
  const truth = measure(cl);
  let heavy = 0;
  let light = 0;
  for (let n = 0; n < cl.count; n++) {
    const t = truth[n];
    assert.ok(feed[n] >= TOOL.feedCut * FEED_OPT.minScale - 1 && feed[n] <= TOOL.feedCut * FEED_OPT.maxScale + 1, `move ${n}: ${feed[n]}`);
    if (!t || t.length < 0.5) continue;
    // heavy means wide *and* deep: a full-width skim of a tenth of a millimetre
    // is a light cut, and the removal rate is what the feed is judged by
    if (t.width > 0.55 * TOOL.diameter && t.depth > 3.6) { heavy++; assert.ok(feed[n] < TOOL.feedCut, `a heavy, full-depth bite at ${feed[n]}, programmed ${TOOL.feedCut}`); }
    if (t.width < 0.2 * TOOL.diameter && t.depth > 1) light++;
  }
  const widest = Math.max(...truth.filter(Boolean).map((t) => t.width));
  assert.ok(heavy > 0, `the part has full-width moves, or this tests nothing (widest ${widest.toFixed(2)})`);
});

test('the machine\'s fastest feed and its spindle power are ceilings', () => {
  const { cl, params } = pocketProgram({ stepover: 0.1 });
  const rec = simulate(cl).moveLoad[0];
  const slow = createMachine({ kind: 'mill', maxFeed: 700 });
  const capped = optimiseFeeds(cl, rec, { op: { params }, tool: TOOL, material: 'aluminium', machine: slow, nominalWidth: 0.6, nominalDepth: 4 });
  const feeds = feedAt(capped.cl);
  // what a cutting move is fed at — the programmed feed also stands on the rapids,
  // where it is not a feed at all (a machine that cannot reach the programmed
  // feed is the machine panel's warning, not this check's)
  let fastest = 0;
  for (let n = 0; n < capped.cl.count; n++) if (capped.cl.moves[n * MOVE_STRIDE + 7] === FEED.CUT) fastest = Math.max(fastest, feeds[n]);
  assert.ok(fastest <= 700 + 1, `fastest ${fastest} against a 700 limit`);
  // power: a spindle that can take only 0.1 kW holds the feed where the cut is within it
  const weak = { ...createMachine({ kind: 'mill' }), spindlePower: 0.1, maxFeed: 5000 };
  const lim = optimiseFeeds(cl, rec, { op: { params }, tool: TOOL, material: 'stainless', machine: weak, nominalWidth: 0.6, nominalDepth: 4 });
  const f2 = feedAt(lim.cl);
  const truth = measure(cl);
  let checked = 0;
  for (let n = 0; n < cl.count; n++) {
    const t = truth[n];
    if (!t || t.length < 0.5 || t.width < 0.3 || t.depth < 0.3) continue;
    const kw = cuttingPowerKw({ ae: t.width, ap: t.depth, feed: f2[n], material: 'stainless' });
    // the floor of the scale is 40%: where even that is too much, it is the floor that holds
    if (f2[n] > TOOL.feedCut * FEED_OPT.minScale + 1) { checked++; assert.ok(kw < 0.1 * 1.5, `move ${n} takes ${kw.toFixed(2)} kW at ${f2[n]}`); }
  }
  assert.ok(checked > 0, 'some moves were limited by power and not by the floor');
});

test('not one coordinate moves, so the metal removed is identical', () => {
  const { cl, params } = pocketProgram();
  const rec = simulate(cl).moveLoad[0];
  const r = optimiseFeeds(cl, rec, { op: { params }, tool: TOOL, material: 'aluminium', machine: createMachine({ kind: 'mill' }), nominalWidth: 2.4, nominalDepth: 4 });
  assert.ok(r.changed);
  assert.ok(r.cl !== cl && r.cl.moves === cl.moves, 'a new record sharing the very same moves');
  assert.ok(cl.events.every((e, i) => e === cl.events[i]), 'and the original untouched');
  assert.eq(cl.events.filter((e) => e.type === 'feeds').length, 1, 'the original still has its one feed');
  const before = simulate(cl, false).final;
  const after = simulate(r.cl, false).final;
  let same = true;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) { same = false; break; }
  assert.ok(same, 'the finished surface is bit for bit the same');
});

test('the program is shorter where the cut is light, and the file still matches its path', () => {
  const { cl, params } = pocketProgram({ stepover: 0.12 });
  const rec = simulate(cl).moveLoad[0];
  const machine = createMachine({ kind: 'mill' });
  const r = optimiseFeeds(cl, rec, { op: { params }, tool: TOOL, material: 'aluminium', machine, nominalWidth: 0.4 * 6, nominalDepth: 4 });
  assert.ok(r.changed);
  const t0 = estimateSeconds(cl, 3000);
  const t1 = estimateSeconds(r.cl, 3000);
  assert.ok(Math.abs(t1 - t0) > 0.5, 'the estimate follows the feeds');
  // posted: the F words are where the events are, and the read-back is clean
  for (const post of ['linuxcnc', 'grbl']) {
    const ops = [{ name: 'p', cl: r.cl }];
    const { text, lineMap } = buildGcode(post, ops);
    const check = checkPost({ ops, text, lineMap });
    assert.ok(check.over <= 0, `${post}: matches its path (${check.worst.toFixed(3)}mm)`);
    const fWords = (text.match(/\bF\d/g) || []).length;
    assert.ok(fWords >= r.stats.levels, `${post}: the feeds are written (${fWords} F words, ${r.stats.levels} levels)`);
    assert.ok(fWords < cl.count / 3, `${post}: and not on every move (${fWords} for ${cl.count} moves)`);
  }
});

test('a feed level is held for about a cutter\'s width, so arcs are not shattered', () => {
  const { cl, params } = pocketProgram();
  const rec = simulate(cl).moveLoad[0];
  const r = optimiseFeeds(cl, rec, { op: { params }, tool: TOOL, material: 'aluminium', machine: createMachine({ kind: 'mill' }), nominalWidth: 2.4, nominalDepth: 4 });
  const events = r.cl.events.filter((e) => e.type === 'feeds').sort((a, b) => a.index - b.index);
  const d = cl.moves;
  const dist = (a, b) => {
    let s = 0;
    for (let i = a + 1; i <= b; i++) s += Math.hypot(d[i * MOVE_STRIDE + 1] - d[(i - 1) * MOVE_STRIDE + 1], d[i * MOVE_STRIDE + 2] - d[(i - 1) * MOVE_STRIDE + 2]);
    return s;
  };
  let short = 0;
  for (let k = 1; k + 1 < events.length; k++) {
    const len = dist(events[k].index, events[k + 1].index);
    if (len < TOOL.diameter * 0.4) short++;
  }
  assert.ok(short <= Math.max(2, events.length * 0.1), `${short} of ${events.length} feed changes are held for under half a cutter`);
});

test('what it will not touch, it says why: holes, taps, lathe tools, other feeds, no measurement', () => {
  const { cl, params } = pocketProgram();
  const rec = simulate(cl).moveLoad[0];
  assert.eq(refusal(cl, TOOL, rec), null);
  assert.ok(/measured/.test(refusal(cl, TOOL, null)));
  assert.ok(/tap/.test(refusal(cl, { ...TOOL, type: 'tap' }, rec)));
  assert.ok(/drill/.test(refusal(cl, { ...TOOL, type: 'drill' }, rec)));
  assert.ok(/lathe/.test(refusal(cl, { type: 'turning', diameter: 10 }, rec)));
  assert.ok(/no tool/.test(refusal(cl, null, rec)));
  // a program that already changes its own feed
  const twice = { ...cl, events: [...cl.events, { type: 'feeds', index: 10, cut: 300, plunge: 100 }] };
  assert.ok(/part-way/.test(refusal(twice, TOOL, rec)), refusal(twice, TOOL, rec));
  // a hole cycle
  const b = new CLBuilder();
  b.toolChange(1); b.spindle(9000); b.event('feeds', { cut: 600, plunge: 200 });
  b.rapid(5, 5, 5); b.drill(5, 5, -3, { retractZ: 2 });
  const holes = b.finish();
  assert.ok(/hole/.test(refusal(holes, TOOL, { width: new Float32Array(holes.count), depth: new Float32Array(holes.count), kind: new Uint8Array(holes.count) })));
  // and the answer is the same toolpath, unchanged, with the reason
  const r = optimiseFeeds(holes, null, { tool: { ...TOOL, type: 'drill' } });
  assert.ok(!r.changed && r.cl === holes && r.refused);
  assert.ok(params);
});

test('a path whose every cut is the nominal one comes back unchanged', () => {
  const { cl, params } = pocketProgram();
  const rec = simulate(cl).moveLoad[0];
  const flat = { width: new Float32Array(cl.count).fill(2.4), depth: new Float32Array(cl.count).fill(4), kind: rec.kind };
  const r = optimiseFeeds(cl, flat, { op: { params }, tool: TOOL, material: 'aluminium', machine: createMachine({ kind: 'mill' }), nominalWidth: 2.4, nominalDepth: 4 });
  assert.ok(!r.changed && r.cl === cl, 'nothing to improve is not a change');
});
