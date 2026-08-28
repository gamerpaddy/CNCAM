// The tool as a shape, in one place.
//
// A cutter was three unrelated descriptions of the same object: a `d` attribute
// for the icon, a cylinder in the simulation viewport, and a clearance function
// in the drop-cutter. They disagreed — the viewport drew a plain cylinder for
// every cutter in the rack, so a ball nose, a V bit and a face mill all looked
// identical while cutting, and neither the shank nor the holder existed at all.
// A tool that reaches 30mm down a pocket with a 40mm holder above it is a crash
// nothing on screen was in a position to show.
//
// So the shape is described once, as a silhouette: a list of sections from the
// tip upward, each a right-half profile of [radius, height above the tip].
// Mirror it and you have the 2D drawing; revolve it and you have the solid;
// evaluate it and you have the reach.
//
// Headless on purpose — no DOM, no three.js. `app/tool-shape.js` draws it and
// `view/simulation.js` revolves it.

import { isLatheTool, insertIcOf } from './insert.js';

const DEFAULT_ARC_SEGMENTS = 20;

/** Point angle for a cutter that has not been given one. */
export function tipAngleOf(tool) {
  if (tool?.tipAngle > 0 && tool.tipAngle < 180) return tool.tipAngle;
  if (tool?.type === 'drill') return 118;
  // a spot drill and a chamfer mill are the same cone, bought at the same angle
  return tool?.type === 'chamfer' || tool?.type === 'spot' ? 90 : 0;
}

/**
 * The cutting end, from the axis at the tip out and up to the top of the flutes.
 * @returns [[r, z], …] with z measured up from the tip
 */
export function cuttingPoints(tool, segments = DEFAULT_ARC_SEGMENTS) {
  const r = Math.max(0.05, (tool?.diameter ?? 6) / 2);
  const type = tool?.type ?? 'flat';
  const points = [];

  if (type === 'ball') {
    // a hemisphere of the cutter's own radius, tangent to the axis at the tip
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * (Math.PI / 2);
      points.push([r * Math.sin(a), r - r * Math.cos(a)]);
    }
  } else if (type === 'bull' && tool.cornerRadius > 0) {
    const corner = Math.min(tool.cornerRadius, r);
    const flat = r - corner;
    points.push([0, 0], [flat, 0]);
    for (let i = 1; i <= segments; i++) {
      const a = (i / segments) * (Math.PI / 2);
      points.push([flat + corner * Math.sin(a), corner - corner * Math.cos(a)]);
    }
  } else if (type === 'drill' || type === 'chamfer' || type === 'spot') {
    const angle = (tipAngleOf(tool) * Math.PI) / 180;
    const tipR = Math.min(Math.max(0, (tool.tipDiameter ?? 0) / 2), r * 0.9);
    points.push([0, 0], [tipR, 0], [r, (r - tipR) / Math.tan(angle / 2)]);
  } else if (isLatheTool(type)) {
    // A lathe tool is not a solid of revolution and this function is one. It is
    // still asked for a silhouette by the reach check and the milling
    // simulation, so it answers with the insert's own extent — but the *drawing*
    // of a lathe tool comes from engine/insert.js, which knows it is a shape in
    // a plane rather than a shape spun about an axis.
    const half = type === 'parting' || type === 'threading'
      ? Math.max(0.05, (tool.bladeWidth ?? tool.diameter ?? 3) / 2)
      : Math.max(0.05, insertIcOf(tool) / 2);
    const nose = Math.min(Math.max(0, tool.noseRadius ?? 0), half);
    points.push([0, 0]);
    for (let i = 1; i <= segments && nose > 0; i++) {
      const a = (i / segments) * (Math.PI / 2);
      points.push([nose * Math.sin(a), nose - nose * Math.cos(a)]);
    }
    points.push([half, nose]);
  } else if (type === 'tap') {
    // A tap is a cylinder of the thread's own size with the first few threads
    // ground away as a taper — the lead, which is what starts it in the hole
    // and what stops it reaching the bottom of a blind one. Drawn from the
    // pitch rather than from a guess: the lead is a count of threads, and a
    // coarse tap has a longer one than a fine tap of the same diameter.
    const pitch = Math.max(0, tool.pitch ?? 0);
    const lead = pitch * (tool.leadThreads ?? 2);
    const start = Math.max(0.05, r - pitch * 0.65);
    points.push([0, 0], [start, 0]);
    if (lead > 0) points.push([r, lead]); else points.push([r, 0]);
  } else if (type === 'threadmill' && tool.pitch > 0) {
    // A thread mill is not an end mill: the form *is* the tool. A stack of vee
    // teeth of the thread's own pitch, cut on the flank, and a cutter drawn as
    // a plain cylinder was indistinguishable from a flat end mill in the rack —
    // which is the one thing the picture is there to tell you.
    //
    // The crest is the full diameter and the root is a thread depth in from it
    // (0.54×pitch for a 60° ISO form), so the widest point is unchanged and
    // nothing downstream reads a different size than it did.
    const pitch = tool.pitch;
    const root = Math.max(0.05, r - pitch * 0.54);
    const teeth = Math.max(1, Math.min(24, Math.floor(fluteLengthOf(tool) / pitch)));
    points.push([0, 0], [root, 0]);
    for (let i = 0; i < teeth; i++) {
      points.push([r, i * pitch + pitch * 0.5], [root, (i + 1) * pitch]);
    }
  } else if (type === 'face') {
    // insert corners are chamfered; that is what a face mill's edge looks like
    const c = Math.min(r * 0.15, 2);
    points.push([0, 0], [r - c, 0], [r, c]);
  } else {
    points.push([0, 0], [r, 0]);
  }

  const fluteTop = Math.max(fluteLengthOf(tool), points[points.length - 1][1] + 0.05);
  points.push([r, fluteTop]);
  return points;
}

/**
 * How far above the tip the cutter first reaches its full diameter.
 *
 * The drill point, in the one form anything downstream needs it: a hole is only
 * full size from here up, so a through hole drilled to the underside of the
 * part leaves a cone of material and a ring of burr. Zero for a flat cutter,
 * the radius for a ball, `(r − tipR)/tan(θ/2)` for a drill or a V bit — and it
 * is read off `cuttingPoints` rather than worked out again, so it cannot
 * disagree with the shape the simulator carves with.
 */
export function tipLengthOf(tool) {
  const points = cuttingPoints(tool, DEFAULT_ARC_SEGMENTS);
  let radius = 0;
  for (const [r] of points) if (r > radius) radius = r;
  for (const [r, z] of points) if (r >= radius - 1e-9) return z;
  return 0;
}

export function fluteLengthOf(tool) {
  const r = Math.max(0.05, (tool?.diameter ?? 6) / 2);
  return tool?.fluteLength > 0 ? tool.fluteLength : r * 3;
}

/** The widest the *cutting* end gets — how far from the axis it removes metal. */
export function cuttingRadiusOf(tool) {
  let max = 0;
  for (const [r] of cuttingPoints(tool, 4)) if (r > max) max = r;
  return Math.max(0.05, max);
}

// How finely the arc on a ball or a bull nose is chorded when the clearance
// profile is built. Higher than the drawing's, because a chord across a convex
// arc sits *above* it and this number decides how deep a finishing pass drops:
// 64 segments over a quarter turn leaves under a micron of error on a Ø6 ball.
const PROFILE_SEGMENTS = 64;
const PROFILE_SAMPLES = 128;

/**
 * How high the cutter's surface sits above its tip at radial distance `d`.
 *
 * The one function that says what the bottom of a cutter *does*: the
 * drop-cutter drops onto it, the simulator carves with it, and the gouge check
 * in the tests measures against it. A surface point at height h and distance d
 * has to stay under the tool, so the lowest legal tip is max(h − c(d)) over the
 * disc — note the minus, which is what lets a ball nose fall below a flat one
 * as it comes off an edge.
 *
 * Built from `cuttingPoints`, the same silhouette the icon is drawn from and
 * the 3D cutter is revolved from, rather than from a second description of the
 * same shape. The second description is where the reported bug lived: it knew
 * about balls and bull noses and answered *zero* for everything else, so a 90°
 * chamfer mill simulated as a flat cutter of its full diameter — a 10mm
 * chamfer mill touching an edge took a 10mm-wide, flat-bottomed bite out of the
 * part instead of leaving a 0.5mm chamfer. Drills flat-bottomed their holes and
 * face mills lost their corner chamfers the same way.
 *
 * Sampled into a table because this runs once per grid cell per move — tens of
 * millions of times on a real program — and a table lookup beats the square
 * roots it replaces.
 */
export function clearanceProfile(tool, samples = PROFILE_SAMPLES) {
  const { table, radius, scale } = profileTable(tool, samples);
  return (d) => {
    if (!(d > 0)) return table[0];
    if (d >= radius) return table[samples];
    const t = d * scale;
    const i = t | 0;
    return table[i] + (table[i + 1] - table[i]) * (t - i);
  };
}

/**
 * The same profile, as the table it is rather than as a function over it.
 *
 * The simulator's sweep reads this millions of times per program and needs more
 * of it than one height: the radius it stops at, and the height at that radius,
 * which is what the tool's own edge is doing at the two moments a cell enters
 * and leaves the cut. Handing back the closure and asking for those separately
 * meant working the same silhouette out twice, and the two could differ — which
 * is the bug this file exists to prevent. So there is one builder, and
 * `clearanceProfile` is a reader over it.
 *
 * `slope` is how fast the flank rises there — the derivative of the same
 * piecewise-linear table, so the two describe one shape and not two. The sweep
 * needs it to find where a tool riding down a ramp stops going down: that is
 * where the flank's rise cancels the path's fall, and which point that is
 * depends on how steep the flank is. Guessing it costs a millimetre on a V bit.
 *
 * @returns { table, slope, radius, samples, scale, edge, flat } — `edge` is the
 *   surface height at the full cutting radius, `scale` converts a distance to a
 *   table index, and `flat` marks a cutter with no flank at all.
 */
export function profileTable(tool, samples = PROFILE_SAMPLES) {
  const points = cuttingPoints(tool, PROFILE_SEGMENTS);
  let radius = 0;
  for (const [r] of points) if (r > radius) radius = r;
  radius = Math.max(1e-4, radius);

  const table = new Float64Array(samples + 1);
  for (let i = 0; i <= samples; i++) {
    table[i] = surfaceHeightAt(points, (radius * i) / samples);
  }
  const scale = samples / radius;
  const slope = new Float64Array(samples);
  for (let i = 0; i < samples; i++) slope[i] = (table[i + 1] - table[i]) * scale;
  return {
    table, slope, radius, samples, scale,
    edge: table[samples],
    // A square-ended cutter is a plane: it reaches the same depth everywhere
    // under itself, so there is no flank for a ramp to slide along and nothing
    // between the two ends of a cut worth looking at.
    flat: table[samples] === table[0],
  };
}

/**
 * The lowest point of a right-half silhouette at radius `d`.
 *
 * The lowest, not any: a silhouette doubles back on itself wherever the tool
 * steps out to a larger diameter, and the half that matters for clearance is
 * the underside — the part that meets the work first.
 */
function surfaceHeightAt(points, d) {
  let lowest = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [r0, z0] = points[i - 1];
    const [r1, z1] = points[i];
    const lo = Math.min(r0, r1);
    const hi = Math.max(r0, r1);
    if (d < lo - 1e-9 || d > hi + 1e-9) continue;
    // a vertical step spans no radius; its lowest point is where it starts
    const z = hi - lo < 1e-9
      ? Math.min(z0, z1)
      : z0 + ((z1 - z0) * (d - r0)) / (r1 - r0);
    if (z < lowest) lowest = z;
  }
  return Number.isFinite(lowest) ? lowest : 0;
}

/**
 * A lathe tool's usable reach: how far into a hole, or along a bar, it goes.
 *
 * Flute length is meaningless on an insert — the cutting edge is a corner, and
 * what limits the cut is the bar behind it. `maxDepth` is that number.
 */
export function latheReachOf(tool) {
  if (tool?.maxDepth > 0) return tool.maxDepth;
  return tool?.type === 'boring' ? Math.max(20, (tool.diameter ?? 12) * 4) : Infinity;
}

/**
 * The whole assembly, tip upward.
 *
 * @returns [{ kind: 'cutting' | 'shank' | 'holder', points }] — sections in
 *   order, each starting where the one below it ended, so the silhouette is
 *   continuous even where the diameter steps.
 */
export function toolSections(tool, { arcSegments = DEFAULT_ARC_SEGMENTS } = {}) {
  const sections = [{ kind: 'cutting', points: cuttingPoints(tool, arcSegments) }];
  let [lastR, lastZ] = sections[0].points[sections[0].points.length - 1];

  for (const kind of ['shank', 'holder']) {
    const stack = normalizeStack(tool?.[kind], kind, tool);
    if (stack.length === 0) continue;
    const points = [[lastR, lastZ]];
    for (const { diameter, length } of stack) {
      const r = Math.max(0.05, diameter / 2);
      points.push([r, lastZ]);              // step across to the new diameter
      lastZ += Math.max(0.1, length);
      points.push([r, lastZ]);
      lastR = r;
    }
    sections.push({ kind, points });
  }
  return sections;
}

/**
 * A stack the tool may not have. An old project, or a hand-built tool, has no
 * shank and no holder — and a cutter that stops at the top of its flutes cannot
 * foul anything, which is the one answer that is certainly wrong.
 */
function normalizeStack(stack, kind, tool) {
  if (Array.isArray(stack) && stack.length > 0) {
    return stack.filter((s) => s && s.diameter > 0 && s.length > 0);
  }
  // A lathe tool has no collet shank and no spindle holder to invent. Inventing
  // them is what made a CNMG look like a 40mm face mill in every preview in the
  // app, and made the reach check answer a question nobody asked.
  if (isLatheTool(tool?.type)) return [];
  const d = Math.max(1, tool?.diameter ?? 6);
  return kind === 'shank'
    ? [{ diameter: d, length: Math.max(20, d * 4) }]
    : [{ diameter: Math.max(25, d * 3), length: 45 }];
}

/** Tip to the top of the holder. */
export function toolLength(tool) {
  const sections = toolSections(tool);
  const last = sections[sections.length - 1].points;
  return last[last.length - 1][1];
}

/** The widest the assembly gets, anywhere. */
export function toolMaxRadius(tool) {
  let max = 0;
  for (const { points } of toolSections(tool)) {
    for (const [r] of points) if (r > max) max = r;
  }
  return max;
}

/**
 * How wide the tool is at height `z` above the tip.
 *
 * What a reach check needs: at the depth a pass reaches, is the part of the
 * tool level with the top of the wall still narrow enough to be in the slot it
 * cut? Above the flutes the answer is the shank, and above that the holder.
 */
export function radiusAt(tool, z) {
  if (!(z >= 0)) return 0;
  let widest = 0;
  for (const { points } of toolSections(tool)) {
    for (let i = 1; i < points.length; i++) {
      const [r0, z0] = points[i - 1];
      const [r1, z1] = points[i];
      if (z < Math.min(z0, z1) - 1e-9 || z > Math.max(z0, z1) + 1e-9) continue;
      // a vertical step spans no height; take the wider of its two radii
      const r = Math.abs(z1 - z0) < 1e-9
        ? Math.max(r0, r1)
        : r0 + ((r1 - r0) * (z - z0)) / (z1 - z0);
      if (r > widest) widest = r;
    }
  }
  return widest;
}

/**
 * Can this tool reach `depth` below the surface without the shank or the holder
 * fouling the wall of the cut?
 *
 * The cut is only as wide as the cutter, so anything above the flutes that is
 * wider than the cutter has to stay above the surface. Answered here rather
 * than in the UI because it is geometry, and because the simulator and the
 * preflight check should not disagree about it.
 *
 * @returns { ok, maxDepth, foulingAt, foulingRadius, kind }
 */
export function reachCheck(tool, depth) {
  const cutterR = Math.max(0.05, (tool?.diameter ?? 6) / 2);
  let maxDepth = Infinity;
  let foul = null;
  let z = 0;

  for (const { kind, points } of toolSections(tool)) {
    for (let i = 1; i < points.length; i++) {
      const [r0, z0] = points[i - 1];
      const [r1, z1] = points[i];
      z = Math.max(z, Math.max(z0, z1));
      const widest = Math.max(r0, r1);
      if (kind === 'cutting' || widest <= cutterR + 1e-6) continue;
      // the first thing above the flutes that is wider than the slot
      const at = Math.min(z0, z1);
      if (at < maxDepth) {
        maxDepth = at;
        foul = { foulingAt: at, foulingRadius: widest, kind };
      }
    }
  }
  if (maxDepth === Infinity) maxDepth = z;
  return { ok: depth <= maxDepth + 1e-6, maxDepth, ...(foul ?? { kind: null }) };
}
