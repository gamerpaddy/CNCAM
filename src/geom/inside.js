// Point-in-polygon-set test for CNCAM loop sets.
//
// Loop sets follow the clipper convention: outers CCW, holes CW, non-zero fill.
// Crossing-number over every loop gives the right answer for that convention
// without needing to know which loop is which — a point inside an outer and
// inside a hole crosses both, and the parity cancels.

/**
 * Does `loop` have any of `loops` standing inside it?
 *
 * The question a clearing strategy has to ask of every hole in its region:
 * a hole is an island of *metal* only when the part is actually in it. Rest
 * machining subtracts what an earlier pass took, and every deduction leaves a
 * hole that is air — so the winding alone cannot tell an island from an emptied
 * floor, and reading it that way swung a lead arc out through a pocket wall.
 *
 * Sampled rather than intersected: a handful of points is enough to tell a boss
 * from cleared ground, and any hit is decisive. Erring toward "yes" is the safe
 * direction — that is the answer the winding used to give for every hole.
 */
export function loopEnclosesAny(loop, loops) {
  if (!loops?.length) return true;
  const n = loop.length / 2;
  if (n < 3) return true;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) { cx += loop[i * 2]; cy += loop[i * 2 + 1]; }
  cx /= n;
  cy /= n;
  if (pointInLoops([loop], cx, cy) && pointInLoops(loops, cx, cy)) return true;
  // the centroid of a horseshoe is outside it, so walk in from the rim as well
  const stride = Math.max(1, Math.floor(n / 12));
  for (let i = 0; i < n; i += stride) {
    const x = cx + (loop[i * 2] - cx) * 0.7;
    const y = cy + (loop[i * 2 + 1] - cy) * 0.7;
    if (pointInLoops([loop], x, y) && pointInLoops(loops, x, y)) return true;
  }
  return false;
}

/**
 * Is `loops` lying immediately *outside* `loop` — is this boundary up against it?
 *
 * The other half of the same question, for a region whose outer boundaries are
 * not all walls. Clearing runs between the stock edge and the part, so an outer
 * boundary is a wall only where the part is on the far side of it; the stock
 * edge has air beyond, and rest machining adds a third kind that looks like
 * neither — the edge of what the earlier pass emptied, with nothing beyond it
 * but the air that pass left. Told from the winding alone that one read as a
 * wall, and the lead swung into the boss it was clearing round.
 *
 * Probed a hair off each edge, on whichever side is not enclosed by the loop,
 * so the answer does not depend on which way the loop happens to be wound.
 */
export function loopBorderedBy(loop, loops, distance = 0.05) {
  if (!loops?.length) return false;
  const n = loop.length / 2;
  if (n < 3) return false;
  const stride = Math.max(1, Math.floor(n / 24));
  for (let i = 0; i < n; i += stride) {
    const j = (i + 1) % n;
    const ax = loop[i * 2];
    const ay = loop[i * 2 + 1];
    const dx = loop[j * 2] - ax;
    const dy = loop[j * 2 + 1] - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const mx = ax + dx / 2;
    const my = ay + dy / 2;
    const nx = (dy / len) * distance;
    const ny = (-dx / len) * distance;
    for (const [px, py] of [[mx + nx, my + ny], [mx - nx, my - ny]]) {
      if (pointInLoops([loop], px, py)) continue;      // that side is the inside
      if (pointInLoops(loops, px, py)) return true;
    }
  }
  return false;
}

/** How far a point is from the nearest edge of any of `loops`. */
export function distanceToLoops(loops, x, y) {
  let best = Infinity;
  for (const loop of loops) {
    const n = loop.length / 2;
    for (let i = 0, k = n - 1; i < n; k = i++) {
      const ax = loop[k * 2];
      const ay = loop[k * 2 + 1];
      const dx = loop[i * 2] - ax;
      const dy = loop[i * 2 + 1] - ay;
      const lenSq = dx * dx + dy * dy;
      let t = lenSq > 0 ? ((x - ax) * dx + (y - ay) * dy) / lenSq : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Does the straight line from a to b stay within the area `loops` fill — never
 * more than `eps` outside it?
 *
 * Exact, for the question a raster can only answer to a cell: a segment whose
 * ends are on the boundary and whose middle is not. It leaves the area either
 * by crossing an edge, or — with no crossing at all — by lying wholly outside
 * it, which is what the chord of an arc does when the area bends round
 * something: then its midpoint is outside, and it is a question of how far.
 * Touching the boundary, running along it, and ending on it are all inside.
 */
export function segmentInLoops(loops, ax, ay, bx, by, eps = 1e-6) {
  const sx = bx - ax;
  const sy = by - ay;
  const sLen = Math.hypot(sx, sy);
  if (sLen < 1e-12) return pointInLoops(loops, ax, ay) || distanceToLoops(loops, ax, ay) <= eps;
  const minX = Math.min(ax, bx) - eps;
  const maxX = Math.max(ax, bx) + eps;
  const minY = Math.min(ay, by) - eps;
  const maxY = Math.max(ay, by) + eps;
  for (const loop of loops) {
    const n = loop.length / 2;
    for (let i = 0, k = n - 1; i < n; k = i++) {
      const px = loop[k * 2];
      const py = loop[k * 2 + 1];
      const qx = loop[i * 2];
      const qy = loop[i * 2 + 1];
      if ((px < minX && qx < minX) || (px > maxX && qx > maxX)
        || (py < minY && qy < minY) || (py > maxY && qy > maxY)) continue;
      // A proper crossing: the edge's ends strictly either side of the segment,
      // and the segment's ends strictly either side of the edge — by more than
      // `eps` each, so an end lying on the boundary is not a crossing.
      const p = (sx * (py - ay) - sy * (px - ax)) / sLen;
      const q = (sx * (qy - ay) - sy * (qx - ax)) / sLen;
      if (!((p > eps && q < -eps) || (p < -eps && q > eps))) continue;
      const ex = qx - px;
      const ey = qy - py;
      const eLen = Math.hypot(ex, ey);
      const a = (ex * (ay - py) - ey * (ax - px)) / eLen;
      const b = (ex * (by - py) - ey * (bx - px)) / eLen;
      if ((a > eps && b < -eps) || (a < -eps && b > eps)) return false;
    }
  }
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  return pointInLoops(loops, mx, my) || distanceToLoops(loops, mx, my) <= eps;
}

/** Is (x, y) inside the filled area described by `loops`? */
export function pointInLoops(loops, x, y) {
  let inside = false;
  for (const loop of loops) {
    const n = loop.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = loop[i * 2 + 1];
      const yj = loop[j * 2 + 1];
      if ((yi > y) === (yj > y)) continue;
      const xi = loop[i * 2];
      const xj = loop[j * 2];
      if (x < xi + ((y - yi) / (yj - yi)) * (xj - xi)) inside = !inside;
    }
  }
  return inside;
}
