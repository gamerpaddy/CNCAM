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
import { plural, pluralEs, verb, allOf } from '../text.js';
import { computeBounds } from '../../geom/mesh.js';
import { applyCutting, effectiveCutting } from '../cutting.js';
import { entryGapOf } from '../heights.js';
import { regionAllowsPoint } from '../regions.js';
import { tipAngleOf } from '../tool-geometry.js';
import { findHoles, findBosses } from './drill.js';

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

/**
 * The round features an operation is actually allowed to work on, with the
 * reasons.
 *
 * @param outward look for bosses rather than holes — external thread milling,
 *   and nothing else so far. The two are the same scan (see drill.js), and the
 *   only thing that changes here is the noun in the warnings, because "no round
 *   holes found" on a part covered in bosses is a wrong answer, not a terse one.
 */
function holesFor(cl, {
  mesh, tool, params, regions, wantDiameter, radiusUsed, what, outward = false,
}) {
  const bounds = computeBounds(mesh.positions);
  const topZ = Math.min(params.topZ, bounds.max[2]);
  const bottomZ = Math.max(params.bottomZ, bounds.min[2]);
  const matchTol = Math.max(0, params.diameterTol ?? 0.5);
  const noun = outward ? 'boss' : 'hole';
  // "boss" takes -es, which is the whole reason text.js has a second helper
  const many = (n) => (outward ? pluralEs(n, noun) : plural(n, noun));

  const found = (outward ? findBosses : findHoles)(mesh, { topZ, bottomZ, bounds });
  const matched = wantDiameter > 0
    ? found.filter((h) => Math.abs(h.r * 2 - wantDiameter) <= matchTol)
    : found;

  if (matched.length === 0) {
    cl.warn(found.length === 0
      ? `no round ${outward ? 'bosses' : 'holes'} found between `
        + `Z${topZ.toFixed(2)} and Z${bottomZ.toFixed(2)}`
      : `no ${noun} matches ⌀${wantDiameter.toFixed(2)}±${matchTol} — this part has `
        + `${[...new Set(found.map((h) => (h.r * 2).toFixed(2)))].join(', ')}mm `
        + `${outward ? 'bosses' : 'holes'}. ${what}`);
    return { holes: [], found, topZ, bounds };
  }

  const holes = matched.filter((h) => regionAllowsPoint(regions, h.cx, h.cy, {
    radius: radiusUsed, tolerance: params.tolerance ?? 0.01,
  }));
  if (holes.length === 0) {
    cl.warn(`${allOf(matched.length, `matching ${noun}`, `matching ${noun}${outward ? 'es' : 's'}`)} `
      + `${verb(matched.length, 'is', 'are')} under a clamp or outside the picked regions`);
  } else if (matched.length > holes.length) {
    cl.info(`${many(matched.length - holes.length)} skipped — under a clamp `
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
  let widest = 0;
  for (const h of holes) {
    // the cone is as wide as asked, or as wide as the hole when nothing was
    // asked — which is the chamfer case
    const across = Math.min(wanted > 0 ? wanted : h.r * 2, maxR * 2);
    // A cone cannot be wider than the cutter that cuts it, whether the width
    // was typed or taken from the hole. Counting only the typed case left the
    // other one saying "spotted to the hole diameter" on a ⌀20 hole a ⌀3 spot
    // drill had put a ⌀3 dimple in — and the chamfer that sentence promises is
    // the second reason to run the operation at all.
    if ((wanted > 0 ? wanted : h.r * 2) > maxR * 2 + 1e-9) clipped++;
    widest = Math.max(widest, across);
    const depth = (across / 2) / Math.tan(half);
    cl.drill(h.cx, h.cy, h.top - depth, { retractZ, peck: 0, dwell: params.dwell ?? 0 });
  }
  // What the cones actually came out at, not what was asked for.
  const across = clipped === holes.length
    ? `⌀${widest.toFixed(2)} with a ${angle}° point — as wide as this cutter goes`
    : `${wanted > 0 ? `⌀${wanted}` : 'to the hole diameter'} with a ${angle}° point`;
  cl.info(`${plural(holes.length, 'hole')} spotted ${across}`);
  if (clipped > 0) {
    cl.warn(`${wanted > 0 ? `⌀${params.spotDiameter} is`
      : `${plural(clipped, 'hole')} ${verb(clipped, 'is', 'are')}`} `
      + `wider than this ⌀${tool.diameter} cutter — `
      + `${clipped === holes.length ? 'the spots are' : `${clipped} of the spots are`} `
      + `⌀${(maxR * 2).toFixed(2)}, which is as wide as it goes`);
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
    // An internal thread is cut in a hole and an external one on a boss, and
    // they are not the same feature seen from two sides: run outward over the
    // *holes* and the cutter plunges down the middle of each one and then feeds
    // sideways out through the wall, which is what this did.
    outward: !internal,
    // Every feature this cutter fits, threaded to whatever size it is: a thread
    // mill is not sized to one thread the way a tap is, so asking which of them
    // are "its" size would be asking the wrong question. Narrow the list with
    // picked regions, which is the answer to "thread these and not those".
    wantDiameter: 0,
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
  let tight = 0;
  // the threads actually cut, not the ones looked at: reporting a size that was
  // skipped two lines above reads as though it had been made
  const made = new Set();
  cl.rapid(holes[0].cx, holes[0].cy, clearance);
  for (const h of holes) {
    // A hole is the *minor* diameter — the tapping drill — and the thread is
    // cut out to the major. A boss is already the major diameter: it was turned
    // to size and the thread is cut into it, so nothing is added.
    const nominal = internal ? threadForHole(h.r * 2, pitch) : h.r * 2;
    // Does the cutter go down the hole at all?
    //
    // The orbit test below is not this question and cannot stand in for it: a
    // ⌀6 cutter in a ⌀6 hole orbits (7−6)/2 = 0.5mm, which is comfortably
    // above any epsilon, and the cutter is still exactly as wide as the hole it
    // is being rapided into. That is a broken tool on the first hole, and it
    // was being emitted without a word.
    if (internal && tool.diameter >= h.r * 2 - 0.05) {
      tooBig++;
      continue;
    }
    // Where the *centre* of the cutter runs: out to the major diameter for an
    // internal thread, in to it for an external one. Half the cutter either
    // way, because it is the flank of the cutter that forms the thread.
    const orbit = internal ? (nominal - cutter) / 2 : (nominal + cutter) / 2;
    if (internal && !(orbit > 0.05)) {
      tooBig++;
      continue;
    }
    // It fits, but only just. Two thirds of the thread is the published limit
    // and it is about chips rather than geometry: past it there is nowhere for
    // them to go, and a thread mill that packs its own hole snaps in it.
    if (internal && cutter > nominal * 0.7) tight++;
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

    // Where the cutter comes down, which is the one place it can: clear air.
    // Inside a hole that is the middle of it; outside a boss the middle is
    // solid metal, so it is a cutter's width further out than the orbit.
    const entryR = internal ? 0 : orbit + cutter;
    cl.rapid(h.cx + entryR, h.cy, clearance);
    cl.rapid(h.cx + entryR, h.cy, topZ + 0.5);
    cl.cut(h.cx + entryR, h.cy, floor, FEED.PLUNGE);
    // and on to the thread on a quarter-turn arc, so the cutter is never fed
    // straight into the wall
    const leadSteps = Math.max(6, Math.round(segments / 4));
    for (let i = 1; i <= leadSteps; i++) {
      const t = i / leadSteps;
      const r = entryR + (orbit - entryR) * t;
      const a = dir * (Math.PI / 2) * t;
      cl.cut(h.cx + r * Math.cos(a), h.cy + r * Math.sin(a), floor, FEED.LEAD);
    }
    const start = dir * (Math.PI / 2);
    const total = segments * turns;
    for (let i = 1; i <= total; i++) {
      const a = start + dir * (i / segments) * Math.PI * 2;
      const z = floor + (depth * i) / total;
      cl.cut(h.cx + orbit * Math.cos(a), h.cy + orbit * Math.sin(a), z);
    }
    // and back off the thread before lifting, so the retract is up clear air
    // and not through the thread that has just been cut
    const end = start + dir * turns * Math.PI * 2;
    for (let i = 1; i <= leadSteps; i++) {
      const t = 1 - i / leadSteps;
      const r = entryR + (orbit - entryR) * t;
      const a = end + dir * (Math.PI / 2) * (1 - t);
      cl.cut(h.cx + r * Math.cos(a), h.cy + r * Math.sin(a), topZ, FEED.LEAD);
    }
    cl.rapid(h.cx + entryR, h.cy, clearance);
    made.add(nominal.toFixed(1));
    cut++;
  }

  if (cut > 0) {
    const sizes = [...made].sort((a, b) => a - b);
    cl.info(`${plural(cut, 'thread')} milled at ${pitch}mm pitch — `
      + `M${sizes.join(', M')}${internal ? '' : ' external'}`);
  }
  if (tooBig > 0) {
    cl.warn(`${plural(tooBig, 'hole')} ${verb(tooBig, 'is', 'are')} too small for a `
      + `⌀${cutter} cutter to orbit in — a thread mill has to fit down the hole with `
      + 'room to reach the wall, which means about two thirds of its diameter');
  }
  if (tight > 0) {
    cl.warn(`⌀${cutter} is more than two thirds of the thread in `
      + `${plural(tight, 'hole')} — it will cut, but the chips have nowhere to go. `
      + 'A smaller cutter is the usual answer.');
  }
  return cl.finish();
}
