// Which cutter a new operation should arrive holding.
//
// It used to be "whichever tool is first in the list", which is right once and
// wrong for every operation after it. A chamfer born holding a flat end mill
// cannot cut at all and says so before it has been asked to do anything; a 3D
// finishing pass born holding a flat one produces a visibly stepped surface and
// says nothing. Both are the app handing the user a mistake to find.
//
// This is a preference, not a rule: the first suitable cutter in the list wins,
// and if none is suitable the first tool is still assigned so the operation is
// editable rather than blank. The point is to be right most of the time, not to
// refuse to be wrong.

import { isLatheTool } from './insert.js';
import { tipAngleOf } from './tool-geometry.js';

/**
 * Cutter families each strategy would like, best first.
 *
 * A missing entry means "anything", which is the honest answer for the 2.5D
 * strategies: a contour or a pocket is cut by whatever end mill fits the
 * corners, and that is a judgement about the part rather than the strategy.
 */
const PREFERRED = {
  face: ['face', 'flat'],
  drill: ['drill'],
  // The rest of what happens to a hole. Each of these has a cutter that is the
  // operation — a tap *is* the thread — and without them here a new tapping
  // pass arrived holding whatever end mill happened to be first in the rack,
  // which is a tool change to a cutter that cannot do the job and no warning
  // until Generate.
  spot: ['spot', 'chamfer', 'drill'],
  tap: ['tap'],
  threadMill: ['threadmill'],
  // pointed cutters: the cone is the whole mechanism
  chamfer: ['chamfer', 'drill'],
  engrave: ['chamfer', 'flat'],
  // a flat cutter leaves steps on a curved surface; a round one rides it
  parallel3d: ['ball', 'bull'],
  waterline: ['ball', 'bull'],
  // a helix inside a hole needs a cylindrical cutter, and a drill is not one
  bore: ['flat', 'bull'],
  contour2d: ['flat', 'bull'],
  pocket: ['flat', 'bull'],
  clear2d: ['flat', 'bull'],
  adaptive: ['flat', 'bull'],
  // a slot's walls are the cutter's own side, so a chamfer or a drill point
  // would leave a V rather than a channel
  slot: ['flat', 'bull'],
  // lathe work: a turning insert for the profile, a blade for parting and
  // grooving, a bar for anything inside a hole
  turnFace: ['turning'],
  turnRough: ['turning'],
  turnFinish: ['turning'],
  turnGroove: ['parting'],
  turnThread: ['threading', 'parting'],
  turnDrill: ['drill'],
  turnBore: ['boring', 'turning'],
  turnPart: ['parting', 'turning'],
};

/**
 * Strategies for which the preference list is the whole list.
 *
 * Falling back to "the first tool in the rack" is right for milling — a contour
 * is cut by whatever end mill fits — and wrong for turning, where the fallback
 * put a 40mm face mill in the turret and called it a roughing insert. Better to
 * hand back nothing and have the panel ask for a tool.
 */
const STRICT = new Set([
  'turnFace', 'turnRough', 'turnFinish', 'turnGroove', 'turnThread',
  'turnDrill', 'turnBore', 'turnPart', 'drill',
  // A thread is cut by the tool that has the thread on it and by nothing else.
  // Handing one an end mill is not a worse choice, it is a different operation.
  'tap', 'threadMill',
]);

/** Families that would actively break a strategy rather than merely suit it badly. */
const NOT_TURNING = new Set(['parting', 'threading', 'boring']);

/**
 * Cutters that only work down their own axis.
 *
 * A drill, a spot drill and a tap have no side to cut with: a slot or a helical
 * bore drives them sideways through metal, which is how a tap gets left in the
 * part. A thread mill does have a side and it is a thread form, so a slot cut
 * with one comes out threaded.
 */
const DOWN_THE_AXIS = new Set(['drill', 'spot', 'tap', 'threadmill']);

/**
 * Strategies that feed the cutter sideways through metal.
 *
 * Which is nearly all of them — a pocket drives a cutter through the work
 * exactly as a slot does, and the sentence above about the tap left in the part
 * is true of every one of these. It was written for `slot` and `bore` and
 * applied to only those two, so with a drill as the only tool in the rack a new
 * pocket, contour, adaptive or finishing pass arrived holding it: a cutter with
 * no side to cut with, on a pass that is nothing but side cutting.
 *
 * Spotting and chamfering are the two that are *not* here, and deliberately:
 * both are a point sunk into the work, which is what a drill point is for.
 */
const SIDE_CUTTING = ['face', 'contour2d', 'pocket', 'clear2d', 'adaptive',
  'engrave', 'parallel3d', 'waterline'];

const UNUSABLE = {
  // through tipAngleOf, because a drill with the angle left blank is a 118° one
  // everywhere else in the app — including in the chamfer strategy, which is
  // the thing this preference exists to agree with
  chamfer: (t) => !(tipAngleOf(t) > 0),
  // spotting is a cone sunk on centre, so anything without a point is out
  spot: (t) => !(tipAngleOf(t) > 0),
  tap: (t) => t.type !== 'tap',
  threadMill: (t) => t.type !== 'threadmill',
  slot: (t) => DOWN_THE_AXIS.has(t.type) || t.type === 'chamfer',
  bore: (t) => DOWN_THE_AXIS.has(t.type),
  drill: (t) => t.type !== 'drill',
  turnFace: (t) => NOT_TURNING.has(t.type),
  turnRough: (t) => NOT_TURNING.has(t.type),
  turnFinish: (t) => NOT_TURNING.has(t.type),
  // a groove is cut by something with parallel sides, not by a pointed insert
  turnGroove: (t) => t.type !== 'parting',
  turnThread: (t) => t.type !== 'threading' && t.type !== 'parting',
  // a lathe starts a hole with a centre drill and opens it with a drill
  turnDrill: (t) => t.type !== 'drill' && t.type !== 'spot',
  // a boring bar or, at a push, a small turning insert on a bar — never a
  // blade, which cannot travel along a bore at all
  turnBore: (t) => t.type !== 'boring' && t.type !== 'turning',
};

for (const type of SIDE_CUTTING) UNUSABLE[type] = (t) => DOWN_THE_AXIS.has(t.type);

/**
 * "This pass feeds the cutter sideways and that cutter has no side."
 *
 * The picker prefers its way past this whenever the rack holds anything else,
 * but it is a preference and it falls back — so with a drill or a tap as the
 * only cutter in the project, a new pocket or contour arrives holding one and
 * generates a complete toolpath that drives it through metal edgeways. Nothing
 * downstream refuses it: a pocket asks the tool for its diameter, and a tap has
 * one.
 *
 * @returns why this pairing cannot cut, or null when it can
 */
export function noSideToCutWith(type, tool) {
  if (!tool || !DOWN_THE_AXIS.has(tool.type)) return null;
  if (!SIDE_CUTTING.includes(type) && type !== 'slot' && type !== 'bore') return null;
  return tool.type === 'threadmill'
    ? 'The side of a thread mill is a thread form, so this pass would cut a threaded '
      + 'groove rather than a plain one. Use an end mill.'
    : `A ${tool.type === 'spot' ? 'spot drill' : tool.type} only cuts down its own axis, `
      + 'and this pass feeds it sideways through the metal. Use an end mill.';
}

/**
 * Cutters the machine running this strategy can actually hold.
 *
 * The rack is shared between the mill and the lathe, so "the first tool in the
 * list" could hand a contour pass a parting blade or a facing pass a 40mm face
 * mill in the turret. A drill belongs to both: a lathe drills on its centreline
 * from the tailstock.
 */
function heldBy(type, tools) {
  const turning = type.startsWith('turn');
  // drills and centre drills belong to both — see tool-library machineCanHold
  return tools.filter((t) => t.type === 'drill' || t.type === 'spot'
    || isLatheTool(t.type) === turning);
}

/**
 * @param type strategy id
 * @param tools the project's tools, in list order
 * @returns the tool to assign, or null when there are none
 */
export function pickToolFor(type, tools) {
  if (!tools || tools.length === 0) return null;
  const held = heldBy(type, tools);
  if (held.length === 0) return null;
  // A preference that cannot be met still falls back to whatever is in the
  // rack, so the operation is editable rather than blank — see the note at the
  // top of this file. That is why `noSideToCutWith` exists as a separate,
  // exported answer: what the picker cannot refuse, the panel has to say out
  // loud before Generate. See app/op-status.js opPreflight.
  const usable = held.filter((t) => !UNUSABLE[type]?.(t));
  const pool = usable.length ? usable : held;

  for (const family of PREFERRED[type] ?? []) {
    // biggest first within a family: a facing pass wants the wide cutter, and a
    // roughing pass wants the stiff one. Finishing overrides this below.
    const matches = pool.filter((t) => t.type === family);
    if (matches.length === 0) continue;
    // finishing and anything going down a hole want the small one; everything
    // else wants the stiff one
    const wantSmallest = type === 'engrave' || type === 'parallel3d' || type === 'waterline'
      || type === 'turnFinish' || type === 'turnBore' || type === 'turnGroove';
    return matches.sort((a, b) => (wantSmallest ? a.diameter - b.diameter : b.diameter - a.diameter))[0];
  }
  return STRICT.has(type) ? null : pool[0];
}
