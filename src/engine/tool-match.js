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
]);

/** Families that would actively break a strategy rather than merely suit it badly. */
const NOT_TURNING = new Set(['parting', 'threading', 'boring']);

const UNUSABLE = {
  chamfer: (t) => !(t.tipAngle > 0),
  slot: (t) => t.type === 'drill' || t.type === 'chamfer',
  bore: (t) => t.type === 'drill',
  drill: (t) => t.type !== 'drill',
  turnFace: (t) => NOT_TURNING.has(t.type),
  turnRough: (t) => NOT_TURNING.has(t.type),
  turnFinish: (t) => NOT_TURNING.has(t.type),
  // a groove is cut by something with parallel sides, not by a pointed insert
  turnGroove: (t) => t.type !== 'parting',
  turnThread: (t) => t.type !== 'threading' && t.type !== 'parting',
  turnDrill: (t) => t.type !== 'drill',
  // a boring bar or, at a push, a small turning insert on a bar — never a
  // blade, which cannot travel along a bore at all
  turnBore: (t) => t.type !== 'boring' && t.type !== 'turning',
};

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
  return tools.filter((t) => t.type === 'drill' || isLatheTool(t.type) === turning);
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
