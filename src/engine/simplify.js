// Dropping points that say nothing, on the way into the CL data.
//
// A clearing strategy works on a resampled path: the material raster has to be
// swept in steps small enough that a cell is never jumped over, which for a
// 12mm cutter means a point every millimetre or two. That resolution is a
// requirement of the *bookkeeping*, not of the geometry — a 60mm straight wall
// arrives as forty identical collinear moves, and forty moves is what the
// control has to read, the post has to write, and the viewport has to draw.
//
// So the sweep keeps its dense path and the output does not. Points are held
// back one at a time and dropped as long as everything dropped since the last
// written point stays within `tolerance` of the straight line that would replace
// it. What survives is the same path to within the tolerance the operation was
// given, with the filler gone.
//
// Only points of the same feed class are ever merged: dropping a point is
// dropping the *move that reached it*, so merging across a feed change would
// quietly run a lead-in at cutting feed. Straightness is judged in three
// dimensions, so a ramp down a straight wall collapses like anything else and a
// finishing pass over a curve keeps every point it needs.

/**
 * How many points one written move may stand in for.
 *
 * This used to be 64, and 64 is short. `deviates` re-measures every point
 * dropped so far against the *new* straight line, so a run costs O(run²) and
 * the cap was there to stop that running away — but it caps the saving with it.
 * A turning finish pass samples the profile at the operation's tolerance, so a
 * plain 60mm diameter arrives as twelve hundred points, and 64 at a time turned
 * it into nineteen G1 blocks describing one straight line. The same cap was
 * costing 7% of every milling program.
 *
 * The rescan is now the fallback rather than the rule — see `accepts` — so the
 * limit only has to be a backstop against a pathological run, not a budget.
 */
const MAX_RUN = 8192;

/**
 * How far the merger may move the path.
 *
 * Half the operation's tolerance, and capped, because the post fits arcs to
 * what comes out of here against its own budget — 0.01mm by default, and not
 * derived from this one. Chords already sitting most of the way through that
 * budget cannot then be replaced by the circle they came from, and a part whose
 * profile is arcs posts as tens of thousands of tiny lines instead.
 *
 * The cap is what keeps the two apart. Below it the saving is on straight runs,
 * where the dropped points are collinear to float precision and the tolerance
 * barely matters; above it the saving is on curves, and that is exactly where
 * it would be spending the arc fitter's money.
 */
export function mergeTolerance(tolerance) {
  return Math.min(Math.max(1e-5, (tolerance ?? 0.01) / 2), 0.004);
}

export class CollinearFilter {
  /**
   * @param write (x, y, z, feed) — where surviving points go
   * @param tolerance how far the simplified path may sit from the original
   */
  constructor(write, tolerance = 0.01, maxRun = MAX_RUN) {
    this.write = write;
    this.tol = Math.max(1e-6, tolerance);
    this.maxRun = Math.max(1, maxRun);
    this.anchor = null;    // the last point actually written
    this.held = null;      // a point that may yet turn out to be droppable
    this.dropped = [];     // points already dropped since the anchor
    this.kept = 0;
    this.seen = 0;
    this.resetCone();
  }

  /**
   * The cheap sufficient test that keeps a long run from costing O(run²).
   *
   * Every dropped point q has to end up within `tol` of the line the run is
   * finally written as. Written as an angle instead of a distance, that says
   * the run's direction may differ from the direction of `anchor→q` by at most
   * `asin(tol / |q − anchor|)` — a cone about `anchor→q`, narrow for the far
   * points and wide for the near ones.
   *
   * So one reference direction is kept, along with the least slack any dropped
   * point leaves around it. A candidate direction inside that slack satisfies
   * every point at once, without looking at any of them. A straight run leaves
   * the slack untouched, which is the case worth being quick at.
   *
   * It is only ever *sufficient*: a candidate outside the slack falls through
   * to the exact rescan, which then re-centres the cone on the direction that
   * actually worked, so a run that curves gently does not rescan every point
   * from then on.
   */
  resetCone() {
    this.ref = null;      // unit direction the slack is measured around
    this.slack = 0;       // radians the run's direction may differ by
    this.far = 0;         // distance to the farthest dropped point
  }

  push(x, y, z, feed) {
    this.seen++;
    const p = [x, y, z, feed];
    if (!this.anchor) return this.emit(p);
    if (!this.held) { this.held = p; return; }

    // A run is a stretch at one feed; a change of feed ends it.
    const sameRun = feed === this.held[3] && this.dropped.length < this.maxRun;
    if (!sameRun || this.deviates(p)) {
      this.emit(this.held);
      this.held = p;
      return;
    }
    this.narrowCone(this.held);
    this.dropped.push(this.held);
    this.held = p;
  }

  /** Would replacing everything dropped so far with anchor→p move the path? */
  deviates(p) {
    if (distanceToSegment(this.held, this.anchor, p) > this.tol) return true;
    if (this.dropped.length === 0) return false;

    const [dx, dy, dz] = delta(this.anchor, p);
    const len = Math.hypot(dx, dy, dz);
    // Inside the cone every dropped point is within tol of the *line*, and
    // reaching at least as far as the farthest of them puts all their
    // projections on the segment — so line distance is segment distance.
    if (this.ref && this.slack > 0 && len >= this.far) {
      const cos = (dx * this.ref[0] + dy * this.ref[1] + dz * this.ref[2]) / len;
      if (Math.acos(Math.min(1, Math.max(-1, cos))) <= this.slack) return false;
    }

    for (const q of this.dropped) {
      if (distanceToSegment(q, this.anchor, p) > this.tol) return true;
    }
    // It holds after all. Re-centre on the direction that worked, so the rest
    // of a gently curving run goes back to being answered by the cone.
    this.resetCone();
    if (len > 1e-12) {
      this.ref = [dx / len, dy / len, dz / len];
      this.slack = Math.PI;
      for (const q of this.dropped) this.narrowCone(q);
    }
    return false;
  }

  /** Fold one dropped point into the cone. */
  narrowCone(q) {
    const [dx, dy, dz] = delta(this.anchor, q);
    const len = Math.hypot(dx, dy, dz);
    if (len <= this.tol) return;   // this near the anchor, any direction serves
    if (len > this.far) this.far = len;
    const beta = Math.asin(Math.min(1, this.tol / len));
    if (!this.ref) {
      this.ref = [dx / len, dy / len, dz / len];
      this.slack = beta;
      return;
    }
    const cos = (dx * this.ref[0] + dy * this.ref[1] + dz * this.ref[2]) / len;
    const off = Math.acos(Math.min(1, Math.max(-1, cos)));
    this.slack = Math.min(this.slack, beta - off);
  }

  /** Write out whatever is being held. Call before a rapid, or at the end. */
  flush() {
    if (this.held) { this.emit(this.held); this.held = null; }
  }

  /**
   * The tool has been picked up and put down somewhere else; the next point
   * starts a new run rather than continuing this one.
   */
  break() {
    this.flush();
    this.anchor = null;
    this.dropped.length = 0;
    this.resetCone();
  }

  emit(p) {
    this.write(p[0], p[1], p[2], p[3]);
    this.anchor = p;
    this.dropped.length = 0;
    this.resetCone();
    this.kept++;
  }
}

/**
 * Drop rapids that go somewhere the very next rapid comes straight back from.
 *
 * Every strategy in here ends a pass by retracting to the clearance plane, and
 * every strategy begins one by positioning at clearance and coming back down.
 * That is the right thing to write and, most of the time, the right thing to
 * run. It is not the right thing to run when the next pass starts at the *same
 * XY* — which is exactly what happens between the depth levels of a contour, of
 * a pocket wall, and of an engraving pass. A 30mm profile in fifteen steps
 * climbs 10mm above the stock and comes back down again fourteen times, for no
 * reason at all: the tool is descending into the slot it cut on the way past.
 *
 * The rule is narrow on purpose, and safe by construction. A rapid is dropped
 * only when it is **purely vertical** — the same XY as the move before it — and
 * the move after it is *also a rapid at that same XY*. Then all three points
 * share one XY column, so the shortened move sweeps a subset of what the pair
 * swept and the tool cannot pass through anything it was not already passing
 * through.
 *
 * Both halves of that are load-bearing. Checking only the move *after* looks
 * sufficient and is not: a retract that also traverses — from the end of a cut
 * to the start of the next pass, at clearance — would be dropped, and the
 * shortened move would run diagonally from the bottom of one cut to the top of
 * the next, straight through whatever stands between them. That is a crash, and
 * it is the one this rule exists to not cause.
 *
 * Nothing is dropped ahead of a cut, ahead of a drill cycle, or as the first
 * move of a program.
 *
 * Events are keyed by move index, so they are carried onto the first surviving
 * move at or after where they were — a tool change that landed on a dropped
 * rapid must not end up after the cut that follows it.
 *
 * @param program a finished CL program
 * @returns the same shape, with the pointless rapids gone
 */
export function dropRedundantRapids(program, stride, RAPID) {
  const { moves, count, events } = program;
  if (count < 2) return program;

  const keep = new Uint8Array(count).fill(1);
  const same = (a, b) => Math.abs(moves[a * stride + 1] - moves[b * stride + 1]) < 1e-9
    && Math.abs(moves[a * stride + 2] - moves[b * stride + 2]) < 1e-9;

  let removed = 0;
  // Never the first move. The safety argument is that the shortened move sweeps
  // a subset of the column the pair swept, and that needs a known place to
  // start from — the first move *is* where the tool starts, so dropping it
  // leaves the one after it beginning from nowhere in particular.
  for (let n = 1; n < count - 1; n++) {
    if (moves[n * stride] !== RAPID) continue;
    // the next *surviving* move, which on a run of retracts is the one after
    // the ones already dropped
    // purely vertical: the tool was already at this XY
    if (!same(n - 1, n)) continue;
    let m = n + 1;
    while (m < count && !keep[m]) m++;
    if (m >= count || moves[m * stride] !== RAPID || !same(n, m)) continue;
    keep[n] = 0;
    removed++;
  }
  if (removed === 0) return program;

  // oldIndex -> the index it lands on afterwards
  const remap = new Int32Array(count + 1);
  const out = new Float32Array((count - removed) * stride);
  let write = 0;
  for (let n = 0; n < count; n++) {
    remap[n] = write;
    if (!keep[n]) continue;
    out.set(moves.subarray(n * stride, (n + 1) * stride), write * stride);
    write++;
  }
  remap[count] = write;

  return {
    ...program,
    moves: out,
    count: write,
    events: events.map((e) => ({ ...e, index: remap[Math.min(e.index, count)] })),
  };
}

/** b − a, in 3D; z defaults to 0. */
function delta(a, b) {
  return [b[0] - a[0], b[1] - a[1], (b[2] ?? 0) - (a[2] ?? 0)];
}

/** Perpendicular distance from a point to a segment, in 3D; z defaults to 0. */
export function distanceToSegment(p, a, b) {
  const az = a[2] ?? 0;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = (b[2] ?? 0) - az;
  const ex = p[0] - a[0];
  const ey = p[1] - a[1];
  const ez = (p[2] ?? 0) - az;
  const lenSq = dx * dx + dy * dy + dz * dz;
  if (lenSq < 1e-18) return Math.hypot(ex, ey, ez);
  let t = (ex * dx + ey * dy + ez * dz) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ex - dx * t, ey - dy * t, ez - dz * t);
}
