// Arc fitting: runs of short moves recognised as the circles they came from.
//
// CL data is linear — every curve reaches a post as a polyline, because that is
// what keeps strategies, simulation and verification honest about one geometry.
// The cost lands at the end of the pipeline: a bored hole or a filleted corner
// arrives as hundreds of tiny G1 blocks, which is a bigger file than it needs to
// be, and on an older controller a jerky one, because the block rate becomes the
// feed limit before the machine does.
//
// So the post looks back over each run of moves and asks whether they lie on a
// circle. Two conditions have to hold, and both are about not cutting anything
// the CL data did not describe:
//
//   * every point sits within `tolerance` of the fitted circle, and
//   * between consecutive points, the arc's bulge away from the straight chord
//     — the sagitta — is within `tolerance` too.
//
// The second is the one that is easy to forget. A twelve-sided polygon standing
// in for a circle passes the first test perfectly, and replacing it with the
// true circle would cut up to a millimetre outside the path that was planned. A
// polyline fine enough to have been a circle all along passes both.
//
// Runs may also descend. G2/G3 with a Z endpoint is helical interpolation —
// the controller runs the circle in XY and the Z linearly alongside — and it is
// what a bore or a ramped boss actually is. Fitting only flat arcs left the one
// case where this matters most untouched: a 30mm bore at a 1mm pitch posted as
// three thousand G1 blocks, on a path that is one instruction. The extra
// condition is that Z advances in proportion to the swept angle, which is what
// makes the straight chord and the true helix agree in Z as well as in XY.

import { MOVE_STRIDE, OP } from '../engine/cl.js';

const MAX_RUN = 512;              // points considered for one arc
const MAX_SWEEP = (350 * Math.PI) / 180;
const MIN_SWEEP = (5 * Math.PI) / 180;   // below this, a line says it better

/**
 * Find the arcs in a CL program.
 *
 * @returns Map from the first move index of a run to
 *   { end, i, j, ccw, helical } — last move index, centre offsets from the
 *   run's start point, the direction of travel (G3 when ccw), and whether the
 *   run also changes Z.
 */
export function planArcs(cl, tolerance = 0.01) {
  const d = cl.moves;
  const eventAt = new Set(cl.events.map((e) => e.index));
  const out = new Map();
  const at = (n) => {
    const o = n * MOVE_STRIDE;
    return [d[o + 1], d[o + 2], d[o + 3]];
  };
  const cuttable = (n) => d[n * MOVE_STRIDE] === OP.LINE;
  const feed = (n) => d[n * MOVE_STRIDE + 7];

  let n = 1;
  while (n < cl.count) {
    // an arc's start point is where the previous move left the tool, so a run
    // needs a predecessor that is not a drill cycle
    if (!cuttable(n) || d[(n - 1) * MOVE_STRIDE] === OP.DRILL) { n++; continue; }

    // Z is no longer a limit on the run — a helix is an arc that descends, and
    // fitArc is what decides whether this one descends the way a helix does.
    let limit = n;
    while (limit + 1 < cl.count && limit + 1 - n < MAX_RUN
      && cuttable(limit + 1) && feed(limit + 1) === feed(n)
      && !eventAt.has(limit + 1)) limit++;

    const points = [];
    for (let k = n - 1; k <= limit; k++) points.push(at(k));

    const found = longestArc(points, tolerance);
    if (found) {
      const end = n + found.span - 1;
      out.set(n, {
        end,
        i: found.cx - points[0][0],
        j: found.cy - points[0][1],
        ccw: found.ccw,
        helical: found.helical,
        // how far the cutter actually travels round it, which is not the
        // distance between its two ends — a full circle has the same start and
        // end and is not a plunge
        length: found.radius * found.sweep,
      });
      n = end + 1;
    } else {
      n++;
    }
  }
  return out;
}

/**
 * The longest arc starting at points[0], as { span, cx, cy, ccw } where `span`
 * counts the moves it covers (points[1..span]), or null if there is none worth
 * emitting.
 *
 * Grown by doubling and then refined, so a long circle costs a handful of full
 * checks rather than one per point. Every candidate is verified in full, so a
 * mis-guess can only cost an arc, never emit a wrong one.
 */
function longestArc(points, tolerance) {
  const most = points.length - 1;
  if (most < 3) return null;

  const seed = fitArc(points, 3, tolerance);
  if (!seed) return null;

  let best = { ...seed, span: 3 };
  let step = 1;
  while (best.span + step <= most) {
    const fit = fitArc(points, best.span + step, tolerance);
    if (fit) {
      best = { ...fit, span: best.span + step };
      step *= 2;              // fitting: reach further next time
    } else if (step === 1) {
      break;                  // the very next point does not belong
    } else {
      step = Math.floor(step / 2);   // overshot: close in on the end
    }
  }
  // Only now is the sweep worth judging. A finely chorded circle starts out
  // three chords and a couple of degrees wide, and rejecting that before it has
  // grown means never fitting the circle it is part of.
  return best.sweep >= MIN_SWEEP ? best : null;
}

/**
 * Does points[0..span] lie on one arc — flat or helical?
 * @returns { cx, cy, radius, ccw, sweep, helical } or null
 */
function fitArc(points, span, tolerance) {
  const a = points[0];
  const b = points[Math.floor(span / 2)];
  const c = points[span];
  const centre = circleThrough(a, b, c);
  if (!centre) return null;
  const [cx, cy] = centre;
  const radius = Math.hypot(a[0] - cx, a[1] - cy);
  if (!(radius > 1e-3) || radius > 1e5) return null;

  let previous = Math.atan2(a[1] - cy, a[0] - cx);
  let sweep = 0;
  let sign = 0;
  const swept = [0];              // cumulative angle at each point, for the Z check
  for (let k = 1; k <= span; k++) {
    const p = points[k];
    if (Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - radius) > tolerance) return null;

    const angle = Math.atan2(p[1] - cy, p[0] - cx);
    let delta = angle - previous;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    if (delta === 0) return null;
    if (sign === 0) sign = Math.sign(delta);
    else if (Math.sign(delta) !== sign) return null;          // doubles back
    // The bulge between this point and the last: what an arc adds to a chord.
    // Compared with a hair of slack, because the commonest case of all is a
    // curve chorded at exactly the tolerance the post is fitting to, and a
    // strict `>` turns that into a coin toss decided by rounding.
    if (radius * (1 - Math.cos(delta / 2)) > tolerance * (1 + 1e-9) + 1e-12) return null;
    sweep += Math.abs(delta);
    if (sweep > MAX_SWEEP) return null;
    swept.push(sweep);
    previous = angle;
  }

  // A helical G2/G3 puts Z where the swept angle says it is. Anything else that
  // happens to sit on a circle in plan — a pass rising and falling over a
  // curved surface, a ramp that stalls partway round — has to stay as lines,
  // because the controller would run the Z straight through it.
  const rise = points[span][2] - a[2];
  const slope = rise / sweep;
  for (let k = 1; k <= span; k++) {
    if (Math.abs(points[k][2] - (a[2] + slope * swept[k])) > tolerance) return null;
  }
  // radius and sweep go out with it because they are the arc's *length*, and
  // the length is what says how steeply a helix descends — see post/core.js
  return { cx, cy, radius, ccw: sign > 0, sweep, helical: Math.abs(rise) > 1e-9 };
}

/** Centre of the circle through three points, or null when they are collinear. */
function circleThrough(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  return [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
  ];
}
