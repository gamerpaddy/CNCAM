// Writing a simultaneous 5-axis operation.
//
// The CL says where the tool *tip* is and which way the spindle points; a
// control wants axis positions. How the one becomes the other depends on who
// does the arithmetic of the table swinging the part about its rotary centre:
//
//   'kins' / 'g43.4'  the control does (LinuxCNC's trt kinematics; Fanuc, Haas
//                     and Okuma's tool-centre-point mode). The program is in part
//                     coordinates — the tip — with the two rotary words beside it,
//                     feed is the speed of the tip, and G94 stays as it is.
//   'none'            the post does. Every block is written in machine axes — the
//                     tip carried round the rotary centre by the table's own turn
//                     — and the feed is a duration (G93), because F in mm/min means
//                     nothing on a block where the part is also turning.
//
// What both have to deal with is that the control interpolates in *its* space,
// not the CAM's. Between two blocks the axes move linearly: under TCP the tip
// goes straight and the angles linearly, which is the CL's own reading provided
// the axis does not swing far in one block; without TCP the *joints* go
// linearly and the tip follows a curve, so a move that turns as it goes has to
// be cut into pieces short enough that the curve is the line. Both are done
// here, once, by cutting each move into pieces — a degree or two of swing for
// TCP, a tolerance on the tip's path for the rest.
//
// The rotary angles come from engine/five/kinematics.js, which keeps them
// continuous (no spin through a whole turn between two neighbouring points) and
// inside their limits. This module never solves an angle; it asks.
//
// An operation ends with the table back at zero. The CL leaves the tool upright,
// but upright is a *direction*: with the tool vertical the turntable is free, and
// the angle it was left at is arbitrary. A 3-axis program that follows reads its
// XY in the machine's own frame, so a table left at C77 would cut it 77° round.

import {
  chooseAngles, tipToMachine, machineToTip, toWritten, recentre, POLE_DEG, unwindsBefore, liftedAfter,
} from '../engine/five/kinematics.js';
import { angleBetween, blendAxis } from '../engine/five/tilt-sweep.js';
import { isTilted } from '../engine/cl.js';

/** The most the spindle may swing in one block, in degrees. */
export const MAX_SWING = 2;

/** How far the tip may leave the straight line between two blocks without TCP, in mm. */
export const TIP_TOLERANCE = 0.01;

/**
 * And the most a rotary axis may turn in one block, in degrees. Near vertical
 * a swing of a degree of axis can be a quarter turn of the turntable, so the
 * angle of the spindle is not enough to count by.
 */
export const MAX_ROTARY_STEP = 10;

/** A swing bigger than this between two neighbouring blocks is a flip, not a sweep. */
const FLIP_DEG = 90;

/** How fast the rotaries may be driven when the machine does not say, deg/min. */
const DEFAULT_ROTARY_FEED = 7200;

const UP = [0, 0, 1];

/**
 * @param five { rotary, tcp, pivot } — see engine/five/post-data.js
 * @param motion the dialect's way of writing one straight move
 * @param hooks { tool: () => the tool number in force, tcpOn, tcpOff }
 * @returns a function with the shape of `motion`, plus `finish` and `warnings`
 */
export function fiveAxisWriter(five, motion, hooks) {
  const machine = { rotary: five.rotary };
  const mode = five.tcp;
  const pivot = five.pivot ?? [0, 0, 0];
  const none = mode === 'none';
  const tolerance = five.tipTolerance ?? TIP_TOLERANCE;
  if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error('5-axis interpolation tolerance must be a positive finite number');
  const fail = (code, detail, data = {}) => {
    const error = new Error(`${five.operation ?? '5-axis operation'}: ${detail}`);
    error.code = code;
    error.finding = { operation: five.operation, move: sourceMove, ...data };
    throw error;
  };
  let sourceMove = -1;
  const letters = five.rotary.map((a) => a.letter);
  const rotaryFeed = Math.min(
    ...five.rotary.map((a) => a.maxFeed ?? DEFAULT_ROTARY_FEED), DEFAULT_ROTARY_FEED,
  );

  let angles = Object.fromEntries(letters.map((l) => [l, 0]));
  let tip = null;
  let axis = UP;
  const said = new Set();
  const warn = (w, key, text) => {
    if (said.has(key)) return;
    said.add(key);
    w.comment(`WARNING: ${text}`);
    write.warnings.push(text);
  };

  /** The block for one pose, with the rotary words alongside. */
  const block = (w, modal, m, point, a, feed, rapid, duration) => {
    const written = toWritten(a, machine);
    const rotaries = five.rotary.map((r) => ({ letter: r.letter, value: written[r.letter] }));
    if (none) {
      const at = tipToMachine(point, a, machine, pivot);
      motion(w, modal, {
        ...m, rapid, x: at[0], y: at[1], z: at[2], rotaries,
        feed: rapid ? 0 : duration > 1e-12 ? 1 / duration : 0, forceFeed: !rapid && duration > 1e-12,
      });
    } else {
      motion(w, modal, { ...m, rapid, x: point[0], y: point[1], z: point[2], rotaries, feed });
    }
  };

  /**
   * The poses between the last one and this one: the tip and the axis at each,
   * and the angles that point the spindle that way.
   */
  const piecesTo = (point, a, rapid) => {
    const swing = angleBetween(axis, a);
    let n = Math.max(1, Math.ceil(swing / MAX_SWING));
    // …and by what the rotary axes actually do to get there
    const target = chooseAngles(a, machine, angles).angles;
    const turn = Math.max(...letters.map((l) => Math.abs(target[l] - angles[l])), 0);
    n = Math.max(n, Math.ceil(turn / MAX_ROTARY_STEP));
    const walk = (count) => {
      const out = [];
      let from = angles;
      for (let i = 1; i <= count; i++) {
        const t = i / count;
        const p = tip ? lerp(tip, point, t) : point;
        const k = blendAxis(axis, a, t);
        const choice = chooseAngles(k, machine, from);
        if (!choice.reachable) fail('FIVE_AXIS_UNREACHABLE', choice.reason ?? 'Requested orientation is outside rotary travel', { orientation: k, angles: choice.angles, fraction: t });
        out.push({ p, k, choice });
        from = choice.angles;
      }
      return out;
    };
    let poses = walk(n);
    // Evenly spaced along the way is not evenly spaced in the axes: near the pole
    // the turntable does most of its turning in one piece. Halve until none does —
    // unless halving stops helping, which is a turn the move cannot be cut finer
    // than (the first step off the pole, where C has to go from nowhere to
    // somewhere): cutting that finer only writes a hundred tiny blocks beside it.
    const biggest = (list) => {
      let from = angles;
      let worst = 0;
      for (const { choice } of list) {
        worst = Math.max(worst, ...letters.map((l) => Math.abs(choice.angles[l] - from[l])));
        from = choice.angles;
      }
      return worst;
    };
    let worst = biggest(poses);
    for (let round = 0; round < 5 && n < 128 && worst > MAX_ROTARY_STEP; round++) {
      const finer = walk(n * 2);
      const next = biggest(finer);
      if (next > worst * 0.8) break;
      n *= 2;
      poses = finer;
      worst = next;
    }
    if (none && tip && !rapid) {
      // without TCP the joints go in straight lines and the tip follows them:
      // cut it finer until the tip is where the CL said to within tolerance
      for (let round = 0; round < 6; round++) {
        if (deviation(poses) <= tolerance) break;
        if (n * 2 > 8192) break;
        n *= 2;
        poses = walk(n);
      }
    }
    if (none && tip && !rapid) {
      const error = deviation(poses);
      if (error > tolerance) fail('FIVE_AXIS_TOLERANCE', `Interpolation error ${error.toFixed(6)} mm exceeds ${tolerance} mm; refinement budget exhausted`, { error, tolerance });
    }
    return poses;
  };

  /** The worst distance of the tip from the CL's path, over the middle of each piece. */
  const deviation = (poses) => {
    let worst = 0;
    let prevPoint = tip;
    let prevAngles = angles;
    let prevMachine = tipToMachine(tip, angles, machine, pivot);
    for (const { p, k, choice } of poses) {
      const here = tipToMachine(p, choice.angles, machine, pivot);
      for (const t of [0.25, 0.5, 0.75]) {
        const midAngles = Object.fromEntries(letters.map(
          l => [l, prevAngles[l] + (choice.angles[l] - prevAngles[l]) * t]));
        const midMachine = lerp(prevMachine, here, t);
        const mid = machineToTipAt(midMachine, midAngles);
        const want = lerp(prevPoint, p, t);
        worst = Math.max(worst, Math.hypot(mid[0] - want[0], mid[1] - want[1], mid[2] - want[2]));
      }
      prevPoint = p;
      prevAngles = choice.angles;
      prevMachine = here;
    }
    return worst;
  };
  const machineToTipAt = (x, a) => machineToTip(x, a, machine, pivot);

  const write = (w, modal, m) => {
    sourceMove = m.sourceMove ?? sourceMove + 1;
    if (!write.started) {
      write.started = true;
      if (none) { w.line('G93'); modal.force('F'); }
      hooks.tcpOn?.(w, modal, { mode, tool: hooks.tool?.() });
    }
    const point = [m.x, m.y, m.z];
    const a = Array.isArray(m.axis) && isTilted(m.axis[0], m.axis[1]) ? m.axis : UP;
    // A swing made at rapid is made at clearance, between passes, with nothing
    // in the way: the moment to unwind the table — turn each axis back within a
    // half turn of zero, which is the same pose — so that a long program does
    // not wind a turntable up to the end of its travel one pass at a time.
    // The same goes for the next move of any kind after the tool has been lifted out of the
    // work: a pass that ends because the turntable ran out of room lifts, and begins the next
    // from the same point with the same axis — no swing to unwind in, and the plunge that
    // follows may not be a rapid either.
    if (tip && unwindsBefore({ lifted: write.lifted, rapid: m.rapid, swings: angleBetween(axis, a) > 1e-6 })) {
      const home = recentre(angles, machine);
      if (letters.some((l) => Math.abs(home[l] - angles[l]) > 1e-9)) {
        block(w, modal, m, tip, home, 0, true, 0);
        angles = home;
      }
    }
    const poses = piecesTo(point, a, m.rapid);
    const before0 = tip;
    let before = tip;
    for (const { p, k, choice } of poses) {
      if (!choice.reachable) {
        warn(w, 'reach', `${choice.reason ?? 'the spindle direction is out of reach'} — `
          + 'this program will alarm at the machine or run into a stop');
      }
      if (!m.rapid && choice.nearPole) {
        warn(w, 'pole', `the spindle comes within ${POLE_DEG} degree of vertical while cutting — `
          + 'the turntable spins fastest there; expect a slowdown or a mark');
      }
      const flip = Math.max(...letters.map((l) => Math.abs(choice.angles[l] - angles[l])));
      if (flip > FLIP_DEG && !m.rapid) {
        warn(w, 'flip', `a rotary axis jumps ${Math.round(flip)} degrees between two cutting `
          + 'blocks — the spindle crosses its pole or the axis changes branch mid-cut');
      }
      // how long this piece should take: the tip's distance at the feed, or the
      // swing at the rotary feed if that takes longer
      const dist = before ? Math.hypot(p[0] - before[0], p[1] - before[1], p[2] - before[2]) : 0;
      const turned = Math.max(...letters.map((l) => Math.abs(choice.angles[l] - angles[l])), 0);
      const duration = m.feed > 0 ? Math.max(dist / m.feed, turned / rotaryFeed) : 0;
      block(w, modal, m, p, choice.angles, m.feed, m.rapid, duration);
      angles = choice.angles;
      before = p;
      axis = k;
    }
    // lifted: this move rose, and nothing has cut since
    write.lifted = liftedAfter({
      lifted: write.lifted, rapid: m.rapid, rises: Boolean(before0) && point[2] > before0[2] + 1e-9,
    });
    tip = point;
    axis = a;
  };

  write.started = false;
  write.lifted = false;
  write.warnings = [];

  /**
   * End the operation: the table back at zero, the control back in its own
   * mode. The tool is at clearance and upright here — the strategy ends that
   * way — so the turntable can spin home without touching anything.
   */
  write.finish = (w, modal) => {
    if (!write.started) return;
    if (tip && letters.some((l) => Math.abs(angles[l]) > 1e-9)) {
      const zero = Object.fromEntries(letters.map((l) => [l, 0]));
      block(w, modal, {}, tip, zero, 0, true, 0);
      angles = zero;
    }
    if (none) { w.line('G94'); modal.force('F'); }
    hooks.tcpOff?.(w, modal, { mode, tool: hooks.tool?.() });
    modal.force('F');
    write.started = false;
  };

  return write;
}

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
