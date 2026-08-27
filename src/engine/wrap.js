// Rotary wrap: a flat program bent round a cylinder.
//
// The other thing a 4th axis is for. Indexing (engine/indexing.js) swings a face
// under the spindle and locks it, and then cuts three-axis; wrapping never locks
// — the rotary turns *while* the tool cuts, and what comes out is a pattern that
// runs all the way round a shaft. A spline, a scale round a dial, a name down a
// tube, a slot that follows the circumference: none of them can be reached by
// indexing, because there is no one angle at which they lie flat.
//
// And it is the same trick as the tilted work plane, which is what makes it
// small. Take the cylinder's surface and unroll it: a rectangle π·D wide.
// Anything on that rectangle can be programmed by the ordinary flat strategies
// against an ordinary flat billet, because on the unrolled sheet it *is* flat.
// The only difference between that program and the one the machine runs is how
// a coordinate is spelled — Y millimetres along the sheet is A degrees round the
// bar — and spelling is the post's job.
//
// So nothing here touches a toolpath. The CL data is the same CL data, the
// simulation is the same simulation, the viewport draws the same flat path, and
// the wrap is a fact about the setup applied on the way out. One description of
// the geometry, in one place. The same rule the tilted plane follows, and for
// the same reason.
//
// Two things do change and both are the post's:
//
//   * **Arcs cannot survive it.** A circle on the unrolled sheet is not a circle
//     round the bar, so a G2 written in X and A would cut something else
//     entirely. Wrapped operations are posted as lines.
//   * **The feed is not a feed.** F is millimetres per minute on a linear move
//     and degrees per minute on a rotary one, and a control has no way to know
//     that this particular degree is worth 0.3mm of surface. The answer every
//     control agrees on is inverse time (G93): each block says how many minutes
//     it should take, computed from the real surface distance — which is the
//     distance on the unrolled sheet, exactly the thing the flat program has.

/** Is this setup's program wrapped round a rotary axis? */
export function isWrapped(setup) {
  return !!setup?.wrap?.enabled && (setup.wrap.diameter ?? 0) > 0;
}

/**
 * Which linear axis is developed into rotation, for each rotary axis.
 *
 * An A axis turns about X, so a point's distance from the axis in *Y* is what
 * becomes an angle; a B axis turns about Y and eats X. Nothing turns about Z
 * here: a C axis with the part lying along Z is a lathe, and this app already
 * has one of those.
 */
const DEVELOPED = { A: 'y', B: 'x' };

/** The axes a wrap can be written about, in the order a picker should show them. */
export const WRAP_AXES = ['A', 'B'];

export const WRAP_AXIS_LABELS = {
  A: 'A — the bar lies along X',
  B: 'B — the bar lies along Y',
};

/**
 * What a setup's wrap means, resolved against the machine that has to run it.
 *
 * @returns null when the setup is not wrapped, otherwise
 *   { axis, developed, diameter, degPerMm, circumference, reachable, reason }
 */
export function wrapFor(setup, machine) {
  if (!isWrapped(setup)) return null;
  const axis = DEVELOPED[setup.wrap.axis] ? setup.wrap.axis : 'A';
  const diameter = setup.wrap.diameter;
  const circumference = Math.PI * diameter;
  // A machine's rotary record names its axis by its *letter*; the field called
  // `axis` on it is the unit vector the table turns about, which is what
  // engine/indexing.js needs. Reading the wrong one of the two is a wrap that
  // silently believes every machine can make it.
  const has = (machine?.rotary ?? []).some((r) => (r.letter ?? r) === axis);
  return {
    axis,
    developed: DEVELOPED[axis],
    diameter,
    circumference,
    // One turn is the circumference, so a millimetre along the sheet is
    // 360/(π·D) degrees. Every coordinate and every feed goes through this one
    // number.
    degPerMm: 360 / circumference,
    reachable: has,
    reason: has ? null
      : `${machine?.name ?? 'this machine'} has no ${axis} axis to wrap around`,
  };
}

/**
 * A flat point, as the machine will be told it.
 *
 * The developed axis becomes the angle and stops being a coordinate: a wrapped
 * program has no Y at all (or no X, on a B axis), because that direction is now
 * round the bar rather than across the table.
 *
 * Z is untouched, and that is worth saying out loud because it looks as though
 * it should not be. It works because the work zero sits on the *top of the
 * cylinder*: the tool is always over the axis, so whatever angle the bar is at,
 * the surface under the tool is at the same height. Set the datum on the rotary
 * centreline instead and every depth in the program is out by the radius.
 */
export function wrapPoint(wrap, { x, y, z }) {
  const along = wrap.developed === 'y' ? y : x;
  return {
    x: wrap.developed === 'y' ? x : null,
    y: wrap.developed === 'y' ? null : y,
    z,
    angle: along * wrap.degPerMm,
  };
}

/**
 * How long a move should take, in minutes — the number an inverse-time block
 * carries.
 *
 * Measured on the unrolled sheet, which is where the surface distance actually
 * is: the tool travels π·D as the bar turns once, and that is the length of the
 * flat program's Y. So the honest feed for a wrapped move is the flat move's own
 * length divided by the flat move's own feed rate, and no trigonometry is needed
 * anywhere.
 *
 * @returns the F word for a G93 block, or 0 when the move takes no time at all
 */
export function inverseTime(from, to, feed) {
  if (!(feed > 0)) return 0;
  const d = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  if (!(d > 1e-9)) return 0;
  const minutes = d / feed;
  return minutes > 0 ? 1 / minutes : 0;
}

/**
 * The angle a wrapped program sweeps, and whether it goes round more than once.
 *
 * A pattern wider than the circumference wraps over itself — the second lap
 * cuts through the first — and on the unrolled sheet that is invisible, because
 * there the pattern is simply a long one. It is the one mistake this
 * transformation makes easy, so it is measured and said.
 */
export function wrapExtent(wrap, extent) {
  if (!wrap || !extent) return null;
  const i = wrap.developed === 'y' ? 1 : 0;
  const span = extent.max[i] - extent.min[i];
  return {
    span,
    degrees: span * wrap.degPerMm,
    laps: span / wrap.circumference,
    overlaps: span > wrap.circumference + 1e-6,
  };
}

/** Anything a wrapped setup should say before it is posted. */
export function wrapWarnings(wrap, extent) {
  const out = [];
  if (!wrap) return out;
  if (!wrap.reachable) out.push({ level: 'warn', text: wrap.reason });
  const reach = wrapExtent(wrap, extent);
  if (reach?.overlaps) {
    out.push({
      level: 'warn',
      text: `the program is ${reach.span.toFixed(1)}mm across the wrapped axis and `
        + `⌀${wrap.diameter} is only ${wrap.circumference.toFixed(1)}mm round — `
        + `it turns ${reach.degrees.toFixed(0)}° and cuts over itself`,
    });
  }
  return out;
}
