import { test, assert } from './runner.js';
import { generateToolpath, estimateSeconds } from '../engine/toolpath.js';
import { buildGcode, postsFor, defaultPostFor } from '../post/index.js';
import { makeBox, makeTube } from './fixtures.js';
import { CLBuilder, FEED, feedRate, descentOf } from '../engine/cl.js';
import { applyCutting } from '../engine/cutting.js';
import { generateCommand } from '../engine/strategies/command.js';

const TOOL = {
  number: 3, diameter: 6, spindleRpm: 9000, feedCut: 800, feedPlunge: 300,
};

function contourOps() {
  const cl = generateToolpath({
    type: 'contour2d', name: 'cutout', tool: TOOL,
    mesh: makeBox(10, 10, 5),
    stock: { min: [0, 0, 0], max: [10, 10, 5] },
    params: { topZ: 5, bottomZ: 0, stepdown: 2, clearanceHeight: 15, stockToLeave: 0, tolerance: 0.01, rampAngle: 0 },
  });
  return [{ name: 'cutout', cl }];
}

function drillOps(peck) {
  const cl = generateToolpath({
    type: 'drill', name: 'holes', tool: TOOL,
    mesh: makeTube(15, 10, 10, 3, 8),
    stock: { min: [0, 0, 0], max: [30, 20, 8] },
    // entryGap 2 puts the cycle's retract plane at Z10, which the
    // expectations below name directly
    params: { topZ: 8, bottomZ: -1, clearanceHeight: 15, entryGap: 2, peck },
  });
  return [{ name: 'holes', cl }];
}

test('LinuxCNC post: header, tool change with G43, footer', () => {
  const { text } = buildGcode('linuxcnc', contourOps(), { programName: 'lcnc' });
  assert.ok(text.includes('G21 G90 G94 G17 G40 G49 G80'), 'full safety header');
  assert.ok(text.includes('T3 M6'), 'tool change');
  assert.ok(text.includes('G43 H3'), 'length comp after M6');
  assert.ok(text.includes('M3 S9000'), 'spindle');
  assert.ok(text.includes('M5'), 'spindle off');
  assert.ok(text.trimEnd().endsWith('M2'), 'program end');
  assert.ok(!/undefined|NaN/.test(text), 'no formatting garbage');
});

test('LinuxCNC post: peck drilling uses G83 with Q and G80 cancel', () => {
  const { text } = buildGcode('linuxcnc', drillOps(2));
  assert.ok(/G98 G83 X15 Y10 Z-1 R10 Q2 F300/.test(text), `cycle line, got:\n${text}`);
  assert.ok(text.includes('G80'), 'cycle cancelled');
});

test('LinuxCNC post: peck 0 uses plain G81', () => {
  const { text } = buildGcode('linuxcnc', drillOps(0));
  assert.ok(text.includes('G98 G81 '), 'G81 cycle');
  assert.ok(!text.includes('G83'), 'no peck cycle');
  assert.ok(!/Q\d/.test(text), 'no Q word');
});

test('GRBL post expands drills long-hand (no canned cycles)', () => {
  const { text } = buildGcode('grbl', drillOps(2));
  assert.ok(!text.includes('G83') && !text.includes('G81'), 'no cycles');
  assert.ok(/G1 Z-1 F300/.test(text) || /G1 Z-1\b/.test(text), 'plunges to bottom');
  const chipClears = (text.match(/G0 Z10/g) || []).length;
  assert.ok(chipClears >= 4, `pecking retracts present (got ${chipClears})`);
});

test('lineMap points G-code lines back to CL moves', () => {
  const ops = contourOps();
  const { text, lineMap } = buildGcode('linuxcnc', ops);
  assert.ok(lineMap.size > 10, 'map populated');
  const lines = text.split('\n');
  for (const [line, ref] of lineMap) {
    assert.ok(ref.move >= 0 && ref.move < ops[ref.op].cl.count, 'move index in range');
    assert.ok(/^[GXYZTFMS(]/.test(lines[line].trim()), `mapped line is code: "${lines[line]}"`);
  }
});

test('unknown post id throws', () => {
  assert.throws(() => buildGcode('fanuc', contourOps()));
});

test('the post list belongs to the machine, so a lathe post is never a mill option', () => {
  assert.ok(postsFor('mill').includes('linuxcnc'), 'mill posts');
  assert.ok(postsFor('mill').includes('grbl'), 'mill posts');
  assert.ok(!postsFor('mill').includes('lathe'),
    'turning is not a flavour of a milling post');
  assert.eq(postsFor('turn').join(), 'lathe');
  assert.eq(defaultPostFor('turn'), 'lathe');
  assert.ok(postsFor('mill').includes(defaultPostFor('mill')));
});

/**
 * A canned cycle's short form restates only X and Y. Everything else about the
 * hole — the depth, the retract plane, the peck, the dwell — is modal, so a
 * hole that differs in any of those has to open a new cycle. Two holes at
 * different depths came out as one G81 and a bare XY line, and the second hole
 * was drilled to the first one's depth with nothing in the file to say so.
 */
function holesAt(specs) {
  const cl = new CLBuilder();
  cl.toolChange(4);
  cl.spindle(2000);
  cl.event('feeds', { cut: 500, plunge: 150 });
  for (const [x, z, retractZ, peck = 0] of specs) {
    cl.drill(x, 0, z, { retractZ, peck, dwell: 0 });
  }
  return [{ name: 'holes', cl: cl.finish() }];
}

test('a hole at a different depth opens its own canned cycle', () => {
  const { text } = buildGcode('linuxcnc', holesAt([[0, -5, 2], [10, -12, 2]]));
  assert.ok(/Z-5 R2/.test(text), 'first hole stated');
  assert.ok(/Z-12 R2/.test(text), `second hole states its own depth, got:\n${text}`);
  assert.eq((text.match(/^G80$/gm) || []).length, 2, 'each cycle is cancelled');
});

test('holes that agree still share one cycle', () => {
  const { text } = buildGcode('linuxcnc', holesAt([[0, -5, 2], [10, -5, 2], [20, -5, 2]]));
  assert.eq((text.match(/G98 G8/g) || []).length, 1, 'one cycle line');
  assert.eq((text.match(/^X10 Y0$/m) || []).length, 1, 'the rest are short form');
});

test('a hole that wants a peck does not inherit a plain cycle', () => {
  const { text } = buildGcode('linuxcnc', holesAt([[0, -5, 2, 0], [10, -5, 2, 3]]));
  assert.ok(/G98 G81 X0/.test(text), 'the plain hole is G81');
  assert.ok(/G98 G83 X10 .*Q3/.test(text), `the pecked one is G83, got:\n${text}`);
});

test('long-hand pecking goes back down the open hole at rapid', () => {
  const { text } = buildGcode('grbl', holesAt([[0, -9, 1, 3]]));
  const lines = text.split('\n');
  const feeds = lines.filter((l) => /^G1 Z/.test(l)).map((l) => Number(l.match(/Z(-?[\d.]+)/)[1]));
  assert.eq(feeds.length, 4, `four pecks, got ${feeds.join()}`);
  // each feed starts from a rapid, so no feed move covers more than one peck
  // plus the clearance above where the last one stopped
  for (let i = 1; i < feeds.length; i++) {
    const from = lines.findIndex((l) => l === `G1 Z${feeds[i]}`);
    const before = lines.slice(0, from).reverse().find((l) => /^(G0 )?Z-?[\d.]+$/.test(l));
    const start = Number(before.match(/Z(-?[\d.]+)/)[1]);
    assert.ok(start - feeds[i] <= 3.6, `peck ${i} feeds ${start} → ${feeds[i]}, not the whole hole`);
  }
});

test('the spindle turns the way the operation asked for', () => {
  const cl = new CLBuilder();
  cl.toolChange(2);
  cl.spindle(1200, 'ccw');
  cl.event('feeds', { cut: 400, plunge: 100 });
  cl.rapid(0, 0, 5);
  cl.cut(10, 0, 5);
  const ops = [{ name: 'left hand', cl: cl.finish() }];
  for (const post of ['linuxcnc', 'grbl']) {
    const { text } = buildGcode(post, ops);
    assert.ok(text.includes('M4 S1200'), `${post} writes M4 for a reversed spindle`);
    assert.ok(!/\bM3\b/.test(text), `${post} does not also write M3`);
  }
});

test('a machine with no tool changer stops for the operator', () => {
  const ops = holesAt([[0, -5, 2]]);
  const manual = buildGcode('grbl', ops, { toolChanger: 'manual' }).text;
  assert.ok(/^M0$/m.test(manual), `a comment does not stop the machine, got:\n${manual}`);
  const auto = buildGcode('grbl', ops, { toolChanger: 'auto' }).text;
  assert.ok(auto.includes('T4 M6'), 'a changer is used when there is one');
  assert.ok(!/^M0$/m.test(auto), 'and then nothing stops');
});

test('a lathe drilled long-hand feeds in mm per revolution, like everything else in the file', () => {
  // G95 is stated in the header, so an F word is millimetres *per revolution*.
  // Long-hand drilling was the one motion the post wrote without the spindle
  // speed to divide by, so a 120 mm/min plunge posted as F120 — read by the
  // control as 120mm per rev, which at 1200 rpm is 144 metres a minute into
  // the end of the bar.
  const cl = new CLBuilder();
  cl.toolChange(5);
  cl.spindle(1200, 'cw');
  cl.event('feeds', { cut: 240, plunge: 120 });
  cl.rapid(0, 0, 20);
  cl.drill(0, 0, -10, { retractZ: 2, peck: 4, dwell: 0 });
  const { text } = buildGcode('lathe', [{ name: 'centre drill', cl: cl.finish() }],
    { feedMode: 'perRev' });
  assert.ok(text.includes('G95'), 'the header says feed per revolution');
  const feeds = [...text.matchAll(/F([\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(feeds.length > 0, `the drill writes a feed, got:\n${text}`);
  for (const f of feeds) {
    assert.close(f, 0.1, 1e-6, `120 mm/min at 1200 rpm is 0.1 mm/rev, not ${f}`);
  }
});

test('per-minute feeds survive the same route', () => {
  const cl = new CLBuilder();
  cl.toolChange(5);
  cl.spindle(1200, 'cw');
  cl.event('feeds', { cut: 240, plunge: 120 });
  cl.rapid(0, 0, 20);
  cl.drill(0, 0, -10, { retractZ: 2, peck: 0, dwell: 0 });
  const { text } = buildGcode('lathe', [{ name: 'drill', cl: cl.finish() }],
    { feedMode: 'perMinute' });
  assert.ok(text.includes('G94'), 'the header says feed per minute');
  assert.ok(/F120\b/.test(text), `and the drill writes it unchanged, got:\n${text}`);
});

/**
 * A cutting pass with a coolant choice, ready to post. `applyCutting` is the
 * one place an operation's speeds, feeds and coolant reach the CL — going
 * through it rather than calling `cl.coolant` directly is what makes these
 * tests about the setting the panel offers.
 */
function coolantOps(...modes) {
  return modes.map((coolant, i) => {
    const cl = new CLBuilder();
    cl.toolChange(TOOL.number);
    applyCutting(cl, { params: { coolant } }, TOOL);
    cl.rapid(0, 0, 10);
    cl.cut(5, 0, 0);
    return { name: `pass ${i + 1}`, cl: cl.finish() };
  });
}

test('an operation that asks for no coolant turns it off', () => {
  // The field is on every operation's Speeds tab and its own hint says "off for
  // a finishing pass you want to watch". Only *asking* for coolant was emitted,
  // so the pump ran straight through the pass that asked for none — the setting
  // did nothing at all, in the safe-looking direction.
  const { text } = buildGcode('linuxcnc', coolantOps('flood', 'off'));
  const words = [...text.matchAll(/^(M[789])$/gm)].map((m) => m[1]);
  assert.eq(words[0], 'M8', `flood comes on, got:\n${text}`);
  assert.eq(words[1], 'M9', `and the next pass turns it off, got:\n${text}`);
});

test('and one that asks for what is already running does not restate it', () => {
  const { text } = buildGcode('linuxcnc', coolantOps('flood', 'flood', 'flood'));
  const words = [...text.matchAll(/^(M[789])$/gm)].map((m) => m[1]);
  assert.eq(words.join(' '), 'M8 M9', 'one M8 for three passes, and off at the end');
});

test('a program that never wants coolant writes no coolant word at all', () => {
  const { text } = buildGcode('linuxcnc', coolantOps('off', 'off'));
  assert.ok(!/^M[789]$/m.test(text), `nothing to say, got:\n${text}`);
});

test('mist and flood are different states, not one "coolant on"', () => {
  const { text } = buildGcode('linuxcnc', coolantOps('flood', 'mist'));
  const words = [...text.matchAll(/^(M[789])$/gm)].map((m) => m[1]);
  assert.eq(words.join(' '), 'M8 M7 M9', 'the change is written');
});

test('a machine with no coolant gets the note and not the M word', () => {
  const { text } = buildGcode('grbl', coolantOps('flood'), { coolant: false });
  assert.ok(!/^M[78]$/m.test(text), 'no relay is switched');
  assert.ok(/flood coolant wanted here/.test(text), `and the reader is told, got:\n${text}`);
});

test('every post retracts before it stops the spindle', () => {
  // The other order drags a stationary cutter out of whatever it is in. Every
  // operation happens to end at clearance today, which is exactly why this was
  // invisible — and exactly why the order still has to be right.
  for (const post of ['linuxcnc', 'grbl']) {
    const lines = buildGcode(post, contourOps()).text.trimEnd().split('\n');
    const retract = lines.findLastIndex((l) => /^G0 Z/.test(l));
    const stop = lines.indexOf('M5');
    assert.ok(stop > retract && retract >= 0, `${post}: retract then M5, got:\n${lines.slice(-4).join('\n')}`);
  }
});

test('and the lathe pulls the cross-slide out before it stops', () => {
  const cl = new CLBuilder();
  cl.toolChange(2);
  cl.spindle(900, 'cw');
  cl.event('feeds', { cut: 200, plunge: 100 });
  cl.rapid(20, 5);
  cl.cut(0, 5);
  const lines = buildGcode('lathe', [{ name: 'part off', cl: cl.finish() }])
    .text.trimEnd().split('\n');
  const retract = lines.findLastIndex((l) => /^G0 X/.test(l));
  assert.ok(lines.indexOf('M5') > retract, `blade clear of the groove first, got:\n${lines.slice(-5).join('\n')}`);
  assert.ok(lines.indexOf('G97') > retract, 'and G97 restored before the end');
});

// --- what a ramp runs at ------------------------------------------------------

test('a ramp is fed by how steeply it descends, not by being a ramp', () => {
  const feeds = { cut: 800, plunge: 250 };
  // Level: it is a cut that happens to carry the ramp class, so it cuts.
  assert.eq(feedRate(FEED.RAMP, feeds, 0), 800, 'a level ramp is a cut');
  // Straight down: the plunge feed, exactly as before.
  assert.eq(feedRate(FEED.RAMP, feeds, 1), 250, 'a vertical ramp is a plunge');
  // In between, the vertical component is what is held to the plunge feed:
  // at 30° the move may run at twice it, but never past the cutting feed.
  assert.close(feedRate(FEED.RAMP, feeds, 0.5), 500, 1e-9, '30° runs at plunge/sin');
  assert.eq(feedRate(FEED.RAMP, feeds, 0.1), 800, 'and is capped by the cutting feed');
  // The other classes are untouched.
  assert.eq(feedRate(FEED.PLUNGE, feeds, 0), 250, 'a plunge is a plunge');
  assert.eq(feedRate(FEED.CUT, feeds, 1), 800, 'a cut is a cut');
});

test('a full-circle helix is measured round its arc, not across its ends', () => {
  // Both ends of a full turn are the same point, so a straight-line reading
  // makes every helical bore a vertical plunge and feeds it accordingly.
  const from = [10, 0, 0];
  const to = [10, 0, -1];                     // one turn of a ⌀20 helix, 1mm pitch
  assert.eq(descentOf(from, to), 1, 'across the ends it reads as straight down');
  const round = descentOf(from, to, 2 * Math.PI * 10);
  assert.ok(round < 0.02, `round the arc it is a shallow ramp, got ${round}`);
  assert.eq(feedRate(FEED.RAMP, { cut: 800, plunge: 250 }, round), 800,
    'so it runs at the cutting feed');
});

test('the time estimate and the post agree about a shallow ramp', () => {
  // Two statements of the same rule is how they came to disagree: the post
  // wrote one feed and the minutes on screen were counted at another.
  const cl = new CLBuilder();
  cl.toolChange(TOOL.number);
  applyCutting(cl, { params: {} }, TOOL);
  cl.rapid(0, 0, 10);
  // straight down first, so the F in force when the ramp begins is the plunge
  // feed and the ramp has to say otherwise rather than inherit it
  cl.cut(0, 0, 0, FEED.PLUNGE);
  cl.cut(100, 0, -1, FEED.RAMP);               // 100mm along, 1mm down
  const program = cl.finish();
  const { text } = buildGcode('linuxcnc', [{ name: 'ramp', cl: program }]);
  const lines = text.split('\n');
  assert.ok(/F300/.test(lines.find((l) => /Z0\b/.test(l)) ?? ''), 'the plunge is a plunge');
  const rampLine = lines.find((l) => l.includes('X100'));
  assert.ok(/F800/.test(rampLine), `the post feeds it at the cutting feed: ${rampLine}`);
  // and the minutes on screen are counted at the feed the file was written at
  const seconds = estimateSeconds(program, 3000);
  const ramp = (Math.hypot(100, 1) / 800) * 60;
  const plunge = (10 / TOOL.feedPlunge) * 60;
  assert.close(seconds, ramp + plunge, 0.6, 'the estimate counts the ramp as a cut');
});

// Under G96 the control sets the rpm itself, from the surface speed and the
// diameter it is at. A post writing feed per revolution has to divide by *that*
// number, not by the nominal figure on the tool — and when the operation says
// constant surface speed there may not be a figure on the tool at all, because
// the operator has already said what they want held.
//
// Both ways of getting it wrong were live. With an rpm on the tool the feed was
// out by the ratio of the two speeds; with none, there was nothing to divide by
// and the mm/min figure went out unconverted — F120, read by a control in G95
// as 120 millimetres per revolution.
function cssProgram({ rpm }) {
  const cl = new CLBuilder();
  cl.toolChange(1);
  cl.spindle(rpm, 'cw', { mode: 'css', surfaceSpeed: 180, maxRpm: 2500 });
  cl.event('feeds', { cut: 120, plunge: 60 });
  cl.rapid(25, 0, 5);
  cl.cut(20, 0, 0, FEED.CUT);         // ⌀40
  cl.cut(20, 0, -30, FEED.CUT);
  return buildGcode('lathe', [{ name: 'rough', cl: cl.finish() }], { feedMode: 'perRev' }).text;
}

test('a lathe in constant surface speed feeds at the rpm the control will hold', () => {
  // 180 m/min on a ⌀40 bar is 180000 / (pi x 40) = 1432 rpm, so 120 mm/min is
  // 120 / 1432 = 0.0838 mm/rev.
  const expected = 120 / ((180 * 1000) / (Math.PI * 40));
  for (const rpm of [1200, 0]) {
    const text = cssProgram({ rpm });
    assert.ok(text.includes('G96'), 'constant surface speed is stated');
    const feeds = [...text.matchAll(/F([\d.]+)/g)].map((m) => Number(m[1]));
    assert.ok(feeds.length > 0, `the pass writes a feed, got:\n${text}`);
    assert.ok(feeds.every((f) => f < 1),
      `an F word here is mm/rev and must never be a mm/min figure, got ${feeds.join(' ')}`);
    assert.close(feeds[0], expected, 1e-4,
      `at ⌀40 and 180m/min, 120mm/min is ${expected.toFixed(4)} mm/rev — with `
      + `${rpm === 0 ? 'no rpm on the tool' : 'a 1200rpm tool'} it wrote ${feeds[0]}`);
  }
});

test('and a fixed-rpm lathe still divides by the S word it wrote', () => {
  const cl = new CLBuilder();
  cl.toolChange(1);
  cl.spindle(1200, 'cw');
  cl.event('feeds', { cut: 120, plunge: 60 });
  cl.rapid(25, 0, 5);
  cl.cut(20, 0, 0, FEED.CUT);
  cl.cut(20, 0, -30, FEED.CUT);
  const { text } = buildGcode('lathe', [{ name: 'rough', cl: cl.finish() }], { feedMode: 'perRev' });
  assert.ok(text.includes('G97 S1200'), 'a plain rpm is stated');
  const feeds = [...text.matchAll(/F([\d.]+)/g)].map((m) => Number(m[1]));
  assert.close(feeds[0], 0.1, 1e-6, `120 mm/min at 1200 rpm is 0.1 mm/rev, not ${feeds[0]}`);
});

test('a machine writes its own lines before the job and after it', () => {
  // Not CAM and not a dialect: the WCS a machine homes into, an air blast, the
  // G53 that parks the head where the vice is reachable. Placement is the whole
  // of this — a start block before the safety header is read in whatever state
  // the last program left, and an end block after the retract is undone by it.
  const cl = new CLBuilder();
  cl.toolChange(1);
  cl.spindle(9000);
  cl.rapid(0, 0, 5);
  cl.cut(10, 0, -1);
  const { text } = buildGcode('linuxcnc', [{ name: 'cut', cl: cl.finish() }], {
    startGcode: 'G54\nM7',
    endGcode: 'G53 G0 Z0',
  });
  const lines = text.split('\n');
  const at = (needle) => lines.findIndex((l) => l.includes(needle));

  assert.ok(at('G21 G90') < at('G54'), 'the start block follows the safety header');
  assert.ok(at('G54') < at('T1 M6'), 'and precedes the first operation');
  assert.ok(at('M5') < at('G53 G0 Z0'), 'the end block follows the spindle stop');
  assert.ok(at('G53 G0 Z0') < at('M2'), 'and precedes the end of program');
  assert.ok(at('(machine start)') >= 0 && at('(machine end)') >= 0,
    'both are labelled, so the operator can see which lines are not CAM');
});

test('a command operation writes its lines where it stands, and nowhere else', () => {
  // The point of the operation is that nothing is checked and nothing is moved
  // that the lines do not move — so what is tested is placement and what the
  // post believes afterwards, which is the part that can go wrong silently.
  const first = new CLBuilder();
  first.toolChange(1);
  first.spindle(9000);
  first.rapid(0, 0, 5);
  first.cut(10, 0, -1);

  const second = new CLBuilder();
  second.toolChange(1);
  second.spindle(9000);
  second.rapid(0, 0, 5);
  second.cut(20, 0, -1);

  const { text } = buildGcode('linuxcnc', [
    { name: 'rough', cl: first.finish() },
    { name: 'swap the head', cl: generateCommand({ params: { gcode: 'M5\nM0 (fit the 12mm)' } }) },
    { name: 'finish', cl: second.finish() },
  ]);
  const lines = text.split('\n');
  const at = (needle) => lines.findIndex((l) => l.includes(needle));

  assert.ok(at('(command: swap the head)') > at('(operation: rough)'),
    'the block lands after the operation before it');
  assert.ok(at('M0 (fit the 12mm)') < at('(operation: finish)'),
    'and before the one after it');

  // The tool is *not* restated. A command that performs a hand tool change
  // exists to avoid a T word, and writing one straight after the operator
  // fitted the cutter would swing the carousel on a machine that has one.
  assert.eq(text.match(/^T1 M6$/gm).length, 1, 'the tool is stated once, not again after the block');
  // The spindle is, because a block that pauses nearly always stops it and one
  // extra S word is never wrong.
  assert.eq(text.match(/^M3 S9000$/gm).length, 2, 'the spindle is restated after the block');

  // An empty command says so rather than posting a silent nothing.
  const empty = generateCommand({ params: { gcode: '   ' } });
  assert.ok(empty.notes.some((n) => n.level === 'warn'), 'an empty command warns');
});

test('a command block leaves the post honest about what it no longer knows', () => {
  // The lines are not understood, so three of the four things the post believed
  // about the machine are dropped and one is kept. The one kept is the tool —
  // see the test above. These are the two that must *not* be asserted.
  const cutting = new CLBuilder();
  cutting.toolChange(1);
  cutting.spindle(9000);
  cutting.coolant('flood');
  cutting.rapid(0, 0, 5);
  cutting.cut(10, 0, -1);

  const withCommand = buildGcode('linuxcnc', [
    { name: 'pause', cl: generateCommand({ params: { gcode: 'M0 (measure the bore)' } }) },
  ]).text;
  assert.ok(!/^M9$/m.test(withCommand),
    'no M9 for coolant the post never turned on — the block owns what the block started');

  // But an operation that did ask for coolant still gets it turned off.
  const withCoolant = buildGcode('linuxcnc', [
    { name: 'cut', cl: cutting.finish() },
  ]).text;
  assert.ok(/^M9$/m.test(withCoolant), 'a program that ran the pump still stops it');

  // And an operation after a command restates its coolant rather than assuming
  // the block left it alone: a tool-change block that writes M9 would otherwise
  // leave the next pass running dry with nothing saying so.
  const after = new CLBuilder();
  after.toolChange(1);
  after.spindle(9000);
  after.coolant('flood');
  after.rapid(0, 0, 5);
  after.cut(10, 0, -1);
  const both = buildGcode('linuxcnc', [
    { name: 'first', cl: cutting.finish() },
    { name: 'swap', cl: generateCommand({ params: { gcode: 'M5\nM9\nM0 (fit the 12mm)' } }) },
    { name: 'second', cl: after.finish() },
  ]).text;
  assert.eq(both.match(/^M8$/gm).length, 2, 'coolant is restated after the block');
});
