// Kinematics of a table-table trunnion, for simultaneous 5-axis.
//
// Indexed work (engine/indexing.js) asks the rotary solver one question per
// face. Simultaneous work asks it at every point of a path, and adds the three
// things a single answer never needed:
//
//   * a *branch*: a tilt-and-turn pair reaches a given spindle direction two
//     ways, (A, C) and (−A, C+180°). One of them may be inside the axis limits
//     and the other not, and the two are not equally far from where the table
//     already is;
//   * *unwinding*: C = 10° and C = 370° put the part in the same place and are
//     a whole turn apart on the machine. Keeping the angle continuous is the
//     difference between a path and a path with a spin in the middle of it;
//   * the *pole*: with the tool vertical, C is arbitrary, and the fraction of a
//     degree either side of it is where the turntable spins fastest.
//
// The geometry stays where it already lives. The closed-form solve is
// indexing.js `solveAxisVector` and the rotation is its `applyRotary`; this
// module chooses among the answers, never re-derives them (see
// cncam-one-description-rule).
//
// ## The machine model
//
// The part sits on the table, the table turns about a rotary centre `c` — the
// point where the two axes cross — and the spindle stays pointing straight
// down. So a point `p` of the part (in the setup's own frame, millimetres from
// the work datum) is found by the linear axes at
//
//     c + R_table · (p − c)
//
// and the tool length never enters: that is the property of a table-table
// machine that makes it the simple one. The pivot is `setup.five.pivot`. With a
// control that does tool-centre-point itself (G43.4, or LinuxCNC's trt
// kinematics) the controller does this sum and the post writes `p`; without
// one, the post writes the result.

import { applyRotary, unapplyRotary, solveAxisVector, rotaryAxes } from '../indexing.js';

const DEG = 180 / Math.PI;

/** Closer to the pole than this (degrees of tilt), C is not to be trusted. */
export const POLE_DEG = 1;

/**
 * The trunnion a machine is, or null — and then the 5-axis beta does not apply.
 *
 * Table-table means a tilt axis (about X or Y) carrying a turntable about Z,
 * listed base → part, so the turntable is the *last* axis: it sits on the tilt
 * and the part sits on it. Anything else (a head that tilts, a tilt on top of a
 * turntable) is a different machine with different algebra, and is refused
 * rather than approximated.
 */
export function trunnionOf(machine) {
  const axes = rotaryAxes(machine);
  if (axes.length !== 2) return null;
  const [tilt, turn] = axes;
  const about = (a, i) => Math.abs(a.axis[i]) > 1 - 1e-9;
  if (!about(turn, 2)) return null;
  if (about(tilt, 0)) return { kind: 'AC', tilt, turn };
  if (about(tilt, 1)) return { kind: 'BC', tilt, turn };
  return null;
}

/** Why this machine cannot run simultaneous 5-axis, or null if it can. */
export function fiveAxisRefusal(machine) {
  if (machine?.kind === 'turn') return 'a lathe has no tilting table';
  const axes = rotaryAxes(machine);
  if (axes.length < 2) {
    return `${machine?.name ?? 'this machine'} has ${axes.length === 0 ? 'no rotary axes' : 'one rotary axis'} `
      + '— simultaneous 5-axis needs a tilt axis and a turntable (A/C or B/C)';
  }
  if (!trunnionOf(machine)) {
    return 'only a table-table trunnion — a tilt about X or Y carrying a turntable about Z, '
      + 'listed with the turntable last — is supported';
  }
  return null;
}

/**
 * Every set of rotary angles that points the spindle along `k` (a unit vector in
 * the part frame), each verified by turning the part and seeing where the
 * spindle ends up — the same check `solveAxisVector` makes of its own answer.
 *
 * At the pole there is one set (tilt 0) with a free turntable; elsewhere there
 * are two.
 */
export function axisBranches(k, machine) {
  const trunnion = trunnionOf(machine);
  if (!trunnion) return [];
  const axes = rotaryAxes(machine);
  const first = solveAxisVector(k, machine);
  const out = [];
  const consider = (angles) => {
    const landed = applyRotary(axes, angles, k);
    if (Math.hypot(landed[0], landed[1], landed[2] - 1) < 1e-6) out.push({ ...angles });
  };
  // `first.angles` is filled even when the travel check failed: the branch is
  // right, only the limits are not — and the limits are decided later, after
  // unwinding, which can bring an out-of-range value back in.
  if (first.angles && Object.keys(first.angles).length) consider(first.angles);
  const t = trunnion.tilt.letter;
  const u = trunnion.turn.letter;
  const tilt = Math.acos(Math.min(1, Math.max(-1, k[2]))) * DEG;
  if (tilt > 1e-6 && out.length) {
    consider({ [t]: -out[0][t], [u]: out[0][u] + 180 });
  }
  return out;
}

/** v + 360n nearest `target`, within [min, max] when the axis has limits. */
function unwind(value, axis, target) {
  const lo = axis.min ?? -Infinity;
  const hi = axis.max ?? Infinity;
  const centre = target ?? 0;
  let best = null;
  const base = Math.round((centre - value) / 360);
  for (let n = base - 2; n <= base + 2; n++) {
    const v = value + 360 * n;
    if (v < lo - 1e-6 || v > hi + 1e-6) continue;
    if (best === null || Math.abs(v - centre) < Math.abs(best - centre)) best = v;
  }
  if (best !== null) return { value: best, inRange: true };
  // nothing within the limits at any whole turn: the nearest turn, flagged — not
  // clamped, so the caller can see (and say) which limit it is past
  return { value: value + 360 * base, inRange: false };
}

/**
 * The rotary angles for the spindle pointing along `k`, continuous with `prev`.
 *
 * @param prev the angles of the previous point ({A, C}), or null at the start
 * @returns { angles, reachable, branch, nearPole, tilt, reason? }
 *   `reachable` is false when no branch lies inside the axis limits — `angles`
 *   is then the least-bad answer, and `reason` says which limit.
 */
export function chooseAngles(k, machine, prev = null) {
  const trunnion = trunnionOf(machine);
  const tilt = Math.acos(Math.min(1, Math.max(-1, k[2]))) * DEG;
  if (!trunnion) {
    return { angles: {}, reachable: false, branch: -1, nearPole: false, tilt, reason: fiveAxisRefusal(machine) };
  }
  const t = trunnion.tilt;
  const u = trunnion.turn;
  const nearPole = tilt < POLE_DEG;

  let branches = axisBranches(k, machine);
  if (branches.length === 0) {
    return { angles: {}, reachable: false, branch: -1, nearPole, tilt, reason: 'the spindle direction is not reachable' };
  }
  // exactly at the pole the turntable is free: hold it where it is
  if (tilt < 1e-9 && prev) branches = [{ [t.letter]: 0, [u.letter]: prev[u.letter] ?? 0 }];

  let best = null;
  branches.forEach((angles, index) => {
    const a = unwind(angles[t.letter], t, prev?.[t.letter]);
    const c = unwind(angles[u.letter], u, prev?.[u.letter]);
    const inRange = a.inRange && c.inRange;
    // distance travelled, with the turntable weighted a little under the tilt:
    // C spins freely and A is the one that runs into its stops
    const cost = prev
      ? Math.abs(a.value - (prev[t.letter] ?? 0)) + 0.5 * Math.abs(c.value - (prev[u.letter] ?? 0))
      : Math.abs(a.value) + 0.5 * Math.abs(c.value);
    const candidate = { index, inRange, cost, angles: { [t.letter]: a.value, [u.letter]: c.value } };
    if (!best || (candidate.inRange && !best.inRange)
      || (candidate.inRange === best.inRange && candidate.cost < best.cost - 1e-9)) best = candidate;
  });

  const over = [];
  for (const axis of [t, u]) {
    const v = best.angles[axis.letter];
    if ((axis.min != null && v < axis.min - 1e-6) || (axis.max != null && v > axis.max + 1e-6)) {
      over.push(`${axis.letter}${Math.round(v * 10) / 10}°`);
    }
  }
  return {
    angles: best.angles,
    reachable: best.inRange && over.length === 0,
    branch: best.index,
    nearPole,
    tilt,
    reason: best.inRange ? undefined : `${over.join(', ') || 'an axis'} is past its travel on every way round`,
  };
}

/**
 * The same pose with every rotary axis brought back within half a turn of zero.
 *
 * C = 370° and C = 10° put the part in the same place and are a whole turn apart
 * on the machine, and keeping the angles continuous (`chooseAngles`) lets them
 * drift: a path that goes round a dome a little further each row winds the
 * turntable up one turn at a time until it reaches the end of its travel, and
 * the solver has no way to go on but to flip to the other branch in the middle of
 * a cut. A program does this when it is *safe* to — at clearance, between passes,
 * with the cutter clear of the work — and this is what it turns to. An axis whose
 * equivalent angle would be outside its limits is left where it is.
 */
export function recentre(angles, machine) {
  const out = { ...angles };
  for (const axis of rotaryAxes(machine)) {
    const v = angles[axis.letter] ?? 0;
    const turned = v - 360 * Math.round(v / 360);
    const lo = axis.min ?? -Infinity;
    const hi = axis.max ?? Infinity;
    if (turned >= lo - 1e-6 && turned <= hi + 1e-6) out[axis.letter] = turned;
  }
  return out;
}

/**
 * The linear axes' position (G54 coordinates) for a tool tip at `p` in the
 * part frame with the rotaries at `angles`: c + R·(p − c).
 */
export function tipToMachine(p, angles, machine, pivot = [0, 0, 0]) {
  const axes = rotaryAxes(machine);
  const r = applyRotary(axes, angles, [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]]);
  return [pivot[0] + r[0], pivot[1] + r[1], pivot[2] + r[2]];
}

/** The inverse: the tool tip in the part frame, from linear axes and angles. */
export function machineToTip(x, angles, machine, pivot = [0, 0, 0]) {
  const axes = rotaryAxes(machine);
  const r = unapplyRotary(axes, angles, [x[0] - pivot[0], x[1] - pivot[1], x[2] - pivot[2]]);
  return [pivot[0] + r[0], pivot[1] + r[1], pivot[2] + r[2]];
}

/** Which way the spindle points in the part frame, from the rotary angles. */
export function axisFromAngles(angles, machine) {
  return unapplyRotary(rotaryAxes(machine), angles, [0, 0, 1]);
}

/**
 * The number a post writes after the axis letter. The solve is in the right-hand
 * sense about the axis vector; a machine whose positive A turns the other way
 * says so with `sign: -1` on that axis. One place applies it, and `fromWritten`
 * undoes it for reading a file back.
 */
export function toWritten(angles, machine) {
  const out = {};
  for (const axis of rotaryAxes(machine)) {
    out[axis.letter] = (angles[axis.letter] ?? 0) * signOf(axis);
  }
  return out;
}

export function fromWritten(written, machine) {
  const out = {};
  for (const axis of rotaryAxes(machine)) {
    out[axis.letter] = (written[axis.letter] ?? 0) * signOf(axis);
  }
  return out;
}

export function signOf(axis) {
  return axis?.sign === -1 ? -1 : 1;
}

/** The pivot as three numbers, from a setup's five block (the origin if unset). */
export function pivotOf(five) {
  const p = five?.pivot;
  return Array.isArray(p) && p.length === 3 && p.every(Number.isFinite) ? p : [0, 0, 0];
}
