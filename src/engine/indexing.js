// Indexed multi-axis milling: 3+1 and 3+2.
//
// A 3-axis mill cuts along one tool axis — straight down +Z — so the only way
// to reach a face that does not point up is to take the part out of the vice
// and put it back a different way round. Every extra fixturing is a datum to
// re-establish, an hour of setup, and a chance to get it wrong.
//
// A machine with rotary axes reaches those faces without the operator: the
// table (or the head) swings the part to a fixed orientation, *locks*, and then
// an ordinary 3-axis program runs in that tilted frame. One rotary axis is
// "3+1", two is "3+2". The "+n" is indexed — the rotaries hold still while the
// three linear axes cut — which is the difference between this and simultaneous
// five-axis, where all five move at once.
//
// The whole point of the CL format's per-move tool-axis vector (see cl.js) is
// that a tilted operation is an ordinary one computed in a rotated frame. So
// this module owns only the *orientation*: given how the work plane is turned
// (the setup's `rotationDeg`, the same rotation engine/setup.js already applies
// to the mesh), it answers
//
//   * which way the spindle points, in the part's own frame (toolAxis);
//   * what the rotary axes must be set to, and whether this machine can reach it
//     at all (solveRotary — a one-axis machine cannot tip a face sideways);
//   * how to describe the tilt to a post as a tilted work plane (eulerFor).
//
// The strategies never see any of it: they run on the rotated mesh exactly as
// they do for a plain setup, and the post wraps their output in the orientation
// this module computes. One description of the tilt, in one place — because two
// descriptions of the same geometry is where this codebase's bugs come from.

import { rotationMatrix, eulerFromMatrix, transposeMatrix } from './setup.js';

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** Is this setup reached by rotary indexing rather than by re-fixturing? */
export function isIndexed(setup) {
  return !!setup?.index?.enabled;
}

/**
 * The direction the spindle points for an indexed orientation, in the part's
 * own (model) frame — a unit vector.
 *
 * engine/setup.js rotates the model by `rotationMatrix(rotationDeg)` so the face
 * to be machined points up (+Z) and the ordinary top-down strategies can cut it.
 * The tool axis is therefore +Z *in that rotated frame*; expressed back in the
 * part frame it is `Rᵀ·[0,0,1]`, which for a pure rotation is the matrix's third
 * row. For a plain setup (`rotationDeg` all zero) this is [0,0,1], exactly as a
 * 3-axis program has always implied.
 */
export function toolAxis(rotationDeg = [0, 0, 0]) {
  const m = rotationMatrix(rotationDeg);
  return normalize([m[6], m[7], m[8]]);
}

/** The tilt of an orientation away from straight-up, in degrees (0…180). */
export function tiltAngle(rotationDeg = [0, 0, 0]) {
  return Math.acos(clamp(toolAxis(rotationDeg)[2], -1, 1)) * DEG;
}

/**
 * How many rotary axes a machine has, and so what kind of indexing it can do.
 *
 * Zero is a plain 3-axis mill: it can only machine the face that is already up.
 * One is 3+1 — a single tilt or a single turn, but not both, so a face has to
 * lie on the axis it swings about. Two is 3+2 and can reach any face.
 */
export function rotaryAxes(machine) {
  return Array.isArray(machine?.rotary) ? machine.rotary : [];
}

export function indexKind(machine) {
  const n = rotaryAxes(machine).length;
  return n >= 2 ? '3+2' : n === 1 ? '3+1' : '3-axis';
}

/**
 * The rotary positions that bring an orientation under the spindle, and whether
 * this machine can reach it.
 *
 * The rotary axes turn the *part* (a trunnion table is the common case): a point
 * on the model at `p` ends up at `R_table · p` in front of a spindle that still
 * points straight down. So "reach this face" means: find the axis angles whose
 * combined rotation `R_table` lays the face normal — the tool axis in the part
 * frame — onto +Z, i.e. `R_table · k = [0,0,1]`.
 *
 * Solved in closed form for the two families a real machine has:
 *   • one tilt axis (A about X, or B about Y) — a 4th-axis mill. It can only
 *     reach a face whose normal already lies in the plane it swings through, so
 *     a normal with a component *along* the tilt axis is refused rather than
 *     approximated.
 *   • a tilt axis plus a turntable about Z (A+C or B+C) — a trunnion. The Z turn
 *     spins the normal into the tilt plane first, so every face is reachable.
 *
 * The answer is checked by rebuilding `R_table` from the solved angles and
 * confirming it really does carry `k` to +Z (see `applyRotary`): a sign error in
 * the algebra becomes a failed reach, not a wrong G-code line.
 *
 * @returns { reachable, angles: {A?,B?,C?}, tilt, reason?, overTravel? }
 */
export function solveRotary(rotationDeg, machine) {
  const axes = rotaryAxes(machine);
  const k = toolAxis(rotationDeg);
  const tilt = Math.acos(clamp(k[2], -1, 1)) * DEG;
  const nearZero = (v) => Math.abs(v) < 1e-6;

  // Already pointing up: nothing to swing, and every machine can do it.
  if (nearZero(k[0]) && nearZero(k[1]) && k[2] > 0) {
    return finishSolve(zeroAngles(axes), axes, k, tilt);
  }

  if (axes.length === 0) {
    return {
      reachable: false, angles: {}, tilt,
      reason: 'this is a 3-axis machine — it can only cut the face that points up',
    };
  }

  const letters = axes.map((a) => a.letter);
  const tiltAxis = axes.find((a) => !isZAxis(a));
  const turnAxis = axes.find((a) => isZAxis(a));

  let angles = null;
  if (axes.length === 1 && tiltAxis) {
    angles = solveSingleTilt(k, tiltAxis);
  } else if (tiltAxis && turnAxis) {
    angles = solveTiltAndTurn(k, tiltAxis, turnAxis);
  } else if (axes.length === 2 && !turnAxis) {
    angles = solveTwoTilts(k, axes);
  } else if (axes.length === 1 && turnAxis) {
    // a lone turntable about Z spins a face round but never tips it up
    return {
      reachable: false, angles: { [turnAxis.letter]: 0 }, tilt,
      reason: `${turnAxis.letter} turns about Z and cannot tilt this ${tilt.toFixed(1)}° face upright`,
    };
  }

  if (!angles) {
    return {
      reachable: false, angles: {}, tilt,
      reason: `${letters.join('+') || 'no'} rotary axes cannot orient this face`,
    };
  }
  return finishSolve(angles, axes, k, tilt);
}

/**
 * Turn a solved set of angles into the answer, once the geometry is known to
 * work: confirm the reach numerically, fold in the axes that did not move, and
 * check the travel limits the machine record carries.
 */
function finishSolve(angles, axes, k, tilt) {
  const full = { ...zeroAngles(axes), ...angles };
  const landed = applyRotary(axes, full, k);
  const reached = Math.hypot(landed[0], landed[1], landed[2] - 1) < 1e-6;
  if (!reached) {
    return {
      reachable: false, angles: full, tilt,
      reason: `${axes.map((a) => a.letter).join('+')} cannot orient this face`,
    };
  }
  const over = axes.filter((a) => outsideLimits(a, full[a.letter]));
  return {
    reachable: over.length === 0,
    angles: full,
    tilt,
    overTravel: over.length ? over.map((a) => a.letter) : undefined,
    reason: over.length
      ? `${over.map((a) => `${a.letter}${round(full[a.letter])}°`).join(', ')} `
        + 'is past the axis travel'
      : undefined,
  };
}

/** One tilt axis (about X or Y): a face off that axis's plane is out of reach. */
function solveSingleTilt(k, axis) {
  if (aboutX(axis)) {
    if (Math.abs(k[0]) > 1e-6) return null;           // tips only in the Y-Z plane
    return { [axis.letter]: wrap(Math.atan2(k[1], k[2]) * DEG) };
  }
  // about Y
  if (Math.abs(k[1]) > 1e-6) return null;             // tips only in the X-Z plane
  return { [axis.letter]: wrap(Math.atan2(-k[0], k[2]) * DEG) };
}

/**
 * Two tilt axes and no turntable — an A/B head.
 *
 * The commonest 3+2 machines pair a tilt with a turntable about Z, and that was
 * the only pair with a solution here: an A+B machine was told, of every face on
 * every part, that its "A+B rotary axes cannot orient this face". Two
 * perpendicular tilts span the sphere exactly as a tilt and a turn do, so that
 * sentence was a statement about the solver dressed up as one about the
 * geometry, and it made a whole class of machine unable to index at all.
 *
 * Which angle is which follows from the order: `applyRotary` turns the
 * innermost axis — the last in the machine's base→part list — first. So the
 * inner axis takes out the component it can reach (Y for a tilt about X, X for
 * a tilt about Y), which leaves the vector in the outer axis's own plane, and
 * the outer one stands it up. `finishSolve` then checks the arithmetic against
 * `applyRotary` rather than trusting it.
 */
function solveTwoTilts(k, axes) {
  const inner = axes[axes.length - 1];
  const outer = axes[0];
  // one about X and one about Y. Two axes about the same line, or a head
  // swivelling about something oblique, is not a pair this closed form
  // describes — and saying so is better than answering it wrongly.
  if (aboutX(inner) === aboutX(outer)) return null;
  if (!aboutX(inner) && !aboutY(inner)) return null;
  if (!aboutX(outer) && !aboutY(outer)) return null;
  if (aboutX(inner)) {
    const a = wrap(Math.atan2(k[1], k[2]) * DEG);          // Y out, about X
    const b = wrap(Math.atan2(-k[0], Math.hypot(k[1], k[2])) * DEG);
    return { [inner.letter]: a, [outer.letter]: b };
  }
  const b = wrap(Math.atan2(-k[0], k[2]) * DEG);           // X out, about Y
  const a = wrap(Math.atan2(k[1], Math.hypot(k[0], k[2])) * DEG);
  return { [inner.letter]: b, [outer.letter]: a };
}

/** A tilt axis plus a turntable about Z: the turntable makes any face reachable. */
function solveTiltAndTurn(k, tilt, turn) {
  const h = Math.hypot(k[0], k[1]);
  if (aboutX(tilt)) {
    // spin the normal onto +Y, then tip it up about X
    const c = wrap(Math.atan2(k[0], k[1]) * DEG);
    const a = wrap(Math.atan2(h, k[2]) * DEG);
    return { [turn.letter]: c, [tilt.letter]: a };
  }
  // tilt about Y: spin the normal onto the X-Z plane, then tip it up about Y.
  // The sign of the projected X component decides which way the tilt goes.
  const c = wrap(Math.atan2(-k[1], k[0]) * DEG);
  const x = k[0] * Math.cos(c * RAD) - k[1] * Math.sin(c * RAD);
  return { [turn.letter]: c, [tilt.letter]: wrap(Math.atan2(-x, k[2]) * DEG) };
}

/**
 * Where a rotary set actually lays a part-frame vector, by composing the axis
 * rotations outer-first (the machine record lists them base→part).
 *
 * This is the check on the algebra, not a second statement of it: `solveRotary`
 * asks this whether its closed form was right.
 */
export function applyRotary(axes, angles, v) {
  let out = [...v];
  // apply the innermost (part-side, last in the list) first
  for (let i = axes.length - 1; i >= 0; i--) {
    out = rotateAbout(axes[i].axis, (angles[axes[i].letter] ?? 0) * RAD, out);
  }
  return out;
}

/**
 * The work plane as XYZ Euler angles in degrees, for a post that speaks tilted
 * work planes (LinuxCNC G68.2, Fanuc G68.2) — the *inverse* of the setup's own
 * `rotationDeg`.
 *
 * It was the rotationDeg itself, and that is a turn in the wrong direction. The
 * two rotations go opposite ways because they act on opposite things. The CAM
 * turns the *part*: `rotationMatrix(rotationDeg)` carries the face to be
 * machined round until it points up, and the strategies then write ordinary
 * top-down coordinates in that turned frame. A tilted work plane turns the
 * *programmed coordinates* — G68.2 is the 3D form of G68, where `R90` puts a
 * programmed X10 Y0 at X0 Y10 — so the matrix it declares maps what the
 * strategies wrote back out to the datum. That is `R` undone, not `R` repeated.
 *
 * The contradiction was visible without leaving this module: the post writes
 * `tool axis 0 1 0` in a comment and `G68.2 … I90` on the next line, and the
 * plane those angles declare has its normal along −Y. `G53.1` stands the
 * spindle normal to the declared plane, so the swing came out 180° from the
 * face for every orientation that is not its own inverse.
 *
 * Which is why it survived: the identity, a 180° flip about X, and a pure turn
 * about Z all *are* their own inverse, and those are three of the six fixturing
 * presets — including the two anyone tries first. "On its side" is the one that
 * would have cut the far side of the part.
 *
 * Stated here so the post never has to know how the mesh was turned.
 */
export function eulerFor(rotationDeg = [0, 0, 0]) {
  return eulerFromMatrix(transposeMatrix(rotationMatrix(rotationDeg))).map(round);
}

/**
 * Everything a post needs to write an orientation, or null for a plain setup.
 *
 * Carried on each postable op so the post stays ignorant of setups and
 * machines: it either has an orientation to apply before the op's moves or it
 * does not.
 */
export function orientationFor(setup, machine) {
  if (!isIndexed(setup)) return null;
  const rotationDeg = setup.orientation?.rotationDeg ?? [0, 0, 0];
  const solved = solveRotary(rotationDeg, machine);
  return {
    rotationDeg,
    euler: eulerFor(rotationDeg),
    toolAxis: toolAxis(rotationDeg),
    tilt: solved.tilt,
    angles: solved.angles,
    reachable: solved.reachable,
    reason: solved.reason,
    kind: indexKind(machine),
    // the identity orientation is the face that is already up: no swing at all
    identity: solved.tilt < 1e-6,
  };
}

/** A stable key for an orientation, so the post restates it only when it changes. */
export function orientationKey(orientation) {
  if (!orientation) return 'plain';
  return orientation.euler.map((v) => round(v)).join(',');
}

/**
 * Warnings about an indexed program that the machine cannot actually run — the
 * same shape machineWarnings uses, so the app can show them together.
 *
 * An indexed setup on a machine with too few rotary axes, or a face past an
 * axis's travel, is a program that alarms the moment it tries to swing. Caught
 * here it is a line in the status bar instead.
 */
export function indexingWarnings(machine, setups) {
  const out = [];
  for (const setup of setups ?? []) {
    if (!isIndexed(setup)) continue;
    const o = orientationFor(setup, machine);
    if (o.identity) continue;                       // the top face needs no rotary
    if (!o.reachable) {
      out.push({
        level: 'warn',
        text: `${setup.name}: ${o.reason ?? `${o.kind} cannot reach this orientation`}`,
      });
    }
  }
  return out;
}

// --- small vector / rotation helpers -----------------------------------------

function zeroAngles(axes) {
  return Object.fromEntries(axes.map((a) => [a.letter, 0]));
}

function isZAxis(a) {
  return Math.abs(a.axis[0]) < 1e-9 && Math.abs(a.axis[1]) < 1e-9 && Math.abs(a.axis[2]) > 0;
}
function aboutX(a) {
  return Math.abs(a.axis[0]) > 0 && Math.abs(a.axis[1]) < 1e-9 && Math.abs(a.axis[2]) < 1e-9;
}
function aboutY(a) {
  return Math.abs(a.axis[1]) > 0 && Math.abs(a.axis[0]) < 1e-9 && Math.abs(a.axis[2]) < 1e-9;
}

function outsideLimits(axis, angle) {
  if (axis.min == null && axis.max == null) return false;
  if (axis.min != null && angle < axis.min - 1e-6) return true;
  if (axis.max != null && angle > axis.max + 1e-6) return true;
  return false;
}

/** Rotate v about a unit axis by θ (Rodrigues). */
function rotateAbout(axis, theta, v) {
  const a = normalize(axis);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const dot = a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
  const cross = [
    a[1] * v[2] - a[2] * v[1],
    a[2] * v[0] - a[0] * v[2],
    a[0] * v[1] - a[1] * v[0],
  ];
  return [
    v[0] * c + cross[0] * s + a[0] * dot * (1 - c),
    v[1] * c + cross[1] * s + a[1] * dot * (1 - c),
    v[2] * c + cross[2] * s + a[2] * dot * (1 - c),
  ];
}

function normalize(v) {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 1];
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Fold an angle into (−180, 180], so a swing is written as the short way round. */
function wrap(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return Math.abs(d) < 1e-9 ? 0 : d;
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
