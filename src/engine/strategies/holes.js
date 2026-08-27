// The rest of what happens to a hole: spot it, tap it, or mill the thread.
//
// Drilling was the whole of the hole story here, and a drilled hole is a hole
// nobody asked for — it is the hole a *fastener* goes in, and getting there
// takes three more operations that the app could not write. So: spot the
// centres so the drill starts where it was told, tap the ones that take a
// thread, and mill the ones that do not (which is most of them on a hobby
// machine, because thread milling needs no rigid tapping and no tapping head,
// and one cutter does every size of the same pitch).
//
// All three find their holes the same way drilling does — `findHoles` on the
// model, or the circles in a drawing — because a hole is a hole and there is no
// second opinion to be had about where they are. What differs is only what the
// tool does when it gets there.

import { CLBuilder, FEED } from '../cl.js';
import { plural, verb, allOf } from '../text.js';
import { computeBounds } from '../../geom/mesh.js';
import { applyCutting, effectiveCutting } from '../cutting.js';
import { entryGapOf } from '../heights.js';
import { regionAllowsPoint } from '../regions.js';
import { tipAngleOf } from '../tool-geometry.js';
import { findHoles } from './drill.js';

/**
 * How much smaller than the thread the hole is, as a share of the pitch.
 *
 * The tapping-drill rule every workshop uses is *nominal minus the pitch*: an
 * M6×1 goes in a 5mm hole, an M8×1.25 in a 6.8. That is about 77% thread
 * engagement, which is where the tables sit because the last 20% of the thread
 * costs most of the torque and buys almost no strength.
 */
const TAP_DRILL_FACTOR = 1;

/** The hole a thread of this size is cut in. */
export function tapDrillDiameter(nominal, pitch) {
  return nominal - pitch * TAP_DRILL_FACTOR;
}

/** And the thread a hole of this size takes. */
export function threadForHole(diameter, pitch) {
  return diameter + pitch * TAP_DRILL_FACTOR;
}

/** The holes an operation is actually allowed to work on, with the reasons. */
function holesFor(cl, {
  mesh, tool, params, regions, wantDiameter, radiusUsed, what,
}) {
  const bounds = computeBounds(mesh.positions);
  const topZ = Math.min(params.topZ, bounds.max[2]);
  const bottomZ = Math.max(params.bottomZ, bounds.min[2]);
  const matchTol = Math.max(0, params.diameterTol ?? 0.5);

  const found = findHoles(mesh, { topZ, bottomZ, bounds });
  const matched = wantDiameter > 0
    ? found.filter((h) => Math.abs(h.r * 2 - wantDiameter) <= matchTol)
    : found;

  if (matched.length === 0) {
    cl.warn(found.length === 0
      ? `no round holes found between Z${topZ.toFixed(2)} and Z${bottomZ.toFixed(2)}`
      : `no hole matches ⌀${wantDiameter.toFixed(2)}±${matchTol} — this part has `
        + `${[...new Set(found.map((h) => (h.r * 2).toFixed(2)))].join(', ')}mm holes. `
        + `${what}`);
    return { holes: [], found, topZ, bounds };
  }

  const holes = matched.filter((h) => regionAllowsPoint(regions, h.cx, h.cy, {
    radius: radiusUsed, tolerance: params.tolerance ?? 0.01,
  }));
  if (holes.length === 0) {
    cl.warn(`${allOf(matched.length, 'matching hole')} `
      + `${verb(matched.length, 'is', 'are')} under a clamp or outside the picked regions`);
  } else if (matched.length > holes.length) {
    cl.info(`${plural(matched.length - holes.length, 'hole')} skipped — under a clamp `
      + 'or outside the picked regions');
  }
  holes.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  return { holes, found, topZ, bounds };
}

/**
 * Spot drilling: a shallow cone at every hole centre.
 *
 * Two jobs in one cut, which is why it is one operation. A twist drill wanders
 * as it enters — its point is a chisel edge that has to be pushed sideways
 * until the flutes engage — and on anything but a faced, flat surface it starts
 * a millimetre from where the program put it. A spot to a diameter *wider than
 * the drill's own web and narrower than its diameter* gives the point somewhere
 * to sit. Spot to the full hole diameter instead and the same cut leaves the
 * chamfer the hole wants anyway, which is the second job.
 *
 * The depth is not typed, it is worked out: a cone of the tool's own point
 * angle, sunk until it is `spotDiameter` across at the surface. Typing a depth
 * for that is asking somebody to do trigonometry to get a chamfer, with a
 * different answer for every tool in the drawer.
 */
export function generateSpot({ mesh, tool, params, regions }) {
  const cl = new CLBuilder();
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  const angle = tipAngleOf(tool);
  if (!(angle > 0 && angle < 180)) {
    cl.warn(`${tool.name ?? 'this cutter'} has no point angle — spotting wants a spot `
      + 'drill, a centre drill or a chamfer mill, not a flat-ended cutter');
    return cl.finish();
  }

  const wanted = params.spotDiameter > 0 ? params.spotDiameter : 0;
  const { holes, topZ } = holesFor(cl, {
    mesh,
    tool,
    params,
    regions,
    // Every hole, whatever its size: spotting is not sized to the hole the way
    // drilling is, and a spot drill is deliberately bigger than most of what it
    // spots. Only a stated diameter narrows the list.
    wantDiameter: 0,
    radiusUsed: Math.max(wanted, 1) / 2,
    what: '',
  });
  if (holes.length === 0) return cl.finish();

  const half = (angle * Math.PI) / 360;
  const clearance = params.clearanceHeight;
  const retractZ = topZ + Math.max(entryGapOf(params), 0.5);
  const maxR = Math.max(0.05, tool.diameter / 2);

  cl.rapid(holes[0].cx, holes[0].cy, clearance);
  let clipped = 0;
  for (const h of holes) {
    // the cone is as wide as asked, or as wide as the hole when nothing was
    // asked — which is the chamfer case
    const across = Math.min(wanted > 0 ? wanted : h.r * 2, maxR * 2);
    if (wanted > maxR * 2) clipped++;
    const depth = (across / 2) / Math.tan(half);
    cl.drill(h.cx, h.cy, h.top - depth, { retractZ, peck: 0, dwell: params.dwell ?? 0 });
  }
  cl.info(`${plural(holes.length, 'hole')} spotted `
    + `${wanted > 0 ? `⌀${wanted}` : 'to the hole diameter'} with a ${angle}° point`);
  if (clipped > 0) {
    cl.warn(`⌀${params.spotDiameter} is wider than this ⌀${tool.diameter} cutter — `
      + `the spots are ⌀${(maxR * 2).toFixed(2)}, which is as wide as it goes`);
  }
  return cl.finish();
}

/**
 * Tapping: cut the thread with a tap, spindle synchronised to the feed.
 *
 * The whole of the difference from drilling is that a tap cannot be fed at a
 * rate of anybody's choosing. It is a screw: one turn advances it one pitch,
 * and if the Z axis and the spindle disagree by a thousandth the tap either
 * pushes itself out of the hole or snaps off in it. That is not a feed rate, it
 * is a *mode* — the control locks the axis to the spindle encoder — so it is
 * stated as one, and the post writes a rigid tapping cycle or says plainly that
 * this control cannot do it.
 *
 * The hole it looks for is the tapping drill, not the thread: an M6 tap goes
 * into a 5mm hole, and searching for 6mm holes finds every clearance hole on
 * the part and none of the ones to be tapped.
 */
export function generateTap({ mesh, tool, params, regions }) {
  const cl = new CLBuilder();
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  const pitch = params.threadPitch > 0 ? params.threadPitch : (tool.pitch ?? 0);
  if (!(pitch > 0)) {
    cl.warn(`${tool.name ?? 'this tap'} has no pitch — a tap without one is a `
      + 'drill, and the thread is the whole operation. Set it on the tool or on this pass');
    return cl.finish();
  }

  const drill = tapDrillDiameter(tool.diameter, pitch);
  const { holes, topZ } = holesFor(cl, {
    mesh,
    tool,
    params,
    regions,
    wantDiameter: drill,
    radiusUsed: tool.diameter / 2,
    what: `An M${tool.diameter}×${pitch} goes in a ⌀${drill.toFixed(2)} hole — `
      + 'drill it before tapping it.',
  });
  if (holes.length === 0) return cl.finish();

  // The feed is not a choice. One turn, one pitch: the number is the spindle
  // speed times the pitch, and a control doing rigid tapping computes it
  // itself. It is written into the CL anyway, because a post that cannot
  // synchronise falls back to long-hand and that is the only feed that has any
  // chance of working there.
  const { spindleRpm } = effectiveCutting({ params }, tool);
  const feed = spindleRpm > 0 ? spindleRpm * pitch : 0;
  if (feed > 0) cl.event('feeds', { cut: feed, plunge: feed });

  const clearance = params.clearanceHeight;
  const retractZ = topZ + Math.max(entryGapOf(params), 1);
  const perHole = (params.depthMode ?? 'bottomZ') === 'hole';
  // A tap cannot reach the bottom of a blind hole: the lead is ground away over
  // the first few threads and cuts nothing at full depth. Backing off by the
  // lead is what stops the program driving a tap into the floor of a hole,
  // which breaks taps and is the commonest way to lose one.
  const lead = pitch * (tool.leadThreads ?? 2);

  cl.tapping(pitch, params.threadHand ?? 'right');
  cl.rapid(holes[0].cx, holes[0].cy, clearance);
  let shortened = 0;
  for (const h of holes) {
    const floor = perHole ? Math.max(h.bottom, params.bottomZ) : params.bottomZ;
    const blind = h.bottom > -Infinity && h.bottom > params.bottomZ - 1e-6;
    const z = blind ? floor + lead : floor;
    if (blind && lead > 0) shortened++;
    cl.drill(h.cx, h.cy, z, { retractZ, peck: 0, dwell: 0 });
  }
  cl.tapping(0);
  cl.info(`${plural(holes.length, 'hole')} tapped M${tool.diameter}×${pitch}`
    + (feed > 0 ? ` at ${feed.toFixed(0)} mm/min — ${spindleRpm} rpm × ${pitch}mm` : ''));
  if (shortened > 0) {
    cl.info(`${plural(shortened, 'blind hole')} stopped ${lead.toFixed(2)}mm short — `
      + `the tap's ${tool.leadThreads ?? 2}-thread lead cuts nothing below that`);
  }
  return cl.finish();
}

/**
 * Thread milling: cut the thread with an end mill on a helix.
 *
 * The one that a machine without rigid tapping can actually do, which on a
 * hobby machine is most of them — there is no synchronisation to get wrong,
 * because the cutter is not a screw. One cutter does every diameter of the same
 * pitch, in either hand, internal or external, and a broken one comes out of
 * the hole instead of staying in it. The trade is that it is a great deal
 * slower and it will not reach the bottom of a deep blind hole.
 *
 * The path is a helix and it is emitted as one: fine chords that the post's arc
 * fitter refits into helical G2/G3, which is a couple of blocks per turn rather
 * than a couple of hundred. See post/arcs.js — a Z on an arc is what makes it a
 * helix, and that is already there for helical boring.
 */
export function generateThreadMill({ mesh, tool, params, regions }) {
  const cl = new CLBuilder();
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  const pitch = params.threadPitch > 0 ? params.threadPitch : (tool.pitch ?? 0);
  if (!(pitch > 0)) {
    cl.warn('a thread has a pitch — set one on the cutter or on this pass');
    return cl.finish();
  }
  const cutter = tool.diameter;
  const internal = params.threadInternal !== false;

  const { holes, topZ } = holesFor(cl, {
    mesh,
    tool,
    params,
    regions,
    // Every hole this cutter fits down, threaded to whatever size it is:
    // a thread mill is not sized to one thread the way a tap is, so asking
    // which holes are "its" size would be asking the wrong question.
    wantDiameter: params.threadDiameter > 0
      ? tapDrillDiameter(params.threadDiameter, pitch) : 0,
    radiusUsed: cutter / 2,
    what: '',
  });
  if (holes.length === 0) return cl.finish();

  const clearance = params.clearanceHeight;
  const climb = (params.direction ?? 'climb') === 'climb';
  const rightHand = (params.threadHand ?? 'right') === 'right';
  // Chords fine enough that the helix is round to the operation's own
  // tolerance, and never so coarse that the arc fitter has nothing to fit.
  const tolerance = Math.max(params.tolerance ?? 0.01, 0.001);
  // Told to the post, so the arc fitter never tries to fit these chords tighter
  // than they were written — a helix drawn to a hundredth cannot be refitted to
  // a thousandth, and asking makes the fitter give up and emit every line.
  cl.setResolution(tolerance);

  let cut = 0;
  let tooBig = 0;
  cl.rapid(holes[0].cx, holes[0].cy, clearance);
  for (const h of holes) {
    const nominal = threadForHole(h.r * 2, pitch);
    // Where the *centre* of the cutter runs: out to the major diameter for an
    // internal thread, in to it for an external one. Half the cutter either
    // way, because it is the flank of the cutter that forms the thread.
    const orbit = internal ? (nominal - cutter) / 2 : (nominal + cutter) / 2;
    if (internal && !(orbit > 0.05)) {
      tooBig++;
      continue;
    }
    const floor = Math.max(params.bottomZ, h.bottom > -Infinity ? h.bottom : params.bottomZ);
    const depth = topZ - floor;
    if (!(depth > 0)) continue;

    // Bottom up: the cutter goes down the middle of an existing hole in clear
    // air, and every turn of the helix after that is cutting into metal that
    // is still supported. Coming down instead means the first turn is taken in
    // a hole that gets thinner underneath it as the pass goes on.
    const turns = Math.max(1, Math.ceil(depth / pitch));
    const segments = Math.max(24, Math.ceil(Math.PI / Math.acos(
      Math.max(-1, 1 - tolerance / Math.max(orbit, tolerance)),
    )));
    // Which way round: an internal right-hand thread cut from the bottom up
    // climbs when the cutter goes anticlockwise, and every one of the four
    // combinations flips it.
    const anticlockwise = internal === (rightHand === climb);
    const dir = anticlockwise ? 1 : -1;

    cl.rapid(h.cx, h.cy, clearance);
    cl.rapid(h.cx, h.cy, topZ + 0.5);
    cl.cut(h.cx, h.cy, floor, FEED.PLUNGE);
    // out to the thread on a quarter-turn arc, so the cutter is never fed
    // straight into the wall
    const leadSteps = Math.max(6, Math.round(segments / 4));
    for (let i = 1; i <= leadSteps; i++) {
      const t = i / leadSteps;
      const a = dir * (Math.PI / 2) * t;
      cl.cut(h.cx + orbit * t * Math.cos(a), h.cy + orbit * t * Math.sin(a), floor, FEED.LEAD);
    }
    const start = dir * (Math.PI / 2);
    const total = segments * turns;
    for (let i = 1; i <= total; i++) {
      const a = start + dir * (i / segments) * Math.PI * 2;
      const z = floor + (depth * i) / total;
      cl.cut(h.cx + orbit * Math.cos(a), h.cy + orbit * Math.sin(a), z);
    }
    // and back to the middle before lifting, so the retract is up the hole and
    // not through the thread that has just been cut
    const end = start + dir * turns * Math.PI * 2;
    for (let i = 1; i <= leadSteps; i++) {
      const t = 1 - i / leadSteps;
      const a = end + dir * (Math.PI / 2) * (1 - t);
      cl.cut(h.cx + orbit * t * Math.cos(a), h.cy + orbit * t * Math.sin(a), topZ, FEED.LEAD);
    }
    cl.rapid(h.cx, h.cy, clearance);
    cut++;
  }

  if (cut > 0) {
    const sizes = [...new Set(holes.map((h) => threadForHole(h.r * 2, pitch).toFixed(1)))];
    cl.info(`${plural(cut, 'thread')} milled at ${pitch}mm pitch — `
      + `M${sizes.join(', M')}${internal ? '' : ' external'}`);
  }
  if (tooBig > 0) {
    cl.warn(`${plural(tooBig, 'hole')} ${verb(tooBig, 'is', 'are')} too small for a `
      + `⌀${cutter} cutter to orbit in — a thread mill has to fit down the hole with `
      + 'room to reach the wall, which means about two thirds of its diameter');
  }
  return cl.finish();
}
