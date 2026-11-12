// V-carve and inlay: the groove is measured, not described.
//
// Each program is run through the simulator and the heightfield it leaves is read
// back: the depth at a point is how far the billet's top stands above it. The
// geometry written down here is the V itself — a V bit of half-angle a cuts to a
// depth of (distance from the wall) / tan a — so every figure is a fact about the
// cutter, and the pair of inlay pieces is checked by whether one fits the other.

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { simulateRemoval } from '../engine/simulate.js';
import { eachMove, FEED, OP } from '../engine/cl.js';
import { drawnShape, carveLevels } from '../engine/strategies/vcarve.js';
import { pickToolFor } from '../engine/tool-match.js';

/** A V bit: `angle` degrees included, `tip` across the flat on its end. */
const vbit = (angle = 90, tip = 0, diameter = 12) => ({
  number: 1, type: 'chamfer', name: `${angle} V`, diameter, flutes: 2, fluteLength: 12,
  tipAngle: angle, tipDiameter: tip, spindleRpm: 12000, feedCut: 600, feedPlunge: 200,
});

const rect = (x0, y0, x1, y1) => ({ points: [x0, y0, x1, y0, x1, y1, x0, y1], closed: true });
const circle = (cx, cy, r, n = 96) => ({
  points: Array.from({ length: n }, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n)]).flat(),
  closed: true,
});

const TOP = 5;
const STOCK = { kind: 'box', min: [-6, -6, 0], max: [26, 18, TOP] };

function carve(drawing, tool, over = {}) {
  const params = {
    ...defaultParamsFor('vcarve', { stock: STOCK, tool }),
    topZ: TOP, bottomZ: 0, clearanceHeight: 15, stepdown: 0.05, ...over,
  };
  const cl = generateToolpath({ type: 'vcarve', name: 'vcarve', tool, mesh: null, stock: STOCK, params, drawing });
  return { cl, params };
}

function surfaceAfter(cl, tool) {
  const sim = simulateRemoval({ stock: STOCK, ops: [{ cl, tool }], maxCells: 260_000 });
  const at = (x, y) => {
    const i = Math.round((x - sim.origin[0]) / sim.cellSize);
    const j = Math.round((y - sim.origin[1]) / sim.cellSize);
    return sim.final[j * sim.width + i];
  };
  return { sim, depth: (x, y) => TOP - at(x, y), height: at };
}

const warns = (cl) => cl.notes.filter((n) => n.level === 'warn').map((n) => n.text);

test('the groove is as deep as the cutter is wide at the wall: depth equals the distance from the edge, for a 90 degree V', () => {
  const tool = vbit(90);
  const { cl } = carve([rect(0, 0, 20, 8)], tool, { vcarveDepth: 6 });
  assert.eq(warns(cl).length, 0, warns(cl).join(' | '));
  const { depth } = surfaceAfter(cl, tool);
  // a 90 degree included V has tan(45) = 1: depth is the distance from the nearest wall
  for (const [x, y, want] of [[10, 1, 1], [10, 2, 2], [10, 3, 3], [10, 0.5, 0.5], [3, 4, 3], [10, 4, 4]]) {
    assert.close(depth(x, y), want, 0.09, `at (${x}, ${y}) the groove is ${depth(x, y).toFixed(2)} deep, ${want} from the wall`);
  }
});

test('the groove opens to the outline at the surface, and nothing is cut outside it', () => {
  const tool = vbit(90);
  const { cl } = carve([rect(0, 0, 20, 8)], tool, { vcarveDepth: 6 });
  const { depth } = surfaceAfter(cl, tool);
  for (const [x, y] of [[-0.3, 4], [20.3, 4], [10, -0.3], [10, 8.3], [-1, -1], [-3, 4]]) {
    assert.ok(depth(x, y) < 0.02, `outside the outline at (${x}, ${y}) it is ${depth(x, y).toFixed(3)} deep`);
  }
  // and just inside it is cut: the wall of the groove reaches the outline
  assert.ok(depth(0.4, 4) > 0.2, `0.4 inside the wall it is ${depth(0.4, 4).toFixed(2)} deep`);
  assert.ok(depth(10, 0.4) > 0.2);
  // every cut is below the surface and above the cap, and inside the billet
  let high = -Infinity;
  let low = Infinity;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE || feed === FEED.RAPID) return;
    high = Math.max(high, z);
    low = Math.min(low, z);
  });
  assert.ok(high <= TOP + 1e-6, `no cut above the surface (${high})`);
  assert.ok(low >= 0, `none through the bottom of the billet (${low})`);
});

test('a narrow shape stops where the V runs out of room, and says so; a wide one reaches the cap', () => {
  const tool = vbit(90);
  const narrow = carve([rect(0, 0, 20, 2)], tool, { vcarveDepth: 5 });
  const { depth } = surfaceAfter(narrow.cl, tool);
  assert.close(depth(10, 1), 1, 0.1, 'a 2mm wide strip bottoms at 1mm: half its width, at 90 degrees');
  assert.ok(narrow.cl.notes.some((n) => /stops at 1\.0\d? ?mm|stops at 0\.99|stops at 1mm/.test(n.text) || /only 2\.00mm wide/.test(n.text)),
    narrow.cl.notes.map((n) => n.text).join(' | '));
  const wide = carve([rect(0, 0, 20, 14)], tool, { vcarveDepth: 2 });
  const w = surfaceAfter(wide.cl, tool);
  assert.close(w.depth(10, 7), 2, 0.08, 'a wide shape is cut to the cap at its middle');
  assert.ok(w.depth(10, 7) < 2.05, 'and not past it');
});

test('a flat bottom is cleared at the cap; a V bottom is left as one pass at that depth cuts it', () => {
  const tool = vbit(90, 0.4);
  const flat = surfaceAfter(carve([rect(0, 0, 20, 14)], tool, { vcarveDepth: 1.5, vcarveBottom: 'flat' }).cl, tool);
  const vee = surfaceAfter(carve([rect(0, 0, 20, 14)], tool, { vcarveDepth: 1.5, vcarveBottom: 'v' }).cl, tool);
  for (const [x, y] of [[10, 7], [6, 7], [14, 5]]) {
    assert.close(flat.depth(x, y), 1.5, 0.1, `flat floor at (${x}, ${y}): ${flat.depth(x, y).toFixed(2)}`);
    assert.ok(vee.depth(x, y) < 0.3, `the V version leaves the middle standing: ${vee.depth(x, y).toFixed(2)} at (${x}, ${y})`);
  }
});

test('a flat on the tip of the bit does not move the wall of the groove, only how deep a narrow shape gets', () => {
  const tool = vbit(60, 0.6);                      // tan 30 = 0.5774
  const tan = Math.tan(Math.PI / 6);
  const { cl } = carve([rect(0, 0, 20, 14)], tool, { vcarveDepth: 3 });
  const { depth } = surfaceAfter(cl, tool);
  // the flank of the cone passes through the outline at the surface whatever is on the end
  for (const dist of [1, 1.5]) {                  // 2 would be 3.46 deep: past the 3mm cap
    assert.close(depth(dist, 7), dist / tan, 0.12, `${dist}mm from the wall: ${depth(dist, 7).toFixed(2)} against ${(dist / tan).toFixed(2)}`);
  }
  // …but the flat is where the V runs out: a 2mm strip bottoms where the cutter's centre can still go,
  // (1 - 0.3) / tan, and its floor is the flat itself
  const strip = carve([rect(0, 0, 20, 2)], tool, { vcarveDepth: 5 });
  const s = surfaceAfter(strip.cl, tool);
  assert.close(s.depth(10, 1), (1 - 0.3) / tan, 0.1, `a 2mm strip: ${s.depth(10, 1).toFixed(2)}`);
});

test('a letter with a hole in it keeps its island: the O is a ring, not a disc', () => {
  const tool = vbit(90);
  const { cl } = carve([circle(10, 6, 6), circle(10, 6, 2.5)], tool, { vcarveDepth: 5 });
  const { depth } = surfaceAfter(cl, tool);
  assert.ok(depth(10, 6) < 0.05, `the middle of the O is left standing: ${depth(10, 6).toFixed(3)}`);
  assert.ok(depth(10 + 1.2, 6) < 0.05, 'and inside the hole');
  // the middle of the ring, 1.75 from each wall
  assert.close(depth(10 + 4.25, 6), 1.75, 0.12, `the ring is cut down its middle: ${depth(14.25, 6).toFixed(2)}`);
  assert.eq(drawnShape([circle(10, 6, 6), circle(10, 6, 2.5)]).length, 2);
});

test('the shape is read as fills: an inner loop is a hole, a third one inside that is a fill again', () => {
  const loops = drawnShape([rect(0, 0, 30, 30), rect(5, 5, 25, 25), rect(10, 10, 20, 20)]);
  const area = (l) => {
    let a = 0;
    for (let i = 0; i < l.length; i += 2) { const j = (i + 2) % l.length; a += l[i] * l[j + 1] - l[j] * l[i + 1]; }
    return a / 2;
  };
  assert.eq(loops.map((l) => Math.sign(area(l))).join(','), '1,-1,1', 'outer CCW, hole CW, island CCW');
  assert.eq(drawnShape([{ points: [0, 0, 5, 5], closed: false }]).length, 0, 'an open line is no shape');
});

test('what it will not carve, it says why: a flat cutter, no drawing, open lines, a shape narrower than the tip', () => {
  const params = { ...defaultParamsFor('vcarve', { stock: STOCK, tool: vbit() }), topZ: TOP, bottomZ: 0, clearanceHeight: 15 };
  const run = (tool, drawing) => generateToolpath({ type: 'vcarve', name: 'v', tool, mesh: null, stock: STOCK, params, drawing });
  const flat = run({ ...vbit(), type: 'flat', tipAngle: 0 }, [rect(0, 0, 10, 10)]);
  assert.ok(warns(flat).some((t) => /V bit or a chamfer mill/.test(t)));
  // with nothing to follow the dispatcher says so before the strategy is asked
  assert.ok(warns(run(vbit(), null)).some((t) => /model|drawing/.test(t)));
  assert.ok(warns(run(vbit(), [])).some((t) => /model|drawing/.test(t)));
  assert.ok(warns(run(vbit(), [{ points: [0, 0, 10, 0, 10, 10], closed: false }])).some((t) => /closed shapes/.test(t)));
  assert.ok(warns(run(vbit(90, 2), [rect(0, 0, 10, 1)])).some((t) => /narrower than the cutter/.test(t)), 'a 1mm strip under a 2mm tip');
  for (const cl of [flat, run(vbit(), null)]) assert.eq(cl.count, 0);
});

test('a bit is as wide as it goes at its diameter: the carve is capped there, and a silly step is refused', () => {
  const tool = vbit(90, 0, 6);                     // 3mm half width: reaches 3mm
  const { cl } = carve([rect(0, 0, 20, 14)], tool, { vcarveDepth: 8 });
  assert.ok(warns(cl).some((t) => /as wide as it goes at 3\.00mm/.test(t)), warns(cl).join(' | '));
  const fine = carve([rect(0, 0, 20, 14)], vbit(90), { vcarveDepth: 5, stepdown: 0.001 });
  assert.ok(warns(fine.cl).some((t) => /depth level/.test(t)));
  assert.eq(fine.cl.count, 0);
});

test('levels: shallowest first, the cap among them, each the shape pulled in by the V', () => {
  const region = drawnShape([rect(0, 0, 20, 14)]);
  const { levels, reach } = carveLevels(region, { tan: 1, tip: 0, cap: 1, step: 0.25, flat: false, clearStep: 0.3 });
  assert.eq(levels.map((l) => l.depth).join(','), '0.25,0.5,0.75,1');
  assert.close(reach, 1, 1e-9);
  const width = (loops) => { let min = Infinity; let max = -Infinity; for (const l of loops) for (let i = 0; i < l.length; i += 2) { min = Math.min(min, l[i]); max = Math.max(max, l[i]); } return max - min; };
  levels.forEach((l) => assert.close(width(l.loops), 20 - 2 * l.depth, 0.02, `at depth ${l.depth}`));
});

// -------------------------------------------------------------------- inlay

/** The width of the cut across y = 7 at a given depth below the surface (a recess), by the cells at least that deep. */
function widthAtDepth(surface, z, y = 7) {
  let min = Infinity;
  let max = -Infinity;
  for (let x = -5; x <= 25; x += surface.sim.cellSize) {
    if (surface.depth(x, y) >= z - 1e-6) { min = Math.min(min, x); max = Math.max(max, x); }
  }
  return max - min;
}
/** The width of the island at a depth below its own top, by the cells at least that high. */
function islandWidth(surface, t, top, y = 7) {
  let min = Infinity;
  let max = -Infinity;
  for (let x = -5; x <= 25; x += surface.sim.cellSize) {
    if (surface.height(x, y) >= top - t - 1e-6 && surface.depth(x, y) < t + 1) { min = Math.min(min, x); max = Math.max(max, x); }
  }
  return max - min;
}

test('the recess is the shape, flat-bottomed, with walls at the angle of the bit', () => {
  const tool = vbit(90);
  const W = 20;
  const { cl } = carve([rect(0, 0, W, 14)], tool, { vcarveDepth: 2, inlay: 'female' });
  assert.eq(warns(cl).length, 0, warns(cl).join(' | '));
  const female = surfaceAfter(cl, tool);
  // width at depth z is W - 2z (tan 45 = 1)
  for (const z of [0.3, 0.8, 1.4, 1.9]) {
    assert.close(widthAtDepth(female, z), W - 2 * z, 0.2, `at ${z}mm down the recess is ${widthAtDepth(female, z).toFixed(2)} wide`);
  }
  assert.close(female.depth(10, 7), 2, 0.06, 'a flat floor at the depth asked for');
  assert.close(female.depth(4, 7), 2, 0.08);
});

test('the plug fits the recess: at every depth it is narrower than the recess by the glue gap on each side, and no more', () => {
  const tool = vbit(90);
  const W = 20;
  const cap = 2;
  const gap = 0.1;
  const female = surfaceAfter(carve([rect(0, 0, W, 14)], tool, { vcarveDepth: cap, inlay: 'female' }).cl, tool);
  const maleRun = carve([rect(0, 0, W, 14)], tool, { vcarveDepth: cap, inlay: 'male', inlayGap: gap, inlayMargin: 3 });
  assert.eq(warns(maleRun.cl).length, 0, warns(maleRun.cl).join(' | '));
  const male = surfaceAfter(maleRun.cl, tool);
  const top = TOP;                                    // the island's top is the untouched surface
  assert.close(male.height(10, 7), top, 0.02, 'the plug stands at the surface');
  // turned over, the plug's top sits on the recess floor: at depth z it has been t = cap - z below its own top
  for (const z of [0.2, 0.6, 1.0, 1.5, 1.9]) {
    const recess = widthAtDepth(female, z);
    const plug = islandWidth(male, cap - z, top);
    const room = (recess - plug) / 2;
    assert.ok(room >= gap - 0.12, `at depth ${z} the plug (${plug.toFixed(2)}) is too wide for the recess (${recess.toFixed(2)}): ${room.toFixed(3)} a side`);
    assert.ok(room <= gap + 0.2, `and not slack: ${room.toFixed(3)} a side, the gap is ${gap}`);
  }
});

test('the plug is carved to the cap all round and the recess depth never exceeds it', () => {
  const tool = vbit(90);
  const male = surfaceAfter(carve([rect(0, 0, 20, 14)], tool, { vcarveDepth: 2, inlay: 'male', inlayMargin: 3 }).cl, tool);
  assert.close(male.depth(-3.5, 7), 2, 0.1, 'the background is cleared to the cap');
  assert.ok(male.depth(-3.5, 7) < 2.05, 'and not below it');
  // the shape is too small to leave a plug at this depth: refused with the reason
  const small = carve([rect(0, 0, 3, 3)], tool, { vcarveDepth: 2, inlay: 'male' });
  assert.ok(warns(small.cl).some((t) => /narrower than the .* the plug has to be pulled in by/.test(t)), warns(small.cl).join(' | '));
});

test('V-carve is in the catalogue, takes the V bit, and follows a drawing', () => {
  const rack = [
    { id: 'a', type: 'flat', diameter: 6, number: 1 },
    { id: 'b', type: 'chamfer', diameter: 12, tipAngle: 60, number: 2 },
  ];
  assert.eq(pickToolFor('vcarve', rack).id, 'b');
});
