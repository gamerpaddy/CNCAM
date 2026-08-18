// The tool as a shape — the one description the icons, the 3D cutter and the
// reach checks all read from.
//
// These test the silhouette against what a machinist would measure with a rule:
// how long the thing is, how wide it gets, and how far down a slot it can go
// before something that is not the cutting edge meets the wall.

import { test, assert } from './runner.js';
import {
  toolSections, toolLength, toolMaxRadius, radiusAt, reachCheck,
  cuttingPoints, fluteLengthOf, tipAngleOf,
} from '../engine/tool-geometry.js';
import { generateToolpath } from '../engine/toolpath.js';
import { describeTool } from '../app/tool-shape.js';
import { makeBox } from './fixtures.js';

const FLAT = {
  type: 'flat', diameter: 6, fluteLength: 20,
  shank: [{ diameter: 6, length: 30 }],
  holder: [{ diameter: 40, length: 50 }],
};

test('a tool is flutes, then shank, then holder, stacked from the tip', () => {
  const sections = toolSections(FLAT);
  assert.eq(sections.map((s) => s.kind).join(','), 'cutting,shank,holder');
  assert.close(toolLength(FLAT), 100, 1e-6, '20 of flute + 30 of shank + 50 of holder');
  assert.close(toolMaxRadius(FLAT), 20, 1e-6, 'the holder is the widest part');

  // every section starts where the one below it ended, or the silhouette has a
  // gap in it and the revolved solid is in pieces
  for (let i = 1; i < sections.length; i++) {
    const below = sections[i - 1].points;
    assert.close(sections[i].points[0][1], below[below.length - 1][1], 1e-6);
  }
});

test('the silhouette climbs and never doubles back on itself', () => {
  for (const type of ['flat', 'ball', 'bull', 'drill', 'chamfer', 'face']) {
    const tool = { ...FLAT, type, cornerRadius: 1, tipAngle: 90, tipDiameter: 0.5 };
    let last = -1;
    for (const { points } of toolSections(tool)) {
      for (const [r, z] of points) {
        assert.ok(z >= last - 1e-9, `${type} steps back down at z=${z}`);
        assert.ok(r >= 0, `${type} has a negative radius`);
        last = z;
      }
    }
  }
});

test('the widest part at a height is what a reach check needs', () => {
  assert.close(radiusAt(FLAT, 0), 3, 1e-6, 'the cutter, at the tip');
  assert.close(radiusAt(FLAT, 10), 3, 1e-6, 'still the cutter, halfway up the flutes');
  assert.close(radiusAt(FLAT, 40), 3, 1e-6, 'the shank is the same size here');
  assert.close(radiusAt(FLAT, 60), 20, 1e-6, 'and the holder above it');
  assert.eq(radiusAt(FLAT, -1), 0, 'nothing below the tip');
});

test('a cutter is stopped by the first thing above it that is wider', () => {
  // a Ø3 V bit on a Ø4 collet shank: 8mm of flute and then it fouls
  const vbit = {
    type: 'chamfer', diameter: 3, tipAngle: 60, fluteLength: 8,
    shank: [{ diameter: 4, length: 30 }], holder: [{ diameter: 40, length: 50 }],
  };
  const reach = reachCheck(vbit, 20);
  assert.eq(reach.ok, false, '20mm deep is beyond it');
  assert.close(reach.maxDepth, 8, 1e-6);
  assert.eq(reach.kind, 'shank');
  assert.eq(reachCheck(vbit, 7).ok, true, 'but 7mm is fine');
});

test('a cutter whose shank matches it is limited only by the holder', () => {
  const reach = reachCheck(FLAT, 45);
  assert.close(reach.maxDepth, 50, 1e-6, 'the ⌀6 shank clears; the holder starts at 50');
  assert.eq(reach.kind, 'holder');
  assert.eq(reachCheck(FLAT, 45).ok, true);
  assert.eq(reachCheck(FLAT, 60).ok, false);
});

test('a tool with no shank or holder is still given one', () => {
  // an old project, or a hand-built tool. A cutter that stops at the top of its
  // flutes cannot foul anything, which is the one answer that is certainly wrong
  const bare = { type: 'flat', diameter: 6, fluteLength: 20 };
  const kinds = toolSections(bare).map((s) => s.kind);
  assert.ok(kinds.includes('shank') && kinds.includes('holder'), kinds.join(','));
  assert.ok(toolLength(bare) > 20, 'and it is longer than its flutes');
});

test('the cutting end matches the cutter family it belongs to', () => {
  const at = (pts, z) => pts.find((p) => Math.abs(p[1] - z) < 1e-6);
  // a ball nose reaches full radius exactly one radius up
  const ball = cuttingPoints({ type: 'ball', diameter: 8, fluteLength: 20 });
  assert.close(ball[ball.length - 2][0], 4, 1e-6);
  assert.close(ball[ball.length - 2][1], 4, 1e-6);
  // a bull nose is flat out to r − corner, then rolls
  const bull = cuttingPoints({ type: 'bull', diameter: 8, cornerRadius: 1, fluteLength: 20 });
  assert.ok(at(bull, 0), 'a bull nose has a flat on the bottom');
  assert.close(Math.max(...bull.filter((p) => p[1] === 0).map((p) => p[0])), 3, 1e-6);
  // a 90° point on a ⌀6 tool rises 3mm; a 118° one rises 1.80mm
  const ninety = cuttingPoints({ type: 'chamfer', diameter: 6, tipAngle: 90, fluteLength: 10 });
  assert.close(ninety[2][1], 3, 1e-6);
  const drill = cuttingPoints({ type: 'drill', diameter: 6, tipAngle: 118, fluteLength: 10 });
  assert.close(drill[2][1], 1.803, 0.002);
});

test('a tool with numbers missing is still drawable', () => {
  assert.eq(tipAngleOf({ type: 'drill' }), 118);
  assert.eq(tipAngleOf({ type: 'chamfer' }), 90);
  assert.eq(tipAngleOf({ type: 'flat' }), 0);
  assert.ok(fluteLengthOf({ diameter: 6 }) > 0, 'a missing flute length gets one');
  assert.ok(toolLength({}) > 0, 'and an empty object does not throw');
});

test('a blank point angle is the same angle everywhere it is written down', () => {
  // `tipAngleOf` is the one statement of what a pointed cutter cuts at: 90° for
  // a chamfer mill, 118° for a drill. Three places wrote the raw field instead
  // — the chamfer's own Result line, the preflight warning about a chamfer too
  // wide for its cutter, and the tool description in the list — so a tool made
  // by the wizard, which leaves the field at 0, was described as cutting at 0°
  // while being cut with at 90.
  const blank = {
    number: 1, type: 'chamfer', name: 'blank chamfer', diameter: 12, tipAngle: 0,
    tipDiameter: 0, flutes: 2, fluteLength: 10, spindleRpm: 9000, feedCut: 800, feedPlunge: 300,
  };
  assert.eq(tipAngleOf(blank), 90, 'a chamfer mill with no angle is a 90° one');
  assert.eq(tipAngleOf({ ...blank, type: 'drill' }), 118, 'and a drill is 118°');
  assert.ok(describeTool(blank).includes('90° point'),
    `the description says so too, got "${describeTool(blank)}"`);

  const cl = generateToolpath({
    type: 'chamfer', name: 'chamfer', tool: blank, mesh: makeBox(40, 40, 10),
    stock: { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] },
    params: {
      topZ: 10, bottomZ: 0, chamferWidth: 0.5, chamferClearance: 0.2,
      clearanceHeight: 15, tolerance: 0.01, stepdown: 1,
    },
  });
  const said = cl.notes.map((n) => n.text).join(' ');
  assert.ok(!/undefined|NaN/.test(said), `the report has no holes in it: ${said}`);
  assert.ok(/at 90°/.test(said), `and names the angle it cut at: ${said}`);
});
