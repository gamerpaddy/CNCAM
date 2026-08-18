// Adaptive clearing: the bite is the promise, so the tests measure it.
//
// Engagement is re-measured independently of the strategy — the emitted program
// is replayed through a fresh material raster at a finer cell size than the one
// it planned with — so these check the toolpath, not the bookkeeping that made it.
//
// Entry moves are excluded from the bite measurement, deliberately and not to
// flatter the result: a ramp entry finishes with a pass that takes off the wedge
// it left, which is as wide as the cutter but only as deep as the last lap
// descended. A 2D engagement measure cannot see that difference, and the ramp
// angle — not the bite limit — is what governs it.

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { eachMove, OP, FEED } from '../engine/cl.js';
import {
  ClearingMap, rasterizeLoops, makeGrid, engagementFraction, widthFromFraction,
} from '../geom/coverage.js';
import { SilhouetteStack } from '../geom/silhouette.js';
import { loopArea } from '../geom/clipper.js';
import { pointInLoops } from '../geom/inside.js';
import { offsetLoops, diffLoops, loopsBounds } from '../geom/clipper.js';
import { stockOutline } from '../engine/stock.js';
import { CollinearFilter, distanceToSegment } from '../engine/simplify.js';
import { cutSpanWithRamp, rampSlopeFor } from '../engine/linking.js';
import { buildGcode } from '../post/index.js';
import { makeBox, makeMushroom, makePocketBlock, makeTube } from './fixtures.js';

const TOOL = {
  number: 1, diameter: 6, spindleRpm: 10000, feedCut: 800, feedPlunge: 300,
};

function paramsFor(overrides = {}) {
  return {
    topZ: 10, bottomZ: 0, stepdown: 10, stepover: 0.5, engagement: 0.2,
    clearanceHeight: 20, stockToLeave: 0, rampAngle: 3, tolerance: 0.01,
    direction: 'climb', ...overrides,
  };
}

/**
 * Replay a single-level program through its own material, and report the widest
 * bite any ordinary cutting move took plus how much material was left standing.
 *
 * The bite at a point is the buried fraction of the cutter disc, read back as
 * the width of cut it stands for — and it is read against the material as it
 * stood when the pass reached this neighbourhood, not as the pass is leaving
 * it. A pass is therefore measured whole: every point of it is read first, and
 * only then is the whole pass swept away.
 *
 * Reading and sweeping point by point instead makes the answer depend on how
 * far apart the points happen to be, in both directions. Collapse forty
 * collinear points into one straight move — the same cut, to within a hundredth
 * of a millimetre — and the single reading at the far end is taken with all
 * forty millimetres still standing, reporting a bite the cutter never took.
 * Densify the same move to a tenth of a millimetre and each reading is of a
 * crescent, reporting almost no bite at all where the tool is buried to the
 * shank. Neither number is about the cut.
 *
 * Area removed per millimetre travelled is the other candidate and is wrong
 * here: it equals the radial width only on a straight move. Spiralling outward
 * out of a bore, the rim of the cutter travels further than its centre, so the
 * same radial step sweeps a bigger area — real on the chip, but not the number
 * the parameter sets.
 */
const PROBE_STEP = 1;
function replay(cl, { mesh, stock, params }) {
  const r = TOOL.diameter / 2;
  const z = params.bottomZ;
  const shadow = new SilhouetteStack(mesh, { tolerance: params.tolerance }).down(z);
  const outer = stockOutline(stock, r);
  const map = new ClearingMap({
    material: diffLoops(stockOutline(stock, 0), offsetLoops(shadow, 0, params.tolerance)),
    allowed: diffLoops(outer, offsetLoops(shadow, r, params.tolerance)),
    radius: r,
    cellSize: 0.15,
    bounds: loopsBounds(outer),
  });

  const bites = [];        // one reading per millimetre of ordinary cutting
  let peak = 0;
  let cuts = 0;
  let retracts = 0;
  let cutLength = 0;
  let prev = null;
  let pass = [];           // the run of same-feed points being measured
  let passFeed = null;

  // read the whole pass, then take the whole pass away
  const closePass = () => {
    if (pass.length === 0) return;
    if (passFeed === FEED.CUT) {
      for (const [px, py] of pass) {
        const bite = widthFromFraction(r, map.engagementAt(px, py));
        peak = Math.max(peak, bite);
        bites.push(bite);
        cuts++;
      }
    }
    for (let i = 1; i < pass.length; i++) {
      map.sweep(pass[i - 1][0], pass[i - 1][1], pass[i][0], pass[i][1]);
    }
    pass = [];
  };

  eachMove(cl, (op, x, y, zz, i, j, k, feed) => {
    if (op === OP.RAPID) {
      closePass();
      passFeed = null;
      if (zz > z + 1e-6) retracts++;
      prev = [x, y];
      return;
    }
    if (Math.abs(zz - z) < 1e-6) {
      if (feed !== passFeed) { closePass(); passFeed = feed; }
      const [ax, ay] = prev ?? [x, y];
      const length = Math.hypot(x - ax, y - ay);
      if (pass.length === 0) pass.push([ax, ay]);
      const pieces = Math.max(1, Math.ceil(length / PROBE_STEP));
      for (let p = 1; p <= pieces; p++) {
        const t = p / pieces;
        pass.push([ax + (x - ax) * t, ay + (y - ay) * t]);
      }
      if (feed === FEED.CUT) cutLength += length;
    } else {
      closePass();
      passFeed = null;
    }
    prev = [x, y];
  });
  closePass();
  bites.sort((a, b) => a - b);
  return {
    cuts,
    cutLength,
    retracts,
    peakBite: peak / TOOL.diameter,
    leftover: map.remainingFraction(),
  };
}

// --- the raster underneath it ---

test('rasterizeLoops fills an outer and leaves its hole empty', () => {
  const square = [0, 0, 20, 0, 20, 20, 0, 20];
  const hole = [15, 5, 5, 5, 5, 15, 15, 15];      // clockwise: a hole
  const grid = makeGrid({ min: [0, 0], max: [20, 20] }, 1);
  const mask = rasterizeLoops([square, hole], grid);
  const at = (x, y) => mask[Math.round(y) * grid.width + Math.round(x)];
  assert.eq(at(2, 2), 1, 'inside the outer');
  assert.eq(at(10, 10), 0, 'inside the hole');
  assert.eq(at(18, 18), 1, 'other side of the hole');
});

test('engagement fraction matches the geometry it stands for', () => {
  const r = 3;
  assert.close(engagementFraction(r, 0), 0, 1e-9, 'no bite, nothing buried');
  assert.close(engagementFraction(r, 2 * r), 1, 1e-9, 'slotting buries the whole disc');
  assert.close(engagementFraction(r, r), 0.5, 1e-9, 'a bite of one radius is half the disc');
  // and it reads backwards, which is how a measured fraction is reported
  for (const w of [0.3, 1.5, 4.2]) {
    assert.close(widthFromFraction(r, engagementFraction(r, w)), w, 1e-3, `round trip ${w}`);
  }
});

test('a cleared region reports no material and offers no seed', () => {
  const map = new ClearingMap({
    material: [[0, 0, 20, 0, 20, 20, 0, 20]],
    allowed: [[-5, -5, 25, -5, 25, 25, -5, 25]],
    radius: 3, cellSize: 0.5, bounds: { min: [-5, -5], max: [25, 25] },
  });
  assert.ok(map.findSeed(), 'material to start on');
  assert.ok(map.remainingFraction() > 0.99, 'nothing cut yet');
  for (let y = -1; y <= 21; y += 2) map.sweep(-6, y, 26, y);
  assert.ok(map.remainingFraction() < 0.01, `swept clean, ${map.remainingFraction()}`);
  assert.eq(map.findSeed(), null, 'nowhere left to seed');
});

// --- the strategy ---

test('adaptive holds the bite where Z-level clearing spikes to a slot', () => {
  // a 20mm island in a 60mm billet: four corners where offsets meet
  const mesh = makeBox(20, 20, 10);
  const stock = { min: [-20, -20, 0], max: [40, 40, 10] };
  const params = paramsFor();
  const shared = { tool: TOOL, mesh, stock, params };

  const adaptive = replay(generateToolpath({ type: 'adaptive', name: 'a', ...shared }),
    { mesh, stock, params });
  const zlevel = replay(generateToolpath({ type: 'clear2d', name: 'c', ...shared }),
    { mesh, stock, params });

  assert.ok(adaptive.cuts > 100, `adaptive produced ${adaptive.cuts} cuts`);
  assert.ok(adaptive.peakBite < 0.25, `adaptive bit ${adaptive.peakBite.toFixed(3)}xD, asked for 0.2`);
  // The point of the whole strategy: concentric offsets cannot hold a bite,
  // because where two of them meet the spacing is whatever the geometry leaves.
  //
  // This used to read `> 0.5`, which was a fair reading of a strategy that
  // stepped a fixed distance off each edge and let the last pass take the
  // remainder — on this island it spiked to a slot. Spacing the rings to divide
  // the band (see engine/rings.js) took that to 0.42, which is still half as
  // much again as adaptive and still above the 0.2 it was set: the corners
  // where offsets converge are the part no offsetting can hold.
  assert.ok(zlevel.peakBite > 0.3, `Z-level only reached ${zlevel.peakBite.toFixed(3)}xD`);
  assert.ok(zlevel.peakBite > adaptive.peakBite * 1.5,
    `and it is not close: ${zlevel.peakBite.toFixed(3)} vs ${adaptive.peakBite.toFixed(3)}`);
  assert.ok(adaptive.leftover < zlevel.leftover + 0.01,
    `clears as much material (${adaptive.leftover.toFixed(3)} vs ${zlevel.leftover.toFixed(3)})`);
});

test('the bite follows the parameter it is set from', () => {
  const mesh = makeBox(20, 20, 10);
  const stock = { min: [-20, -20, 0], max: [40, 40, 10] };
  let previous = 0;
  for (const engagement of [0.1, 0.2, 0.4]) {
    const params = paramsFor({ engagement });
    const cl = generateToolpath({ type: 'adaptive', name: 'a', tool: TOOL, mesh, stock, params });
    const { peakBite } = replay(cl, { mesh, stock, params });
    // Within a raster cell of the parameter, at every setting — the cell being
    // the one the strategy plans with, worked out here the same way.
    //
    // It used to read `engagement * 1.15`, which is a tighter number than the
    // sentence it was written under and only happened to hold. It stopped
    // holding when entries stopped ramping along the span they were entering
    // (see openDescent): a span that is now one continuous cutting pass used to
    // be a ramp followed by a shorter one, and this replay reads a pass against
    // the material as it stood when the pass *began*. Same cut, longer pass,
    // higher reading — at 0.2xD it went to 0.239 and the peak lands out at the
    // corner of the billet where the tool is peeling the outside margin.
    //
    // What the cutter actually does was measured independently, by carving a
    // heightmap and dividing the footprint taken by the distance travelled,
    // which does not depend on where a pass happens to be punctuated: 0.100,
    // 0.200 and 0.400xD for the three settings, peak 0.101, 0.202, 0.404. See
    // engagement.test.js, which asserts that directly.
    const cell = Math.min(Math.max((engagement * TOOL.diameter) / 3, 0.1), TOOL.diameter / 4, 1);
    assert.ok(peakBite <= engagement + cell / TOOL.diameter,
      `${engagement}xD asked, ${peakBite.toFixed(3)}xD taken`);
    assert.ok(peakBite > previous, 'a bigger parameter takes a bigger bite');
    previous = peakBite;
  }
});

test('adaptive opens an enclosed pocket from the inside instead of slotting in', () => {
  // the front of a peel run from the stock boundary reappears inside a pocket
  // with nothing cleared beside it; driving it in there would be a full slot
  const { mesh, floorZ } = makePocketBlock({ size: 40, pocketSize: 24, height: 10, depth: 6 });
  const stock = { min: [0, 0, 0], max: [40, 40, 10] };
  const params = paramsFor({ topZ: 10, bottomZ: floorZ, stepdown: 10 });
  const cl = generateToolpath({ type: 'adaptive', name: 'a', tool: TOOL, mesh, stock, params });
  const { peakBite, cuts } = replay(cl, { mesh, stock, params });

  assert.ok(cuts > 50, `pocket floor was machined (${cuts} cuts)`);
  // Boring out and spiralling is bite-limited like anything else; slotting into
  // the pocket wall would read as a full diameter here.
  assert.ok(peakBite < 0.25, `pocket bite ${peakBite.toFixed(3)}xD`);
});

test('adaptive keeps the cutter clear of an overhanging cap', () => {
  const { mesh, cap, postHeight, capHeight } = makeMushroom();
  const cl = generateToolpath({
    type: 'adaptive', name: 'rough', tool: TOOL, mesh,
    stock: { min: [0, 0, 0], max: [40, 40, postHeight + capHeight] },
    params: paramsFor({ topZ: postHeight + capHeight, bottomZ: 0, stepdown: 4 }),
  });

  const r = TOOL.diameter / 2;
  let cuts = 0;
  let worst = Infinity;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE || feed === FEED.RAPID) return;
    cuts++;
    const dx = Math.max(cap.min[0] - x, 0, x - cap.max[0]);
    const dy = Math.max(cap.min[1] - y, 0, y - cap.max[1]);
    worst = Math.min(worst, Math.hypot(dx, dy));
  });
  assert.ok(cuts > 0, 'produced cutting moves');
  assert.ok(worst > r - 0.05, `cut ${worst.toFixed(3)}mm from the cap, need >= ${r}`);
});

test('adaptive lifts the tool less often than Z-level clearing, despite more passes', () => {
  const mesh = makeBox(20, 20, 10);
  const stock = { min: [-20, -20, 0], max: [40, 40, 10] };
  const params = paramsFor();
  const shared = { tool: TOOL, mesh, stock, params };
  const adaptive = replay(generateToolpath({ type: 'adaptive', name: 'a', ...shared }),
    { mesh, stock, params });
  const zlevel = replay(generateToolpath({ type: 'clear2d', name: 'c', ...shared }),
    { mesh, stock, params });

  // Distance, not move count: adaptive writes its straights as single long
  // moves, so counting moves would measure how the path is punctuated rather
  // than how far the cutter travels.
  assert.ok(adaptive.cutLength > zlevel.cutLength,
    `adaptive cuts further — that is the trade `
    + `(${adaptive.cutLength.toFixed(0)} vs ${zlevel.cutLength.toFixed(0)} mm)`);
  assert.ok(adaptive.retracts < zlevel.retracts,
    `but lifts fewer times (${adaptive.retracts} vs ${zlevel.retracts})`);
});

test('a flat floor at the final depth is machined, not treated as an obstacle', () => {
  // The silhouette is what a tool tip at z is blocked by, and a floor lying
  // exactly at z is the surface the pass exists to cut. Counting it as keepout
  // left the last pass with nothing to do and the floor uncut.
  const { mesh, floorZ, pocket } = makePocketBlock({ size: 40, pocketSize: 24, height: 10, depth: 6 });
  const stock = { min: [0, 0, 0], max: [40, 40, 10] };
  for (const type of ['adaptive', 'clear2d']) {
    const cl = generateToolpath({
      type, name: type, tool: TOOL, mesh, stock,
      params: paramsFor({ topZ: 10, bottomZ: floorZ, stepdown: 2 }),
    });
    let atFloor = 0;
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (op !== OP.LINE || feed === FEED.RAPID || Math.abs(z - floorZ) > 1e-6) return;
      if (x > pocket.min[0] && x < pocket.max[0] && y > pocket.min[1] && y < pocket.max[1]) atFloor++;
    });
    assert.ok(atFloor > 10, `${type} cut the pocket floor (${atFloor} moves at ${floorZ})`);
  }
});

// --- how much of the path reaches the machine ---

test('collinear runs collapse, and only within the tolerance they were given', () => {
  const kept = [];
  const filter = new CollinearFilter((x, y, z, feed) => kept.push([x, y, z, feed]), 0.05);
  // a straight 40mm wall sampled every millimetre, then a right-angle turn
  const dense = [];
  for (let x = 0; x <= 40; x += 1) dense.push([x, 0]);
  for (let y = 1; y <= 10; y += 1) dense.push([40, y]);
  for (const [x, y] of dense) filter.push(x, y, -5, FEED.CUT);
  filter.flush();

  assert.ok(kept.length <= 4, `41 collinear points plus a corner became ${kept.length}`);
  // and the corner is still a corner
  assert.close(kept[kept.length - 1][0], 40, 1e-9);
  assert.close(kept[kept.length - 1][1], 10, 1e-9);
  // every original point is still on the simplified path, within tolerance
  for (const [x, y] of dense) {
    let best = Infinity;
    for (let i = 1; i < kept.length; i++) {
      best = Math.min(best, distanceToSegment([x, y, -5], kept[i - 1], kept[i]));
    }
    assert.ok(best <= 0.05 + 1e-9, `(${x}, ${y}) drifted ${best.toFixed(4)} off the path`);
  }
});

test('a bend bigger than the tolerance is never merged away', () => {
  const kept = [];
  const filter = new CollinearFilter((x, y, z, feed) => kept.push([x, y]), 0.01);
  // a shallow arc: every point is nearly collinear with its neighbours, but the
  // arc as a whole is not, and merging the lot would cut a chord across it
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI;
    filter.push(20 - 20 * Math.cos(a), 3 * Math.sin(a), -5, FEED.CUT);
  }
  filter.flush();
  assert.ok(kept.length > 8, `an arc kept only ${kept.length} points`);
  assert.ok(kept.length < 40, `and did not keep all 41 of them either (${kept.length})`);
});

test('a feed change ends a run, so a lead-in never becomes a cut', () => {
  const kept = [];
  const filter = new CollinearFilter((x, y, z, feed) => kept.push([x, feed]), 1);
  // collinear throughout, but the middle stretch is a lead
  filter.push(0, 0, -5, FEED.LEAD);
  filter.push(1, 0, -5, FEED.LEAD);
  filter.push(2, 0, -5, FEED.CUT);
  filter.push(3, 0, -5, FEED.CUT);
  filter.flush();
  const feeds = kept.map((k) => k[1]);
  assert.ok(feeds.includes(FEED.LEAD), `the lead survived: ${JSON.stringify(kept)}`);
  assert.ok(feeds.includes(FEED.CUT), `and so did the cut: ${JSON.stringify(kept)}`);
});

test('adaptive says the same path in far fewer moves', () => {
  // Straight walls arrive from the resampler as a point every millimetre or so,
  // because that is what sweeping the material raster needs — not because the
  // machine needs to be told to go straight forty times.
  const mesh = makeBox(20, 20, 10);
  const stock = { min: [-20, -20, 0], max: [40, 40, 10] };
  const params = paramsFor();
  const cl = generateToolpath({ type: 'adaptive', name: 'a', tool: TOOL, mesh, stock, params });

  let moves = 0;
  eachMove(cl, () => moves++);
  const { leftover, peakBite } = replay(cl, { mesh, stock, params });
  assert.ok(moves < 2000, `${moves} moves for a 60mm billet with a 20mm island`);
  // and it is the same cut: nothing left standing, bite still held
  assert.ok(leftover < 0.01, `left ${(leftover * 100).toFixed(1)}% standing`);
  assert.ok(peakBite < 0.25, `bit ${peakBite.toFixed(3)}xD`);
});

// A ramp descends by *length*, so a short span at a shallow angle needs a great
// many laps — and the shallower the angle, the bigger the file, which is the
// opposite of what a ramp angle is for. Measured before the fix: at a 2mm
// stepdown a 0.6mm leftover span was ramped a hundred times inside its own
// half-millimetre window, and that was most of the program.
test('a shallow ramp angle no longer multiplies the program', () => {
  const mesh = makeBox(20, 20, 20);
  const stock = { min: [-20, -20, 0], max: [40, 40, 20] };
  const at = (rampAngle) => {
    const params = paramsFor({ topZ: 20, bottomZ: 0, stepdown: 2, rampAngle });
    let moves = 0;
    eachMove(generateToolpath({
      type: 'adaptive', name: 'a', tool: TOOL, mesh, stock, params,
    }), () => moves++);
    return moves;
  };
  const shallow = at(2);
  const steep = at(7);
  const none = at(0);
  assert.ok(shallow <= steep * 1.2,
    `2° is no dearer than 7° (${shallow} vs ${steep} moves)`);
  assert.ok(shallow < none * 2,
    `and within reach of plunging (${shallow} vs ${none} moves)`);
});

test('a span shorter than the cutter is plunged, not oscillated in', () => {
  // Every point of a span this short is within one radius of every other, so
  // the tool never leaves the hole it is making whatever angle it descends at.
  // Ramping is then a hundred laps that cut exactly what one plunge cuts.
  const span = [[0, 0], [0.6, 0]];
  const moves = [];
  const end = cutSpanWithRamp((x, y, z, feed) => moves.push([x, y, z, feed]),
    span, 2, 0, 2, { minLength: 6 });
  assert.eq(moves.length, 2, `one plunge and one cut, not ${moves.length} moves`);
  assert.eq(moves[0][3], FEED.PLUNGE);
  assert.close(moves[0][2], 0, 1e-9, 'straight to depth');
  assert.eq(end[0], 0.6, 'and it still finishes at the far end of the span');

  // A span the cutter can work along still ramps.
  const long = [[0, 0], [40, 0]];
  const ramped = [];
  cutSpanWithRamp((x, y, z, feed) => ramped.push([x, y, z, feed]),
    long, 2, 0, 2, { minLength: 6 });
  assert.ok(ramped.some((m) => m[3] === FEED.RAMP), 'a 40mm span is ramped');
});

test('the ramp angle is honoured, or the program says it was not', () => {
  // 2° over 5mm of span is fifty-seven laps to descend 10mm. The choice is
  // between steepening and plunging, and steepening is the gentler of the two.
  const gentle = rampSlopeFor(2, 40, 2);
  assert.ok(!gentle.steepened, 'a long span takes the angle it was given');
  assert.close(gentle.slope, Math.tan((2 * Math.PI) / 180), 1e-9);

  const forced = rampSlopeFor(10, 5, 2);
  assert.ok(forced.steepened, 'a short span cannot');
  assert.close(forced.laps, 8, 1e-9, 'and lands in the laps allowed');
  assert.close(forced.slope * 5 * 8, 10, 1e-6, 'reaching exactly the depth asked');
});

// "It still makes multiple holes instead of one to mill out from there."
test('a walled-off region is opened once, not again three millimetres away', () => {
  const { mesh, floorZ } = makePocketBlock({ size: 80, pocketSize: 50, height: 20, depth: 14 });
  const stock = { min: [0, 0, 0], max: [80, 80, 20] };
  const params = paramsFor({ topZ: 20, bottomZ: floorZ, stepdown: 2, rampAngle: 2 });
  const cl = generateToolpath({ type: 'adaptive', name: 'a', tool: TOOL, mesh, stock, params });

  const levels = Math.round((20 - floorZ) / 2);
  const note = cl.notes.map((n) => n.text).join(' ');
  assert.ok(note.includes('adaptive: peak bite'), `the pass summarises itself: ${note}`);
  // absent when there were none to open, which is itself an answer of zero
  const seeds = Number(/(\d+) walled-off regions? opened/.exec(note)?.[1] ?? 0);
  // one pocket, one hole per level — the fault was two, the second landing
  // three millimetres from the first after the peel stalled at 2% cleared
  assert.ok(seeds <= levels, `${seeds} entry holes for ${levels} levels of one pocket`);
  const { leftover } = replay(cl, { mesh, stock, params });
  assert.ok(leftover < 0.05, `and it still clears the level (${leftover.toFixed(3)} left)`);
});

// "The hole is still full of stock, and the operation says it went fine."
test('a walled-off region narrower than the opening circle is still opened', () => {
  // A ⌀8 hole with a ⌀6 cutter: the tool centre has 1mm of room in there, and
  // the circle the peel opens a region with wanted 1.2 of it. A front is a
  // path, so a circle that does not fit clips to *nothing* — the region was
  // found, peeled at, and left exactly as it was, MAX_SEEDS times over.
  const mesh = makeTube(20, 20, 14, 4, 10, 64);
  const stock = { min: [0, 0, 0], max: [40, 40, 10] };
  const params = paramsFor({ topZ: 10, bottomZ: 0, stepdown: 10, engagement: 0.2 });
  const cl = generateToolpath({ type: 'adaptive', tool: TOOL, mesh, stock, params });

  let nearest = Infinity;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.RAPID) return;
    nearest = Math.min(nearest, Math.hypot(x - 20, y - 20));
  });
  // the centre may reach 1mm out from the axis; anywhere in there is the hole
  assert.ok(nearest <= 1.01, `the pass goes into the hole (nearest ${nearest.toFixed(2)}mm)`);

  // and it does not spend its seed budget finding out
  const note = cl.notes.map((n) => n.text).join(' ');
  const seeds = Number(/(\d+) walled-off regions? opened/.exec(note)?.[1] ?? 0);
  assert.ok(seeds > 0 && seeds <= 2, `one region, opened once (${seeds}): ${note}`);
});

/**
 * Cutting travel outside the part's footprint that does not run along a stock
 * edge, in mm.
 *
 * The margin round a rectangular part in oversize stock is cleared by offsets
 * of the stock boundary and one lap round the part, so all of it but the
 * corners is axis-parallel. An arc struck from somewhere *inside* the part is
 * not, which is what makes this the measurement to take: it stays near zero
 * for a pass that cut the margin the way the margin is shaped.
 */
function acrossTheMargin(cl, { size }) {
  const outside = (x, y) => x < -0.05 || x > size + 0.05 || y < -0.05 || y > size + 0.05;
  let total = 0;
  let prev = null;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE) { prev = null; return; }
    if (prev && feed !== FEED.RAPID && outside(x, y) && outside(prev[0], prev[1])
      && Math.abs(x - prev[0]) > 0.02 && Math.abs(y - prev[1]) > 0.02) {
      total += Math.hypot(x - prev[0], y - prev[1]);
    }
    prev = [x, y];
  });
  return total;
}

test('the spiral that opens a pocket stays in the pocket', () => {
  // Stock 6mm oversize all round, so the level has two separate places the
  // cutter can be: the margin outside the part, and the pocket. The peel from
  // the stock boundary clears the first and stops at the part; the seeded peel
  // opens the second — and its rings, being circles about the seed that grow
  // until they are as wide as the job, used to carry on straight over the part
  // and cut the band of stock the wall pass had been left. Concentric arcs in
  // the margin, struck from the middle of a pocket 20mm away.
  const stock = { min: [-6, -6, 0], max: [46, 46, 10] };
  const params = paramsFor({ topZ: 10, bottomZ: 4, stepdown: 10 });
  const run = (mesh) => generateToolpath({
    type: 'adaptive', name: 'a', tool: TOOL, mesh, stock, params,
  });

  // the same billet and the same margin, with nothing inside the part to open
  const plain = acrossTheMargin(run(makeBox(40, 40, 10)), { size: 40 });
  const pocketed = acrossTheMargin(
    run(makePocketBlock({ size: 40, pocketSize: 24, height: 10, depth: 6 }).mesh), { size: 40 });

  // corner arcs either way; what a pocket may not do is add a hundred times
  // that much curved cutting to ground it is nowhere near
  assert.ok(pocketed < plain * 3 + 10,
    `${pocketed.toFixed(0)}mm cut across the margin with a pocket in the part, `
    + `${plain.toFixed(0)}mm without one`);
});

test('a roughing pass is written at its resolution, not at a finishing tolerance', () => {
  const { mesh, floorZ } = makePocketBlock({ size: 80, pocketSize: 50, height: 20, depth: 14 });
  const stock = { min: [0, 0, 0], max: [80, 80, 20] };
  const at = (resolution) => {
    const params = paramsFor({ topZ: 20, bottomZ: floorZ, stepdown: 2, rampAngle: 2, resolution });
    const cl = generateToolpath({ type: 'adaptive', name: 'a', tool: TOOL, mesh, stock, params });
    return buildGcode('linuxcnc', [{ name: 'a', cl }], {}).text.split('\n').length;
  };
  const fine = at(0);
  const normal = at(0.1);
  assert.ok(normal < fine * 0.6, `0.1mm resolution is far shorter (${normal} vs ${fine} lines)`);
  // Coarsening must not *lengthen* the file, which is what happened while the
  // post fitted arcs to a tighter budget than the path was written at: chords
  // wider than the arc tolerance fail the sagitta check, so a bore that is one
  // G2 came out as four hundred G1s. See CLBuilder.setResolution.
  assert.ok(at(0.4) <= normal * 1.2,
    `and coarser is not somehow longer (${at(0.4)} vs ${normal} lines)`);
});

test('a link at depth is allowed to start where the last pass ended', () => {
  // Every span the clipper produces ends exactly on the boundary of the region
  // it was clipped to. Reading that boundary with the eroded mask — the one
  // that answers "may the cutter go here" — calls it out of bounds, so a link
  // was refused before it began and the tool retracted between every pass.
  const map = new ClearingMap({
    material: [[0, 0, 40, 0, 40, 40, 0, 40]],
    allowed: [[0, 0, 40, 0, 40, 40, 0, 40]],
    radius: 3, cellSize: 0.5, bounds: { min: [0, 0], max: [40, 40] },
  });
  assert.ok(!map.allowedAt(0, 20), 'the eroded mask keeps the cutter off the edge');
  assert.ok(map.insideAt(0, 20), 'but the edge is still somewhere a move may pass through');
  assert.ok(!map.insideAt(-4, 20), 'and outside is still outside');
});

test('adaptive lifts out of the cut far less than it used to', () => {
  const mesh = makeBox(20, 20, 10);
  const stock = { min: [-20, -20, 0], max: [40, 40, 10] };
  const params = paramsFor();
  const { retracts } = replay(
    generateToolpath({ type: 'adaptive', name: 'a', tool: TOOL, mesh, stock, params }),
    { mesh, stock, params },
  );
  // one level, one island: a handful of entries, not one per pass
  assert.ok(retracts < 20, `${retracts} retracts on a single level`);
});

test('a run longer than the old 64-point cap still collapses to one move', () => {
  // A turning finish pass samples the profile at the operation's tolerance, so
  // a plain 60mm diameter arrives as twelve hundred points. Capping the run at
  // 64 wrote nineteen G1 blocks for one straight line.
  const kept = [];
  const filter = new CollinearFilter((x, y, z, feed) => kept.push([x, y, z]), 0.004);
  for (let i = 0; i <= 1200; i++) filter.push(i * 0.05, 0, -5, FEED.CUT);
  filter.flush();
  assert.eq(kept.length, 2, `1201 collinear points became ${kept.length} moves`);
  assert.close(kept[1][0], 60, 1e-9, 'and the far end is where it was');
});

test('the run-length shortcut never merges a point it should have kept', () => {
  // The cone test is only a shortcut; when it cannot answer, the exact rescan
  // does. Both have to agree, on straight runs, noisy ones, arcs and walks.
  const exact = (p, tol) => {
    const kept = [];
    const f = new CollinearFilter((x, y, z, feed) => kept.push([x, y, z, feed]), tol, 1e9);
    f.deviates = function slow(q) {
      if (distanceToSegment(this.held, this.anchor, q) > this.tol) return true;
      return this.dropped.some((r) => distanceToSegment(r, this.anchor, q) > this.tol);
    };
    f.narrowCone = () => {};
    for (const [x, y, z, feed] of p) f.push(x, y, z, feed);
    f.flush();
    return kept;
  };
  const fast = (p, tol) => {
    const kept = [];
    const f = new CollinearFilter((x, y, z, feed) => kept.push([x, y, z, feed]), tol, 1e9);
    for (const [x, y, z, feed] of p) f.push(x, y, z, feed);
    f.flush();
    return kept;
  };
  let seed = 20260806;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let trial = 0; trial < 60; trial++) {
    const points = [];
    let x = 0; let y = 0; let z = 0;
    const shape = trial % 4;
    for (let i = 0; i < 160; i++) {
      if (shape === 0) x += 0.05;
      else if (shape === 1) { x += 0.05; y += (rnd() - 0.5) * 0.004; }
      else if (shape === 2) { const a = i * 0.01; x = 20 * Math.cos(a); y = 20 * Math.sin(a); }
      else { x += rnd() * 0.2 - 0.1; y += rnd() * 0.2 - 0.1; z += rnd() * 0.05 - 0.025; }
      points.push([x, y, z, i % 37 === 0 && shape === 3 ? FEED.LEAD : FEED.CUT]);
    }
    assert.eq(JSON.stringify(fast(points, 0.004)), JSON.stringify(exact(points, 0.004)),
      `shape ${shape} differed`);
  }
});

test('the silhouette keeps shapes and drops the seams between them', () => {
  // A union of many touching triangles leaves hairline slivers along the seams.
  // Judged by area alone they survive — a sliver a micron wide and a
  // millimetre long has more area than a small hole — and every level after
  // carries them. What makes it more than a cost is what happens next:
  // waterline offsets the silhouette outward by the tool radius, so a sliver
  // of no width becomes a full circle of toolpath.
  const block = makeBox(40, 30, 10);
  const stack = new SilhouetteStack(block, { tolerance: 0.01 });
  const loops = stack.down(5);
  assert.eq(loops.length, 1, `a box casts one shadow, got ${loops.length}`);
  assert.close(Math.abs(loopArea(loops[0])), 1200, 1, 'and it is the box');

  // …and the shadow still covers the part: every corner of it is inside.
  for (const [x, y] of [[1, 1], [39, 1], [39, 29], [1, 29], [20, 15]]) {
    assert.ok(pointInLoops(loops, x, y), `(${x}, ${y}) is under the part`);
  }
});
