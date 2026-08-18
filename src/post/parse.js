// G-code read back into motion.
//
// The post is the one stage whose output nothing downstream checks: a strategy
// is verified against the part, the simulator against the CL data, and then the
// text that actually goes to the machine is trusted because it was printed by
// code that looked right. Reading it back closes that loop — parse the emitted
// program, expand its arcs, and the result can be diffed against the CL data it
// came from. A flipped G2/G3, a sign error in I/J or a lost modal word shows up
// as a path that no longer matches, rather than as a scrapped part.
//
// Deliberately small: motion words and modal state, in the G17 XY plane with
// incremental arc centres (G91.1 — what CNCAM emits, and the default on the
// controllers it posts for). Canned cycles are reported, not expanded; a G81
// hole is motion the CL data describes as one move anyway.

const WORD = /([A-Za-z])\s*(-?\d*\.?\d+)/g;

/**
 * @param text a G-code program
 * @param options.arcTolerance chord tolerance when expanding arcs (mm)
 * @returns {{ points, cycles, unsupported }}
 *   points: [{ x, y, z, rapid, line }] in order, one per resolved endpoint
 *   cycles: [{ code, x, y, z, r, q, line }] canned cycles, unexpanded
 *   unsupported: [{ code, line }] motion-ish words that were not understood
 */
export function parseGcode(text, { arcTolerance = 0.005 } = {}) {
  const points = [];
  const cycles = [];
  const unsupported = [];
  let motion = null;                 // modal G0/G1/G2/G3
  let cycle = null;                  // modal G81/G83…
  const at = { x: 0, y: 0, z: 0 };
  let started = false;

  text.split('\n').forEach((raw, line) => {
    const code = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim();
    if (!code) return;

    const words = [];
    for (const m of code.matchAll(WORD)) words.push([m[1].toUpperCase(), Number(m[2])]);
    const value = (letter) => {
      const found = words.find(([l]) => l === letter);
      return found ? found[1] : null;
    };

    for (const [letter, n] of words) {
      if (letter !== 'G') continue;
      if (n === 0 || n === 1 || n === 2 || n === 3) { motion = n; cycle = null; }
      else if (n === 80) { cycle = null; motion = null; }
      else if (n >= 81 && n <= 89) { cycle = n; motion = null; }
      else if ([17, 18, 19, 20, 21, 40, 43, 49, 53, 54, 55, 56, 57, 58, 59, 90, 91.1, 93, 94, 98, 99].includes(n)) {
        // plane, units, offsets, comp and feed modes: no motion of their own
      } else unsupported.push({ code: `G${n}`, line });
    }

    const x = value('X');
    const y = value('Y');
    const z = value('Z');

    if (cycle) {
      if (x != null || y != null) {
        cycles.push({
          code: `G${cycle}`, line,
          x: x ?? at.x, y: y ?? at.y, z: value('Z') ?? at.z,
          r: value('R'), q: value('Q'),
        });
        at.x = x ?? at.x; at.y = y ?? at.y;
      }
      return;
    }

    if (motion == null || (x == null && y == null && z == null)) return;
    const target = { x: x ?? at.x, y: y ?? at.y, z: z ?? at.z };

    if (!started) { points.push({ ...at, rapid: true, line }); started = true; }

    if (motion === 2 || motion === 3) {
      const i = value('I') ?? 0;
      const j = value('J') ?? 0;
      for (const p of arcPoints(at, target, i, j, motion === 3, arcTolerance)) {
        points.push({ ...p, rapid: false, line });
      }
    } else {
      points.push({ ...target, rapid: motion === 0, line });
    }
    Object.assign(at, target);
  });

  return { points, cycles, unsupported };
}

/**
 * Expand an arc into the chords a machine would interpolate, fine enough to be
 * within `tolerance` of the true curve. Z is carried linearly, so a helical arc
 * comes back as a helix.
 */
function arcPoints(from, to, i, j, ccw, tolerance) {
  const cx = from.x + i;
  const cy = from.y + j;
  const radius = Math.hypot(from.x - cx, from.y - cy);
  const start = Math.atan2(from.y - cy, from.x - cx);
  const end = Math.atan2(to.y - cy, to.x - cx);

  let sweep = end - start;
  if (ccw && sweep <= 1e-12) sweep += 2 * Math.PI;
  if (!ccw && sweep >= -1e-12) sweep -= 2 * Math.PI;

  const step = radius > tolerance
    ? 2 * Math.acos(Math.max(-1, 1 - tolerance / radius))
    : Math.PI / 2;
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / step));
  const out = [];
  for (let k = 1; k <= segments; k++) {
    const a = start + (sweep * k) / segments;
    out.push({
      x: cx + radius * Math.cos(a),
      y: cy + radius * Math.sin(a),
      z: from.z + (to.z - from.z) * (k / segments),
    });
  }
  // land exactly where the block said, whatever the arithmetic did
  out[out.length - 1] = { x: to.x, y: to.y, z: to.z };
  return out;
}
