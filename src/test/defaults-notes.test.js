// The application layer of "this operation did nothing".
//
// Every failure covered here looked, from the viewport, exactly like a broken
// strategy: an operation that ran, emitted a program, and cut nothing useful.
// None of them were geometry bugs. They were a facing pass told to go to the
// bottom of the part, a finishing pass given a roughing stepover, a parameter
// the UI offered and no strategy read, and a diagnosis printed somewhere the
// user never looks.

import { test, assert } from './runner.js';
import { makeBox, makeTube, makePocketBlock } from './fixtures.js';
import {
  createOperation, createTool, createSetup, createModel, createDrawing,
} from '../doc/schema.js';
import {
  formatTime, opPreflight, opFingerprint, toolNumberClashes,
} from '../app/op-status.js';
import { defaultParamsFor, retypeParams, depthRangeFor } from '../engine/op-defaults.js';
import { generateToolpath, toolpathStats } from '../engine/toolpath.js';
import { computeStock, depthPasses } from '../engine/stock.js';
import { computeBounds } from '../geom/mesh.js';
import { entryPlane, constrainHeights, heightLimits } from '../engine/heights.js';
import { findHoles } from '../engine/strategies/drill.js';
import { tipLengthOf } from '../engine/tool-geometry.js';
import { fixtureLoop, fixtureLoops, fixtureTop, createFixture } from '../engine/fixtures.js';
import { loopsBounds } from '../geom/clipper.js';
import { createMachine, machineWarnings } from '../doc/machines.js';
import { toolProfilePath } from '../app/tool-shape.js';
import { Document } from '../doc/document.js';
import { UndoStack } from '../doc/undo.js';
import { OP, FEED, eachMove } from '../engine/cl.js';
import { OP_PARAM_GROUPS, paramApplies } from '../app/op-params.js';
import { describeIntent } from '../app/op-catalog.js';
import { threadFormDepth, threadInfeed } from '../engine/strategies/turning.js';

/** A 40×40×10 part sitting in a billet with 1mm of margin all round. */
function scene(mesh = makeBox(40, 40, 10)) {
  const stock = computeStock([mesh], { kind: 'box-margin', margin: [1, 1, 1], marginBottom: 0 });
  return { mesh, stock, modelBounds: computeBounds(mesh.positions) };
}

function toolFor(type = 'flat', diameter = 6) {
  const tool = createTool(type);
  tool.diameter = diameter;
  tool.number = 1;
  return tool;
}

function build(type, { mesh, stock, modelBounds }, tool, extra = {}) {
  const op = createOperation(type);
  Object.assign(op.params, defaultParamsFor(type, { stock, modelBounds, tool }), extra);
  return generateToolpath({ type, name: type, tool, stock, mesh, params: op.params });
}

// --- per-strategy defaults ---

test('a new facing pass skims the stock margin instead of the whole part', () => {
  const s = scene();
  const { topZ, bottomZ } = depthRangeFor('face', s);
  assert.close(topZ, s.stock.max[2], 1e-9, 'starts at the stock top');
  assert.close(bottomZ, s.modelBounds.max[2], 1e-9, 'stops at the top of the part');
  // the bug this exists for: facing inherited "bottom = bottom of the model",
  // so a 1mm skim on a 10mm part rastered 11mm of air and material away
  assert.ok(bottomZ > s.modelBounds.min[2] + 5, 'does not descend to the part bottom');
});

test('every other strategy still reaches the bottom of the part', () => {
  const s = scene();
  for (const type of ['contour2d', 'clear2d', 'adaptive', 'pocket', 'parallel3d', 'waterline']) {
    const { bottomZ } = depthRangeFor(type, s);
    assert.close(bottomZ, s.modelBounds.min[2], 1e-9, `${type} goes to the part bottom`);
  }
});

test('finishing gets a finishing stepover and roughing a roughing one', () => {
  const tool = toolFor('ball');
  const finish = defaultParamsFor('parallel3d', { tool });
  const rough = defaultParamsFor('clear2d', { tool });
  assert.ok(finish.stepover < rough.stepover / 3,
    `finish stepover ${finish.stepover} is not meaningfully finer than ${rough.stepover}`);
});

test('stepdown scales with the cutter, and never exceeds its flute', () => {
  const small = defaultParamsFor('clear2d', { tool: toolFor('flat', 3) });
  const big = defaultParamsFor('clear2d', { tool: toolFor('flat', 12) });
  assert.ok(big.stepdown > small.stepdown, 'a bigger cutter takes a deeper pass');

  const stubby = toolFor('flat', 20);
  stubby.fluteLength = 5;
  const capped = defaultParamsFor('adaptive', { tool: stubby });
  assert.ok(capped.stepdown <= 5, `stepdown ${capped.stepdown} exceeds the 5mm flute`);
});

test('adaptive is born set up for the trade it exists to make', () => {
  const tool = toolFor('flat', 6);
  const adaptive = defaultParamsFor('adaptive', { tool });
  const zlevel = defaultParamsFor('clear2d', { tool });
  // a light radial bite is what pays for deep passes; inheriting Z-level
  // clearing's 2mm stepdown threw the whole strategy away
  assert.ok(adaptive.stepdown > zlevel.stepdown * 2, 'takes a much deeper pass');
  assert.ok(adaptive.engagement < 0.2, 'holds a light bite');
});

test('changing strategy moves the stepping and keeps the heights', () => {
  const tool = toolFor();
  const op = createOperation('clear2d');
  Object.assign(op.params, { topZ: -3, bottomZ: -25, clearanceHeight: 40, feedCut: 1234 });
  const next = retypeParams('parallel3d', op.params, { tool });

  assert.eq(next.topZ, -3, 'top height survives');
  assert.eq(next.bottomZ, -25, 'bottom height survives');
  assert.eq(next.clearanceHeight, 40, 'clearance survives');
  assert.eq(next.feedCut, 1234, 'a tuned feed survives');
  assert.ok(next.stepover < 0.2, 'but the stepover becomes a finishing one');
});

// --- notes reach the caller ---

test('a strategy that cuts nothing says so where the UI can read it', () => {
  const s = scene();
  // a pocket op on a part with no enclosed void: correct, and worth saying
  const cl = build('pocket', s, toolFor());
  const stats = toolpathStats(cl);
  assert.ok(stats.empty, 'nothing was cut');
  assert.ok(stats.warnings.length > 0, 'and a warning explains it');
  assert.ok(cl.events.some((e) => e.type === 'comment' && e.text === stats.warnings[0].text),
    'the same text still reaches the G-code');
});

test('a pass that cuts is not reported as a warning', () => {
  const s = scene();
  const stats = toolpathStats(build('contour2d', s, toolFor()));
  assert.ok(!stats.empty, 'contour cut something');
  assert.eq(stats.warnings.length, 0, 'and said nothing alarming');
  assert.ok(stats.cutLength > 100, `cut only ${stats.cutLength}mm`);
});

test('drilling names the sizes it found when none of them fit', () => {
  const s = scene(makeTube(0, 0, 20, 2.5, 10));
  const cl = build('drill', s, toolFor('drill', 6));
  const stats = toolpathStats(cl);
  assert.eq(stats.drills, 0, 'a 6mm drill does not go in a 5mm hole');
  // the message has to be actionable: "no holes" sends the user looking for a
  // modelling problem, "this part has ⌀5" sends them to the tool library
  assert.ok(/5\.0/.test(stats.warnings[0]?.text ?? ''),
    `unhelpful warning: ${stats.warnings[0]?.text}`);
});

// --- hole scanning ---

test('drilling finds a hole that does not break the top surface', () => {
  // a tube with a lid: the hole starts below the top face, so a single slice
  // taken just under the top finds nothing at all
  const tube = makeTube(0, 0, 20, 2.5, 10);
  const s = scene(tube);
  const holes = findHoles(tube, {
    topZ: s.modelBounds.max[2], bottomZ: s.modelBounds.min[2], bounds: s.modelBounds,
  });
  assert.eq(holes.length, 1, `expected one hole, got ${holes.length}`);
  assert.close(holes[0].r, 2.5, 0.05, 'measured its radius');
  assert.ok(holes[0].top - holes[0].bottom > 5, 'and how deep it runs');
});

test('drilling to each hole floor stops at the floor, not at Bottom Z', () => {
  const tube = makeTube(0, 0, 20, 2.5, 10);
  const s = scene(tube);
  const cl = build('drill', s, toolFor('drill', 5), { depthMode: 'hole', bottomZ: -500 });
  let deepest = 0;
  eachMove(cl, (op, x, y, z) => { if (op === OP.DRILL) deepest = Math.min(deepest, z); });
  assert.ok(deepest > -500, 'did not take the runaway Bottom Z');
  // A tube is a *through* hole, so the floor is the underside and the tip has
  // to come out of it: a ⌀5 drill ground at 118° is 1.50mm from tip to full
  // diameter, and anything less than that leaves the hole coned over.
  const point = tipLengthOf(toolFor('drill', 5));
  assert.close(deepest, s.modelBounds.min[2] - point, 0.01,
    `drilled to ${deepest}, expected the underside less the ${point.toFixed(2)}mm point`);
});

test('a hole that stops short of the underside gets no breakthrough', () => {
  // Bottom Z inside the part: the hole this operation is being asked to make
  // does not come out the other side, so there is nothing to break through and
  // the point stays in the metal.
  const tube = makeTube(0, 0, 20, 2.5, 10);
  const s = scene(tube);
  const cl = build('drill', s, toolFor('drill', 5), { depthMode: 'hole', bottomZ: 2 });
  let deepest = Infinity;
  eachMove(cl, (op, x, y, z) => { if (op === OP.DRILL) deepest = Math.min(deepest, z); });
  assert.close(deepest, 2, 0.01, `drilled past Bottom Z to ${deepest}`);
});

// --- the feed plane, which used to be a field nothing read ---

test('a pass starts feeding just above the level it is cutting from', () => {
  const params = { topZ: 0, clearanceHeight: 10, entryGap: 1 };
  // second pass of a multi-level cut: the level above is at -3, so feeding
  // starts at -2 and covers one stepdown — not the whole depth from the top
  assert.eq(entryPlane(params, -3, -6), -2, 'entered from the level above');
  assert.eq(entryPlane(params, 0, -3), 1, 'the first pass enters above the stock top');
  assert.eq(entryPlane({ ...params, entryGap: 0 }, -3, -6), -3, 'a zero gap lands on the surface');
});

test('the entry plane never rises above clearance or drops into the cut', () => {
  assert.eq(entryPlane({ topZ: 0, clearanceHeight: 10, entryGap: 50 }, 0, -3), null,
    'a gap past clearance is no saving, so there is no separate plane');
  // a level entered at its own depth (waterline, finish passes) still comes
  // down from clearance, and still stops the gap above the floor it lands on
  assert.eq(entryPlane({ topZ: 0, clearanceHeight: 10, entryGap: 1 }, -6, -6), -5,
    'a level entered at depth still gets an entry plane');
});

test('the stepdown survives the entry, not just the cutting levels', () => {
  // the bug: the last pass of a 30mm profile fed 32mm straight down in one
  // move, because the entry ignored the levels above it
  const s = scene(makeBox(40, 40, 30));
  const cl = build('contour2d', s, toolFor('flat', 6), { stepdown: 3, leadType: 'arc' });
  let deepestPlunge = 0;
  let prev = null;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.DRILL) return;
    if (prev && feed === FEED.PLUNGE) deepestPlunge = Math.max(deepestPlunge, prev[2] - z);
    prev = [x, y, z];
  });
  assert.ok(deepestPlunge <= 3 + 1 + 1e-6,
    `a single plunge dropped ${deepestPlunge.toFixed(2)}mm, more than a stepdown plus the entry gap`);
});

test('entries rapid down to the entry gap instead of feeding through air', () => {
  const s = scene(makePocketBlock().mesh);
  const tool = toolFor('flat', 4);
  const near = toolpathStats(build('clear2d', s, tool, { entryGap: 1 }));
  // a gap big enough to reach clearance is the old behaviour: feed the whole
  // way down from where the tool is already sitting
  const far = toolpathStats(build('clear2d', s, tool, { entryGap: 1000 }));

  assert.ok(near.cuts > 0, 'still cuts');
  assert.ok(near.cutLength < far.cutLength,
    `the entry gap did not shorten the fed distance (${near.cutLength} vs ${far.cutLength})`);
  assert.ok(near.seconds < far.seconds, 'and the cycle time came down with it');
});

// --- finish passes on the strategies that offer them ---

test('Z-level clearing spends its finish passes on the wall', () => {
  const s = scene(makePocketBlock().mesh);
  const tool = toolFor('flat', 4);
  const plain = toolpathStats(build('clear2d', s, tool, { stockToLeave: 0.5, finishPasses: 0 }));
  const finished = toolpathStats(build('clear2d', s, tool, { stockToLeave: 0.5, finishPasses: 2 }));
  assert.ok(finished.cutLength > plain.cutLength,
    'asking for finish passes added no cutting — the parameter was offered and ignored');
});

// --- program order is editable ---

test('an operation can be moved through the program, and undone back', () => {
  const doc = new Document();
  const setup = createSetup();
  doc.addSetup(setup);
  const names = ['rough', 'drill', 'finish'];
  for (const name of names) {
    const op = createOperation('contour2d');
    op.name = name;
    doc.addOperation(setup, op);
  }
  const order = () => setup.operations.map((o) => o.name);

  doc.reorderOperation(setup, 2, 0);
  assert.eq(order().join(), 'finish,rough,drill', 'moved to the front');
  doc.undo();
  assert.eq(order().join(), names.join(), 'and back again');
});

test('deleting an operation and undoing puts it back where it was', () => {
  const doc = new Document();
  const setup = createSetup();
  doc.addSetup(setup);
  const ids = [];
  for (const name of ['a', 'b', 'c']) {
    const op = createOperation('contour2d');
    op.name = name;
    ids.push(op.id);
    doc.addOperation(setup, op);
  }
  doc.removeOperation(ids[1]);
  assert.eq(setup.operations.map((o) => o.name).join(), 'a,c', 'removed');
  doc.undo();
  // order is machining order; undo used to push it back on the end, quietly
  // moving a finishing pass ahead of the roughing that feeds it
  assert.eq(setup.operations.map((o) => o.name).join(), 'a,b,c', 'restored in place');
});

// --- height ordering ---
//
// Bottom above Top was reachable by typing in a box or dragging a handle. It
// produced an operation that generated a program and machined nothing, with no
// error anywhere: the exact shape of "some toolpaths don't do anything".

test('the bottom of a cut cannot be put above its top', () => {
  const params = { topZ: 0, bottomZ: -10, clearanceHeight: 10 };
  const up = constrainHeights(params, 'bottomZ', 5);
  assert.ok(up.rejected, 'a bottom above the top was accepted');
  assert.eq(up.patch.bottomZ, -10, 'and the working value was kept');

  const down = constrainHeights(params, 'topZ', -20);
  assert.ok(down.rejected, 'a top below the bottom was accepted');
});

test('a rejected height is refused, not clamped to a cut one micron deep', () => {
  // clamping "5" to topZ - epsilon is technically in order and machines
  // nothing, which is the failure this rule exists to prevent
  const { patch } = constrainHeights({ topZ: 0, bottomZ: -10, clearanceHeight: 10 }, 'bottomZ', 5);
  assert.ok(patch.topZ - patch.bottomZ > 1, 'left a usable depth of cut');
});

test('raising the top of the cut lifts clearance out of the way', () => {
  const { patch, adjusted, rejected } = constrainHeights(
    { topZ: 0, bottomZ: -10, clearanceHeight: 10 }, 'topZ', 30);
  assert.ok(!rejected, 'the edit stands');
  assert.eq(patch.topZ, 30, 'at the value asked for');
  assert.ok(patch.clearanceHeight > 30, 'clearance got out of the way');
  assert.eq(adjusted.join(), 'clearanceHeight', 'and the UI is told which moved');
});

test('clearance may not be lowered into the cut', () => {
  const params = { topZ: 0, bottomZ: -10, clearanceHeight: 10 };
  assert.ok(constrainHeights(params, 'clearanceHeight', -3).rejected, 'below Top Z');
  assert.ok(!constrainHeights(params, 'clearanceHeight', 40).rejected, 'raising is always fine');
});

test('drag limits agree with what the typed fields allow', () => {
  const params = { topZ: 0, bottomZ: -10, clearanceHeight: 10 };
  assert.ok(heightLimits(params, 'bottomZ').max < params.topZ, 'bottom stops below top');
  assert.ok(heightLimits(params, 'topZ').min > params.bottomZ, 'top stops above bottom');
  assert.ok(heightLimits(params, 'clearanceHeight').min > params.topZ,
    'clearance stops above the top of the cut');
});

// --- undo stack bookkeeping ---

test('the undo stack reports its state to listeners, not its state a step ago', () => {
  const stack = new UndoStack();
  const seen = [];
  // running a command is what notifies the app, so what the app sees at that
  // moment has to be the state *after* the move, not before it
  const record = () => seen.push({ canUndo: stack.canUndo, canRedo: stack.canRedo });
  stack.push({ label: 'edit', do: record, undo: record });

  assert.eq(seen.at(-1).canUndo, true, 'doing an edit should leave something to undo');
  stack.undo();
  assert.eq(seen.at(-1).canRedo, true, 'undoing should leave something to redo');
  stack.redo();
  assert.eq(seen.at(-1).canUndo, true, 'redoing should leave something to undo again');
});

test('undo and redo name the edit they will act on', () => {
  const stack = new UndoStack();
  stack.push({ label: 'add operation', do: () => {}, undo: () => {} });
  assert.eq(stack.undoLabel, 'add operation', 'undo names the last edit');
  stack.undo();
  assert.eq(stack.redoLabel, 'add operation', 'redo names what was undone');
});

// --- contour: which profiles, which side, and holding tabs ---

test('cutting a part out follows its outline and stays out of its holes', () => {
  const tube = makeTube(0, 0, 20, 8, 10);      // Ø40 outside, Ø16 bore
  const s = scene(tube);
  const tool = toolFor('flat', 6);

  const radii = (profile) => {
    const cl = build('contour2d', s, tool, { profile });
    let min = Infinity;
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (op === OP.DRILL || feed === FEED.RAPID) return;
      min = Math.min(min, Math.hypot(x, y));
    });
    return min;
  };

  // the default job — "cut this part out" — must not send the cutter down the
  // bore on its way round the outside
  assert.ok(radii('outer') > 20, `outer profile reached in to r=${radii('outer').toFixed(1)}`);
  assert.ok(radii('all') < 12, 'every-profile should still machine the bore');
});

test('the tool side decides which way the cut is compensated', () => {
  const tube = makeTube(0, 0, 20, 8, 10);
  const s = scene(tube);
  const tool = toolFor('flat', 6);
  const outerRadius = (side) => {
    // lead moves arc in from off the path, so they sit outside the profile by
    // the lead radius; the compensation is the *cutting* radius
    const cl = build('contour2d', s, tool, { profile: 'outer', side, leadType: 'none' });
    let max = 0;
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (op === OP.DRILL || feed !== FEED.CUT) return;
      max = Math.max(max, Math.hypot(x, y));
    });
    return max;
  };
  // Ø40 part, Ø6 cutter: outside runs the centre at r=23, on the line at 20,
  // inside at 17
  assert.close(outerRadius('outside'), 23, 0.6, 'outside leaves the part');
  assert.close(outerRadius('on'), 20, 0.6, 'on the line');
  assert.close(outerRadius('inside'), 17, 0.6, 'inside opens the profile up');
});

test('a tab taller than the stepdown is still left standing', () => {
  const s = scene(makeBox(40, 40, 20));
  const tool = toolFor('flat', 6);
  const tabs = { tabCount: 4, tabWidth: 6, tabHeight: 5 };

  // 5mm of tab against a 2mm stepdown: the two passes above the tab top used to
  // machine straight through it, because only the final pass lifted over it. The
  // program looked right and the part came loose anyway.
  const cl = build('contour2d', s, tool, { ...tabs, stepdown: 2 });
  const floor = s.modelBounds.min[2];
  let lowestInTab = Infinity;
  let liftedMoves = 0;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.DRILL || feed === FEED.RAPID) return;
    if (z > floor + 1e-6 && z < floor + tabs.tabHeight + 1e-6) liftedMoves++;
    lowestInTab = Math.min(lowestInTab, z);
  });
  assert.ok(liftedMoves > 0, 'no moves were made over the tabs at all');

  // every pass that would have cut through the tab has to ride over it
  const levels = Math.ceil((s.stock.max[2] - floor) / 2);
  assert.ok(liftedMoves >= levels, `only ${liftedMoves} lifted moves for ${levels} passes`);
});

test('tabs leave material: the tab spans never reach the final depth', () => {
  const s = scene(makeBox(40, 40, 10));
  const cl = build('contour2d', s, toolFor('flat', 6),
    { tabCount: 3, tabWidth: 8, tabHeight: 2, stepdown: 5 });
  const floor = s.modelBounds.min[2];
  let atFloor = 0;
  let atTabTop = 0;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.DRILL || feed === FEED.RAPID) return;
    if (Math.abs(z - floor) < 1e-6) atFloor++;
    if (Math.abs(z - (floor + 2)) < 1e-6) atTabTop++;
  });
  assert.ok(atFloor > 0, 'the profile is cut through between the tabs');
  assert.ok(atTabTop > 0, 'and rides up over the tabs themselves');
});

// --- clamps and fixtures ---

test('a clamp footprint is the shape it was described as', () => {
  const box = fixtureLoop({ kind: 'box', center: [10, 5], size: [20, 10], rotationDeg: 0 });
  const b = loopsBounds([box]);
  assert.close(b.min[0], 0, 1e-6, 'left edge');
  assert.close(b.max[0], 20, 1e-6, 'right edge');
  assert.close(b.min[1], 0, 1e-6, 'front edge');
  assert.close(b.max[1], 10, 1e-6, 'back edge');

  const round = fixtureLoop({ kind: 'cylinder', center: [0, 0], diameter: 30 });
  for (let i = 0; i < round.length; i += 2) {
    assert.close(Math.hypot(round[i], round[i + 1]), 15, 0.05, 'on the rim');
  }
});

test('a rotated jaw turns about its own centre', () => {
  const turned = fixtureLoop({ kind: 'box', center: [0, 0], size: [20, 10], rotationDeg: 90 });
  const b = loopsBounds([turned]);
  assert.close(b.max[0] - b.min[0], 10, 1e-6, 'width and depth swapped');
  assert.close(b.max[1] - b.min[1], 20, 1e-6, 'about the centre, not a corner');
});

test('a disabled clamp stops constraining the toolpaths', () => {
  const fixtures = [
    { kind: 'box', center: [0, 0], size: [10, 10], enabled: true },
    { kind: 'box', center: [20, 0], size: [10, 10], enabled: false },
  ];
  assert.eq(fixtureLoops(fixtures).length, 1, 'only the live clamp counts');
});

test('clearing keeps the cutter out of a clamp that covers what it would machine', () => {
  // a block with a 20mm pocket at its centre: something worth machining in the
  // middle, which a plain billet does not have
  const s = scene(makePocketBlock().mesh);
  const tool = toolFor('flat', 6);
  const clamp = { kind: 'box', center: [0, 0], size: [24, 24], enabled: true };

  const cutsInside = (regions) => {
    const op = createOperation('clear2d');
    Object.assign(op.params, defaultParamsFor('clear2d', { ...s, tool }));
    const cl = generateToolpath({
      type: 'clear2d', name: 'c', tool, stock: s.stock, mesh: s.mesh, params: op.params, regions,
    });
    let inside = 0;
    eachMove(cl, (o, x, y, z, i, j, k, feed) => {
      if (o === OP.DRILL || feed === FEED.RAPID) return;
      // the tool centre must stay a radius clear of the clamp, so anything
      // within the footprint at all is a collision
      if (Math.abs(x - 20) < 12 && Math.abs(y - 20) < 12) inside++;
    });
    return inside;
  };

  // the fixture is in setup space, and makeBox spans 0..40, so a clamp at the
  // part centre sits at (20, 20) in part coordinates
  const withClamp = { include: [], avoid: fixtureLoops([{ ...clamp, center: [20, 20] }]) };
  assert.ok(cutsInside(null) > 0, 'the unclamped pass does machine that area');
  assert.eq(cutsInside(withClamp), 0, 'the clamped pass put the cutter inside the jaw');
});

test('a clamp taller than the clearance plane is named before it is hit', () => {
  // The keep-out a clamp imposes is a *footprint*, so every cut move already
  // avoids it perfectly — which is exactly what hides this. Clearance is a
  // height, and nothing compared the two: a toe clamp standing 25mm proud with
  // clearance left at its default 10 gives a program whose every "safe"
  // traverse goes straight through it, drawn in the backplot as a tidy orange
  // line over the part.
  const doc = new Document();
  const tool = createTool('flat');
  Object.assign(tool, { number: 1, diameter: 6, fluteLength: 25 });
  doc.addTool(tool);
  const model = createModel('part', 'part.stl');
  doc.addModel(model, makeBox(40, 40, 10));

  const setup = createSetup('Setup 1');
  const op = createOperation('clear2d');
  op.toolId = tool.id;
  Object.assign(op.params, { topZ: 0, bottomZ: -5, stepdown: 2, clearanceHeight: 10 });
  doc.addSetup(setup);
  doc.addOperation(setup, op);

  assert.ok(!opPreflight(doc, op).some((n) => /clearance/i.test(n)),
    'nothing to say with no clamp in the setup');

  const jaw = createFixture('box');
  Object.assign(jaw, { name: 'Jaw', baseZ: 0, height: 25 });
  doc.addFixture(setup, jaw);
  const warned = opPreflight(doc, op);
  assert.ok(warned.some((n) => /Jaw stands to Z25/.test(n)),
    `expected the clamp named, got ${warned}`);

  doc.updateItem(op.params, { clearanceHeight: 30 }, 'raise clearance');
  assert.ok(!opPreflight(doc, op).some((n) => /Jaw stands/.test(n)),
    'a clearance plane above the clamp is not warned about');
});

test('and the tallest clamp is the one that decides it', () => {
  const low = { kind: 'box', name: 'Low', baseZ: 0, height: 5, enabled: true };
  const tall = { kind: 'box', name: 'Tall', baseZ: -2, height: 20, enabled: true };
  assert.eq(fixtureTop([low, tall]).name, 'Tall', 'the one in the way');
  assert.close(fixtureTop([low, tall]).z, 18, 1e-9, 'measured from its own base');
  assert.eq(fixtureTop([low, { ...tall, enabled: false }]).name, 'Low',
    'a disabled clamp is not in the way');
  assert.eq(fixtureTop([]), null, 'and a setup with no clamps has no ceiling');
  // A chuck is a Z limit on a lathe and what the part stands on elsewhere,
  // not something the tool reaches over. See chuckLimit.
  assert.eq(fixtureTop([{ kind: 'chuck', name: 'Chuck', faceZ: 0, height: 60, enabled: true }]),
    null, 'a chuck is not an overhead obstacle');
});

test('a machine limit says which operation asks for it', () => {
  // "an operation asks for 12000 rpm" in a twelve-operation program is a
  // generate-open-tab-close-tab cycle to find out which one, and the app knows.
  const machine = createMachine({ kind: 'mill', spindleMin: 100, spindleMax: 8000, maxFeed: 5000 });
  const named = machineWarnings(machine, null, {
    maxRpm: 12000, minRpm: 12000, maxFeed: 9000,
    at: { maxRpm: 'Waterline finish', maxFeed: 'Face' },
  });
  assert.ok(named.some((w) => /Waterline finish asks for 12000 rpm/.test(w.text)),
    `expected the operation named, got ${named.map((w) => w.text)}`);
  assert.ok(named.some((w) => /Face feeds at 9000/.test(w.text)), 'and the feed too');

  // it still reads as a sentence when nothing knows the name
  const anonymous = machineWarnings(machine, null, { maxRpm: 12000, maxFeed: 9000 });
  assert.ok(anonymous.some((w) => /an operation asks for 12000 rpm/.test(w.text)));
  assert.ok(anonymous.some((w) => /a feed of 9000/.test(w.text)));
});

// --- tool shapes ---
//
// The drawing is the tool library's whole point: a name asks you to remember
// what "6mm bull r1" looks like, a picture tells you what the bottom of the
// cutter leaves in the part.

test('every cutter family draws a different shape', () => {
  // no tipAngle here: a drill and a chamfer mill ground to the same angle are
  // the same cone, and it is their default angles (118° and 90°) that tell them
  // apart on screen, along with the colour
  const base = { diameter: 6, fluteLength: 10, cornerRadius: 1.5 };
  const seen = new Map();
  for (const type of ['flat', 'ball', 'bull', 'drill', 'chamfer', 'face']) {
    const path = toolProfilePath({ ...base, type });
    assert.ok(!seen.has(path), `${type} draws the same shape as ${seen.get(path)}`);
    seen.set(path, type);
  }
});

/** The [x, y] points of an all-lines path, in drawing coordinates. */
function pathPoints(d) {
  return [...d.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
}

test('a ball nose is drawn as a hemisphere of its own radius', () => {
  // Checked as geometry rather than as an SVG arc command: the profile comes
  // from engine/tool-geometry.js, which polygonises so that the same points can
  // be revolved into the 3D cutter and evaluated for reach.
  const points = pathPoints(toolProfilePath({ type: 'ball', diameter: 8, fluteLength: 20 }));
  const nose = points.filter(([, y]) => y >= -4 - 1e-6 && y <= 1e-6);
  assert.ok(nose.length > 20, `only ${nose.length} points on the nose`);
  // every one of them a radius from the centre of the ball, which sits at r up
  for (const [x, y] of nose) {
    assert.close(Math.hypot(x, y + 4), 4, 0.02, `(${x}, ${y}) is not on the ball`);
  }
  assert.close(Math.max(...points.map(([x]) => x)), 4, 1e-6, 'and it is 8mm across');
});

test('the drawn point angle is the tip angle that was set', () => {
  // a 90° point on a Ø6 tool rises r/tan(45°) = 3mm; a 118° one rises ~1.80mm
  const shoulder = (tool) => {
    const points = pathPoints(toolProfilePath(tool));
    const widest = Math.max(...points.map(([x]) => x));
    // the lowest point at full diameter is where the cone meets the flutes
    return -Math.max(...points.filter(([x]) => Math.abs(x - widest) < 1e-6).map(([, y]) => y));
  };
  assert.close(shoulder({ type: 'chamfer', diameter: 6, tipAngle: 90, fluteLength: 10 }), 3, 0.01);
  assert.close(shoulder({ type: 'drill', diameter: 6, tipAngle: 118, fluteLength: 10 }), 1.803, 0.01);
});

test('a steep V bit is drawn as a cone, not as crossed triangles', () => {
  // A 3.175mm 30° V bit has a cone 5.9mm tall. The old drawing put the flutes
  // at a fixed stubby height and the cone shoulder at its true one, so the
  // shoulder ended up *above* the top of the tool and the outline crossed
  // itself — a bowtie of triangles pointing the wrong way.
  const points = pathPoints(toolProfilePath({
    type: 'chamfer', diameter: 3.175, tipAngle: 30, fluteLength: 12,
  }));
  const r = 3.175 / 2;
  assert.ok(r / Math.tan((15 * Math.PI) / 180) > 5.9, 'the cone really is taller than a stub');

  // walking up the right-hand side, the radius never decreases and the height
  // never decreases either: a cone, then a cylinder, in that order.
  // The silhouette is drawn up one side and back down the other, so the first
  // half of it is the right-hand profile.
  const right = points.slice(0, points.length / 2);
  for (let i = 1; i < right.length; i++) {
    assert.ok(right[i][0] >= right[i - 1][0] - 1e-6,
      `the outline steps back inward at ${JSON.stringify(right[i])}`);
    assert.ok(right[i][1] <= right[i - 1][1] + 1e-6,
      `the outline steps back down at ${JSON.stringify(right[i])}`);
  }
  // the path is rounded to a thousandth of a millimetre when it is written out
  assert.close(Math.max(...points.map(([x]) => x)), r, 0.001);
  assert.close(-Math.min(...points.map(([, y]) => y)), 12, 1e-6, 'as long as its flutes');
});

test('a bull nose with no corner radius is drawn as a flat', () => {
  const flat = toolProfilePath({ type: 'flat', diameter: 6, fluteLength: 10 });
  const bull = toolProfilePath({ type: 'bull', diameter: 6, cornerRadius: 0, fluteLength: 10 });
  assert.eq(bull, flat, 'a zero corner radius is a flat, and should look like one');
});

test('a corner radius cannot be drawn bigger than the cutter', () => {
  // r5 on a Ø3 tool is not a shape; capped, it is a ball nose, and it must not
  // produce a broken path either way
  const path = toolProfilePath({ type: 'bull', diameter: 3, cornerRadius: 5, fluteLength: 10 });
  assert.ok(!/NaN|undefined/.test(path), `degenerate path: ${path}`);
  const points = pathPoints(path);
  assert.close(Math.max(...points.map(([x]) => x)), 1.5, 1e-6, 'no wider than the cutter');
  assert.close(Math.min(...points.map(([, y]) => y)), -10, 1e-6, 'and as long as the flutes');
  // the corner is capped at the tool radius, which makes the end a full round
  assert.ok(points.some(([x, y]) => Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6),
    'the tip is on the axis');
});

// --- what the panels report ---

test('a time never rounds up into a field it has already printed', () => {
  // each field used to be rounded on its own, so the seconds could round up to a
  // whole minute and still be printed as seconds: "5m 60s" on the Result tab.
  assert.eq(formatTime(359.8), '6m 0s');
  assert.eq(formatTime(3599.7), '1h 0m');
  assert.eq(formatTime(59.6), '1m 0s');
  assert.eq(formatTime(0), '0s');
  assert.eq(formatTime(45), '45s');
  assert.eq(formatTime(125), '2m 5s');
  assert.eq(formatTime(3661), '1h 1m');
});

test('a drill sent deeper than its flutes says so before it is generated', () => {
  // bore, chamfer and every stepdown had a reach check; drilling — the one
  // operation that is entirely about depth — had none. The case that bites is a
  // spot drill, which is short on purpose.
  const doc = new Document();
  const spot = createTool('drill');
  Object.assign(spot, { number: 5, diameter: 10, fluteLength: 12, tipAngle: 90 });
  doc.addTool(spot);
  const setup = createSetup('Setup 1');
  const op = createOperation('drill');
  op.toolId = spot.id;
  Object.assign(op.params, { topZ: 0, bottomZ: -36 });
  doc.addSetup(setup);
  doc.addOperation(setup, op);

  const deep = opPreflight(doc, op);
  assert.ok(deep.some((n) => /12mm of flute/.test(n)), `expected a flute warning, got ${deep}`);

  doc.updateItem(spot, { fluteLength: 60 }, 'longer drill');
  assert.ok(!opPreflight(doc, op).some((n) => /flute/.test(n)),
    'a drill long enough for the hole is not warned about');
});

test('importing a model marks the operations that will now cut something else', () => {
  // A setup with no `modelIds` machines every model in the project, which is the
  // state of every setup the app makes — so the models it machines are not a
  // property of the setup and the fingerprint could not read them off it. It
  // compared `modelIds`, which stays empty however many models arrive, and a
  // second import silently moved the stock and every path in the job while the
  // tree went on showing them as up to date.
  const doc = new Document();
  const first = createModel('part');
  doc.addModel(first, makeBox(40, 40, 10));
  const setup = createSetup('Setup 1');
  const op = createOperation('contour2d');
  doc.addSetup(setup);
  doc.addOperation(setup, op);

  const before = opFingerprint(doc, op, setup);
  const second = createModel('another part');
  doc.addModel(second, makeBox(20, 20, 10));
  assert.ok(opFingerprint(doc, op, setup) !== before, 'the second model is a change');

  doc.removeModel(second.id);
  assert.eq(opFingerprint(doc, op, setup), before, 'and removing it again is not');

  // a setup pinned to its own models is genuinely unaffected by the rest
  doc.updateItem(setup, { modelIds: [first.id] }, 'pin');
  const pinned = opFingerprint(doc, op, setup);
  doc.addModel(createModel('a third'), makeBox(20, 20, 10));
  assert.eq(opFingerprint(doc, op, setup), pinned, 'a pinned setup ignores the others');
});

test('moving the drawing an operation follows marks it out of date', () => {
  // A DXF is placed on the billet — shifted, rotated, scaled, mirrored — and
  // every one of those is a field in the drawing panel that moves the cut.
  // None of it lives on the operation, so a fingerprint built from `op.params`
  // could not see it: rotating a square 30° and scaling it ×2 took the engraved
  // path from 80mm to 143mm while the operation went on reporting itself up to
  // date, which meant Simulate showed the old path and Export posted it.
  const doc = new Document();
  doc.addModel(createModel('part'), makeBox(40, 40, 10));
  const drawing = createDrawing('sq', 'sq.dxf',
    [{ points: [-10, -10, 10, -10, 10, 10, -10, 10], closed: true, layer: '0' }],
    { min: [-10, -10], max: [10, 10] });
  doc.addDrawing(drawing);
  const setup = createSetup('Setup 1');
  const op = createOperation('engrave');
  op.params.drawingId = drawing.id;
  doc.addSetup(setup);
  doc.addOperation(setup, op);

  const before = opFingerprint(doc, op, setup);
  for (const move of [{ offset: [15, 7] }, { rotationDeg: 30 }, { scale: 2 }, { mirrorX: true },
    { origin: 'stock-corner' }]) {
    const was = { ...drawing.placement };
    doc.updateItem(drawing.placement, move, 'move drawing');
    assert.ok(opFingerprint(doc, op, setup) !== before,
      `${Object.keys(move)[0]} moves the cut, so it has to read as out of date`);
    doc.updateItem(drawing.placement, was, 'put it back');
  }
  assert.eq(opFingerprint(doc, op, setup), before, 'and putting it back is not a change');

  // an operation that follows nothing is not touched by a drawing that moves
  doc.updateItem(op.params, { drawingId: null }, 'follow the part');
  const following = opFingerprint(doc, op, setup);
  doc.updateItem(drawing.placement, { offset: [40, 40] }, 'move drawing');
  assert.eq(opFingerprint(doc, op, setup), following, 'a drawing it does not follow is not its business');
});

test('every field of the cutter but its name is part of the fingerprint', () => {
  // The list used to be the milling ones — diameter, corner radius, tip angle —
  // so changing a turning insert's nose radius moved the finishing profile
  // (67.57mm → 67.24mm, 16 moves → 19) with nothing saying so, and the next
  // tool field to be added would have gone the same way. Naming the two that
  // cannot matter is a list that does not have to be maintained.
  const doc = new Document();
  doc.addModel(createModel('part'), makeBox(40, 40, 10));
  const tool = createTool('turning');
  doc.addTool(tool);
  const setup = createSetup('Setup 1', 'turn');
  const op = createOperation('turnFinish');
  op.toolId = tool.id;
  doc.addSetup(setup);
  doc.addOperation(setup, op);

  const before = opFingerprint(doc, op, setup);
  for (const [key, value] of Object.entries(tool)) {
    if (key === 'id' || key === 'name') continue;
    const changed = typeof value === 'number' ? value + 1
      : typeof value === 'string' ? `${value}x`
        : typeof value === 'boolean' ? !value : [...(value ?? []), { diameter: 1, length: 1 }];
    doc.updateItem(tool, { [key]: changed }, `set ${key}`);
    assert.ok(opFingerprint(doc, op, setup) !== before, `${key} has to read as out of date`);
    doc.updateItem(tool, { [key]: value }, `put ${key} back`);
  }
  assert.eq(opFingerprint(doc, op, setup), before, 'and every one of them put back is not a change');

  doc.updateItem(tool, { name: 'my favourite insert' }, 'rename');
  assert.eq(opFingerprint(doc, op, setup), before, 'renaming a cutter does not move a path');
});

test('two cutters on one T number are named as the clash they are', () => {
  // The T word is all the program says about which cutter to fit, and the post
  // drops a second change to a number already in the spindle — correctly, since
  // six operations sharing an end mill should not write six carousel cycles.
  // Give two cutters one number and that reasoning turns against you: the ⌀6
  // stays in the spindle and cuts the ⌀12 operation.
  const doc = new Document();
  doc.addModel(createModel('part'), makeBox(40, 40, 10));
  const small = toolFor('flat', 6);
  const big = toolFor('flat', 12);
  big.number = 2;
  doc.addTool(small);
  doc.addTool(big);
  const setup = createSetup('Setup 1');
  const op = createOperation('contour2d');
  op.toolId = small.id;
  doc.addSetup(setup);
  doc.addOperation(setup, op);

  assert.eq(toolNumberClashes(doc.project).size, 0, 'distinct numbers do not clash');
  assert.ok(!opPreflight(doc, op).some((n) => /different cutters/.test(n)), 'and nothing is said');

  doc.updateItem(big, { number: small.number }, 'collide');
  const clash = toolNumberClashes(doc.project);
  assert.eq(clash.size, 1, 'one number is shared');
  assert.eq(clash.get(1).length, 2, 'by two cutters');
  assert.ok(opPreflight(doc, op).some((n) => /different cutters/.test(n)),
    'and the operation holding it says so');
});

// --- fields the panel offers that nothing reads ---
//
// A knob that does nothing is not a cosmetic problem here: it reads as a
// promise about the cut. "Depth of cut (radial) 0.2" on a finishing pass says
// the insert takes two tenths; it takes the whole profile in one pass and
// always has. Each of these was found by changing one field at a time and
// comparing the programs byte for byte.

/** The parameter keys the properties panel shows for an operation. */
function offeredFields(type, params = {}) {
  const op = createOperation(type);
  Object.assign(op.params, params);
  const keys = [];
  for (const group of OP_PARAM_GROUPS) {
    for (const field of group.fields) if (paramApplies(field, op)) keys.push(field.key);
  }
  return keys;
}

test('a finishing turn offers no depth of cut, because it takes one pass', () => {
  // the claim underneath the panel: the strategy cannot see the field at all
  const mesh = makeTube(0, 0, 15, 0, 60, 48);
  const stock = computeStock([mesh], {
    kind: 'cylinder', cylinder: { diameter: 31, height: 70, align: 'center' },
  }, 'turn');
  const insert = toolFor('turning', 12);
  insert.noseRadius = 0.4;
  const program = (stepdown) => {
    const op = createOperation('turnFinish');
    Object.assign(op.params, {
      topZ: 55, bottomZ: 5, stepdown, stockToLeave: 0, tolerance: 0.05, clearanceX: 25,
    });
    const cl = generateToolpath({ type: 'turnFinish', tool: insert, stock, mesh, params: op.params });
    return Array.from(cl.moves.slice(0, cl.count * 8)).join(',');
  };
  assert.ok(program(0.2).length > 40, 'the pass cuts something to compare');
  assert.eq(program(0.2), program(5), 'a finishing pass is one pass at any stepdown');

  assert.ok(!offeredFields('turnFinish').includes('stepdown'),
    'turnFinish must not offer a stepdown');
  assert.eq(defaultParamsFor('turnFinish', { tool: toolFor('turning', 12) }).stepdown, undefined,
    'nor be born with one');
  // the fields it does live by are still there
  const fields = offeredFields('turnFinish');
  assert.ok(fields.includes('tolerance'), 'the tolerance is what decides its resolution');
  assert.ok(fields.includes('stockToLeave'), 'and the allowance is still a decision');
  // …and the preflight does not ask for the field that is gone
  const doc = new Document();
  doc.addModel(createModel('part'), makeBox(40, 40, 10));
  const tool = toolFor('turning', 12);
  tool.noseRadius = 0.4;
  doc.addTool(tool);
  const setup = createSetup('Setup 1', 'turn');
  const op = createOperation('turnFinish');
  op.toolId = tool.id;
  op.params.stepdown = 0;
  doc.addSetup(setup);
  doc.addOperation(setup, op);
  assert.ok(!opPreflight(doc, op).some((n) => /Stepdown is zero/.test(n)),
    'and nothing warns about a stepdown it does not have');
});

test('parting off offers one height, and internal work no clearance radius', () => {
  // the blade goes in at Bottom Z from wherever the bar is; nothing reads Top Z
  assert.ok(!offeredFields('turnPart').includes('topZ'), 'turnPart has one height');
  assert.ok(offeredFields('turnPart').includes('bottomZ'), 'and it is the one it uses');
  // a clearance *radius* is out past the bar, which is nowhere a centre drill
  // or a boring bar can go
  for (const type of ['turnDrill', 'turnBore']) {
    assert.ok(!offeredFields(type).includes('clearanceX'), `${type} works down the middle`);
  }
  for (const type of ['turnFace', 'turnRough', 'turnFinish', 'turnGroove', 'turnPart']) {
    assert.ok(offeredFields(type).includes('clearanceX'), `${type} travels round the outside`);
  }
});

test('choosing a surface speed and not setting one is said out loud', () => {
  const doc = new Document();
  doc.addModel(createModel('part'), makeBox(40, 40, 10));
  const tool = toolFor('turning', 12);
  tool.noseRadius = 0.4;
  doc.addTool(tool);
  const setup = createSetup('Setup 1', 'turn');
  const op = createOperation('turnRough');
  op.toolId = tool.id;
  doc.addSetup(setup);
  doc.addOperation(setup, op);

  const asks = () => opPreflight(doc, op).some((n) => /surface speed/.test(n));
  assert.ok(!asks(), 'nothing to say at a fixed rpm');
  doc.updateItem(op.params, { spindleMode: 'css' }, 'css');
  // G96 with no metres per minute posts G97 and says nothing — see applyCutting
  assert.ok(asks(), 'G96 with no speed is a setting that does nothing');
  doc.updateItem(op.params, { surfaceSpeed: 120 }, 'speed');
  assert.ok(!asks(), 'and the warning goes when the speed arrives');
});

// --- what the panel says the operation will do ---

test('the thread the panel describes is the thread that gets cut', () => {
  const tool = toolFor('threading', 6);
  const op = createOperation('turnThread');
  Object.assign(op.params, {
    topZ: 60, bottomZ: 39, threadPitch: 1.5, threadPasses: 6,
    threadFirstDepth: 0.25, threadDegression: 2, threadSpringPasses: 1,
  });
  // the count is a minimum: capping the first bite adds passes, and the
  // sentence used to report the six that were asked for against fifteen cut
  const scheduled = threadInfeed({
    depth: threadFormDepth(1.5, false), passes: 6, degression: 2,
    firstDepth: 0.25, spring: 1,
  }).length;
  assert.ok(scheduled > 6, 'this schedule really does grow');
  assert.ok(describeIntent(op, tool).includes(`${scheduled} passes`),
    `the panel says ${scheduled}: ${describeIntent(op, tool)}`);

  // and an internal thread has a form depth of its own
  op.params.threadInternal = true;
  const inside = describeIntent(op, tool);
  assert.ok(inside.includes('internal'), 'named as internal');
  assert.ok(!inside.includes('0.92mm deep'), `not the external form depth: ${inside}`);
});

test('a groove with no floor radius is not described as a part-off', () => {
  const tool = toolFor('grooving', 3);
  tool.bladeWidth = 3;
  const op = createOperation('turnGroove');
  Object.assign(op.params, { topZ: 58, bottomZ: 55 });
  assert.eq(op.params.grooveRadius, null, 'a new groove has no floor radius, deliberately');
  // `?? 0` turned that blank into ⌀0 — the centreline, which is the bar cut in
  // half. The strategy stopped doing it; the sentence had not.
  assert.ok(!/⌀0\b/.test(describeIntent(op, tool)),
    `blank is not zero: ${describeIntent(op, tool)}`);
  op.params.grooveRadius = 0;
  assert.ok(/centreline/.test(describeIntent(op, tool)),
    `and zero says what zero means: ${describeIntent(op, tool)}`);
});

test('the plunge count on screen is the plunge count in the program', () => {
  const tool = toolFor('grooving', 3);
  tool.bladeWidth = 3;
  const mesh = makeTube(0, 0, 15, 0, 60, 48);
  const stock = computeStock([mesh], {
    kind: 'cylinder', cylinder: { diameter: 31, height: 70, align: 'center' },
  }, 'turn');
  for (const stockToLeave of [0, 0.2]) {
    const op = createOperation('turnGroove');
    Object.assign(op.params, {
      topZ: 55, bottomZ: 45, grooveRadius: 11, stockToLeave, clearanceX: 25,
    });
    const cl = generateToolpath({ type: 'turnGroove', tool, stock, mesh, params: op.params });
    const said = /(\d+) plunges? of/.exec(cl.notes.map((n) => n.text).join(' '))?.[1];
    const panel = /in (\d+) plunges? of/.exec(describeIntent(op, tool))?.[1];
    assert.eq(panel, said, `leaving ${stockToLeave}mm: panel ${panel}, program ${said}`);
  }
});

test('the pass count on screen is the pass count in the program', () => {
  // The sentence is a check on the settings, so its numbers have to be the
  // strategy's. Two of them were not. The stepdown is a *limit* — the depth is
  // shared out evenly into passes that are all at most that — so a 20mm cut at
  // 3mm is seven of 2.86 and the panel said "seven passes of 3mm"; and the
  // clearing strategies add a level at every flat face of the part, so on a
  // part with a floor in it the count itself was short.
  const tool = createTool('flat');
  const { mesh, stock } = scene(makePocketBlock({
    size: 40, pocketSize: 20, height: 20, depth: 12,      // the floor is at Z8
  }).mesh);
  // Z8 is not one of the even levels for 20mm at a 3mm stepdown (17.14, 14.29,
  // 11.43, 8.57, 5.71, 2.86, 0), so a horizontal cut there is a flat level and
  // nothing else — which is how this asks the strategy rather than a list.
  const levelled = (cl) => {
    let prev = null;
    let found = false;
    eachMove(cl, (o, x, y, z, i, j, k, feed) => {
      if (prev && o === OP.LINE && feed !== FEED.RAPID
        && Math.abs(z - prev[2]) < 1e-6 && Math.abs(z - 8) < 0.02) found = true;
      prev = [x, y, z];
    });
    return found;
  };

  for (const type of ['contour2d', 'slot', 'clear2d', 'pocket', 'adaptive']) {
    const op = createOperation(type);
    Object.assign(op.params, {
      ...defaultParamsFor(type, { stock, tool }),
      topZ: 20, bottomZ: 0, stepdown: 3, stockToLeave: 0,
      tolerance: 0.05, clearanceHeight: 40,
    });
    const said = describeIntent(op, tool);
    const [, count, per] = /in (\d+) passe?s? of ([\d.]+)mm/.exec(said) ?? [];
    assert.ok(count, `${type} says how many passes: ${said}`);
    // the depth is the depth each pass takes, not the limit that was typed
    assert.close(Number(per), 20 / Number(count), 0.01,
      `${type} states the depth each pass takes: ${said}`);
    assert.eq(Number(count), depthPasses(20, 0, 3).length, `${type} counts the even passes`);

    const cl = generateToolpath({
      type, name: type, tool, mesh, stock, params: op.params, fixtures: [],
    });
    assert.eq(levelled(cl), / and one at each flat face/.test(said),
      `${type} ${levelled(cl) ? 'takes' : 'does not take'} a pass at the Z8 floor: ${said}`);
  }
});

test('an engraved mark is described at the depth it is cut, not the height it sits in', () => {
  // Bottom Z on an engrave is a floor the mark may not pass, and it arrives 5mm
  // under the face — so reading the depth off Top Z minus Bottom Z described a
  // three-tenths mark as five millimetres deep. That is the same reading of
  // those two heights that once had the strategy cutting through the part.
  const tool = createTool('chamfer');            // ⌀6, 90° point
  const { mesh, stock, modelBounds } = scene();
  const op = createOperation('engrave');
  Object.assign(op.params, defaultParamsFor('engrave', { stock, modelBounds, tool }));
  assert.ok(op.params.topZ - op.params.bottomZ > 1,
    'the two heights really are far apart on a new engrave');

  const byDepth = describeIntent(op, tool);
  assert.ok(byDepth.includes(`${op.params.engraveDepth}mm deep`),
    `the mark's own depth: ${byDepth}`);
  const cl = generateToolpath({
    type: 'engrave', tool, mesh, stock, params: op.params, fixtures: [],
  });
  const said = cl.notes.map((n) => n.text).join(' ');
  assert.ok(said.includes(`${op.params.engraveDepth.toFixed(3)}mm deep`),
    `and it is what the program says: ${said}`);

  // asked for a width, both convert it through the same point angle
  op.params.engraveMode = 'width';
  op.params.grooveWidth = 0.6;
  const byWidth = describeIntent(op, tool);
  assert.ok(byWidth.includes('0.6mm wide'), `the width asked for: ${byWidth}`);
  assert.ok(byWidth.includes('0.3mm deep'),
    `which a 90° point reaches at half of it: ${byWidth}`);
});
