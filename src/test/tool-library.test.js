// The tool library: what it suggests, and what it remembers.
//
// The wizard's whole value is that a Ø1 cutter and a Ø20 cutter arrive with
// speeds two orders of magnitude apart instead of both getting 10000rpm. So the
// suggestions are checked against the hand-tuned presets, which are the only
// numbers in this app that a person sat down and chose.

import { test, assert } from './runner.js';
import {
  suggestCutting, suggestName, presetsFor, machineForType, machineCanHold, shankFor,
  allPresets, toolFromPreset, serializeLibrary, deserializeLibrary,
  toolWarnings, cuttingReadout, defaultsForType,
} from '../doc/tool-library.js';

test('suggested speeds land near the presets a person tuned by hand', () => {
  for (const preset of allPresets()) {
    const s = suggestCutting({
      type: preset.type, diameter: preset.diameter, flutes: preset.flutes,
      tipAngle: preset.tipAngle,
    });
    const rpmRatio = s.spindleRpm / preset.spindleRpm;
    const feedRatio = s.feedCut / preset.feedCut;
    assert.ok(rpmRatio > 0.55 && rpmRatio < 1.8,
      `${preset.name}: suggested ${s.spindleRpm}rpm against a tuned ${preset.spindleRpm}`);
    assert.ok(feedRatio > 0.5 && feedRatio < 2.1,
      `${preset.name}: suggested F${s.feedCut} against a tuned F${preset.feedCut}`);
  }
});

test('a small cutter is spun faster and fed slower than a big one', () => {
  const small = suggestCutting({ type: 'flat', diameter: 2 });
  const big = suggestCutting({ type: 'flat', diameter: 16 });
  assert.ok(small.spindleRpm > big.spindleRpm * 2, 'surface speed sets the rpm');
  assert.ok(small.feedCut < big.feedCut, 'and chip load scales with the cutter');
  assert.ok(small.fluteLength < big.fluteLength, 'as does a sensible flute length');
});

test('a spot drill is spun like a mill, not like a jobber drill', () => {
  const spot = suggestCutting({ type: 'drill', diameter: 10, tipAngle: 90 });
  const jobber = suggestCutting({ type: 'drill', diameter: 10, tipAngle: 118 });
  assert.ok(spot.spindleRpm > jobber.spindleRpm * 2,
    `spot ${spot.spindleRpm}rpm vs jobber ${jobber.spindleRpm}rpm`);
  assert.ok(spot.fluteLength < jobber.fluteLength / 3, 'and it is stubby, which is the point');
});

test('a drill is not spun like an end mill', () => {
  const drill = suggestCutting({ type: 'drill', diameter: 6, tipAngle: 118 });
  const mill = suggestCutting({ type: 'flat', diameter: 6 });
  assert.ok(drill.spindleRpm < mill.spindleRpm / 3,
    `a 6mm drill at ${drill.spindleRpm}rpm against a 6mm end mill at ${mill.spindleRpm}`);
});

test('a lathe feed is per revolution, and follows the bar not the insert', () => {
  const thin = suggestCutting({ type: 'turning', diameter: 6, workDiameter: 10 });
  const fat = suggestCutting({ type: 'turning', diameter: 6, workDiameter: 80 });
  assert.ok(thin.spindleRpm > fat.spindleRpm * 3,
    'a big bar turns slower for the same surface speed');
  // the insert is the same insert; only the work changed
  assert.ok(thin.feedCut > fat.feedCut, 'and the per-minute feed follows the rpm');
});

test('the shank is the collet size the cutter fits, never smaller than it', () => {
  assert.eq(shankFor(3), 3);
  assert.eq(shankFor(3.175), 4, 'a 1/8" cutter goes in a 4mm collet, not a 3mm one');
  assert.eq(shankFor(6), 6);
  assert.eq(shankFor(6.35), 8);
  assert.ok(shankFor(50) >= 50, 'and something enormous keeps its own shank');
});

test('a machine is only offered cutters it can hold', () => {
  const mill = presetsFor('mill').flatMap((g) => g.tools);
  const lathe = presetsFor('turn').flatMap((g) => g.tools);
  assert.ok(mill.length > 0 && lathe.length > 0, 'both machines have tooling');
  assert.ok(mill.every((t) => machineCanHold(t.type, 'mill')),
    'no lathe inserts in the mill list');
  assert.ok(lathe.every((t) => machineCanHold(t.type, 'turn')),
    'and no end mills in the turret');
  assert.ok(!lathe.some((t) => machineForType(t.type) === 'mill'
    && t.type !== 'drill' && t.type !== 'spot'),
  'the only milling cutters a lathe holds go down the axis: drills and centre drills');
  // Those are held by both, so the two lists overlap rather than partition —
  // which is the point: a lathe that could not offer a drill or a centre drill
  // had nothing to start a hole with.
  const together = new Set([...mill, ...lathe]);
  assert.eq(together.size, allPresets().length, 'and none went missing');
});

test('a suggested name says what the cutter is', () => {
  assert.eq(suggestName({ type: 'flat', diameter: 6, flutes: 3 }), '6mm flat 3FL');
  assert.eq(suggestName({ type: 'ball', diameter: 3 }), '3mm ball');
  assert.eq(suggestName({ type: 'bull', diameter: 10, cornerRadius: 2 }), '10mm bull r2');
  assert.eq(suggestName({ type: 'drill', diameter: 5 }), '5mm drill');
  // the two ends of the same cutter family read differently to a machinist
  assert.eq(suggestName({ type: 'chamfer', diameter: 6, tipAngle: 90 }), '6mm chamfer 90°');
  assert.eq(suggestName({ type: 'chamfer', diameter: 3.175, tipAngle: 30 }), '3.175mm V bit 30°');
  assert.eq(suggestName({ type: 'parting', diameter: 3, bladeWidth: 2 }), '2mm parting blade');
});

// --- the checks, and the one calibration that matters ----------------------

test('nothing in the library warns about itself', () => {
  // The bands in toolWarnings have no material to go on, so they are wide by
  // design — but a warning that fires on the app's own hand-tuned presets is a
  // warning nobody will read by the third tool. This is what keeps them honest.
  const noisy = allPresets()
    .map((p) => [p.name, toolWarnings(toolFromPreset(p, 1))])
    .filter(([, w]) => w.length > 0)
    .map(([name, w]) => `${name}: ${w[0]}`);
  assert.eq(noisy.join(' | '), '', 'every preset is quiet');
});

test('the checks catch what the fields let you type', () => {
  const has = (tool, re) => toolWarnings(toolFromPreset(tool, 1)).some((w) => re.test(w));
  assert.ok(has({ name: 'x', type: 'bull', diameter: 6, cornerRadius: 5 }, /ball nose/),
    'a corner radius bigger than the cutter');
  assert.ok(has({ name: 'x', type: 'boring', diameter: 12, minBore: 8, noseRadius: 0.4 }, /cannot go down/),
    'a bar that will not enter its own minimum bore');
  assert.ok(has({ name: 'x', type: 'turning', diameter: 12, noseRadius: 0 }, /nose radius/),
    'an insert with no nose radius to compensate');
  assert.ok(has({
    name: 'x', type: 'flat', diameter: 6, flutes: 2, spindleRpm: 12000, feedCut: 800, feedPlunge: 2000,
  }, /Plunging faster/), 'a plunge feed above the cutting feed');
  assert.ok(has({
    name: 'x', type: 'flat', diameter: 6, flutes: 2, spindleRpm: 12000, feedCut: 9000,
  }, /heavier chip/), 'a feed no chip load justifies');
  // and a jobber drill, which is 10xD by definition, is not a long-reach cutter
  assert.ok(!has({ name: 'x', type: 'drill', diameter: 3, fluteLength: 30, tipAngle: 118 }, /long-reach/),
    'a drill is allowed to be long');
});

test('the readout says what the speeds mean, in the units they are judged in', () => {
  // A ⌀6 three-flute at 10000rpm and 900mm/min: π×6×10000/1000 = 188 m/min,
  // and 900/(10000×3) = 0.03mm of chip per tooth. Arithmetic, not a model.
  const mill = cuttingReadout(toolFromPreset({
    name: 'x', type: 'flat', diameter: 6, flutes: 3, spindleRpm: 10000, feedCut: 900,
  }, 1));
  assert.close(mill.vc, 188.5, 0.5);
  assert.close(mill.load, 0.03, 0.001);
  assert.eq(mill.loadLabel, 'per tooth');

  // A lathe's surface speed is set by the *work*, and its feed is per
  // revolution however many edges the insert has.
  const lathe = cuttingReadout(toolFromPreset({
    name: 'x', type: 'turning', diameter: 12, noseRadius: 0.8, spindleRpm: 900, feedCut: 180,
  }, 1), { workDiameter: 30 });
  assert.close(lathe.vc, 84.8, 0.5, 'read against the bar, not the insert');
  assert.close(lathe.load, 0.2, 0.001);
  assert.eq(lathe.loadLabel, 'per rev');
});

test('changing family re-derives the sizes only that family has', () => {
  // The wizard's cards and the Type field in the properties panel are the same
  // decision; before they shared this, only the cards re-derived, so retyping
  // an end mill as a boring bar left three fields that decide whether it can
  // cut at all silently zero.
  const bar = defaultsForType('boring', { type: 'flat', diameter: 6, flutes: 3 });
  assert.eq(bar.type, 'boring');
  assert.ok(bar.diameter >= 10, `a ⌀${bar.diameter} bar is an end mill's diameter, not a bar's`);
  assert.ok(bar.noseRadius > 0, 'an insert with no nose cannot be compensated');
  assert.ok(bar.minBore > bar.diameter, 'and it needs a hole bigger than itself');

  // …and back the other way, where the ⌀12.7 of an insert is not an end mill
  const drill = defaultsForType('drill', { type: 'turning', diameter: 12.7, noseRadius: 0.8 });
  assert.eq(drill.tipAngle, 118);
  assert.eq(drill.noseRadius, 0);
  assert.eq(drill.flutes, 2, 'a drill has two flutes whatever was there before');
  assert.ok(drill.diameter < 12, `⌀${drill.diameter} carried the insert's size across`);

  // A size the family does have is kept: retyping a bull nose as a bull nose,
  // or nudging through one family to another, must not throw the number away.
  assert.eq(defaultsForType('bull', { type: 'bull', diameter: 10, cornerRadius: 2 }).cornerRadius, 2);
});

test('a library round-trips, and never carries ids or tool numbers back in', () => {
  const tools = [toolFromPreset({ name: 'a', type: 'flat', diameter: 6 }, 4)];
  const back = deserializeLibrary(serializeLibrary(tools));
  assert.eq(back.length, 1);
  assert.eq(back[0].name, 'a');
  assert.ok(back[0].id !== tools[0].id, 're-ided, so importing cannot collide');
});
