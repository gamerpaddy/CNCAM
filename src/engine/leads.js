// Lead-in / lead-out and cut direction.
//
// Dropping the cutter straight onto the finished wall leaves a witness mark
// where it dwells for one revolution. A lead brings it in tangentially from
// clear air so the tool is already at full feed when it meets the wall, and
// takes it back out the same way. Arc leads are approximated as polylines here
// because CL data is linear-only for now; the post sees ordinary moves.

import { FEED } from './cl.js';
import { loopArea } from '../geom/clipper.js';

const LEAD_SEGMENTS = 8;

/**
 * Orient a loop for the requested cut direction.
 *
 * Climb milling wants the material on the tool's right, which for an outer
 * boundary (CCW, positive area) means running it clockwise. Holes invert:
 * their material sits outside, so the sense flips.
 *
 * 'both' leaves the loop exactly as it arrived. It is the answer for a roughing
 * pass where the finish does not matter and the shortest path does: a strategy
 * that may cut either way round can take a pass from whichever end it is
 * already near, instead of crossing the part to start it from the right one.
 *
 * @param loop flat [x0,y0,...]
 * @param direction 'climb' | 'conventional' | 'both'
 * @param isHole whether this loop bounds material from the inside
 */
export function orientLoop(loop, direction = 'climb', isHole = false) {
  if (direction === 'both') return loop;
  const ccw = loopArea(loop) > 0;
  let wantCcw = direction === 'conventional';
  if (isHole) wantCcw = !wantCcw;
  return ccw === wantCcw ? loop : reversed(loop);
}

function reversed(loop) {
  const n = loop.length / 2;
  const out = new Array(loop.length);
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i;
    out[i * 2] = loop[j * 2];
    out[i * 2 + 1] = loop[j * 2 + 1];
  }
  return out;
}

/**
 * Unit tangent entering loop point 0, and the normal pointing into clear air.
 *
 * `materialOutside` is the same question `orientLoop` asks as `isHole`, and for
 * the same reason: a tool-centre loop says nothing on its own about which of its
 * two sides is metal. Round the outside of a part the material is what the loop
 * encloses, so air is outward. Inside a pocket or a bore it is the other way
 * round — the loop encloses the space being emptied and the metal is outside it,
 * so a lead that swings "out" swings straight into the wall it was supposed to
 * approach cleanly. Measured on a 24×24 pocket with a ⌀12 cutter, the arc lead
 * put the cutter 2mm past the finished wall before the pass had started.
 */
function frameAtStart(loop, materialOutside = false) {
  const n = loop.length / 2;
  const p0 = [loop[0], loop[1]];
  const p1 = [loop[2], loop[3]];
  let tx = p1[0] - p0[0];
  let ty = p1[1] - p0[1];
  const len = Math.hypot(tx, ty) || 1;
  tx /= len; ty /= len;
  // (ty, -tx) points out of the region the loop encloses, whichever way round
  // the loop runs; `materialOutside` says whether that is the airy side
  const sign = (loopArea(loop) > 0 ? 1 : -1) * (materialOutside ? -1 : 1);
  return { p0, t: [tx, ty], nOut: [ty * sign, -tx * sign], n };
}

/**
 * Points approaching loop[0] from clear air.
 * @returns array of [x, y], first point furthest out; empty when type is 'none'
 */
export function leadInPoints(loop, { type = 'none', radius = 0, materialOutside = false } = {}) {
  if (type === 'none' || !(radius > 0) || loop.length < 6) return [];
  const { p0, t, nOut } = frameAtStart(loop, materialOutside);

  if (type === 'tangent') {
    return [[p0[0] - t[0] * radius, p0[1] - t[1] * radius]];
  }

  // quarter-circle arc tangent to the path at p0, curving out into clear air
  const c = [p0[0] + nOut[0] * radius, p0[1] + nOut[1] * radius];
  const pts = [];
  for (let i = LEAD_SEGMENTS; i >= 0; i--) {   // i = 0 lands exactly on p0
    const a = (i / LEAD_SEGMENTS) * (Math.PI / 2);
    // rotate (p0 - c) backwards around c by angle a
    const vx = p0[0] - c[0], vy = p0[1] - c[1];
    const ca = Math.cos(-a), sa = Math.sin(-a);
    pts.push([c[0] + vx * ca - vy * sa, c[1] + vx * sa + vy * ca]);
  }
  return pts;
}

/**
 * Where an internal pass should start, and how big its lead may be.
 *
 * An arc lead does not only curve to one side: it reaches back along the
 * reversed tangent by its own radius as well, because that is where a
 * quarter-circle tangent at the entry point begins. Outside a part that is
 * empty air. Inside a pocket it is the wall the tool is about to leave — and if
 * the pass starts on a corner, as it does when the loop is a rectangle and
 * nothing moved its start point, "back along the tangent" is straight through
 * the adjacent wall. Measured on a 24×24 pocket with a ⌀12 cutter and a 2mm
 * lead: 2.00mm past finished size, before the pass had cut anything.
 *
 * So an internal pass enters at the middle of the longest straight it has, and
 * the lead is capped at half that straight. The arc then reaches back along a
 * wall the tool is following anyway, and curls inward over floor that the inner
 * rings have already cleared.
 *
 * @returns { index, mid, radius } — the segment to enter on, its midpoint, and
 *   the radius that fits there; null when no lead is being used
 */
export function internalLeadStart(loop, { type = 'none', radius = 0 } = {}) {
  if (type === 'none' || !(radius > 0) || loop.length < 6) return null;
  // Already broken mid-straight by an earlier call — the point the loop starts
  // on lies on the line through its neighbours. Re-breaking it would move the
  // entry every time it was asked, and waterline asks twice: once to plan the
  // link to this pass and once to cut it.
  if (startsMidStraight(loop)) return null;
  const n = loop.length / 2;
  let index = 0;
  let best = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const len = Math.hypot(loop[j * 2] - loop[i * 2], loop[j * 2 + 1] - loop[i * 2 + 1]);
    if (len > best) { best = len; index = i; }
  }
  const j = (index + 1) % n;
  return {
    index,
    mid: [(loop[index * 2] + loop[j * 2]) / 2, (loop[index * 2 + 1] + loop[j * 2 + 1]) / 2],
  };
}

function startsMidStraight(loop, eps = 1e-6) {
  const n = loop.length / 2;
  const ax = loop[(n - 1) * 2];
  const ay = loop[(n - 1) * 2 + 1];
  const cx = loop[2];
  const cy = loop[3];
  const cross = (loop[0] - ax) * (cy - ay) - (loop[1] - ay) * (cx - ax);
  return Math.abs(cross) < eps * Math.max(1, Math.hypot(cx - ax, cy - ay));
}

/**
 * The lead this loop can actually take, capped to the straight it reaches back
 * along.
 *
 * An arc lead reaches back by its own radius from the entry point. Outside a
 * part that is air; inside a pocket it has to stay on the wall the tool is
 * following, so it may not be longer than the run of that wall behind the
 * entry — which, on a loop `orderLoopForEntry` has broken mid-straight, is
 * exactly half the longest wall.
 */
export function leadOnLoop(loop, lead) {
  if (!lead?.materialOutside || !(lead.radius > 0) || loop.length < 6) return lead;
  const n = loop.length / 2;
  const behind = Math.hypot(loop[0] - loop[(n - 1) * 2], loop[1] - loop[(n - 1) * 2 + 1]);
  return behind < lead.radius ? { ...lead, radius: behind } : lead;
}

/** Re-break a closed loop so it starts at `mid`, a point on segment `index`. */
export function startOnSegment(loop, index, mid) {
  const n = loop.length / 2;
  const out = [mid[0], mid[1]];
  for (let i = 1; i <= n; i++) {
    const k = (index + i) % n;
    out.push(loop[k * 2], loop[k * 2 + 1]);
  }
  return out;
}

/**
 * Mirror of leadInPoints, leaving the loop where the pass finishes.
 *
 * Which is loop[0], not loop[n-1]: a closed pass walks the perimeter and comes
 * back round to the point it started from. Taking the exit frame from plain
 * `reversed(loop)` — whose first point is loop[n-1] — put the first lead-out
 * move a whole segment behind the tool, so the pass ended by cutting its last
 * edge a second time, backwards, along a wall it had just finished. Measured on
 * a 24×24 pocket: a 12mm backtrack at lead feed before the arc.
 */
export function leadOutPoints(loop, options) {
  if (loop.length < 6) return [];
  const pts = leadInPoints(reversedFromStart(loop), options);
  return pts.slice().reverse();
}

/** The same cycle walked backwards from loop[0]: [p0, p(n-1), … p1]. */
function reversedFromStart(loop) {
  const n = loop.length / 2;
  const out = [loop[0], loop[1]];
  for (let i = n - 1; i >= 1; i--) out.push(loop[i * 2], loop[i * 2 + 1]);
  return out;
}

/** Emit a lead-in polyline at cutting depth, ending on the loop start. */
export function emitLeadIn(cl, loop, z, options) {
  const pts = leadInPoints(loop, options);
  for (const [x, y] of pts) cl.cut(x, y, z, FEED.LEAD);
  return pts.length > 0;
}

/** Emit a lead-out polyline at cutting depth, starting from the loop end. */
export function emitLeadOut(cl, loop, z, options) {
  const pts = leadOutPoints(loop, options);
  for (const [x, y] of pts) cl.cut(x, y, z, FEED.LEAD);
  return pts.length > 0;
}
