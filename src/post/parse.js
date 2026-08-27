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
// It reads *other people's* programs for the same reason. A file from another
// CAM system, or one somebody typed, is motion like any other: parsed here it
// can be drawn, simulated against the billet, timed, and checked against the
// machine's travels — which is the whole of what a backplot is for, and none of
// it needs the program to have come from this app.
//
// So the parser is modal in the ways a control is, and only in those ways:
// units, distance mode, plane, feed, tool, and the canned cycles. Anything it
// does not understand is *reported*, never guessed at — a program half-read is
// worse than one not read at all, because it looks like an answer.

/** Millimetres per inch, for a program in G20. */
const INCH = 25.4;

const WORD = /([A-Za-z])\s*(-?\d*\.?\d+)/g;

/** The G codes that set state and produce no motion of their own. */
const MODAL_G = new Set([
  17, 18, 19,          // plane
  20, 21,              // units
  40, 41, 42,          // cutter comp — computer comp is what this app posts
  43, 44, 49,          // length offsets
  53,                  // machine coordinates for one block
  54, 55, 56, 57, 58, 59, 59.1, 59.2, 59.3,
  61, 61.1, 64,        // path control
  90, 91,              // distance mode (handled below as well)
  90.1, 91.1,          // arc centre mode
  93, 94, 95,          // feed mode
  96, 97,              // spindle mode
  98, 99,              // cycle retract
]);

/** M codes that mean something here. Everything else is reported. */
const KNOWN_M = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30]);

/**
 * @param text a G-code program
 * @param options.arcTolerance chord tolerance when expanding arcs (mm)
 * @returns {{ motion, points, cycles, events, unsupported, units, blocks }}
 *   motion:  every move and cycle in program order, the one authoritative list
 *   points:  the moves alone, one entry per resolved endpoint (arcs expanded)
 *   cycles:  the canned cycles alone, unexpanded — a G81 hole is one move
 *   events:  tool changes, spindle, coolant and feed changes, in order
 *   unsupported: [{ code, line }] words that were not understood
 *   units:   'mm' or 'inch' — what the program was written in
 */
export function parseGcode(text, { arcTolerance = 0.005 } = {}) {
  const motion = [];
  const events = [];
  const unsupported = [];

  let move = null;                   // modal G0/G1/G2/G3
  let cycle = null;                  // modal G81/G83…
  let plane = 17;                    // G17 XY, G18 ZX, G19 YZ
  let scale = 1;                     // 25.4 in a G20 program
  let units = 'mm';
  let absolute = true;               // G90 / G91
  let arcAbsolute = false;           // G90.1 / G91.1 — incremental by default
  let retractMode = 98;              // G98 initial plane / G99 R plane
  let feed = null;
  let tool = null;
  let spindle = null;
  let blocks = 0;

  const at = { x: 0, y: 0, z: 0 };
  let started = false;
  // The height the tool was at when the first cycle of a run began, which is
  // where G98 sends it back to between holes.
  let initialZ = 0;

  text.split('\n').forEach((raw, line) => {
    const code = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim();
    if (!code || code === '%') return;

    const words = [];
    for (const m of code.matchAll(WORD)) words.push([m[1].toUpperCase(), Number(m[2])]);
    if (words.length === 0) return;
    blocks++;
    const value = (letter) => {
      const found = words.find(([l]) => l === letter);
      return found ? found[1] : null;
    };

    let endsCycle = false;
    for (const [letter, n] of words) {
      if (letter === 'G') {
        if (n === 0 || n === 1 || n === 2 || n === 3) { move = n; cycle = null; }
        else if (n === 80) { cycle = null; move = null; endsCycle = true; }
        else if (n >= 73 && n <= 89 && n !== 80) { cycle = n; move = null; }
        else if (n === 17 || n === 18 || n === 19) plane = n;
        else if (n === 20) { scale = INCH; units = 'inch'; }
        else if (n === 21) { scale = 1; units = 'mm'; }
        else if (n === 90) absolute = true;
        else if (n === 91) absolute = false;
        else if (n === 90.1) arcAbsolute = true;
        else if (n === 91.1) arcAbsolute = false;
        else if (n === 98 || n === 99) retractMode = n;
        else if (!MODAL_G.has(n)) unsupported.push({ code: `G${n}`, line });
      } else if (letter === 'M') {
        if (n === 3 || n === 4) {
          spindle = { rpm: value('S') ?? spindle?.rpm ?? 0, dir: n === 3 ? 'cw' : 'ccw' };
          events.push({ type: 'spindle', ...spindle, line });
        } else if (n === 5) events.push({ type: 'spindle', rpm: 0, dir: 'off', line });
        else if (n === 6) events.push({ type: 'tool', tool: value('T') ?? tool, line });
        else if (n === 7 || n === 8) events.push({ type: 'coolant', mode: n === 7 ? 'mist' : 'flood', line });
        else if (n === 9) events.push({ type: 'coolant', mode: 'off', line });
        else if (n === 2 || n === 30) events.push({ type: 'end', line });
        else if (!KNOWN_M.has(n)) unsupported.push({ code: `M${n}`, line });
      } else if (letter === 'T') {
        tool = n;
      } else if (letter === 'F') {
        const mm = n * scale;
        if (mm !== feed) { feed = mm; events.push({ type: 'feed', feed: mm, line }); }
      } else if (letter === 'S') {
        if (!words.some(([l]) => l === 'M')) events.push({ type: 'speed', rpm: n, line });
      }
    }
    if (endsCycle) return;

    // Coordinates, in millimetres and absolute, whatever the program said.
    const axis = (letter, from) => {
      const v = value(letter);
      if (v == null) return null;
      return absolute ? v * scale : from + v * scale;
    };
    const x = axis('X', at.x);
    const y = axis('Y', at.y);
    const z = axis('Z', at.z);

    if (cycle) {
      // A canned cycle is one hole per block that names a position. R is the
      // height it feeds from and Z the bottom; G98 comes back to wherever the
      // tool was when the run started, G99 to R.
      if (x != null || y != null || value('R') != null) {
        const r = axis('R', at.z) ?? at.z;
        const bottom = z ?? at.z;
        if (motion.length && motion[motion.length - 1].kind !== 'cycle') initialZ = at.z;
        motion.push({
          kind: 'cycle',
          code: `G${cycle}`,
          line,
          x: x ?? at.x,
          y: y ?? at.y,
          z: bottom,
          r,
          q: value('Q') != null ? value('Q') * scale : null,
          p: value('P'),
          retract: retractMode === 99 ? r : Math.max(initialZ, r),
          feed,
          tool,
        });
        at.x = x ?? at.x;
        at.y = y ?? at.y;
        at.z = retractMode === 99 ? r : Math.max(initialZ, r);
      }
      return;
    }

    if (move == null || (x == null && y == null && z == null)) return;
    const target = { x: x ?? at.x, y: y ?? at.y, z: z ?? at.z };

    // The path starts where the program first says it is, not at the origin.
    // A machine is wherever it was left when a file is loaded, so a first move
    // drawn from (0,0,0) is a line nobody commanded — and against a program
    // this one posted itself it is a thirty-millimetre discrepancy in a
    // comparison that is supposed to measure micron-scale post bugs.
    if (!started) {
      started = true;
      initialZ = z ?? at.z;
    }

    if (move === 2 || move === 3) {
      const centre = arcCentre(at, target, words, value, plane, scale, arcAbsolute);
      if (!centre) {
        unsupported.push({ code: `G${move} without I/J/K or R`, line });
        motion.push({ kind: 'move', ...target, rapid: false, line, feed, tool });
      } else {
        for (const p of arcPoints(at, target, centre, move === 3, arcTolerance, plane)) {
          motion.push({ kind: 'move', ...p, rapid: false, line, feed, tool });
        }
      }
    } else {
      motion.push({ kind: 'move', ...target, rapid: move === 0, line, feed, tool });
    }
    Object.assign(at, target);
  });

  return {
    motion,
    points: motion.filter((m) => m.kind === 'move'),
    cycles: motion.filter((m) => m.kind === 'cycle'),
    events,
    unsupported,
    units,
    blocks,
  };
}

/**
 * The two axes an arc turns in, and the letters that give its centre.
 *
 * A control interpolates an arc in the active plane and nowhere else, so a
 * G18 arc whose centre was read off I and J is not a slightly wrong arc — it
 * is a straight line through the middle of the part.
 */
const PLANES = {
  17: { a: 'x', b: 'y', ca: 'I', cb: 'J' },
  18: { a: 'z', b: 'x', ca: 'K', cb: 'I' },
  19: { a: 'y', b: 'z', ca: 'J', cb: 'K' },
};

/**
 * Where an arc turns about, from either spelling of it.
 *
 * I/J/K is what this app posts and what every control accepts. R is what a lot
 * of hand-written and Fanuc-flavoured code uses, and it is ambiguous by design:
 * two arcs pass through the same two points at the same radius, and the sign of
 * R picks between them — positive for the short way round, negative for the
 * long. Getting that backwards puts the tool through the part on the far side
 * of the circle, which is exactly the sort of thing reading the file back is
 * supposed to catch.
 */
function arcCentre(from, to, words, value, plane, scale, arcAbsolute) {
  const { a, b, ca, cb } = PLANES[plane] ?? PLANES[17];
  const i = value(ca);
  const j = value(cb);
  if (i != null || j != null) {
    return arcAbsolute
      ? { a: (i ?? from[a] / scale) * scale, b: (j ?? from[b] / scale) * scale }
      : { a: from[a] + (i ?? 0) * scale, b: from[b] + (j ?? 0) * scale };
  }
  const rWord = value('R');
  if (rWord == null) return null;
  const r = rWord * scale;
  const [x0, y0] = [from[a], from[b]];
  const [x1, y1] = [to[a], to[b]];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9 || d > 2 * Math.abs(r) + 1e-6) return null;
  const h = Math.sqrt(Math.max(0, r * r - (d / 2) * (d / 2)));
  // Which side of the chord the centre sits on is the sign of R crossed with
  // the direction of travel; both candidates are the same distance from both
  // ends, and only the sweep they produce tells them apart.
  const sign = r < 0 ? -1 : 1;
  return {
    a: (x0 + x1) / 2 - sign * h * (dy / d),
    b: (y0 + y1) / 2 + sign * h * (dx / d),
  };
}

/**
 * Expand an arc into the chords a machine would interpolate, fine enough to be
 * within `tolerance` of the true curve. The third axis is carried linearly, so
 * a helical arc comes back as a helix.
 */
function arcPoints(from, to, centre, ccw, tolerance, plane = 17) {
  const { a, b } = PLANES[plane] ?? PLANES[17];
  const third = ['x', 'y', 'z'].find((k) => k !== a && k !== b);
  const radius = Math.hypot(from[a] - centre.a, from[b] - centre.b);
  const start = Math.atan2(from[b] - centre.b, from[a] - centre.a);
  const end = Math.atan2(to[b] - centre.b, to[a] - centre.a);

  let sweep = end - start;
  if (ccw && sweep <= 1e-12) sweep += 2 * Math.PI;
  if (!ccw && sweep >= -1e-12) sweep -= 2 * Math.PI;

  const step = radius > tolerance
    ? 2 * Math.acos(Math.max(-1, 1 - tolerance / radius))
    : Math.PI / 2;
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / step));
  const out = [];
  for (let k = 1; k <= segments; k++) {
    const ang = start + (sweep * k) / segments;
    const p = { x: from.x, y: from.y, z: from.z };
    p[a] = centre.a + radius * Math.cos(ang);
    p[b] = centre.b + radius * Math.sin(ang);
    p[third] = from[third] + (to[third] - from[third]) * (k / segments);
    out.push(p);
  }
  // land exactly where the block said, whatever the arithmetic did
  out[out.length - 1] = { x: to.x, y: to.y, z: to.z };
  return out;
}
