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

/**
 * What an X word means on a lathe.
 *
 * A turning control is told the *diameter* it should be at, not the radius —
 * `X40` on a ⌀40 bar is the tool touching the skin, and the slide is 20mm off
 * the spindle centreline. G7 turns that reading on and G8 turns it off, and
 * every lathe post in this app writes G7 in its header (see post/lathe.js,
 * where the radius the CL data holds is doubled).
 *
 * Read as a plain coordinate instead and a lathe program comes back at twice
 * its real radius: the backplot draws it off the bar, the simulation cuts air,
 * the travel check measures the wrong envelope, and the post round-trip reports
 * every single operation as out by half a diameter — which is what it did.
 *
 * Only the X *position* is a diameter. Arc centre offsets are radii in both
 * modes on every control that has the pair, so I is left alone.
 */
const DIAMETER_MODE = 7;
const RADIUS_MODE = 8;

/**
 * A lathe's T word is two numbers written as one: `T0909` is turret station 9
 * carrying offset 9, which is what post/lathe.js writes and what every turning
 * control expects. Read as a single number it is tool 909, and the read-back
 * then reports "the file asks for T909 and there is no T909 here" about a file
 * that asked for station 9 — and simulates it with whatever the widest cutter
 * in the library happens to be.
 *
 * Only in diameter mode, which is the one word that says "this is a lathe
 * program" out loud, and only for a word actually written with four digits: a
 * mill's `T909` is tool 909 and must stay that.
 */
const LATHE_T_DIGITS = 4;

/**
 * The axes this reader cannot draw.
 *
 * A rotary word is motion — the part turns under the tool — and there is no
 * honest way to plot it against a billet that is not turning. Dropping the word
 * and keeping the X on the same block is not a small error either: a wrapped
 * program (see engine/wrap.js) is *mostly* rotary, so the whole pattern
 * collapses onto one line and the file reads as though the tool sat still. That
 * is a picture of a program nobody wrote, so the letters are reported instead
 * — once each, because there is one on nearly every block.
 */
const ROTARY_AXES = new Set(['A', 'B', 'C']);

/**
 * What an F word means, which is not always millimetres a minute.
 *
 * G94 is a rate and is what a mill uses. G95 is millimetres *per revolution* —
 * what a lathe uses, what this app's own lathe post writes, and the figure on
 * the side of an insert box — so the rate depends on the spindle. G93 is
 * inverse time: the F is how many of that block fit in a minute, which is not a
 * speed at all and is what a wrapped program is written in.
 *
 * Read as a rate whatever the mode, a lathe file comes back at the feed it
 * would have at one rev per minute: a program this app estimates at eight
 * minutes read back as seventy-one hours.
 */
const PER_MINUTE = 94;
const PER_REV = 95;
const INVERSE_TIME = 93;

/** Surface speed is quoted in metres a minute, or in feet a minute under G20. */
const SURFACE_UNIT = { mm: 1000, inch: 304.8 };

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
 * @returns {{ motion, points, cycles, events, unsupported, units, xWords, blocks }}
 *   motion:  every move and cycle in program order, the one authoritative list
 *   points:  the moves alone, one entry per resolved endpoint (arcs expanded)
 *   cycles:  the canned cycles alone, unexpanded — a G81 hole is one move
 *   events:  tool changes, spindle, coolant and feed changes, in order
 *   unsupported: [{ code, line }] words that were not understood
 *   units:   'mm' or 'inch' — what the program was written in
 *   xWords:  'radius' or 'diameter' — how the file spelled X. Every coordinate
 *            that comes back is a radius either way; this says which the file
 *            said. See DIAMETER_MODE.
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
  let xScale = 1;                    // 0.5 in a G7 program — see DIAMETER_MODE
  let absolute = true;               // G90 / G91
  let arcAbsolute = false;           // G90.1 / G91.1 — incremental by default
  let retractMode = 98;              // G98 initial plane / G99 R plane
  // A canned cycle's own words are modal, and this is the whole reason a run of
  // holes is two lines and then four: the second hole says X and Y and nothing
  // else, and means the same depth, the same R plane and the same peck. Read as
  // "whatever Z is now" instead, every hole after the first came back at the
  // height the tool had just retracted to — a four-hole drilling operation that
  // drilled one hole and then hovered over three more.
  let cycleZ = null;
  let cycleR = null;
  let cycleQ = null;
  let cycleP = null;
  let feed = null;
  let tool = null;
  let spindle = null;
  let blocks = 0;
  // What an F word and an S word mean right now. Both are modal, and both are
  // read wrongly by default on a lathe file — see PER_REV.
  let feedMode = PER_MINUTE;
  let css = false;          // G96: S is a surface speed and the rpm follows the diameter
  let surfaceSpeed = 0;     // mm/min of skin, under G96
  let rpmCap = 0;           // the D word on a G96 line — the control's own clamp
  let rpm = 0;              // the speed in force, when it is knowable
  // Modes and axes already reported as unreadable. A wrapped program has a
  // rotary word on nearly every block, so these are said once each rather than
  // once per line.
  const reported = new Set();
  const unread = (code, line) => {
    if (reported.has(code)) return;
    reported.add(code);
    unsupported.push({ code, line });
  };

  const at = { x: 0, y: 0, z: 0 };
  let started = false;
  // The height the tool was at when the first cycle of a run began, which is
  // where G98 sends it back to between holes.
  let initialZ = 0;

  /**
   * The spindle speed in force.
   *
   * Under G97 that is the S word. Under G96 the control holds a *surface* speed
   * and works the rpm out from where the tool is, so the answer moves with X —
   * v/(π·D), clamped by the D word, and on the centreline it is that clamp. It
   * is read at the moment it is asked for rather than per move, which is all a
   * feed rate written once at the top of a pass is worth anyway.
   */
  const spindleNow = () => {
    if (!css) return rpm;
    const r = Math.abs(at.x);
    const free = r > 1e-6 ? surfaceSpeed / (2 * Math.PI * r) : Infinity;
    if (rpmCap > 0) return Math.min(rpmCap, free);
    return Number.isFinite(free) ? free : 0;
  };

  text.split('\n').forEach((raw, line) => {
    const code = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim();
    if (!code || code === '%') return;

    const words = [];
    // the digits as they were written are kept too: a lathe's T word means one
    // thing at four digits and another at two — see LATHE_T_DIGITS
    for (const m of code.matchAll(WORD)) words.push([m[1].toUpperCase(), Number(m[2]), m[2]]);
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
        // Spindle-synchronised motion. G33 is a feed move whose rate comes from
        // the spindle rather than from F — read as a cut, which is what it is —
        // and G33.1 is a whole tapped hole in one block: down to Z at K per
        // revolution and back to where it started, the return being what makes
        // it a cycle rather than a move.
        else if (n === 33) { move = 1; cycle = null; }
        else if (n === 33.1) { cycle = 33.1; move = null; }
        else if (n === 80) {
          cycle = null; move = null; endsCycle = true;
          cycleZ = null; cycleR = null; cycleQ = null; cycleP = null;
        }
        else if (n >= 73 && n <= 89 && n !== 80) { cycle = n; move = null; }
        else if (n === DIAMETER_MODE) xScale = 0.5;
        else if (n === RADIUS_MODE) xScale = 1;
        else if (n === 17 || n === 18 || n === 19) plane = n;
        else if (n === 20) { scale = INCH; units = 'inch'; }
        else if (n === 21) { scale = 1; units = 'mm'; }
        else if (n === 90) absolute = true;
        else if (n === 91) absolute = false;
        else if (n === 90.1) arcAbsolute = true;
        else if (n === 91.1) arcAbsolute = false;
        else if (n === 98 || n === 99) retractMode = n;
        else if (n === PER_MINUTE || n === PER_REV) feedMode = n;
        else if (n === INVERSE_TIME) {
          // Not a rate at all: the F on the block says how many of that block
          // would fit in a minute. There is nothing to convert it to without
          // walking the block, and a wrapped program's rotary words are already
          // unread, so the mode is reported and its F words are left out.
          feedMode = n;
          unread('G93 (inverse time)', line);
        } else if (n === 96) {
          css = true;
          const d = value('D');
          if (d != null) rpmCap = d;
          const sw = value('S');
          if (sw != null) surfaceSpeed = sw * (SURFACE_UNIT[units] ?? SURFACE_UNIT.mm);
        } else if (n === 97) css = false;
        else if (!MODAL_G.has(n)) unsupported.push({ code: `G${n}`, line });
      } else if (ROTARY_AXES.has(letter)) {
        // Motion this reader cannot draw — see ROTARY_AXES. The block's linear
        // words are still read, because half a move drawn is what the rest of
        // the checks below are built on; what must not happen is silence.
        unread(`${letter} (rotary axis)`, line);
      } else if (letter === 'M') {
        if (n === 3 || n === 4) {
          const sw = value('S');
          if (sw != null) {
            if (css) surfaceSpeed = sw * (SURFACE_UNIT[units] ?? SURFACE_UNIT.mm);
            else rpm = sw;
          }
          spindle = { rpm: spindleNow(), dir: n === 3 ? 'cw' : 'ccw' };
          events.push({ type: 'spindle', ...spindle, line });
        } else if (n === 5) events.push({ type: 'spindle', rpm: 0, dir: 'off', line });
        else if (n === 6) events.push({ type: 'tool', tool: toolNumber(words, xScale) ?? tool, line });
        else if (n === 7 || n === 8) events.push({ type: 'coolant', mode: n === 7 ? 'mist' : 'flood', line });
        else if (n === 9) events.push({ type: 'coolant', mode: 'off', line });
        else if (n === 2 || n === 30) events.push({ type: 'end', line });
        else if (!KNOWN_M.has(n)) unsupported.push({ code: `M${n}`, line });
      } else if (letter === 'T') {
        tool = toolNumber(words, xScale);
      } else if (letter === 'F') {
        // Millimetres a minute, whatever the file spelled it as — see PER_REV.
        // Under inverse time there is no such number, and under feed-per-rev
        // there is none until the spindle has been told a speed.
        if (feedMode === INVERSE_TIME) continue;
        const speed = feedMode === PER_REV ? spindleNow() : 1;
        if (feedMode === PER_REV && !(speed > 0)) {
          unread('G95 (feed per rev, before any spindle speed)', line);
          continue;
        }
        const mm = n * scale * speed;
        if (mm !== feed) { feed = mm; events.push({ type: 'feed', feed: mm, line }); }
      } else if (letter === 'S') {
        if (css) surfaceSpeed = n * (SURFACE_UNIT[units] ?? SURFACE_UNIT.mm);
        else rpm = n;
        if (!words.some(([l]) => l === 'M')) {
          events.push({ type: 'speed', rpm: spindleNow(), line });
        }
      }
    }
    if (endsCycle) return;

    // Coordinates, in millimetres and absolute, whatever the program said —
    // and in radii, whatever the lathe said. `per` is 1 on every axis but X,
    // and a half on X while the control is in diameter mode.
    const axis = (letter, from, per = 1) => {
      const v = value(letter);
      if (v == null) return null;
      return absolute ? v * scale * per : from + v * scale * per;
    };
    const x = axis('X', at.x, xScale);
    const y = axis('Y', at.y);
    const z = axis('Z', at.z);

    if (cycle === 33.1) {
      // Rigid tapping: the block says how deep and at what pitch, and the
      // position is wherever the tool already is. It returns to the height it
      // started at, which is why nothing after it has to be told to retract.
      if (z != null) {
        motion.push({
          kind: 'cycle',
          code: 'G33.1',
          line,
          x: at.x,
          y: at.y,
          z,
          r: at.z,
          q: null,
          p: null,
          pitch: value('K') != null ? value('K') * scale : null,
          retract: at.z,
          feed,
          tool,
        });
      }
      return;
    }

    if (cycle) {
      // A canned cycle is one hole per block that names a position. R is the
      // height it feeds from and Z the bottom; G98 comes back to wherever the
      // tool was when the run started, G99 to R.
      if (value('R') != null) cycleR = axis('R', at.z);
      if (z != null) cycleZ = z;
      if (value('Q') != null) cycleQ = value('Q') * scale;
      if (value('P') != null) cycleP = value('P');
      if (x != null || y != null || value('R') != null || z != null) {
        const r = cycleR ?? at.z;
        const bottom = cycleZ ?? at.z;
        if (motion.length && motion[motion.length - 1].kind !== 'cycle') initialZ = at.z;
        motion.push({
          kind: 'cycle',
          code: `G${cycle}`,
          line,
          x: x ?? at.x,
          y: y ?? at.y,
          z: bottom,
          r,
          q: cycleQ,
          p: cycleP,
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
      const centre = arcCentre(at, target, words, value, plane, scale, arcAbsolute,
        move === 3);
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
    // 'diameter' when the program ended in G7 — said out loud because every
    // X in `motion` has already been halved, and a caller comparing against a
    // file's own text needs to know which of the two numbers it is looking at.
    xWords: xScale === 1 ? 'radius' : 'diameter',
    blocks,
  };
}

/** The station a T word names, unpicking the lathe's station+offset pairing. */
function toolNumber(words, xScale) {
  const found = words.find(([l]) => l === 'T');
  if (!found) return null;
  const [, n, raw] = found;
  const lathe = xScale !== 1;
  return lathe && raw.length === LATHE_T_DIGITS ? Math.floor(n / 100) : n;
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
 *
 * Which of the two centres gives the short way depends on which way the tool is
 * going round, and that is why `ccw` is an argument rather than a detail of the
 * caller. The minor arc keeps its centre to the left of the direction of travel
 * for a G3 and to the right for a G2 — so reading the sign of R alone is right
 * for half of all arcs and the complement of the arc for the other half. A
 * `G2 X10 Y10 R10` from the origin is a quarter circle; read without `ccw` it
 * came back as the three quarters that go round the other side.
 */
function arcCentre(from, to, words, value, plane, scale, arcAbsolute, ccw) {
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
  // ends, and only the sweep they produce tells them apart. +1 puts it to the
  // left of the chord, which is where a counter-clockwise minor arc turns
  // about.
  const sign = (r < 0) === !!ccw ? -1 : 1;
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
