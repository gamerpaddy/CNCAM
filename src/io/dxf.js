// DXF import: 2D drawings, as polylines you can drive a cutter down.
//
// This is the format a 2D drawing arrives in — a logo to engrave, a plate
// outline to cut, a fold line to scribe — and none of it is a solid, so none of
// it can come in as a mesh. It comes in as *curves*, which is what an engraving
// pass wants anyway: the line is the feature and the tool centre belongs on it.
//
// A DXF file is a flat list of (group code, value) pairs. Everything below is
// reading that list and turning the handful of entity types that carry 2D
// geometry into polylines. Curves are chorded to a tolerance here rather than
// carried as arcs, because every consumer downstream — the offsetter, the
// simulator, the backplot — already works in polylines, and the post's arc
// fitter puts the arcs back on the way out.
//
// What is deliberately not supported: INSERT/BLOCK, which needs a full
// transform stack and is a fair amount of work for a first pass, and 3D
// entities, which are not what this is for. Both are counted and reported, so a
// file that came in half-empty says why rather than looking like a broken
// parser.

const DEG = Math.PI / 180;

/** Millimetres per unit, by $INSUNITS. The ones a CAM user actually meets. */
const UNIT_SCALE = {
  0: 1,          // unitless — assume the file is already in millimetres
  1: 25.4,       // inches
  2: 304.8,      // feet
  4: 1,          // millimetres
  5: 10,         // centimetres
  6: 1000,       // metres
  9: 0.0254,     // microinches
  10: 914.4,     // yards
  11: 1e-7,      // ångströms — present for completeness, not for machining
  12: 1e-6,
  13: 1e-3,
};

/**
 * Split the file into (code, value) pairs.
 *
 * DXF is line-based: an integer group code on one line, its value on the next.
 * Binary DXF exists and is not handled; it is rare out of anything a machinist
 * uses and it announces itself with a sentinel, which is what the check is for.
 */
function tokenize(text) {
  if (text.startsWith('AutoCAD Binary DXF')) {
    throw new Error('this is a binary DXF — re-export it as ASCII DXF');
  }
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isFinite(code)) continue;
    pairs.push([code, lines[i + 1]]);
  }
  return pairs;
}

/**
 * Parse a DXF into 2D paths.
 *
 * @param text the file, as text
 * @param options { tolerance } chord tolerance for arcs and splines, in the
 *   file's own units before scaling.
 *
 *   The default is **half the post's arc tolerance**, and that relationship is
 *   the whole reason for the number. It was 0.02mm on the argument that no
 *   machine tool notices 20 microns, which is true of the *cut* and misses what
 *   happens downstream: the post fits arcs to 0.01mm and refuses any chord
 *   whose bulge is coarser than that, so a drawn circle chorded at 0.02 could
 *   never be recognised as the circle it is. Every engraved circle posted as
 *   fifty G1 blocks — a polygon on the screen, a polygon in the file, and
 *   audibly a polygon on the machine. Chorded finer than the fitter's budget it
 *   posts as one G2, which is both smaller and exact.
 * @returns { paths: [{ points: [x, y, …], closed, layer }], bounds, units,
 *            skipped: { type: count } }
 */
export function parseDXF(text, { tolerance = 0.005 } = {}) {
  const pairs = tokenize(text);
  const scale = unitScale(pairs);
  const paths = [];
  const skipped = {};

  let i = 0;
  // walk to ENTITIES; a file with no such section has no geometry in it
  while (i < pairs.length && !(pairs[i][0] === 2 && pairs[i][1].trim() === 'ENTITIES')) i++;
  if (i >= pairs.length) {
    return { paths: [], bounds: null, units: scale, skipped: { 'no ENTITIES section': 1 } };
  }
  i++;

  const tol = tolerance / (scale || 1);
  while (i < pairs.length) {
    const [code, raw] = pairs[i];
    if (code !== 0) { i++; continue; }
    const type = raw.trim();
    if (type === 'ENDSEC') break;

    const { entity, next } = readEntity(pairs, i);
    i = next;
    const made = entityToPaths(type, entity, tol);
    if (made === null) {
      skipped[type] = (skipped[type] ?? 0) + 1;
      continue;
    }
    for (const path of made) {
      if (path.points.length >= 4) paths.push(path);
    }
  }

  // scale into millimetres once, at the end, so everything above is in the
  // file's own numbers and only one place knows about units
  if (scale !== 1) {
    for (const path of paths) {
      for (let k = 0; k < path.points.length; k++) path.points[k] *= scale;
    }
  }
  return { paths, bounds: boundsOf(paths), units: scale, skipped };
}

/** $INSUNITS, as millimetres per drawing unit. */
function unitScale(pairs) {
  for (let i = 0; i + 1 < pairs.length; i++) {
    if (pairs[i][0] === 9 && pairs[i][1].trim() === '$INSUNITS') {
      const value = Number(pairs[i + 1][1]);
      return UNIT_SCALE[value] ?? 1;
    }
  }
  return 1;
}

/**
 * Collect one entity's group codes, up to the next 0-code.
 *
 * Repeated codes matter — a polyline's vertices are all code 10 — so values are
 * kept as arrays and the callers take the first or the whole list as they need.
 * A POLYLINE swallows its VERTEX entities, which is the one place the flat pair
 * list is really a tree.
 */
function readEntity(pairs, start) {
  const entity = new Map();
  const push = (code, value) => {
    if (!entity.has(code)) entity.set(code, []);
    entity.get(code).push(value);
  };
  const type = pairs[start][1].trim();
  let i = start + 1;

  // The pairs in the order they were written, as well as grouped by code. The
  // grouping is what almost everything wants; the order is what a bulge needs,
  // because a bulge is written after the vertex it belongs to and only when it
  // is non-zero. See bulgesFor.
  const ordered = [];
  while (i < pairs.length && pairs[i][0] !== 0) {
    push(pairs[i][0], pairs[i][1]);
    ordered.push(pairs[i]);
    i++;
  }
  entity.set('__order', ordered);

  // an old-style POLYLINE is a header followed by VERTEX entities and a SEQEND
  if (type === 'POLYLINE') {
    const vertices = [];
    while (i < pairs.length) {
      const marker = pairs[i][1].trim();
      if (marker === 'SEQEND') {
        i++;
        while (i < pairs.length && pairs[i][0] !== 0) i++;
        break;
      }
      if (marker !== 'VERTEX') break;
      const { entity: vertex, next } = readEntity(pairs, i);
      i = next;
      vertices.push({
        x: number(vertex, 10, 0),
        y: number(vertex, 20, 0),
        bulge: number(vertex, 42, 0),
      });
    }
    entity.set('vertices', vertices);
  }
  return { entity, next: i };
}

function number(entity, code, fallback = 0) {
  const value = Number(entity.get(code)?.[0]);
  return Number.isFinite(value) ? value : fallback;
}

function numbers(entity, code) {
  return (entity.get(code) ?? []).map(Number).filter(Number.isFinite);
}

function text(entity, code, fallback = '') {
  return entity.get(code)?.[0]?.trim() ?? fallback;
}

/**
 * One entity as zero or more paths, or null when the type is not handled.
 *
 * Null and an empty array mean different things and the caller acts on both: an
 * unhandled type is reported to the user, and a handled type that happened to
 * produce nothing (a zero-radius circle) is simply not there.
 */
function entityToPaths(type, entity, tol) {
  const layer = text(entity, 8, '0');
  const path = (points, closed = false) => [{ points, closed, layer }];

  switch (type) {
    case 'LINE':
      return path([
        number(entity, 10), number(entity, 20),
        number(entity, 11), number(entity, 21),
      ]);

    case 'LWPOLYLINE': {
      const xs = numbers(entity, 10);
      const ys = numbers(entity, 20);
      // Bulges are sparse: only the vertices that carry one have a 42, so the
      // list cannot be zipped against the vertices by index. They are read back
      // out of the raw pair order instead — see bulgesFor.
      const bulges = bulgesFor(entity, xs.length);
      const closed = (number(entity, 70, 0) & 1) === 1;
      return path(polylinePoints(xs, ys, bulges, closed, tol), closed);
    }

    case 'POLYLINE': {
      const vertices = entity.get('vertices') ?? [];
      const closed = (number(entity, 70, 0) & 1) === 1;
      return path(polylinePoints(
        vertices.map((v) => v.x), vertices.map((v) => v.y),
        vertices.map((v) => v.bulge), closed, tol,
      ), closed);
    }

    case 'CIRCLE': {
      const r = number(entity, 40);
      if (!(r > 0)) return [];
      return path(arcPoints(number(entity, 10), number(entity, 20), r, 0, Math.PI * 2, tol), true);
    }

    case 'ARC': {
      const r = number(entity, 40);
      if (!(r > 0)) return [];
      const from = number(entity, 50) * DEG;
      let to = number(entity, 51) * DEG;
      // DXF arcs always run counter-clockwise from start to end
      while (to <= from) to += Math.PI * 2;
      return path(arcPoints(number(entity, 10), number(entity, 20), r, from, to - from, tol));
    }

    case 'ELLIPSE':
      return path(ellipsePoints(entity, tol),
        Math.abs((number(entity, 42, Math.PI * 2) - number(entity, 41, 0))
          - Math.PI * 2) < 1e-6);

    case 'SPLINE': {
      const points = splinePoints(entity, tol);
      return points.length >= 4 ? path(points, (number(entity, 70, 0) & 1) === 1) : [];
    }

    // Not geometry, or geometry this does not do yet. Counted and reported
    // rather than dropped in silence.
    case 'POINT': case 'TEXT': case 'MTEXT': case 'DIMENSION':
    case 'INSERT': case 'HATCH': case 'SOLID': case 'ATTDEF':
      return null;

    default:
      return null;
  }
}

/**
 * The bulge for each vertex of an LWPOLYLINE.
 *
 * A bulge is written as a 42 immediately after the vertex it belongs to, and
 * only when it is non-zero — so the 42s and the 10s cannot be zipped by index.
 * The entity map keeps insertion order per code but not *between* codes, so the
 * association is rebuilt by counting: the nth bulge belongs to the vertex whose
 * 10 came before it. Without this a polyline with one arc in it comes back with
 * the arc on the first segment, which is a shape nobody drew.
 */
function bulgesFor(entity, count) {
  const out = new Array(count).fill(0);
  const order = entity.get('__order') ?? [];
  let vertex = -1;
  for (const [code, value] of order) {
    if (code === 10) vertex++;
    else if (code === 42 && vertex >= 0 && vertex < count) {
      const bulge = Number(value);
      if (Number.isFinite(bulge)) out[vertex] = bulge;
    }
  }
  return out;
}

/** A polyline's points, with each bulged segment replaced by its arc. */
function polylinePoints(xs, ys, bulges, closed, tol) {
  const n = Math.min(xs.length, ys.length);
  const out = [];
  if (n === 0) return out;
  const last = closed ? n : n - 1;

  out.push(xs[0], ys[0]);
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % n;
    const bulge = bulges[i] ?? 0;
    if (Math.abs(bulge) < 1e-12) {
      out.push(xs[j], ys[j]);
      continue;
    }
    // bulge = tan(θ/4), θ the included angle, positive counter-clockwise
    const theta = 4 * Math.atan(bulge);
    const dx = xs[j] - xs[i];
    const dy = ys[j] - ys[i];
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-12) { out.push(xs[j], ys[j]); continue; }
    const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
    // the centre is off the chord's midpoint, on the side the bulge points
    const height = radius * Math.cos(theta / 2);
    const mx = (xs[i] + xs[j]) / 2;
    const my = (ys[i] + ys[j]) / 2;
    const nx = -dy / chord;
    const ny = dx / chord;
    const cx = mx + nx * height * Math.sign(theta);
    const cy = my + ny * height * Math.sign(theta);
    const from = Math.atan2(ys[i] - cy, xs[i] - cx);
    const arc = arcPoints(cx, cy, radius, from, theta, tol);
    for (let k = 2; k < arc.length; k++) out.push(arc[k]);
  }
  return out;
}

/** An arc as points, chorded so the sagitta stays under `tol`. */
function arcPoints(cx, cy, r, from, sweep, tol) {
  const steps = arcSteps(r, Math.abs(sweep), tol);
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + (sweep * i) / steps;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

/**
 * How many chords an arc needs.
 *
 * The sagitta of a chord subtending angle φ on radius r is r(1 − cos(φ/2)), so
 * the largest φ that stays inside the tolerance falls straight out of it. A
 * fixed segment count is what makes small circles look like polygons and large
 * ones cost a thousand points for nothing.
 */
function arcSteps(r, sweep, tol) {
  if (!(r > 0) || !(sweep > 0)) return 1;
  const ratio = Math.max(-1, Math.min(1, 1 - Math.max(1e-9, tol) / r));
  const maxAngle = 2 * Math.acos(ratio);
  return Math.max(2, Math.min(2048, Math.ceil(sweep / Math.max(1e-6, maxAngle))));
}

/** An ellipse or elliptical arc, from its centre, major axis vector and ratio. */
function ellipsePoints(entity, tol) {
  const cx = number(entity, 10);
  const cy = number(entity, 20);
  const mx = number(entity, 11);
  const my = number(entity, 21);
  const ratio = number(entity, 40, 1);
  const from = number(entity, 41, 0);
  let to = number(entity, 42, Math.PI * 2);
  while (to <= from) to += Math.PI * 2;

  const major = Math.hypot(mx, my);
  if (!(major > 0)) return [];
  const minor = major * ratio;
  const rot = Math.atan2(my, mx);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  // chorded against the *larger* radius, so the flatter end is not under-sampled
  const steps = arcSteps(major, to - from, tol);
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = from + ((to - from) * i) / steps;
    const ex = major * Math.cos(t);
    const ey = minor * Math.sin(t);
    out.push(cx + ex * cos - ey * sin, cy + ex * sin + ey * cos);
  }
  return out;
}

/**
 * A B-spline, evaluated properly rather than approximated by its control
 * polygon.
 *
 * A spline's control points are not on the curve — joining them gives a shape
 * that touches the real one at the ends and misses it everywhere else, by as
 * much as a third of the curvature. On an engraved logo that is the difference
 * between the letters you drew and letters that look melted. So the basis
 * functions are evaluated: de Boor's algorithm, at a sample count taken from
 * the control polygon's own length.
 */
function splinePoints(entity, tol) {
  const xs = numbers(entity, 10);
  const ys = numbers(entity, 20);
  const knots = numbers(entity, 40);
  const weights = numbers(entity, 41);
  const degree = Math.max(1, Math.round(number(entity, 71, 3)));
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return [];
  if (n <= degree || knots.length !== n + degree + 1) {
    // not a spline this can evaluate — the control polygon is at least the
    // right shape, and saying so beats dropping the entity
    const out = [];
    for (let i = 0; i < n; i++) out.push(xs[i], ys[i]);
    return out;
  }

  // Sample count from how far the control polygon travels: a long sweeping
  // spline needs more points than a short one, and neither needs a fixed 100.
  let span = 0;
  for (let i = 1; i < n; i++) span += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  const steps = Math.max(8, Math.min(4000, Math.ceil(span / Math.max(1e-6, tol * 20))));

  const lo = knots[degree];
  const hi = knots[n];
  const out = [];
  for (let s = 0; s <= steps; s++) {
    const t = lo + ((hi - lo) * s) / steps;
    const p = deBoor(t === hi ? hi - 1e-12 : t, degree, knots, xs, ys, weights, n);
    if (p) out.push(p[0], p[1]);
  }
  return out;
}

/** de Boor's algorithm at parameter `t`, rational when weights are present. */
function deBoor(t, degree, knots, xs, ys, weights, n) {
  let k = degree;
  while (k < n && knots[k + 1] <= t) k++;
  if (k >= n) k = n - 1;

  const rational = weights.length === n;
  const px = [];
  const py = [];
  const pw = [];
  for (let j = 0; j <= degree; j++) {
    const index = k - degree + j;
    const w = rational ? weights[index] : 1;
    px.push(xs[index] * w);
    py.push(ys[index] * w);
    pw.push(w);
  }

  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const index = k - degree + j;
      const lo = knots[index];
      const hi = knots[index + degree - r + 1];
      const denom = hi - lo;
      const a = denom > 1e-12 ? (t - lo) / denom : 0;
      px[j] = (1 - a) * px[j - 1] + a * px[j];
      py[j] = (1 - a) * py[j - 1] + a * py[j];
      pw[j] = (1 - a) * pw[j - 1] + a * pw[j];
    }
  }
  const w = pw[degree];
  if (!(Math.abs(w) > 1e-12)) return null;
  return [px[degree] / w, py[degree] / w];
}

/** Extent of a set of paths, or null when there are none. */
export function boundsOf(paths) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { points } of paths) {
    for (let i = 0; i < points.length; i += 2) {
      if (points[i] < minX) minX = points[i];
      if (points[i] > maxX) maxX = points[i];
      if (points[i + 1] < minY) minY = points[i + 1];
      if (points[i + 1] > maxY) maxY = points[i + 1];
    }
  }
  return Number.isFinite(minX) ? { min: [minX, minY], max: [maxX, maxY] } : null;
}

/**
 * Total length of every path, for reporting.
 *
 * "Imported 412 paths" says nothing about whether the drawing is the size you
 * thought; "412 paths, 3.1m of line, 84 × 22mm" says all of it.
 */
export function totalLength(paths) {
  let sum = 0;
  for (const { points, closed } of paths) {
    const n = points.length / 2;
    for (let i = 1; i < n; i++) {
      sum += Math.hypot(points[i * 2] - points[i * 2 - 2], points[i * 2 + 1] - points[i * 2 - 1]);
    }
    if (closed && n > 2) {
      sum += Math.hypot(points[0] - points[(n - 1) * 2], points[1] - points[(n - 1) * 2 + 1]);
    }
  }
  return sum;
}
