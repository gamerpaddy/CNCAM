// What a picked region means for an operation.
//
// A region is a place on the part; what gets restricted is where the *tool* may
// be, so every list is moved by a tool number before it is used (see
// engine/regions.js). Which number that is depends on the strategy, and for
// almost all of them it is the same one: an end mill takes material off out to
// its full radius, so a keep-out grows by the radius and a "machine only here"
// erodes by it.
//
// A chamfer is the exception, and it is not a small one. Its cutter is a cone:
// a ⌀12 chamfer mill cutting a 0.5mm edge break takes metal off within a
// millimetre of its axis and is in clear air the rest of the way out. Growing a
// keep-out by six millimetres because the tool is twelve wide reserves a disc
// the cut never enters — which is a hole picked to be left alone taking a bite
// out of a chamfer five millimetres away from it. And its path runs *outside*
// what was picked rather than over it, so the include list has to grow to
// contain that path instead of eroding away from it.
//
// Both facts belong to the strategy, so they are asked of it rather than
// restated here; this is the one place that knows which strategy to ask.

import { chamferRegionReach } from './strategies/chamfer.js';

/**
 * @param op the operation — its `type` and `params`
 * @param tool the tool assigned to it
 * @returns { cutRadius, includeGrow }
 *   cutRadius   — how far from its axis this operation removes material, which
 *                 is what a keep-out has to be grown by
 *   includeGrow — how the "machine only here" list moves: negative eroded, for
 *                 a pass that runs over the picked face; positive grown, for
 *                 one that stands off its edge
 */
export function regionReachFor(op, tool) {
  const radius = Math.max(0, (tool?.diameter ?? 0) / 2);
  if (op?.type === 'chamfer') {
    const { cutRadius, includeGrow } = chamferRegionReach(tool, op.params ?? {});
    return { cutRadius, includeGrow };
  }
  return { cutRadius: radius, includeGrow: -radius };
}
