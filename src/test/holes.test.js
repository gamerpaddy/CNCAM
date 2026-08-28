import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { buildGcode } from '../post/index.js';
import { readGcode } from '../engine/backplot.js';
import { MOVE_STRIDE, OP, FEED, eachMove } from '../engine/cl.js';
import { tapDrillDiameter, threadForHole } from '../engine/strategies/holes.js';
import { coarsePitch, suggestCutting } from '../doc/tool-library.js';
import { makeTube, makeBoss, makeBox } from './fixtures.js';

const STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] };
/** A block with a ⌀5 hole through it — what an M6 tapping drill leaves. */
const TAPPED = makeTube(20, 20, 18, 2.5, 20);
/** And a ⌀10 one, for a thread mill to orbit in. */
const BORED = makeTube(20, 20, 18, 5, 20);

const TAP = {
  number: 5, type: 'tap', diameter: 6, pitch: 1, leadThreads: 2,
  flutes: 3, fluteLength: 25, spindleRpm: 350, feedCut: 350, feedPlunge: 350,
};
const MILL = {
  number: 6, type: 'threadmill', diameter: 4, pitch: 1,
  flutes: 3, fluteLength: 20, spindleRpm: 5000, feedCut: 350, feedPlunge: 120,
};
const SPOT = {
  number: 4, type: 'drill', diameter: 10, tipAngle: 90, tipDiameter: 0,
  flutes: 2, fluteLength: 12, spindleRpm: 4000, feedCut: 200, feedPlunge: 200,
};

function run(type, tool, mesh, params = {}) {
  return generateToolpath({
    type,
    name: type,
    tool,
    mesh,
    stock: STOCK,
    params: {
      topZ: 20, bottomZ: 0, clearanceHeight: 30, tolerance: 0.01,
      diameterTol: 0.5, entryGap: 1, ...params,
    },
  });
}

function cutMoves(cl) {
  let n = 0;
  eachMove(cl, (opcode) => { if (opcode !== OP.RAPID) n++; });
  return n;
}

function drillMoves(cl) {
  const out = [];
  eachMove(cl, (opcode, x, y, z, retract) => {
    if (opcode === OP.DRILL) out.push({ x, y, z, retract });
  });
  return out;
}

const notes = (cl) => (cl.notes ?? []).map((n) => n.text).join(' | ');

// --- the tapping drill rule ---

test('the tapping drill is the thread less its pitch', () => {
  assert.close(tapDrillDiameter(6, 1), 5, 1e-9, 'an M6×1 goes in a ⌀5');
  assert.close(tapDrillDiameter(8, 1.25), 6.75, 1e-9, 'an M8×1.25 in a ⌀6.75');
  assert.close(threadForHole(5, 1), 6, 1e-9, 'and back again');
});

test('the coarse pitch is the one on the workshop wall', () => {
  assert.close(coarsePitch(6), 1, 1e-9, 'M6 is 1.0');
  assert.close(coarsePitch(8), 1.25, 1e-9, 'M8 is 1.25');
  assert.close(coarsePitch(3), 0.5, 1e-9, 'M3 is 0.5');
});

test('a tap is fed at its pitch, not at a chip load', () => {
  const s = suggestCutting({ type: 'tap', diameter: 6, pitch: 1 });
  assert.close(s.feedCut, s.spindleRpm * 1, 1, 'one turn, one millimetre');
  assert.eq(s.feedPlunge, s.feedCut, 'and it comes out the same way it went in');
});

// --- tapping ---

test('tapping finds the tapping drill, not the thread', () => {
  const cl = run('tap', TAP, TAPPED);
  const holes = drillMoves(cl);
  assert.eq(holes.length, 1, `one hole tapped: ${notes(cl)}`);
  assert.close(holes[0].x, 20, 0.2, 'in the middle of the block');
});

test('and refuses a hole that is the thread size rather than the drill size', () => {
  const cl = run('tap', { ...TAP, diameter: 10, pitch: 1.5 }, TAPPED);
  assert.eq(drillMoves(cl).length, 0, 'nothing tapped');
  assert.ok(/goes in a/.test(notes(cl)), `and it says what hole to drill: ${notes(cl)}`);
});

test('a tap without a pitch is refused rather than fed at a guess', () => {
  const cl = run('tap', { ...TAP, pitch: 0 }, TAPPED);
  assert.eq(cl.count, 0, 'nothing at all');
  assert.ok(/pitch/.test(notes(cl)), notes(cl));
});

test('the tapping feed is the pitch times the speed', () => {
  const cl = run('tap', TAP, TAPPED);
  const feeds = cl.events.filter((e) => e.type === 'feeds');
  const last = feeds[feeds.length - 1];
  assert.close(last.plunge, 350 * 1, 1e-6, '350 rpm × 1mm');
});

test('tapping switches the mode on and off again', () => {
  const cl = run('tap', TAP, TAPPED);
  const modes = cl.events.filter((e) => e.type === 'tapping');
  assert.eq(modes.length, 2, 'on and off');
  assert.close(modes[0].pitch, 1, 1e-9, 'at the thread pitch');
  assert.eq(modes[1].pitch, 0, 'and off again, so nothing after it is synchronised');
});

test('a blind hole is tapped short of its floor by the tap lead', () => {
  // a pocket 10mm deep with a ⌀5 hole another 6mm into its floor
  const blind = makeTube(20, 20, 18, 2.5, 14);
  const cl = run('tap', TAP, blind, { depthMode: 'hole', bottomZ: 0 });
  const holes = drillMoves(cl);
  assert.eq(holes.length, 1, `one hole: ${notes(cl)}`);
  assert.ok(holes[0].z > 0.5, `stopped short of the floor, at ${holes[0].z}`);
  assert.ok(/lead cuts nothing/.test(notes(cl)), notes(cl));
});

test('LinuxCNC taps with G33.1, and reads back as the same hole', () => {
  const cl = run('tap', TAP, TAPPED);
  const { text } = buildGcode('linuxcnc', [{ name: 'tap', cl }]);
  assert.ok(/G33\.1 Z[-\d.]+ K1/.test(text), `rigid tapping: ${text}`);
  const back = readGcode(text);
  assert.eq(back.parsed.unsupported.length, 0,
    `nothing in it went unread: ${JSON.stringify(back.parsed.unsupported)}`);
  assert.eq(back.parsed.cycles.length, 1, 'one tapped hole came back');
  assert.close(back.parsed.cycles[0].pitch, 1, 1e-9, 'at its pitch');
});

test('a post that cannot rigid tap says so and reverses the spindle instead', () => {
  const cl = run('tap', TAP, TAPPED);
  const { text } = buildGcode('grbl', [{ name: 'tap', cl }]);
  assert.ok(/tension-compression/.test(text), `the warning is in the file: ${text}`);
  assert.ok(/M4/.test(text), 'and the spindle is reversed to come out');
  assert.ok(!/G33/.test(text), 'without pretending to synchronise');
});

// --- thread milling ---

test('a thread mill spirals up the hole at the pitch', () => {
  const cl = run('threadMill', MILL, BORED, { bottomZ: 10 });
  assert.ok(cl.count > 50, `a helix, not a plunge: ${cl.count} moves — ${notes(cl)}`);
  // every cutting point sits on one circle about the hole centre
  const d = cl.moves;
  const radii = [];
  for (let n = 0; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    if (d[o] !== OP.LINE) continue;
    radii.push(Math.hypot(d[o + 1] - 20, d[o + 2] - 20));
  }
  const orbit = Math.max(...radii);
  // ⌀10 hole threaded M11 with a ⌀4 cutter: (11 − 4) / 2
  assert.close(orbit, 3.5, 0.1, 'the cutter centre runs on the thread radius');
});

test('and rises exactly one pitch per turn', () => {
  const cl = run('threadMill', MILL, BORED, { bottomZ: 10 });
  const d = cl.moves;
  const centre = [20, 20];
  let firstAngle = null;
  let firstZ = 0;
  let turns = 0;
  let lastZ = 0;
  let prevAngle = 0;
  for (let n = 0; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    if (d[o] !== OP.LINE) continue;
    const r = Math.hypot(d[o + 1] - centre[0], d[o + 2] - centre[1]);
    if (r < 3.4) continue;                       // the lead in and out
    const a = Math.atan2(d[o + 2] - centre[1], d[o + 1] - centre[0]);
    if (firstAngle === null) { firstAngle = a; firstZ = d[o + 3]; prevAngle = a; }
    let step = a - prevAngle;
    while (step > Math.PI) step -= Math.PI * 2;
    while (step < -Math.PI) step += Math.PI * 2;
    turns += Math.abs(step) / (Math.PI * 2);
    prevAngle = a;
    lastZ = d[o + 3];
  }
  assert.ok(turns > 0.9, `it goes round: ${turns.toFixed(2)} turns`);
  assert.close((lastZ - firstZ) / turns, 1, 0.15,
    `one millimetre of rise per turn, got ${((lastZ - firstZ) / turns).toFixed(3)}`);
});

test('a cutter too big to orbit in the hole is refused, with the reason', () => {
  const cl = run('threadMill', { ...MILL, diameter: 12 }, BORED, { bottomZ: 10 });
  assert.eq(cutMoves(cl), 0, 'nothing cut');
  assert.ok(/too small for a ⌀12 cutter/.test(notes(cl)), notes(cl));
});

test('the post refits the helix into arcs rather than a thousand lines', () => {
  const cl = run('threadMill', MILL, BORED, { bottomZ: 10 });
  const { text } = buildGcode('linuxcnc', [{ name: 'thread', cl }]);
  const arcs = (text.match(/^G[23]\b/gm) ?? []).length;
  const lines = (text.match(/^G1\b/gm) ?? []).length;
  assert.ok(arcs > 0, `helical arcs came out: ${arcs} arcs, ${lines} lines`);
});

// --- spotting ---

test('a spot is as deep as its own cone, not as deep as it was told', () => {
  const cl = run('spot', SPOT, TAPPED, { spotDiameter: 4 });
  const holes = drillMoves(cl);
  assert.eq(holes.length, 1, `one spot: ${notes(cl)}`);
  // a 90° point sunk until it is 4mm across is 2mm deep
  assert.close(20 - holes[0].z, 2, 0.05, 'half the diameter, at 90°');
});

test('and a shallower point makes a deeper spot for the same width', () => {
  const wide = run('spot', { ...SPOT, tipAngle: 60 }, TAPPED, { spotDiameter: 4 });
  const holes = drillMoves(wide);
  // 60° included: depth = 2 / tan(30°) = 3.46
  assert.close(20 - holes[0].z, 3.464, 0.05, 'the tool decides, not the operation');
});

test('asked for nothing, a spot chamfers the hole it is over', () => {
  const cl = run('spot', SPOT, TAPPED, { spotDiameter: 0 });
  const holes = drillMoves(cl);
  assert.close(20 - holes[0].z, 2.5, 0.1, 'the ⌀5 hole, at 90°, is 2.5mm deep');
});

test('a flat cutter cannot spot anything, and says so', () => {
  const cl = run('spot', { ...SPOT, type: 'flat', tipAngle: 0 }, TAPPED);
  assert.eq(cl.count, 0, 'nothing cut');
  assert.ok(/point angle/.test(notes(cl)), notes(cl));
});

test('a spot wider than the cutter is clipped to the cutter, with a warning', () => {
  const cl = run('spot', { ...SPOT, diameter: 3 }, TAPPED, { spotDiameter: 8 });
  const holes = drillMoves(cl);
  assert.close(20 - holes[0].z, 1.5, 0.05, 'as wide as the cutter goes');
  assert.ok(/as wide as it goes/.test(notes(cl)), notes(cl));
});

test('a hole wider than the cutter is not "spotted to the hole diameter"', () => {
  // The sentence promised the second half of the job — the chamfer the hole
  // wants anyway — on a cone a ⌀3 cutter cannot make in a ⌀5 hole.
  const cl = run('spot', { ...SPOT, diameter: 3 }, TAPPED, { spotDiameter: 0 });
  const holes = drillMoves(cl);
  assert.close(20 - holes[0].z, 1.5, 0.05, 'the cone is the cutter, not the hole');
  assert.ok(!/to the hole diameter/.test(notes(cl)),
    `and does not claim otherwise: ${notes(cl)}`);
  assert.ok(/as wide as (it|this cutter) goes/.test(notes(cl)), notes(cl));
});

// --- threading the outside of a boss ---

const BOSS = makeBoss({ diameter: 20, plateHeight: 10, height: 12 });

/** How far from the boss centre each cutting move ran. */
function cutRadii(cl, cx, cy) {
  const out = [];
  eachMove(cl, (opcode, x, y) => {
    if (opcode !== OP.RAPID) out.push(Math.hypot(x - cx, y - cy));
  });
  return out;
}

test('an external thread is milled round a boss, not round a hole', () => {
  // Pointed at holes, the strategy plunged down the middle of each one and fed
  // the cutter sideways out through the wall to orbit *outside* it.
  const cl = run('threadMill', MILL, BOSS.mesh, {
    threadInternal: false, topZ: BOSS.top, bottomZ: BOSS.base,
  });
  assert.ok(cutMoves(cl) > 0, `it cuts something: ${notes(cl)}`);
  assert.ok(/M20/.test(notes(cl)), `a boss is already the major diameter: ${notes(cl)}`);
  const radii = cutRadii(cl, BOSS.cx, BOSS.cy);
  // the cutter's centre runs a cutter radius outside the boss and never inside it
  assert.close(Math.min(...radii), (BOSS.diameter + MILL.diameter) / 2, 0.01,
    'the flank of the cutter forms the thread');
});

test('and it comes down beside the boss rather than into it', () => {
  const cl = run('threadMill', MILL, BOSS.mesh, {
    threadInternal: false, topZ: BOSS.top, bottomZ: BOSS.base,
  });
  // every plunge is in clear air: the whole cutter outside the boss
  let worst = Infinity;
  eachMove(cl, (opcode, x, y, z, a, b, c, feed) => {
    if (opcode === OP.RAPID || feed !== FEED.PLUNGE) return;
    worst = Math.min(worst, Math.hypot(x - BOSS.cx, y - BOSS.cy) - MILL.diameter / 2);
  });
  assert.ok(worst > BOSS.diameter / 2,
    `the plunge clears the ⌀${BOSS.diameter} boss by ${(worst - BOSS.diameter / 2).toFixed(2)}mm`);
});

test('a bar is a boss: its own outside is what an external thread is cut on', () => {
  // BORED is a ⌀36 cylinder with a hole down it. The hole is where an internal
  // thread goes; the ⌀36 outside is where an external one goes, and pointing
  // the pass at the hole for both was the bug.
  const cl = run('threadMill', MILL, BORED, { threadInternal: false, bottomZ: 10 });
  assert.ok(/M36/.test(notes(cl)), `the outside, not the ⌀10 bore: ${notes(cl)}`);
  const radii = cutRadii(cl, 20, 20);
  assert.ok(Math.min(...radii) > 18, `and it stays outside the bar: ${Math.min(...radii).toFixed(2)}`);
});

test('an external pass over a part with no round outside says so, not "no holes"', () => {
  const cl = run('threadMill', MILL, makeBox(40, 40, 20), { threadInternal: false, bottomZ: 10 });
  assert.eq(cutMoves(cl), 0, 'nothing cut');
  assert.ok(/boss/.test(notes(cl)), notes(cl));
});
