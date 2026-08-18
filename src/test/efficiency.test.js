// Toolpath efficiency: the moves that were being made for nothing.
//
// Every test here is a pair of claims — the program got shorter, *and* it still
// cuts the same thing and cannot hit anything on the way. The second half is
// the one that matters: an optimisation that shortens a program by driving the
// tool through the part is not an optimisation.

import { test, assert } from './runner.js';
import { CLBuilder, MOVE_STRIDE, OP, FEED, eachMove } from '../engine/cl.js';
import { generateToolpath } from '../engine/toolpath.js';
import { orderByProximity, startNearest } from '../engine/linking.js';
import { makeBox, makePocketBlock, makeShaft } from './fixtures.js';
import { mergeMeshes, computeNormals } from '../geom/mesh.js';
import { buildHeightmap } from '../geom/heightmap.js';

const FLAT = {
  number: 1, type: 'flat', name: '6mm flat', diameter: 6, flutes: 2,
  fluteLength: 20, spindleRpm: 12000, feedCut: 800, feedPlunge: 250,
};
const INSERT = {
  number: 1, type: 'turning', name: 'CCMT 0.4', diameter: 6, noseRadius: 0.4,
  fluteLength: 12, flutes: 1, spindleRpm: 1200, feedCut: 120, feedPlunge: 80,
};

function moves(cl) {
  const out = [];
  eachMove(cl, (op, x, y, z, i, j, k, feed) => out.push({ op, x, y, z, feed }));
  return out;
}

/** How far the tool travels at rapid, which is the cost being attacked. */
function rapidDistance(cl) {
  let sum = 0;
  let prev = null;
  for (const m of moves(cl)) {
    if (prev && m.op === OP.RAPID) {
      sum += Math.hypot(m.x - prev.x, m.y - prev.y, m.z - prev.z);
    }
    prev = m;
  }
  return sum;
}

// --- the peephole on retracts ---------------------------------------------

test('a retract straight back down at the same place is dropped', () => {
  const cl = new CLBuilder();
  cl.rapid(0, 0, 10);
  cl.cut(0, 0, -2, FEED.PLUNGE);
  cl.cut(5, 0, -2);
  cl.rapid(5, 0, 10);      // retract, purely vertical
  cl.rapid(5, 0, 1);       // and straight back down at the same XY
  cl.cut(5, 0, -4, FEED.PLUNGE);
  const out = cl.finish();

  const ms = moves(out);
  assert.eq(ms.length, 5, 'one move gone');
  // the tool still ends up where it was going, and never left the column
  assert.eq(ms[3].z, 1, 'the descent survived');
  assert.eq(ms[3].x, 5);
  assert.eq(ms[4].z, -4, 'and so did the cut under it');
});

test('a retract that also travels is never dropped', () => {
  // This is the crash the rule exists to not cause: the retract is what lifts
  // the tool out of one cut before it crosses to the next.
  const cl = new CLBuilder();
  cl.rapid(0, 0, 10);
  cl.cut(0, 0, -5, FEED.PLUNGE);
  cl.rapid(40, 0, 10);     // out of the cut AND across the part
  cl.rapid(40, 0, 1);
  cl.cut(40, 0, -5, FEED.PLUNGE);
  const out = cl.finish();

  const ms = moves(out);
  assert.eq(ms.length, 5, 'nothing may be dropped here');
  // specifically: the move that lifts out of the cut before crossing the part
  assert.eq(ms[2].z, 10, 'the retract survived');
  assert.eq(ms[2].x, 40);
  assert.eq(ms[3].z, 1, 'and the descent after it');
});

test('the first move of a program is never dropped', () => {
  // it is where the tool starts; there is nothing before it to be a subset of
  const cl = new CLBuilder();
  cl.rapid(20, 20, 15);
  cl.rapid(20, 20, 2);
  const out = cl.finish();
  assert.eq(out.count, 2, 'both survive');
});

test('events stay attached to the move they were recorded at', () => {
  const cl = new CLBuilder();
  cl.rapid(0, 0, 10);
  cl.rapid(0, 0, 5);        // droppable
  cl.rapid(0, 0, 1);
  cl.toolChange(7);         // recorded at index 3
  cl.cut(0, 0, -1, FEED.PLUNGE);
  const out = cl.finish();

  const tool = out.events.find((e) => e.type === 'tool');
  const at = tool.index * MOVE_STRIDE;
  assert.eq(out.moves[at], OP.LINE, 'the tool change still lands before the cut');
  assert.eq(out.moves[at + 3], -1);
});

test('a deep contour no longer climbs to clearance between levels', () => {
  const mesh = makeBox(40, 40, 20);
  const params = {
    topZ: 20, bottomZ: 0, stepdown: 1, clearanceHeight: 40, entryGap: 1,
    tolerance: 0.05, stockToLeave: 0, direction: 'climb', leadType: 'none',
    rampAngle: 0, side: 'outside', profile: 'outer', contourOutline: 'part',
    tabCount: 0, finishPasses: 0,
  };
  const cl = generateToolpath({ type: 'contour2d', name: 'profile', tool: FLAT, mesh, params });

  // Twenty levels of the same outline: the tool has no reason to visit Z40
  // nineteen times, because it descends into the slot it just cut.
  const atClearance = moves(cl).filter((m) => Math.abs(m.z - 40) < 1e-6).length;
  assert.ok(atClearance <= 2, `still visiting clearance ${atClearance} times`);
  // and it did actually cut all twenty levels
  const depths = new Set(moves(cl).filter((m) => m.feed !== FEED.RAPID)
    .map((m) => Math.round(m.z * 100) / 100));
  assert.ok(depths.size >= 20, `only ${depths.size} depths cut`);
});

// --- ordering --------------------------------------------------------------

/** A square loop of side `s` centred on (cx, cy), as flat [x, y, …]. */
function square(cx, cy, s) {
  const h = s / 2;
  return [cx - h, cy - h, cx + h, cy - h, cx + h, cy + h, cx - h, cy + h];
}

test('loops are ordered so the tool does not cross the work between them', () => {
  // deliberately the worst order there is: a row of features, listed by
  // alternating ends, which is what an offsetter's output order feels like
  const loops = [
    square(0, 0, 4), square(100, 0, 4), square(10, 0, 4),
    square(90, 0, 4), square(20, 0, 4), square(80, 0, 4),
  ];
  const before = travel(loops);
  const after = travel(orderByProximity(loops, [0, 0]));
  assert.ok(after < before * 0.5,
    `ordering saved nothing: ${before.toFixed(0)} → ${after.toFixed(0)}`);
  // the ideal order is a single sweep down the row: 0, 10, 20 … 80, 90, 100
  assert.eq(after, 100, 'anything more than one pass down the row is waste');
  assert.eq(loops.length, 6, 'and every loop is still there');
});

/** Distance the tool travels between the start points of consecutive loops. */
function travel(loops) {
  let sum = 0;
  for (let i = 1; i < loops.length; i++) {
    sum += Math.hypot(loops[i][0] - loops[i - 1][0], loops[i][1] - loops[i - 1][1]);
  }
  return sum;
}

test('a loop is entered at the point nearest the tool, not always at its first', () => {
  const loop = square(0, 0, 10);          // starts at (-5, -5)
  const rotated = startNearest(loop, [5, 5]);
  assert.eq(rotated[0], 5, 'starts at the near corner now');
  assert.eq(rotated[1], 5);
  assert.eq(rotated.length, loop.length, 'and is the same loop');
  // the same points, in the same cyclic order
  const cycle = [...rotated.slice(4), ...rotated.slice(0, 4)];
  assert.eq(cycle.join(), loop.join(), 'rotated, not reordered');
});

test('chamfering several holes takes them in order rather than at random', () => {
  const { mesh } = makePocketBlock({ size: 60, pocketSize: 16, height: 10, depth: 6 });
  const chamferTool = {
    number: 2, type: 'chamfer', name: '6mm 90°', diameter: 6, tipAngle: 90,
    tipDiameter: 0.5, flutes: 2, fluteLength: 10, spindleRpm: 8000,
    feedCut: 700, feedPlunge: 250,
  };
  const cl = generateToolpath({
    type: 'chamfer',
    name: 'break edges',
    tool: chamferTool,
    mesh,
    params: {
      topZ: 10, bottomZ: -5, clearanceHeight: 25, entryGap: 1, tolerance: 0.05,
      chamferWidth: 0.4, chamferClearance: 0.3, chamferPasses: 1,
      chamferEdges: 'all', direction: 'climb', leadType: 'none',
    },
  });
  assert.ok(moves(cl).length > 10, 'it cut something');
  // no single traverse crosses more than the block's own diagonal, which is the
  // most any sane order ever needs
  let prev = null;
  let longest = 0;
  for (const m of moves(cl)) {
    if (prev && m.op === OP.RAPID) {
      longest = Math.max(longest, Math.hypot(m.x - prev.x, m.y - prev.y));
    }
    prev = m;
  }
  assert.ok(longest <= Math.hypot(60, 60) + 1,
    `a ${longest.toFixed(1)}mm traverse on a 60mm block`);
});

// --- the sweep -------------------------------------------------------------

test('no milling strategy goes home between passes when it need not', () => {
  // The bug this catches is one shape repeated in five places: a pass that
  // retracts to clearance because it does not know what the next one is. It is
  // invisible on a shallow part with one loop per level — the retract and the
  // descent are at the same XY and the peephole drops the pair — so the fixture
  // is deep enough and split enough to have real transitions.
  const deep = makePocketBlock({ size: 40, pocketSize: 20, height: 30, depth: 24 });
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 30] };
  const params = {
    clearanceHeight: 45, entryGap: 1, tolerance: 0.05, stockToLeave: 0,
    stepdown: 2, stepover: 3, direction: 'climb', leadType: 'none',
    topZ: 30, bottomZ: 6,
  };

  // slot belongs here for the same reason as the rest and was missing from the
  // list, which is exactly why it kept its retracts: ten passes down a channel,
  // every one of them arriving from and leaving at full clearance.
  for (const type of ['clear2d', 'pocket', 'contour2d', 'waterline', 'adaptive', 'slot']) {
    const cl = generateToolpath({
      type, name: type, tool: FLAT, mesh: deep.mesh, stock, params,
    });
    let climbs = 0;
    let prev = null;
    let travelledLow = 0;
    for (const m of moves(cl)) {
      if (prev) {
        if (m.z >= 45 - 1e-6 && prev.z < 45 - 1e-6) climbs++;
        if (m.op === OP.RAPID && Math.hypot(m.x - prev.x, m.y - prev.y) > 1e-6
          && Math.min(m.z, prev.z) < 45 - 1e-6) travelledLow++;
        // and never *through* the stock: below its top a travelling rapid is a
        // crash, whatever it saves.
        //
        // Adaptive and pocket are exempt because they have a second, lower
        // plane the others do not: inside a level's allowed region the material
        // has already been taken down to the level above, so they cross at a
        // gap above *that*. Pocket only reaches for it where the whole move
        // stays inside what the level above emptied (`linkFor`), and it started
        // reaching for it here when the ring spacing changed — the claim is
        // stronger than a height and neither of them is taken on trust: both
        // are replayed against the material in engagement.test.js.
        if (type !== 'adaptive' && type !== 'pocket' && m.op === OP.RAPID
          && Math.hypot(m.x - prev.x, m.y - prev.y) > 1e-6) {
          assert.ok(Math.min(m.z, prev.z) > 30,
            `${type} travels at z=${Math.min(m.z, prev.z).toFixed(2)} through 30mm of stock`);
        }
      }
      prev = m;
    }
    // Pocket clears this fixture as one region per level and links inside it,
    // so it has no transition to spend a crossing plane on. Having none and
    // needing none are the same program; going home repeatedly is the failure.
    assert.ok(climbs <= 4, `${type} climbs to clearance ${climbs} times`);
    assert.ok(travelledLow > 0 || climbs <= 1,
      `${type} climbs ${climbs} times and never uses the crossing plane`);
  }
});

// --- adaptive clearing -----------------------------------------------------

const ADAPTIVE_STOCK = { kind: 'box', min: [0, 0, 0], max: [60, 60, 10] };

function adaptiveRun(extra = {}) {
  return generateToolpath({
    type: 'adaptive',
    name: 'rough',
    tool: FLAT,
    mesh: makePocketBlock().mesh,
    stock: ADAPTIVE_STOCK,
    params: {
      clearanceHeight: 25, entryGap: 1, tolerance: 0.05, stockToLeave: 0,
      stepdown: 2, stepover: 3, direction: 'climb', topZ: 10, bottomZ: 4,
    },
    ...extra,
  });
}

test('adaptive crosses below clearance when nothing is in the way', () => {
  const cl = adaptiveRun();

  // Clearance is 25 and the stock is 10 tall, so every link that goes home
  // climbs 15mm and comes back down 15mm — to move, in the measured case, an
  // average of two millimetres sideways.
  let climbs = 0;
  let prev = null;
  for (const m of moves(cl)) {
    if (prev && m.z >= 25 - 1e-6 && prev.z < 25 - 1e-6) climbs++;
    prev = m;
  }
  assert.ok(climbs <= 4, `${climbs} climbs to clearance — the links are going home`);
  assert.ok(rapidDistance(cl) < 4500,
    `${Math.round(rapidDistance(cl))}mm of rapid; it was 6138 when every link went home`);
});

test('and it stays above the part while it does', () => {
  // The claim being tested is the one that makes the saving legitimate. A link
  // below clearance is only allowed where the material it passes over is known
  // to be lower — so replay every rapid against the part's own surface.
  const mesh = makePocketBlock().mesh;
  const map = buildHeightmap(mesh, { cellSize: 0.25, floor: 0 });
  const heightAt = (x, y) => {
    const i = Math.round((x - map.bounds.min[0]) / map.cellSize);
    const j = Math.round((y - map.bounds.min[1]) / map.cellSize);
    if (i < 0 || j < 0 || i >= map.width || j >= map.height) return 0;
    return map.data[j * map.width + i];
  };

  const cl = adaptiveRun();
  let worst = 0;
  let prev = null;
  for (const m of moves(cl)) {
    if (prev && m.op === OP.RAPID) {
      const steps = Math.max(2, Math.ceil(Math.hypot(m.x - prev.x, m.y - prev.y) / 0.5));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = prev.x + (m.x - prev.x) * t;
        const y = prev.y + (m.y - prev.y) * t;
        // the tool is at the lower of the two ends for the whole move, which is
        // the conservative reading of a diagonal rapid
        const z = Math.min(prev.z, m.z);
        worst = Math.max(worst, heightAt(x, y) - z);
      }
    }
    prev = m;
  }
  assert.ok(worst <= 0, `a rapid passes ${worst.toFixed(2)}mm below the part surface`);
});

test('a clamp in the setup sends the links back to clearance', () => {
  // A fixture is a keep-out for the whole column above its footprint, and
  // adaptive is not given enough to route around one. Crossing low is the thing
  // that has to be given up, not the clamp.
  const cl = adaptiveRun({
    fixtures: [{
      kind: 'box', name: 'jaw', min: [0, -10, 0], max: [60, 0, 20],
    }],
  });
  let climbs = 0;
  let prev = null;
  for (const m of moves(cl)) {
    if (prev && m.z >= 25 - 1e-6 && prev.z < 25 - 1e-6) climbs++;
    prev = m;
  }
  assert.ok(climbs > 10, `${climbs} climbs — with a clamp present it must use clearance`);
});

// --- turning ---------------------------------------------------------------

test('a roughing pass rapids up to the cut instead of feeding through air', () => {
  const { mesh } = makeShaft();        // Ø30 stepping down to Ø16
  const stock = {
    kind: 'cylinder', min: [-20, -20, 0], max: [20, 20, 65],
    cylinder: { diameter: 40, height: 65, center: [0, 0] },
  };
  const cl = generateToolpath({
    type: 'turnRough',
    name: 'rough',
    tool: INSERT,
    mesh,
    stock,
    params: {
      topZ: 60, bottomZ: 5, clearanceX: 0, clearanceHeight: 50, entryGap: 1,
      tolerance: 0.05, stockToLeave: 0.5, stepdown: 2,
    },
  });

  // No feed move may travel a long way radially: that is the signature of
  // feeding in from the clearance radius. The most a plunge may cover is the
  // stepdown — the metal this pass is there to take — plus the approach gap.
  //
  // It cannot be less than the stepdown, and that is worth saying because the
  // obvious tighter bound is wrong in a way that reads as an optimisation. At
  // the free end the surface stands where the *previous* pass left it, a full
  // stepdown out, so "rapid to half a millimetre off this pass's radius" puts
  // the rapid's end point inside solid bar. Feeding the step is the cut.
  let prev = null;
  for (const m of moves(cl)) {
    if (prev && m.feed === FEED.PLUNGE) {
      const radial = Math.abs(m.x - prev.x);
      assert.ok(radial < 2 + 0.51,
        `a plunge travels ${radial.toFixed(2)}mm radially — that is air at feed rate`);
    }
    prev = m;
  }
  assert.ok(rapidDistance(cl) > 0, 'and it does still rapid somewhere');
});

test('roughing passes do not go back to the clearance radius between them', () => {
  const { mesh } = makeShaft();
  const stock = {
    kind: 'cylinder', min: [-20, -20, 0], max: [20, 20, 65],
    cylinder: { diameter: 40, height: 65, center: [0, 0] },
  };
  const clearanceX = 30;
  const cl = generateToolpath({
    type: 'turnRough',
    name: 'rough',
    tool: INSERT,
    mesh,
    stock,
    params: {
      topZ: 60, bottomZ: 5, clearanceX, clearanceHeight: 50, entryGap: 1,
      tolerance: 0.05, stockToLeave: 0, stepdown: 2,
    },
  });

  // The tool has to reach the clearance radius twice: once on the way in and
  // once on the way home. Anything in between is a pass paying for the full
  // radial distance out and back for no reason.
  let atClear = 0;
  for (const m of moves(cl)) {
    if (m.x >= clearanceX - 1e-6) atClear++;
  }
  assert.eq(atClear, 2, 'in at the start, out at the end, and never in between');

  // And the return travel stays just off the surface the pass has cut.
  let prev = null;
  let worst = 0;
  for (const m of moves(cl)) {
    if (prev && m.op === OP.RAPID && Math.abs(m.z - prev.z) > 1) {
      worst = Math.max(worst, m.x);
    }
    prev = m;
  }
  assert.ok(worst < 21, `a lengthwise rapid runs at radius ${worst.toFixed(1)} — `
    + 'outside the Ø40 bar, so it went home first');
});

test('threading does not go home between passes', () => {
  const { mesh } = makeShaft();
  const stock = {
    kind: 'cylinder', min: [-20, -20, 0], max: [20, 20, 65],
    cylinder: { diameter: 40, height: 65, center: [0, 0] },
  };
  const threader = {
    number: 8, type: 'threading', name: '16ER', diameter: 6, noseRadius: 0.1,
    bladeWidth: 1.5, flutes: 1, fluteLength: 12, spindleRpm: 400, feedCut: 100,
    feedPlunge: 60,
  };
  const cl = generateToolpath({
    type: 'turnThread', name: 'thread', tool: threader, mesh, stock,
    params: {
      topZ: 60, bottomZ: 45, clearanceX: 0, clearanceHeight: 50, entryGap: 1,
      tolerance: 0.05, threadPitch: 1.5,
    },
  });

  // The clearance radius is the bar plus two — 22 — and the thread is on ⌀16.
  // Fifteen passes that each go home pay 14mm of radial travel twice over,
  // fifteen times, to return to a groove the tool is standing in.
  const clearX = 22;
  let atClear = 0;
  for (const m of moves(cl)) if (m.x >= clearX - 1e-6) atClear++;
  assert.eq(atClear, 2, 'in at the start, out at the end, and never in between');

  assert.ok(rapidDistance(cl) < 400,
    `${Math.round(rapidDistance(cl))}mm of rapid; it was 692 when every pass went home`);

  // and the travel between passes stays clear of the ⌀16 it is cutting
  let prev = null;
  for (const m of moves(cl)) {
    if (prev && m.op === OP.RAPID && Math.abs(m.z - prev.z) > 1) {
      assert.ok(m.x > 8, `a lengthwise rapid at radius ${m.x.toFixed(2)} is inside the thread`);
    }
    prev = m;
  }
});

// --- regions that restrict nothing -----------------------------------------

test('a region nowhere near the work does not change what is cut', () => {
  // A clamp is a region the app adds for you, so *every* setup that holds its
  // part down has one — and a keep-out 500mm away restricts nothing. It still
  // changed five strategies, each by a different mechanism, all of them the
  // same mistake: treating "there is a region somewhere" as "this pass is
  // restricted here".
  //
  //   contour, slot    — applyRegionsToPaths handed every loop back as an open
  //                      span, including the ones it had not touched, so passes
  //                      that ramp round a closed loop started walking it twice
  //   face             — rows were clipped to the stock outline, which took off
  //                      the overrun that carries the cutter off the edge
  //   parallel finish  — the raster's own edge samples sit exactly on the area
  //                      boundary, read as "excluded", so every row began and
  //                      ended with a full retract: 418mm of rapid became 7174
  //
  // Rapids are exempt: a fixture legitimately gives up the crossing plane and
  // sends the links home (see engine/heights.js). What must not move is the
  // cut.
  const part = makePocketBlock({ size: 40, pocketSize: 20, height: 20, depth: 8 });
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] };
  const params = {
    clearanceHeight: 30, entryGap: 1, tolerance: 0.05, stockToLeave: 0,
    stepdown: 2, stepover: 3, direction: 'climb', leadType: 'none',
    rampAngle: 3, topZ: 20, bottomZ: 12,
  };
  // a keep-out half a metre away, already grown by the tool radius the way
  // engine/regions.js grows one
  const faraway = { avoid: [[500, 500, 510, 500, 510, 510, 500, 510]] };

  for (const type of ['face', 'contour2d', 'slot', 'clear2d', 'pocket', 'parallel3d', 'waterline']) {
    const args = { type, name: type, tool: FLAT, mesh: part.mesh, stock, params };
    const plain = generateToolpath(args);
    const withRegion = generateToolpath({ ...args, regions: faraway });
    assert.eq(cutDistance(withRegion).toFixed(3), cutDistance(plain).toFixed(3),
      `${type} cuts a different distance when an irrelevant region is present`);
  }
});

/** How far the tool travels while cutting — the claim that must not move. */
function cutDistance(cl) {
  let total = 0;
  let prev = null;
  for (const m of moves(cl)) {
    if (prev && m.op !== OP.RAPID) {
      total += Math.hypot(m.x - prev.x, m.y - prev.y, m.z - prev.z);
    }
    prev = m;
  }
  return total;
}

/** Two pocketed blocks side by side: the case where "which pocket" is a question. */
function twoPockets() {
  const one = makePocketBlock({ size: 40, pocketSize: 20, height: 10, depth: 6 }).mesh;
  const moved = { indices: one.indices, positions: new Float32Array(one.positions) };
  for (let i = 0; i < moved.positions.length; i += 3) moved.positions[i] += 50;
  return computeNormals(mergeMeshes([one, moved]));
}

const POCKET_PARAMS = {
  topZ: 10, bottomZ: 4, stepdown: 2, clearanceHeight: 20, entryGap: 1,
  stepover: 0.4, tolerance: 0.01, stockToLeave: 0, rampAngle: 0,
  leadType: 'none', leadRadius: 0, finishPasses: 0,
};

function pocketOnTwo() {
  return generateToolpath({
    type: 'pocket', name: 'pocket', tool: FLAT, mesh: twoPockets(),
    stock: { kind: 'box', min: [0, 0, 0], max: [90, 40, 10] },
    params: POCKET_PARAMS,
  });
}

test('pocketing finishes one pocket before it starts the next', () => {
  // The rings were emitted a *ring index* at a time — every pocket's innermost
  // ring, then every pocket's next one out — so the tool crossed between the
  // two on every single step, climbing over the billet each time. Nine changes
  // of pocket to cut six rings.
  const cl = pocketOnTwo();
  let switches = 0;
  let last = null;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.RAPID) return;
    const which = x < 45 ? 'A' : 'B';
    if (last && which !== last) switches++;
    last = which;
  });
  // three depth levels, two pockets: one crossing per level is the floor
  assert.ok(switches <= 3, `crossed between the pockets ${switches} times`);
});

test('and links its own rings inside the pocket instead of over the billet', () => {
  // Every ring transition was a full climb to the crossing plane and back down,
  // for a move of one stepover inside a pocket the tool was already standing in.
  const cl = pocketOnTwo();
  let overTheStock = 0;
  eachMove(cl, (op, x, y, z) => {
    if (op === OP.RAPID && z >= 10 - 1e-9) overTheStock++;
  });
  // the only retracts that have to clear the billet are the ones that actually
  // cross between the pockets, plus arriving and going home
  assert.ok(overTheStock <= 12, `${overTheStock} retracts to the stock top or above`);
});

test('and never rapids up to a feed plane it is already below', () => {
  // The feed plane is measured from the level above, which is right when the
  // tool arrives from clearance and wrong the moment it arrives lower: the
  // pocket linked two rings at Z9 and was then sent to Z11 before plunging to
  // Z8. A hop over nothing, and exactly what the linking was there to remove.
  const cl = pocketOnTwo();
  const d = cl.moves;
  let climbs = 0;
  for (let n = 1; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    const p = (n - 1) * MOVE_STRIDE;
    if (d[o] !== OP.RAPID) continue;
    const sameXY = Math.abs(d[o + 1] - d[p + 1]) < 1e-6 && Math.abs(d[o + 2] - d[p + 2]) < 1e-6;
    // a pure lift followed by a descent to a *lower* place than it started
    if (!sameXY || d[o + 3] <= d[p + 3] + 1e-9) continue;
    const next = (n + 1) * MOVE_STRIDE;
    if (n + 1 < cl.count && d[next + 3] < d[p + 3] - 1e-9) climbs++;
  }
  assert.eq(climbs, 0, 'lifted only to come straight back down past where it was');
});

test('a pocket enters once per pocket per level, not once per ring', () => {
  // Every ring was entered on its own — lift, traverse, ramp a whole stepdown
  // down into the next ring out — which at the machine reads as the tool
  // pecking its way outward. There is nothing to ramp through: two concentric
  // rings are one stepover apart and the tool is already at depth.
  const cl = pocketOnTwo();
  let entries = 0;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.DRILL && feed === FEED.PLUNGE) entries++;
  });
  // two pockets, three depth levels
  assert.eq(entries, 6, 'one descent per pocket per level');
});

test('and asking for a ramp ramps those entries and nothing else', () => {
  const ramped = generateToolpath({
    type: 'pocket', name: 'pocket', tool: FLAT, mesh: twoPockets(),
    stock: { kind: 'box', min: [0, 0, 0], max: [90, 40, 10] },
    params: { ...POCKET_PARAMS, rampAngle: 3 },
  });
  let entries = 0;
  let ramps = 0;
  eachMove(ramped, (op, x, y, z, i, j, k, feed) => {
    if (feed === FEED.PLUNGE) entries++;
    if (feed === FEED.RAMP) ramps++;
  });
  assert.eq(entries, 6, 'still one descent per pocket per level');
  assert.ok(ramps > 0, 'and they ramp');
});

test('a pocket never rapids below the stock top over ground it has not cleared', () => {
  // The link planner it borrowed from waterline answers "how high is the
  // *part* here", which is right for a finishing pass — the roughing has
  // already taken the stock away — and a crash for a roughing one: where the
  // part is absent the stock very often is not. A pocketing pass may only fly
  // low over ground it emptied itself.
  const cl = pocketOnTwo();
  const inPocket = (x, y) => (y > 10 && y < 30)
    && ((x > 10 && x < 30) || (x > 60 && x < 80));
  const d = cl.moves;
  let through = 0;
  for (let n = 1; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    const p = (n - 1) * MOVE_STRIDE;
    if (d[o] !== OP.RAPID) continue;
    for (let t = 0; t <= 1; t += 0.05) {
      const x = d[p + 1] + (d[o + 1] - d[p + 1]) * t;
      const y = d[p + 2] + (d[o + 2] - d[p + 2]) * t;
      const z = d[p + 3] + (d[o + 3] - d[p + 3]) * t;
      if (z < 10 - 1e-6 && !inPocket(x, y)) { through++; break; }
    }
  }
  assert.eq(through, 0, 'rapided through standing stock');
});

// --- the pass that is tangent to the billet --------------------------------

test('roughing does not lap the billet edge where the cutter cannot reach it', () => {
  // The clearable area for a Z-level pass is the stock outline grown by the
  // tool radius, because the cutter is allowed to hang off the edge. Its outer
  // *boundary* is therefore the locus where the cutter touches the billet
  // without entering it: a pass there removes nothing, at cutting feed, once
  // per level — and once more per finish pass. On a 40mm part in a 46mm billet
  // that was 1065mm of the 3162mm cut.
  //
  // The pass one stepover inside it reaches everything it could have, so there
  // is nothing to trade off: the same surface comes out.
  const stock = { kind: 'box', min: [-3, -3, 0], max: [43, 43, 22] };
  const r = FLAT.diameter / 2;
  const tangent = (p) => Math.abs(p[0] - (stock.min[0] - r)) < 0.02
    || Math.abs(p[0] - (stock.max[0] + r)) < 0.02
    || Math.abs(p[1] - (stock.min[1] - r)) < 0.02
    || Math.abs(p[1] - (stock.max[1] + r)) < 0.02;

  for (const finishPasses of [0, 2]) {
    const cl = generateToolpath({
      type: 'clear2d', name: 'rough', tool: FLAT,
      mesh: makePocketBlock({ size: 40, pocketSize: 20, height: 20, depth: 12 }).mesh,
      stock,
      params: {
        topZ: 20, bottomZ: 4, stepdown: 3, stepover: 0.5, clearanceHeight: 40,
        tolerance: 0.05, stockToLeave: 0.5, rampAngle: 3, direction: 'climb',
        leadType: 'none', finishPasses,
      },
    });
    let along = 0;
    let prev = null;
    for (const m of moves(cl)) {
      const p = [m.x, m.y, m.z];
      if (prev && m.feed !== FEED.RAPID && tangent(prev) && tangent(p)) {
        along += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
      }
      prev = p;
    }
    // a corner of the region still touches the locus; a side of it is 46mm
    assert.ok(along < 20, `${along.toFixed(0)}mm of cutting feed ran along the `
      + `billet edge with the cutter tangent to it (finishPasses ${finishPasses})`);
  }
});
