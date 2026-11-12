// Probing blocks: text the operator runs, never something this program runs.
//
// What is checked is what could hurt: that the file read back still matches the
// path it was printed from (a probe's Z is a limit, not a destination, and read
// as motion it made every program with a touch-off block "ten millimetres off"),
// that nothing but ASCII reaches GRBL, that the spindle is off before a pause,
// and that the control is left in absolute mode.

import { test, assert } from './runner.js';
import { buildGcode } from '../post/index.js';
import { parseGcode } from '../post/parse.js';
import { checkPost } from '../engine/backplot.js';
import { CLBuilder } from '../engine/cl.js';
import { generateCommand } from '../engine/strategies/command.js';
import { PROBE_KINDS, probeMacro } from '../doc/probe-macros.js';

function pass(number, [x, y]) {
  const cl = new CLBuilder();
  cl.toolChange(number);
  cl.spindle(9000);
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(x, y, 1);
  cl.cut(x + 10, y, 0);
  cl.rapid(x + 10, y, 10);
  return cl.finish();
}

const KINDS = PROBE_KINDS.map((k) => k.id);

function macro(kind, post, extra = {}) {
  const m = probeMacro({ kind, post, ...extra });
  assert.ok(!m.error, `${kind}/${post}: ${m.error}`);
  return m;
}

test('every probing block between two cuts reads back as the path it was printed from', () => {
  for (const post of ['linuxcnc', 'grbl']) {
    for (const kind of KINDS) {
      if (kind === 'bore' && post === 'grbl') continue;   // refused, below
      const { gcode } = macro(kind, post);
      const ops = [
        { name: 'a', cl: pass(1, [20, 15]) },
        { name: 'probe', cl: generateCommand({ params: { gcode } }) },
        { name: 'b', cl: pass(1, [40, 30]) },
      ];
      const { text, lineMap } = buildGcode(post, ops);
      const check = checkPost({ ops, text, lineMap });
      assert.ok(check.over <= 0, `${post}/${kind}: the file matches its toolpath (worst ${check.worst.toFixed(2)}mm)`);
    }
  }
});

test('G38.2, G28, G10, G92 and G53 are read as what they are, not as a move to their Z', () => {
  // the exact blocks that read back ten and seventeen millimetres off
  for (const block of ['G38.2 Z-30 F100', 'G28 Z0', 'G10 L20 P1 Z0', 'G92 Z0', 'G53 G0 Z0']) {
    const parsed = parseGcode(`G0 Z10\nG1 X5 Z2 F300\n${block}\nG1 X9 Z2`);
    const heights = parsed.points.map((p) => p.z);
    assert.eq(JSON.stringify(heights), '[10,2,2]', `${block}: the block draws no point`);
    assert.ok(!parsed.unsupported.some((u) => /G38|G28|G10|G92|G53/.test(u.code)), `${block} is not reported unreadable`);
  }
  const probe = parseGcode('G38.2 Z-30 F100');
  assert.ok(probe.events.some((e) => e.type === 'probe'), 'a probe is an event the reader can show');
});

test('the spindle is stopped before the pause and the first probe move, and G90 comes back', () => {
  for (const post of ['linuxcnc', 'grbl']) {
    for (const kind of ['z', 'edge', 'corner']) {
      const lines = macro(kind, post).gcode.split('\n');
      const stop = lines.indexOf('M5');
      const pause = lines.findIndex((l) => /^M0\b/.test(l));
      const firstProbe = lines.findIndex((l) => /^G38\.2/.test(l));
      assert.ok(stop >= 0 && stop < firstProbe, `${post}/${kind}: M5 before the probe`);
      if (pause >= 0) assert.ok(stop < pause, `${post}/${kind}: M5 before the M0 - GRBL's M0 leaves the spindle on`);
      assert.eq(lines[lines.length - 1], 'G90', `${post}/${kind}: absolute again at the end`);
      assert.ok(lines.indexOf('G91') < firstProbe, `${post}/${kind}: incremental before the probe`);
    }
  }
  assert.ok(!macro('z', 'linuxcnc', { pause: false }).gcode.includes('M0'), 'no pause when asked for none');
});

test('only G38.2 is used, so a probe that finds nothing stops the program', () => {
  for (const kind of KINDS) {
    const { gcode } = macro(kind, 'linuxcnc');
    assert.ok(!/G38\.[345]/.test(gcode), `${kind}: G38.3 and up do not alarm on a miss`);
    assert.ok(/G38\.2/.test(gcode));
  }
});

test('the output is ASCII, comments cannot break out, and GRBL gets no parameters or O-words', () => {
  const m = macro('edge', 'grbl', { wcs: 'G55' });
  assert.ok(/^[\x20-\x7e\n]*$/.test(m.gcode), 'ASCII only');
  assert.ok(!/[#[\]]|^O\d/m.test(m.gcode), 'no # parameters, expressions or O-words for GRBL');
  assert.ok(/G10 L20 P2 /.test(m.gcode), 'G55 is P2');
  for (const line of m.gcode.split('\n')) {
    if (line.startsWith('(')) assert.ok(!line.slice(1, -1).includes(')'), `a comment does not close early: ${line}`);
  }
});

test('the arithmetic: where the work is set is the probe radius back from the face it touched', () => {
  // moving +X onto a face with a 1.5mm tip: the centre stopped 1.5 short of it
  assert.ok(macro('edge', 'linuxcnc', { axis: 'X', direction: 1, radius: 1.5 }).gcode.includes('G10 L20 P1 X-1.5'));
  // moving -X it stopped 1.5 on the far side
  assert.ok(macro('edge', 'linuxcnc', { axis: 'X', direction: -1, radius: 1.5 }).gcode.includes('G10 L20 P1 X1.5'));
  // Z on a 20mm touch plate makes the surface 20 high
  assert.ok(macro('z', 'linuxcnc', { thickness: 20 }).gcode.includes('G10 L20 P1 Z20'));
  // the probe goes toward the work by the search distance, and slowly
  assert.ok(macro('z', 'linuxcnc', { travel: 12, feed: 60 }).gcode.includes('G38.2 Z-12 F60'));
});

test('it refuses numbers that would hurt, and says why, and a bore on GRBL, and a lathe', () => {
  assert.ok(probeMacro({ kind: 'z', feed: 0 }).error);
  assert.ok(probeMacro({ kind: 'z', feed: 5000 }).error, 'a probe is not fed at cutting speed');
  assert.ok(probeMacro({ kind: 'z', travel: 1e9 }).error);
  assert.ok(probeMacro({ kind: 'z', travel: NaN }).error);
  assert.ok(probeMacro({ kind: 'z', wcs: 'G99' }).error);
  assert.ok(probeMacro({ kind: 'edge', axis: 'Z' }).error);
  assert.ok(probeMacro({ kind: 'nonsense' }).error);
  assert.ok(probeMacro({ kind: 'bore', post: 'grbl' }).error, 'GRBL cannot hold what it measured');
  assert.ok(probeMacro({ kind: 'z', post: 'lathe' }).error);
  assert.ok(!probeMacro({ kind: 'z' }).error, 'and the defaults are fine');
});

test('a bore block averages the two walls it touched, on each axis', () => {
  const { gcode } = macro('bore', 'linuxcnc', { diameter: 20 });
  assert.eq((gcode.match(/G38\.2/g) || []).length, 6, 'a plus and a minus wall, on X, Y and X again');
  assert.ok(/G0 X\[\[#<xp> \+ #<xm>\] \/ 2\]/.test(gcode));
  assert.ok(/G0 Y\[\[#<yp> \+ #<ym>\] \/ 2\]/.test(gcode));
  assert.ok(gcode.includes('G10 L20 P1 X0 Y0'));
});
