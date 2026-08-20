// Lathe tooling and the operations that need it.
//
// The thread running through all of these is that a lathe is not a mill with
// different words. A lathe tool is not a solid of revolution, the work it holds
// is bar rather than a billet, what holds it takes away a Z rather than a patch
// of table, and half its operations work outward from the inside where every
// sign is reversed. Each of those was once implemented as "milling, but", and
// each produced a confident picture of the wrong thing.

import { test, assert } from './runner.js';
import {
  insertOutline, parseInsertCode, latheToolOutline, isLatheTool, insertIcOf,
  INSERT_SHAPES, INSERT_LETTERS, toolPose, effectiveLead, cornerAngleOf,
} from '../engine/insert.js';
import { toolSections, latheReachOf } from '../engine/tool-geometry.js';
import { toolFromPreset, allPresets, machineCanHold } from '../doc/tool-library.js';
import { computeStock, isRoundStock, deriveCylinder } from '../engine/stock.js';
import { createFixture, chuckLimit } from '../engine/fixtures.js';
import { boreProfile, hasBore, barFromStock, turningProfile } from '../engine/lathe.js';
import { generateToolpath, TURNING_OPS, toolpathStats } from '../engine/toolpath.js';
import { FEED, OP, eachMove } from '../engine/cl.js';
import { simulateTurning, SimulationPlayback, turnPositionAt } from '../engine/simulate.js';
import { threadFormDepth, threadInfeed } from '../engine/strategies/turning.js';
import { createOperation } from '../doc/schema.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { pickToolFor } from '../engine/tool-match.js';
import { makeShaft, makeTube, makeSteppedBore } from './fixtures.js';

const preset = (name) => allPresets().find((t) => t.name === name);
const tool = (name, number = 1) => toolFromPreset(preset(name), number);

/** Every point the tool feeds to, as [radius, 0, z] — see engine/lathe.js. */
function cutPoints(cl) {
  const pts = [];
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.LINE && feed !== FEED.RAPID) pts.push([x, y, z]);
  });
  return pts;
}

// --- insert geometry -------------------------------------------------------

test('an insert is the size its inscribed circle says, whatever its shape', () => {
  for (const letter of INSERT_LETTERS) {
    const { points } = insertOutline(letter, 12, 0.8);
    // the incircle touches every edge, so the nearest edge is at exactly IC/2
    let nearest = Infinity;
    for (let i = 0; i < points.length; i++) {
      const [x0, y0] = points[i];
      const [x1, y1] = points[(i + 1) % points.length];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      nearest = Math.min(nearest, Math.abs(dx * y0 - dy * x0) / len);
    }
    // a round insert is its own incircle, and chording it puts the edges a
    // hair inside — everything else lands on the nose
    const tolerance = letter === 'R' ? 0.05 : 0.001;
    assert.ok(Math.abs(nearest - 6) < tolerance,
      `${letter} has an inscribed circle of ${nearest.toFixed(3)}, expected 6`);
  }
});

test('a sharper corner reaches further out of the same inscribed circle', () => {
  // This is the whole trade the shape letter encodes: a V insert gets into a
  // corner a C cannot, and is a long thin spike doing it.
  const reach = (letter) => {
    const { points } = insertOutline(letter, 12, 0.4);
    return Math.max(...points.map(([x, y]) => Math.hypot(x, y)));
  };
  const order = ['S', 'C', 'T', 'D', 'V'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(reach(order[i]) > reach(order[i - 1]),
      `${order[i]} (${INSERT_SHAPES[order[i]].cornerAngle}°) should reach further `
      + `than ${order[i - 1]} (${INSERT_SHAPES[order[i - 1]].cornerAngle}°)`);
  }
  assert.ok(reach('R') < reach('S'), 'and a round insert reaches least of all');
});

test('every insert shape draws a different outline', () => {
  const seen = new Set();
  for (const letter of INSERT_LETTERS) {
    const key = insertOutline(letter, 12, 0.4).points
      .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
    assert.ok(!seen.has(key), `${letter} draws the same shape as another letter`);
    seen.add(key);
  }
});

test('an ISO designation is read for the three parts of it that are geometry', () => {
  const tnmg = parseInsertCode('TNMG160408');
  assert.eq(tnmg.insert, 'T');
  assert.eq(tnmg.insertIc, 9.6);
  assert.eq(tnmg.noseRadius, 0.8);

  const wnmg = parseInsertCode('WNMG080408');
  assert.eq(wnmg.insert, 'W');
  assert.eq(wnmg.insertIc, 12.7, 'a trigon\'s edge and its inscribed circle are not the same number');
  assert.eq(parseInsertCode('VNMG160404').noseRadius, 0.4);
  // the thickness field takes a letter on the thinner inserts
  assert.eq(parseInsertCode('CCMT09T304').insert, 'C');
  assert.eq(parseInsertCode('CCMT09T304').noseRadius, 0.4);
  // a round insert has no nose radius to quote: the edge is the radius
  assert.eq(parseInsertCode('RCMT1204M0').insert, 'R');
  assert.eq(parseInsertCode('RCMT1204M0').noseRadius, 6);
  assert.eq(parseInsertCode('6mm end mill'), null, 'and junk is rejected');
  assert.eq(parseInsertCode(''), null);
});

test('the nose radius is capped by the insert it is on', () => {
  // a 4mm nose on an IC 6 insert is not a rounded corner, it is a different
  // shape — and one that would swallow the corner it was drawn on
  const { points } = insertOutline('V', 6, 4);
  const reach = Math.max(...points.map(([x, y]) => Math.hypot(x, y)));
  assert.ok(Number.isFinite(reach) && reach > 0, 'the outline survives an absurd nose');
  assert.ok(points.length > 4, 'and is still a rounded polygon rather than a point');
});

// --- a lathe tool is not a milling cutter ----------------------------------

test('a lathe tool has no collet shank and no spindle holder invented for it', () => {
  for (const p of allPresets()) {
    const t = toolFromPreset(p, 1);
    if (!isLatheTool(t.type)) continue;
    assert.eq(t.shank.length, 0, `${t.name} was given a shank`);
    assert.eq(t.holder.length, 0, `${t.name} was given a holder`);
    // and the silhouette the reach check evaluates is the insert, not a
    // revolved end mill with a 40mm holder over it
    const sections = toolSections(t);
    assert.eq(sections.length, 1, `${t.name} revolves into more than its own insert`);
    assert.eq(sections[0].kind, 'cutting');
  }
});

test('a lathe tool is drawn as an insert and a holder that trails the cut', () => {
  const rougher = tool('CNMG 120408 rougher');
  const sections = latheToolOutline(rougher);
  assert.eq(sections.length, 2);
  assert.ok(sections.some((s) => s.kind === 'insert'));
  const holder = sections.find((s) => s.kind === 'holder');

  // A right-hand tool cuts travelling toward −Z, so its holder must sit at +Z,
  // in metal it has already removed. Drawn the other way it is permanently
  // buried in stock the tool has not reached — which is what "the tool sinks
  // into the model" was.
  const holderZ = holder.points.reduce((sum, [z]) => sum + z, 0) / holder.points.length;
  assert.ok(holderZ > 0, `the holder trails at Z${holderZ.toFixed(1)}, it should be positive`);

  const left = latheToolOutline({ ...rougher, hand: 'L' });
  const leftHolder = left.find((s) => s.kind === 'holder');
  const leftZ = leftHolder.points.reduce((sum, [z]) => sum + z, 0) / leftHolder.points.length;
  assert.ok(leftZ < 0, 'and a left-hand tool trails the other way');
});

test('the lead angle lays the major cutting edge where it says', () => {
  // The major edge should sit (90 − lead)° off the bar axis: 0° for a 90° tool
  // (pure OD turning, edge along the bar), swinging up as the lead falls toward
  // a facing tool. A sharp corner (no nose fillet) so the tip's two neighbours
  // are the straight edges themselves.
  for (const lead of [45, 62.5, 90, 95]) {
    const t = {
      type: 'turning', insert: 'C', insertIc: 12, noseRadius: 0, hand: 'R', leadAngle: lead, mountAngle: 0,
    };
    const insert = latheToolOutline(t, { holderLength: 20 }).find((s) => s.kind === 'insert').points;
    let ti = 0;
    let td = Infinity;
    insert.forEach((p, i) => { const d = Math.hypot(p[0], p[1]); if (d < td) { td = d; ti = i; } });
    const tip = insert[ti];
    const edgeAngle = (p) => Math.atan2(p[1] - tip[1], p[0] - tip[0]) * 180 / Math.PI;
    const want = 90 - lead;
    const edges = [insert[(ti - 1 + insert.length) % insert.length], insert[(ti + 1) % insert.length]]
      .map(edgeAngle);
    const major = edges.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
    assert.close(major, want, 1.5, `lead ${lead}: major edge at ${major.toFixed(1)}° off the bar`);
  }
});

test('a mount angle clocks the whole tool and moves the effective lead with it', () => {
  const base = {
    type: 'turning', insert: 'C', insertIc: 12, noseRadius: 0.4, hand: 'R', leadAngle: 95,
  };
  const rot = (t) => toolPose(t).rotationDeg;
  // mounting 5° clocks the pose by 5° and takes 5° off the lead the cut sees
  assert.close(rot({ ...base, mountAngle: 5 }) - rot(base), 5, 1e-9, 'the pose turns with the block');
  assert.close(effectiveLead({ ...base, mountAngle: 5 }), 90, 1e-9, 'a 95° tool mounted +5 cuts at 90');
  assert.close(effectiveLead({ ...base, mountAngle: -5 }), 100, 1e-9, 'and −5 the other way');
  // a bigger ground lead sweeps a C-insert tool further back
  assert.ok(rot({ ...base, leadAngle: 95 }) < rot({ ...base, leadAngle: 45 }), 'more lead, more sweep');
});

test('a custom insert takes its corner angle from the tool, not from a letter', () => {
  assert.eq(cornerAngleOf({ insert: 'X', insertAngle: 47 }), 47);
  assert.eq(cornerAngleOf({ insert: 'C' }), 80, 'a lettered insert keeps its own angle');
  // and it draws as a rhombus of that angle: a sharper corner reaches further
  // out of the same inscribed circle, exactly as the lettered shapes do
  const reach = (angle) => {
    const o = insertOutline('X', 12, 0, 6, angle);
    return Math.max(...o.points.map(([x, y]) => Math.hypot(x, y)));
  };
  assert.ok(reach(35) > reach(100), 'a 35° custom corner reaches further than a 100° one');
});

test('two tools of a different lead angle are drawn as different tools', () => {
  // The complaint this answers: every turning tool came out the same wedge. The
  // insert orientation now follows the lead, so a 62° profiler and a 95° turner
  // are not the same drawing.
  const outline = (lead) => latheToolOutline({
    type: 'turning', insert: 'C', insertIc: 12, noseRadius: 0.8, leadAngle: lead,
  }).find((s) => s.kind === 'insert').points;
  const a = outline(62.5);
  const b = outline(95);
  const moved = a.some((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]) > 0.5);
  assert.ok(moved, 'the two inserts no longer draw on top of each other');
});

test('a boring bar reaches into a hole, and says how far', () => {
  const bar = tool('S12M CCMT 06 bar ⌀12');
  assert.eq(bar.type, 'boring');
  assert.ok(bar.minBore > bar.diameter, 'it needs a hole bigger than itself to fit in');
  assert.eq(latheReachOf(bar), bar.maxDepth);
  // an external tool has no such limit; it is not down a hole
  assert.eq(latheReachOf(tool('CNMG 120408 rougher')), Infinity);
});

test('a lathe holds a drill, because that is what puts a hole down the axis', () => {
  assert.ok(machineCanHold('drill', 'turn'), 'a drill goes in the tailstock');
  assert.ok(machineCanHold('drill', 'mill'), 'and in the spindle');
  assert.ok(!machineCanHold('flat', 'turn'), 'but an end mill does not');
  assert.ok(!machineCanHold('turning', 'mill'), 'and an insert is not a milling cutter');
});

// --- stock ------------------------------------------------------------------

test('round stock resolves as round even before it has been sized', () => {
  const { mesh } = makeShaft();
  // A setup that says "bar" and has not been given a diameter still means bar.
  // Falling through to a box made a lathe setup plan against a rectangular
  // billet and draw one, while the panel said cylinder.
  const stock = computeStock([mesh], { kind: 'cylinder', cylinder: null });
  assert.eq(stock.kind, 'cylinder');
  assert.ok(stock.cylinder.diameter > 30, 'and sized to the part it will be cut from');
});

test('a bar is longer than the part at both ends, for different reasons', () => {
  const { mesh, zMin, zMax } = makeShaft();
  const derived = deriveCylinder([mesh]);
  const stock = computeStock([mesh], { kind: 'cylinder', cylinder: derived });
  // something to face
  assert.ok(stock.max[2] > zMax + 0.5,
    'the bar should stand proud of the free end so facing has something to cut');
  // something to hold
  assert.ok(zMin - stock.min[2] > 10,
    'and reach past the part so the chuck has something to grip');
});

test('a tube is a bar with a hole in it, and the hole is not material', () => {
  const tube = makeTube(0, 0, 20, 8, 50);
  const stock = computeStock([tube], {
    kind: 'tube',
    cylinder: { diameter: 44, innerDiameter: 14, height: 52, align: 'center', offset: [0, 0, 0] },
  });
  assert.eq(stock.kind, 'tube');
  assert.ok(isRoundStock(stock));
  assert.eq(stock.cylinder.innerDiameter, 14);

  const bar = barFromStock(stock, turningProfile(tube));
  assert.eq(bar.radius, 22);
  assert.eq(bar.innerRadius, 7);

  // solid bar reports no bore, so nothing downstream needs a second case
  const solid = computeStock([tube], {
    kind: 'cylinder',
    cylinder: { diameter: 44, height: 52, align: 'center', offset: [0, 0, 0] },
  });
  assert.eq(barFromStock(solid, turningProfile(tube)).innerRadius, 0);
});

test('a bore is only a bore where the part actually has one', () => {
  const tube = makeTube(0, 0, 20, 8, 50);
  const bored = boreProfile(tube);
  assert.ok(hasBore(bored), 'a tube has a bore');
  const inner = Math.max(...bored.r);
  assert.ok(Math.abs(inner - 8) < 0.5, `bore radius read as ${inner.toFixed(2)}, expected 8`);

  // A solid shaft must not report one. Its end faces are surfaces spanning
  // every radius from the axis outward, and reading the minimum there would
  // call the whole part a hole.
  const { mesh } = makeShaft();
  assert.ok(!hasBore(boreProfile(mesh)), 'a solid shaft has no bore anywhere');
});

// --- the chuck --------------------------------------------------------------

test('a chuck takes away a Z, not a patch of the table', () => {
  const chuck = createFixture('chuck');
  chuck.faceZ = -80;
  chuck.jawLength = 20;
  const limit = chuckLimit([chuck]);
  assert.eq(limit.z, -60, 'the tool cannot pass the front of the jaws');
  assert.eq(limit.mode, 'outside');

  assert.eq(chuckLimit([]), null, 'and a setup with no chuck has no limit');
  assert.eq(chuckLimit([{ ...chuck, enabled: false }]), null, 'a disabled one imposes none');

  // A collet grips all round with nothing standing out, so the limit is the
  // face itself rather than the face plus jaws.
  assert.eq(chuckLimit([{ ...chuck, chuckMode: 'collet' }]).z, -80);
});

test('a turning pass stops at the jaws and says so', () => {
  const { mesh } = makeShaft();
  const stock = computeStock([mesh], {
    kind: 'cylinder',
    cylinder: { diameter: 32, height: 62, align: 'center', offset: [0, 0, 0] },
  });
  const chuck = createFixture('chuck');
  chuck.faceZ = stock.min[2];
  chuck.jawLength = 20;

  const params = { ...createOperation('turnRough').params, topZ: stock.max[2], bottomZ: stock.min[2], stepdown: 2 };
  const cl = generateToolpath({
    type: 'turnRough', name: 'rough', params, tool: tool('CNMG 120408 rougher'),
    stock, mesh, fixtures: [chuck],
  });
  assert.ok(cl.notes.some((n) => n.level === 'warn' && /in the way/.test(n.text)),
    'a pass aimed behind the jaws must say so rather than generate as asked');

  // and nothing it emits goes past them
  const limit = chuckLimit([chuck]).z;
  let deepest = Infinity;
  for (let n = 0; n < cl.count; n++) deepest = Math.min(deepest, cl.moves[n * 8 + 3]);
  assert.ok(deepest >= limit - 1e-6,
    `the toolpath reaches Z${deepest.toFixed(2)}, past the jaws at Z${limit}`);
});

test('gripping a bore blocks the bore and leaves the outside clear', () => {
  const chuck = createFixture('chuck');
  chuck.chuckMode = 'inside';
  chuck.faceZ = -80;
  chuck.jawLength = 20;
  const { mesh } = makeShaft();
  const stock = computeStock([mesh], {
    kind: 'cylinder',
    cylinder: { diameter: 32, height: 62, align: 'center', offset: [0, 0, 0] },
  });
  const params = { ...createOperation('turnRough').params, topZ: stock.max[2], bottomZ: stock.min[2], stepdown: 2 };
  const cl = generateToolpath({
    type: 'turnRough', name: 'rough', params, tool: tool('CNMG 120408 rougher'),
    stock, mesh, fixtures: [chuck],
  });
  assert.ok(!cl.notes.some((n) => /in the way/.test(n.text)),
    'jaws inside the part do not block a cut on the outside of it');
});

// --- the new operations -----------------------------------------------------

const shaft = makeShaft();
// The bar the app would actually give this part: sized to it, proud of the free
// end so facing has something to cut, and long enough behind it to be held.
// Building one by hand here would test the operations against stock no lathe
// setup ever arrives with.
const SHAFT_STOCK = computeStock([shaft.mesh], {
  kind: 'cylinder',
  cylinder: deriveCylinder([shaft.mesh]),
});

function generate(type, overrides = {}, toolName = 'CNMG 120408 rougher') {
  const op = createOperation(type);
  Object.assign(op.params, defaultParamsFor(type, {
    stock: SHAFT_STOCK,
    modelBounds: { min: [0, 0, shaft.zMin], max: [0, 0, shaft.zMax] },
  }), overrides);
  return generateToolpath({
    type, name: type, params: op.params, tool: tool(toolName),
    stock: SHAFT_STOCK, mesh: shaft.mesh, fixtures: [],
  });
}

test('every turning strategy generates something from its own defaults', () => {
  const toolFor = {
    turnFace: 'CNMG 120408 rougher',
    turnRough: 'CNMG 120408 rougher',
    turnFinish: 'DCMT 070204 finishing',
    turnGroove: '3mm parting blade',
    turnThread: '16ER AG60 threading',
    turnDrill: '8mm drill',
    turnBore: 'S08K CCMT 04 bar ⌀8',
    turnPart: '3mm parting blade',
  };
  for (const type of TURNING_OPS) {
    assert.ok(toolFor[type], `${type} has no cutter named in this test`);
    const cl = generate(type, {}, toolFor[type]);
    // Boring is the one that legitimately produces nothing on a solid shaft —
    // there is no hole to open up — and it must say why rather than fail quietly.
    if (type === 'turnBore') {
      assert.ok(cl.notes.some((n) => n.level === 'warn' && /solid/.test(n.text)),
        'boring a solid part must explain that there is no hole to bore');
      continue;
    }
    assert.ok(cl.count > 0, `${type} emitted no moves from its own defaults`);
  }
});

test('a groove is walked out in overlapping plunges of the blade it has', () => {
  const cl = generate('turnGroove', {
    topZ: shaft.zMax - 2, bottomZ: shaft.zMax - 10, grooveRadius: 5, peck: 0,
  }, '3mm parting blade');
  const note = cl.notes.find((n) => /plunge/.test(n.text));
  assert.ok(note, 'grooving should report how many plunges it took');
  // 8mm of groove with a 3mm blade cannot be one plunge
  assert.ok(/[2-9] plunge/.test(note.text), `only one plunge: ${note.text}`);

  // and a groove narrower than the blade is refused rather than cut oversize
  const narrow = generate('turnGroove', {
    topZ: shaft.zMax - 2, bottomZ: shaft.zMax - 3, grooveRadius: 5,
  }, '3mm parting blade');
  assert.ok(narrow.notes.some((n) => n.level === 'warn' && /cannot fit/.test(n.text)));
});

test('threading shares the chip area out, not the depth', () => {
  // Every pass at the same depth increment removes more metal than the one
  // before it, because the groove widens as it deepens. Equal *depths* would
  // put several times the load of the first pass on the last one.
  assert.ok(Math.abs(threadFormDepth(1.5) - 0.92) < 0.005, 'ISO external form depth');
  assert.ok(threadFormDepth(1.5, true) < threadFormDepth(1.5), 'internal is shallower');

  const passes = 6;
  const cl = generate('turnThread', {
    topZ: shaft.zMax, bottomZ: shaft.zMax - 15, threadPitch: 1.5, threadPasses: passes,
    threadStartRadius: 8, threadFirstDepth: 0, threadSpringPasses: 0,
  }, '16ER AG60 threading');

  // the radius each pass cuts at, in order
  const depths = [];
  for (let n = 0; n < cl.count; n++) {
    const o = n * 8;
    if (cl.moves[o] === 1) depths.push(8 - cl.moves[o + 1]);   // OP.LINE
  }
  assert.eq(depths.length, passes, 'one cutting pass per depth');
  for (let i = 1; i < depths.length; i++) {
    assert.ok(depths[i] > depths[i - 1], 'each pass goes deeper than the last');
    const step = depths[i] - depths[i - 1];
    const prev = i > 1 ? depths[i - 1] - depths[i - 2] : Infinity;
    assert.ok(step <= prev + 1e-9,
      'and each step is no bigger than the one before — the load stays level');
  }
});

test('the first threading bite is capped, and the pass count grows to suit', () => {
  // Sharing the area out equally makes the *first* pass the deepest one there
  // is — 41% of the whole form in six passes, which is what "it goes to full
  // depth on the first pass" looks like on screen and at the machine.
  const depth = threadFormDepth(1.5);
  const bare = threadInfeed({ depth, passes: 6, firstDepth: 0 });
  assert.eq(bare.length, 6, 'the count is the count when nothing caps it');
  assert.ok(bare[0] / depth > 0.4, `an uncapped first pass takes ${bare[0].toFixed(3)}mm`);

  const capped = threadInfeed({ depth, passes: 6, firstDepth: 0.25, spring: 1 });
  assert.ok(capped[0] <= 0.25 + 1e-9, `first bite ${capped[0].toFixed(3)}mm is over the cap`);
  assert.ok(capped.length > 6, 'passes were added rather than the cap being ignored');
  assert.close(capped[capped.length - 1], depth, 1e-9, 'and it still reaches full depth');
  assert.close(capped[capped.length - 2], depth, 1e-9, 'the last one being a spring pass');

  // equal depth per pass is the other end of the same dial
  const flat = threadInfeed({ depth, passes: 4, degression: 1, firstDepth: 0 });
  assert.close(flat[0], depth / 4, 1e-9, 'degression 1 is equal depth per pass');
});

test('a left-hand thread is cut the other way along the bar', () => {
  const params = {
    topZ: shaft.zMax, bottomZ: shaft.zMax - 15, threadPitch: 1.5, threadPasses: 4,
    threadStartRadius: 8, threadFirstDepth: 0, threadSpringPasses: 0,
  };
  const runs = (hand) => {
    const cl = generate('turnThread', { ...params, threadHand: hand }, '16ER AG60 threading');
    const out = [];
    let prev = null;
    for (let n = 0; n < cl.count; n++) {
      const o = n * 8;
      // The synchronised cut only. A thread with no run-in space also emits a
      // radial *feed* to depth — an OP.LINE that does not move along Z at all —
      // and counting that as a pass reads as a pass going nowhere.
      const isCut = cl.moves[o] === 1 && cl.moves[o + 7] === FEED.CUT;
      if (isCut && prev !== null) out.push(cl.moves[o + 3] - prev);
      prev = cl.moves[o + 3];
    }
    return out.filter((d) => Math.abs(d) > 1e-6);
  };
  assert.ok(runs('right').every((d) => d < 0), 'a right-hand pass runs toward the chuck');
  assert.ok(runs('left').every((d) => d > 0), 'a left-hand pass runs out toward the free end');
});

test('boring works outward from the hole that is there', () => {
  const tube = makeTube(0, 0, 20, 8, 50);
  const stock = computeStock([tube], {
    kind: 'tube',
    cylinder: { diameter: 44, innerDiameter: 12, height: 52, align: 'center', offset: [0, 0, 0] },
  });
  const bar = tool('S08K CCMT 04 bar ⌀8');
  const params = {
    ...createOperation('turnBore').params,
    topZ: stock.max[2], bottomZ: stock.max[2] - 30, stepdown: 0.8, stockToLeave: 0.2,
  };
  const cl = generateToolpath({
    type: 'turnBore', name: 'bore', params, tool: bar, stock, mesh: tube, fixtures: [],
  });
  assert.ok(cl.count > 0, 'a tube gives boring something to do');

  // every cutting radius is inside the wall and outside the pilot
  let smallest = Infinity;
  let largest = 0;
  for (let n = 0; n < cl.count; n++) {
    const o = n * 8;
    if (cl.moves[o] !== 1) continue;
    smallest = Math.min(smallest, cl.moves[o + 1]);
    largest = Math.max(largest, cl.moves[o + 1]);
  }
  assert.ok(largest < 20, 'boring never cuts outside the part');
  assert.ok(smallest > 0, 'and never through the axis');
});

test('boring on solid bar takes its pilot from the part, not from a fraction', () => {
  // A boring bar cannot start from solid, so something opened the hole first —
  // and on a stepped bore that something is a drill the size of the narrowest
  // parallel section. What the fallback used to say instead was `target * 0.4`:
  // on a ⌀20/⌀12 bore it announced a ⌀8 pilot, and where the bar needed a ⌀12
  // hole it then refused to cut because of a number it had invented itself.
  //
  // ⌀20 for the first 20mm in from the free end, ⌀12 the rest of the way.
  const part = makeSteppedBore();
  const stock = computeStock([part], {
    kind: 'cylinder',
    cylinder: { diameter: 44, height: 50, align: 'center', offset: [0, 0, 0] },
  });
  const bar = tool('S08K CCMT 04 bar ⌀8');       // needs a ⌀10 hole
  const cl = generateToolpath({
    type: 'turnBore',
    name: 'bore',
    params: {
      ...createOperation('turnBore').params,
      topZ: stock.max[2], bottomZ: stock.min[2], stepdown: 0.8, stockToLeave: 0.2,
    },
    tool: bar,
    stock,
    mesh: part,
    fixtures: [],
  });
  const note = cl.notes.map((n) => n.text).join(' ');
  assert.ok(cl.count > 0, `it must open the ⌀20 out of the ⌀12 that is there — ${note}`);
  assert.ok(/from ⌀12\.00/.test(note), `the pilot is the part's own ⌀12: ${note}`);
  // and no pass may start inside the drilled hole
  for (const [radius] of cutPoints(cl)) {
    assert.ok(radius >= 5.9, `a pass at ⌀${(radius * 2).toFixed(2)} is inside the pilot`);
  }
});

test('a boring bar refuses a hole it cannot fit down', () => {
  const tube = makeTube(0, 0, 20, 8, 50);
  const stock = computeStock([tube], {
    kind: 'tube',
    cylinder: { diameter: 44, innerDiameter: 8, height: 52, align: 'center', offset: [0, 0, 0] },
  });
  const bar = tool('S16Q DCMT 07 bar ⌀16');    // needs a ⌀21 hole
  const params = {
    ...createOperation('turnBore').params,
    topZ: stock.max[2], bottomZ: stock.max[2] - 20,
  };
  const cl = generateToolpath({
    type: 'turnBore', name: 'bore', params, tool: bar, stock, mesh: tube, fixtures: [],
  });
  assert.eq(cl.count, 0, 'it must not generate a path it cannot run');
  assert.ok(cl.notes.some((n) => n.level === 'warn' && /needs a/.test(n.text)));
});

// --- the simulation ---------------------------------------------------------

test('the turning simulation says how deep a cut each pass takes', () => {
  // The lathe half of the milling load reading. There is no radial *width* to
  // hold a lathe tool to — the tool is a corner, not a disc — so the number
  // that decides whether the cut is heavy is the depth of cut, which is how far
  // the bar's radius drops under the insert.
  const at = (stepdown) => {
    const cl = generate('turnRough', {
      topZ: SHAFT_STOCK.max[2], bottomZ: SHAFT_STOCK.min[2] + 2, stepdown,
    });
    const bar = barFromStock(SHAFT_STOCK, turningProfile(shaft.mesh));
    return simulateTurning({ bar, ops: [{ cl, tool: tool('CNMG 120408 rougher') }] }).load;
  };
  const light = at(0.5);
  const heavy = at(2);
  assert.ok(light.peakDepth > 0, 'a roughing pass cuts something');
  assert.ok(light.peakDepth <= 0.5 + 0.25,
    `a 0.5mm depth of cut reads ${light.peakDepth.toFixed(2)}mm`);
  assert.ok(heavy.peakDepth > light.peakDepth,
    `${heavy.peakDepth.toFixed(2)}mm at a 2mm setting against `
    + `${light.peakDepth.toFixed(2)}mm at 0.5 — the reading follows the setting`);
  assert.ok(heavy.peakDepth <= 2 + 0.3, `and stays inside it: ${heavy.peakDepth.toFixed(2)}mm`);
});

test('turning removes the metal where the tool is, not all at once', () => {
  // A roughing pass is one CL move sixty millimetres long. Recording one event
  // step for it made the whole length of bar vanish on a single frame, which is
  // a picture of a diameter changing rather than of turning.
  const cl = generate('turnRough', {
    topZ: SHAFT_STOCK.max[2], bottomZ: SHAFT_STOCK.min[2] + 2, stepdown: 1.5,
  });
  const bar = barFromStock(SHAFT_STOCK, turningProfile(shaft.mesh));
  const sim = simulateTurning({ bar, ops: [{ cl, tool: tool('CNMG 120408 rougher') }] });

  assert.ok(sim.stepCount > cl.count * 5,
    `${sim.stepCount} steps for ${cl.count} moves — the moves are not being walked`);

  const withEvents = new Set();
  for (let i = 0; i < sim.eventCount; i++) withEvents.add(sim.evStep[i]);
  assert.ok(withEvents.size > 50,
    `metal comes off on only ${withEvents.size} steps — it is still arriving in lumps`);

  // and the diameter at one point along the bar comes down in stages
  const playback = new SimulationPlayback(sim);
  const probe = Math.floor(sim.count * 0.85);
  const radii = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    playback.seek(Math.floor(sim.stepCount * f));
    return playback.current[probe];
  });
  for (let i = 1; i < radii.length; i++) {
    assert.ok(radii[i] <= radii[i - 1] + 1e-6, 'the bar never grows back');
  }
  assert.ok(radii[0] - radii[radii.length - 1] > 1, 'and it does come down');
  assert.ok(radii[2] < radii[0] - 0.5 && radii[2] > radii[4] + 0.1,
    'halfway through the program the part is halfway roughed, not finished');
});

test('the simulation tracks where the tool actually was', () => {
  // Subdividing means a step is no longer a move, so the cutter cannot be found
  // by indexing into the CL — the record carries its own track instead.
  const cl = generate('turnRough', { stepdown: 2 });
  const ops = [{ cl, tool: tool('CNMG 120408 rougher') }];
  const bar = barFromStock(SHAFT_STOCK, turningProfile(shaft.mesh));
  const sim = simulateTurning({ bar, ops });

  assert.eq(sim.trackX.length, sim.stepCount + 1, 'one tool position per step');
  assert.eq(sim.trackZ.length, sim.trackX.length);
  for (const step of [0, Math.floor(sim.stepCount / 2), sim.stepCount]) {
    const at = turnPositionAt(sim, ops, step);
    assert.ok(at && Number.isFinite(at.position[0]) && Number.isFinite(at.position[2]),
      `no tool position at step ${step}`);
    assert.ok(at.tool, 'and it knows which tool is cutting');
  }
});

test('drilling and boring open a hole rather than doing nothing', () => {
  // The surface used to be the outside of the bar alone, so a drill worked
  // inside a solid that had no inside and left no mark at all.
  const cl = generate('turnDrill', {
    topZ: shaft.zMax, bottomZ: shaft.zMax - 25, peck: 3,
  }, '8mm drill');
  const bar = barFromStock(SHAFT_STOCK, turningProfile(shaft.mesh));
  const sim = simulateTurning({ bar, ops: [{ cl, tool: tool('8mm drill') }] });
  assert.eq(sim.initial.length, sim.count * 2, 'the surface is an outside and a bore');

  const playback = new SimulationPlayback(sim);
  playback.seek(sim.stepCount);
  const zAt = (z) => Math.round((z - sim.zMin) / sim.dz);
  const drilled = sim.count + zAt(shaft.zMax - 10);
  const beyond = sim.count + zAt(shaft.zMax - 40);
  assert.ok(Math.abs(playback.current[drilled] - 4) < 0.6,
    `the hole should be ⌀8 where the drill reached, got ⌀${(playback.current[drilled] * 2).toFixed(2)}`);
  assert.eq(playback.current[beyond], 0, 'and there should be no hole past the bottom of it');
});

test('a new turning operation arrives holding a cutter that can do the job', () => {
  const rack = [
    tool('CNMG 120408 rougher', 1),
    tool('DCMT 070204 finishing', 2),
    tool('3mm parting blade', 3),
    tool('16ER AG60 threading', 4),
    tool('8mm drill', 5),
    tool('S08K CCMT 04 bar ⌀8', 6),
  ];
  const expected = {
    turnFace: 'turning',
    turnRough: 'turning',
    turnFinish: 'turning',
    turnGroove: 'parting',
    turnThread: 'threading',
    turnDrill: 'drill',
    turnBore: 'boring',
    turnPart: 'parting',
  };
  for (const [type, family] of Object.entries(expected)) {
    const picked = pickToolFor(type, rack);
    assert.ok(picked, `${type} was given no cutter at all`);
    assert.eq(picked.type, family, `${type} should reach for a ${family} tool`);
  }
  // a blade cannot turn a profile, so it is never offered for one
  assert.eq(pickToolFor('turnRough', [tool('3mm parting blade', 1)]), null);
});

test('the insert size is read from the insert, not from a diameter it has not got', () => {
  const t = tool('WNMG 080408 rougher');
  assert.eq(insertIcOf(t), 12.7);
  // an old project's tool has no insertIc; the diameter field was already
  // being used for the insert size, so that is what it falls back to
  assert.eq(insertIcOf({ type: 'turning', diameter: 9.525 }), 9.525);
});

test('a thread with no run-in space says so instead of plunging into the bar', () => {
  // The reported repro: rough to size, then thread on one of the diameters.
  // The diameter runs on past the thread, so `Top Z + two pitches` — where the
  // tool has to be at full form depth before the synchronised pass starts — is
  // inside solid stock. Every pass rapided to depth there.
  const params = {
    topZ: shaft.zMax - 5, bottomZ: shaft.zMax - 20, threadPitch: 1.5,
    threadFirstDepth: 0, threadSpringPasses: 0,
  };
  const cl = generate('turnThread', params, '16ER AG60 threading');
  const said = cl.notes.filter((n) => n.level === 'warn').map((n) => n.text).join(' ');
  assert.ok(/run-in space/.test(said), `expected a run-in warning, got: ${said}`);

  // and nothing rapids to depth: the moves that reach thread depth are feeds
  const major = 8;
  let rapidsToDepth = 0;
  for (let n = 0; n < cl.count; n++) {
    const o = n * 8;
    if (cl.moves[o] === 0 && cl.moves[o + 1] < major - 0.05) rapidsToDepth++;
  }
  assert.eq(rapidsToDepth, 0, `${rapidsToDepth} rapids end inside the ⌀16 shaft`);

  // Threading at the end of the bar has the room, and says nothing.
  const clean = generate('turnThread', {
    ...params, topZ: shaft.zMax, bottomZ: shaft.zMax - 15,
  }, '16ER AG60 threading');
  assert.ok(!clean.notes.some((n) => n.level === 'warn' && /run-in/.test(n.text)),
    'a thread that starts at the end of the bar has its run-in');
});

test('an internal thread at the mouth of a bore has its run-in', () => {
  // The mirror of the case above, and the one the first fix got wrong. Past the
  // end of the part there is nothing at all — which is the commonest run-in
  // there is — but the *bore* also reads zero out there, so testing the hole
  // without testing whether the part is even present read open air as solid and
  // warned about a thread with all the space in the world.
  const tube = makeTube(0, 0, 20, 10, 50);
  const cl = generateToolpath({
    type: 'turnThread', name: 't', tool: tool('16ER AG60 threading'), mesh: tube,
    stock: {
      kind: 'cylinder', min: [-20, -20, 0], max: [20, 20, 50],
      cylinder: { diameter: 40, height: 50, center: [0, 0] },
    },
    params: {
      topZ: 50, bottomZ: 35, clearanceX: 0, clearanceHeight: 50, entryGap: 1,
      tolerance: 0.05, threadPitch: 1.5, threadInternal: true, threadStartRadius: 10,
      threadFirstDepth: 0, threadSpringPasses: 0,
    },
  });
  const said = cl.notes.filter((n) => n.level === 'warn').map((n) => n.text).join(' ');
  assert.ok(!/run-in/.test(said), `it has the room, but said: ${said}`);

  // and the run-out is not refused either. Past the thread the hole carries on
  // at the diameter the thread starts from, which is not in the tool's way: the
  // tool is already at depth and already cutting, and a pitch and a half more of
  // the same bore is what a run-out *is*. Only something standing proud of the
  // thread's own crest stops it — see the test below.
  assert.ok(!/run-out/.test(said), `the bore carries on, but said: ${said}`);
});

test('a run-out that would hit a shoulder is refused, and says which shoulder', () => {
  // The other half of the rule above. The tool comes out of the thread at full
  // form depth, so a step standing proud of the thread's crest is metal it
  // cannot pass — and unlike the plain cylinder, no amount of carrying on turns
  // that into more thread.
  const shaft = makeShaft({ bigDiameter: 40, smallDiameter: 24, length: 60, stepAt: 25 });
  const cl = generateToolpath({
    type: 'turnThread', name: 't', tool: tool('16ER AG60 threading'), mesh: shaft.mesh,
    stock: {
      kind: 'cylinder', min: [-20, -20, 0], max: [20, 20, 60],
      cylinder: { diameter: 40, height: 60, center: [0, 0] },
    },
    // threaded down the ⌀24 toward the shoulder at Z35, ending right on it
    params: {
      topZ: 60, bottomZ: 36, clearanceX: 25, clearanceHeight: 70, entryGap: 1,
      tolerance: 0.05, threadPitch: 1.5, threadFirstDepth: 0.25, threadSpringPasses: 0,
    },
  });
  const said = cl.notes.filter((n) => n.level === 'warn').map((n) => n.text).join(' ');
  assert.ok(/run-out/.test(said), `expected the shoulder to stop it: ${said}`);
  assert.ok(/⌀40/.test(said), `and to say what is in the way: ${said}`);
});

test('a thread on a plain bar runs out past its own end', () => {
  // The reported case: a thread part-way along a cylinder that carries on. The
  // work "comes up to meet the tool" at exactly the diameter the thread is cut
  // into, which is not a shoulder and never was — refusing the run-out there
  // stopped every pass dead on the last full thread.
  const bar = makeTube(0, 0, 18.085, 0, 40);
  const cl = generateToolpath({
    type: 'turnThread', name: 't', tool: tool('16ER AG60 threading'), mesh: bar,
    stock: {
      kind: 'cylinder', min: [-19, -19, 0], max: [19, 19, 40],
      cylinder: { diameter: 38, height: 40, center: [0, 0] },
    },
    params: {
      topZ: 40, bottomZ: 30.6, clearanceX: 25, clearanceHeight: 50, entryGap: 1,
      tolerance: 0.05, threadPitch: 3, threadFirstDepth: 0.25, threadSpringPasses: 1,
    },
  });
  const said = cl.notes.filter((n) => n.level === 'warn').map((n) => n.text).join(' ');
  assert.ok(!/run-out/.test(said), `the bar carries on, but said: ${said}`);

  // and the passes really do reach past the end of the thread
  const zs = cutPoints(cl).map((p) => p[2]);
  assert.ok(Math.min(...zs) < 30.6 - 1, `run-out reached Z${Math.min(...zs).toFixed(2)}`);
});

test('a threading pass is timed at pitch × rpm, not at the insert feed', () => {
  // A threading insert carries a slow feedrate and a threading pass does not use
  // it: the carriage is locked to the encoder and advances one pitch per rev.
  // Timing 3mm of pitch at 400rpm as if it were 60mm/min is where "a simple
  // short thread says 52 minutes" came from.
  const bar = makeTube(0, 0, 18.085, 0, 40);
  const insert = { ...tool('16ER AG60 threading'), spindleRpm: 400, feedCut: 60, feedPlunge: 40 };
  const cl = generateToolpath({
    type: 'turnThread', name: 't', tool: insert, mesh: bar,
    stock: {
      kind: 'cylinder', min: [-19, -19, 0], max: [19, 19, 40],
      cylinder: { diameter: 38, height: 40, center: [0, 0] },
    },
    params: {
      topZ: 40, bottomZ: 30.6, clearanceX: 25, clearanceHeight: 50, entryGap: 1,
      tolerance: 0.05, threadPitch: 3, threadFirstDepth: 0.25, threadSpringPasses: 1,
      spindleRpm: 400, feedCut: 60, feedPlunge: 40,
    },
  });
  const stats = toolpathStats(cl, 3000);
  // the synchronised passes are the bulk of the cutting, at 3 × 400 = 1200mm/min
  const atInsertFeed = (stats.cutLength / 60) * 60;
  assert.ok(stats.seconds < atInsertFeed / 5,
    `${stats.seconds.toFixed(0)}s for ${stats.cutLength.toFixed(0)}mm — that is the insert's feed, `
    + 'not the spindle\'s');
  assert.ok(stats.seconds > (stats.cutLength / 1200) * 60 * 0.5, 'and not free either');
});

test('a threading schedule cannot be expanded without bound', () => {
  // The pass count is derived from a *squared* ratio, so a careful first-bite
  // cap on a coarse form multiplies into a number no control would accept: a
  // 5mm form at a 0.01mm first bite asked for 250,000 passes, which is a hang
  // rather than a cycle.
  const many = threadInfeed({ depth: 5, passes: 6, firstDepth: 0.01 });
  assert.ok(many.length <= 200, `${many.length} passes`);
  assert.ok(many.every(Number.isFinite), 'and every depth is a number');
  assert.close(many[many.length - 1], 5, 1e-9, 'and it still reaches full depth');

  // the ordinary schedules are nowhere near the cap
  assert.eq(threadInfeed({ depth: threadFormDepth(1.5), passes: 6, firstDepth: 0.25 }).length, 14);
});
