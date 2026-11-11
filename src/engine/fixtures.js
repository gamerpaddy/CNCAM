// Clamps, vice jaws, toe clamps, soft jaws — the things holding the part down.
//
// Machining regions are picked off the *model*, which works for "do not touch
// this face" and cannot express the commonest keep-out there is: a clamp is not
// part of the model at all. It exists on the machine, it is in the way, and
// nothing in a CAD file knows about it. Before this there was no way to say so
// — you either moved the clamps to suit the program or found out where they
// were when the cutter did.
//
// A fixture is a footprint the tool may not enter, defined in setup space (the
// same frame the toolpaths and the G-code are in, so a number measured off the
// machine can be typed in directly). Fixtures belong to the setup rather than
// to an operation, because a clamp does not care which operation is running.
//
// The keep-out is the whole column above and below the footprint, not a
// box in 3D. That is deliberately conservative: a tool that must not touch a
// clamp must not be *above* it either, because it has to get down to the cut
// somehow, and the way down is through the clamp. Being clever here would buy a
// little more reachable material in exchange for a class of crash that scraps
// the part and the cutter together.

//
// A *model* fixture is the exception to that last paragraph, and for a reason. A
// vice or a chuck brought in as an STL or a STEP file is not a lump beside the
// part: the part sits *in* it, between the jaws and over the bed, and the column
// over the whole of it is the column over the part. So a model keeps the tool
// out of what stands above the bottom of the stock (the jaws, a stop, a clamp
// screw) by footprint, exactly as a drawn jaw does — and everything else about
// it is asked in 3D, of the finished path, with the whole tool: see
// `fixtureKeepouts` here and engine/five/fixture-hits.js.

import { silhouetteAbove } from '../geom/silhouette.js';

const CIRCLE_SEGMENTS = 48;

export const FIXTURE_KINDS = ['box', 'cylinder', 'chuck'];

export const FIXTURE_KIND_LABELS = {
  box: 'Rectangular jaw',
  cylinder: 'Round clamp',
  chuck: 'Lathe chuck',
  model: 'Imported model',
};

/**
 * Which way up a fixture's file is. CAD is Z-up as often as it is Y-up, and a
 * vice lying on its side is a keep-out in a place the vice is not.
 */
export const UP_AXES = ['+z', '-z', '+y', '-y', '+x', '-x'];

export const UP_AXIS_LABELS = {
  '+z': 'Z+ (as drawn)',
  '-z': 'Z− (upside down)',
  '+y': 'Y+',
  '-y': 'Y−',
  '+x': 'X+',
  '-x': 'X−',
};

/** Each "up" as the rotation that brings it to +Z: [x', y', z'] from (x, y, z). */
const TO_Z_UP = {
  '+z': (x, y, z) => [x, y, z],
  '-z': (x, y, z) => [x, -y, -z],
  '+y': (x, y, z) => [x, -z, y],
  '-y': (x, y, z) => [x, z, -y],
  '+x': (x, y, z) => [-z, y, x],
  '-x': (x, y, z) => [z, y, -x],
};

/** How a chuck holds the work. The two are opposite keep-outs, not one setting. */
export const CHUCK_MODES = ['outside', 'inside', 'collet', 'face'];

export const CHUCK_MODE_LABELS = {
  outside: 'Gripping the outside (jaws closed on the bar)',
  inside: 'Gripping a bore (jaws opened inside the part)',
  collet: 'Collet (grips all round, nothing sticking out)',
  face: 'Face plate / soft jaws on a step',
};

export function createFixture(kind = 'box') {
  return {
    id: `fix_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
    name: { chuck: 'Chuck', cylinder: 'Clamp', box: 'Jaw', model: 'Fixture' }[kind] ?? 'Jaw',
    kind,                       // 'box' | 'cylinder' | 'chuck' | 'model'
    enabled: true,
    center: [0, 0],             // setup-space XY
    size: [40, 20],             // box: width X, depth Y
    diameter: 20,               // cylinder
    rotationDeg: 0,             // box only; a jaw is rarely square to the axes
    baseZ: 0,                   // for drawing and simulation, not for the keep-out
    height: 25,
    // --- chuck ---
    // A chuck is not a clamp with a round footprint. It is at one end of the
    // bar, it grips at a diameter, and what it takes away is not a patch of the
    // table but *everything below a Z* — the tool cannot reach past the jaws,
    // whatever radius it is at. See `chuckLimit`.
    jaws: 3,
    chuckMode: 'outside',
    clampDiameter: 30,          // the diameter the jaws close on
    jawLength: 20,              // how far the jaws stand out from the chuck face
    jawWidth: 18,
    faceZ: 0,                   // Z of the chuck face; jaws run from here to +Z
    bodyDiameter: 125,
    bodyLength: 60,
    // --- model ---
    // An imported vice, chuck or fixture plate. Its geometry is on the document
    // (doc.fixtureMeshes, by this id), as a model's is; these say where it
    // stands. `center` is where the middle of its footprint goes and `baseZ`
    // where its lowest point sits, which is what they mean for a jaw too.
    upAxis: '+z',
    scale: 1,                   // 25.4 for a file drawn in inches
    sourceName: '',
  };
}

const placedCache = new WeakMap();   // source mesh -> { key, placed }

/**
 * A fixture's own mesh, stood where the fixture says it is: turned the right way
 * up, scaled, rotated about Z, its footprint centred on `center` and its lowest
 * point on `baseZ`.
 *
 * @returns { positions, indices, bounds } in setup space
 */
export function placeFixtureMesh(mesh, fixture) {
  const up = TO_Z_UP[fixture.upAxis] ? fixture.upAxis : '+z';
  const scale = Number.isFinite(fixture.scale) && fixture.scale > 0 ? fixture.scale : 1;
  const rotation = fixture.rotationDeg ?? 0;
  const [cx, cy] = fixture.center ?? [0, 0];
  const baseZ = fixture.baseZ ?? 0;
  const key = [up, scale, rotation, cx, cy, baseZ].join('|');
  const held = placedCache.get(mesh);
  if (held?.key === key) return held.placed;

  const turn = TO_Z_UP[up];
  const source = mesh.positions;
  const out = new Float32Array(source.length);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < source.length; i += 3) {
    const p = turn(source[i] * scale, source[i + 1] * scale, source[i + 2] * scale);
    for (let k = 0; k < 3; k++) {
      out[i + k] = p[k];
      if (p[k] < lo[k]) lo[k] = p[k];
      if (p[k] > hi[k]) hi[k] = p[k];
    }
  }
  // turned about the middle of its own footprint, so the rotation field spins
  // the vice where it stands and does not swing it round the origin of its file
  const px = (lo[0] + hi[0]) / 2;
  const py = (lo[1] + hi[1]) / 2;
  const a = (rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < out.length; i += 3) {
    const u = out[i] - px;
    const v = out[i + 1] - py;
    out[i] = cx + u * cos - v * sin;
    out[i + 1] = cy + u * sin + v * cos;
    out[i + 2] = out[i + 2] - lo[2] + baseZ;
    for (let k = 0; k < 3; k++) {
      if (out[i + k] < min[k]) min[k] = out[i + k];
      if (out[i + k] > max[k]) max[k] = out[i + k];
    }
  }
  const placed = { positions: out, indices: mesh.indices, bounds: { min, max } };
  placedCache.set(mesh, { key, placed });
  return placed;
}

/**
 * A setup's fixtures with the imported ones given their geometry.
 *
 * Everything that asks about fixtures asks these, not `setup.fixtures`: a model
 * fixture's record says where it stands and nothing about its shape, so on its
 * own it has no height, no footprint and nothing to hit. Here it gains `mesh`
 * (placed, in setup space) and the `height` that mesh stands to, and from then
 * on it answers `fixtureTop`, `chuckLimit` and the rest as any other does.
 *
 * One whose geometry is missing (a project saved without it) comes back
 * disabled and marked `missing`, so it is drawn as nothing and kept out of as
 * nothing — and the panel says so.
 *
 * @param meshes Map of fixture id -> mesh (doc.fixtureMeshes)
 */
export function resolveFixtures(fixtures, meshes) {
  return (fixtures ?? []).map((f) => {
    if (f?.kind !== 'model') return f;
    const source = meshes?.get?.(f.id);
    if (!source) return { ...f, enabled: false, missing: true };
    const mesh = placeFixtureMesh(source, f);
    return {
      ...f, mesh, height: mesh.bounds.max[2] - mesh.bounds.min[2],
    };
  });
}

/**
 * Resolved fixtures without their geometry, for the jobs that only need to know
 * how high they stand: a vice of a hundred thousand triangles is not copied to
 * a worker for every operation so that one number can be read off it.
 */
export function withoutGeometry(fixtures) {
  return (fixtures ?? []).map((f) => {
    if (!f?.mesh) return f;
    const { mesh, ...rest } = f;
    return { ...rest, mesh: null, stands: true };
  });
}

/** Does this imported fixture have a shape — its geometry, or the height read off it? */
function hasShape(fixture) { return !!fixture.mesh || fixture.stands === true; }

/**
 * How far toward the chuck a turning tool may go, in Z.
 *
 * A milling keep-out is a footprint because a mill's tool comes down onto the
 * work from above. A lathe's does not: the tool comes in from the side, and
 * everything in front of the jaws is reachable at any radius while everything
 * behind them is reachable at none. So the chuck's keep-out is one number, and
 * a turning pass that would run past it is stopped there and says so.
 *
 * `inside` clamping is the exception worth having: the jaws are inside a bore,
 * so the *outside* of the part is clear right up to the chuck face and only the
 * bore is blocked.
 *
 * @returns { z, mode, name } or null when nothing on this setup is a chuck
 */
export function chuckLimit(fixtures) {
  let found = null;
  for (const f of fixtures ?? []) {
    if (!f || f.enabled === false) continue;
    // An imported chuck is its own drawing of where the jaws end: the front of
    // the model is as far as a turning tool goes. It cannot say it grips a bore,
    // so it is read the careful way round.
    if (f.kind === 'model') {
      if (!hasShape(f)) continue;
      const z = (f.baseZ ?? 0) + Math.max(0, f.height ?? 0);
      if (!found || z > found.z) found = { z, mode: 'outside', name: f.name ?? 'Chuck' };
      continue;
    }
    if (f.kind !== 'chuck') continue;
    const mode = f.chuckMode ?? 'outside';
    const jaws = mode === 'collet' ? 0 : Math.max(0, f.jawLength ?? 0);
    const z = (f.faceZ ?? 0) + jaws;
    if (!found || z > found.z) found = { z, mode, name: f.name ?? 'Chuck' };
  }
  return found;
}

/**
 * How high a milling fixture stands, so a clearance plane can be checked
 * against it.
 *
 * The keep-out below is a *footprint*, which is what a cut has to stay out of —
 * and it says nothing about height on purpose (the column above a clamp is
 * blocked too). But the plane long moves cross the job at is a height, and
 * nothing compared the two: a toe clamp standing 25mm proud of the billet with
 * clearance left at its default 10 gave a program whose every "safe" traverse
 * went straight through it. The cut moves avoided the clamp perfectly, which is
 * what made it invisible.
 *
 * A chuck is excluded: on a lathe it is a Z limit rather than an obstacle
 * overhead (see `chuckLimit`), and on a rotary table it is what the part is
 * standing on rather than something reached over.
 *
 * @returns { z, name } of the tallest enabled clamp, or null when there is none
 */
export function fixtureTop(fixtures) {
  let top = null;
  for (const f of fixtures ?? []) {
    if (!f || f.enabled === false || f.kind === 'chuck') continue;
    // an imported fixture stands as high as its geometry, and one that has not
    // been given it (see resolveFixtures) has no height to report
    if (f.kind === 'model' && !hasShape(f)) continue;
    const z = (f.baseZ ?? 0) + Math.max(0, f.height ?? 0);
    if (!top || z > top.z) top = { z, name: f.name ?? 'a clamp' };
  }
  return top;
}

/** The XY footprint of one fixture as a closed loop [x0,y0,x1,y1,…]. */
export function fixtureLoop(fixture) {
  if (fixture.kind === 'model') {
    // The box round it: what is left to say when only one loop will do. The
    // keep-out a program is planned against is `fixtureKeepouts`, which knows
    // the jaws from the bed.
    const b = fixture.mesh?.bounds;
    if (!b) return [];
    return [b.min[0], b.min[1], b.max[0], b.min[1], b.max[0], b.max[1], b.min[0], b.max[1]];
  }
  if (fixture.kind === 'chuck') {
    // On a mill (a chuck on a rotary table) the body is what is in the way.
    return circleLoop(fixture.center ?? [0, 0],
      Math.max(0.01, (fixture.bodyDiameter ?? 100) / 2));
  }
  if (fixture.kind === 'cylinder') {
    return circleLoop(fixture.center ?? [0, 0], Math.max(0.01, (fixture.diameter ?? 0) / 2));
  }

  const [w, d] = fixture.size ?? [10, 10];
  const [cx, cy] = fixture.center ?? [0, 0];
  const hw = Math.max(0.01, w) / 2;
  const hd = Math.max(0.01, d) / 2;
  const a = ((fixture.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const loop = [];
  for (const [u, v] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) {
    loop.push(cx + u * cos - v * sin, cy + u * sin + v * cos);
  }
  return loop;
}

function circleLoop([cx, cy], r) {
  const loop = new Array(CIRCLE_SEGMENTS * 2);
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    loop[i * 2] = cx + r * Math.cos(a);
    loop[i * 2 + 1] = cy + r * Math.sin(a);
  }
  return loop;
}

/** Footprints of every enabled fixture on a setup, ready to subtract. */
export function fixtureLoops(fixtures) {
  return (fixtures ?? [])
    .filter((f) => f && f.enabled !== false)
    .map(fixtureLoop)
    .filter((loop) => loop.length >= 6);
}

/**
 * How far above the bottom of the stock a model has to stand to be in the way.
 * A vice bed the part sits flat on is *at* that height, to the rounding of two
 * files, and is not something to keep out of — it is what the part is on.
 */
const FLOOR_MARGIN = 0.05;

const footprintCache = new WeakMap();   // placed mesh -> Map(floor -> loops)

/**
 * Where no operation may cut, for planning: every drawn clamp's footprint, and
 * of every imported fixture the outline of what stands above `floorZ` — the
 * bottom of the stock, which is as deep as a program is planned to go.
 *
 * That is the vice's jaws and not its bed, a chuck's jaws and not its body: the
 * part of the thing that is beside the work, where a cutter working the work
 * could reach it. What is below is under the part, and is not planned round but
 * checked — a through-cut that goes on into the bed is found by `fixtureCrashes`
 * (engine/five/fixture-hits.js), on the finished path, with the whole tool.
 *
 * @param fixtures from `resolveFixtures`
 */
export function fixtureKeepouts(fixtures, floorZ = -Infinity) {
  const out = [];
  for (const f of fixtures ?? []) {
    if (!f || f.enabled === false) continue;
    if (f.kind !== 'model') { out.push(fixtureLoop(f)); continue; }
    if (!f.mesh) continue;
    const floor = Number.isFinite(floorZ) ? floorZ + FLOOR_MARGIN : f.mesh.bounds.min[2];
    if (floor >= f.mesh.bounds.max[2]) continue;
    let byFloor = footprintCache.get(f.mesh);
    if (!byFloor) { byFloor = new Map(); footprintCache.set(f.mesh, byFloor); }
    let loops = byFloor.get(floor);
    if (!loops) {
      loops = silhouetteAbove(f.mesh, floor);
      byFloor.set(floor, loops);
    }
    out.push(...loops);
  }
  return out;
}
