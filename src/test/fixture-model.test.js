// A vice or a chuck brought in from a file: where it stands, what a program is
// planned to keep out of, and whether a finished path goes into it.
//
// The vice here is the smallest thing that is one: a bed, and two jaws standing
// on it with a gap between them for the part. The whole point of the feature is
// in that shape — the column over the bed is the column over the part, so the
// bed must not be a keep-out, and the jaws must.

import { test, assert } from './runner.js';
import { CLBuilder } from '../engine/cl.js';
import { mergeMeshes } from '../geom/mesh.js';
import { pointInLoops } from '../geom/inside.js';
import {
  createFixture, placeFixtureMesh, resolveFixtures, withoutGeometry,
  fixtureKeepouts, fixtureTop, chuckLimit, fixtureLoops,
} from '../engine/fixtures.js';
import { modelPrisms, fixtureCrashes } from '../engine/five/fixture-hits.js';
import { simulateRemoval } from '../engine/simulate.js';
import { serializeProject, extractFixtureMeshes, createProject } from '../doc/schema.js';
import { makeBox } from './fixtures.js';

const TOOL = {
  number: 1, type: 'flat', diameter: 6, fluteLength: 15, spindleRpm: 12000, feedCut: 900, feedPlunge: 300,
};

function shifted(mesh, dx, dy, dz) {
  const positions = new Float32Array(mesh.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += dx; positions[i + 1] += dy; positions[i + 2] += dz;
  }
  return { positions, indices: mesh.indices };
}

/**
 * Bed 100 × 60 × 20, and on it two jaws 100 × 15 × 30 at the Y edges: the gap
 * between them is 30 wide. In its own file it sits with a corner at the origin.
 */
function viceMesh() {
  return mergeMeshes([
    makeBox(100, 60, 20),
    shifted(makeBox(100, 15, 30), 0, 0, 20),
    shifted(makeBox(100, 15, 30), 0, 45, 20),
  ]);
}

/** The vice centred on the origin with its bed top at Z0: jaws up to Z30. */
function placedVice(patch = {}) {
  const fixture = { ...createFixture('model'), name: 'Vice', baseZ: -20, ...patch };
  const meshes = new Map([[fixture.id, viceMesh()]]);
  return { fixture, meshes, held: resolveFixtures([fixture], meshes) };
}

test('fixture model: stands where its record says, centred and on its base', () => {
  const { held } = placedVice({ center: [10, -5] });
  const { min, max } = held[0].mesh.bounds;
  assert.close((min[0] + max[0]) / 2, 10, 1e-4, 'centre X');
  assert.close((min[1] + max[1]) / 2, -5, 1e-4, 'centre Y');
  assert.close(min[2], -20, 1e-4, 'lowest point on baseZ');
  assert.close(held[0].height, 50, 1e-4, 'as high as the file');
  assert.close(fixtureTop(held).z, 30, 1e-4, 'the clearance plane is asked to clear the jaws');
});

test('fixture model: up axis, scale and rotation', () => {
  const mesh = viceMesh();
  const base = createFixture('model');
  const yUp = placeFixtureMesh(mesh, { ...base, upAxis: '+y' }).bounds;
  assert.close(yUp.max[2] - yUp.min[2], 60, 1e-4, 'the file\'s Y is now the height');
  const inch = placeFixtureMesh(mesh, { ...base, scale: 25.4 }).bounds;
  assert.close(inch.max[0] - inch.min[0], 2540, 1e-2, 'scaled');
  const turned = placeFixtureMesh(mesh, { ...base, rotationDeg: 90, center: [7, 3] }).bounds;
  assert.close(turned.max[0] - turned.min[0], 60, 1e-3, 'a quarter turn swaps the footprint');
  assert.close((turned.min[0] + turned.max[0]) / 2, 7, 1e-3, 'and it turns where it stands');
  // every "up" is a rotation: a mirrored vice would have its fixed jaw on the wrong side
  for (const up of ['+z', '-z', '+y', '-y', '+x', '-x']) {
    const p = placeFixtureMesh(makeBox(1, 2, 3), { ...base, upAxis: up }).positions;
    // signed volume of the box keeps its sign under a rotation
    let volume = 0;
    const idx = makeBox(1, 2, 3).indices;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
      volume += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
        - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
        + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    assert.ok(volume > 0, `${up} must not turn the model inside out`);
  }
});

test('fixture model: a missing file is no fixture at all, and says so', () => {
  const fixture = { ...createFixture('model'), name: 'Vice' };
  const held = resolveFixtures([fixture], new Map());
  assert.eq(held[0].missing, true);
  assert.eq(held[0].enabled, false);
  assert.eq(fixtureTop(held), null);
  assert.eq(fixtureLoops(held).length, 0);
  assert.eq(fixtureKeepouts(held, 0).length, 0);
  assert.eq(modelPrisms(held).length, 0);
});

test('fixture model: the plan keeps out of the jaws and not the bed', () => {
  const { held } = placedVice();
  // stock sitting on the bed: its bottom is Z0
  const loops = fixtureKeepouts(held, 0);
  assert.ok(loops.length >= 2, `two jaws, got ${loops.length} loops`);
  assert.ok(pointInLoops(loops, 0, -25), 'over the near jaw');
  assert.ok(pointInLoops(loops, 0, 25), 'over the far jaw');
  assert.ok(!pointInLoops(loops, 0, 0), 'between the jaws is where the part is');
  // with nothing to say where the stock ends, the whole of it is in the way
  const all = fixtureKeepouts(held);
  assert.ok(pointInLoops(all, 0, 0), 'no floor: the bed counts');
  // stock standing above the jaws: nothing of the vice is beside the work
  assert.eq(fixtureKeepouts(held, 30).length, 0);
});

test('fixture model: a path into a jaw is found, with the holder as well as the cutter', () => {
  const { held } = placedVice();
  const prisms = modelPrisms(held);

  const clear = new CLBuilder();
  clear.rapid(0, 0, 40);
  clear.cut(0, 0, 5);          // down between the jaws
  clear.cut(30, 0, 5);
  clear.rapid(30, 0, 40);
  assert.eq(fixtureCrashes(clear.finish(), TOOL, prisms), null, 'a cut between the jaws is fine');

  const intoJaw = new CLBuilder();
  intoJaw.rapid(0, 0, 40);
  intoJaw.cut(0, 0, 10);
  intoJaw.cut(0, 20, 10);      // sideways into the far jaw, 20mm below its top
  const hit = fixtureCrashes(intoJaw.finish(), TOOL, prisms);
  assert.ok(hit, 'driving into the jaw is a crash');
  assert.eq(hit.name, 'Vice');
  assert.ok(hit.depth > 15, `well into it, got ${hit.depth}`);

  // Along the jaw, touching it: what a cut planned round the jaw looks like, and
  // not a crash. A millimetre further over is one.
  const along = (y) => {
    const cl = new CLBuilder();
    cl.rapid(-30, y, 40);
    cl.cut(-30, y, 25);
    cl.cut(30, y, 25);
    return fixtureCrashes(cl.finish(), TOOL, prisms);
  };
  assert.eq(along(12), null, 'tangent to the jaw face is clear');
  assert.eq(along(-12), null, 'on either side');
  assert.ok(along(13), 'a millimetre into the jaw is not');
  assert.ok(along(-13), 'on either side');

  const intoBed = new CLBuilder();
  intoBed.rapid(0, 0, 40);
  intoBed.cut(0, 0, -3);       // a through-cut that goes on into the bed
  const bed = fixtureCrashes(intoBed.finish(), TOOL, prisms);
  assert.ok(bed && bed.depth > 2.5, 'the bed is not planned round, and is checked');

  // a rapid across the jaws below their tops
  const across = new CLBuilder();
  across.rapid(0, -40, 25);
  across.rapid(0, 40, 25);
  assert.ok(fixtureCrashes(across.finish(), TOOL, prisms), 'a traverse through the jaws');

  // The cutter is in the gap and touches nothing — and the holder is not: 40mm
  // across, 12mm up a tool standing 20mm down between jaws 30mm apart.
  const stubby = {
    ...TOOL, fluteLength: 10, shank: [{ diameter: 6, length: 2 }], holder: [{ diameter: 40, length: 30 }],
  };
  const slim = { ...TOOL, shank: [{ diameter: 6, length: 60 }], holder: [{ diameter: 40, length: 30 }] };
  const beside = new CLBuilder();
  beside.rapid(0, 0, 60);
  beside.cut(0, 0, 10);
  const down = beside.finish();
  const holder = fixtureCrashes(down, stubby, prisms);
  assert.ok(holder, 'the holder comes down on the jaws');
  assert.close(holder.depth, 8, 0.6, 'by as far as it is below their tops');
  assert.eq(fixtureCrashes(down, slim, prisms), null, 'a long slim tool reaches down between them');
});

test('fixture model: the simulation reports the hit on a program that never tilts', () => {
  const { held } = placedVice();
  const cl = new CLBuilder();
  cl.rapid(0, 0, 40);
  cl.cut(0, 0, 10);
  cl.cut(0, 20, 10);
  const run = simulateRemoval({
    stock: { min: [-20, -14, 0], max: [20, 14, 20] },
    ops: [{ cl: cl.finish(), tool: TOOL }],
    fixtures: held,
  });
  assert.ok((run.findings ?? []).some((f) => f.kind === 'fixture' && f.name === 'Vice'),
    'the vice is named among the collisions');

  const ok = new CLBuilder();
  ok.rapid(0, 0, 40);
  ok.cut(0, 0, 10);
  ok.cut(10, 0, 10);
  const fine = simulateRemoval({
    stock: { min: [-20, -14, 0], max: [20, 14, 20] },
    ops: [{ cl: ok.finish(), tool: TOOL }],
    fixtures: held,
  });
  assert.eq((fine.findings ?? []).filter((f) => f.kind === 'fixture').length, 0);
});

test('fixture model: without its geometry it still says how high it stands', () => {
  const { held } = placedVice();
  const lean = withoutGeometry(held);
  assert.eq(lean[0].mesh, null);
  assert.close(fixtureTop(lean).z, 30, 1e-4);
  // and on a lathe the front of it is as far as a turning tool goes
  assert.close(chuckLimit(lean).z, 30, 1e-4);
  assert.eq(chuckLimit(lean).mode, 'outside');
});

test('fixture model: its geometry is saved with the project and comes back', () => {
  const project = createProject();
  const { fixture, meshes } = placedVice();
  project.setups.push({ id: 's1', name: 'Setup 1', fixtures: [fixture], operations: [] });
  const json = serializeProject(project, new Map(), meshes);
  const back = JSON.parse(json);
  assert.ok(back.setups[0].fixtures[0].geometry, 'embedded in the file');
  assert.eq(project.setups[0].fixtures[0].geometry, undefined, 'and not left on the live record');
  const restored = extractFixtureMeshes(back);
  assert.eq(back.setups[0].fixtures[0].geometry, undefined, 'lifted back off');
  const mesh = restored.get(fixture.id);
  assert.eq(mesh.positions.length, meshes.get(fixture.id).positions.length);
  assert.eq(mesh.indices.length, meshes.get(fixture.id).indices.length);
});
