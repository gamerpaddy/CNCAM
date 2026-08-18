import { test, assert } from './runner.js';
import {
  simulateRemoval, SimulationPlayback, PlaybackClock, positionAtStep, eventBudget,
} from '../engine/simulate.js';
import { generateToolpath } from '../engine/toolpath.js';
import { CLBuilder, FEED, MOVE_STRIDE } from '../engine/cl.js';
import { clearanceProfile, cuttingRadiusOf } from '../engine/tool-geometry.js';
import { makeMushroom, makeBox, makeStepped } from './fixtures.js';

const FLAT = { number: 1, type: 'flat', diameter: 6, fluteLength: 20, spindleRpm: 10000, feedCut: 800, feedPlunge: 300 };
const BALL = { ...FLAT, type: 'ball' };

const BOX_STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] };

/** A single straight cut across the middle of the stock at depth z. */
function straightCut(z, tool = FLAT) {
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(-10, 20, 15);
  cl.cut(-10, 20, z, FEED.PLUNGE);
  cl.cut(50, 20, z);
  return { cl: cl.finish(), tool };
}

function heightAt(sim, playback, x, y) {
  const i = Math.round((x - sim.origin[0]) / sim.cellSize);
  const j = Math.round((y - sim.origin[1]) / sim.cellSize);
  return playback.current[j * sim.width + i];
}

test('simulation starts as untouched stock', () => {
  const sim = simulateRemoval({ stock: BOX_STOCK, ops: [straightCut(4)] });
  const pb = new SimulationPlayback(sim);
  assert.close(heightAt(sim, pb, 20, 20), 10, 1e-6, 'full height before any cut');
  assert.eq(pb.seconds, 0, 'clock starts at zero');
});

test('a straight cut lowers the stock along its path and nowhere else', () => {
  const sim = simulateRemoval({ stock: BOX_STOCK, ops: [straightCut(4)] });
  const pb = new SimulationPlayback(sim);
  pb.seek(sim.stepCount);

  assert.close(heightAt(sim, pb, 20, 20), 4, 0.2, 'cut down to depth on the path');
  assert.close(heightAt(sim, pb, 20, 35), 10, 1e-6, 'untouched well off the path');
  // the flat cutter is 6mm wide, so material survives just past 3mm out
  assert.close(heightAt(sim, pb, 20, 24.5), 10, 1e-6, 'outside the cutter width');
});

test('a ball nose leaves a rounded groove, a flat one leaves a flat floor', () => {
  const ballSim = simulateRemoval({ stock: BOX_STOCK, ops: [straightCut(4, BALL)] });
  const ballPb = new SimulationPlayback(ballSim);
  ballPb.seek(ballSim.stepCount);
  const flatSim = simulateRemoval({ stock: BOX_STOCK, ops: [straightCut(4, FLAT)] });
  const flatPb = new SimulationPlayback(flatSim);
  flatPb.seek(flatSim.stepCount);

  // on centre both reach the same depth
  assert.close(heightAt(ballSim, ballPb, 20, 20), 4, 0.2, 'ball centre depth');
  assert.close(heightAt(flatSim, flatPb, 20, 20), 4, 0.2, 'flat centre depth');
  // 2mm off centre the ball has risen, the flat has not
  const ballEdge = heightAt(ballSim, ballPb, 20, 22);
  const flatEdge = heightAt(flatSim, flatPb, 20, 22);
  assert.ok(ballEdge > flatEdge + 0.3, `ball ${ballEdge} should sit above flat ${flatEdge}`);
});

test('rapids above the stock cut nothing', () => {
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(0, 0, 25);
  cl.rapid(40, 40, 25);
  const sim = simulateRemoval({ stock: BOX_STOCK, ops: [{ cl: cl.finish(), tool: FLAT }] });
  assert.eq(sim.eventCount, 0, 'no material removed');
});

test('a plunge below the surface does cut, even as a rapid', () => {
  // a rapid driven into the material is a crash, and the point of watching the
  // simulation is that it shows up rather than being silently skipped
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(20, 20, 15);
  cl.rapid(20, 20, 2);
  const sim = simulateRemoval({ stock: BOX_STOCK, ops: [{ cl: cl.finish(), tool: FLAT }] });
  const pb = new SimulationPlayback(sim);
  pb.seek(sim.stepCount);
  assert.ok(sim.eventCount > 0, 'the plunge removed material');
  assert.close(heightAt(sim, pb, 20, 20), 2, 0.2, 'down to the rapid depth');
});

// --- the point of the event log: seeking backwards ---

test('seeking back to the start restores the original stock exactly', () => {
  const sim = simulateRemoval({ stock: BOX_STOCK, ops: [straightCut(4)] });
  const pb = new SimulationPlayback(sim);
  pb.seek(sim.stepCount);
  pb.seek(0);
  for (let k = 0; k < sim.initial.length; k++) {
    if (pb.current[k] !== sim.initial[k]) {
      throw new Error(`cell ${k}: ${pb.current[k]} !== ${sim.initial[k]}`);
    }
  }
  assert.eq(pb.seconds, 0, 'clock rewinds too');
});

test('scrubbing to a step gives the same surface however you got there', () => {
  const { mesh } = makeMushroom();
  const cl = generateToolpath({
    type: 'clear2d', name: 'rough', tool: FLAT, mesh,
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 15] },
    params: {
      topZ: 15, bottomZ: 0, stepdown: 3, stepover: 0.5, clearanceHeight: 25,
      stockToLeave: 0, rampAngle: 0, tolerance: 0.05, leadType: 'none',
    },
  });
  const sim = simulateRemoval({ stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 15] }, ops: [{ cl, tool: FLAT }] });
  const mid = Math.floor(sim.stepCount / 2);

  const forward = new SimulationPlayback(sim);
  forward.seek(mid);

  const backward = new SimulationPlayback(sim);
  backward.seek(sim.stepCount);   // run to the end
  backward.seek(mid);             // then rewind to the same place

  const jumpy = new SimulationPlayback(sim);
  for (const s of [10, sim.stepCount, 3, mid + 40, 0, mid]) jumpy.seek(s);

  for (let k = 0; k < forward.current.length; k++) {
    if (backward.current[k] !== forward.current[k]) {
      throw new Error(`rewind mismatch at ${k}: ${backward.current[k]} vs ${forward.current[k]}`);
    }
    if (jumpy.current[k] !== forward.current[k]) {
      throw new Error(`scrub mismatch at ${k}: ${jumpy.current[k]} vs ${forward.current[k]}`);
    }
  }
  assert.close(backward.seconds, forward.seconds, 1e-9, 'clocks agree');
});

test('the surface only ever goes down as the playhead advances', () => {
  const sim = simulateRemoval({ stock: BOX_STOCK, ops: [straightCut(6), straightCut(2)] });
  const pb = new SimulationPlayback(sim);
  let previous = pb.current.slice();
  for (let s = 0; s <= sim.stepCount; s += 2) {
    pb.seek(s);
    for (let k = 0; k < pb.current.length; k++) {
      if (pb.current[k] > previous[k] + 1e-9) {
        throw new Error(`cell ${k} rose from ${previous[k]} to ${pb.current[k]} at step ${s}`);
      }
    }
    previous = pb.current.slice();
  }
});

// --- timeline metadata ---

test('elapsed time is monotonic and ends at the total', () => {
  const sim = simulateRemoval({ stock: BOX_STOCK, ops: [straightCut(4)] });
  for (let i = 1; i < sim.times.length; i++) {
    assert.ok(sim.times[i] >= sim.times[i - 1], `time went backwards at ${i}`);
  }
  assert.close(sim.times[sim.times.length - 1], sim.totalSeconds, 1e-6);
  assert.ok(sim.totalSeconds > 0, 'the cut takes some time');
});

test('round stock masks out the corners', () => {
  const stock = {
    kind: 'cylinder', min: [-20, -20, 0], max: [20, 20, 10],
    cylinder: { diameter: 40, height: 10, center: [0, 0], baseZ: 0 },
  };
  const sim = simulateRemoval({ stock, ops: [straightCut(4)] });
  const at = (x, y) => sim.mask[
    Math.round((y - sim.origin[1]) / sim.cellSize) * sim.width
    + Math.round((x - sim.origin[0]) / sim.cellSize)];
  assert.eq(at(0, 0), 1, 'centre is stock');
  assert.eq(at(19, 0), 1, 'inside the rim is stock');
  assert.eq(at(19, 19), 0, 'the corner is not');
});

// --- playback clock ---

test('playback advances through a step that lasts longer than a frame', () => {
  // the regression this guards: a single plunge can take seconds, so several
  // hundred frames land inside one step. Deriving the clock from the current
  // step snaps it back to that step's start every frame and playback freezes.
  const times = new Float32Array([0, 0, 3.1, 3.2, 9.0, 9.1]);
  const clock = new PlaybackClock(times, times.length - 1);

  let step = clock.toStep(0);
  assert.eq(step, 0, 'starts at the first step');

  const frame = 1 / 60;
  const seen = [];
  for (let i = 0; i < 60 * 12 && !clock.finished; i++) {
    seen.push(clock.advance(frame));
  }
  assert.ok(clock.seconds > 3.1, `clock got past the long step, reached ${clock.seconds}`);
  assert.ok(Math.max(...seen) >= times.length - 2, 'reached the far end');
  // and it must never go backwards on its own
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] >= seen[i - 1], `step went backwards at frame ${i}`);
  }
});

test('the clock maps seconds to the step in progress at that moment', () => {
  const times = new Float32Array([0, 1, 5, 6]);
  const clock = new PlaybackClock(times, 3);
  assert.eq(clock.stepAt(0), 0);
  assert.eq(clock.stepAt(0.5), 0, 'still inside the first step');
  assert.eq(clock.stepAt(1), 1, 'on the boundary the next step has begun');
  assert.eq(clock.stepAt(4.9), 1, 'still inside the long step');
  assert.eq(clock.stepAt(5.1), 2);
  assert.eq(clock.stepAt(99), 3, 'clamps at the end');
});

test('the clock rewinds correctly after being scrubbed backwards', () => {
  const times = new Float32Array([0, 1, 5, 6]);
  const clock = new PlaybackClock(times, 3);
  clock.advance(5.5);
  assert.eq(clock.stepAt(clock.seconds), 2, 'ran forward');
  clock.toStep(0);
  assert.eq(clock.seconds, 0, 'scrubbing back resets the clock');
  assert.eq(clock.stepAt(0.5), 0, 'and the cursor searches from the start again');
});

test('positionAtStep walks the program and clamps past the end', () => {
  // Read off the record rather than counted out of the program: a long move is
  // walked in pieces now, so a step is not a CL move and never was going to
  // stay one. See the note on positionAtStep.
  const ops = [straightCut(4), straightCut(2)];
  const sim = simulateRemoval({ stock: BOX_STOCK, ops });
  const first = positionAtStep(sim, ops, 0);
  assert.close(first.position[0], -10, 1e-6, 'starts at the first move');

  const inSecond = positionAtStep(sim, ops, sim.opEnds[0] + 1);
  assert.ok(inSecond, 'walks into the second operation');
  assert.eq(inSecond.tool, ops[1].tool, 'and holds the second cutter');

  const past = positionAtStep(sim, ops, 99999);
  assert.close(past.position[0], 50, 1e-6, 'clamps to the last move');
});

test('the metal comes off under the cutter, not all at the end of the move', () => {
  // One step per CL move meant a whole swath vanished the instant the playhead
  // reached it, while the tool was still drawn travelling the first millimetre
  // of it: a 60mm cut disappeared in one frame and the cutter then flew over
  // bare stock.
  const ops = [straightCut(4)];
  const sim = simulateRemoval({ stock: BOX_STOCK, ops });
  const pb = new SimulationPlayback(sim);

  // half way through the program by time, and the far end must still be there
  pb.seek(Math.floor(sim.stepCount / 2));
  const tool = positionAtStep(sim, ops, Math.floor(sim.stepCount / 2));
  // 38 is inside the billet (0..40) and well past where the tool has reached
  assert.ok(tool.position[0] < 30, 'the cutter has not reached the far end yet');
  assert.close(heightAt(sim, pb, 38, 20), 10, 1e-6,
    'and the stock in front of it is untouched');
  assert.ok(heightAt(sim, pb, 0, 20) < 10, 'while what it has passed over is cut');

  pb.seek(sim.stepCount);
  assert.close(heightAt(sim, pb, 38, 20), 4, 1e-6, 'and by the end it is all cut');
});

// --- the shape the cutter actually sweeps ------------------------------------
//
// There is an answer to "what does this move leave behind" that owes nothing to
// how the sweep is written: walk the move in a thousand pieces and drop the tool
// at each one. It is far too slow to simulate with and exactly right, which
// makes it the thing to check against.
//
// The sweep used to be sampled at the two ends of a move and the closest
// approach, and on a level cut those are the right three points — which is why
// roughing looked correct and this went unnoticed. On a ramp they are not: a
// cell is deepest at the last instant it is still under the descending cutter,
// and that instant is in the middle of the move, so nothing evaluated it. A 15°
// ramp came out 0.8mm shallow and a plunging ball nose 2.4mm.

/** The lowest the tool's surface ever gets above (x, y), by brute force. */
function envelopeAt(ops, x, y, pieces = 2000) {
  let lowest = Infinity;
  for (const { cl, tool } of ops) {
    const profile = clearanceProfile(tool);
    const radius = cuttingRadiusOf(tool);
    const d = cl.moves;
    let prev = null;
    for (let n = 0; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      const p = [d[o + 1], d[o + 2], d[o + 3]];
      if (!prev) { prev = p; continue; }
      for (let s = 0; s <= pieces; s++) {
        const t = s / pieces;
        const dist = Math.hypot(
          prev[0] + (p[0] - prev[0]) * t - x,
          prev[1] + (p[1] - prev[1]) * t - y);
        if (dist > radius) continue;
        const z = prev[2] + (p[2] - prev[2]) * t + profile(dist);
        if (z < lowest) lowest = z;
      }
      prev = p;
    }
  }
  return lowest;
}

/** Where a cell centre really is, so the envelope is asked about that point. */
function cellCentre(sim, x, y) {
  return [
    sim.origin[0] + Math.round((x - sim.origin[0]) / sim.cellSize) * sim.cellSize,
    sim.origin[1] + Math.round((y - sim.origin[1]) / sim.cellSize) * sim.cellSize,
  ];
}

test('the floor a ramping cutter leaves is the shape it really sweeps', () => {
  const BULL = { ...FLAT, type: 'bull', cornerRadius: 1 };
  const VBIT = { ...FLAT, type: 'chamfer', diameter: 10, tipAngle: 90 };
  for (const tool of [FLAT, BALL, BULL, VBIT]) {
    const cl = new CLBuilder();
    cl.event('feeds', { cut: 600, plunge: 200 });
    cl.rapid(5, 20, 12);
    cl.cut(35, 20, 3, FEED.RAMP);      // 30mm along, 9mm down
    const ops = [{ cl: cl.finish(), tool }];
    const sim = simulateRemoval({ stock: BOX_STOCK, ops, maxCells: 40_000 });
    const pb = new SimulationPlayback(sim);
    pb.seek(sim.stepCount);

    for (const x of [16, 20, 24, 28, 32]) {
      const [cx, cy] = cellCentre(sim, x, 20);
      const want = envelopeAt(ops, cx, cy);
      const got = heightAt(sim, pb, x, 20);
      assert.close(got, want, 0.02,
        `${tool.type} at x=${x}: simulated ${got.toFixed(3)}, swept ${want.toFixed(3)}`);
    }
  }
});

test('and so is the one a ball nose leaves plunging into the metal', () => {
  // The steepest case: 8mm down over 10mm along. The deepest moment for a cell
  // on the centreline is nowhere near either end of the move.
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(5, 20, 12);
  cl.cut(15, 20, 2, FEED.RAMP);
  cl.cut(32, 20, 2);
  const ops = [{ cl: cl.finish(), tool: BALL }];
  const sim = simulateRemoval({ stock: BOX_STOCK, ops, maxCells: 40_000 });
  const pb = new SimulationPlayback(sim);
  pb.seek(sim.stepCount);

  for (const x of [9, 11, 13, 15]) {
    const [cx, cy] = cellCentre(sim, x, 20);
    const want = envelopeAt(ops, cx, cy);
    const got = heightAt(sim, pb, x, 20);
    assert.close(got, want, 0.02,
      `at x=${x}: simulated ${got.toFixed(3)}, swept ${want.toFixed(3)}`);
  }
});

test('a machined floor has no raw stock left standing in it', () => {
  // A path running exactly one cutter radius from a line of cells is tangent to
  // the sweep, and axis-aligned toolpaths on an axis-aligned grid make rows of
  // them. Deciding tangency on the sign of a quantity that is exactly zero
  // there resolves it differently from one cell to the next, which speckles a
  // finished floor with single cells of untouched billet.
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(-5, 8, 12);
  for (let y = 8; y <= 32; y += 4) {
    cl.cut(-5, y, 8, FEED.PLUNGE);
    cl.cut(45, y, 8);
    cl.rapid(45, y + 4, 8);
    cl.rapid(-5, y + 4, 8);
  }
  const sim = simulateRemoval({
    stock: BOX_STOCK, ops: [{ cl: cl.finish(), tool: FLAT }], maxCells: 40_000,
  });
  const pb = new SimulationPlayback(sim);
  pb.seek(sim.stepCount);
  const isCut = (i, j) => pb.current[j * sim.width + i] < sim.stockTop - 1e-6;

  let stranded = 0;
  for (let j = 1; j < sim.height - 1; j++) {
    for (let i = 1; i < sim.width - 1; i++) {
      if (isCut(i, j)) continue;
      if (isCut(i - 1, j) && isCut(i + 1, j)) stranded++;
      else if (isCut(i, j - 1) && isCut(i, j + 1)) stranded++;
    }
  }
  assert.eq(stranded, 0, `${stranded} cells of raw stock left inside the cut`);
});

test('simulating a real program on the mushroom leaves the part standing', () => {
  const { mesh, cap, postHeight, capHeight } = makeMushroom();
  const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, postHeight + capHeight] };
  const cl = generateToolpath({
    type: 'clear2d', name: 'rough', tool: FLAT, mesh, stock,
    params: {
      topZ: postHeight + capHeight, bottomZ: 0, stepdown: 3, stepover: 0.5,
      clearanceHeight: 25, stockToLeave: 0, rampAngle: 0, tolerance: 0.05, leadType: 'none',
    },
  });
  const sim = simulateRemoval({ stock, ops: [{ cl, tool: FLAT }] });
  const pb = new SimulationPlayback(sim);
  pb.seek(sim.stepCount);

  // over the cap the stock must still be full height — the roughing pass is
  // not allowed to have touched the part
  assert.close(heightAt(sim, pb, 20, 20), 15, 0.01, 'part left intact');
  // out in the corner, well clear of the cap, stock should be gone
  assert.ok(heightAt(sim, pb, 1.5, 1.5) < 1, 'corner cleared to the bottom');
  assert.ok(sim.eventCount > 100, 'plenty of material actually removed');
});

// --- the detail setting must not decide how much of the program runs ---
//
// The turning simulation used to size its sub-steps purely off the sample
// spacing, so raising the detail multiplied the step count for exactly the same
// program — and past the ceiling the run stopped, leaving the last part of the
// toolpath looking as though it cut nothing. Detail says how finely the *bar*
// is sampled. It has nothing to say about how many frames the program takes.

import { simulateTurning, spinAngle, opSpindleRpm, SPIN_RATIO } from '../engine/simulate.js';

/** A long facing-and-turning program, as one op. */
function longTurningProgram() {
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 120, plunge: 80 });
  cl.spindle(900, 'cw');
  cl.rapid(25, 0, 60);
  for (let r = 19; r > 5; r -= 0.5) {
    cl.rapid(r + 0.5, 0, 60);
    cl.cut(r, 0, 60, FEED.PLUNGE);
    cl.cut(r, 0, 5);
    cl.rapid(25, 0, 5);
    cl.rapid(25, 0, 60);
  }
  return { cl: cl.finish(), tool: { type: 'turning', noseRadius: 0.4, diameter: 12 } };
}

test('turning detail changes the surface, not how much of the program is simulated', () => {
  const bar = { radius: 20, innerRadius: 0, zMin: 0, zMax: 65 };
  const ops = [longTurningProgram()];
  const coarse = simulateTurning({ bar, ops, samples: 400 });
  const fine = simulateTurning({ bar, ops, samples: 3200 });

  assert.eq(fine.count, 3200, 'the fine run really is finer');
  // The contract is not that the two are walked in the same number of pieces —
  // a coarser bar honestly needs fewer — but that neither runs out of record
  // and both reach the end of the program. Raising the detail used to multiply
  // the step count without bound, and the ceiling then cut the run short.
  assert.ok(!coarse.truncated && !fine.truncated, 'neither run ran out of record');
  assert.close(fine.totalSeconds, coarse.totalSeconds, 1e-3,
    'both simulated the whole program');
  assert.ok(fine.stepCount <= 200_000,
    `the finest run is still bounded (${fine.stepCount} steps)`);
  assert.ok(fine.stepCount >= coarse.stepCount, 'and finer is not coarser');
});

// --- the spindle, on screen ---

test('the picture of the spindle runs at a hundredth of the programmed speed', () => {
  // one turn of the picture per hundred of the machine
  const oneTurn = 60 / (1200 * SPIN_RATIO);
  assert.close(spinAngle(oneTurn, 1200), 0, 1e-6, 'a whole turn wraps to zero');
  assert.close(spinAngle(oneTurn / 4, 1200), Math.PI / 2, 1e-6);
  // proportional, so a threading pass really does look slower than roughing
  assert.close(spinAngle(1, 1200) / spinAngle(1, 400), 3, 1e-6);
  assert.eq(spinAngle(5, 0), 0, 'a stopped spindle does not turn');
});

test('the spin speed is read off the program, not off the tool', () => {
  const cl = new CLBuilder();
  cl.spindle(350, 'cw');
  cl.rapid(0, 0, 0);
  assert.eq(opSpindleRpm({ cl: cl.finish() }), 350);
  assert.eq(opSpindleRpm({ cl: new CLBuilder().finish() }), 0, 'and is 0 when nothing said');
});


// "Simulated, but the program outran the record." The limit that message is
// about used to be a constant, so the only advice the message could give was to
// coarsen the picture or simulate half the job. It is a preference now.
test('the recording limit scales the budget the message is about', () => {
  const grid = 120_000;
  const standard = eventBudget(grid);
  assert.ok(standard > 0, 'a budget exists at all');
  assert.eq(eventBudget(grid, 2), standard * 2, 'twice the limit is twice the record');
  assert.eq(eventBudget(grid, 8), standard * 8);
  // and it stays a limit: an unset, absurd or hostile value cannot uncap it
  assert.eq(eventBudget(grid, undefined), standard, 'no setting is the standard one');
  assert.eq(eventBudget(grid, 1000), standard * 8, 'capped at the largest offered');
  assert.eq(eventBudget(grid, 0), standard, 'and never below it');
  assert.eq(eventBudget(grid, 'nonsense'), standard);

  // The budget still follows the grid, which is why it is a multiplier and not
  // a number of events: a finer grid records more events for the same program,
  // and a fixed ceiling is what made raising the detail stop a run halfway.
  assert.ok(eventBudget(400_000) >= eventBudget(15_000), 'a finer grid gets more room');
});

test('a tube simulates as a ring, not as a square block', () => {
  // buildMask asked `kind === 'cylinder'`, so tube stock — which is round stock
  // too — got no mask at all: a piece of pipe came up as a rectangular billet,
  // with no bore and not even round.
  const stock = {
    kind: 'tube',
    min: [-50, -50, -25],
    max: [50, 50, 0],
    cylinder: {
      diameter: 100, innerDiameter: 40, height: 25, center: [0, 0], baseZ: -25,
    },
  };
  const sim = simulateRemoval({ stock, ops: [straightCut(-1)], maxCells: 20000 });
  let on = 0;
  for (let i = 0; i < sim.mask.length; i++) on += sim.mask[i];
  const fraction = on / (sim.width * sim.height);
  const ring = (Math.PI * (50 * 50 - 20 * 20)) / (100 * 100);
  assert.close(fraction, ring, 0.02, `masked ${(fraction * 100).toFixed(1)}% of the grid`);

  // and solid bar still masks to a disc
  const bar = { ...stock, kind: 'cylinder', cylinder: { ...stock.cylinder, innerDiameter: 0 } };
  const barSim = simulateRemoval({ stock: bar, ops: [straightCut(-1)], maxCells: 20000 });
  let barOn = 0;
  for (let i = 0; i < barSim.mask.length; i++) barOn += barSim.mask[i];
  assert.close(barOn / (barSim.width * barSim.height), Math.PI / 4, 0.02);
});

// --- what the cut asked of the cutter --------------------------------------
//
// The simulation's answer used to be a shape and nothing else, and a shape
// cannot show the load: a pass that takes a tenth of a millimetre and one that
// takes the whole diameter leave the same floor behind, and only one of them
// arrives at the machine in one piece. These are the numbers that separate
// them, taken off the same sweep that carves the billet.
//
// Calibrated against cases whose answer is arithmetic rather than another
// measurement — a slot is full width because a slot is the cutter's own width,
// and a facing pass is its stepover because that is what a stepover is.

test('the simulation says how wide a bite each cut takes', () => {
  const mesh = makeBox(60, 60, 10);
  const stock = { kind: 'box', min: [0, 0, 0], max: [60, 60, 11] };
  const facing = (stepover) => simulateRemoval({
    stock,
    maxCells: 400_000,
    ops: [{
      tool: FLAT,
      cl: generateToolpath({
        type: 'face',
        name: 'f',
        tool: FLAT,
        mesh,
        stock,
        params: {
          topZ: 11, bottomZ: 10, stepdown: 1, stepover, clearanceHeight: 20,
          tolerance: 0.01, stockToLeave: 0, pattern: 'zigzag',
        },
      }),
    }],
  }).load;

  // The first row of any facing pass is full width — there is nothing cleared
  // beside it yet — so the peak says the same thing whatever the stepover is.
  // What follows the setting is how *far* the cutter runs buried.
  const light = facing(0.4);
  const heavy = facing(0.8);
  assert.ok(light.buried / light.cutting < 0.1,
    `at a 0.4xD stepover ${(100 * light.buried / light.cutting).toFixed(0)}% of the `
    + 'cut is taken past three quarters of the width');
  assert.ok(heavy.buried / heavy.cutting > 0.5,
    `at 0.8xD it is only ${(100 * heavy.buried / heavy.cutting).toFixed(0)}%`);
});

test('and it is the cut it measures, not the entry', () => {
  // A slot is full width by definition: the cutter's own width is the slot.
  const { mesh, height } = makeStepped();
  const stock = { kind: 'box', min: [-2, -2, 0], max: [42, 42, height + 2] };
  const slot = simulateRemoval({
    stock,
    maxCells: 400_000,
    ops: [{
      tool: FLAT,
      cl: generateToolpath({
        type: 'slot',
        name: 's',
        tool: FLAT,
        mesh,
        stock,
        params: {
          topZ: height + 2, bottomZ: 0, stepdown: 1.5, stepover: 0.4, slotWidth: 0,
          clearanceHeight: height + 12, entryGap: 1, tolerance: 0.01,
          stockToLeave: 0, rampAngle: 3, direction: 'climb',
        },
      }),
    }],
  }).load;
  assert.ok(slot.buried / slot.cutting > 0.8,
    `a slot runs buried, and this one reads ${(100 * slot.buried / slot.cutting).toFixed(0)}%`);

  // Clearing a boss out of oversize stock at half the diameter is the same
  // cutter and the same billet, and almost none of it is buried — which is the
  // whole of what a stepover buys. Cutting the rings innermost first read 684mm
  // of this at more than three quarters of the width; see engagement.test.js.
  const boss = simulateRemoval({
    stock: { kind: 'box', min: [-20, -20, 0], max: [40, 40, 10] },
    maxCells: 400_000,
    ops: [{
      tool: FLAT,
      cl: generateToolpath({
        type: 'clear2d',
        name: 'c',
        tool: FLAT,
        mesh: makeBox(20, 20, 10),
        stock: { min: [-20, -20, 0], max: [40, 40, 10] },
        params: {
          topZ: 10, bottomZ: 0, stepdown: 3, stepover: 0.5, clearanceHeight: 20,
          entryGap: 1, tolerance: 0.01, stockToLeave: 0, rampAngle: 3,
          direction: 'climb', leadType: 'none',
        },
      }),
    }],
  }).load;
  assert.ok(boss.buried / boss.cutting < 0.02,
    `${boss.buried.toFixed(0)}mm of ${(boss.cutting / 1000).toFixed(1)}m buried on a `
    + '0.5xD pass');
  assert.ok(boss.peakWidth < 0.8, `and no moment at ${boss.peakWidth.toFixed(2)}xD`);
});
