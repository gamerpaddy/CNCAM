// The 5-axis beta's plumbing: the switch, and the two places the CL pipeline
// used to assume the tool always points up.

import { test, assert } from './runner.js';
import { CLBuilder, OP, FEED, MOVE_STRIDE } from '../engine/cl.js';
import {
  SETTINGS, SETTING_GROUPS, getSetting, setSetting, resetSettings,
  exportSettings, importSettings, fiveAxisEnabled,
} from '../app/settings.js';

/** retract, swing, descend at one XY — what every simultaneous op links with */
function linked(tilt) {
  const cl = new CLBuilder();
  cl.rapid(0, 0, 20);
  cl.rapid(5, 5, 20);                    // over the start of the pass
  cl.rapid(5, 5, 20.0001 - 0.0001);      // …a no-op the filter must not mistake for the swing
  if (tilt) cl.setAxis(0.5, 0, Math.sqrt(0.75));
  cl.rapid(5, 5, 20);                    // the swing
  cl.rapid(5, 5, 2);                     // the descent
  cl.cut(10, 5, 2, FEED.CUT);
  return cl.finish();
}

test('a rapid that swings the tool is not a redundant link, however vertical it is', () => {
  const flat = linked(false);
  const tilted = linked(true);
  assert.ok(tilted.count > flat.count - 1,
    `swing was dropped: ${tilted.count} moves against ${flat.count} flat`);
  // the swing is the move that lands at clearance with the new axis, and the
  // one after it (the descent) must carry the same axis, not the old one
  const axisAt = (p, n) => Array.from(p.moves.subarray(n * MOVE_STRIDE + 4, n * MOVE_STRIDE + 7));
  let swing = -1;
  for (let n = 0; n < tilted.count; n++) {
    if (axisAt(tilted, n)[0] > 0.1) { swing = n; break; }
  }
  assert.ok(swing > 0, 'no move carries the tilted axis');
  assert.close(tilted.moves[(swing - 1) * MOVE_STRIDE + 4], 0, 1e-9, 'move before the swing');
  assert.eq(tilted.moves[swing * MOVE_STRIDE], OP.RAPID);
});

test('a program that never tilts posts nothing different, and says so', () => {
  assert.eq(linked(false).fiveAxis, false);
  assert.eq(linked(true).fiveAxis, true);
});

test('a drill cycle is not a tilt: its axis slots hold retract, peck and dwell', () => {
  const cl = new CLBuilder();
  cl.rapid(0, 0, 20);
  cl.drill(0, 0, -5, { retractZ: 2, peck: 1, dwell: 0.5 });
  assert.eq(cl.finish().fiveAxis, false);
});

test('a lathe-style record with zeroed axis slots is not a tilt', () => {
  const cl = new CLBuilder();
  cl.setAxis(0, 0, 0);
  cl.rapid(0, 0, 5);
  cl.cut(1, 0, 0);
  assert.eq(cl.finish().fiveAxis, false);
});

test('the 5-axis beta is off by default, and the setting is in its own group', () => {
  resetSettings();
  assert.eq(fiveAxisEnabled(), false);
  const setting = SETTINGS.find((s) => s.key === 'fiveAxisBeta');
  assert.ok(setting, 'no fiveAxisBeta setting');
  assert.eq(setting.group, 'Experimental');
  assert.ok(SETTING_GROUPS.includes('Experimental'));
  assert.eq(setting.default, false);
});

test('the beta switch survives a preferences export and import', () => {
  resetSettings();
  setSetting('fiveAxisBeta', true);
  const text = exportSettings();
  resetSettings();
  assert.eq(fiveAxisEnabled(), false);
  importSettings(text);
  assert.eq(getSetting('fiveAxisBeta'), true);
  resetSettings();
});
