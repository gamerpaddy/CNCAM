// What a simultaneous 5-axis program asks of the machine it is posted for.
//
// None of this is visible in the toolpath: a path that is perfectly good for the
// part can ask the C axis to spin half a turn between two neighbouring points,
// or carry the tip round a rotary centre 400mm from where the table is, or want
// a feed the rotaries cannot follow. They are facts about the *pair* — this
// program, this machine — so they are checked here, from the CL and the machine,
// and said when the whole program is in front of you (actions/program.js).
//
// The walk is the post's own: the same angle solver, in the same order, with the
// same continuity (post/five.js), so what is flagged here is what the file will
// do. Blocks the post splits are not split here, so the rates below are the
// worst a block can ask for.

import { MOVE_STRIDE, OP, FEED, isTilted } from '../cl.js';
import {
  chooseAngles, tipToMachine, recentre, POLE_DEG,
} from './kinematics.js';
import { angleBetween } from './tilt-sweep.js';

/** A swing this big between two neighbouring cutting points is a flip, not a sweep. */
const FLIP_DEG = 90;

/** How fast the rotaries may be driven when the machine does not say, degrees a minute. */
export const DEFAULT_ROTARY_FEED = 7200;

/**
 * @param cl a finished CL program
 * @param five { rotary, tcp, pivot } — see post-data.js
 * @returns {{ findings, extent, stats }} findings are `{ level, text }` ready to
 *   hang off the operation's name; `extent` is where the machine's linear axes
 *   go (the tip carried round the rotary centre), for the travel check
 */
export function fiveChecks(cl, five) {
  const machine = { rotary: five.rotary };
  const letters = five.rotary.map((a) => a.letter);
  const limit = Math.min(...five.rotary.map((a) => a.maxFeed ?? DEFAULT_ROTARY_FEED), DEFAULT_ROTARY_FEED);
  const pivot = five.pivot ?? [0, 0, 0];
  const d = cl.moves;
  const feeds = cl.events.filter((e) => e.type === 'feeds');
  const cutFeed = feeds.length ? feeds[feeds.length - 1].cut ?? 600 : 600;

  let angles = Object.fromEntries(letters.map((l) => [l, 0]));
  let prev = null;
  let prevAxis = null;
  let unreachable = 0;
  let firstUnreachable = -1;
  let why = null;
  let flips = 0;
  let nearPole = 0;
  let cutLength = 0;
  let slowLength = 0;
  let worstDemand = 0;
  let maxTilt = 0;
  let tiltSum = 0;
  let tiltCount = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let n = 0; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    if (d[o] === OP.DRILL) continue;
    const point = [d[o + 1], d[o + 2], d[o + 3]];
    const tilted = isTilted(d[o + 4], d[o + 5]);
    const axis = tilted ? [d[o + 4], d[o + 5], d[o + 6]] : [0, 0, 1];
    const rapid = d[o] === OP.RAPID || d[o + 7] === FEED.RAPID;
    // the post unwinds the table when it swings at rapid — see post/five.js
    if (rapid && prevAxis && angleBetween(prevAxis, axis) > 1e-6) angles = recentre(angles, machine);
    prevAxis = axis;
    const choice = chooseAngles(axis, machine, angles);
    if (!choice.reachable) {
      unreachable++;
      if (firstUnreachable < 0) { firstUnreachable = n; why = choice.reason; }
    }
    const tilt = Math.acos(Math.min(1, axis[2])) * 180 / Math.PI;
    if (!rapid) {
      if (choice.nearPole && tilted) nearPole++;
      const turn = Math.max(...letters.map((l) => Math.abs(choice.angles[l] - angles[l])), 0);
      if (turn > FLIP_DEG) flips++;
      if (prev) {
        const dist = Math.hypot(point[0] - prev[0], point[1] - prev[1], point[2] - prev[2]);
        if (dist > 1e-6) {
          cutLength += dist;
          // the rate the rotaries would need to hold the programmed feed over
          // this move: degrees to turn, over the time the move takes
          const demand = (turn / dist) * cutFeed;
          if (demand > limit) slowLength += dist;
          if (demand > worstDemand) worstDemand = demand;
        }
      }
      if (tilted) { tiltSum += tilt; tiltCount++; }
      if (tilt > maxTilt) maxTilt = tilt;
    }
    const at = tipToMachine(point, choice.angles, machine, pivot);
    for (let k = 0; k < 3; k++) {
      if (at[k] < min[k]) min[k] = at[k];
      if (at[k] > max[k]) max[k] = at[k];
    }
    angles = choice.angles;
    prev = point;
  }

  const findings = [];
  if (unreachable > 0) {
    findings.push({
      level: 'warn',
      text: `the rotary axes cannot point the spindle where ${unreachable} of its moves ask `
        + `(first at move ${firstUnreachable}): ${why ?? 'past an axis limit'}`,
    });
  }
  if (flips > 0) {
    findings.push({
      level: 'warn',
      text: `a rotary axis would turn more than ${FLIP_DEG} degrees between two cutting moves at `
        + `${flips} ${flips === 1 ? 'place' : 'places'} — the spindle crosses its pole there`,
    });
  }
  if (nearPole > 0) {
    findings.push({
      level: 'info',
      text: `the spindle is within ${POLE_DEG} degree of vertical for ${nearPole} cutting `
        + `${nearPole === 1 ? 'move' : 'moves'}, where the turntable spins fastest`,
    });
  }
  if (cutLength > 0 && slowLength / cutLength > 0.05) {
    findings.push({
      level: 'info',
      text: `the rotary axes (${Math.round(limit)} deg/min) cannot keep up with the programmed feed `
        + `over ${Math.round((100 * slowLength) / cutLength)}% of the cut — the control will slow `
        + `it there (worst: ${Math.round(worstDemand)} deg/min asked)`,
    });
  }

  return {
    findings,
    extent: Number.isFinite(min[0]) ? { min, max } : null,
    stats: {
      maxTilt, meanTilt: tiltCount ? tiltSum / tiltCount : 0, unreachable, flips, nearPole,
      cutLength, slowLength, worstDemand,
    },
  };
}
