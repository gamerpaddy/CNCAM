// Arc output, checked by reading the G-code back.
//
// An arc is the one thing a post can emit that is not a copy of its input: it
// replaces a run of moves with a curve, and a flipped G2/G3 or a sign error in
// I/J still looks like perfectly ordinary G-code. So these tests do not inspect
// the text — they parse it back into motion and compare that motion against the
// CL data it was posted from.

import { test, assert } from './runner.js';
import { buildGcode } from '../post/index.js';
import { parseGcode } from '../post/parse.js';
import { planArcs } from '../post/arcs.js';
import { CLBuilder, MOVE_STRIDE, OP, FEED } from '../engine/cl.js';
import { generateToolpath } from '../engine/toolpath.js';
import { makeBox, makeTube } from './fixtures.js';
import { mergeTolerance } from '../engine/simplify.js';
import { createMachine } from '../doc/machines.js';
import { createProject, deserializeProject } from '../doc/schema.js';

const TOOL = {
  number: 1, diameter: 6, spindleRpm: 9000, feedCut: 800, feedPlunge: 300,
};

/** A CL program tracing a circle as `segments` chords at depth z. */
function circleProgram(radius, segments, { cx = 0, cy = 0, z = -1 } = {}) {
  const cl = new CLBuilder();
  cl.comment('circle');
  cl.toolChange(1);
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(cx + radius, cy, 5);
  cl.cut(cx + radius, cy, z, FEED.PLUNGE);
  for (let i = 1; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    cl.cut(cx + radius * Math.cos(a), cy + radius * Math.sin(a), z);
  }
  cl.rapid(cx + radius, cy, 5);
  return cl.finish();
}

/** Every CL point, in order; `cutsOnly` drops the rapids. */
function clPoints(cl, cutsOnly = false) {
  const out = [];
  for (let n = 0; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    if (cl.moves[o] === OP.DRILL) continue;
    if (cutsOnly && cl.moves[o] === OP.RAPID) continue;
    out.push([cl.moves[o + 1], cl.moves[o + 2], cl.moves[o + 3]]);
  }
  return out;
}

/**
 * The posted program as motion, in the two forms a comparison needs: the whole
 * path, and the cutting part of it alone. Rapids are excluded from the second
 * because the post is entitled to add its own — the start position it assumes
 * and the final retract are not in the CL data and should not have to be.
 */
function posted(text, options) {
  const points = parseGcode(text, options).points;
  return {
    all: points.map((p) => [p.x, p.y, p.z]),
    cuts: points.filter((p) => !p.rapid).map((p) => [p.x, p.y, p.z]),
  };
}

/** Furthest any point of `points` sits from the polyline `path`. */
function maxDeviation(points, path) {
  let worst = 0;
  for (const p of points) {
    let best = Infinity;
    for (let i = 1; i < path.length; i++) best = Math.min(best, distToSegment(p, path[i - 1], path[i]));
    worst = Math.max(worst, best);
  }
  return worst;
}

function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const lenSq = dx * dx + dy * dy + dz * dz;
  let t = lenSq > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t), p[2] - (a[2] + dz * t));
}

/** Blocks that move the machine — modal G words mean most carry no G at all. */
function motionLines(text) {
  return text.split('\n').filter((l) => /^(G[0123]\b|[XYZIJ])/.test(l.trim())).length;
}

test('a finely chorded circle posts as arcs, not hundreds of G1 blocks', () => {
  const cl = circleProgram(10, 240);
  const { text } = buildGcode('linuxcnc', [{ name: 'circle', cl }]);
  const arcs = (text.match(/^G[23]\b/gm) || []).length;
  assert.ok(arcs >= 1 && arcs <= 4, `expected a couple of arc blocks, got ${arcs}`);
  assert.ok(motionLines(text) < 20, `240 chords should collapse, ${motionLines(text)} blocks left`);
  assert.ok(/I-?\d/.test(text) && /J-?\d/.test(text), 'arc centres emitted');
});

test('the posted arc cuts the path the CL data described', () => {
  const cl = circleProgram(10, 240);
  const { text } = buildGcode('linuxcnc', [{ name: 'circle', cl }], { arcTolerance: 0.01 });
  const back = posted(text);
  assert.ok(maxDeviation(clPoints(cl, true), back.all) < 0.02,
    'every cut the CL data described is on the posted path');
  assert.ok(maxDeviation(back.cuts, clPoints(cl)) < 0.02,
    'and the posted path cuts nothing the CL data did not');
});

test('arc direction survives the round trip both ways round', () => {
  for (const sense of [1, -1]) {
    const cl = new CLBuilder();
    cl.event('feeds', { cut: 600, plunge: 200 });
    cl.cut(10, 0, -1, FEED.PLUNGE);
    for (let i = 1; i <= 120; i++) {
      const a = sense * (i / 120) * Math.PI * 1.5;
      cl.cut(10 * Math.cos(a), 10 * Math.sin(a), -1);
    }
    const program = cl.finish();
    const { text } = buildGcode('linuxcnc', [{ name: 'arc', cl: program }]);
    assert.ok(/G[23] /.test(text), 'posted as an arc');
    assert.ok(text.includes(sense > 0 ? 'G3 ' : 'G2 '),
      `${sense > 0 ? 'counter-clockwise' : 'clockwise'} arc got the wrong code:\n${text}`);
    assert.ok(maxDeviation(clPoints(program, true), posted(text).all) < 0.02,
      'path matches after the round trip');
  }
});

test('a coarse polygon is left as lines — it is not a circle yet', () => {
  // twelve chords through a 10mm radius bulge 0.34mm away from the curve; an
  // arc through those points would cut outside everything the CL data planned
  const cl = circleProgram(10, 12);
  const arcs = planArcs(cl, 0.01);
  assert.eq(arcs.size, 0, 'no arc fitted to a coarse polygon');
});

test('arcs stop at anything that is not more of the same cut', () => {
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.cut(10, 0, -1, FEED.PLUNGE);
  for (let i = 1; i <= 60; i++) {
    const a = (i / 240) * Math.PI * 2;
    cl.cut(10 * Math.cos(a), 10 * Math.sin(a), -1);
  }
  cl.rapid(0, 0, 5);                    // a retract in the middle of the circle
  for (let i = 61; i <= 120; i++) {
    const a = (i / 240) * Math.PI * 2;
    cl.cut(10 * Math.cos(a), 10 * Math.sin(a), -1);
  }
  const program = cl.finish();
  const arcs = planArcs(program, 0.01);
  for (const [start, arc] of arcs) {
    for (let n = start; n <= arc.end; n++) {
      assert.eq(program.moves[n * MOVE_STRIDE], OP.LINE, 'an arc covers cutting moves only');
    }
  }
  const { text } = buildGcode('linuxcnc', [{ name: 'split', cl: program }]);
  assert.ok(maxDeviation(clPoints(program, true), posted(text).all) < 0.02,
    'both halves still trace the circle');
});

test('turning arcs off posts the original chords', () => {
  const cl = circleProgram(10, 240);
  const { text } = buildGcode('linuxcnc', [{ name: 'circle', cl }], { arcs: false });
  assert.ok(!/^G[23]\b/m.test(text), 'no arcs emitted');
  assert.ok(motionLines(text) > 200, `chords posted long-hand, got ${motionLines(text)}`);
});

test('a real toolpath survives the post as the same motion', () => {
  // 120 facets: a tessellation fine enough that the flats are inside tolerance
  // of the cylinder they stand for, which is what makes the contour arc-fittable
  const cl = generateToolpath({
    type: 'contour2d', name: 'cutout', tool: TOOL,
    mesh: makeTube(15, 15, 10, 4, 8, 120),
    stock: { min: [0, 0, 0], max: [30, 30, 8] },
    params: {
      topZ: 8, bottomZ: 0, stepdown: 4, clearanceHeight: 15, stockToLeave: 0,
      tolerance: 0.01, rampAngle: 0, leadType: 'none',
    },
  });
  const { text } = buildGcode('linuxcnc', [{ name: 'cutout', cl }], { arcTolerance: 0.01 });
  assert.ok(/^G[23]\b/m.test(text), 'the round part posted with arcs');
  const back = posted(text);
  assert.ok(maxDeviation(clPoints(cl, true), back.all) < 0.05, 'posted motion matches the toolpath');
  assert.ok(maxDeviation(back.cuts, clPoints(cl)) < 0.05, 'and cuts nothing extra');
});

test('the line map still points into the toolpath when arcs collapse blocks', () => {
  const ops = [{
    name: 'cutout',
    cl: generateToolpath({
      type: 'contour2d', name: 'cutout', tool: TOOL,
      mesh: makeBox(10, 10, 5),
      stock: { min: [0, 0, 0], max: [10, 10, 5] },
      params: {
        topZ: 5, bottomZ: 0, stepdown: 2, clearanceHeight: 15, stockToLeave: 0,
        tolerance: 0.01, rampAngle: 0,
      },
    }),
  }];
  const { text, lineMap } = buildGcode('linuxcnc', ops);
  const lines = text.split('\n');
  for (const [line, ref] of lineMap) {
    assert.ok(ref.move >= 0 && ref.move < ops[ref.op].cl.count, 'move index in range');
    assert.ok(/^[GXYZTFMS(]/.test(lines[line].trim()), `mapped line is code: "${lines[line]}"`);
  }
});

test('parse-back reports canned cycles rather than guessing at them', () => {
  const cl = generateToolpath({
    type: 'drill', name: 'holes', tool: TOOL,
    mesh: makeTube(15, 10, 10, 3, 8),
    stock: { min: [0, 0, 0], max: [30, 20, 8] },
    params: { topZ: 8, bottomZ: -1, clearanceHeight: 15, peck: 2 },
  });
  const { text } = buildGcode('linuxcnc', [{ name: 'holes', cl }]);
  const { cycles, unsupported } = parseGcode(text);
  assert.ok(cycles.length >= 1, 'the G83 cycle came back');
  assert.eq(cycles[0].code, 'G83', 'as a peck cycle');
  assert.close(cycles[0].z, -1, 1e-6, 'to the depth it was posted at');
  assert.eq(unsupported.length, 0, `nothing in the program went unread: ${JSON.stringify(unsupported)}`);
});

// --- helical arcs ---

/** A CL program spiralling down `turns` revolutions at `pitch` per turn. */
function helixProgram(radius, segments, turns, pitch, zTop = 0) {
  const cl = new CLBuilder();
  cl.comment('helix');
  cl.toolChange(1);
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(radius, 0, 5);
  cl.cut(radius, 0, zTop, FEED.PLUNGE);
  const steps = segments * turns;
  for (let i = 1; i <= steps; i++) {
    const a = (i / segments) * Math.PI * 2;
    cl.cut(radius * Math.cos(a), radius * Math.sin(a), zTop - (pitch * i) / segments, FEED.RAMP);
  }
  cl.rapid(radius, 0, 5);
  return cl.finish();
}

test('a helix posts as helical arcs, not thousands of G1 blocks', () => {
  const cl = helixProgram(10, 180, 8, 1);
  const { text } = buildGcode('linuxcnc', [{ name: 'bore', cl }]);
  const blocks = motionLines(text);
  assert.ok(blocks < 40, `expected a handful of arc blocks, got ${blocks} of ${cl.count}`);

  const arcs = text.split('\n').filter((l) => /^G[23]\b/.test(l.trim()));
  assert.ok(arcs.length > 0, 'and they are arcs');
  assert.ok(arcs.every((l) => /Z-?[\d.]/.test(l)), `every helical arc carries a Z: ${arcs[0]}`);
});

test('the posted helix is the helix that was planned', () => {
  const cl = helixProgram(10, 180, 6, 1.5);
  const { text } = buildGcode('linuxcnc', [{ name: 'bore', cl }]);
  const back = posted(text);
  assert.ok(maxDeviation(clPoints(cl, true), back.all) < 0.05, 'posted motion follows the toolpath');
  assert.ok(maxDeviation(back.cuts, clPoints(cl)) < 0.05, 'and cuts nothing extra');

  const deepest = Math.min(...back.cuts.map((p) => p[2]));
  assert.close(deepest, -9, 1e-3, 'to the depth the helix reached');
});

test('a circle in plan whose Z does not follow the angle is not a helix', () => {
  // The XY is a perfect circle and the Z steps up and down over it — a pass
  // round a rippled form. A G2 would run the Z straight through the ripples, so
  // no run of this may become an arc.
  const cl = new CLBuilder();
  cl.comment('ripple');
  cl.toolChange(1);
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(10, 0, 5);
  cl.cut(10, 0, 0, FEED.PLUNGE);
  for (let i = 1; i <= 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    cl.cut(10 * Math.cos(a), 10 * Math.sin(a), i % 2 ? -0.5 : 0);
  }
  const program = cl.finish();
  assert.eq(planArcs(program, 0.01).size, 0, 'no run of it may be replaced by an arc');

  const back = posted(buildGcode('linuxcnc', [{ name: 'ripple', cl: program }]).text);
  assert.ok(maxDeviation(clPoints(program, true), back.all) < 1e-3, 'so the Z survives exactly');
});

test('a helix whose Z stalls partway round is not one arc either', () => {
  // descends for half a turn, then runs level for the rest: two motions, and
  // one G2 through both of them would cut a spiral where the path is flat
  const cl = new CLBuilder();
  cl.comment('stall');
  cl.toolChange(1);
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(10, 0, 5);
  cl.cut(10, 0, 0, FEED.PLUNGE);
  for (let i = 1; i <= 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    cl.cut(10 * Math.cos(a), 10 * Math.sin(a), i <= 60 ? -i / 60 : -1);
  }
  const program = cl.finish();
  const back = posted(buildGcode('linuxcnc', [{ name: 'stall', cl: program }]).text);
  assert.ok(maxDeviation(clPoints(program, true), back.all) < 0.02,
    'the flat half stays flat');
});

test('a bore really does collapse into arcs end to end', () => {
  const cl = generateToolpath({
    type: 'bore', name: 'bore', tool: { ...TOOL, diameter: 6 },
    mesh: makeTube(0, 0, 25, 12, 12, 64),
    params: {
      topZ: 12, bottomZ: 0, clearanceHeight: 25, entryGap: 2, tolerance: 0.02,
      stepdown: 1, stepover: 0.4, stockToLeave: 0, finishPasses: 0,
      direction: 'climb', depthMode: 'bottomZ', preDrilled: 0,
    },
  });
  const plain = motionLines(buildGcode('linuxcnc', [{ name: 'b', cl }], { arcs: false }).text);
  const fitted = motionLines(buildGcode('linuxcnc', [{ name: 'b', cl }]).text);
  assert.ok(fitted < plain / 8, `arcs should shrink the file: ${fitted} vs ${plain} blocks`);

  const back = posted(buildGcode('linuxcnc', [{ name: 'b', cl }]).text);
  assert.ok(maxDeviation(back.cuts, clPoints(cl)) < 0.1, 'without moving the cut');
});

test('merging collinear points does not stop the post fitting arcs', () => {
  // The regression this guards: collapsing the resampled path to within half
  // the operation tolerance left every chord sitting further inside its own
  // circle than the arc fitter is allowed to move, so a bored hole came out as
  // hundreds of tiny lines. 614 arcs in the sample program became none, and
  // nothing failed — the file was just eight times longer and read worse.
  const round = (tolerance) => {
    const cl = generateToolpath({
      type: 'contour2d', name: 'cutout', tool: TOOL,
      mesh: makeTube(15, 15, 10, 4, 8, 120),
      stock: { min: [0, 0, 0], max: [30, 30, 8] },
      params: {
        topZ: 8, bottomZ: 0, stepdown: 4, clearanceHeight: 15, stockToLeave: 0,
        tolerance, rampAngle: 0, leadType: 'none',
      },
    });
    const { text } = buildGcode('linuxcnc', [{ name: 'cutout', cl }],
      { arcs: true, arcTolerance: 0.01 });
    return { moves: cl.count, arcs: (text.match(/^G0?[23]\b/gm) ?? []).length };
  };

  const tight = round(0.01);
  const loose = round(0.05);
  assert.ok(tight.arcs > 0, 'a round part posts arcs at all');
  // The merge scales with the operation tolerance and the arc budget does not,
  // so a loose operation is where the two collide. It must not cost arcs.
  assert.eq(loose.arcs, tight.arcs,
    `${loose.arcs} arcs at 0.05 tolerance against ${tight.arcs} at 0.01`);

  // the merge really is tighter than what the fitter is allowed to spend
  assert.ok(mergeTolerance(0.05) < 0.01,
    `merge tolerance ${mergeTolerance(0.05)} is not below the arc tolerance`);
  assert.ok(mergeTolerance(1) <= 0.004, 'and it never grows into a machining allowance');
});

test('whether a controller gets arcs is a property of the machine', () => {
  // It used to be one tick on the toolbar for the whole project, which is wrong
  // twice: it is a fact about the control — one takes G2/G3, the next takes it
  // badly, the lathe post here takes none — and a project that roughs on the
  // router and finishes on the mill needs a different answer for each.
  assert.eq(createMachine({ kind: 'mill' }).arcs, true, 'on unless said otherwise');
  assert.eq(createMachine({ kind: 'mill', arcs: false }).arcs, false, 'and off when it is');

  // A project written before the move meant what its tick said, so every
  // machine in it inherits that rather than quietly posting arcs again.
  const old = createProject('legacy');
  old.version = 4;
  old.postOptions = { arcs: false, arcTolerance: 0.01 };
  const back = deserializeProject(JSON.stringify(old));
  assert.ok(back.machines.length > 0, 'the rack came back');
  assert.ok(back.machines.every((m) => m.arcs === false), 'with arcs off on all of them');
  assert.eq(back.postOptions.arcs, undefined, 'and the project-wide tick is gone');

  // The tolerance stays where it was: that is how tightly a fitted arc has to
  // hug the path, which belongs to the job and not to the control.
  assert.eq(back.postOptions.arcTolerance, 0.01, 'the fit tolerance is still the project\u2019s');
});
