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

const CIRCLE_SEGMENTS = 48;

export const FIXTURE_KINDS = ['box', 'cylinder', 'chuck'];

export const FIXTURE_KIND_LABELS = {
  box: 'Rectangular jaw',
  cylinder: 'Round clamp',
  chuck: 'Lathe chuck',
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
    name: { chuck: 'Chuck', cylinder: 'Clamp', box: 'Jaw' }[kind] ?? 'Jaw',
    kind,                       // 'box' | 'cylinder' | 'chuck'
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
  };
}

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
    if (!f || f.kind !== 'chuck' || f.enabled === false) continue;
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
    const z = (f.baseZ ?? 0) + Math.max(0, f.height ?? 0);
    if (!top || z > top.z) top = { z, name: f.name ?? 'a clamp' };
  }
  return top;
}

/** The XY footprint of one fixture as a closed loop [x0,y0,x1,y1,…]. */
export function fixtureLoop(fixture) {
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
    .map(fixtureLoop);
}

/** Does this setup hold the tool out of anywhere? */
export function hasFixtures(fixtures) {
  return fixtureLoops(fixtures).length > 0;
}
