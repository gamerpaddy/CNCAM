// CL data v0 (DRAFT — frozen as v1 after the Spike B end-to-end run).
//
// The canonical intermediate between toolpath strategies and posts/simulator.
// Motion records: flat Float32Array, MOVE_STRIDE floats each:
//   [opcode, x, y, z, i, j, k, feedClass]
// (i,j,k) = unit tool-axis vector — constant (0,0,1) for 3-axis; this field is
// what makes 3+2 and simultaneous 5-axis extensions of the same pipeline.
// Arcs and state (tool change, spindle, coolant, cycles, WCS) are side events
// keyed by motion index, kept out of the hot array.

import { CollinearFilter, dropRedundantRapids } from './simplify.js';

export const MOVE_STRIDE = 8;

export const OP = Object.freeze({
  RAPID: 0,
  LINE: 1,
  // DRILL repurposes the axis fields (tool axis is implied +Z for cycles):
  //   [DRILL, x, y, zBottom, retractZ, peck, dwell, PLUNGE]
  // peck = 0 means a plain drill (G81), > 0 a peck cycle (G83); dwell > 0 with
  // no peck is a dwell cycle (G82), which is how a flat-bottomed hole is
  // finished off — the tool pauses at depth rather than lifting immediately.
  DRILL: 2,
});

export const FEED = Object.freeze({
  RAPID: 0,
  CUT: 1,
  LEAD: 2,
  RAMP: 3,
  PLUNGE: 4,
});

/**
 * How fast a move runs, in mm/min — the one statement of it.
 *
 * A plunge runs at the plunge feed and a cut at the cutting feed; the
 * interesting one is the **ramp**, which is a cut that happens to descend. How
 * fast it may go depends on how steeply: both numbers are statements about the
 * same cutter — the plunge feed is how fast it may be driven *downward*, the
 * cutting feed how fast it may be driven through material at all — so a ramp
 * respects both. The vertical component may not exceed the plunge feed, and the
 * move itself may not exceed the cutting feed.
 *
 * Treating every ramp as a plunge is what made a helical bore take three times
 * as long as it needed to: the helix in a ⌀20 bore with a ⌀6 cutter descends
 * 0.9mm per 44mm of travel — 1.2° — and 94% of that operation's cutting
 * distance ran at 250mm/min instead of 800, at a chip load of 0.025mm/tooth,
 * which is a cutter rubbing rather than cutting.
 *
 * It lives here because four places asked the question and all four answered it
 * themselves: the post, the time estimate and the simulation twice. That is the
 * shape of every bug in this codebase — see the note in geom/heightmap.js.
 *
 * @param descent |dz| over the length of the move: 0 level, 1 straight down
 */
export function feedRate(feedClass, feeds, descent = 0) {
  const cut = feeds.cut || feeds.plunge || 100;
  const plunge = feeds.plunge || cut;
  if (feedClass === FEED.PLUNGE) return plunge;
  if (feedClass !== FEED.RAMP) return cut;
  if (!(descent > 1e-6)) return cut;
  return Math.min(cut, plunge / descent);
}

/**
 * How much of a move is straight down, as a fraction of its own length.
 *
 * @param length the distance actually travelled in XY, where that is not the
 *   straight-line distance between the ends — an arc, and above all a
 *   full-circle helix, whose two ends are the same point
 */
export function descentOf(from, to, length = null) {
  if (!from) return 0;
  const dz = to[2] - from[2];
  if (!(dz < -1e-9)) return 0;      // level, or climbing out: not a descent
  const run = length ?? Math.hypot(to[0] - from[0], to[1] - from[1]);
  const travel = Math.hypot(run, dz);
  return travel > 1e-9 ? Math.min(1, -dz / travel) : 1;
}

export class CLBuilder {
  constructor(capacityMoves = 1024) {
    this.data = new Float32Array(capacityMoves * MOVE_STRIDE);
    this.count = 0;
    this.events = [];               // { index, type, ...payload }
    this.notes = [];                // { level, text } — user-facing diagnostics
    this.axis = [0, 0, 1];
    this.merger = null;             // see simplify()
    this.resolution = 0;            // see setResolution()
  }

  setAxis(i, j, k) { this.axis = [i, j, k]; }

  /**
   * The shortest move this program was written at, in mm.
   *
   * Carried to the post because the arc fitter needs it. Fitting checks that
   * the bulge between consecutive points — the sagitta — is within the arc
   * tolerance, which is what stops a coarse twelve-sided polygon from being
   * replaced by the circle it is *not*. A path deliberately written at a
   * resolution coarser than that budget fails the check everywhere, so a bore
   * that would have been one G2 comes out as four hundred G1s: coarsening the
   * path made the file five times bigger, which is the opposite of the point.
   *
   * Saying so here resolves it honestly. The chords were sampled *from* the
   * true arc at this spacing, so replacing them with the arc moves the path by
   * at most the sagitta the resolution already allowed — the deviation was
   * accepted when the number was set, and the arc is the more faithful
   * description of the two, not the less.
   */
  setResolution(mm) {
    this.resolution = Number.isFinite(mm) && mm > 0 ? mm : 0;
    return this;
  }

  /**
   * Merge collinear cutting points on the way in, to within `tolerance`.
   *
   * Strategies work on resampled paths: the raster sweeps, the drop-cutter and
   * the offset walkers all need a point every millimetre or two, and that is a
   * requirement of the *computation*, not of the geometry. A 60mm straight wall
   * arrives as forty identical collinear moves, and forty moves is what the
   * control has to read, the post has to write and the viewport has to draw.
   *
   * Opt-in per strategy, because a few of them care exactly where their points
   * are: engrave.js writes the shape of a letter, and bore.js deliberately
   * chords tight so the post's arc fitter can put the circle back.
   *
   * Everything that is not an ordinary cut — a rapid, a drill cycle, an event,
   * the end of the program — flushes first, so nothing is ever held back across
   * a move that changes where the tool is or what the machine is doing.
   *
   * @see engine/simplify.js
   */
  simplify(tolerance) {
    this.merger = new CollinearFilter(
      (x, y, z, feedClass) => this.move(OP.LINE, x, y, z, feedClass), tolerance,
    );
    return this;
  }

  /** Write out anything the merger is holding. Safe to call at any time. */
  flushMerged() {
    this.merger?.flush();
  }

  move(opcode, x, y, z, feedClass) {
    if ((this.count + 1) * MOVE_STRIDE > this.data.length) this.grow();
    const o = this.count * MOVE_STRIDE;
    const d = this.data;
    d[o] = opcode; d[o + 1] = x; d[o + 2] = y; d[o + 3] = z;
    d[o + 4] = this.axis[0]; d[o + 5] = this.axis[1]; d[o + 6] = this.axis[2];
    d[o + 7] = feedClass;
    return this.count++;
  }

  rapid(x, y, z) {
    // the tool is going somewhere else; the next cut starts a fresh run
    this.merger?.break();
    return this.move(OP.RAPID, x, y, z, FEED.RAPID);
  }

  cut(x, y, z, feedClass = FEED.CUT) {
    if (this.merger) return this.merger.push(x, y, z, feedClass);
    return this.move(OP.LINE, x, y, z, feedClass);
  }

  drill(x, y, zBottom, { retractZ, peck = 0, dwell = 0 }) {
    this.merger?.break();
    if ((this.count + 1) * MOVE_STRIDE > this.data.length) this.grow();
    const o = this.count * MOVE_STRIDE;
    const d = this.data;
    d[o] = OP.DRILL; d[o + 1] = x; d[o + 2] = y; d[o + 3] = zBottom;
    d[o + 4] = retractZ; d[o + 5] = peck; d[o + 6] = dwell;
    d[o + 7] = FEED.PLUNGE;
    return this.count++;
  }

  event(type, payload = {}) {
    // an event is keyed by the move index it sits at, so nothing may be in
    // flight when one is recorded
    this.merger?.flush();
    this.events.push({ index: this.count, type, ...payload });
  }

  toolChange(tool) { this.event('tool', { tool }); }

  /**
   * @param options `{ mode: 'css', surfaceSpeed, maxRpm }` asks for constant
   *   surface speed — the spindle speeding up as the tool works in toward the
   *   axis, which is what keeps the metres-per-minute constant across a facing
   *   cut. `rpm` is still carried, because it is what the simulation clock and
   *   the chip-load report are computed from, and because a control that cannot
   *   hold surface speed needs a number to fall back to.
   */
  spindle(rpm, dir = 'cw', options = {}) {
    this.event('spindle', { rpm, dir, ...options });
  }

  /**
   * Mark the following cutting moves as spindle-synchronised, at `pitch` mm per
   * revolution — a threading pass.
   *
   * This is the difference between a program that cuts a thread and a program
   * that cuts a helical groove of approximately the right shape. The carriage
   * has to be locked to the spindle encoder, not fed at a rate that works out
   * about right, or every pass after the first starts in a slightly different
   * place and the form is destroyed. The control does that; the CAM's job is to
   * *say* so, which is what this event is for. A post with no synchronised
   * motion refuses the program rather than writing G1 and hoping.
   */
  threadPass(pitch) { this.event('thread', { pitch }); }

  /** End of a synchronised run: ordinary feed from here on. */
  threadEnd() { this.event('thread', { pitch: 0 }); }


  coolant(mode) { this.event('coolant', { mode }); }

  /**
   * Tapping on, or off.
   *
   * A tapped hole is geometrically a drilled one — down to depth and back to
   * the retract — so it stays a DRILL move and nothing downstream has to learn
   * a second kind of hole. What is different is not the shape, it is the
   * *mode*: the control locks the Z axis to the spindle encoder, one turn to
   * one pitch, and no feed rate can stand in for that. A mode is a state event,
   * which is what this side table is for.
   */
  tapping(pitch, hand = 'right') { this.event('tapping', { pitch, hand }); }
  comment(text) { this.event('comment', { text }); }

  /**
   * A diagnostic the *user* should see, not just the G-code reader.
   *
   * Strategies used to say "found no enclosed region to clear" as a comment,
   * which is honest and completely invisible: the only place it surfaced was
   * the posted file, which nobody opens to find out why a toolpath looks empty.
   * Notes ride on the finished program so the UI can put them next to the
   * operation that produced them, and they are *also* emitted as comments so
   * the G-code still explains itself.
   *
   * @param level 'info' for something worth knowing, 'warn' for something that
   *   probably means the operation did not do what the user wanted
   */
  note(level, text) {
    this.notes.push({ level, text });
    this.comment(text);
  }

  info(text) { this.note('info', text); }
  warn(text) { this.note('warn', text); }

  grow() {
    const next = new Float32Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }

  /** Finished, trimmed program. `data` buffer is transferable to workers. */
  finish() {
    this.merger?.flush();
    // The link moves nobody needs: a retract to clearance followed by a rapid
    // straight back down at the same XY, which is what every depth level of
    // every 2.5D strategy emits between its passes. See engine/simplify.js.
    return dropRedundantRapids({
      version: 0,
      moves: this.data.slice(0, this.count * MOVE_STRIDE),
      count: this.count,
      events: this.events,
      notes: this.notes,
      resolution: this.resolution,
    }, MOVE_STRIDE, OP.RAPID);
  }
}

/**
 * How fast a spindle-synchronised move actually travels, in mm/min.
 *
 * A threading pass has no feedrate of its own. The carriage is locked to the
 * encoder, so it advances one pitch per revolution and its speed is
 * `pitch × rpm` — nothing else. Timing one at the tool's cutting feed instead is
 * the arithmetic behind "threading a simple short thread says 52 minutes": a
 * threading insert carries a slow feed number, and a lathe running 3mm of pitch
 * at a few hundred rpm covers the thread more than ten times faster than that
 * number claims. Both clocks in here — the estimate and the simulation — were
 * reading the wrong instrument.
 *
 * @returns mm/min, or 0 when this is not a synchronised move
 */
export function syncFeed(pitch, rpm) {
  return pitch > 0 && rpm > 0 ? pitch * rpm : 0;
}

/**
 * A machine's two rapid rates, from whatever the caller had.
 *
 * A number means "both axes at this" — what every test and every older project
 * file carries; the app hands over `{ xy, z }` off the machine record.
 */
export function rapidRates(rapidFeed = 3000) {
  if (typeof rapidFeed === 'number') return { xy: rapidFeed, z: rapidFeed };
  const xy = rapidFeed?.xy > 0 ? rapidFeed.xy : 3000;
  return { xy, z: rapidFeed?.z > 0 ? rapidFeed.z : xy };
}

/**
 * How long a G0 takes, in seconds.
 *
 * The axes run at once, each at its own maximum, and the move is over when the
 * slowest of them arrives — which is what a controller does, and why a retract
 * on a machine whose Z is half as fast as its table is not distance ÷ rapid.
 * Both clocks in the app read this one function: an estimate that disagrees
 * with the simulation's own clock is worse than either being wrong.
 */
export function rapidSeconds(dxy, dz, rapidFeed) {
  const { xy, z } = rapidRates(rapidFeed);
  return Math.max(Math.abs(dxy) / xy, Math.abs(dz) / z) * 60;
}

/**
 * The pitch and spindle speed in force at each move, as a cursor.
 *
 * Both clocks walk their moves in order and both need the same two events, so
 * the walk lives here once. `at(n)` must be called with non-decreasing `n`.
 */
export function syncTrack(cl) {
  const pick = (type) => cl.events.filter((e) => e.type === type)
    .sort((a, b) => a.index - b.index);
  const threads = pick('thread');
  const spindles = pick('spindle');
  let ti = 0;
  let si = 0;
  let pitch = 0;
  let rpm = 0;
  return {
    at(n) {
      while (ti < threads.length && threads[ti].index <= n) pitch = Math.max(0, threads[ti++].pitch ?? 0);
      while (si < spindles.length && spindles[si].index <= n) rpm = Math.max(0, spindles[si++].rpm ?? 0);
      return syncFeed(pitch, rpm);
    },
  };
}

/** XY of the most recent move in a builder (for retracts back over the cut). */
export function lastXY(cl) {
  cl.merger?.flush();   // "the most recent move" must include one still in flight
  const o = (cl.count - 1) * MOVE_STRIDE;
  return [cl.data[o + 1], cl.data[o + 2]];
}

/** Iterate a finished CL program: cb(opcode, x, y, z, i, j, k, feedClass, index). */
export function eachMove(cl, cb) {
  const d = cl.moves;
  for (let n = 0; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    cb(d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5], d[o + 6], d[o + 7], n);
  }
}
