// Turning inserts, as the shapes they actually are.
//
// A lathe tool is not a small end mill. It does not spin, it has no flutes, and
// nothing about it is a solid of revolution — which is exactly what the app used
// to draw, because every cutter went through the same revolve-a-silhouette path.
// A CNMG and a WNMG came out as identical grey cones, and the one thing a
// machinist reads a lathe tool by — the insert shape, and therefore what corner
// angle and what clearance it has — was nowhere on screen.
//
// So an insert is described here the way the ISO code describes it: a letter for
// the shape, an inscribed circle for the size, and a nose radius on the corner
// that cuts. That is the first, third and last part of a designation like
// TNMG160408 — T for the 60° triangle, 16 for a 16mm inscribed circle (the code
// gives the edge length, but IC is what the geometry wants), 08 for a 0.8mm
// nose.
//
// Headless on purpose — no DOM, no three.js. `app/tool-shape.js` draws these and
// `view/simulation.js` extrudes them.

const ARC_SEGMENTS = 6;

/**
 * ISO insert shapes, by the letter that starts every designation.
 *
 * `cornerAngle` is the included angle at the cutting corner, which is the whole
 * trade the letter encodes: a big angle is a strong corner that cannot get into
 * a tight one, a small angle reaches into corners and chips if you look at it.
 */
export const INSERT_SHAPES = {
  R: { label: 'Round', cornerAngle: 180, kind: 'round' },
  S: { label: 'Square 90°', cornerAngle: 90, kind: 'regular', sides: 4 },
  C: { label: 'Rhombic 80°', cornerAngle: 80, kind: 'rhombic' },
  W: { label: 'Trigon 80°', cornerAngle: 80, kind: 'trigon' },
  T: { label: 'Triangle 60°', cornerAngle: 60, kind: 'regular', sides: 3 },
  D: { label: 'Rhombic 55°', cornerAngle: 55, kind: 'rhombic' },
  V: { label: 'Rhombic 35°', cornerAngle: 35, kind: 'rhombic' },
};

export const INSERT_LETTERS = Object.keys(INSERT_SHAPES);

export const INSERT_SHAPE_LABELS = Object.fromEntries(
  INSERT_LETTERS.map((k) => [k, `${k} — ${INSERT_SHAPES[k].label}`]),
);

/** What each shape is good for, in the sentence a catalogue would use. */
export const INSERT_NOTES = {
  R: 'Strongest edge there is, and it can only make radii. Copying and heavy roughing.',
  S: 'Four strong corners. Facing and roughing where nothing has to reach into a corner.',
  C: 'The general-purpose insert: 80° corners rough, the other two get to a shoulder.',
  W: 'Three 80° corners instead of two — a C insert with half again the edges.',
  T: 'Reaches a 60° corner and turns and faces from one setting. Weaker than a C.',
  D: 'Profiling. 55° gets into most shoulders without a second tool.',
  V: 'Sharp enough to follow almost any profile, and fragile. Finishing only.',
};

/** Which way the tool is handed. R cuts toward the chuck, which is the usual one. */
export const INSERT_HANDS = ['R', 'L', 'N'];
export const INSERT_HAND_LABELS = {
  R: 'Right hand (cuts toward the chuck)',
  L: 'Left hand (cuts toward the tailstock)',
  N: 'Neutral (faces and turns both ways)',
};

/**
 * The insert's outline, centred on its own centre, as a closed polygon.
 *
 * Sized by the inscribed circle, because that is the number that means "how big
 * is this insert" — the circle that fits inside the shape and touches every
 * edge. Corners carry the nose radius, so a 0.4 and a 1.2 look as different as
 * they cut.
 *
 * The primary cutting corner is the one pointing at −Y, so a caller placing the
 * tool only has to rotate the whole shape rather than hunt for a vertex.
 *
 * @param shape one of INSERT_SHAPES' letters
 * @param ic inscribed circle diameter, mm
 * @param noseRadius corner radius, mm
 * @returns { points: [[x, y], …], cornerAt: [x, y], ic }
 */
export function insertOutline(shape, ic = 12, noseRadius = 0.8, segments = ARC_SEGMENTS) {
  const spec = INSERT_SHAPES[shape] ?? INSERT_SHAPES.C;
  const r = Math.max(0.5, ic) / 2;

  if (spec.kind === 'round') {
    const points = [];
    const n = Math.max(16, segments * 6);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      points.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return { points, cornerAt: [0, -r], ic };
  }

  const raw = spec.kind === 'regular' ? regularPolygon(spec.sides)
    : spec.kind === 'trigon' ? trigon()
      : rhombus(spec.cornerAngle);

  // Built at an arbitrary scale, then scaled so the inscribed circle is right.
  // Solving each shape's vertex radius in closed form is three different pieces
  // of trigonometry; measuring the incircle is one, and it cannot disagree with
  // the polygon it measured.
  const scale = r / inradius(raw);
  const scaled = raw.map(([x, y]) => [x * scale, y * scale]);
  // never a nose bigger than the insert can hold: a 1.2mm nose on a 6mm IC
  // V insert is not a rounded corner, it is a different shape
  const nose = Math.min(Math.max(0, noseRadius), r * 0.6);
  const points = filletPolygon(scaled, nose, segments);
  return { points, cornerAt: scaled[0], ic };
}

/** A regular n-gon with one vertex pointing at −Y, circumradius 1. */
function regularPolygon(sides) {
  const points = [];
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + (i / sides) * Math.PI * 2;
    points.push([Math.cos(a), Math.sin(a)]);
  }
  return points;
}

/** A rhombus of acute angle `deg`, acute corner pointing at −Y, long half-diagonal 1. */
function rhombus(deg) {
  const half = (deg * Math.PI) / 360;
  // side 1: half-diagonals are cos and sin of the half-angle
  const p = Math.cos(half);
  const q = Math.sin(half);
  return [[0, -p], [q, 0], [0, p], [-q, 0]];
}

/**
 * A trigon: three 80° cutting corners with a blunt corner between each pair.
 *
 * Six vertices, interior angles alternating 80° and 160° (they have to sum to
 * 720°). The ratio between the two vertex radii is what sets the 80°, and it is
 * solved once here rather than eyeballed — a trigon drawn with the wrong ratio
 * is a hexagon, which is not an insert anybody sells.
 */
function trigon() {
  // Corner at (0,−1), its neighbour at radius k, 60° round. For the corner to
  // be 80° the edge must leave it 40° off the bisector, which after squaring
  //   (1 − k/2)² = cos²40 · (k² − k + 1)
  // is a quadratic in k. It comes out at 0.6527; solving it rather than writing
  // that down keeps the shape honest if the 80° is ever parameterised.
  const c2 = Math.cos((40 * Math.PI) / 180) ** 2;
  const A = 0.25 - c2;
  const B = c2 - 1;
  const C = 1 - c2;
  const k = (-B - Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
  const minor = Number.isFinite(k) && k > 0.2 && k < 1 ? k : 0.6527;

  const points = [];
  for (let i = 0; i < 3; i++) {
    const major = -Math.PI / 2 + (i * Math.PI * 2) / 3;
    points.push([Math.cos(major), Math.sin(major)]);
    const between = major + Math.PI / 3;
    points.push([minor * Math.cos(between), minor * Math.sin(between)]);
  }
  return points;
}

/** Distance from the origin to the nearest edge of a convex polygon. */
function inradius(points) {
  let min = Infinity;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    // perpendicular distance from the origin to the infinite line
    const d = Math.abs(dx * y0 - dy * x0) / len;
    if (d < min) min = d;
  }
  return min > 0 ? min : 1;
}

/** Round every corner of a convex polygon by `radius`. */
function filletPolygon(points, radius, segments) {
  if (!(radius > 1e-6)) return points.map((p) => [...p]);
  const n = points.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = points[i];
    const p = points[(i - 1 + n) % n];
    const q = points[(i + 1) % n];
    const u = unit(p[0] - c[0], p[1] - c[1]);
    const v = unit(q[0] - c[0], q[1] - c[1]);
    const cosFull = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]));
    const half = Math.acos(cosFull) / 2;
    if (!(half > 1e-4) || half > Math.PI / 2 - 1e-4) { out.push([...c]); continue; }

    const tangent = radius / Math.tan(half);
    const maxTangent = Math.min(Math.hypot(p[0] - c[0], p[1] - c[1]),
      Math.hypot(q[0] - c[0], q[1] - c[1])) * 0.48;
    const t = Math.min(tangent, maxTangent);
    const rr = t * Math.tan(half);
    const bis = unit(u[0] + v[0], u[1] + v[1]);
    const centre = [c[0] + bis[0] * (rr / Math.sin(half)), c[1] + bis[1] * (rr / Math.sin(half))];
    const start = [c[0] + u[0] * t, c[1] + u[1] * t];
    const end = [c[0] + v[0] * t, c[1] + v[1] * t];

    const a0 = Math.atan2(start[1] - centre[1], start[0] - centre[0]);
    let a1 = Math.atan2(end[1] - centre[1], end[0] - centre[0]);
    // always take the short way round; a convex corner never sweeps past 180°
    while (a1 - a0 > Math.PI) a1 -= Math.PI * 2;
    while (a0 - a1 > Math.PI) a1 += Math.PI * 2;
    for (let s = 0; s <= segments; s++) {
      const a = a0 + ((a1 - a0) * s) / segments;
      out.push([centre[0] + rr * Math.cos(a), centre[1] + rr * Math.sin(a)]);
    }
  }
  return out;
}

function unit(x, y) {
  const len = Math.hypot(x, y) || 1;
  return [x / len, y / len];
}

// --- placing the insert on a tool ------------------------------------------
//
// Everything above is the insert on its own. A tool is that insert held at an
// angle in a shank, and which angle is the difference between a tool that can
// turn up to a shoulder and one that fouls on it.
//
// The frame is the machine's ZX plane as it is always drawn: +Z to the right
// (toward the tailstock), +X up (away from the spindle axis), and the cutting
// point at the origin. A right-hand OD tool therefore has its shank going up and
// to the right — behind and above the cut — and cuts travelling left. Getting
// this backwards is what put the holder inside the material it had not cut yet.

/** Lathe tool families, and how each one is held. */
export const LATHE_TOOL_TYPES = ['turning', 'boring', 'parting', 'threading'];

export function isLatheTool(type) {
  return LATHE_TOOL_TYPES.includes(type);
}

/**
 * Where the insert sits and which way the shank runs, for a tool.
 *
 * The rotation and the shank direction are two statements about the same fact —
 * which side of the cutting corner the *body* of the tool is on — and they have
 * to agree. They did not: a right-hand tool was drawn with its shank running
 * toward the tailstock (+Z) and its insert leaning the other way, toward the
 * chuck, so the insert appeared to hang off the wrong end of its own holder.
 * That is the "rotated 180°" the tools looked like, and it was also wrong in
 * the one way that matters: the insert sat in the metal the pass had not
 * reached yet, on the side the holder is supposed to trail through.
 *
 * `insertOutline` hands back a shape whose cutting corner points at −Y and
 * whose body is therefore at +Y; seated on the origin, rotating it by `d` puts
 * the body along (−sin d, cos d) in the (Z, radius) frame. So a body that has
 * to end up at +Z needs a *negative* rotation, which is the sign that was
 * inverted.
 *
 * @returns {{ rotationDeg, shank: [dz, dx], approach }} `shank` is the unit
 *   direction the holder body extends in, away from the cut.
 */
export function toolPose(tool) {
  const hand = tool?.hand ?? 'R';
  if (tool?.type === 'boring') {
    // Inside the bore: the edge faces the wall (up, +X) and the bar runs back
    // out of the hole toward the tailstock. The body sits *below* the cut, in
    // the space the pilot hole already made — so the insert leans to +Z and −X,
    // which is the third quadrant of the rotation above.
    return { rotationDeg: 215, shank: [1, -1], approach: 'internal' };
  }
  if (tool?.type === 'parting') {
    // A blade goes straight in: no lead angle, body directly outboard.
    return { rotationDeg: 0, shank: [0, 1], approach: 'radial' };
  }
  if (tool?.type === 'threading') {
    // A threading tool is not a parting blade, which is what it used to be
    // drawn as. It is a pointed insert on an ordinary square shank, fed
    // straight in — so it is placed the way a turning tool is, body trailing
    // back and outboard, but with *no* lead angle: the form has to sit square
    // to the axis or the two flank angles come out unequal.
    return { rotationDeg: 0, shank: [1, 1], approach: 'radial' };
  }
  // OD turning. A right-hand tool cuts travelling toward the chuck, so its body
  // trails toward the tailstock, through metal it has already removed. Left-hand
  // tools are the mirror image about the X axis.
  return hand === 'L'
    ? { rotationDeg: 35, shank: [-1, 1], approach: 'external' }
    : { rotationDeg: -35, shank: [1, 1], approach: 'external' };
}

/**
 * The whole tool as closed loops in the ZX plane, cutting point at the origin.
 *
 * One place, so the icon in the list, the big preview in the panel and the solid
 * in the simulation are the same drawing at three sizes. They used to be three
 * drawings, and they disagreed.
 *
 * @param scale mm the holder extends back from the tip; the insert is drawn at
 *   its true size relative to it
 * @returns [{ kind: 'insert' | 'holder', points }]
 */
export function latheToolOutline(tool, { holderLength = null, bladeDepth = null } = {}) {
  const type = tool?.type ?? 'turning';
  const pose = toolPose(tool);
  const ic = insertIcOf(tool);
  const nose = Math.max(0, tool?.noseRadius ?? 0);

  if (type === 'parting') return partingOutline(tool, holderLength, bladeDepth, nose);

  const points = type === 'threading'
    ? threadingInsert(tool, ic)
    : insertOutline(tool?.insert ?? defaultShapeFor(type), ic, nose).points;
  // the outline's cutting corner points at −Y; bring it to the origin, then
  // rotate the whole insert to the tool's lead angle
  const lowest = points.reduce((lo, p) => (p[1] < lo ? p[1] : lo), Infinity);
  const seated = points.map(([x, y]) => [x, y - lowest]);
  const insert = seated.map(rotator(pose.rotationDeg));

  const shankWidth = Math.max(4, ic * 0.9);
  const back = holderLength ?? Math.max(30, ic * 3.5);
  const [dz, dx] = unit(pose.shank[0], pose.shank[1]);
  // Where the insert stops, measured along the shank's own axis. The holder
  // starts there and not before it: it used to start at 0.55·IC, which is
  // *inside* the insert, and since the holder is extruded thicker than the
  // plate it swallowed it — the reported "inserts clip into the holders". An
  // insert is bolted into a pocket in the front face of the shank, so the front
  // face is where the shank begins.
  let seat = 0;
  for (const [z, x] of insert) seat = Math.max(seat, z * dz + x * dx);

  const nz = -dx;
  const nx = dz;
  const holder = [
    [dz * seat + nz * shankWidth * 0.5, dx * seat + nx * shankWidth * 0.5],
    [dz * (seat + back) + nz * shankWidth * 0.5, dx * (seat + back) + nx * shankWidth * 0.5],
    [dz * (seat + back) - nz * shankWidth * 0.5, dx * (seat + back) - nx * shankWidth * 0.5],
    [dz * seat - nz * shankWidth * 0.5, dx * seat - nx * shankWidth * 0.5],
  ];
  return [
    { kind: 'holder', points: holder },
    { kind: 'insert', points: insert },
  ];
}

/**
 * A parting or grooving tool: a blade, and the block that holds it.
 *
 * The old drawing was the blade with a slightly wider rectangle standing on end
 * on top of it — a lollipop, and not a picture of any tool anybody owns. What
 * identifies a parting tool is that the blade is *thin* and *reaches*: it
 * stands a groove's depth out of a holder that runs back along the bar. So the
 * blade is as wide along Z as the groove it cuts and as deep radially as it
 * plunges, and the body runs off toward the tailstock from the top of it —
 * over the offcut rather than over the part still in the chuck.
 */
function partingOutline(tool, holderLength, bladeDepth, nose) {
  const width = Math.max(0.5, tool?.bladeWidth || tool?.diameter || 3);
  // How far the blade is *drawn* standing out, which is not always how far it
  // reaches: an icon of a 3mm blade that reaches 25mm is a hairline in a tall
  // box, and what identifies a parting tool at that size is the tip and the
  // block behind it. The simulation asks for the real depth and gets it.
  const depth = bladeDepth != null
    ? Math.max(width * 1.6, bladeDepth)
    : Math.max(4, tool?.maxDepth || width * 6);
  const back = holderLength != null
    ? Math.max(width * 2.5, holderLength)
    : Math.max(width * 4, depth * 1.4);
  const shoulder = depth + nose;
  const height = Math.max(width * 4, depth * 0.6, 8);
  return [
    // drawn first so the blade paints over the shoulder they share
    { kind: 'holder', points: rect(-width * 0.9, shoulder, back + width * 0.9, height) },
    { kind: 'insert', points: rect(-width / 2, 0, width, shoulder) },
  ];
}

/**
 * A threading insert: a point of the thread's own included angle, on a stub of
 * body.
 *
 * Drawn to the same convention as `insertOutline` — cutting corner at the
 * bottom, body above it — so the placement code does not have to know which
 * family it was handed. The point angle is the whole identity of the tool: a
 * threading insert is a shape you check against the form you are cutting, and
 * drawing one as a rhombus with a corner radius says nothing about it.
 */
function threadingInsert(tool, ic) {
  const included = tool?.tipAngle > 0 && tool.tipAngle < 150 ? tool.tipAngle : 60;
  const half = (included * Math.PI) / 360;
  const flank = Math.max(1.2, ic * 0.42);
  const t = Math.tan(half) * flank;
  const w = Math.max(t * 1.25, ic * 0.45);
  const body = Math.max(1.5, ic * 0.5);
  return [
    [0, 0], [t, flank], [w, flank], [w, flank + body], [-w, flank + body],
    [-w, flank], [-t, flank],
  ];
}

function rotator(deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return ([x, y]) => [x * c - y * s, x * s + y * c];
}

function rect(x, y, w, h) {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

/** The shape a tool of this family gets when nobody has said. */
export function defaultShapeFor(type) {
  return type === 'boring' ? 'C' : 'C';
}

/**
 * The insert's inscribed circle for a tool.
 *
 * Falls back to the tool's `diameter`, which is what the old records held and
 * what the presets have always meant by it — a lathe tool has no diameter, so
 * the field was already being used for the insert size.
 */
export function insertIcOf(tool) {
  const ic = tool?.insertIc;
  if (ic > 0) return ic;
  return Math.max(3, tool?.diameter ?? 9.525);
}

/**
 * Bounding extent of the tool in the ZX plane, for framing a drawing.
 * @returns { minZ, maxZ, minX, maxX }
 */
export function latheToolBounds(sections) {
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const { points } of sections) {
    for (const [z, x] of points) {
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  return { minZ, maxZ, minX, maxX };
}

/**
 * Read an ISO designation well enough to fill the fields in.
 *
 * Not a full parser — the middle letters are tolerance and chipbreaker classes
 * nothing here models. The three parts that are geometry are the first letter,
 * the size, and the last two digits.
 *
 * @returns { insert, insertIc, noseRadius } or null when it does not look like one
 */
export function parseInsertCode(code) {
  const text = String(code ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
  // shape · clearance · tolerance · type · edge · thickness · nose · anything.
  // The thickness field takes a letter on the thinner inserts (T3 is 3.97mm),
  // so it is not all digits — which is why it is matched and thrown away.
  const m = /^([RSCWTDV])[A-Z]{3}(\d{2})([\dA-Z]{2})([\dA-Z]{2})[A-Z0-9]*$/.exec(text);
  if (!m) return null;
  const [, letter, edge, , nose] = m;
  // A round insert has no nose radius to quote: the edge *is* the radius, so
  // the field holds a chipbreaker code instead and there is nothing to read.
  if (letter === 'R') {
    const ic = icFromEdge('R', Number(edge));
    return { insert: 'R', insertIc: ic, noseRadius: Math.round((ic / 2) * 1000) / 1000 };
  }
  if (!/^\d{2}$/.test(nose)) return null;
  return {
    insert: letter,
    // the code quotes the cutting edge length; IC is what the geometry is built
    // from, so the shape's own ratio between the two converts it
    insertIc: icFromEdge(letter, Number(edge)),
    // the last pair is tenths of a millimetre: 08 is a 0.8 nose
    noseRadius: Number(nose) / 10,
  };
}

/**
 * Inscribed circle for a nominal edge length, by shape.
 *
 * These are the ratios that make the catalogue numbers come out: TNMG16 is a
 * 9.525 IC, WNMG08 is 12.7, CNMG12 is 12.7. A shape's edge and its inscribed
 * circle are only the same number on a square.
 */
const IC_PER_EDGE = { R: 1, S: 1, C: 1.058, W: 1.5875, T: 0.6, D: 0.85, V: 0.6 };

function icFromEdge(letter, edge) {
  if (!(edge > 0)) return 9.525;
  return Math.round(edge * (IC_PER_EDGE[letter] ?? 1) * 1000) / 1000;
}
