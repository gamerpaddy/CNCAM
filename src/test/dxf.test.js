// DXF import, placement on the stock, and engraving what came in.
//
// The thing worth testing here is not "does it parse" — it is whether the shape
// that arrives is the shape that was drawn, at the size it was drawn, in the
// place the setup puts it. Every one of those has a way of being quietly wrong
// that produces a program which runs perfectly and cuts the wrong thing.

import { test, assert } from './runner.js';
import { parseDXF, totalLength, boundsOf } from '../io/dxf.js';
import { placedPaths, overhangOf, boundsOfPaths } from '../engine/drawing.js';
import { generateToolpath } from '../engine/toolpath.js';
import { eachMove, OP, FEED } from '../engine/cl.js';
import { makeBox } from './fixtures.js';

/** A minimal DXF, written as the group-code pairs the format actually is. */
function dxf(entities, { units = 4 } = {}) {
  const header = ['0', 'SECTION', '2', 'HEADER',
    '9', '$INSUNITS', '70', String(units), '0', 'ENDSEC'];
  return [...header, '0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC',
    '0', 'EOF'].join('\n');
}

const LINE = ['0', 'LINE', '8', 'outline',
  '10', '0', '20', '0', '11', '10', '21', '0'];

const SQUARE = ['0', 'LWPOLYLINE', '8', 'outline', '90', '4', '70', '1',
  '10', '0', '20', '0',
  '10', '20', '20', '0',
  '10', '20', '20', '10',
  '10', '0', '20', '10'];

const CIRCLE = ['0', 'CIRCLE', '8', 'holes', '10', '5', '20', '5', '40', '4'];

test('a line comes in as a line, in millimetres', () => {
  const { paths, units } = parseDXF(dxf(LINE));
  assert.eq(units, 1, 'a file in mm needs no scaling');
  assert.eq(paths.length, 1);
  assert.eq(paths[0].closed, false, 'a line is not a loop');
  assert.eq(paths[0].points.join(), '0,0,10,0');
  assert.eq(paths[0].layer, 'outline', 'the layer comes with it');
});

test('a drawing in inches arrives 25.4 times bigger', () => {
  const { paths } = parseDXF(dxf(LINE, { units: 1 }));
  assert.close(paths[0].points[2], 254, 1e-9, 'ten inches is 254mm');
});

test('and every other unit a drawing can be in arrives at its size', () => {
  // $INSUNITS as the DXF reference numbers them. 8 (microinches) and 14
  // (decimetres) were missing and fell back to millimetres, and 9 carried the
  // microinch label on the mil's number.
  const tenUnits = { 2: 3048, 5: 100, 6: 10000, 8: 10 * 2.54e-5, 9: 0.254, 13: 0.01, 14: 1000 };
  for (const [units, mm] of Object.entries(tenUnits)) {
    const { paths } = parseDXF(dxf(LINE, { units: Number(units) }));
    assert.close(paths[0].points[2], mm, mm * 1e-9, `ten of unit ${units} is ${mm}mm`);
  }
});

test('a closed polyline is closed, and its corners are where they were drawn', () => {
  const { paths } = parseDXF(dxf(SQUARE));
  assert.eq(paths.length, 1);
  assert.eq(paths[0].closed, true);
  const b = boundsOf(paths);
  assert.eq(b.min.join(), '0,0');
  assert.eq(b.max.join(), '20,10');
  // a closed rectangle is 2 × (20 + 10) round
  assert.close(totalLength(paths), 60, 1e-6);
});

test('a circle is round, not a polygon', () => {
  const { paths } = parseDXF(dxf(CIRCLE), { tolerance: 0.01 });
  const { points } = paths[0];
  assert.ok(paths[0].closed, 'a circle closes');
  for (let i = 0; i < points.length; i += 2) {
    assert.close(Math.hypot(points[i] - 5, points[i + 1] - 5), 4, 1e-9,
      'every point is on the circle');
  }
  // The chorded perimeter is always a little short of the true one — chords cut
  // the corner. A tenth of a percent on a Ø8 circle is a hundredth of a
  // millimetre over the whole way round, which no machine tool can express.
  const chorded = totalLength(paths);
  assert.ok(chorded < 2 * Math.PI * 4, 'chords are shorter than the arc');
  assert.ok(2 * Math.PI * 4 - chorded < 0.03, `circumference ${chorded} is visibly short`);
});

test('an arc runs counter-clockwise from its start angle to its end', () => {
  const { paths } = parseDXF(dxf(['0', 'ARC', '10', '0', '20', '0', '40', '10',
    '50', '0', '51', '90']));
  const { points } = paths[0];
  assert.close(points[0], 10, 1e-6, 'starts at 0°');
  assert.close(points[1], 0, 1e-6);
  assert.close(points[points.length - 2], 0, 1e-6, 'ends at 90°');
  assert.close(points[points.length - 1], 10, 1e-6);
  assert.close(totalLength(paths), (Math.PI * 10) / 2, 0.02, 'a quarter of a circle');
});

test('an arc drawn on a flipped plane lands where it was drawn', () => {
  // Extrusion 0,0,−1: the arc is in its own coordinates, whose X axis is world
  // −X, and it runs counter-clockwise *seen from below*. Centre (5,0), 0°→90°
  // in those coordinates is centre (−5,0), from 180° clockwise round to 90° in
  // the world — joined to a LINE that ends at (−15,0), which is in the world.
  const { paths } = parseDXF(dxf([
    '0', 'ARC', '10', '5', '20', '0', '40', '10', '50', '0', '51', '90',
    '210', '0', '220', '0', '230', '-1',
    '0', 'LINE', '10', '-15', '20', '-20', '11', '-15', '21', '0',
  ]));
  const arc = paths[0].points;
  assert.close(arc[0], -15, 1e-6, 'starts where the line ends, at world (−15, 0)');
  assert.close(arc[1], 0, 1e-6);
  assert.close(arc[arc.length - 2], -5, 1e-6, 'ends on top of its centre');
  assert.close(arc[arc.length - 1], 10, 1e-6);
  const line = paths[1].points;
  assert.close(line[2], arc[0], 1e-9, 'and the line meets it');

  // a circle and a polyline on that plane are mirrored the same way
  const flipped = parseDXF(dxf([
    '0', 'CIRCLE', '10', '5', '20', '5', '40', '4', '230', '-1',
    '0', 'LWPOLYLINE', '90', '2', '70', '0', '10', '1', '20', '0', '10', '3', '20', '0',
    '230', '-1',
  ])).paths;
  const circleXs = flipped[0].points.filter((_, i) => i % 2 === 0);
  assert.close((Math.min(...circleXs) + Math.max(...circleXs)) / 2, -5, 0.01, 'the circle is at x −5');
  assert.eq(flipped[1].points.join(), '-1,0,-3,0', 'the polyline at x −1…−3');
});

test('a bulged polyline segment is an arc, on the right segment', () => {
  // a square whose *second* segment bulges out into a semicircle
  const { paths } = parseDXF(dxf(['0', 'LWPOLYLINE', '90', '3', '70', '0',
    '10', '0', '20', '0',
    '10', '10', '20', '0', '42', '1',
    '10', '10', '20', '10']));
  const { points } = paths[0];
  // the straight first segment is untouched
  assert.eq(points[0], 0);
  assert.eq(points[1], 0);
  // bulge 1 is a half turn: the arc from (10,0) to (10,10) bows out to x = 15
  const maxX = Math.max(...points.filter((_, i) => i % 2 === 0));
  assert.close(maxX, 15, 0.05, 'the semicircle bows out by its radius');
  // and it is the second segment that bowed, not the first
  const firstSegmentX = points.slice(0, 4).filter((_, i) => i % 2 === 0);
  assert.eq(Math.max(...firstSegmentX), 10, 'the first segment stayed straight');
});

test('an unreadable entity is reported rather than dropped in silence', () => {
  const { paths, skipped } = parseDXF(dxf([
    ...LINE,
    '0', 'INSERT', '2', 'BLOCKNAME', '10', '0', '20', '0',
  ]));
  assert.eq(paths.length, 1, 'the line still came in');
  assert.eq(skipped.INSERT, 1, 'and the block reference said so');
});

// --- placement -------------------------------------------------------------

const STOCK = { kind: 'box', min: [-50, -30, -10], max: [50, 30, 0] };

test('a drawing centres itself on the billet', () => {
  const { paths, bounds } = parseDXF(dxf(SQUARE));
  const placed = placedPaths({ paths, bounds, placement: { origin: 'stock-center' } }, STOCK);
  const b = boundsOfPaths(placed);
  assert.close((b.min[0] + b.max[0]) / 2, 0, 1e-9, 'centred in X');
  assert.close((b.min[1] + b.max[1]) / 2, 0, 1e-9, 'centred in Y');
  assert.close(b.max[0] - b.min[0], 20, 1e-9, 'and not resized doing it');
});

test('scale, rotation and mirror all act about the same anchor', () => {
  const { paths, bounds } = parseDXF(dxf(SQUARE));
  const twice = placedPaths({
    paths, bounds, placement: { origin: 'stock-center', scale: 2 },
  }, STOCK);
  const b = boundsOfPaths(twice);
  assert.close(b.max[0] - b.min[0], 40, 1e-9, 'twice as wide');
  assert.close((b.min[0] + b.max[0]) / 2, 0, 1e-9, 'still centred');

  const turned = placedPaths({
    paths, bounds, placement: { origin: 'stock-center', rotationDeg: 90 },
  }, STOCK);
  const t = boundsOfPaths(turned);
  assert.close(t.max[0] - t.min[0], 10, 1e-6, 'a quarter turn swaps the extents');
  assert.close(t.max[1] - t.min[1], 20, 1e-6);
});

// Mirroring a stamp or a mould half is a gesture that changes which way round
// the drawing reads. It is not a gesture that moves it off the part — and in
// corner mode it did, because the corner being pinned was the one the drawing
// had *before* the transform. Reflected about its own left edge, all 20mm of a
// corner-pinned drawing landed at −20…0.
//
// Stated as the property rather than as coordinates: whatever the transform,
// the placed drawing's own reference point is the one the mode promises.
test('a turned or mirrored drawing keeps the corner it is pinned by', () => {
  const { paths, bounds } = parseDXF(dxf(SQUARE));
  const at = (placement) => boundsOfPaths(placedPaths({ paths, bounds, placement }, STOCK));

  for (const move of [{}, { mirrorX: true }, { rotationDeg: 90 }, { rotationDeg: -35 },
    { scale: 2 }, { mirrorX: true, rotationDeg: 90, scale: 1.5 }]) {
    const corner = at({ origin: 'stock-corner', ...move });
    assert.close(corner.min[0], STOCK.min[0], 1e-6, `pinned in X under ${JSON.stringify(move)}`);
    assert.close(corner.min[1], STOCK.min[1], 1e-6, `pinned in Y under ${JSON.stringify(move)}`);

    // the other mode was always right, and has to stay right
    const middle = at({ origin: 'stock-center', ...move });
    assert.close((middle.min[0] + middle.max[0]) / 2, 0, 1e-6,
      `centred in X under ${JSON.stringify(move)}`);
    assert.close((middle.min[1] + middle.max[1]) / 2, 0, 1e-6,
      `centred in Y under ${JSON.stringify(move)}`);
  }

  // a mirror is a reflection, not a move: same box, reversed contents
  const plain = at({ origin: 'stock-corner' });
  const flipped = at({ origin: 'stock-corner', mirrorX: true });
  assert.close(flipped.max[0] - flipped.min[0], plain.max[0] - plain.min[0], 1e-9, 'same width');
  assert.eq(overhangOf(placedPaths({ paths, bounds,
    placement: { origin: 'stock-corner', mirrorX: true } }, STOCK), STOCK), null,
  'and it is still on the billet');

  // 'as-drawn' means the file's own coordinates, so it turns about the file's
  // origin and is not re-pinned to anything
  const drawn = at({ origin: 'as-drawn', rotationDeg: 90 });
  assert.close(drawn.min[0], -bounds.max[1], 1e-6, 'as-drawn turns about 0,0');
});

test('a drawing bigger than the billet says so', () => {
  const { paths, bounds } = parseDXF(dxf(SQUARE));
  const fits = placedPaths({ paths, bounds, placement: {} }, STOCK);
  assert.eq(overhangOf(fits, STOCK), null, '20 × 10 fits on 100 × 60');

  const huge = placedPaths({ paths, bounds, placement: { scale: 20 } }, STOCK);
  const complaint = overhangOf(huge, STOCK);
  assert.ok(complaint && /off the billet/.test(complaint), `no warning: ${complaint}`);
});

// --- engraving what came in ------------------------------------------------

const VBIT = {
  number: 1, type: 'chamfer', name: '60° V bit', diameter: 3.175, tipAngle: 60,
  tipDiameter: 0.1, flutes: 1, fluteLength: 8, spindleRpm: 18000,
  feedCut: 500, feedPlunge: 150,
};

const ENGRAVE = {
  tolerance: 0.01, stepdown: 2, clearanceHeight: 5, entryGap: 1,
  topZ: 0, bottomZ: -0.3, direction: 'climb', side: 'on',
  engraveMode: 'depth', engraveLines: 'all',
};

test('engraving follows the drawing, not the part under it', () => {
  const { paths, bounds } = parseDXF(dxf([...SQUARE, ...CIRCLE]));
  const drawing = placedPaths({ paths, bounds, placement: { origin: 'as-drawn' } }, null);
  const cl = generateToolpath({
    type: 'engrave', name: 'mark', tool: VBIT, params: ENGRAVE,
    mesh: makeBox(200, 200, 10), drawing,
  });

  const cuts = [];
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.LINE && feed !== FEED.RAPID) cuts.push([x, y]);
  });
  assert.ok(cuts.length > 20, `nothing engraved: ${cuts.length} cutting moves`);

  // every cutting move is inside the drawing's own extent, which the 200mm box
  // it is being engraved onto is not
  for (const [x, y] of cuts) {
    assert.ok(x >= -0.01 && x <= 20.01 && y >= -0.01 && y <= 10.01,
      `cut at ${x},${y} is outside the drawing`);
  }
  assert.ok(!cl.notes.some((n) => n.level === 'warn'), 'and it did not complain');
});

test('an open drawn line is cut as a line, not closed into a loop', () => {
  const { paths, bounds } = parseDXF(dxf(LINE));
  const drawing = placedPaths({ paths, bounds, placement: { origin: 'as-drawn' } }, null);
  const cl = generateToolpath({
    type: 'engrave', name: 'scribe', tool: VBIT, params: ENGRAVE,
    mesh: makeBox(60, 60, 10), drawing,
  });
  // Moves that actually travel across the work — the plunge down to depth is a
  // feed move too and is not one of them.
  const travelled = [];
  let prev = null;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE) { prev = [x, y]; return; }
    if (feed !== FEED.RAPID && prev && Math.hypot(x - prev[0], y - prev[1]) > 1e-9) {
      travelled.push([x, y]);
    }
    prev = [x, y];
  });
  // one cut, end to end. A loop would come back to where it started.
  assert.eq(travelled.length, 1, 'a two-point line is one cutting move');
  assert.close(travelled[0][0], 10, 1e-6, 'ending at the far end of the line');
});

test('an engrave op with a drawing that has no lines says which is wrong', () => {
  const cl = generateToolpath({
    type: 'engrave', name: 'mark', tool: VBIT, params: ENGRAVE,
    mesh: makeBox(60, 60, 10), drawing: [],
  });
  assert.ok(cl.notes.some((n) => n.level === 'warn' && /drawing/.test(n.text)),
    'an empty drawing must not read as an empty part');
});

test('a spline given only by the points it passes through still comes in', () => {
  // no control polygon (10/20), only fit points (11/21): it used to arrive as
  // nothing at all, and nothing said an entity had been dropped
  const FIT = ['0', 'SPLINE', '8', 'curve', '70', '8', '71', '3', '74', '4',
    '11', '0', '21', '0', '11', '10', '21', '5', '11', '20', '21', '0', '11', '30', '21', '5'];
  const { paths, skipped } = parseDXF(dxf(FIT));
  assert.eq(paths.length, 1, `the curve is there, skipped: ${JSON.stringify(skipped)}`);
  const b = boundsOf(paths);
  assert.eq(`${b.min.join()} ${b.max.join()}`, '0,0 30,5', 'through the points it was given');
});
