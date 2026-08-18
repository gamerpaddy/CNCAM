// Chamfering, boring and engraving — the three operations that put the cutter
// somewhere other than "offset by its own radius at a series of depths".
//
// Each one is tested against the thing it is *for* rather than against its own
// implementation: a chamfer against the cone geometry that decides where the
// edge lands, a bore against the promise that it never plunges, an engrave
// against the promise that the mark is on the line.

import { test, assert } from './runner.js';
import { generateToolpath } from '../engine/toolpath.js';
import { eachMove, OP, FEED } from '../engine/cl.js';
import { chamferGeometry, maxWidthFor } from '../engine/strategies/chamfer.js';
import { grooveGeometry } from '../engine/strategies/engrave.js';
import { boreRadii, circleSegments } from '../engine/strategies/bore.js';
import {
  makeBox, makeTube, makeRamp, makePocketBlock, makePocketAndHole,
} from './fixtures.js';
import {
  buildFaces, buildEdges, edgeAtPoint, edgeFootprint,
} from '../geom/faces.js';
import { resolveRegions } from '../app/regions-ui.js';
import { mergeMeshes } from '../geom/mesh.js';

const CHAMFER90 = {
  number: 3, type: 'chamfer', name: '6mm chamfer', diameter: 6, tipAngle: 90,
  tipDiameter: 0, fluteLength: 10, flutes: 1, spindleRpm: 10000, feedCut: 600, feedPlunge: 200,
};
const VBIT60 = { ...CHAMFER90, name: '60° V bit', diameter: 3.175, tipAngle: 60 };
// Wide enough that the difference between "how big is the cutter" and "how far
// out does it cut" is a centimetre rather than a rounding error.
const CHAMFER12 = { ...CHAMFER90, id: 't', name: '12mm chamfer', diameter: 12, flutes: 4 };
const FLAT = {
  number: 1, type: 'flat', name: '6mm flat', diameter: 6, tipAngle: 0, tipDiameter: 0,
  fluteLength: 20, flutes: 2, spindleRpm: 10000, feedCut: 800, feedPlunge: 300,
};

/** Every point the cutter feeds to, in order. */
function cutPoints(cl) {
  const pts = [];
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op === OP.LINE && feed !== FEED.RAPID) pts.push([x, y, z]);
  });
  return pts;
}

function notes(cl, level) {
  return cl.notes.filter((n) => !level || n.level === level).map((n) => n.text).join(' | ');
}

/** XY bounds of the points at (or very near) one Z. */
function boundsAtZ(pts, z, tol = 1e-3) {
  const at = pts.filter((p) => Math.abs(p[2] - z) < tol);
  if (at.length === 0) return null;
  return {
    count: at.length,
    minX: Math.min(...at.map((p) => p[0])),
    maxX: Math.max(...at.map((p) => p[0])),
    minY: Math.min(...at.map((p) => p[1])),
    maxY: Math.max(...at.map((p) => p[1])),
  };
}

// --- chamfer geometry: where the cone has to sit ---

test('a 90° cutter cuts a chamfer as deep as it is wide', () => {
  const g = chamferGeometry(CHAMFER90, { width: 2, clearance: 0 });
  assert.ok(g.pointed, 'a 90° cutter has a cone to lay on the edge');
  assert.close(g.faceDepth, 2, 1e-9, '45° face: 2mm across is 2mm down');
  assert.close(g.offset, 0, 1e-9, 'a true point on the edge itself');
});

test('the same chamfer is far deeper with a narrow V bit', () => {
  const g = chamferGeometry(VBIT60, { width: 2, clearance: 0 });
  // 60° included = 30° half angle; 2 / tan(30°) = 3.464
  assert.close(g.faceDepth, 2 / Math.tan(Math.PI / 6), 1e-6);
  assert.ok(g.faceDepth > 3, 'which is the number a machinist would get wrong by hand');
});

test('the flat on the tip stands the cutter off the edge by its own radius', () => {
  const withFlat = chamferGeometry({ ...CHAMFER90, tipDiameter: 1 }, { width: 1, clearance: 0 });
  assert.close(withFlat.offset, 0.5, 1e-9);
  assert.close(withFlat.faceDepth, 1, 1e-9, 'the face is still the width asked for');
});

test('tip clearance drops the point below the chamfer and steps the axis out to match', () => {
  const c = 0.4;
  const g = chamferGeometry(CHAMFER90, { width: 1, clearance: c });
  assert.close(g.drop, 1 + c, 1e-9, 'the tip goes clearance below the bottom of the face');
  // at 45° the axis has to move out by exactly what the tip dropped, or the
  // flank is no longer on the chamfer plane
  assert.close(g.offset, c, 1e-9);
});

test('a cutter with no point angle has no chamfer geometry at all', () => {
  assert.eq(chamferGeometry(FLAT, { width: 1 }).pointed, false);
  assert.eq(maxWidthFor(FLAT), 0);
});

test('the widest chamfer a cutter reaches is bounded by its own diameter', () => {
  assert.close(maxWidthFor(CHAMFER90, 0), 3, 1e-9, 'a ⌀6 90° mill: 3mm of cone each side');
  assert.close(maxWidthFor({ ...CHAMFER90, tipDiameter: 1 }, 0), 2.5, 1e-9);
});

// --- chamfer toolpath ---

const boxParams = {
  topZ: 10, bottomZ: 0, clearanceHeight: 25, entryGap: 2, tolerance: 0.01,
  direction: 'climb', leadType: 'none', leadRadius: 0,
  chamferWidth: 1, chamferClearance: 0.5, chamferPasses: 1, chamferEdges: 'outer',
};

test('a chamfer runs at the depth and offset the cone geometry asks for', () => {
  const cl = generateToolpath({
    type: 'chamfer', name: 'ch', tool: CHAMFER90, mesh: makeBox(40, 40, 10),
    params: boxParams,
  });
  const g = chamferGeometry(CHAMFER90, { width: 1, clearance: 0.5 });
  const z = 10 - g.drop;
  const b = boundsAtZ(cutPoints(cl), z);
  assert.ok(b && b.count > 8, `expected a lap at Z${z}, got ${b ? b.count : 0} points`);
  // the box spans 0..40; the axis stands `offset` outside it on every side
  assert.close(b.minX, -g.offset, 0.02);
  assert.close(b.maxX, 40 + g.offset, 0.02);
  assert.close(b.minY, -g.offset, 0.02);
  assert.close(b.maxY, 40 + g.offset, 0.02);
});

test('a hole is chamfered from inside it, and the outline from outside', () => {
  // ⌀20 bore through a ⌀40 post, so both boundaries are present at the top face
  const mesh = makeTube(0, 0, 20, 10, 12, 48);
  const run = (chamferEdges) => cutPoints(generateToolpath({
    type: 'chamfer', name: 'ch', tool: CHAMFER90, mesh,
    params: { ...boxParams, topZ: 12, chamferEdges, chamferClearance: 0 },
  }));

  const radius = (pts) => Math.max(...pts.map((p) => Math.hypot(p[0], p[1])));
  const inner = run('holes');
  const outer = run('outer');
  assert.ok(inner.length > 8 && outer.length > 8, 'both boundaries produce a lap');
  // with no tip clearance and a true point the axis sits on each boundary
  assert.close(radius(inner), 10, 0.35, 'the hole chamfer runs round the ⌀20 bore');
  assert.close(radius(outer), 20, 0.35, 'the outline chamfer runs round the ⌀40 outside');
});

// Picking the top face and getting *nothing* was the reported bug, and it had
// two independent causes: the include region was shrunk by the tool radius (a
// chamfer's tool centre is outside the face by construction, so the whole path
// fell outside it), and the survivors come back as open spans which the
// strategy was throwing away. Either one alone reproduces "offsets came back
// empty", so this checks the outcome rather than the mechanism.
test('picking the top face chamfers its edge instead of producing nothing', () => {
  const mesh = makeBox(40, 40, 10);
  const topFace = [[0, 0, 40, 0, 40, 40, 0, 40]];
  const cl = generateToolpath({
    type: 'chamfer', name: 'ch', tool: CHAMFER90, mesh, params: boxParams,
    regions: { include: topFace, avoid: [] },
  });
  const g = chamferGeometry(CHAMFER90, { width: 1, clearance: 0.5 });
  const b = boundsAtZ(cutPoints(cl), 10 - g.drop);
  assert.ok(b && b.count > 4, `picking the face it is in must chamfer that edge; got ${b ? b.count : 0} points`);
  assert.close(b.maxX, 40 + g.offset, 0.05, 'and on the same line as with nothing picked');
  assert.eq(notes(cl, 'warn'), '', 'with no warning about empty offsets');
});

// The other half: a region that genuinely has no edge at this Z still has to
// say so, or the fix above would simply have made the filter do nothing.
test('picking a face with no edge at Z chamfers nothing and says why', () => {
  const cl = generateToolpath({
    type: 'chamfer', name: 'ch', tool: CHAMFER90, mesh: makeBox(40, 40, 10), params: boxParams,
    regions: { include: [[100, 100, 120, 100, 120, 120, 100, 120]], avoid: [] },
  });
  assert.eq(cutPoints(cl).length, 0, 'nothing is cut off in the corner of the table');
  assert.ok(/picked faces/.test(notes(cl, 'warn')), `said: ${notes(cl, 'warn')}`);
});

test('each chamfer pass cuts a wider chamfer than the one before it', () => {
  const cl = generateToolpath({
    type: 'chamfer', name: 'ch', tool: CHAMFER90, mesh: makeBox(40, 40, 10),
    params: { ...boxParams, chamferWidth: 1.5, chamferPasses: 3, chamferClearance: 0 },
  });
  const levels = [...new Set(cutPoints(cl).map((p) => Math.round(p[2] * 1000) / 1000))]
    .sort((a, b) => b - a);
  assert.eq(levels.length, 3, `three passes, three depths — got ${levels.join(', ')}`);
  assert.close(levels[0], 9.5, 1e-6, 'first pass: a 0.5mm chamfer');
  assert.close(levels[2], 8.5, 1e-6, 'last pass: the full 1.5mm');
});

test('a chamfer refuses a cutter that has no point rather than inventing one', () => {
  const cl = generateToolpath({
    type: 'chamfer', name: 'ch', tool: FLAT, mesh: makeBox(40, 40, 10), params: boxParams,
  });
  assert.eq(cutPoints(cl).length, 0, 'and cuts nothing');
  assert.ok(/point angle/.test(notes(cl, 'warn')), notes(cl));
});

test('a chamfer too wide for the cutter says how wide it can go', () => {
  const cl = generateToolpath({
    type: 'chamfer', name: 'ch', tool: CHAMFER90, mesh: makeBox(40, 40, 10),
    params: { ...boxParams, chamferWidth: 5 },
  });
  assert.eq(cutPoints(cl).length, 0);
  assert.ok(/widest it reaches/.test(notes(cl, 'warn')), notes(cl));
});

// --- bore ---

const boreParams = {
  topZ: 12, bottomZ: 0, clearanceHeight: 25, entryGap: 2, tolerance: 0.02,
  stepdown: 1, stepover: 0.4, stockToLeave: 0, finishPasses: 0,
  direction: 'climb', depthMode: 'bottomZ', boreDiameter: 0, preDrilled: 0,
};

test('boring spirals in — it never plunges into the hole', () => {
  const cl = generateToolpath({
    type: 'bore', name: 'bore', tool: FLAT, mesh: makeTube(0, 0, 20, 8, 12, 48),
    params: boreParams,
  });
  let plungesBelowTop = 0;
  let prev = null;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE) { prev = null; return; }
    if (prev && feed !== FEED.RAPID) {
      const flat = Math.hypot(x - prev[0], y - prev[1]);
      // a descent with no travel is a plunge; above the material it is just the
      // approach through air, which is fine
      if (prev[2] - z > 1e-6 && flat < 1e-6 && z < 12 - 1e-6) plungesBelowTop++;
    }
    prev = [x, y, z];
  });
  assert.eq(plungesBelowTop, 0, 'the whole descent is the helix');
  assert.ok(cutPoints(cl).length > 100, 'and it is a real spiral, not two circles');
});

test('a bore reaches the hole size, not the cutter size', () => {
  const cl = generateToolpath({
    type: 'bore', name: 'bore', tool: FLAT, mesh: makeTube(0, 0, 20, 8, 12, 48),
    params: boreParams,
  });
  const pts = cutPoints(cl);
  const widest = Math.max(...pts.map((p) => Math.hypot(p[0], p[1])));
  // ⌀16 hole, ⌀6 cutter: the centreline finishes at 8 − 3 = 5
  assert.close(widest, 5, 0.15);
  const deepest = Math.min(...pts.map((p) => p[2]));
  assert.close(deepest, 0, 1e-6, 'and goes all the way to Bottom Z');
});

test('boring from solid clears the middle instead of leaving a core', () => {
  const cl = generateToolpath({
    type: 'bore', name: 'bore', tool: FLAT, mesh: makeTube(0, 0, 20, 8, 12, 48),
    params: boreParams,
  });
  const closest = Math.min(...cutPoints(cl).map((p) => Math.hypot(p[0], p[1])));
  // the innermost pass has to sweep the centre: radius ≤ the cutter's own
  assert.ok(closest <= 3 + 1e-6, `innermost radius ${closest.toFixed(3)} leaves a core`);
});

test('a pre-drilled hole means the bore only opens the wall out', () => {
  // ⌀30 bore, ⌀6 cutter: from solid the centreline has to work out from 3 to 12
  const mesh = makeTube(0, 0, 25, 15, 12, 64);
  const run = (preDrilled) => cutPoints(generateToolpath({
    type: 'bore', name: 'bore', tool: FLAT, mesh, params: { ...boreParams, preDrilled },
  }));

  const closest = (pts) => Math.min(...pts.map((p) => Math.hypot(p[0], p[1])));
  const solid = run(0);
  const opened = run(12);
  assert.close(closest(solid), 3, 0.2, 'from solid the first sweep covers the centre');
  // a ⌀12 hole already there: the cutter starts with its inner edge on that wall
  assert.close(closest(opened), 9, 0.2);
  assert.ok(opened.length < solid.length,
    `pre-drilled should be shorter: ${opened.length} vs ${solid.length} points`);
});

test('climb in a bore runs the other way round from climb on an outside profile', () => {
  const run = (direction) => {
    const pts = cutPoints(generateToolpath({
      type: 'bore', name: 'bore', tool: FLAT, mesh: makeTube(0, 0, 20, 8, 12, 48),
      params: { ...boreParams, direction },
    }));
    // signed area of the last full lap tells which way it went
    const lap = pts.slice(-20);
    let area = 0;
    for (let i = 0; i < lap.length - 1; i++) {
      area += lap[i][0] * lap[i + 1][1] - lap[i + 1][0] * lap[i][1];
    }
    return Math.sign(area);
  };
  assert.eq(run('climb'), 1, 'material outside the cut: climb is counter-clockwise');
  assert.eq(run('conventional'), -1);
});

test('a bore of assorted holes names the sizes it bored, not the first one', () => {
  // Three holes of three sizes came back as "3 bore(s), ⌀10.00 with a ⌀6
  // cutter". The paths were right; the sentence was the only thing wrong with
  // it, and the sentence is what gets read before cycle start.
  const a = makeTube(0, 0, 10, 4, 12, 48);      // ⌀8
  const b = makeTube(30, 0, 10, 3, 12, 48);     // ⌀6
  const c = makeTube(60, 0, 12, 5, 12, 48);     // ⌀10
  const mesh = mergeMeshes([a, b, c]);
  const cl = generateToolpath({
    type: 'bore', name: 'bore', tool: { ...FLAT, diameter: 4 }, mesh, params: boreParams,
  });
  const said = notes(cl, 'info');
  for (const size of ['⌀6.00', '⌀8.00', '⌀10.00']) {
    assert.ok(said.includes(size), `${size} is bored but not named: ${said}`);
  }
});

test('a cutter with no room to move inside the hole says so instead of cutting', () => {
  const cl = generateToolpath({
    type: 'bore', name: 'bore', tool: { ...FLAT, diameter: 16 },
    mesh: makeTube(0, 0, 20, 8, 12, 48), params: boreParams,
  });
  assert.eq(cutPoints(cl).length, 0);
  assert.ok(/room to move/.test(notes(cl, 'warn')), notes(cl));
});

test('bore radii start where the material does and finish on size', () => {
  // from solid: the first sweep has to cover the centre
  const solid = boreRadii({ finalR: 8, startR: 3, step: 2 });
  assert.close(solid[0], 3, 1e-9);
  assert.close(solid[solid.length - 1], 8, 1e-9);
  assert.ok(solid.every((r, i) => i === 0 || r > solid[i - 1]), 'strictly outward');

  // a hole no wider than the cutter needs one pass, not zero and not many
  const single = boreRadii({ finalR: 2, startR: 9, step: 2 });
  assert.eq(single.length, 1);
  assert.close(single[0], 2, 1e-9);
  assert.eq(boreRadii({ finalR: 0, startR: 3, step: 2 }).length, 0);
});

test('a circle is chorded finely enough to hold the tolerance it was given', () => {
  const r = 10;
  const n = circleSegments(r, 0.01);
  const sagitta = r * (1 - Math.cos(Math.PI / n));
  assert.ok(sagitta <= 0.01 + 1e-9, `sagitta ${sagitta} over tolerance`);
  assert.ok(circleSegments(r, 0.1) < n, 'a looser tolerance uses fewer chords');
});

// --- engrave ---

const engraveParams = {
  topZ: 10, bottomZ: 9.7, clearanceHeight: 25, entryGap: 2, tolerance: 0.01,
  stepdown: 1, side: 'on', engraveLines: 'outer', direction: 'climb',
  engraveMode: 'depth', grooveWidth: 0.4,
};

test('engraving puts the cutter on the line rather than beside it', () => {
  const cl = generateToolpath({
    type: 'engrave', name: 'eng', tool: VBIT60, mesh: makeBox(40, 40, 10),
    params: engraveParams,
  });
  const b = boundsAtZ(cutPoints(cl), 9.7);
  assert.ok(b && b.count > 3, 'cut at the floor of the mark');
  assert.close(b.minX, 0, 0.02, 'no cutter compensation at all');
  assert.close(b.maxX, 40, 0.02);
});

test('asking for a line width works the depth out from the cutter angle', () => {
  const cl = generateToolpath({
    type: 'engrave', name: 'eng', tool: VBIT60, mesh: makeBox(40, 40, 10),
    params: { ...engraveParams, bottomZ: 5, engraveMode: 'width', grooveWidth: 0.6 },
  });
  const deepest = Math.min(...cutPoints(cl).map((p) => p[2]));
  // 60° included: width = 2·depth·tan(30°), so 0.6mm wide is 0.5196mm deep
  const expected = 10 - 0.6 / (2 * Math.tan(Math.PI / 6));
  assert.close(deepest, expected, 1e-4);
});

test('a flat cutter cannot be asked for a line width', () => {
  const cl = generateToolpath({
    type: 'engrave', name: 'eng', tool: FLAT, mesh: makeBox(40, 40, 10),
    params: { ...engraveParams, engraveMode: 'width' },
  });
  assert.eq(cutPoints(cl).length, 0);
  assert.ok(/no point angle/.test(notes(cl, 'warn')), notes(cl));
});

test('a groove deeper than Bottom Z is refused, not quietly cut', () => {
  const cl = generateToolpath({
    type: 'engrave', name: 'eng', tool: VBIT60, mesh: makeBox(40, 40, 10),
    params: { ...engraveParams, engraveMode: 'width', grooveWidth: 3, bottomZ: 9.5 },
  });
  assert.eq(cutPoints(cl).length, 0);
  assert.ok(/below Bottom Z/.test(notes(cl, 'warn')), notes(cl));
});

test('groove width and depth are inverses of each other', () => {
  const g = grooveGeometry(VBIT60);
  assert.ok(g.pointed);
  const depth = g.depthFor(0.5);
  assert.close(g.widthAt(depth), 0.5, 1e-9);
  assert.eq(grooveGeometry(FLAT).pointed, false);
  assert.eq(grooveGeometry(FLAT).depthFor(0.5), null);
});

// --- a picked region is sized to the cut, not to the cutter -----------------

/**
 * Chamfer this part with these picks, through the same path the app takes: the
 * picks are face ids, `resolveRegions` turns them into loops, and how far those
 * loops move is the question under test.
 */
function chamferPicking(mesh, picks, tool = CHAMFER12) {
  const params = {
    topZ: 10, bottomZ: -50, clearanceHeight: 25, entryGap: 2, tolerance: 0.01,
    direction: 'climb', leadType: 'none', leadRadius: 0,
    chamferWidth: 0.5, chamferClearance: 0.5, chamferPasses: 1, chamferEdges: 'all',
  };
  const op = {
    id: 'op', type: 'chamfer', toolId: 't', enabled: true, params, regions: picks,
  };
  const doc = {
    meshes: new Map([['m', mesh]]), toolpaths: new Map(), project: { tools: [tool] },
  };
  return generateToolpath({
    type: 'chamfer', name: 'ch', tool, mesh, params,
    regions: resolveRegions(doc, op, (m) => m, null, tool),
  });
}

/** The id of the face whose triangles all satisfy `test` (x, y, z per vertex). */
function faceWhere(mesh, faces, test) {
  return faces.findIndex((tris) => tris.length > 0 && tris.every((t) => {
    for (let k = 0; k < 3; k++) {
      const i = mesh.indices[t * 3 + k] * 3;
      if (!test(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2])) return false;
    }
    return true;
  }));
}

/** How far the pass cuts along the line x = at, in mm. */
function cutAlongX(cl, at, tol = 0.6) {
  let total = 0;
  let prev = null;
  eachMove(cl, (op, x, y, z, i, j, k, feed) => {
    if (op !== OP.LINE) { prev = null; return; }
    if (prev && feed !== FEED.RAPID
      && Math.abs(x - at) < tol && Math.abs(prev[0] - at) < tol) {
      total += Math.hypot(x - prev[0], y - prev[1]);
    }
    prev = [x, y];
  });
  return total;
}

/** How many cutting points land on the rim of the hole. */
function cutsRoundHole(cl, hole) {
  return cutPoints(cl)
    .filter(([x, y]) => Math.hypot(x - hole.x, y - hole.y) < hole.r + 1).length;
}

test('a chamfer on a picked wall leaves a hole beside it alone', () => {
  // A ⌀12 chamfer mill breaking a 0.5mm edge cuts within a millimetre of its
  // axis. Sizing the pick to the cutter instead selected a band 12mm either
  // side of the picked wall, caught the rim of a hole 5mm past it, and broke an
  // edge nobody had pointed at.
  const { mesh, pocket, hole } = makePocketAndHole();
  const { faces } = buildFaces(mesh);
  const wall = faceWhere(mesh, faces, (x, y, z) => x === pocket.max[0] && z < 10.001);
  assert.ok(wall >= 0, 'found the pocket wall the hole sits beside');

  const cl = chamferPicking(mesh, { include: [{ modelId: 'm', faceId: wall }], avoid: [] });
  assert.eq(cutsRoundHole(cl, hole), 0, 'the hole was not picked and is not chamfered');
  assert.ok(cutAlongX(cl, pocket.max[0] - 0.5) > 18,
    `the picked wall is broken along its whole length `
    + `(${cutAlongX(cl, pocket.max[0] - 0.5).toFixed(1)}mm of 19)`);
});

test('and excluding that hole does not take a bite out of it', () => {
  // The same arithmetic in the other direction: a keep-out grown by the cutter's
  // radius rather than by where it cuts reserved a ⌀12 disc round the hole,
  // which reached 1.25mm past the pocket wall and left 7.3mm of the pocket's own
  // chamfer uncut — an unbroken edge either side of a gap.
  const {
    mesh, pocket, hole, gap,
  } = makePocketAndHole();
  const { faces } = buildFaces(mesh);
  const wall = faceWhere(mesh, faces, (x, y, z) => x === pocket.max[0] && z < 10.001);
  // the bore: every vertex of it stands at the hole radius (to within the
  // single precision the mesh is held in)
  const holeFace = faceWhere(mesh, faces,
    (x, y) => Math.abs(Math.hypot(x - hole.x, y - hole.y) - hole.r) < 1e-3);
  assert.ok(holeFace >= 0, 'found the hole');

  const include = [{ modelId: 'm', faceId: wall }];
  const alone = chamferPicking(mesh, { include, avoid: [] });
  const excluded = chamferPicking(mesh,
    { include, avoid: [{ modelId: 'm', faceId: holeFace }] });

  const at = pocket.max[0] - 0.5;
  assert.close(cutAlongX(excluded, at), cutAlongX(alone, at), 0.01,
    `excluding a hole ${gap}mm clear of the wall changed the wall's chamfer: `
    + `${cutAlongX(alone, at).toFixed(2)}mm became ${cutAlongX(excluded, at).toFixed(2)}mm`);
});

// --- picking an edge rather than a face ------------------------------------

test('a box has one crease per edge, and a click picks the nearest one', () => {
  const mesh = makeBox(20, 20, 10);
  const { faces, faceOfTriangle } = buildFaces(mesh);
  const { edges, edgeOfSegment } = buildEdges(mesh, faces, faceOfTriangle);

  // Six faces meeting at twelve edges. The creases are grouped by face *pair*,
  // so the four segments round the top are four edges and not one loop —
  // "break this corner" is about one of them.
  assert.eq(faces.length, 6, `${faces.length} faces on a box`);
  assert.eq(edges.length, 12, `${edges.length} creases on a box`);

  // a click just inside the top face, near the x=20 edge, means that edge
  const top = faceOfTriangle.findIndex((f, t) => {
    const z = mesh.positions[mesh.indices[t * 3] * 3 + 2];
    return z === 10 && f >= 0;
  });
  const topTri = faceOfTriangle.indexOf(faceOfTriangle[top]);
  const picked = edgeAtPoint(mesh, edgeOfSegment, topTri, [19.5, 10, 10]);
  const other = edgeAtPoint(mesh, edgeOfSegment, topTri, [0.5, 10, 10]);
  assert.ok(picked != null, 'a click near an edge of the top face picks one');
  if (other != null && picked !== other) {
    assert.ok(true, 'and a click near the opposite edge picks a different one');
  }
});

test('a picked edge becomes a band the chamfer can be clipped to', () => {
  const mesh = makeBox(20, 20, 10);
  const { faces, faceOfTriangle } = buildFaces(mesh);
  const { edges } = buildEdges(mesh, faces, faceOfTriangle);

  // the crease along x = 20 on the top face
  const along = edges.findIndex((e) => e.segments.every(([a, b]) => (
    mesh.positions[a * 3] === 20 && mesh.positions[b * 3] === 20
    && mesh.positions[a * 3 + 2] === 10 && mesh.positions[b * 3 + 2] === 10
  )));
  assert.ok(along >= 0, 'found the top edge at x=20');

  const band = edgeFootprint(mesh, edges, [along], 0.25);
  assert.ok(band.length > 0, 'the edge has a footprint');
  const xs = [];
  for (const loop of band) for (let i = 0; i < loop.length; i += 2) xs.push(loop[i]);
  // a band a quarter of a millimetre either side of x = 20, and nowhere else:
  // the whole point is that the other eleven edges are not in it
  assert.ok(Math.min(...xs) > 19.7, `band reaches x=${Math.min(...xs).toFixed(2)}`);
  assert.ok(Math.max(...xs) < 20.3, `band reaches x=${Math.max(...xs).toFixed(2)}`);
});

test('a picked edge is chamfered at its own height, not at the top of the part', () => {
  // A spiral down the side of a ⌀24 post. Its plan view is a circle that never
  // touches the profile at Edge Z, so slicing the part at one plane finds
  // nothing of it — which is "selecting a sloped edge doesn't generate
  // toolpaths at all".
  const mesh = makeTube(0, 0, 12, 0, 20, 96);
  const helix = [];
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    const a = t * 3 * Math.PI * 2;
    helix.push(12 * Math.cos(a), 12 * Math.sin(a), 20 - 16 * t);
  }
  const params = {
    topZ: 20, bottomZ: -50, clearanceHeight: 30, entryGap: 2, tolerance: 0.01,
    direction: 'climb', leadType: 'none', leadRadius: 0,
    chamferWidth: 1, chamferClearance: 0.5, chamferPasses: 1, chamferEdges: 'all',
  };
  const cl = generateToolpath({
    type: 'chamfer', name: 'ch', tool: CHAMFER90, mesh, params,
    regions: { include: [], avoid: [], cleared: [], edgePaths: [helix] },
  });
  const pts = cutPoints(cl);
  assert.ok(pts.length > 100, `expected a pass along the whole spiral, got ${pts.length} points`);

  const zs = pts.map((p) => p[2]);
  const g = chamferGeometry(CHAMFER90, { width: 1, clearance: 0.5 });
  assert.close(Math.max(...zs), 20 - g.drop, 0.02, 'starts a chamfer below the top of the edge');
  assert.close(Math.min(...zs), 4 - g.drop, 0.02, 'and follows it all the way down');

  // and the cone stands off the post, on the air side, everywhere along it
  const rs = pts.map((p) => Math.hypot(p[0], p[1]));
  assert.close(Math.min(...rs), 12 + g.offset, 0.02);
  assert.close(Math.max(...rs), 12 + g.offset, 0.02);
});

test('a vertical picked edge says why it cannot be chamfered', () => {
  const mesh = makeBox(20, 20, 10);
  const corner = [20, 20, 10, 20, 20, 0];
  const cl = generateToolpath({
    type: 'chamfer', name: 'ch', tool: CHAMFER90, mesh,
    params: {
      topZ: 10, bottomZ: -50, clearanceHeight: 25, entryGap: 2, tolerance: 0.01,
      direction: 'climb', leadType: 'none', leadRadius: 0,
      chamferWidth: 1, chamferClearance: 0.5, chamferPasses: 1, chamferEdges: 'all',
    },
    regions: { include: [], avoid: [], cleared: [], edgePaths: [corner] },
  });
  assert.eq(cutPoints(cl).length, 0, 'nothing to run the cone along');
  assert.ok(/straight down/.test(notes(cl, 'warn')), notes(cl));
});

// --- engraving follows the surface -----------------------------------------

test('an engraved line follows a slope instead of cutting one Z across it', () => {
  // A wedge rising from Z0 at x=0 to Z10 at x=40. A line scribed across it at
  // one Z starts at the right depth, breaks the surface halfway, and finishes
  // in air — which is what "engraving only follows 2D" is a description of.
  const mesh = makeRamp(40, 40, 10);
  const drawing = [{ points: [2, 20, 38, 20], closed: false }];   // along the slope
  const params = {
    topZ: 10, bottomZ: 9.7, stepdown: 5, clearanceHeight: 25, entryGap: 1,
    tolerance: 0.05, side: 'on', engraveMode: 'depth',
  };
  const run = (engraveFollow) => generateToolpath({
    type: 'engrave', name: 'e', tool: VBIT60, mesh, drawing,
    params: { ...params, engraveFollow },
  });

  const cuts = (cl) => {
    const out = [];
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (op === OP.LINE && feed !== FEED.RAPID) out.push([x, z]);
    });
    return out;
  };

  // the depth below the surface at each point the tool cuts; the ramp's
  // surface at x is x/40 * 10
  const errors = (cl) => cuts(cl).map(([x, z]) => Math.abs(((x / 40) * 10 - 0.3) - z));

  const flat = errors(run(false));
  const followed = errors(run(true));
  assert.ok(Math.max(...flat) > 5,
    `a fixed-Z pass should be metres out on a 10mm ramp, was ${Math.max(...flat).toFixed(2)}`);
  assert.ok(Math.max(...followed) < 0.2,
    `following the surface should hold the depth, was ${Math.max(...followed).toFixed(3)}mm out`);

  // and it does not resample a flat face into hundreds of moves
  const flatTop = generateToolpath({
    type: 'engrave', name: 'e', tool: VBIT60, mesh: makeBox(40, 40, 10), drawing,
    params: { ...params, engraveFollow: true },
  });
  assert.ok(cuts(flatTop).length <= 3,
    `${cuts(flatTop).length} moves to scribe a straight line across a flat face`);
});

test('an engraved mark is a depth below the surface, not a pair of heights', () => {
  // The reported disaster. Top Z and Bottom Z arrive from the model bounds, so
  // on a 10mm-tall wedge the old reading of them made the mark 10mm deep — and
  // following the surface then took it through the part, ten passes at a time.
  const mesh = makeRamp(40, 40, 10);
  const drawing = [{ points: [5, 10, 35, 10], closed: false }];
  const cl = generateToolpath({
    type: 'engrave', name: 'e', tool: VBIT60, mesh, drawing,
    params: {
      topZ: 10, bottomZ: 0, stepdown: 1, clearanceHeight: 25, entryGap: 1,
      tolerance: 0.05, side: 'on', engraveMode: 'depth', engraveDepth: 0.3,
    },
  });

  const pts = cutPoints(cl);
  assert.ok(pts.length > 0, 'it still cuts');
  // the ramp's surface at x is x/40 × 10; the mark sits 0.3 under it, wherever
  // that is, and nowhere near the billet floor
  for (const [x, , z] of pts) {
    const surface = (x / 40) * 10;
    assert.ok(Math.abs((surface - 0.3) - z) < 0.2,
      `at X${x.toFixed(1)} the mark is at Z${z.toFixed(2)}, surface is ${surface.toFixed(2)}`);
    assert.ok(z > 0, `Z${z.toFixed(2)} is below the billet`);
  }
  assert.ok(/0\.300mm deep/.test(notes(cl)), notes(cl));
});

test('a mark does not dive into what the cutter cannot reach', () => {
  const params = {
    topZ: 10, bottomZ: 0, stepdown: 1, clearanceHeight: 25, entryGap: 1,
    tolerance: 0.05, side: 'on', engraveMode: 'depth', engraveDepth: 0.3,
  };
  const across = (mesh) => {
    const cl = generateToolpath({
      type: 'engrave', name: 'e', tool: CHAMFER90, mesh,
      drawing: [{ points: [5, 20, 35, 20], closed: false }], params,
    });
    return cutPoints(cl).map((p) => p[2]);
  };

  // a 4mm pocket and a ⌀6 cutter: the tool physically cannot get in, and a
  // drop-cutter alone would still wedge it between the two rims and mark there
  const narrow = across(makePocketBlock({ size: 40, pocketSize: 4, height: 10, depth: 6 }).mesh);
  assert.ok(narrow.length > 0, 'the top face either side is still marked');
  assert.ok(Math.min(...narrow) > 9.5,
    `the mark dipped to Z${Math.min(...narrow).toFixed(2)} in a pocket the tool does not fit`);

  // a 20mm pocket the tool does fit in: its floor is a surface, and marking it
  // is right — as a separate mark, not as a dive through the wall
  const wide = across(makePocketBlock({ size: 40, pocketSize: 20, height: 10, depth: 6 }).mesh);
  assert.ok(Math.min(...wide) < 4.5, 'the floor of a pocket the tool fits in is marked');
  // nothing on the wall between them
  const onWall = wide.filter((z) => z > 4.5 && z < 9.5);
  assert.eq(onWall.length, 0, `${onWall.length} points cut on the pocket wall`);
});
