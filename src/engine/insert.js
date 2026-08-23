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
  // A custom grind: a rhombus of whatever corner angle the tool carries in
  // `insertAngle`, so an off-catalogue or hand-ground insert can be described
  // rather than forced into the nearest letter. See insertOutline.
  X: { label: 'Custom', cornerAngle: 60, kind: 'custom' },
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
export function insertOutline(shape, ic = 12, noseRadius = 0.8, segments = ARC_SEGMENTS, cornerAngle = null, customPoints = null) {
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

  const scaled = scaledInsert(shape, ic, cornerAngle, customPoints);
  // never a nose bigger than the insert can hold: a 1.2mm nose on a 6mm IC
  // V insert is not a rounded corner, it is a different shape
  const nose = Math.min(Math.max(0, noseRadius), r * 0.6);
  const points = filletPolygon(scaled, nose, segments);
  return { points, cornerAt: scaled[0], ic };
}

/**
 * The insert's *sharp* polygon, scaled to the inscribed circle — the shape
 * before the nose radius rounds the corner off.
 *
 * The cutting corner is vertex 0, pointing at −Y. Kept as its own function
 * because two things need the sharp corners rather than the rounded outline: the
 * fillet (which needs a corner to round), and the engagement geometry (which
 * needs the straight cutting edges the arc would otherwise hide — see
 * `insertEngagement`). Building it in one place is what stops the drawing and
 * the engagement from disagreeing about where an edge is.
 *
 * @param customPoints for the custom shape 'X': an explicit polygon, cutting
 *   corner first, in any consistent scale. Falls back to a rhombus of
 *   `cornerAngle` when absent, so an 'X' tool with only an angle still draws.
 */
export function scaledInsert(shape, ic = 12, cornerAngle = null, customPoints = null) {
  const spec = INSERT_SHAPES[shape] ?? INSERT_SHAPES.C;
  const r = Math.max(0.5, ic) / 2;
  // A custom insert is either an explicit polygon the user drew, or — with only
  // an angle to go on — a rhombus of that angle. Both are the one shape that
  // takes its geometry from the tool rather than from the letter.
  const custom = spec.kind === 'custom'
    ? Math.max(20, Math.min(160, cornerAngle ?? spec.cornerAngle))
    : null;
  let raw = spec.kind === 'regular' ? regularPolygon(spec.sides)
    : spec.kind === 'trigon' ? trigon()
      : spec.kind === 'custom' && isPolygon(customPoints) ? seatCorner(customPoints)
        : rhombus(custom ?? spec.cornerAngle);

  // A degenerate custom polygon — three points in a line, or a sliver — has
  // almost no inscribed circle, and scaling *that* up to the real IC blows the
  // shape up to metres across. It is not an insert, so it falls back to the
  // rhombus the corner angle describes rather than drawing nonsense.
  if (spec.kind === 'custom' && isPolygon(customPoints)) {
    const extent = Math.max(...raw.map(([x, y]) => Math.hypot(x, y)));
    // a plain 80° rhombus, not one of the degenerate angle the sliver measured
    if (!(inradius(raw) > extent * 0.05)) raw = rhombus(80);
  }

  // Built at an arbitrary scale, then scaled so the inscribed circle is right.
  // Solving each shape's vertex radius in closed form is three different pieces
  // of trigonometry; measuring the incircle is one, and it cannot disagree with
  // the polygon it measured.
  const scale = r / inradius(raw);
  return raw.map(([x, y]) => [x * scale, y * scale]);
}

/** Is this a usable custom polygon — at least a triangle of finite points? */
export function isPolygon(points) {
  return Array.isArray(points) && points.length >= 3
    && points.every((p) => Array.isArray(p) && p.length === 2
      && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/**
 * Normalise a custom polygon to the same frame the lettered shapes are built
 * in: centred on its centroid, with the cutting corner (vertex 0) pointing at
 * −Y and the body above it.
 *
 * This is what lets a hand-drawn insert be placed, filleted, engaged and drawn
 * by exactly the code the catalogue shapes use — the editor draws in whatever
 * frame is convenient, and this is the one place that frame is made to match the
 * `rhombus`/`regularPolygon` convention (corner at −Y, bisector up +Y). Every
 * downstream reader — the seating in `latheToolOutline`, the walk in
 * `insertEngagement`, and `cornerAngleOf` — treats vertex 0 as the cutting
 * corner, so this is the one place that guarantees the user's marked corner *is*
 * vertex 0.
 */
function seatCorner(points) {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of points) { cx += x; cy += y; }
  cx /= points.length;
  cy /= points.length;
  const centred = points.map(([x, y]) => [x - cx, y - cy]);
  // rotate so the cutting corner (vertex 0) points at −Y
  const c0 = centred[0];
  const have = Math.atan2(c0[1], c0[0]);
  const rot = -Math.PI / 2 - have;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return centred.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
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

/** The point of `points` closest to `to` — used to find a corner after filleting. */
function nearestPoint(points, to) {
  let best = points[0];
  let bd = Infinity;
  for (const p of points) {
    const d = (p[0] - to[0]) ** 2 + (p[1] - to[1]) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
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
 * The corner angle of the insert on a tool — the letter's, or the tool's own
 * `insertAngle` when it is the custom shape.
 */
export function cornerAngleOf(tool) {
  const shape = INSERT_SHAPES[tool?.insert] ?? INSERT_SHAPES.C;
  if (shape.kind !== 'custom') return shape.cornerAngle;
  // An explicit custom polygon carries its own corner angle in its geometry:
  // the included angle at the cutting vertex is a fact about the drawing, not a
  // second number to keep in step with it. Only when there is no polygon does
  // the tool's `insertAngle` (the rhombus fallback) decide.
  if (isPolygon(tool?.customPoints)) return polygonCornerAngle(tool.customPoints);
  return Math.max(20, Math.min(160, tool?.insertAngle ?? 60));
}

/** The included angle (degrees) at the cutting corner — vertex 0 — of a polygon. */
export function polygonCornerAngle(points) {
  const seated = seatCorner(points);
  const c = seated[0];
  const p = seated[seated.length - 1];
  const q = seated[1];
  const u = unit(p[0] - c[0], p[1] - c[1]);
  const v = unit(q[0] - c[0], q[1] - c[1]);
  const cos = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * The lead (approach) angle a tool actually cuts at, once its holder is clocked.
 *
 * The insert has a lead angle ground into it; a Multifix or quick-change block
 * then holds the whole tool at `mountAngle`, and the cut sees the sum. A tool
 * ground at 95° and mounted 5° nose-down turns as an 90° tool — which is the
 * whole reason the mount angle is worth having, and the thing to keep in mind
 * before trusting the angle written on the holder.
 */
export function effectiveLead(tool) {
  const type = tool?.type;
  if (type === 'parting' || type === 'threading') return 0;
  const lead = Number.isFinite(tool?.leadAngle) ? tool.leadAngle
    : (type === 'boring' ? 92 : 95);
  return lead - (tool?.mountAngle ?? 0);
}

/** The unit direction the holder body runs in, for an insert rotated by `deg`. */
function bodyDir(deg) {
  const a = (deg * Math.PI) / 180;
  return [-Math.sin(a), Math.cos(a)];
}

/**
 * Where the insert sits and which way the shank runs, for a tool.
 *
 * The insert's major cutting edge is set to the tool's lead angle: `insertOutline`
 * hands back a shape whose cutting corner points at −Y with the two edges ε apart
 * about the +Y bisector (ε the corner angle), and rotating it by `ε/2 − κ` lays
 * the major edge at κ off the face — 0° a facing edge, 90° pure OD turning, a
 * little over 90° a tool that back-faces a shoulder. So a 93° and a 62° tool are
 * posed, and drawn, as the different tools they are rather than one fixed wedge.
 * The holder then trails along the insert's bisector, away from the cut. A
 * left-hand tool is the mirror of the right about the radial axis (`flipZ`); the
 * mount angle clocks the whole thing. The rotation and the shank are one
 * statement of which side of the cut the body is on, so they are computed from
 * one angle and cannot disagree.
 *
 * @returns {{ rotationDeg, shank: [dz, dx], approach, flipZ }}
 */
export function toolPose(tool) {
  const hand = tool?.hand ?? 'R';
  const mount = Number.isFinite(tool?.mountAngle) ? tool.mountAngle : 0;
  const eps = cornerAngleOf(tool);
  // The lead ground into the insert, before the block clocks the whole tool. The
  // mount is then *added to the rotation* below, which is the same swing the
  // effective lead loses — the tool turns, and the cut sees the difference.
  const ground = Number.isFinite(tool?.leadAngle) ? tool.leadAngle
    : (tool?.type === 'boring' ? 92 : 95);

  if (tool?.type === 'parting') {
    // A blade goes straight in: no lead angle, body directly outboard, but the
    // holder still clocks with the block.
    const rot = mount;
    return { rotationDeg: rot, shank: bodyDir(rot), approach: 'radial', flipZ: false };
  }
  if (tool?.type === 'threading') {
    // A pointed insert on a square shank, fed straight in — square to the axis
    // so the two flank angles stay equal — plus whatever the block is clocked to.
    const rot = mount;
    return { rotationDeg: rot, shank: bodyDir(rot), approach: 'radial', flipZ: false };
  }
  if (tool?.type === 'boring') {
    // Inside the bore the insert cuts *up* into the wall (+X) and the bar runs
    // back out of the hole toward the tailstock (+Z, −X). It is the OD pose
    // turned to face the wall, and the lead still leans the major edge.
    const rot = 180 - (eps / 2 - ground) + mount;
    return { rotationDeg: rot, shank: bodyDir(rot), approach: 'internal', flipZ: hand === 'L' };
  }
  // OD turning: lay the major edge at the lead angle, body trailing to +Z/+X,
  // then clock the whole tool by the mount angle.
  const rot = eps / 2 - ground + mount;
  return { rotationDeg: rot, shank: bodyDir(rot), approach: 'external', flipZ: hand === 'L' };
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

  const shape = tool?.insert ?? defaultShapeFor(type);
  const outline = type === 'threading'
    ? { points: threadingInsert(tool, ic), cornerAt: [0, 0] }
    : insertOutline(shape, ic, nose, ARC_SEGMENTS,
      shape === 'X' ? cornerAngleOf(tool) : null,
      shape === 'X' ? tool?.customPoints : null);
  const points = outline.points;
  // Seat the *marked* cutting corner at the origin, then rotate to the lead
  // angle. The cutting corner is a known vertex — `cornerAt`, the sharp corner
  // the outline was built around, which `cornerAngleOf` also measures — not
  // simply the lowest point: a hand-drawn custom insert can have another vertex
  // dip lower, and seating on *that* would cut on a corner the user never marked
  // and whose angle nothing reports (the two-descriptions bug this file fights).
  // We seat on the filleted point nearest that sharp corner — the bottom of its
  // nose arc — which for the symmetric catalogue shapes is exactly the lowest
  // point, so their drawing is unchanged.
  const tip = nearestPoint(points, outline.cornerAt);
  const seated = points.map(([x, y]) => [x - tip[0], y - tip[1]]);
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
  const sections = [
    { kind: 'holder', points: holder },
    { kind: 'insert', points: insert },
  ];
  // A left-hand tool is the mirror of the right about the radial axis — the same
  // insert and holder, reflected in Z. Built once as a right-hand tool and
  // flipped, so the two hands cannot drift apart.
  if (pose.flipZ) {
    for (const s of sections) s.points = s.points.map(([z, x]) => [-z, x]);
  }
  return sections;
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

// --- engagement: where the insert meets the work, and whether it is too much --
//
// A turning insert cuts on a corner, not on a disc, so the number that says
// whether a cut is heavy is the depth of cut — how much radius the tool takes
// in one pass — and how much of the cutting edge that depth engages. Too much
// engaged edge is how an insert is broken rather than worn, so this is worth
// drawing (see app/tool-shape.js) and worth warning about (see the strategies).
//
// Everything here is measured off the same sharp insert the drawing is built
// from, in the same (Z, radius) frame, so the picture and the numbers cannot
// disagree — the recurring bug in this codebase is two descriptions of one
// shape (see [one description, not two]).

/**
 * The insert, seated and posed exactly as `latheToolOutline` draws it, but as
 * the *sharp* polygon — the nose is a true vertex with two straight cutting
 * edges rather than an arc, which is what the engagement geometry has to walk.
 *
 * @returns {{ points: [[z, x], …], noseIndex }} the cutting corner at the
 *   origin (radius up), and which vertex it is
 */
export function seatedInsert(tool, { sharp = true } = {}) {
  const type = tool?.type ?? 'turning';
  const pose = toolPose(tool);
  const ic = insertIcOf(tool);
  const nose = Math.max(0, tool?.noseRadius ?? 0);
  const shape = tool?.insert ?? defaultShapeFor(type);
  const custom = shape === 'X' ? cornerAngleOf(tool) : null;
  const customPts = shape === 'X' ? tool?.customPoints : null;
  const pts = sharp
    ? scaledInsert(shape, ic, custom, customPts)
    : insertOutline(shape, ic, nose, ARC_SEGMENTS, custom, customPts).points;
  // The same seat-then-rotate the outline does, then the left-hand mirror it
  // applies to the finished sections — kept in step so this frame is the frame
  // the tool is drawn in. The cutting corner is vertex 0: every builder
  // (`rhombus`, `regularPolygon`, `trigon`, `seatCorner`) puts the marked corner
  // there, and `cornerAngleOf` measures it there. It is *not* re-derived as the
  // lowest point — for a symmetric catalogue insert that is vertex 0 anyway, but
  // a hand-drawn custom can have another vertex dip lower, and walking the
  // engagement from that one would read a corner the user never marked.
  const noseIndex = 0;
  const tip = pts[noseIndex];
  const seated = pts.map(([x, y]) => [x - tip[0], y - tip[1]]).map(rotator(pose.rotationDeg));
  const points = pose.flipZ ? seated.map(([z, x]) => [-z, x]) : seated;
  return { points, noseIndex };
}

/**
 * The length of the insert's cutting edge, mm — the straight edge running back
 * from the nose corner, which is what a depth of cut is spent against.
 *
 * A round insert has no straight edge; its whole periphery cuts, so the usable
 * length is taken as the inscribed circle, which is the honest "how much edge is
 * there" for it.
 */
export function cuttingEdgeLength(tool) {
  const ic = insertIcOf(tool);
  const shape = tool?.insert ?? 'C';
  if ((INSERT_SHAPES[shape] ?? INSERT_SHAPES.C).kind === 'round') return ic;
  const poly = scaledInsert(shape, ic,
    shape === 'X' ? cornerAngleOf(tool) : null,
    shape === 'X' ? tool?.customPoints : null);
  // the two edges at the cutting corner — vertex 0, the marked corner the
  // engagement also walks from (see seatedInsert) so the two agree on which
  // corner is cutting. The cut is taken against the shorter of them, the one
  // that runs out first.
  const ci = 0;
  const c = poly[ci];
  const a = poly[(ci - 1 + poly.length) % poly.length];
  const b = poly[(ci + 1) % poly.length];
  const la = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const lb = Math.hypot(b[0] - c[0], b[1] - c[1]);
  return Math.min(la, lb);
}

/**
 * How much of the cutting edge a depth of cut engages, and whether that is more
 * than the insert should be asked to take.
 *
 * The engaged edge is found by geometry rather than by a textbook formula,
 * because the app's lead angle already orients the drawn insert and the honest
 * question is "how much of *that* edge is in the metal": the tool is seated with
 * its nose at the origin, the pass has taken a band of stock `ap` deep (a band
 * of radius, from the nose out to `ap` above it), and the engaged edge is the
 * leading cutting edge walked from the nose until it climbs out of that band.
 *
 * A low lead angle lays the edge nearly along the bar, so the same depth engages
 * a long stretch of it — a thinner chip spread over more edge — and a near-90°
 * edge engages barely more than the depth itself. Both fall straight out of the
 * geometry, which is the point of measuring rather than reading.
 *
 * @returns {{ ap, engagedLength, edgeLength, fraction, apMax, overloaded,
 *   edge:[[z,x],[z,x]], band:[[z,x],…] }}
 */
export function insertEngagement(tool, ap) {
  const depth = Math.max(0, ap);
  const edgeLength = cuttingEdgeLength(tool);
  const apMax = recommendedDepthOfCut(tool);
  const shape = tool?.insert ?? 'C';
  const round = (INSERT_SHAPES[shape] ?? INSERT_SHAPES.C).kind === 'round';
  // Which way the metal sits. An OD tool cuts down to its nose, so the stock it
  // is removing is *above* the nose in radius (+x); a boring bar opens a hole
  // outward, so the stock is *below* it (−x). Getting this backwards is the
  // inside/outside sign error the whole lathe file warns about.
  const into = tool?.type === 'boring' ? -1 : 1;
  const result = (engagedLength, edge) => ({
    ap: depth,
    engagedLength,
    edgeLength,
    fraction: edgeLength > 0 ? engagedLength / edgeLength : 0,
    apMax,
    overloaded: depth > apMax + 1e-6,
    edge,
    band: [edge[0], edge[1], [edge[1][0], edge[0][1]]],
  });

  if (round) {
    // No straight edge: the engaged length is the arc the nose rolls through to
    // reach `ap` deep, on a circle of the nose radius.
    const rN = Math.max(0.5, tool?.noseRadius || insertIcOf(tool) / 2);
    const theta = Math.acos(Math.max(-1, 1 - Math.min(depth, 2 * rN) / rN));
    const nose = [0, 0];
    const end = [-Math.sin(theta) * rN, into * (1 - Math.cos(theta)) * rN];
    return result(Math.min(edgeLength, rN * theta), [nose, end]);
  }

  const { points: poly, noseIndex } = seatedInsert(tool, { sharp: true });
  const nose = poly[noseIndex];               // the tip that reaches the work
  const neighbours = [poly[(noseIndex + 1) % poly.length],
    poly[(noseIndex - 1 + poly.length) % poly.length]];
  const cand = neighbours.map((p) => ({
    dir: unit(p[0] - nose[0], p[1] - nose[1]),
    span: Math.hypot(p[0] - nose[0], p[1] - nose[1]),
  }));
  // The leading cutting edge is the one that climbs into the metal — furthest in
  // the `into` direction per unit length. The other neighbour runs along the
  // finished surface and cuts nothing in a straight pass.
  const lead = into * cand[0].dir[1] >= into * cand[1].dir[1] ? cand[0] : cand[1];
  const rise = Math.max(1e-6, into * lead.dir[1]);   // radius climbed per unit edge
  // length along the edge to reach `ap` deep, capped at the edge itself: past the
  // vertex the cut is on the next edge, a different and usually catastrophic
  // engagement the warning exists to forbid
  const engagedLength = Math.min(lead.span, depth / rise);
  const end = [nose[0] + lead.dir[0] * engagedLength, nose[1] + lead.dir[1] * engagedLength];
  return result(engagedLength, [nose, end]);
}

/**
 * The deepest cut this insert should take in one pass, mm.
 *
 * The rule of thumb is that a depth of cut past about two-thirds of the cutting
 * edge is asking to break the insert, and a sharper corner is weaker still — a
 * 35° V insert cannot take what an 80° C insert can out of the same inscribed
 * circle. So the safe fraction of the edge scales with the corner angle, and the
 * depth that fraction of edge corresponds to depends on how steeply the lead lays
 * the edge into the cut: a shallow lead spends a long edge on a small depth.
 *
 * Advisory, and deliberately generous — without the material and the machine
 * there is no exact number, only an obviously reckless one. What this catches is
 * a 6mm depth of cut on a finishing insert.
 */
export function recommendedDepthOfCut(tool) {
  const edgeLength = cuttingEdgeLength(tool);
  const shape = tool?.insert ?? 'C';
  if ((INSERT_SHAPES[shape] ?? INSERT_SHAPES.C).kind === 'round') {
    // a round insert has no corner to break and is the strongest there is; the
    // usual limit is a fraction of its radius before the cut wraps too far round
    return Math.max(0.1, edgeLength * 0.25);
  }
  const eps = cornerAngleOf(tool);
  // strength grows with the corner angle: 20°→0.15 of the edge, 90°+→0.66
  const frac = Math.max(0.15, Math.min(0.66, (eps - 20) / (90 - 20) * (0.66 - 0.15) + 0.15));
  // the steepest the leading edge is laid tells how much depth that edge buys —
  // measured toward the metal, which is up for turning and down for a boring bar
  const into = tool?.type === 'boring' ? -1 : 1;
  const { points: poly, noseIndex } = seatedInsert(tool, { sharp: true });
  const nose = poly[noseIndex];
  const next = poly[(noseIndex + 1) % poly.length];
  const prev = poly[(noseIndex - 1 + poly.length) % poly.length];
  const rise = Math.max(0.05, Math.max(
    into * unit(next[0] - nose[0], next[1] - nose[1])[1],
    into * unit(prev[0] - nose[0], prev[1] - nose[1])[1],
  ));
  return Math.max(0.05, edgeLength * frac * rise);
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
