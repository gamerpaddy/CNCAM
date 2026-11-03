// What the post needs to know to write a 5-axis operation, as plain data.
//
// The post is ignorant of setups and machines on purpose (it runs in a worker,
// and it is the same engine for every dialect), so the facts it needs are
// attached to the operation it is about to write — the way an indexed setup's
// orientation is (engine/indexing.js orientationFor).
//
// A program that never tilts the tool gets nothing, and posts exactly as before.
// One that does and cannot be posted gets a `refused` with the reason, and the
// post writes the reason in place of the moves rather than a program that looks
// finished and is not.

import { fiveAxisRefusal, pivotOf } from './kinematics.js';
import { isIndexed } from '../indexing.js';

/**
 * @returns null for an ordinary program, else { rotary, tcp, pivot, machine } or
 *   { refused } — never a half answer
 */
export function fiveFor(setup, machine, cl) {
  if (!cl?.fiveAxis) return null;
  const why = refusalFor(setup, machine);
  if (why) return { refused: why };
  return {
    rotary: machine.rotary.map((a) => ({ ...a, axis: [...a.axis] })),
    tcp: machine.tcp ?? 'kins',
    pivot: pivotOf(setup.five),
    machine: machine.name ?? null,
  };
}

/** Why this setup on this machine cannot run simultaneous 5-axis, or null. */
export function refusalFor(setup, machine) {
  if (!setup?.five?.enabled) {
    return 'this setup is not set up for 5-axis — switch it on in the setup panel';
  }
  if (isIndexed(setup)) {
    return 'this setup is also indexed (3+2): the table cannot hold a tilted plane and swing under '
      + 'the cutter at once — index it or run it simultaneously, not both';
  }
  if (setup.wrap) {
    return 'this setup is also wrapped round a rotary axis, which the 5-axis table is busy being';
  }
  const machineWhy = fiveAxisRefusal(machine);
  if (machineWhy) return machineWhy;
  if ((machine.tcp ?? 'kins') === 'none' && !setup.five.pivot) {
    return 'this machine has no tool-centre-point mode, so the post needs the rotary centre '
      + '— enter where the table axes cross in the setup panel';
  }
  return null;
}
