// What the cutter is actually asked to do, measured off the finished program.
//
// Every other test here checks the shape of a path. These check the *load*: how
// wide a bite each move takes, how deep it is while taking it, and whether any
// rapid drives the tool through metal. Those are the numbers that decide whether
// a program breaks a cutter, and none of them can be read off the path — they
// only exist against the material as it stands when the move is made.
//
// So the program is replayed through a heightmap of the billet. Each move carves
// it, and the footprint the move took divided by the distance it travelled is
// the radial width of cut. That answer does not depend on how the path happens
// to be punctuated, which is what makes it worth having next to the pass-based
// reading in adaptive.test.js: collapse a run of collinear points into one move,
// or split a ramped entry into two passes, and the pass-based number moves while
// this one does not.
//
// The faults this was written for, all found by it and all fixed:
//
//   * a slot re-reading the part's outline at every depth, so the first pass on
//     a line that appears when the cross-section changes took the whole depth in
//     one full-width cut — 13.5mm with a ⌀6 cutter, and it rapided down into
//     solid billet to get there
//   * adaptive cutting a ring from end to end because *part* of it had cleared
//     space beside it, driving the far end into untouched material at 1.00xD on
//     a pass asked for 0.15
//   * a depth level that cleared nothing taking the entry height down with it,
//     so the pass below ramped one stepdown through three of standing stock

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { eachMove, OP, FEED, descentOf } from '../engine/cl.js';
import { clearanceProfile, cuttingRadiusOf } from '../engine/tool-geometry.js';
import { ClearingMap } from '../geom/coverage.js';
import { makeBox, makePocketBlock, makeStepped, makeRamp } from './fixtures.js';

const FLAT = {
  number: 1, type: 'flat', name: '6mm flat', diameter: 6, flutes: 2,
  fluteLength: 20, spindleRpm: 12000, feedCut: 800, feedPlunge: 250,
};

/**
 * The billet as a heightmap: what stands where, as the program eats it.
 *
 * Cells outside the stock hold -Infinity, so a cut that runs off the edge is
 * not credited with removing anything.
 */
class Material {
  constructor(stock, cell = 0.15) {
    this.cell = cell;
    const pad = 8;
    this.min = [stock.min[0] - pad, stock.min[1] - pad];
    this.width = Math.ceil((stock.max[0] - stock.min[0] + 2 * pad) / cell) + 1;
    this.height = Math.ceil((stock.max[1] - stock.min[1] + 2 * pad) / cell) + 1;
    this.area = cell * cell;
    this.floor = stock.min[2];
    this.top = new Float32Array(this.width * this.height).fill(-1e9);
    for (let j = 0; j < this.height; j++) {
      for (let i = 0; i < this.width; i++) {
        const x = this.min[0] + i * cell;
        const y = this.min[1] + j * cell;
        if (x >= stock.min[0] && x <= stock.max[0] && y >= stock.min[1] && y <= stock.max[1]) {
          this.top[j * this.width + i] = stock.max[2];
        }
      }
    }
  }

  /**
   * Carve one sub-segment.
   * @returns { swath, depth } — the footprint (mm²) taken down to the tool's own
   *   tip plane, and the deepest any cell was lowered by. The tip plane is what
   *   makes this exact for a flat cutter and honest for a shaped one: counting
   *   every cell the tool lowered instead reads a face mill at a 0.6xD stepover
   *   as a 4xD cut, because a cell in the corner radius comes closer to the axis
   *   as the tool advances and is lowered again by every step.
   */
  carve(x0, y0, z0, x1, y1, z1, radius, profile) {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((Math.min(x0, x1) - radius - this.min[0]) / c));
    const i1 = Math.min(this.width - 1, Math.ceil((Math.max(x0, x1) + radius - this.min[0]) / c));
    const j0 = Math.max(0, Math.floor((Math.min(y0, y1) - radius - this.min[1]) / c));
    const j1 = Math.min(this.height - 1, Math.ceil((Math.max(y0, y1) + radius - this.min[1]) / c));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lenSq = dx * dx + dy * dy;
    const plane = Math.min(z0, z1) + 1e-4;
    let cells = 0;
    let depth = 0;
    for (let j = j0; j <= j1; j++) {
      const py = this.min[1] + j * c;
      const row = j * this.width;
      for (let i = i0; i <= i1; i++) {
        const px = this.min[0] + i * c;
        let t = lenSq > 0 ? ((px - x0) * dx + (py - y0) * dy) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
        if (d > radius) continue;
        const surface = Math.max(z0 + (z1 - z0) * t + profile(d), this.floor - 1);
        const was = this.top[row + i];
        if (was <= surface + 1e-6) continue;
        if (was > -1e8) {
          if (was - surface > depth) depth = was - surface;
          if (was > plane && surface <= plane) cells++;
        }
        this.top[row + i] = surface;
      }
    }
    return { swath: cells * this.area, depth };
  }

  /** How far the tool body is inside standing material with its tip at (x,y,z). */
  interference(x, y, z, radius, profile) {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((x - radius - this.min[0]) / c));
    const i1 = Math.min(this.width - 1, Math.ceil((x + radius - this.min[0]) / c));
    const j0 = Math.max(0, Math.floor((y - radius - this.min[1]) / c));
    const j1 = Math.min(this.height - 1, Math.ceil((y + radius - this.min[1]) / c));
    let over = 0;
    for (let j = j0; j <= j1; j++) {
      const py = this.min[1] + j * c;
      const row = j * this.width;
      for (let i = i0; i <= i1; i++) {
        const t = this.top[row + i];
        if (t <= z + 1e-6) continue;
        const d = Math.hypot(this.min[0] + i * c - x, py - y);
        // a cut running along a wall touches it at exactly the radius, and the
        // cutter is not a cylinder — a V bit 0.8mm up is 1mm wide
        if (d > radius - 1.5 * c || t <= z + profile(d) + 1e-6) continue;
        over = Math.max(over, t - z - profile(d));
      }
    }
    return over;
  }
}

/**
 * Replay a program through its billet.
 *
 * @returns { width, depth, crash } — the widest bite any ordinary cutting move
 *   took as a fraction of the diameter, the deepest cut taken at more than
 *   nine-tenths of the full width, and how far any rapid passed inside standing
 *   material.
 */
function load(cl, { tool, stock, step = 0.3, cell = 0.15, stepdown = 0 }) {
  const radius = cuttingRadiusOf(tool);
  const profile = clearanceProfile(tool);
  const material = new Material(stock, cell);
  const out = {
    width: 0, widthAt: null, depth: 0, depthAt: null, crash: 0, crashAt: null,
    crashes: 0, heavy: 0, heavyAt: null, run: 0, runAt: null, buried: 0,
  };
  let run = 0;
  let prev = null;
  eachMove(cl, (op, x, y, z, i, j, k, feed, index) => {
    if (op === OP.DRILL) { material.carve(x, y, z, x, y, z, radius, profile); prev = [x, y, i]; return; }
    if (!prev) { prev = [x, y, z]; return; }
    const len = Math.hypot(x - prev[0], y - prev[1], z - prev[2]);
    const n = Math.max(1, Math.ceil(len / step));
    if (op === OP.RAPID || feed === FEED.RAPID) {
      run = 0;
      for (let p = 0; p <= n; p++) {
        const t = p / n;
        const over = material.interference(prev[0] + (x - prev[0]) * t,
          prev[1] + (y - prev[1]) * t, prev[2] + (z - prev[2]) * t, radius, profile);
        if (over > 0.05) {
          out.crashes++;
          if (over > out.crash) { out.crash = over; out.crashAt = [round(x), round(y), round(z), index]; }
        }
      }
      prev = [x, y, z];
      return;
    }
    // a descent through material is an entry, and the ramp angle governs that —
    // not the bite limit. It is measured by depth below, not by width.
    const descending = z < prev[2] - 1e-6 && prev[2] - z > Math.hypot(x - prev[0], y - prev[1]) * 0.02;
    for (let p = 1; p <= n; p++) {
      const t0 = (p - 1) / n;
      const t1 = p / n;
      const ax = prev[0] + (x - prev[0]) * t0;
      const ay = prev[1] + (y - prev[1]) * t0;
      const bx = prev[0] + (x - prev[0]) * t1;
      const by = prev[1] + (y - prev[1]) * t1;
      const piece = Math.hypot(bx - ax, by - ay);
      const { swath, depth } = material.carve(ax, ay, prev[2] + (z - prev[2]) * t0,
        bx, by, prev[2] + (z - prev[2]) * t1, radius, profile);
      if (descending || piece < 1e-9) continue;
      const w = Math.min(swath / piece, 2 * radius) / (2 * radius);
      if (feed === FEED.CUT && w > out.width) {
        out.width = w;
        out.widthAt = [round(bx), round(by), round(z), index];
      }
      // How *far* the cutter runs buried to more than half its width. A corner
      // where two offsets meet spikes for a few tenths of a millimetre and
      // always has; driving the far end of a ring into untouched billet is
      // tens of millimetres of it, and that is the difference worth testing.
      if (feed === FEED.CUT && w > 0.5) {
        out.heavy += piece;
        if (!out.heavyAt) out.heavyAt = [round(bx), round(by), round(z), index];
      }
      // The same reading clear of every stepover a strategy defaults to, so it
      // is not a reading of the setting: roughing at 0.5xD sits exactly on
      // `heavy` and half its cutting distance lands either side of it by noise.
      if (feed === FEED.CUT && w > 0.75) out.buried += piece;
      // How far the cutter runs *continuously* at full width while taking most
      // of the depth of cut. Concentric offsets always spike at an inside
      // corner — that is what adaptive exists to avoid — but a spike is a
      // fraction of a millimetre. A step from one ring to the next taken square
      // into the material is the whole move: 3.39mm here against 1.49mm for the
      // worst corner, which is what separates the two.
      if (feed === FEED.CUT && w > 0.9 && depth > stepdown * 0.5) {
        run += piece;
        if (run > out.run) { out.run = run; out.runAt = [round(bx), round(by), round(z), index]; }
      } else {
        run = 0;
      }
      // Ordinary cutting only. An entry — a ramp, or the little circle a seeded
      // peel bores to open a pocket from the inside — is full width by nature
      // and is governed by the ramp angle instead; adaptive emits those as
      // leads for exactly this reason.
      if (feed === FEED.CUT && w > 0.9 && depth > out.depth) {
        out.depth = depth;
        out.depthAt = [round(bx), round(by), round(z), index];
      }
    }
    prev = [x, y, z];
  });
  return out;
}

function round(v) { return Math.round(v * 100) / 100; }

// --- adaptive: the bite is the parameter -----------------------------------

test('adaptive takes exactly the bite it was asked for, whatever the setting', () => {
  // The strong form of the claim in adaptive.test.js, measured by removal
  // rather than by reading the material under each point of a pass: the footprint
  // a move takes divided by the distance it travels *is* the radial width of
  // cut, and no amount of splitting or merging the path changes it.
  const mesh = makeBox(20, 20, 10);
  const stock = { min: [-20, -20, 0], max: [40, 40, 10] };
  for (const engagement of [0.1, 0.2, 0.4]) {
    const cl = generateToolpath({
      type: 'adaptive', name: 'a', tool: FLAT, mesh, stock,
      params: {
        topZ: 10, bottomZ: 0, stepdown: 10, stepover: 0.5, engagement,
        clearanceHeight: 20, stockToLeave: 0, rampAngle: 3, tolerance: 0.01,
        direction: 'climb',
      },
    });
    const { width, widthAt } = load(cl, { tool: FLAT, stock });
    // one cell of the measuring grid over the parameter and no more
    assert.ok(width <= engagement + 0.15 / FLAT.diameter,
      `${engagement}xD asked, ${width.toFixed(3)}xD taken at ${JSON.stringify(widthAt)}`);
    assert.ok(width > engagement * 0.8,
      `and it is really cutting: ${width.toFixed(3)}xD for ${engagement} asked`);
  }
});

test('adaptive never drives the far end of a ring into untouched material', () => {
  // A ring reaching cleared ground at one end and standing against the billet
  // at the other used to be cut from end to end, because the test for "is there
  // cleared space beside this" asked about the span as a whole. On a part with a
  // sloped face that is a full-width cut the depth of the whole level: measured
  // 1.00xD and 10.7mm deep from a ⌀6 cutter asked for 0.15xD.
  const { mesh, floorZ } = makePocketBlock({ size: 60, pocketSize: 30, height: 20, depth: 14 });
  const stock = { min: [-6, -6, 0], max: [66, 66, 20] };
  const cl = generateToolpath({
    type: 'adaptive', name: 'a', tool: FLAT, mesh, stock,
    params: {
      topZ: 20, bottomZ: floorZ, stepdown: 12, stepover: 0.5, engagement: 0.15,
      clearanceHeight: 30, stockToLeave: 0.3, rampAngle: 2, tolerance: 0.01,
      direction: 'climb',
    },
  });
  const { heavy, heavyAt, depth, depthAt } = load(cl, { tool: FLAT, stock });
  // Corners spike for a fraction of a millimetre and always have — what this is
  // about is a ring cut from end to end, which is tens of millimetres of the
  // cutter buried past half its width. Measured before the fix on the same
  // shape: 46mm of it, 10.7mm deep.
  assert.ok(heavy < 3,
    `${heavy.toFixed(1)}mm cut at over half the cutter's width, from ${JSON.stringify(heavyAt)}`);
  assert.ok(depth < 1,
    `and no full-width cut ${depth.toFixed(1)}mm deep at ${JSON.stringify(depthAt)}`);
});

test('a pocket slides onto the next ring instead of stepping into the wall', () => {
  // One move per ring, and it was the heaviest in the program: the tool
  // finished a ring, and to reach the next one out it went diagonally into the
  // corner of the uncut band — material on two sides at once, at the full depth
  // of cut. Measured on this fixture before the fix: 0.97, 0.98, 0.97xD at
  // 6.00mm deep, while the rings either side of them ran at 0.5xD.
  //
  // The depth is what separates it from the entry. A ramp is full width too —
  // it is boring its way in, and the ramp angle governs that — but it descends
  // as it goes, so no single ramp move takes anything like the whole stepdown.
  // A step-across takes all of it.
  const { mesh, floorZ } = makePocketBlock({ size: 60, pocketSize: 34, height: 10, depth: 6 });
  const stock = { min: [0, 0, 0], max: [60, 60, 10] };
  const cl = generateToolpath({
    type: 'pocket', name: 'p', tool: FLAT, mesh, stock,
    params: {
      topZ: 10, bottomZ: floorZ, stepdown: 6, stepover: 0.4, clearanceHeight: 20,
      entryGap: 1, tolerance: 0.01, stockToLeave: 0, rampAngle: 3, leadType: 'arc',
      leadRadius: 2, direction: 'climb', finishPasses: 0,
    },
  });
  const { run, runAt } = load(cl, { tool: FLAT, stock, stepdown: 6 });
  assert.ok(run < 2.5,
    `${run.toFixed(2)}mm cut at full width and full depth without a break, `
    + `at ${JSON.stringify(runAt)} — a step across into the wall, not a corner`);
});

test('Z-level clearing marches across the band instead of starting in the middle', () => {
  // A boss in oversize stock leaves a band with air on one side and the part on
  // the other. Its concentric offsets meet at the band's medial axis, which is
  // the one place with material on *both* sides — so cutting them innermost
  // first, as a pocket's rings are cut, opens every level with a full-width
  // slot the depth of the pass whatever stepover was set. Measured here before
  // the order was fixed: 684mm of cutting at more than three quarters of the
  // diameter and a 34mm run of it unbroken, on a 0.5xD stepover.
  const mesh = makeBox(20, 20, 10);
  const stock = { min: [-20, -20, 0], max: [40, 40, 10] };
  const cl = generateToolpath({
    type: 'clear2d', name: 'c', tool: FLAT, mesh, stock,
    params: {
      topZ: 10, bottomZ: 0, stepdown: 3, stepover: 0.5, clearanceHeight: 20,
      entryGap: 1, tolerance: 0.01, stockToLeave: 0, rampAngle: 3,
      direction: 'climb', leadType: 'none',
    },
  });
  const { run, runAt, buried } = load(cl, { tool: FLAT, stock, stepdown: 3 });
  assert.ok(run < 2, `${run.toFixed(1)}mm cut at full width and full depth without a `
    + `break, at ${JSON.stringify(runAt)}`);
  assert.ok(buried < 50, `${buried.toFixed(0)}mm cut past three quarters of the `
    + 'cutter\'s width on a pass set to half of it');
});

test('Z-level clearing spaces its rings to divide the band, not to step off it', () => {
  // An 11mm band with a ⌀6 at a 3mm stepover has passes 3mm apart from each
  // edge — at 0 and 3 coming in from one side, at 8 and 11 from the other — and
  // the pass at 8 arrives with material from 6 to 11 in front of it. **5mm in
  // one bite**, 0.83xD on an operation set to half of it, with nothing in the
  // settings to show it: the band's width divided by the stepover simply had a
  // remainder and the last pass inherited it. Measured at 656mm before the
  // spacing was solved rather than assumed, and at 0 after.
  const mesh = makeBox(40, 40, 10);
  const stock = { min: [-11, -11, 0], max: [51, 51, 10] };
  const cl = generateToolpath({
    type: 'clear2d', tool: FLAT, mesh, stock,
    params: {
      topZ: 10, bottomZ: 0, stepdown: 3, stepover: 0.5, clearanceHeight: 20,
      entryGap: 1, tolerance: 0.01, stockToLeave: 0, rampAngle: 3,
      direction: 'climb', leadType: 'none',
    },
  });
  // Distance and run, not the peak: the widest single sub-piece is 1.00xD here
  // and always will be, because it is the inside corner where two offsets meet,
  // which every concentric path makes and no cutter minds. What the remainder
  // produced was not a spike but a *pass* — five millimetres wide for the whole
  // length of a side.
  const { buried, run, runAt } = load(cl, { tool: FLAT, stock, stepdown: 3 });
  assert.ok(buried < 40, `${buried.toFixed(0)}mm cut past three quarters of the `
    + 'cutter\'s width on a pass set to half of it');
  assert.ok(run < 3, `and no unbroken run of it: ${run.toFixed(1)}mm at ${JSON.stringify(runAt)}`);
});

test('Z-level clearing keeps marching after an island merges into the outer ring', () => {
  // A ring family is only two families while its two halves stay separate
  // loops. Erode a band far enough and the island's hole joins the outer
  // boundary, giving one loop that is stock edge along one stretch and wraps
  // the island along another — and read off the sign of its area, the whole of
  // it marched the way the stock edge wanted, so its island stretch arrived
  // with material on both sides. Measured on the slope part before the fix:
  // one complete ring around the dome, 198 of its 220 steps past 0.75xD.
  // The island sits **off centre**, which is what makes the merge happen: the
  // narrow side pinches out while the wide side still has material, so the hole
  // joins the outer boundary and the rings past that point are one loop.
  const mesh = makeBox(40, 40, 10);
  const stock = { min: [-9, -9, 0], max: [80, 80, 10] };
  const cl = generateToolpath({
    type: 'clear2d', tool: FLAT, mesh, stock,
    params: {
      topZ: 10, bottomZ: 0, stepdown: 3, stepover: 0.5, clearanceHeight: 20,
      entryGap: 1, tolerance: 0.01, stockToLeave: 0, rampAngle: 3,
      direction: 'climb', leadType: 'none',
    },
  });
  // Asking the question of the ring's own points left 174mm of it, because a
  // merged ring's straight stretches have points only at their corners: the
  // 37mm edge along the top of the part is equidistant from both sides at the
  // end where the outer boundary meets it and part-side everywhere else, so it
  // was cut whole in the air march with metal on both sides. `splitBySide`
  // resamples first. What is left is corners, which are a fraction of a
  // millimetre each and which every concentric toolpath makes.
  const { buried, run } = load(cl, { tool: FLAT, stock, stepdown: 3 });
  assert.ok(buried < 60, `${buried.toFixed(0)}mm cut past three quarters of the `
    + 'cutter\'s width on a pass set to half of it');
  assert.ok(run < 5, `${run.toFixed(1)}mm run continuously at full width and `
    + 'most of the depth of cut — that is a stretch, not a corner');
});

// --- the map has to answer the question the parameter is set in -------------

test('the clearing map reads a radial width, not how buried the cutter is', () => {
  // The two are the same number only while the cleared space is *beside* the
  // cutter. Where it is *behind* — a pass driving into a patch the peel left
  // standing — a third of the disc reads as cleared because the tool has just
  // come through there, and a full-width slot reports as a comfortable bite.
  // That is how a 6mm cut 10.3mm deep got past a limit set at 0.15xD.
  const square = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
  const map = new ClearingMap({
    // everything from x = 13 rightward is still standing
    material: [square(13, 0, 40, 40)],
    allowed: [square(-10, -10, 50, 50)],
    radius: 3,
    cellSize: 0.2,
    bounds: { min: [-10, -10], max: [50, 50] },
  });

  // One place, one material state, two directions — and the cut is a different
  // cut. The disc reading cannot tell them apart, which is the point.
  const buried = map.engagementAt(13, 20);
  assert.ok(buried > 0.4 && buried < 0.6,
    `half the disc is over material either way (${buried.toFixed(2)})`);
  assert.close(map.widthAt(13, 20, 1, 0), 6, 0.4,
    'driving straight at the wall is a full-width slot');
  assert.close(map.widthAt(13, 20, 0, 1), 3, 0.5,
    'running along it takes the three millimetres the tool overhangs');

  // and a pass beside one already made takes the step between them
  map.sweep(13, 0, 13, 40);
  assert.close(map.widthAt(15, 20, 0, 1), 2, 0.4, 'a 2mm step over is a 2mm bite');
  assert.eq(map.widthAt(13, 20, 0, 1), 0, 'and nothing where it has already cut');
});

// --- the depth per pass is the stepdown ------------------------------------

test('a slot takes one stepdown per pass on a part whose outline changes', () => {
  // The outline was re-read at every depth, so when the cross-section changed
  // the pass followed a line nothing had ever cut and took the lot in one go.
  // 40mm base, 20mm boss on top of it: the outline is one square down to Z10
  // and a different one below it, which is where the fault lived.
  const { mesh, height } = makeStepped();
  const stock = { min: [-2, -2, 0], max: [42, 42, height + 2] };
  const stepdown = 1.5;
  const cl = generateToolpath({
    type: 'slot', name: 'slot', tool: FLAT, mesh, stock,
    params: {
      topZ: height + 2, bottomZ: 0, stepdown, stepover: 0.4, slotWidth: 0,
      clearanceHeight: height + 12, entryGap: 1, tolerance: 0.01, stockToLeave: 0,
      rampAngle: 3, direction: 'climb',
    },
  });
  const { depth, depthAt, crash, crashAt } = load(cl, { tool: FLAT, stock });
  // a slot is full width by definition; what it may not do is take more than
  // the depth per pass it was set
  assert.ok(depth <= stepdown + 0.3,
    `a full-width cut ${depth.toFixed(2)}mm deep at a ${stepdown}mm stepdown, `
    + `at ${JSON.stringify(depthAt)}`);
  assert.eq(round(crash), 0, `and it rapids into standing stock at ${JSON.stringify(crashAt)}`);
});

test('no roughing strategy rapids through material, on a part with a step in it', () => {
  // The class: a depth level that cleared nothing still took the entry height
  // down with it, so the pass below rapided to a feed plane inside the billet.
  const { mesh, height } = makeStepped();
  const stock = { min: [-2, -2, 0], max: [42, 42, height + 2] };
  const params = {
    topZ: height + 2, bottomZ: 0, stepdown: 3, stepover: 0.5, engagement: 0.15,
    clearanceHeight: height + 12, entryGap: 1, tolerance: 0.01, stockToLeave: 0,
    rampAngle: 3, direction: 'climb', leadType: 'none',
  };
  for (const type of ['clear2d', 'adaptive', 'pocket', 'contour2d', 'slot']) {
    const cl = generateToolpath({ type, name: type, tool: FLAT, mesh, stock, params });
    const { crash, crashAt, crashes } = load(cl, { tool: FLAT, stock });
    assert.ok(crash < 0.2,
      `${type} rapids ${crash.toFixed(2)}mm inside standing stock, ${crashes} times, `
      + `at ${JSON.stringify(crashAt)}`);
  }
});

test('nor when a deep pocket links below the top of the billet', () => {
  // Pocketing crosses between passes at a gap above the floor the level *above*
  // left, wherever the whole move stays inside what that level emptied — which
  // is a rapid below the top of the stock, and the only thing that makes it
  // safe is the claim that the ground under it has already gone. So the claim
  // is checked here rather than taken on trust: efficiency.test.js exempts
  // pocket from "no travelling rapid below the stock top" and points at this.
  const deep = makePocketBlock({ size: 40, pocketSize: 20, height: 30, depth: 24 });
  const stock = { min: [0, 0, 0], max: [40, 40, 30] };
  const cl = generateToolpath({
    type: 'pocket', tool: FLAT, mesh: deep.mesh, stock,
    params: {
      clearanceHeight: 45, entryGap: 1, tolerance: 0.05, stockToLeave: 0,
      stepdown: 2, stepover: 3, direction: 'climb', leadType: 'none',
      topZ: 30, bottomZ: 6,
    },
  });
  const { crash, crashAt, crashes } = load(cl, { tool: FLAT, stock });
  assert.ok(crash < 0.2,
    `pocket rapids ${crash.toFixed(2)}mm inside standing stock, ${crashes} times, `
    + `at ${JSON.stringify(crashAt)}`);
});

test('and a pass never takes more than its stepdown at full width', () => {
  const { mesh, height } = makeStepped();
  const stock = { min: [-2, -2, 0], max: [42, 42, height + 2] };
  const stepdown = 3;
  for (const type of ['clear2d', 'pocket', 'contour2d']) {
    const cl = generateToolpath({
      type,
      name: type,
      tool: FLAT,
      mesh,
      stock,
      params: {
        topZ: height + 2, bottomZ: 0, stepdown, stepover: 0.5, clearanceHeight: height + 12,
        entryGap: 1, tolerance: 0.01, stockToLeave: 0, rampAngle: 3,
        direction: 'climb', leadType: 'none', contourOutline: 'level',
      },
    });
    const { depth, depthAt } = load(cl, { tool: FLAT, stock });
    assert.ok(depth <= stepdown + 0.3,
      `${type} takes a full-width cut ${depth.toFixed(2)}mm deep at a ${stepdown}mm `
      + `stepdown, at ${JSON.stringify(depthAt)}`);
  }
});

// --- a part that runs out to the edge of its billet ------------------------

test('clearing a slope marches in from the billet edge instead of slotting its middle', () => {
  // A wedge running off the side of the plate is stock edge on three sides of
  // every level's region and part wall on the fourth. Asking whether the
  // *whole* boundary was the stock edge answered no, so the piece took the
  // order meant for a pocket — innermost ring first, which on a band is its
  // medial axis, which is a full-width slot the depth of the level.
  //
  // The two halves of the fix are one claim: the march needs somewhere to start
  // (any touch of the stock edge) and something to turn round at (the part
  // side of the boundary, told apart by which of the two it is nearer).
  const mesh = makeRamp(40, 40, 10);
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] };
  const cl = generateToolpath({
    type: 'clear2d',
    name: 'rough',
    tool: FLAT,
    mesh,
    stock,
    params: {
      topZ: 10, bottomZ: 0, stepdown: 2.5, stepover: 0.5, clearanceHeight: 20,
      entryGap: 1, tolerance: 0.05, stockToLeave: 0.3, rampAngle: 3,
      direction: 'climb', leadType: 'none',
    },
  });
  const { buried, run, runAt } = load(cl, { tool: FLAT, stock, stepdown: 2.5 });
  // 125mm buried and a 5mm unbroken full-width run before; 4mm and 1mm after.
  assert.ok(buried < 30,
    `${buried.toFixed(1)}mm of cutting past three quarters of the diameter on a `
    + '0.5xD stepover');
  assert.ok(run < 3,
    `a ${run.toFixed(1)}mm unbroken full-width run at ${JSON.stringify(runAt)}`);
});

test('no cutting move descends faster than the cutter may be driven downward', () => {
  // A raster follows the surface, and a wall followed is a plunge. Every other
  // strategy says so with FEED.RAMP, which is how feedRate holds the vertical
  // component to the plunge feed; parallel3d emitted every sample as a plain
  // cut, so a ball nose went down a 9mm pocket wall at 800mm/min against a
  // plunge feed of 250.
  const parts = [
    ['pocket', makePocketBlock({ size: 40, pocketSize: 20, height: 20, depth: 12 }).mesh,
      { min: [0, 0, 0], max: [40, 40, 20] }, 20],
    ['step', makeStepped().mesh, { min: [0, 0, 0], max: [40, 40, 20] }, 20],
  ];
  const ball = { ...FLAT, type: 'ball', name: '6mm ball' };
  for (const [name, mesh, stock, top] of parts) {
    for (const type of ['parallel3d', 'waterline', 'contour2d', 'clear2d', 'pocket']) {
      const cl = generateToolpath({
        type,
        name: type,
        tool: ball,
        mesh,
        stock: { kind: 'box', ...stock },
        params: {
          topZ: top, bottomZ: 0, stepdown: 1, stepover: 0.1, clearanceHeight: top + 10,
          entryGap: 1, tolerance: 0.05, stockToLeave: 0, rampAngle: 3,
          direction: 'climb', leadType: 'none',
        },
      });
      let prev = null;
      let worst = 0;
      let at = null;
      eachMove(cl, (op, x, y, z, i, j, k, feed, index) => {
        if (prev && op !== OP.RAPID && feed === FEED.CUT) {
          const d = descentOf(prev, [x, y, z]);
          const down = ball.feedCut * d;
          if (down > worst) { worst = down; at = [x, y, z, index]; }
        }
        prev = [x, y, z];
      });
      assert.ok(worst <= ball.feedPlunge + 1e-6,
        `${type} on the ${name} drives down at ${Math.round(worst)}mm/min where the `
        + `plunge feed is ${ball.feedPlunge}, at ${JSON.stringify(at)}`);
    }
  }
});
