// Shared post engine. A dialect provides hooks; the core walks CL programs,
// tracks modality and feeds, expands drill cycles for controllers without
// them, and records a line map (G-code line → { op, move }) for the UI's
// backplot cross-highlighting.
//
// Dialect shape:
//   name
//   header(w, options)
//   toolChange(w, modal, { tool })            — T/M6/G43 or a comment
//   spindle(w, { rpm, dir })
//   drill: null | {
//     start(w, move, feeds)  — first hole: full cycle line (G98 G81/G83 …)
//     next(w, move)          — subsequent holes: short line (X Y …)
//     cancel(w)              — G80
//   }
//   arcs: whether the controller takes G2/G3 with I/J
//   stop(w)                                   — halt and wait for the operator
//   footer(w, { safeZ, spindleOn })
//
// Options: { programName, arcs (default: whatever the dialect supports),
//            arcTolerance (mm, default 0.01) }

import { MOVE_STRIDE, OP, FEED, feedRate, descentOf } from '../engine/cl.js';
import { orientationKey } from '../engine/indexing.js';
import { Modal, LineWriter, num } from './format.js';
import { planArcs } from './arcs.js';

export function buildProgram(dialect, ops, options = {}) {
  const w = new LineWriter();
  const modal = new Modal();
  const lineMap = new Map(); // 0-based G-code line index -> { op: i, move: n }
  let feeds = { cut: 600, plunge: 200 };
  let spindleOn = false;
  // What the pump was last told, for the same reason as `activeTool` and
  // `activeSpindle`: every operation states the coolant it wants and most of
  // them want the same thing, so an eleven-operation flood job wrote eleven M8s
  // — and the reader of a file cannot tell a restatement from a change. A
  // program starts dry, so 'off' is the state in force before the first word.
  let coolant = 'off';
  // The cycle in force, as the words that were written for it — not just
  // "there is one". A canned cycle's short form is `X.. Y..` and everything
  // else about the hole is modal, so a second hole that is deeper, or has a
  // different retract plane, or wants a peck, has to open a *new* cycle. It did
  // not: three holes at −5, −12 and −5-with-a-peck came out as one G81 to −5
  // followed by two bare XY lines, and the second hole was drilled seven
  // millimetres short with nothing in the file to say so.
  let cycle = null;
  let activeWcs = null;
  // Which setup's operations are being written. A setup is a fixturing — its
  // own stock, its own clamps, its own datum — so crossing from one to the next
  // means the part has to come out and go back in a different way round, which
  // is not something a program can do on its own. See the boundary below.
  let activeSetup = null;
  // Whether the setup in force is reached by rotary indexing rather than by
  // hand. Crossing from one indexed setup to another is a rotary swing the
  // machine does on its own, so it must *not* stop for the operator the way a
  // re-fixturing does — see the boundary below.
  let activeIndexed = false;
  // The tilted work plane in force, as a key, and whether one is actually
  // declared on the controller. An indexed operation swings the part to its
  // orientation and locks; the next in the same orientation restates nothing,
  // and leaving it (or the program ending) cancels the plane. See
  // engine/indexing.js and the dialect's `tiltedPlane` hook.
  let activeOrientation = null;
  let planeActive = false;
  // Where to lift to before the rotaries swing. The highest Z any operation
  // reaches is clear of the part in every frame, which is what a reorientation
  // needs — the table is about to move the work under a stationary tool.
  const reorientZ = safeZ(ops);
  // What is in the spindle. Every operation states the tool it wants, because
  // an operation cannot know what ran before it — but the *program* can, and a
  // second M6 for the tool already fitted is not a no-op: on a machine with a
  // changer it is a wasted carousel cycle, and on one without it is a prompt
  // telling the operator to fit the tool they are looking at. Six milling
  // operations sharing one end mill wrote five of them. Null until the first
  // tool is called, so the first change is always emitted.
  let activeTool = null;
  // What the spindle was last *told*, for the same reason as `activeTool`: an
  // operation cannot know what ran before it, so six operations sharing an end
  // mill all state S8000 and five of them are restating a speed already in
  // force. Null after every tool change, because the controller stops the
  // spindle to make one — so the first operation after a change always speaks.
  // Compared as a key rather than an rpm: the lathe's constant-surface-speed
  // mode writes G96 from `mode`, `surfaceSpeed` and `maxRpm`, and two passes
  // agreeing on rpm alone are not agreeing on the same spindle state.
  let activeSpindle = null;
  // The spindle speed in force, because a lathe writing feed per revolution has
  // to divide by it, and the number lives in an event rather than in the move
  // array. Zero means nothing has been asked for yet.
  let spindleRpm = 0;
  // Pitch of the synchronised run in force, 0 when there is not one. A
  // threading pass is not a G1 at a cleverly chosen feed: the carriage is
  // locked to the spindle encoder, and only the control can do that.
  let threadPitch = 0;
  // And whether the holes going by are being tapped. A tapped hole is a DRILL
  // move like any other — down to depth and back to the retract — so the shape
  // of it stays where it was; what changes is that the axis is locked to the
  // spindle rather than fed. See CLBuilder.tapping.
  let tapPitch = 0;
  let tapHand = 'right';

  const endCycle = () => {
    if (!cycle) return;
    dialect.drill.cancel(w);
    cycle = null;
    modal.reset(); // cycle lines bypass modal tracking
  };

  /** Everything a cycle line states that its short form does not restate. */
  const cycleKey = (m, feeds2) => `${m.z}|${m.retractZ}|${m.peck}|${m.dwell}|${feeds2.plunge}`;

  dialect.header(w, options);

  const useArcs = (options.arcs ?? true) && !!dialect.arcs;
  // How a straight move is written. A mill says X, Y and Z; a lathe says X and
  // Z, with X doubled into a diameter. Everything above this line is the same
  // for both, which is the point of letting the dialect answer it.
  const motion = dialect.motion ?? defaultMotion;

  ops.forEach((op, opIndex) => {
    const cl = op.cl;
    const d = cl.moves;
    const events = orderOpening([...cl.events]);
    // Said once per operation, not once per cycle — see the drill branch below.
    let dwellDropped = false;
    // Never tighter than the path was written at — see CLBuilder.setResolution.
    const arcTolerance = Math.max(options.arcTolerance ?? 0.01, cl.resolution ?? 0);
    const arcs = useArcs ? planArcs(cl, arcTolerance) : null;

    // An operation that produced no motion must not touch the machine.
    //
    // Every operation states the tool and the speed it wants, and those are
    // written when they are flushed — but the move loop below is what decides
    // *whether* they are, and for a zero-move program it never runs, so the
    // trailing flush wrote the whole preamble on its own. A drill that found no
    // holes posted T7 M6, G43 H7 and M3 S2200 and then said, in the next line,
    // that it had nothing to do: a carousel cycle on a machine with a changer,
    // and a prompt to fit a drill that never touches the part on one without.
    // Worse, it left `activeTool` pointing at a tool that was never used, so
    // the next real operation spent a second change going back.
    //
    // The diagnostic still gets written — "nothing to do here" is exactly what
    // the reader of the file needs. What is dropped is the motion-side state:
    // nothing was cut, so nothing needed fitting, starting or turning on.
    const silent = cl.count === 0;

    const flush = (e) => {
      endCycle();
      if (e.type === 'comment') w.comment(e.text);
      if (e.type === 'feeds') feeds = e;
      if (silent) return;
      if (e.type === 'tool' && e.tool !== activeTool) {
        // the options go through because whether the machine can change its own
        // tool is a fact about the machine, not about the dialect
        dialect.toolChange(w, modal, e, options);
        activeTool = e.tool;
        // The controller stops the spindle to change a tool, so whatever was
        // running is not running now — see `activeSpindle`.
        activeSpindle = null;
      }
      if (e.type === 'spindle' && spindleKey(e) !== activeSpindle) {
        dialect.spindle(w, e);
        activeSpindle = spindleKey(e);
        spindleOn = true;
        spindleRpm = e.rpm > 0 ? e.rpm : spindleRpm;
      }
      if (e.type === 'coolant' && e.mode !== coolant) {
        (dialect.coolant ?? defaultCoolant)(w, e, options);
        coolant = e.mode;
      }
      if (e.type === 'tapping') {
        // A post that cannot synchronise cannot tap, and the one thing it must
        // not do is write a G1 down the hole and let the file look finished.
        // The long-hand fallback below is the reversing-spindle idiom, which
        // works with a tension-compression holder and nothing else — so it says
        // so, once, where the operator will read it.
        if (e.pitch > 0 && !dialect.tap && !dialect.synchronised) {
          w.comment('WARNING: this control has no rigid tapping. These holes are '
            + 'fed at pitch × rpm with the spindle reversed to come out, which '
            + 'needs a tension-compression tapping holder — a solid holder will '
            + 'break the tap');
        }
        tapPitch = e.pitch > 0 ? e.pitch : 0;
        tapHand = e.hand ?? 'right';
        endCycle();
        modal.force('G');
        modal.force('F');
      }
      if (e.type === 'thread') {
        // A post with no synchronised motion cannot cut a thread, and the one
        // thing it must not do is write G1 and let the file look finished.
        if (e.pitch > 0 && !dialect.synchronised) {
          w.comment('WARNING: this post cannot write spindle-synchronised motion, so '
            + 'these passes cut a helical groove and not a thread');
        }
        threadPitch = e.pitch > 0 ? e.pitch : 0;
        // G33 is its own motion mode; leaving F or G1 modally in force across
        // the boundary is how a synchronised pass ends up being read as a
        // linear one, or the other way round
        modal.force('G');
        modal.force('F');
      }
    };

    w.comment(`operation: ${op.name}`);
    // A new fixturing cannot begin while the last one is still in the vice.
    //
    // Generate and Export both span every setup on the machine, and the file
    // used to run straight from the last operation of one into the first of the
    // next — through the moment where the part is supposed to come out, be
    // turned over and be picked up on a new datum. Nothing in the program said
    // so. So the transition is written as what it is: the spindle stopped, the
    // coolant off, and a program stop with the reason next to it.
    if (!silent && op.setup != null) {
      const thisIndexed = !!op.orientation;
      // An indexed setup is reached by the machine swinging its rotary axes to a
      // fixed angle and locking, not by the operator turning the part over — so
      // crossing from one indexed setup to another reorients on its own and must
      // not stop. Every other crossing is a genuine re-fixturing. See the
      // reorientation just below, and engine/indexing.js.
      const reFixture = activeSetup != null && op.setup !== activeSetup
        && !(activeIndexed && thisIndexed);
      if (reFixture) {
        // A re-fixturing puts the part back on the table square, so a tilted
        // plane no longer describes anything — cancel it first, while the
        // controller is still ours, so the coordinate frame the operator sees at
        // the stop is the machine's own and not a tilted one.
        if (planeActive) { dialect.tiltedPlane?.cancel(w, modal); planeActive = false; }
        activeOrientation = null;
        if (coolant !== 'off') {
          (dialect.coolant ?? defaultCoolant)(w, { mode: 'off' }, options);
          coolant = 'off';
        }
        if (spindleOn) { w.line('M5'); spindleOn = false; activeSpindle = null; }
        w.comment(`re-fixture the part for ${op.setupName ?? 'the next setup'}, `
          + 'then cycle start');
        (dialect.stop ?? defaultStop)(w);
        // Nothing about where the tool is survives an operator standing at the
        // machine, and nothing about the controller's state survives M0 either.
        modal.reset();
      }
      activeSetup = op.setup;
      activeIndexed = thisIndexed;
    }
    // the work offset ties our coordinates to what the operator touched off,
    // so it is stated once and restated whenever a setup change moves it
    if (op.wcs && op.wcs !== activeWcs && !silent) {
      (dialect.wcs ?? defaultWcs)(w, { code: op.wcs });
      activeWcs = op.wcs;
      // Modal words are numbers in *some* coordinate system, and this line just
      // changed which one. Two setups sharing a cutter — rough the top, flip,
      // rough the bottom — wrote `G55` and then a bare `X10`, because Y and Z
      // happened to match the last block of the previous offset. The machine
      // holds its Y and Z, which are now somewhere else entirely, and the next
      // block plunges there. Restating every word is the only safe reading of a
      // datum change; a tool change already does exactly this (see the dialects).
      modal.reset();
      // A tilted work plane is declared *relative to the active work offset* —
      // G68.2 X0 Y0 Z0 is the datum's own origin — so a plane set under G54 is
      // anchored to the wrong place once G55 is in force. Two indexed faces that
      // happen to share an angle but sit on different offsets would otherwise
      // keep the first plane and cut the second in the wrong spot. Invalidating
      // the orientation here makes the reorientation below re-establish it under
      // the new datum, retract and all.
      if (planeActive) activeOrientation = null;
    }
    // Swing the part to this operation's orientation, when it has one and it is
    // not the one already in force.
    //
    // Only when it changes: a 3+2 job cuts a whole face — several operations —
    // at one angle, and restating the plane before each would swing rotaries
    // that are already there. The tool is lifted clear first, because the table
    // is about to move the work under it; the previous plane is cancelled before
    // the new one is declared; and a post that cannot tilt says so rather than
    // writing the moves as though the part were flat. See engine/indexing.js.
    if (!silent) {
      const key = orientationKey(op.orientation ?? null);
      if (key !== activeOrientation) {
        activeOrientation = key;
        const wantsPlane = op.orientation && !op.orientation.identity;
        if (planeActive || wantsPlane) {
          const z = modal.word('Z', reorientZ, 3);
          if (z) w.line('G0', z);          // clear the part before the swing
        }
        if (planeActive) { dialect.tiltedPlane?.cancel(w, modal); planeActive = false; }
        if (wantsPlane) {
          if (dialect.tiltedPlane) {
            if (op.orientation.reachable === false) {
              w.comment(`WARNING: ${op.orientation.reason ?? 'this machine cannot reach '
                + 'this orientation'} — the swing will alarm or gouge`);
            }
            dialect.tiltedPlane.set(w, modal, op.orientation);
            planeActive = true;
          } else {
            // No tilted-plane support (a hobby controller): the moves would run
            // in the flat frame and cut the wrong thing, so say so loudly rather
            // than post a file that looks finished.
            w.comment('WARNING: this post cannot orient a tilted work plane, so '
              + `the ${op.orientation.kind} operations below are NOT indexed — do not run this`);
          }
        }
      }
    }
    // Where the tool is, for the one question a move cannot answer on its own:
    // how steeply it descends. Null at the start of an operation and after
    // anything that moves the machine without a move of ours (a cycle, a datum
    // change), which reads as "level" and so as the ordinary cutting feed.
    let at = null;
    const positionOf = (index) => {
      const p = index * MOVE_STRIDE;
      return [d[p + 1], d[p + 2], d[p + 3]];
    };
    for (let n = 0; n < cl.count; n++) {
      while (events.length && events[0].index <= n) flush(events.shift());
      const o = n * MOVE_STRIDE;
      const opcode = d[o];
      const before = w.lines.length;
      const arc = arcs?.get(n);

      if (arc) {
        endCycle();
        const end = arc.end * MOVE_STRIDE;
        // measured along the arc, not across it: a full-circle helix ends where
        // it started, and read as a straight move that is a plunge
        const f = feedRate(d[end + 7], feeds,
          descentOf(at, positionOf(arc.end), arc.length));
        // A Z on a G2/G3 is helical interpolation: the circle in XY, the Z run
        // linearly alongside it. Asking modal for it means a flat arc still
        // emits none, because Z has not moved.
        w.line(
          modal.word('G', arc.ccw ? 3 : 2, 0),
          modal.word('X', d[end + 1]), modal.word('Y', d[end + 2]),
          modal.word('Z', d[end + 3]),
          `I${num(arc.i)}`, `J${num(arc.j)}`,
          modal.word('F', f, 1),
        );
        // the whole run answers to the move the arc ends on, so clicking the
        // block in the G-code panel still lands somewhere on the toolpath
        for (let li = before; li < w.lines.length; li++) lineMap.set(li, { op: opIndex, move: arc.end });
        at = positionOf(arc.end);
        n = arc.end;
        continue;
      }

      if (opcode === OP.DRILL) {
        const move = {
          x: d[o + 1], y: d[o + 2], z: d[o + 3],
          retractZ: d[o + 4], peck: d[o + 5], dwell: d[o + 6],
        };
        if (tapPitch > 0) {
          // A tapped hole never joins a drilling cycle: the modal state a
          // canned cycle leaves behind is not what a tapping block expects, and
          // the two must not be interleaved.
          endCycle();
          const tap = { ...move, pitch: tapPitch, hand: tapHand };
          if (dialect.tap) dialect.tap(w, modal, tap, feeds);
          else expandTap(w, modal, tap, motion, { rpm: spindleRpm, feedMode: options.feedMode });
        } else if (dialect.drill) {
          // A setting that cannot be honoured has to say so.
          //
          // A canned cycle carries either a peck or a dwell on most controls,
          // never both, so the dialect drops one of them — and dropping it in
          // silence means an operation given `peck 3, dwell 0.5` posts a plain
          // G83 and nothing in the file, the panel or the notes mentions the
          // half-second that went missing.
          if (move.peck > 0 && move.dwell > 0 && !dialect.drill.dwellWithPeck && !dwellDropped) {
            w.comment(`the ${num(move.dwell, 2)}s dwell is not written: this control's `
              + 'peck cycle has no dwell word, and the peck retract clears the chips '
              + 'the dwell was asked for');
            dwellDropped = true;
          }
          const key = cycleKey(move, feeds);
          if (cycle === key) {
            dialect.drill.next(w, move);
          } else {
            // a hole that differs in anything but X and Y is a new cycle, and
            // the old one has to be cancelled before the new one is stated
            endCycle();
            dialect.drill.start(w, move, feeds);
            cycle = key;
          }
        } else {
          // rpm and feedMode go with it for the same reason they go with an
          // ordinary move: on a lathe the F word is mm per *revolution*, and
          // the only way to write one is to divide by the speed. Long-hand
          // drilling was the one motion in the post that did not carry them, so
          // a centre drill under G95 posted its 120 mm/min plunge as F120 —
          // read by the control as 120mm per rev, which at 1200 rpm is the
          // drill going into the bar at a hundred metres a minute.
          expandDrill(w, modal, move, feeds, motion,
            { rpm: spindleRpm, feedMode: options.feedMode });
        }
      } else {
        endCycle();
        const rapid = opcode === OP.RAPID;
        motion(w, modal, {
          rapid,
          x: d[o + 1], y: d[o + 2], z: d[o + 3],
          feed: feedRate(d[o + 7], feeds, descentOf(at, positionOf(n))),
          // a rapid inside a threading run is the lead-in or the retract, and
          // neither of those is synchronised to anything
          threadPitch: rapid ? 0 : threadPitch,
          rpm: spindleRpm,
          feedMode: options.feedMode,
        });
      }
      for (let li = before; li < w.lines.length; li++) lineMap.set(li, { op: opIndex, move: n });
      // A canned cycle leaves the tool wherever its retract plane is, which is
      // not something this loop wrote — so the next move's descent is unknown
      // rather than wrong.
      at = opcode === OP.DRILL ? null : positionOf(n);
    }
    while (events.length) flush(events.shift());
    endCycle();
    // neither a synchronised run nor a tapping mode survives the end of the
    // operation that opened it
    threadPitch = 0;
    tapPitch = 0;
    modal.force('F');
  });

  // A tilted work plane must not outlive the program: the closing retract and
  // every later job read their coordinates flat, so the plane is cancelled and
  // the rotaries are free to return before the footer lifts the tool.
  if (planeActive) { dialect.tiltedPlane?.cancel(w, modal); planeActive = false; }
  // Coolant off before the spindle stops and the tool retracts, always. A file
  // that ends with the pump still running leaves it running.
  if (coolant !== 'off') (dialect.coolant ?? defaultCoolant)(w, { mode: 'off' }, options);
  // `modal` goes with it so the closing retract can be dropped when the tool is
  // already standing there — every milling program ended `G0 Z10 / G0 Z10`,
  // because the last operation retracts to clearance and the footer then said so
  // again, bypassing the modal tracker that would have known.
  dialect.footer(w, { safeZ: safeZ(ops), safeX: safeX(ops), spindleOn, modal });
  return { text: w.toString(), lineMap };
}

/**
 * The order the machine wants an operation's opening state stated in.
 *
 * A CL program says what it wants — this tool, this speed, this coolant — in
 * whatever order the strategy wrote it, and for most of that the order does not
 * matter. For one of them it does: the pump has to be off *before* the carousel
 * swings and on *after* the spindle is up. Two drills, the first flood and the
 * second dry, posted `T2 M6 / G43 H2 / M3 S1400 / M9` — the change made with
 * coolant running, and the M9 arriving afterwards as though the dry operation
 * had asked for coolant it did not want.
 *
 * Only the events before the first move are moved, and only relative to each
 * other. Anything an operation says mid-cut is said where it said it.
 */
function orderOpening(events) {
  const rank = (e) => {
    if (e.type === 'coolant') return e.mode === 'off' ? 1 : 4;
    if (e.type === 'tool') return 2;
    if (e.type === 'spindle') return 3;
    // comments and feeds move nothing on the machine, so they stay in front;
    // a synchronised run is opened last, after everything it depends on
    return e.type === 'thread' ? 5 : 0;
  };
  let n = 0;
  while (n < events.length && events[n].index <= 0) n++;
  // sort is stable, so events of equal rank keep the order they were written in
  const head = events.slice(0, n).sort((a, b) => rank(a) - rank(b));
  events.splice(0, n, ...head);
  return events;
}

/**
 * M8 flood, M7 mist, M9 off — the same three words on every control there is.
 *
 * A machine with no coolant gets a comment rather than the M-word: on a
 * hobby router M8 is at best ignored and at worst switches a relay wired to
 * something else, and the operator reading the file still needs to know the
 * program wanted coolant here.
 */
function defaultCoolant(w, { mode }, options = {}) {
  if (options.coolant === false) {
    if (mode !== 'off') w.comment(`${mode} coolant wanted here — this machine has none`);
    return;
  }
  w.line({ flood: 'M8', mist: 'M7' }[mode] ?? 'M9');
}

/** Widest X seen — a lathe retracts the cross-slide, not the spindle. */
function safeX(ops) {
  let out = 0;
  for (const op of ops) {
    const d = op.cl.moves;
    for (let n = 0; n < op.cl.count; n++) out = Math.max(out, d[n * MOVE_STRIDE + 1]);
  }
  return out;
}

/**
 * Everything about a spindle event a dialect can write, as one comparable value.
 *
 * Not just the rpm: `post/lathe.js` reads `mode`, `surfaceSpeed` and `maxRpm`
 * to choose between G97 at a fixed speed and G96 at a constant surface speed,
 * and those two are different instructions at the same nominal rpm.
 */
function spindleKey(e) {
  return JSON.stringify([e.rpm, e.dir ?? null, e.mode ?? null,
    e.surfaceSpeed ?? null, e.maxRpm ?? null]);
}


/** G54…G59 is standard across dialects; a post only overrides it if it differs. */
function defaultWcs(w, { code }) {
  w.line(code);
}

/**
 * Stop and wait for the operator. M0 on every control there is — and unlike M1
 * it cannot be switched off at the panel, which matters when what it is waiting
 * for is the part being turned over.
 */
function defaultStop(w) {
  w.line('M0');
}

/** How a mill writes a straight move: the three axes it has. */
function defaultMotion(w, modal, { rapid, x, y, z, feed }) {
  const wx = modal.word('X', x);
  const wy = modal.word('Y', y);
  const wz = modal.word('Z', z);
  if (!wx && !wy && !wz) return;
  if (rapid) w.line(modal.word('G', 0, 0), wx, wy, wz);
  else w.line(modal.word('G', 1, 0), wx, wy, wz, modal.word('F', feed, 1));
}

/**
 * Long-hand drill for controllers without canned cycles (rapid–plunge–retract).
 *
 * Every peck after the first goes back down the hole at rapid to just short of
 * where it left off, and only then feeds. That is what G83 does on a control
 * that has it, and it is not a nicety: without it the tool feeds from the
 * retract plane all the way down through the hole it has already made, at
 * plunge feed, on every peck. A 30mm hole pecked 1mm at a time spent about
 * fifteen times as long cutting air as cutting metal — a slow file, and one
 * that reads nothing like the cycle it stands in for.
 */
const PECK_GAP = 0.5;   // mm of feed above the last depth, so it never rapids into metal

function expandDrill(w, modal, move, feeds, motion, spindle = {}) {
  const go = (rapid, z, feed) => motion(w, modal, {
    rapid, x: move.x, y: move.y, z, feed, ...spindle,
  });
  go(true, move.retractZ);
  const peck = move.peck > 0 ? move.peck : Infinity;
  let z = move.retractZ;
  let cut = move.retractZ;    // how far down the hole already goes
  while (z > move.z + 1e-9) {
    if (cut < move.retractZ - 1e-9) {
      // back down the open hole at rapid, stopping short of the bottom of it
      go(true, Math.min(move.retractZ, cut + PECK_GAP));
      modal.force('Z');
    }
    z = Math.max(move.z, z - peck);
    go(false, z, feeds.plunge);
    cut = z;
    if (z > move.z + 1e-9) {
      go(true, move.retractZ);   // chip clear
      modal.force('Z');
    } else if (move.dwell > 0) {
      // the dwell belongs at the bottom of the hole, not at every peck step
      w.line(`G4 P${num(move.dwell, 2)}`);
    }
  }
  go(true, move.retractZ);
}

/**
 * Tapping long-hand, for a control with no rigid tapping cycle.
 *
 * The reversing-spindle idiom: feed in at pitch × rpm, stop, reverse, feed out
 * at the same rate, and put the spindle back the way it was. It is not rigid
 * tapping and cannot be — nothing here is watching the encoder — so it works
 * with a tension-compression holder to take up the error and breaks taps in a
 * solid one. The warning is written once, when the mode starts.
 *
 * A left-hand tap is the same sequence with the two spindle directions swapped,
 * which is the whole of the difference and is why the hand travels with the
 * move rather than being assumed.
 */
function expandTap(w, modal, move, motion, spindle = {}) {
  const rpm = spindle.rpm > 0 ? spindle.rpm : 0;
  // The feed is arithmetic, not a preference: one turn, one pitch.
  const feed = rpm > 0 ? rpm * move.pitch : 0;
  const forward = move.hand === 'left' ? 'M4' : 'M3';
  const reverse = move.hand === 'left' ? 'M3' : 'M4';
  const go = (rapid, z, f) => motion(w, modal, {
    rapid, x: move.x, y: move.y, z, feed: f, ...spindle,
  });
  go(true, move.retractZ);
  go(false, move.z, feed);
  // stopped before reversing: a spindle told to turn the other way while it is
  // still running the first is a spindle that decides for itself how long the
  // tap spends at the bottom of the hole
  w.line('M5');
  w.line(rpm > 0 ? `${reverse} S${Math.round(rpm)}` : reverse);
  go(false, move.retractZ, feed);
  w.line('M5');
  w.line(rpm > 0 ? `${forward} S${Math.round(rpm)}` : forward);
  modal.force('F');
}

/** Highest Z seen across all programs — used for the final retract. */
function safeZ(ops) {
  let top = 10;
  for (const op of ops) {
    const d = op.cl.moves;
    for (let n = 0; n < op.cl.count; n++) {
      const o = n * MOVE_STRIDE;
      top = Math.max(top, d[o + 3], d[o] === OP.DRILL ? d[o + 4] : -Infinity);
    }
  }
  return top;
}
