import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { buildGcode } from '../post/index.js';
import { readGcode, tapCutFinding } from '../engine/backplot.js';
import { simulateRemoval } from '../engine/simulate.js';
import { MOVE_STRIDE, OP, FEED, eachMove } from '../engine/cl.js';
import { tapDrillDiameter, threadForHole } from '../engine/strategies/holes.js';
import { orderHoles } from '../engine/strategies/drill.js';
import { coarsePitch, suggestCutting } from '../doc/tool-library.js';
import { makeTube, makeBoss, makeBox, makeRevolved } from './fixtures.js';

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

// The whole ISO 261 coarse series, because the table used to stop at M24 — and
// stopping is not the same as ending. The nearest-row rule then handed every
// larger size 3.0, so the wizard built an M30 tap as M30×3.0 where the standard
// is 3.5, and an M48 as ×3.0 where it is 5.0. The number goes on to set the
// tapping drill and the feed, so nobody finds out until the tap is in the hole.
test('and it is the one on the wall all the way up the series', () => {
  const iso = [
    [1.6, 0.35], [2, 0.4], [2.5, 0.45], [3, 0.5], [3.5, 0.6], [4, 0.7], [5, 0.8],
    [6, 1], [8, 1.25], [10, 1.5], [12, 1.75], [14, 2], [16, 2], [18, 2.5],
    [20, 2.5], [22, 2.5], [24, 3], [27, 3], [30, 3.5], [33, 3.5], [36, 4],
    [39, 4], [42, 4.5], [45, 4.5], [48, 5],
  ];
  for (const [diameter, pitch] of iso) {
    assert.close(coarsePitch(diameter), pitch, 1e-9, `M${diameter} is ${pitch}`);
  }
  // a size that is not in the series takes the pitch of the one beside it,
  // which is also what the standard says for M7 and M9
  assert.close(coarsePitch(7), 1, 1e-9, 'M7 is 1.0, like the M6 beside it');
  assert.close(coarsePitch(9), 1.25, 1e-9, 'M9 is 1.25');
  // and the drill that follows from it
  assert.close(tapDrillDiameter(30, coarsePitch(30)), 26.5, 1e-9,
    'an M30 coarse goes in a ⌀26.5, not the ⌀27 a 3mm pitch asks for');
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
  // a ⌀5 hole 12mm deep in a block 20 tall: its floor is at Z8
  const blind = makeRevolved([[0, 8], [2.5, 8], [2.5, 20], [18, 20], [18, 0], [0, 0]], 24);
  const stock = { kind: 'box', min: [-20, -20, 0], max: [20, 20, 20] };
  for (const depthMode of ['hole', 'bottomZ']) {
    const cl = generateToolpath({
      type: 'tap', name: 'tap', tool: TAP, mesh: blind, stock,
      params: {
        topZ: 20, bottomZ: 0, clearanceHeight: 30, tolerance: 0.01,
        diameterTol: 0.5, entryGap: 1, depthMode,
      },
    });
    const holes = drillMoves(cl);
    assert.eq(holes.length, 1, `one hole: ${notes(cl)}`);
    // a lead of two threads at 1mm: the tap stops 2mm over the floor — and does
    // so whatever Bottom Z says, which here is 8mm under the floor of the hole
    assert.close(holes[0].z, 10, 0.02, `${depthMode}: stopped short of the floor, at ${holes[0].z}`);
    assert.ok(/lead cuts nothing/.test(notes(cl)), notes(cl));
  }
});

test('a through hole is tapped on past the underside, by the lead', () => {
  // The test for "blind" used to be "reaches Bottom Z", which every through hole
  // does as well — so a tap in a plate stopped two millimetres short of the
  // underside and the last two threads were never cut.
  const cl = run('tap', TAP, TAPPED, { bottomZ: 0 });
  const holes = drillMoves(cl);
  assert.eq(holes.length, 1, `one hole: ${notes(cl)}`);
  assert.close(holes[0].z, -2, 0.02, `the lead comes out of the underside: Z${holes[0].z}`);
  assert.ok(/past the underside/.test(notes(cl)), notes(cl));
  // and a hole that goes on below Bottom Z is not the end of a hole: the tap
  // takes the depth it was given
  const shallow = run('tap', TAP, TAPPED, { bottomZ: 8 });
  assert.close(drillMoves(shallow)[0].z, 8, 0.02, 'a depth limit inside a through hole is a depth');
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

test('a thread deeper than the flutes rubs the shank on the wall, and says so', () => {
  // The helix carries the whole cutter out to the thread radius. Above the
  // flutes that is the shank, which cuts nothing: a ⌀4 shank on a 3.5mm orbit
  // reaches 5.5mm from the axis, in a hole 5mm in radius that the thread has
  // not been cut out of. It rubbed the wall the whole way up with no word said.
  const short = { ...MILL, fluteLength: 6 };
  const cl = run('threadMill', short, BORED, { bottomZ: 10 });
  assert.ok(cutMoves(cl) > 0, 'the thread is still cut - it is a warning, not a refusal');
  assert.ok(/deeper than the cutter's 6mm of flute/.test(notes(cl)), notes(cl));
  assert.ok(/shank rubs the wall/.test(notes(cl)), notes(cl));
  // and when the flutes reach the bottom of the hole there is nothing to say
  const reaching = run('threadMill', { ...MILL, fluteLength: 10 }, BORED, { bottomZ: 10 });
  assert.ok(!/flute/.test(notes(reaching)), `silent when they do: ${notes(reaching)}`);
  // ...however deep the hole goes past a cutter that does not reach it
  assert.ok(/deeper than the cutter's 6mm of flute/.test(notes(run('threadMill', short, BORED, { bottomZ: 0 }))),
    'through the whole block');
});

test('a cutter with a neck goes down a deep thread without touching the wall', () => {
  // orbit 3.5 + a neck of radius 1 = 4.5, inside the hole's 5mm - and a neck
  // of radius 1.7 is 5.2, which is not
  const necked = { ...MILL, fluteLength: 6, shank: [{ diameter: 2, length: 30 }] };
  assert.ok(!/flute/.test(notes(run('threadMill', necked, BORED, { bottomZ: 10 }))),
    'a slim neck has room');
  const fat = { ...MILL, fluteLength: 6, shank: [{ diameter: 3.4, length: 30 }] };
  assert.ok(/shank rubs the wall/.test(notes(run('threadMill', fat, BORED, { bottomZ: 10 }))),
    'a neck that is too wide again does not');
  // the widest part of the tool over the stretch counts, not either end of it
  const stepped = { ...MILL, fluteLength: 6, shank: [{ diameter: 2, length: 2 }, { diameter: 3.4, length: 30 }] };
  assert.ok(/shank rubs the wall/.test(notes(run('threadMill', stepped, BORED, { bottomZ: 10 }))),
    'a shoulder in the middle of the hole is the widest point');
});

test('an external thread has no shank in the way above the flutes', () => {
  // the cutter is outside the boss, and so is everything above it
  const cl = run('threadMill', { ...MILL, fluteLength: 3 }, BOSS.mesh, {
    threadInternal: false, topZ: BOSS.top, bottomZ: BOSS.base,
  });
  assert.ok(cutMoves(cl) > 0, 'it cuts');
  assert.ok(!/flute/.test(notes(cl)), notes(cl));
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

// A thread is one turn, one pitch. The count of turns is depth / pitch and it
// is not generally a whole number, so the last turn is a partial one — and
// rounding it up to a whole turn and sharing the depth out over *that* cut a
// pitch of depth / ceil(depth / pitch) instead. An M10×1.5 through a 20mm plate
// came out at 1.43mm on a form tool ground for 1.5: the nut does not go on.
//
// Measured as the slope of Z against the unwrapped swept angle, which is what a
// pitch *is* and which does not care how the helix happens to be chorded.
function milledPitch(cl) {
  let previous = null;
  let angle = 0;
  const swept = [];
  const heights = [];
  eachMove(cl, (opcode, x, y, z, i, j, k, feed) => {
    if (opcode === OP.DRILL || feed !== FEED.CUT) { previous = null; return; }
    const a = Math.atan2(y - 20, x - 20);
    if (previous !== null) {
      let d = a - previous;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) > 1e-9) { angle += d; swept.push(angle); heights.push(z); }
    }
    previous = a;
  });
  const n = swept.length;
  const mx = swept.reduce((s, v) => s + v, 0) / n;
  const my = heights.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) { num += (swept[i] - mx) * (heights[i] - my); den += (swept[i] - mx) ** 2; }
  return Math.abs(num / den) * 2 * Math.PI;
}

test('a milled thread advances one pitch per turn, whatever the depth', () => {
  for (const pitch of [1, 1.5, 0.7]) {
    const tool = { ...MILL, pitch };
    // 20mm of plate is not a whole number of turns at any of these pitches
    for (const bottomZ of [0, 7, 9.5]) {
      const cl = run('threadMill', tool, BORED, { threadPitch: pitch, bottomZ });
      assert.ok(cutMoves(cl) > 0, `it cuts at P${pitch} to Z${bottomZ}: ${notes(cl)}`);
      assert.close(milledPitch(cl), pitch, 1e-6,
        `P${pitch} from Z${bottomZ}: the helix rises ${milledPitch(cl).toFixed(4)}mm per turn`);
    }
  }
});

test('and it still ends exactly at the top of the thread', () => {
  const cl = run('threadMill', { ...MILL, pitch: 1.5 }, BORED, { threadPitch: 1.5, bottomZ: 0 });
  let highest = -Infinity;
  eachMove(cl, (opcode, x, y, z, i, j, k, feed) => {
    if (opcode !== OP.DRILL && feed === FEED.CUT) highest = Math.max(highest, z);
  });
  assert.close(highest, 20, 1e-6, 'the last turn reaches topZ and does not overshoot it');
});

test('every hole strategy approaches from above the billet, not just the part', () => {
  // The part is 20 tall in a 23mm billet — 3mm left on top, as a job arrives
  // before it is faced. Every hole strategy measured its approach from the
  // part's top, which put R (and the bore's feed plane, and the thread mill's
  // rapid) inside that 3mm: a canned cycle rapids down to R.
  const TALL = { kind: 'box', min: [0, 0, 0], max: [40, 40, 23] };
  const BIT = {
    number: 7, type: 'flat', diameter: 4, flutes: 3, fluteLength: 25,
    spindleRpm: 9000, feedCut: 600, feedPlunge: 200,
  };
  const DRILL5 = { ...SPOT, type: 'drill', diameter: 5, tipAngle: 118, fluteLength: 30 };
  const cases = [
    ['drill', DRILL5, TAPPED, {}],
    ['spot', SPOT, TAPPED, {}],
    ['tap', TAP, TAPPED, { diameterTol: 0.3 }],
    ['threadMill', MILL, BORED, {}],
    ['bore', BIT, BORED, { stepdown: 1, stepover: 0.4 }],
  ];
  for (const [type, tool, mesh, extra] of cases) {
    const cl = generateToolpath({
      type, name: type, tool, mesh, stock: TALL,
      params: {
        topZ: 23, bottomZ: 0, clearanceHeight: 30, tolerance: 0.01,
        diameterTol: 0.5, entryGap: 1, ...extra,
      },
    });
    assert.ok(cl.count > 0, `${type} made something: ${notes(cl)}`);
    let lowestRapid = Infinity;
    let lowestR = Infinity;
    eachMove(cl, (opcode, x, y, z, retract) => {
      if (opcode === OP.RAPID) lowestRapid = Math.min(lowestRapid, z);
      if (opcode === OP.DRILL) lowestR = Math.min(lowestR, retract);
    });
    assert.ok(lowestRapid >= 23 - 1e-6, `${type} rapids down to Z${lowestRapid}, inside the billet`);
    assert.ok(lowestR >= 23 + 0.5 - 1e-6, `${type} feeds from R${lowestR}, inside the billet`);
  }
});

// --- a tap needs the hole it follows ---

const DRILL5 = {
  number: 3, type: 'drill', diameter: 5, tipAngle: 118, flutes: 2, fluteLength: 30,
  spindleRpm: 3000, feedCut: 200, feedPlunge: 150,
};

test('a tap that comes down on metal is reported, and one that finds its hole is not', () => {
  // The path of a tap is a perfectly good tapping cycle whether the tapping drill
  // went in ahead of it or not, and the file reads the same either way. It is the
  // billet in front of the simulation that knows there was no hole: the flat of a
  // tap is smaller than its thread, and in a ⌀5 hole it drops through air.
  const drill = run('drill', DRILL5, TAPPED, { bottomZ: -3 });
  const tap = run('tap', TAP, TAPPED, { diameterTol: 0.3 });
  assert.ok(drillMoves(drill).length === 1 && drillMoves(tap).length === 1, 'one hole each');
  const simulate = (ops) => simulateRemoval({ stock: STOCK, ops });

  const tapped = simulate([{ cl: drill, tool: DRILL5 }, { cl: tap, tool: TAP }]);
  assert.eq(tapped.tapCut.count, 0, 'drilled first, the tap finds its hole');
  assert.eq(tapCutFinding(tapped, [{ name: 'drill' }, { name: 'tap' }]), null, 'and there is nothing to say');

  const bare = simulate([{ cl: tap, tool: TAP }]);
  assert.eq(bare.tapCut.count, 1, 'with no drilling ahead of it, the tap comes down on metal');
  const found = tapCutFinding(bare, [{ name: 'Tap M6', tool: TAP }]);
  assert.ok(found, 'reported');
  assert.eq(found.level, 'warn', 'as a warning');
  assert.ok(/tap in Tap M6/.test(found.text), `in the operation: ${found?.text}`);
  assert.ok(/1 hole/.test(found.text), `at how many holes: ${found?.text}`);
  assert.ok(/⌀5 for this tap/.test(found.text), `and says what to drill: ${found?.text}`);

  // a hole drilled *after* it is no help
  const late = simulate([{ cl: tap, tool: TAP }, { cl: drill, tool: DRILL5 }]);
  assert.eq(late.tapCut.count, 1, 'drilled after, the tap has still come down on metal');
});

test('and a tap that runs out of the hole it was given', () => {
  // Blind, with the drill stopped seven millimetres into a twelve-deep hole: the
  // tap goes on down to two short of the bottom, and for the last three
  // millimetres it is cutting a hole, not a thread.
  const part = makeRevolved([[0, 0], [20, 0], [20, 20], [2.5, 20], [2.5, 8], [0, 8], [0, 0]]);
  const stock = { kind: 'box', min: [-21, -21, 0], max: [21, 21, 20] };
  const make = (type, tool, params = {}) => generateToolpath({
    type, name: type, tool, mesh: part, stock,
    params: {
      topZ: 20, bottomZ: 0, clearanceHeight: 30, tolerance: 0.01,
      diameterTol: 0.5, entryGap: 1, ...params,
    },
  });
  const tap = make('tap', TAP, { diameterTol: 0.3 });
  assert.eq(drillMoves(tap).length, 1, `the blind hole is tapped: ${notes(tap)}`);
  const deep = make('drill', DRILL5, {});
  const shallow = make('drill', DRILL5, { bottomZ: 13 });
  assert.ok(drillMoves(shallow)[0].z > drillMoves(deep)[0].z + 4, 'one drill is much shorter');
  const after = (drill) => simulateRemoval({
    stock, ops: [{ cl: drill, tool: DRILL5 }, { cl: tap, tool: TAP }],
  });
  assert.eq(after(deep).tapCut.count, 0, 'drilled to the floor, the tap has all the hole it needs');
  assert.eq(after(shallow).tapCut.count, 1, 'drilled seven deep, the tap runs out of hole');
  // a tap that goes a millimetre into the point of its drill is bottoming, which
  // is what a bottoming tap does, and not a hole cut in solid
  const near = make('drill', DRILL5, { bottomZ: drillMoves(deep)[0].z + 1 });
  assert.eq(after(near).tapCut.count, 0, 'a millimetre into the point of the drill is not reported');
});

// --- the order the holes are visited in ---

/** A drawing of circles: one closed 24-gon per centre, which is how a DXF circle arrives. */
function circlesAt(centres, r = 3) {
  return centres.map(([cx, cy]) => {
    const points = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      points.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    return { points, closed: true };
  });
}

/** XY distance walked between drill cycles, in program order. */
function drillRoute(cl) {
  const pts = drillMoves(cl);
  let sum = 0;
  for (let i = 1; i < pts.length; i++) sum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return { sum, count: pts.length };
}

test('holes are visited by the shortest route found, not row by row', () => {
  // Three columns of five holes, each a few hundredths off a straight line. Read
  // as rows (Y, then X) they are fifteen different rows, so the old order went
  // across the plate and back for every hole: 800mm of travel for a part whose
  // holes are covered by three 80mm walks.
  const centres = [];
  for (let c = 0; c < 3; c++) {
    for (let k = 0; k < 5; k++) centres.push([10 + c * 40, 10 + k * 16 + ((c * 5 + k) % 4) * 0.05 * (c + 1)]);
  }
  const drawing = circlesAt(centres);
  const BIT = { ...DRILL5, diameter: 6 };
  const make = (type, tool) => generateToolpath({
    type, name: type, tool, drawing, mesh: BORED, stock: STOCK,
    params: {
      topZ: 20, bottomZ: 0, clearanceHeight: 30, tolerance: 0.01,
      diameterTol: 0.5, entryGap: 1,
    },
  });
  const drill = drillRoute(make('drill', BIT));
  assert.eq(drill.count, 15, 'every hole is drilled once');
  // three columns: 4 × 16 down each, and two 40mm hops between them
  assert.ok(drill.sum < 64 * 3 + 80 + 5, `the route is the three columns, not ${drill.sum.toFixed(0)}mm of crossing`);
  // and it is one function that every operation visiting holes goes through
  const holes = centres.map(([cx, cy]) => ({ cx, cy, r: 3 }));
  const walked = orderHoles(holes.slice().sort((a, b) => b.cx - a.cx || b.cy - a.cy));
  let sum = 0;
  for (let i = 1; i < walked.length; i++) sum += Math.hypot(walked[i].cx - walked[i - 1].cx, walked[i].cy - walked[i - 1].cy);
  assert.ok(sum < 64 * 3 + 80 + 5, `from any starting order, ${sum.toFixed(0)}mm`);
});

test('a blind hole is drilled to its own floor and spotted from its own surface, on a tall part too', () => {
  // The scan finds a hole by slicing the part, and a slice tells where a hole
  // IS, not where it stops: on a part 100mm tall the slices are a millimetre
  // apart, and the floor of the blind hole below was read as the last slice that
  // saw it — 0.5mm above the real one. depthMode "hole" drilled to that.
  const FLOOR = 37;
  const COUNTERBORE_FLOOR = 69;
  const body = makeRevolved([
    [0, FLOOR], [3, FLOOR], [3, 100], [20, 100], [20, 0], [0, 0],
  ], 48);
  // and a ⌀6 hole that opens in the floor of a ⌀12 counterbore
  const stepped = makeRevolved([
    [0, 20], [3, 20], [3, COUNTERBORE_FLOOR], [6, COUNTERBORE_FLOOR], [6, 100], [20, 100], [20, 0], [0, 0],
  ], 48);
  const stock = { kind: 'box', min: [-20, -20, 0], max: [20, 20, 100] };
  const make = (type, tool, mesh, params = {}) => generateToolpath({
    type, name: type, tool, mesh, stock,
    params: {
      topZ: 100, bottomZ: 0, clearanceHeight: 110, tolerance: 0.01,
      diameterTol: 0.5, entryGap: 1, depthMode: 'hole', ...params,
    },
  });
  const bit = { ...DRILL5, diameter: 6 };
  const drilled = drillMoves(make('drill', bit, body));
  assert.eq(drilled.length, 1);
  assert.close(drilled[0].z, FLOOR, 0.02, `drilled to Z${drilled[0].z.toFixed(3)}, the floor is at ${FLOOR}`);

  // a 90° spot across the ⌀6 hole's mouth, which is the counterbore floor
  const spot = drillMoves(make('spot', { ...SPOT, diameter: 12 }, stepped, { spotDiameter: 6 }))
    .filter((m) => Math.abs(m.z - (COUNTERBORE_FLOOR - 3)) < 1.5);
  assert.eq(spot.length, 1, 'one spot, in the counterbore floor');
  assert.close(spot[0].z, COUNTERBORE_FLOOR - 3, 0.02,
    `the cone is sunk from the real surface: Z${spot[0].z.toFixed(3)}, wanted ${COUNTERBORE_FLOOR - 3}`);
});

test('a drawing of circles drills with no model in the project at all', () => {
  // The app hands the strategy no mesh when a project holds only a DXF, which is
  // the job "Positions from" a drawing is for — and the drill read the mesh's
  // positions before it looked at the drawing, so the operation threw.
  const drawing = circlesAt([[10, 10], [30, 10], [20, 30]]);
  const BIT = { ...DRILL5, diameter: 6 };
  const cl = generateToolpath({
    type: 'drill', name: 'drill', tool: BIT, mesh: null, drawing, stock: STOCK,
    params: {
      topZ: 20, bottomZ: 0, clearanceHeight: 30, tolerance: 0.01,
      diameterTol: 0.5, entryGap: 1,
    },
  });
  const holes = drillMoves(cl);
  assert.eq(holes.length, 3, `three circles, three holes: ${notes(cl)}`);
  assert.ok(holes.every((h) => h.z < 0), 'through the billet, point and all');
  const bare = generateToolpath({
    type: 'drill', name: 'drill', tool: BIT, mesh: null, stock: STOCK,
    params: { topZ: 20, bottomZ: 0, clearanceHeight: 30, tolerance: 0.01, diameterTol: 0.5 },
  });
  assert.eq(bare.count, 0, 'with neither a part nor a drawing it says so instead of throwing');
  assert.ok(/no model/.test(notes(bare)), notes(bare));
});

test('a spot drill with a flat on its tip is sunk by the width the cone has to grow, not by the whole of it', () => {
  // A cone ⌀6 across at the surface, 90° included, from a tool that is already
  // ⌀2 at its tip: it has only to grow 2mm each side, so the tip goes in 2mm.
  // The depth was worked out as if the tool ended in a point, 3mm — a ⌀8 spot.
  const FLAT_TIP = { ...SPOT, diameter: 10, tipDiameter: 2 };
  const point = drillMoves(run('spot', SPOT, BORED, { spotDiameter: 6 }))[0];
  const flat = drillMoves(run('spot', FLAT_TIP, BORED, { spotDiameter: 6 }))[0];
  assert.close(point.z, 20 - 3, 0.02, 'from a point: three millimetres in');
  assert.close(flat.z, 20 - 2, 0.02, `from a ⌀2 flat: two, got ${(20 - flat.z).toFixed(3)}`);
  const none = run('spot', FLAT_TIP, BORED, { spotDiameter: 1.5 });
  assert.close(drillMoves(none)[0].z, 20, 0.02, 'a cone narrower than the tip is not cut at all');
  assert.ok(/flat tip/.test(notes(none)), notes(none));
});
