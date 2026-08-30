import { test, assert } from './runner.js';
import {
  isWrapped, wrapFor, wrapPoint, inverseTime, wrapExtent, wrapWarnings, linearExtent,
} from '../engine/wrap.js';
import { machineWarnings } from '../doc/machines.js';
import { buildGcode } from '../post/index.js';
import { CLBuilder, FEED } from '../engine/cl.js';

const MACHINE = {
  kind: 'mill', name: 'a fourth axis', travel: [400, 250, 180],
  spindleMin: 0, spindleMax: 0, maxFeed: 0,
  rotary: [{ letter: 'A', axis: [1, 0, 0], min: -360, max: 360 }],
};
const PLAIN = { ...MACHINE, name: 'three axis', rotary: [] };

const setup = (wrap) => ({ name: 'bar', mode: 'mill', wcs: 'G54', wrap });

// A ⌀20 bar is π×20 = 62.83mm round.
const BAR = setup({ enabled: true, axis: 'A', diameter: 20 });

test('a setup with no diameter is not wrapped, whatever the checkbox says', () => {
  assert.ok(!isWrapped(setup({ enabled: true, axis: 'A', diameter: 0 })), 'no bar, no wrap');
  assert.ok(!isWrapped(setup(null)), 'and none at all');
  assert.ok(isWrapped(BAR), 'but a bar with a size is');
});

test('one turn is the circumference, and a millimetre is its share of 360°', () => {
  const w = wrapFor(BAR, MACHINE);
  assert.close(w.circumference, Math.PI * 20, 1e-9, 'π×⌀');
  assert.close(w.degPerMm, 360 / (Math.PI * 20), 1e-9, 'and the angle per mm');
  assert.close(w.degPerMm * w.circumference, 360, 1e-9, 'so a full lap is a full turn');
});

test('an A axis eats Y and a B axis eats X', () => {
  const a = wrapFor(BAR, MACHINE);
  const b = wrapFor(setup({ enabled: true, axis: 'B', diameter: 20 }),
    { ...MACHINE, rotary: [{ letter: 'B', axis: [0, 1, 0], min: -360, max: 360 }] });
  assert.eq(a.developed, 'y', 'A turns about X, so Y is round the bar');
  assert.eq(b.developed, 'x', 'and B turns about Y');
});

test('the developed coordinate becomes an angle and stops being written', () => {
  const w = wrapFor(BAR, MACHINE);
  const p = wrapPoint(w, { x: 10, y: w.circumference / 4, z: -1 });
  assert.close(p.x, 10, 1e-9, 'X is still X');
  assert.eq(p.y, null, 'Y is gone — that direction is round the bar now');
  assert.close(p.angle, 90, 1e-9, 'a quarter of the way round is 90°');
  assert.close(p.z, -1, 1e-9, 'and Z is untouched, because the datum is on top of the bar');
});

test('a machine with no rotary axis cannot wrap, and says which axis it wants', () => {
  const w = wrapFor(BAR, PLAIN);
  assert.ok(!w.reachable, 'not reachable');
  assert.ok(/no A axis/.test(w.reason), w.reason);
  assert.ok(wrapFor(BAR, MACHINE).reachable, 'and with one, it is');
});

test('inverse time is the move measured on the unrolled sheet', () => {
  // 100mm at 200mm/min is half a minute, so F is 2
  assert.close(inverseTime({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, 200), 2, 1e-9);
  // and a move round the bar is measured the same way, because the unrolled
  // length *is* the surface distance
  assert.close(inverseTime({ x: 0, y: 0, z: 0 }, { x: 0, y: 100, z: 0 }, 200), 2, 1e-9);
  assert.eq(inverseTime({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 200), 0, 'a move of no length');
});

test('a pattern wider than the bar is round cuts over itself, and it says so', () => {
  const w = wrapFor(BAR, MACHINE);
  const fits = wrapExtent(w, { min: [0, 0, 0], max: [50, 60, 5] });
  assert.ok(!fits.overlaps, `60mm on a 62.8mm bar fits: ${fits.degrees.toFixed(0)}°`);
  const over = wrapExtent(w, { min: [0, 0, 0], max: [50, 90, 5] });
  assert.ok(over.overlaps, 'but 90mm does not');
  assert.close(over.laps, 90 / (Math.PI * 20), 1e-9, 'nearly a lap and a half');
  const said = wrapWarnings(w, { min: [0, 0, 0], max: [50, 90, 5] });
  assert.ok(said.some((s) => /cuts over itself/.test(s.text)), JSON.stringify(said));
});

// --- what the post writes ---

/** A flat pass: plunge, cut 10mm in X, then 15.7mm in Y (a quarter turn). */
function flatPass() {
  const cl = new CLBuilder();
  cl.toolChange(1);
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(0, 0, 5);
  cl.cut(0, 0, -1, FEED.PLUNGE);
  cl.cut(10, 0, -1);
  cl.cut(10, Math.PI * 20 / 4, -1);
  cl.rapid(10, Math.PI * 20 / 4, 5);
  return cl.finish();
}

function posted(wrapArgs = {}) {
  const wrap = wrapFor(setup({ enabled: true, axis: 'A', diameter: 20, ...wrapArgs }), MACHINE);
  const { text } = buildGcode('linuxcnc', [{ name: 'wrapped', cl: flatPass(), wrap }]);
  return text;
}

test('a wrapped program says A where the flat one said Y', () => {
  const text = posted();
  assert.ok(/A90/.test(text), `a quarter turn came out as A90:\n${text}`);
  const cutting = text.split('\n').filter((l) => /^(G1|X|Y|A)/.test(l));
  assert.ok(!cutting.some((l) => /\bY[-\d]/.test(l)),
    `and no Y is written at all:\n${cutting.join('\n')}`);
});

test('and switches to inverse time for the duration of the operation', () => {
  const text = posted();
  const lines = text.split('\n');
  assert.ok(lines.includes('G93'), 'inverse time on');
  assert.ok(lines.includes('G94'), 'and off again, so the next operation is not a duration');
  assert.ok(lines.indexOf('G93') < lines.indexOf('G94'), 'in that order');
});

test('every cutting block carries its own F, because it is a duration', () => {
  const cuts = posted().split('\n').filter((l) => /^G1\b/.test(l) || /^X[-\d]/.test(l));
  assert.ok(cuts.length >= 2, `there are cutting blocks: ${cuts.join(' | ')}`);
  for (const line of cuts) {
    assert.ok(/F[\d.]+/.test(line), `${line} states its own time`);
  }
});

test('the inverse-time number is the move, not the rate', () => {
  // the 10mm move at 600mm/min takes 1/60 minute, so F is 60
  const line = posted().split('\n').find((l) => /^X10\b/.test(l) || /^G1 X10\b/.test(l));
  assert.ok(line, 'the 10mm move is there');
  const f = Number(/F([\d.]+)/.exec(line)?.[1]);
  assert.close(f, 60, 0.5, `10mm at 600mm/min is a sixtieth of a minute: ${line}`);
});

test('it says what it wrapped round, in the file', () => {
  assert.ok(/wrapped round ⌀20/.test(posted()), 'the bar');
  assert.ok(/62\.8mm is one turn/.test(posted()), 'and what a turn is worth');
});

test('a wrap the machine cannot make is refused in the file, not silently posted', () => {
  const wrap = wrapFor(setup({ enabled: true, axis: 'A', diameter: 20 }), PLAIN);
  const { text } = buildGcode('linuxcnc', [{ name: 'wrapped', cl: flatPass(), wrap }]);
  assert.ok(/WARNING/.test(text), 'the warning is in the file');
  assert.ok(/do not run this/.test(text), 'in those words');
});

test('an unwrapped operation is posted exactly as it always was', () => {
  const { text: flat } = buildGcode('linuxcnc', [{ name: 'flat', cl: flatPass() }]);
  const { text: nulled } = buildGcode('linuxcnc',
    [{ name: 'flat', cl: flatPass(), wrap: null }]);
  assert.eq(flat, nulled, 'a null wrap changes nothing');
  assert.ok(!/G93/.test(flat), 'and no inverse time appears');
  assert.ok(/Y15\.708/.test(flat), 'Y is still Y');
});

// --- what a wrap is not ---

test('the developed axis is not travel, and is dropped from the extent', () => {
  // A pattern that goes right round a ⌀100 bar is 314mm of Y on the unrolled
  // sheet and no Y at all in the file: the tool stands still there and the bar
  // turns. Measured flat against the table, every machine in the rack was told
  // it had not got the travel for the ordinary case of a wrap.
  const w = wrapFor(setup({ enabled: true, axis: 'A', diameter: 100 }),
    { ...MACHINE, travel: [400, 250, 180] });
  const flat = { min: [-34, -148, -1], max: [34, 148, 10] };
  const seen = linearExtent(w, flat);
  assert.close(seen.max[0] - seen.min[0], 68, 1e-9, 'X is still X');
  assert.ok(!Number.isFinite(seen.min[1]), 'and Y is not an axis this program moves');
  assert.close(seen.max[2] - seen.min[2], 11, 1e-9, 'Z is untouched');
  assert.eq(machineWarnings({ ...MACHINE, travel: [400, 250, 180] }, seen).length, 0,
    'so nothing is said about 250mm of Y travel');
  // and a B axis eats X instead
  const b = wrapFor(setup({ enabled: true, axis: 'B', diameter: 100 }),
    { ...MACHINE, rotary: [{ letter: 'B', axis: [0, 1, 0], min: -360, max: 360 }] });
  assert.ok(!Number.isFinite(linearExtent(b, flat).min[0]), 'X, for a B axis');
  assert.eq(linearExtent(null, flat), flat, 'and an unwrapped setup is left alone');
});

test('a setup cannot be indexed and wrapped at once', () => {
  // The two things a fourth axis does, and they are opposites: indexing swings
  // the rotary and locks it under a tilted plane, wrapping turns it while the
  // tool cuts. Asked for both, the post wrote a G68.2 holding the plane and
  // then commanded the same axis round the bar underneath it.
  const both = {
    ...setup({ enabled: true, axis: 'A', diameter: 20 }),
    index: { enabled: true },
    orientation: { rotationDeg: [30, 0, 0] },
  };
  const w = wrapFor(both, MACHINE);
  assert.ok(!w.reachable, 'refused');
  assert.ok(/also indexed/.test(w.reason), w.reason);
  const { text } = buildGcode('linuxcnc', [{ name: 'wrapped', cl: flatPass(), wrap: w }]);
  assert.ok(/do not run this/.test(text), 'and the file says so');
  // the identity orientation is the face that is already up: no swing, no clash
  const flatFace = { ...both, orientation: { rotationDeg: [0, 0, 0] } };
  assert.ok(wrapFor(flatFace, MACHINE).reachable, 'an unswung indexed setup still wraps');
});
