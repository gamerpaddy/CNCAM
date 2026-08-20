// Turning: facing, roughing, finishing, grooving, threading, drilling, boring
// and parting off.
//
// All of them are the same shape of thing — a tool moving in the (Z, radius)
// plane — so they share a file and a set of helpers rather than pretending to be
// eight unrelated strategies.
//
// Conventions, once:
//
//   * Z runs along the bar. Larger Z is the free end, nearer the tailstock;
//     smaller Z is toward the chuck. A pass works from the free end inward,
//     which is the direction that pushes the part into the jaws rather than out
//     of them.
//   * X in CL data is a **radius**, because that is the geometry. The lathe
//     post doubles it on the way out; nothing else in the pipeline should.
//   * The point CL data names is the **centre of the insert's nose radius**,
//     exactly as a milling CL names the centre of the cutter rather than a
//     point on its edge. Every strategy here compensates for it, in Z and in X,
//     and the simulator rolls a circle of that radius along the path.
//
//     This was worth getting wrong once to learn: roughing used to compensate
//     the Z and not the X while finishing compensated both, so a program that
//     read correctly left the part a nose radius oversize on every diameter —
//     0.4mm on a typical insert, which is a scrapped part and no error message.
//
//   * `topZ` is where the cut starts and `bottomZ` where it ends, keeping the
//     same two fields (and the same "start above end" rule) the milling
//     operations use. `clearanceX` is the radius rapids travel at, which is the
//     lathe's equivalent of a clearance plane.
//
//   * **Inside and outside are opposite in every direction.** An external tool
//     retreats to a *large* radius and a boring bar to a small one; roughing
//     works inward on the outside and outward on the inside; the chuck blocks
//     the OD and leaves the bore alone when it is gripping that bore. Every
//     helper here takes the side as an argument rather than assuming external,
//     because assuming external is how a boring bar ends up retracting through
//     the wall it just cut.

import { CLBuilder, FEED, lastXY } from '../cl.js';
import { plural, pluralEs } from '../text.js';
import { applyCutting } from '../cutting.js';
import { chuckLimit } from '../fixtures.js';
import { mergeTolerance } from '../simplify.js';
import {
  turningProfile, radiusAtZ, barFromStock, offsetProfile, profilePoints, profileRange,
  boreProfile, hasBore,
} from '../lathe.js';

/** Everything the strategies share: the profile, the bar, and where safety is. */
function turningContext({ mesh, params, stock, tool, fixtures }) {
  const profile = turningProfile(mesh, { samples: 600 });
  const bar = barFromStock(stock, profile);
  const clearX = Math.max(params.clearanceX ?? 0, bar.radius + 2);
  return {
    profile,
    bar,
    clearX,
    nose: Math.max(0, tool?.noseRadius ?? 0),
    allowance: Math.max(0, params.stockToLeave ?? 0),
    zStart: params.topZ,
    zEnd: params.bottomZ,
    chuck: chuckLimit(fixtures),
  };
}

function startProgram(tool, params) {
  // Same simplifier every milling strategy uses. Turning went without one, so
  // a profile sampled finely enough to hold a tolerance was written out point
  // by point — thousands of blocks to describe a straight diameter.
  const cl = new CLBuilder().simplify(mergeTolerance(params?.tolerance ?? 0.05));
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);
  return cl;
}

/**
 * How far toward the chuck this pass may actually go.
 *
 * A turning pass whose Bottom Z is behind the jaws is not a deep cut, it is a
 * crash — and it is the easiest one in the app to set up, because the chuck is
 * drawn at one end of a bar whose Z numbers all look reasonable. So the pass is
 * stopped at the jaws and says so, rather than being generated as asked and
 * discovered at the machine.
 *
 * @param side 'external' | 'internal' — a chuck gripping a bore blocks the bore
 *   and leaves the outside clear, which is the whole point of gripping that way
 */
function limitToChuck(cl, ctx, side = 'external') {
  const { chuck } = ctx;
  if (!chuck) return ctx.zEnd;
  const blocks = side === 'internal'
    ? chuck.mode === 'inside'
    : chuck.mode !== 'inside';
  if (!blocks) return ctx.zEnd;
  if (ctx.zEnd >= chuck.z - 1e-6) return ctx.zEnd;
  cl.warn(`stopped at Z${round(chuck.z)} — ${chuck.name} is in the way `
    + `(asked for Z${round(ctx.zEnd)})`);
  return chuck.z;
}

/** Rapid to a safe radius, then to Z, in that order — never diagonally into work. */
function safeTo(cl, clearX, z) {
  const [x] = lastXY(cl);
  if (cl.count > 0 && x < clearX) cl.rapid(clearX, 0, currentZ(cl));
  cl.rapid(clearX, 0, z);
}

/** The same, inside a bore: safety is a *smaller* radius, not a larger one. */
function safeToInternal(cl, safeX, z) {
  const [x] = lastXY(cl);
  if (cl.count > 0 && x > safeX) cl.rapid(safeX, 0, currentZ(cl));
  cl.rapid(safeX, 0, z);
}

function currentZ(cl) {
  return cl.count > 0 ? cl.data[(cl.count - 1) * 8 + 3] : 0;
}

/** How far off the cut the tool stops rapiding and starts feeding. */
const RADIAL_GAP = 0.5;

/**
 * Come in to the cutting radius: rapid to just off it, then feed.
 *
 * The bit that has to be a feed is the bit that might be touching metal, and
 * that is the last half millimetre. Feeding the whole way in from the clearance
 * radius is the same motion at a fortieth of the speed, through air, and on a
 * roughing cycle it is repeated once per pass.
 *
 * @param internal a boring bar comes *out* from the axis, so its gap is on the
 *   other side
 */
function approachRadially(cl, radius, z, internal) {
  const from = internal ? radius - RADIAL_GAP : radius + RADIAL_GAP;
  if (from > 0) cl.rapid(from, 0, z);
  cl.cut(radius, 0, z, FEED.PLUNGE);
}

function round(v) { return Math.round(v * 1000) / 1000; }

function dia(radius) { return (radius * 2).toFixed(2); }

/** A recess narrower than this along the bar is a tessellation artefact. */
const RECESS_MIN_DEPTH = 0.3;

/**
 * Every place on the profile that no turning pass can reach, deepest first.
 *
 * A turning tool comes in radially and travels along the bar, so it can only
 * get to a diameter that nothing between it and the end of the bar stands in
 * front of. Where the profile dips below what it does on **both** sides, the
 * dip is enclosed: whichever end the tool comes from, a bigger diameter is in
 * the way. That is a grooving job, and no amount of roughing will change it.
 *
 * Which is a fact about the shape and not about the order the operations ran
 * in, so the roughing pass can say what it is leaving and the finishing pass
 * can say what it is being handed, from the same reading. It is the trapped
 * water of the radius profile: at each sample, the lower of the two running
 * maxima, less the radius there.
 *
 * **All** of them, because a part has as many as it has. This used to answer
 * with the deepest alone, and the test shaft has two — the ⌀24 groove, 3mm
 * behind the ⌀30 either side of it, and the ⌀17.2 thread relief, 1.4mm behind
 * the ⌀20 thread. Roughing named the groove and left 1.4mm standing on the
 * relief without a word, which is exactly the thing this reading exists to say
 * out loud.
 *
 * @param points [z, radius] along the profile, in either direction
 * @returns [{ depth, z, radius, shoulder }] — empty when nothing is enclosed
 */
export function enclosedRecesses(points) {
  const n = points.length;
  if (n < 3) return [];
  const before = new Float64Array(n);
  const after = new Float64Array(n);
  let run = -Infinity;
  for (let i = 0; i < n; i++) { run = Math.max(run, points[i][1]); before[i] = run; }
  run = -Infinity;
  for (let i = n - 1; i >= 0; i--) { run = Math.max(run, points[i][1]); after[i] = run; }
  const depthAt = (i) => Math.min(before[i], after[i]) - points[i][1];

  const out = [];
  let i = 0;
  while (i < n) {
    if (depthAt(i) <= RECESS_MIN_DEPTH) { i++; continue; }
    // one recess is one unbroken stretch of enclosed profile; two grooves with
    // a full-diameter shoulder between them are two
    let end = i;
    let deepest = 0;
    while (end < n && depthAt(end) > RECESS_MIN_DEPTH) {
      deepest = Math.max(deepest, depthAt(end));
      end++;
    }
    // The middle of the floor, not the first sample that happened to hit the
    // deepest reading. A groove's floor is flat, so every sample along it ties
    // — and which one wins then depends on which way the caller walked the
    // profile. Roughing reads the profile from the chuck end and finishing from
    // the free end, so the same groove was reported at two different Z values in
    // the same program, 3mm apart. It has one position and this is it.
    let lo = Infinity;
    let hi = -Infinity;
    let radius = 0;
    let shoulder = 0;
    for (let k = i; k < end; k++) {
      if (depthAt(k) < deepest - 1e-6) continue;
      lo = Math.min(lo, points[k][0]);
      hi = Math.max(hi, points[k][0]);
      radius = points[k][1];
      shoulder = Math.min(before[k], after[k]);
    }
    out.push({ depth: deepest, z: (lo + hi) / 2, radius, shoulder });
    i = end;
  }
  return out.sort((a, b) => b.depth - a.depth);
}

// --- facing ---

/**
 * Face the end of the bar back to `bottomZ`, in `stepdown` bites.
 *
 * Each pass sweeps from the outside of the bar in to the centre. Going the
 * other way would have the insert climbing out of the middle with a chip
 * thickness that grows as the surface speed drops to nothing, which is how you
 * break the corner off an insert.
 */
export function generateTurnFace({ mesh, tool, params, stock, fixtures }) {
  const cl = startProgram(tool, params);
  const ctx = turningContext({ mesh, params, stock, tool, fixtures });
  const { clearX, bar, nose } = ctx;
  const step = Math.max(0.05, params.stepdown ?? 1);
  const centre = Math.max(0, params.faceToRadius ?? 0);
  const zEnd = limitToChuck(cl, ctx);

  if (!(ctx.zStart > zEnd + 1e-6)) {
    cl.warn('facing has no depth — Z start is not ahead of Z end');
    return cl.finish();
  }

  const passes = [];
  for (let z = ctx.zStart - step; z > zEnd + 1e-9; z -= step) passes.push(z);
  passes.push(zEnd);

  // On a tube there is nothing to face inside the bore, and running the insert
  // in to the axis across a hole is a lot of air followed by a corner.
  const inTo = Math.max(centre, bar.innerRadius);

  for (const z of passes) {
    // the insert's nose sits a radius behind the face it is cutting
    const cutZ = z + nose;
    safeTo(cl, clearX, cutZ);
    cl.rapid(bar.radius + 0.5, 0, cutZ);
    cl.cut(bar.radius + 0.5, 0, cutZ, FEED.LEAD);
    // The nose centre stops a radius outside the pip it is meant to leave;
    // facing all the way to the axis takes the centre to zero and lets the nose
    // sweep past it, which is what facing to centre is.
    cl.cut(inTo > 0 ? inTo + nose : 0, 0, cutZ);
    cl.rapid(clearX, 0, cutZ);
  }

  cl.info(`faced ${(ctx.zStart - zEnd).toFixed(2)}mm off the end in ${pluralEs(passes.length, 'pass')}`
    + (bar.innerRadius > 0 ? `, stopping at the ⌀${dia(bar.innerRadius)} bore` : ''));
  return cl.finish();
}

// --- roughing ---

/**
 * Rough the outside down to the profile, one constant-diameter pass at a time.
 *
 * The classic OD roughing cycle, and it is classic because it is right: the
 * tool runs at a fixed radius until the part comes up to meet it, then retracts
 * and comes back at the next radius in. Every pass is a straight line at a
 * constant depth of cut, which is what an insert wants.
 */
export function generateTurnRough({ mesh, tool, params, stock, fixtures }) {
  const cl = startProgram(tool, params);
  const ctx = turningContext({ mesh, params, stock, tool, fixtures });
  const { profile, bar, clearX, allowance, nose } = ctx;
  const step = Math.max(0.05, params.stepdown ?? 1);
  const zEnd = limitToChuck(cl, ctx);

  const zHi = Math.max(ctx.zStart, zEnd);
  const zLo = Math.min(ctx.zStart, zEnd);
  // The smallest radius roughing goes to: the profile's minimum over the range,
  // plus what the finishing pass is there to take off. Walked by sample rather
  // than by accumulating Z, because a float that overshoots the last sample
  // reads as "off the end of the part" and drags the answer to zero.
  let finishR = Infinity;
  for (const [, radius] of profileRange(profile, zLo, zHi)) {
    if (radius < finishR) finishR = radius;
  }
  finishR = Math.max(0, (Number.isFinite(finishR) ? finishR : 0) + allowance);

  if (!(bar.radius > finishR + 1e-6)) {
    cl.warn(`nothing to rough — the bar is ⌀${dia(bar.radius)} and the part `
      + `reaches ⌀${dia(finishR)} here`);
    return cl.finish();
  }

  // The passes share one state object so each of them knows where the tool
  // already is and what the pass before it left behind. Without that a pass has
  // to assume the worst and retract to the clearance radius, and on a roughing
  // cycle that is the whole cycle: see the header of cutOneRoughPass.
  const state = { started: false, prev: bar.radius + nose, z: zHi + nose, r: clearX };
  let passes = 0;
  const levels = roughLevels(profile, {
    barRadius: bar.radius, finishR, step, allowance, zLo, zHi,
  });
  for (const at of levels) {
    if (cutOneRoughPass(cl, { profile, at, zHi, zLo, allowance, nose, clearX, state })) passes++;
  }
  // Home once, at the end — and out along the bar before out in radius. The
  // last pass stops *at* the shoulder that stopped it, and that shoulder stands
  // outside the tool: leaving radially from there drives the insert into it.
  if (state.started) {
    cl.rapid(state.r, 0, zHi + nose);
    cl.rapid(clearX, 0, zHi + nose);
  }

  if (passes === 0) {
    cl.warn('roughing produced no passes — check the Z range against the part');
    return cl.finish();
  }
  cl.info(`${pluralEs(passes, 'roughing pass')} from ⌀${dia(bar.radius)} to ⌀${dia(finishR)}`
    + (allowance > 0 ? `, leaving ${allowance}mm on` : ''));
  // …everywhere the tool could get to. A pass stops where the work rises to
  // meet it, so a diameter with a bigger one on both sides of it is never
  // approached, and "leaving 0.3mm on" is then true of most of the part and
  // wrong by millimetres exactly where it matters. Said here rather than left
  // for whoever reads the finished part.
  for (const recess of enclosedRecesses(profileRange(profile, zLo, zHi))) {
    if (recess.depth <= allowance + 0.1) continue;
    cl.info(`⌀${dia(recess.radius)} at Z${recess.z.toFixed(2)} is not roughed — it sits `
      + `${recess.depth.toFixed(2)}mm behind the ⌀${dia(recess.shoulder)} either side of it, `
      + 'which a turning pass cannot get past; it needs a grooving tool');
  }
  return cl.finish();
}

/** How much of the bar a plateau must run along to be worth a pass of its own. */
const SHELF_MIN_LENGTH = 1;

/**
 * The radii the roughing passes are taken at, outside in.
 *
 * Stepping down from the bar by the depth of cut is right for a plain taper and
 * blind to a shoulder. Each pass runs in from the free end and stops where the
 * part rises to meet it, so on a stepped shaft the first pass — already deeper
 * than the big diameter — stops at the shoulder, and so does every pass after
 * it. The band of stock standing on the big diameter is then never roughed at
 * all: measured on a ⌀30/⌀16 shaft in a ⌀32 bar, roughing said "leaving 0.3mm
 * on" and left 1.00mm, all of it for a finishing insert to take in one cut.
 *
 * So every plateau in the profile gets a level of its own, at the radius the
 * finishing pass will want to find there. Extra levels can only make passes
 * shallower — the ones either side are unmoved — so nothing here cuts deeper
 * than the stepdown.
 *
 * A plateau near a level the ladder already has is the case worth being careful
 * about, and the obvious reading of it is wrong. Dropping the plateau because
 * something is *within* a fifth of a step of it treats the two sides of it
 * alike, and they are not: a pass stops where the work rises to meet it, so a
 * level **outside** the plateau leaves the difference standing and a level
 * inside it stops short and never touches the plateau at all. Only the
 * plateau's own radius cuts a plateau to size. Measured on the ⌀30 section of
 * the test shaft: the ladder landed at ⌀31.00, the plateau wanted ⌀30.60, the
 * plateau was dropped for being 0.2 away, and the finishing insert was handed
 * 0.5mm where 0.3 was asked for.
 *
 * So the plateau is kept and the nearby ladder level gives way to it. That
 * cannot cost a pass or deepen one: the plateau level is the deeper of the two,
 * so it cuts everything the level it replaced would have cut, and the pass
 * below it is left with less to take.
 */
export function roughLevels(profile, { barRadius, finishR, step, allowance, zLo, zHi }) {
  const ladder = [];
  for (let radius = barRadius - step; radius > finishR + 1e-9; radius -= step) ladder.push(radius);

  // plateaus: runs of the profile at one radius, long enough to turn along
  const shelves = [];
  const samples = profileRange(profile, zLo, zHi);
  let runStart = 0;
  for (let i = 1; i <= samples.length; i++) {
    const same = i < samples.length && Math.abs(samples[i][1] - samples[runStart][1]) < 1e-3;
    if (same) continue;
    const length = Math.abs(samples[i - 1][0] - samples[runStart][0]);
    const at = samples[runStart][1] + allowance;
    if (length >= SHELF_MIN_LENGTH && at > finishR + 1e-9 && at < barRadius - 1e-9
      && shelves.every((s) => Math.abs(s - at) > 1e-6)) {
      shelves.push(at);
    }
    runStart = i;
  }

  const near = (l) => shelves.some((s) => Math.abs(l - s) <= step * 0.2);
  // finishR is the deepest the cycle goes and is nobody's to give up
  return [...ladder.filter((l) => !near(l)), ...shelves, finishR].sort((a, b) => b - a);
}

/**
 * One constant-radius pass: in at the free end, along until the part rises to
 * meet the tool, back to the free end at the radius the pass just left.
 *
 * The return travel is the whole point. A pass that retracts to the clearance
 * radius, rapids back along the bar and dives in again pays for the full radial
 * distance twice on every pass — on a Ø40 bar roughed in 2mm steps that is
 * about 190mm of extra rapid, per pass, through air the tool is standing in
 * already. It is the lathe's version of the parallel-finish retract.
 *
 * It is also unnecessary, and provably so: this pass has just cleared
 * everything between `stopZ` and `zHi` down to `at`, so the corridor half a
 * millimetre outside `at` is air over exactly the span the tool has to travel
 * back along. Nothing else can be in it.
 *
 * The approach is the mirror of the same argument, and it used to be wrong. The
 * old code rapided to `at + 0.5` whatever the step was, but the surface at the
 * free end stands at whatever the *previous* pass left — 2mm further out on a
 * 2mm stepdown — so the rapid finished 1.5mm inside solid stock. The rapid now
 * stops at the previous pass's surface and the feed covers the step.
 *
 * @param state carried across the whole cycle: what the last pass left (`prev`),
 *   and where the tool now stands (`r`, `z`)
 * @returns whether it cut anything
 */
function cutOneRoughPass(cl, { profile, at, zHi, zLo, allowance, nose, clearX, state }) {
  // How far along this radius stays clear of the part: walk the samples from
  // the free end inward and stop where the work rises to meet the tool.
  const samples = profileRange(profile, zLo, zHi);
  let stopZ = zLo;
  for (let i = samples.length - 1; i >= 0; i--) {
    const [z, radius] = samples[i];
    if (z > zHi + 1e-9) continue;
    if (radius + allowance > at + 1e-9) { stopZ = z; break; }
    stopZ = zLo;
  }
  if (!(zHi > stopZ + 1e-6)) return false;

  // the nose centre, which is a radius outside the diameter this pass leaves
  const centre = at + nose;
  const startZ = zHi + nose;
  // Rapid to the surface the last pass left and feed from there: that is the
  // last place on the way in that is certainly air.
  const entry = Math.max(centre + RADIAL_GAP, state.prev);
  if (!state.started) {
    safeTo(cl, clearX, startZ);
    cl.rapid(entry, 0, startZ);
  } else {
    cl.rapid(state.r, 0, startZ);          // back along the corridor just cut
    if (entry < state.r - 1e-9) cl.rapid(entry, 0, startZ);
  }
  cl.cut(centre, 0, startZ, FEED.PLUNGE);
  cl.cut(centre, 0, stopZ + nose);
  // lift off the wall before travelling back, so the tool does not rub its way out
  cl.rapid(centre + RADIAL_GAP, 0, stopZ + nose);

  state.started = true;
  state.prev = centre;
  state.r = centre + RADIAL_GAP;
  state.z = stopZ + nose;
  return true;
}

// --- finishing ---

/**
 * One pass down the finished profile, with the insert's nose radius taken off
 * it.
 *
 * A finishing pass driven straight down the profile cuts every face a nose
 * radius short and every diameter a nose radius deep, because the insert
 * touches the work on its nose and not at the point the drawing calls the tip.
 * See offsetProfile in engine/lathe.js.
 */
export function generateTurnFinish({ mesh, tool, params, stock, fixtures }) {
  const cl = startProgram(tool, params);
  const ctx = turningContext({ mesh, params, stock, tool, fixtures });
  const { profile, clearX, allowance, nose } = ctx;
  // The tolerance is what the finish pass is *for*, and it was being thrown
  // away: the sampling step was `max(tolerance, 0.2)`, so every tolerance
  // finer than two tenths produced the identical program. Asking for 0.02 and
  // asking for 0.2 gave the same path — on the one operation in the app whose
  // whole job is to hold a size.
  //
  // Sampled at the tolerance now, and the builder merges what is collinear
  // (see startProgram), so a straight diameter is still two points and only a
  // curve pays for the resolution it needs.
  const step = Math.max(0.01, params.tolerance ?? 0.05);
  const zEnd = limitToChuck(cl, ctx);

  const raw = profilePoints(profile, ctx.zStart, zEnd, { step });
  if (raw.length < 2) {
    cl.warn('finishing found no profile in the Z range');
    return cl.finish();
  }
  const withAllowance = raw.map(([z, r]) => [z, r + allowance]);
  const path = offsetProfile(withAllowance, nose);

  safeTo(cl, clearX, path[0][0]);
  cl.rapid(path[0][1] + 1, 0, path[0][0]);
  cl.cut(path[0][1], 0, path[0][0], FEED.LEAD);
  for (let i = 1; i < path.length; i++) cl.cut(path[i][1], 0, path[i][0]);
  cl.rapid(path[path.length - 1][1] + 1, 0, path[path.length - 1][0]);
  cl.rapid(clearX, 0, path[path.length - 1][0]);

  cl.info(`finished ${Math.abs(ctx.zStart - zEnd).toFixed(2)}mm of profile`
    + (nose > 0 ? `, compensated for a ${nose}mm nose` : ' with no nose compensation'));
  // What a finishing insert is actually being asked to take.
  //
  // A finish pass follows the profile wherever it goes, including down into a
  // recess no roughing cycle could open — and then the cut it takes there is
  // the whole depth of the recess in one bite. Measured on the test shaft: a
  // DCMT 07 with a 0.4mm nose driven 3.09mm into the ⌀24 groove behind the ⌀30
  // shoulder, with the operation reporting only that it had finished 90mm of
  // profile. Nothing else in the program says so either, because the pass that
  // should have opened it is one nobody added.
  for (const recess of enclosedRecesses(raw)) {
    if (recess.depth <= Math.max(nose, allowance) + 0.1) continue;
    cl.warn(`⌀${dia(recess.radius)} at Z${recess.z.toFixed(2)} is ${recess.depth.toFixed(2)}mm `
      + `below the ⌀${dia(recess.shoulder)} either side of it — no turning pass can reach in `
      + 'there, so this insert takes the whole depth in one cut; open it with a grooving tool first');
  }
  return cl.finish();
}

// --- grooving ---

/**
 * Cut a groove between Top Z and Bottom Z, down to `grooveRadius`.
 *
 * The groove's two shoulders are the operation's two heights, because a groove
 * *is* a width along the bar and that is what the pair already means everywhere
 * else on the lathe. The blade is narrower than most grooves, so the cut is
 * walked along in overlapping plunges — full width at each end so both
 * shoulders are cut by a full edge rather than by a corner, and the middle
 * shared out evenly between them.
 *
 * Each plunge is pecked. A blade buried to its full depth in a groove has
 * nowhere to send the chip, and a chip with nowhere to go lifts the blade out
 * of the cut sideways, which is how they break.
 */
/**
 * How a groove is shared out into plunges of a blade narrower than it is.
 *
 * Full-width bites at both shoulders, then whatever is needed in between.
 *
 * `cuts` is the number of *steps* between those two shoulders, so a groove
 * exactly one blade wide takes none of them and the caller plunges once.
 * Forcing it to at least one made that groove — the commonest one there is,
 * because a blade is bought for the width it has to cut — plunge twice at the
 * identical Z: the second bite fed the blade down a slot it had just cut,
 * rubbing the whole way and taking no chip, which is how a parting blade is
 * broken rather than worn.
 *
 * Stock to leave is the same distance from *every* finished surface here as it
 * is everywhere else in the app — the floor and both shoulders — which is the
 * rule slot.js already spells out for the milled version of the same cut.
 * Grooving read it for the floor alone and the panel did not offer it at all,
 * so a groove asked to leave 0.2mm all round came out on size across its width
 * with nothing for the finishing pass to take off the walls.
 *
 * A groove no wider than the blade has no wall allowance to be had — the cut is
 * full width by definition — so there it applies to the floor alone rather than
 * being turned into a groove two allowances narrow.
 *
 * Exported because the properties panel says how many plunges the operation
 * comes to before it is generated (see app/op-catalog.js describeIntent), and a
 * second copy of this arithmetic there was one plunge out on any groove with an
 * allowance set.
 */
export function grooveBites(width, blade, allowance = 0) {
  const wallAllowance = width - blade >= 2 * allowance ? allowance : 0;
  const cutWidth = width - 2 * wallAllowance;
  const inner = Math.max(0, cutWidth - blade);
  const cuts = Math.ceil(inner / (blade * 0.7));
  return { wallAllowance, cutWidth, inner, cuts, plunges: cuts + 1 };
}

export function generateTurnGroove({ mesh, tool, params, stock, fixtures }) {
  const cl = startProgram(tool, params);
  const ctx = turningContext({ mesh, params, stock, tool, fixtures });
  const { bar, clearX, allowance } = ctx;
  const internal = !!params.grooveInternal;
  const zEnd = limitToChuck(cl, ctx, internal ? 'internal' : 'external');

  const blade = Math.max(0.2, tool?.bladeWidth || tool?.diameter || 3);
  const zHi = Math.max(ctx.zStart, zEnd);
  const zLo = Math.min(ctx.zStart, zEnd);
  const width = zHi - zLo;
  // Where the plunge starts: the bar for an outside groove, the bore for one
  // cut in a hole. Both are "the surface the blade meets first".
  const from = internal
    ? Math.max(bar.innerRadius, radiusAtZ(ctx.profile, (zHi + zLo) / 2) - 1)
    : Math.min(bar.radius, Math.max(radiusAtZ(ctx.profile, zHi), radiusAtZ(ctx.profile, zLo)));
  const safeX = internal ? Math.max(0.5, from - 2) : clearX;
  // How deep the groove goes, when nobody has said.
  //
  // A blank floor used to read as radius 0, which is the centreline — so a new
  // groove operation arrived set to cut the bar in half. That is a part-off,
  // and there is a strategy for it. The Z span next door is defaulted with the
  // same care and the reasoning is written down there: "a groove is a width,
  // not a length of bar", and defaulting it to the whole part is a groove
  // nobody wants. The depth deserved the same answer and never got it.
  //
  // It is measured off `from` — the surface the blade actually meets at this Z,
  // which the strategy has just worked out — rather than off the stock, because
  // a groove near the small end of a stepped shaft is cut into whatever is
  // there, not into the diameter the bar arrived as. Zero is still honoured
  // exactly as written, for anyone who does mean the centreline.
  const defaultDepth = Math.min(2, Math.max(0.5, from * 0.2));
  const floor = params.grooveRadius != null
    ? Math.max(0, params.grooveRadius)
    : Math.max(0, internal ? from + defaultDepth : from - defaultDepth);

  if (width < blade * 0.999) {
    cl.warn(`the groove is ${width.toFixed(2)}mm wide and the blade is ${blade}mm — `
      + 'it cannot fit');
    return cl.finish();
  }
  const depth = internal ? floor - from : from - floor;
  if (!(depth > 1e-6)) {
    cl.warn(internal
      ? `nothing to groove — the floor ⌀${dia(floor)} is not outside the bore ⌀${dia(from)}`
      : `nothing to groove — the floor ⌀${dia(floor)} is not inside the stock ⌀${dia(from)}`);
    return cl.finish();
  }

  const { wallAllowance, cutWidth, inner, cuts } = grooveBites(width, blade, allowance);
  const zHiCut = zHi - wallAllowance;
  const centres = [];
  for (let i = 0; i <= cuts; i++) {
    centres.push(zHiCut - blade / 2 - (cuts === 0 ? 0 : (inner * i) / cuts));
  }

  const peck = Math.max(0, params.peck ?? 0);
  const target = internal ? floor - allowance : floor + allowance;
  // Half a millimetre off the surface the blade plunges from. Every plunge
  // starts and ends there, and the step along the bar between them happens
  // there too: it is outside the material by definition, so going back out to
  // the clearance radius between plunges is a round trip to nowhere — and there
  // is one per bite of a groove several blades wide.
  const off = internal ? from - 0.5 : from + 0.5;
  for (let i = 0; i < centres.length; i++) {
    const z = centres[i];
    if (i === 0) {
      if (internal) safeToInternal(cl, safeX, z); else safeTo(cl, safeX, z);
      cl.rapid(off, 0, z);
    } else {
      cl.rapid(off, 0, z);            // already at `off`; this is the step along
    }
    plungeRadially(cl, { from, to: target, peck, internal, clear: from });
    // out the way it came in, so the blade never drags along a wall
    cl.rapid(off, 0, z);
  }
  if (centres.length > 0) cl.rapid(safeX, 0, centres[centres.length - 1]);

  cl.info(`${plural(centres.length, 'plunge')} of a ${blade}mm blade — a ${width.toFixed(2)}mm groove `
    + `${depth.toFixed(2)}mm deep to ⌀${dia(floor)}`
    + (allowance > 0
      ? `, leaving ${allowance}mm on the floor${wallAllowance > 0 ? ' and both walls' : ''
      } (this pass cuts ${cutWidth.toFixed(2)}mm to ⌀${dia(internal ? target : target)})`
      : '')
    + (peck > 0 ? `, pecking ${peck}mm` : ''));
  return cl.finish();
}

/**
 * Feed radially from `from` to `to`, backing out every `peck` to clear the chip.
 * Works in both directions, because a bore is grooved outward.
 *
 * @param lanes Z positions to take each bite at, deepening together. One lane
 *   is an ordinary plunge; two cut a slot wider than the blade, which is what
 *   keeps a deep part-off from pinching — see generateTurnPart. A blade may
 *   only move sideways in air, so changing lane goes out of the slot, across,
 *   and back down to the depth that lane had already reached.
 */
function plungeRadially(cl, { from, to, peck, internal, clear, lanes = null }) {
  const zs = lanes ?? [currentZ(cl)];
  const escape = internal ? clear - 0.5 : clear + 0.5;
  const total = Math.abs(to - from);
  const sign = to > from ? 1 : -1;
  const bite = peck > 0 ? Math.min(peck, total) : total;
  let at = from;
  let n = 0;
  while (Math.abs(at - to) > 1e-9) {
    const reached = at;
    at = sign > 0 ? Math.min(to, at + bite) : Math.max(to, at - bite);
    for (const z of zs) {
      if (zs.length > 1) {
        cl.rapid(escape, 0, currentZ(cl));
        cl.rapid(escape, 0, z);
        cl.rapid(reached, 0, z);
      }
      cl.cut(at, 0, z, FEED.PLUNGE);
    }
    n++;
    if (Math.abs(at - to) > 1e-9) {
      cl.rapid(escape, 0, currentZ(cl));                                // clear the chip
      // Back on down to a hair short of the floor we just cut — *short* of it.
      // The offset has to run against the direction of cutting, and saying that
      // as `internal ? +0.2 : -0.2` got both cases backwards: an outside groove
      // cuts toward the axis, so 0.2 less radius than the fresh floor is 0.2
      // inside solid bar, and the blade arrived there at rapid. `sign` is the
      // direction, and taking the offset off it is the only description of
      // "short of" that cannot be inverted by mistake.
      cl.rapid(at - sign * 0.2, 0, currentZ(cl));
    }
  }
  return n;
}

// --- threading ---

/** How deep an ISO metric thread's form is, from its pitch. */
export function threadFormDepth(pitch, internal = false) {
  // 0.61343·P external (the crest is truncated), 0.54127·P internal
  return Math.max(0.01, (internal ? 0.54127 : 0.61343) * Math.max(0.01, pitch));
}

/**
 * The most passes a threading schedule may be expanded to.
 *
 * A limit rather than a preference: the pass count is derived from a squared
 * ratio, so a first-bite cap a machinist would call "careful" and a form depth
 * they would call "coarse" multiply into a number no control would accept and
 * no user would wait for.
 */
const MAX_THREAD_PASSES = 200;

/**
 * The depth each threading pass cuts to, from the surface.
 *
 * Two things decide the shape of the schedule, and they pull against each
 * other:
 *
 *   * **Equal chip area.** Every pass at the same depth increment removes more
 *     than the one before it, because the groove is wider the deeper it gets.
 *     Sharing the area out equally puts the depth at `d·(i/n)^½` — the
 *     degressive infeed every threading cycle uses internally.
 *   * **The first pass is then the biggest one there is.** `√(1/6)` is 41% of
 *     the whole form in the first bite, which is what "it goes to full depth on
 *     the first pass" is describing: after that pass the groove is already most
 *     of the way to its finished shape and the remaining five barely show. It
 *     is also more than a 60° insert corner wants to take in one go.
 *
 * So the pass count is a *minimum*, not the answer: if the schedule's first
 * bite exceeds `firstDepth`, passes are added until it does not. Solving
 * `d·n^(−1/p) ≤ firstDepth` gives `n ≥ (d/firstDepth)^p`, so a 1.5mm pitch
 * (0.92mm deep) at a 0.25mm first bite comes out at 14 passes rather than 6 —
 * which is what a threading cycle for that pitch actually looks like.
 *
 * @param degression 1 is equal depth per pass, 2 is equal chip area
 * @param firstDepth the largest first bite allowed, mm; 0 leaves the count alone
 */
export function threadInfeed({ depth, passes, degression = 2, firstDepth = 0, spring = 0 }) {
  const p = Math.min(2, Math.max(1, degression || 2));
  let n = Math.max(1, Math.round(passes || 1));
  if (firstDepth > 0 && depth > firstDepth) {
    // Squared, so the count grows fast: a 5mm form at a 0.01mm first bite asks
    // for a quarter of a million passes, which is not a threading cycle, it is
    // a hang. The cap is well past any real schedule — a coarse ACME thread is
    // thirty or forty — and `capped` lets the caller say the number it was
    // given cannot be honoured rather than silently producing something else.
    const want = Math.ceil((depth / firstDepth) ** p - 1e-9);
    n = Math.max(n, Math.min(want, MAX_THREAD_PASSES));
  }
  n = Math.min(n, MAX_THREAD_PASSES);
  const out = [];
  for (let i = 1; i <= n; i++) out.push(depth * (i / n) ** (1 / p));
  // Spring passes cut nothing new by the numbers and take the thread to size in
  // practice: the bar deflects away from the insert under load, so the last
  // real pass leaves what it sprang by behind.
  for (let i = 0; i < Math.max(0, Math.round(spring || 0)); i++) out.push(depth);
  return out;
}

/**
 * Where a threading pass may actually start and stop.
 *
 * A pass runs past the thread at both ends — the carriage has to be locked to
 * the spindle before the tool touches, and cannot stop dead at the far end — and
 * both of those overruns are only available if there is nothing standing there.
 * The tool is at full form depth for the whole of them.
 *
 * Walks from the thread's own end outward toward the wanted point and stops
 * where the work rises to meet the tool.
 *
 * @param at the wanted point, `from` the thread's own end nearest it
 * @param slack how much the work may close on the tool and still count as
 *   clear. Zero going in, where the tool has to reach depth in air. A hair
 *   coming out, where the radius being tested is the thread's own crest and the
 *   cylinder it is cut into sits exactly on it — see the caller.
 * @returns { z, clear } — how far it may go, and whether that is the whole way
 */
function clearOfWork(profile, radius, {
  at, from, internal, bore, slack = 0,
}) {
  const span = at - from;
  if (Math.abs(span) < 1e-9) return { z: at, clear: true };
  const limit = radius + (internal ? -slack : slack);
  const blocked = (z) => {
    const outer = radiusAtZ(profile, z);
    // Past the end of the part there is nothing at all, inside or out. That is
    // the commonest run-in there is — a thread at the free end leads in through
    // air — and it has to be tested before either of the cases below, because
    // the *bore* also reads zero out there and would otherwise be mistaken for
    // solid metal. This was wrong for exactly one release: an internal thread
    // with all the space in the world was told it had none.
    if (!(outer > 1e-6)) return false;
    // Inside a bore the work is outside the tool, so the test flips: a hole
    // narrower than the pass blocks it. No hole where the part *is* — a blind
    // bore that has ended, or solid bar — blocks it too.
    if (internal) return !(radiusAtZ(bore ?? profile, z) > limit + 1e-6);
    return outer > limit + 1e-6;
  };
  const steps = Math.max(8, Math.ceil(Math.abs(span) / 0.1));
  let reached = from;
  for (let i = 1; i <= steps; i++) {
    const z = from + (span * i) / steps;
    if (blocked(z)) return { z: reached, clear: false };
    reached = z;
  }
  return { z: at, clear: true };
}

/**
 * Single-point threading: a series of passes down the same helix, each a little
 * deeper than the last.
 *
 * The infeed is not linear. Every pass at the same depth increment removes more
 * material than the one before it, because the groove is wider the deeper it
 * gets — so the last pass of a linear schedule is doing several times the work
 * of the first, on the weakest corner in the shop. Sharing the *area* out
 * equally instead means each depth goes as the square root of the pass number,
 * which is what every control's threading cycle does internally and what this
 * writes out longhand.
 *
 * The passes are emitted as ordinary moves rather than as a G76 cycle. That is
 * deliberate: the moves are what the simulator can show and what the backplot
 * can draw, and a post that wants a cycle can recognise the pattern.
 *
 * Each pass is *marked* as synchronised, though, and that is not decoration.
 * The carriage has to be locked to the spindle encoder, not fed at a rate that
 * works out about right — otherwise every pass after the first starts a little
 * further round the bar and the form is destroyed. The lathe post turns the
 * mark into G33 with the pitch as K. See engine/cl.js threadPass.
 */
export function generateTurnThread({ mesh, tool, params, stock, fixtures }) {
  const cl = startProgram(tool, params);
  const ctx = turningContext({ mesh, params, stock, tool, fixtures });
  const { bar, clearX } = ctx;
  const internal = !!params.threadInternal;
  const zEnd = limitToChuck(cl, ctx, internal ? 'internal' : 'external');

  const pitch = Math.max(0.1, params.threadPitch ?? 1.5);
  const asked = Math.max(1, Math.round(params.threadPasses ?? 6));
  const leftHand = (params.threadHand ?? 'right') === 'left';
  const depth = params.threadDepth > 0
    ? params.threadDepth
    : threadFormDepth(pitch, internal);
  const zHi = Math.max(ctx.zStart, zEnd);
  const zLo = Math.min(ctx.zStart, zEnd);

  const major = params.threadStartRadius > 0
    ? params.threadStartRadius
    : threadMajorRadius(ctx.profile, {
      zLo, zHi, internal, barRadius: bar.radius, face: params.threadFace ?? 'auto',
    });

  if (!(zHi > zLo + 1e-6)) {
    cl.warn('the thread has no length — Top Z and Bottom Z are the same place');
    return cl.finish();
  }
  if (internal && major - depth <= 0) {
    cl.warn('an internal thread that deep would cut through the axis');
    return cl.finish();
  }

  // A lead-in and a run-out, because the carriage has to be up to speed before
  // the tool touches and cannot stop dead at the end of the thread.
  const lead = pitch * 2;
  const safeX = internal ? Math.max(0.5, major - depth - 2) : clearX;
  const sign = internal ? 1 : -1;

  // Which way the carriage runs. The hand of a thread is the feed direction
  // against the spindle's, and the spindle only turns one way for a cut — so a
  // left-hand thread is the same tool and the same synchronisation run the
  // other way along the bar: in past the thread first, then out toward the free
  // end. That is also the only way to thread up to a shoulder, which is why
  // "start from the inside" and "left hand" are the same request.
  const wantFrom = leftHand ? zLo - lead : zHi + lead;
  const wantTo = leftHand ? zHi + lead * 0.5 : zLo - lead * 0.5;

  // The deepest the tool ever stands, which is what both ends have to be judged
  // against: the run-in has to be clear of the work at the *last* pass's radius,
  // not the first, or the tool rapids into metal on every pass after the first.
  const deepest = major + sign * depth;
  // An internal thread is judged against the hole it is cut in, not against the
  // outside of the part — the two are different curves and only one of them is
  // in the tool's way down there.
  const bore = internal ? boreProfile(mesh, { samples: 600 }) : null;
  const runIn = clearOfWork(ctx.profile, deepest, {
    at: wantFrom, from: leftHand ? zLo : zHi, internal, bore,
  });
  // The run-out is judged against the thread's own crest, not against the bottom
  // of its form, and the two ends are different questions on purpose.
  //
  // Going *in*, the tool has to arrive at full depth before it touches anything
  // — so nothing may stand above the minor diameter, or the approach is a plunge
  // into solid bar. Coming *out*, the tool is already at depth, already
  // synchronised and already cutting: metal at the thread's own diameter is not
  // in its way, it is the same cylinder the thread is being cut into, and
  // running a pitch and a half further along it is what a run-out *is*. Judging
  // that end at the minor radius refused the ordinary case — "no run-out space
  // at Z−18.508, the pass stops at Z−15.508 where the part comes up to meet the
  // tool", on a plain ⌀36 bar that simply carries on past the thread. What
  // genuinely stops a run-out is a *shoulder*: something standing proud of the
  // crest.
  const runOut = clearOfWork(ctx.profile, major, {
    at: wantTo, from: leftHand ? zHi : zLo, internal, bore, slack: 0.001,
  });
  // A chuck stops the run-in and the run-out too, not just the thread between
  // them. `limitToChuck` pulls the thread's *end* clear of the jaws, but a
  // run-out carries a pitch and a half past that end — toward the chuck on a
  // right-hand thread, and it was crossing into the jaws (measured 1.5mm past a
  // Z10 limit, cutting to Z8.5). The chuck blocks everything below its face, so
  // neither end of a synchronised pass may go there. The thread simply loses its
  // run-out room when the jaws are that close, which is the operator's to fix by
  // gripping less of the bar — but the tool no longer runs into the jaws.
  const chuckFloor = ctx.chuck
    && (internal ? ctx.chuck.mode === 'inside' : ctx.chuck.mode !== 'inside')
    ? ctx.chuck.z : -Infinity;
  const from = Math.max(runIn.z, chuckFloor);
  const to = Math.max(runOut.z, chuckFloor);

  // "The first plunge is way too deep — a real insert would break."
  //
  // It was, and this is where. The lead-in point was `Top Z + two pitches`
  // without asking what is there, so on a thread that starts short of the end
  // of a turned diameter — which is most of them, the diameter runs on past the
  // thread — the tool rapided from the clearance radius **to full thread depth
  // inside solid bar**, once per pass. The first pass buries 0.25mm of a 60°
  // corner in unthreaded stock; the last buries the whole form. The
  // synchronised move then starts from there, so the "lead-in" was a full-depth
  // boring cut with a threading insert.
  //
  // The pass may only be positioned where the work is clear of it. Where the
  // geometry does not give that, no schedule fixes it: the thread needs a
  // relief groove or has to start at the end of the bar, and the operation says
  // so rather than emitting the program that breaks the tool.
  if (!runIn.clear) {
    cl.warn(`no run-in space: at Z${round(wantFrom)} the part is `
      + `⌀${dia(radiusAtZ(ctx.profile, wantFrom))} and the tool has to be at `
      + `⌀${dia(deepest)} before the pass starts, so it would enter the work at `
      + 'full form depth. Start the thread at the end of the bar, or cut a '
      + 'relief groove for the tool to run into.');
  }
  if (!runOut.clear) {
    cl.warn(`no run-out space at Z${round(wantTo)}: the part stands `
      + `⌀${dia(radiusAtZ(ctx.profile, wantTo))} there, proud of the thread's own `
      + `⌀${dia(major)}, so the pass stops at Z${round(to)} against the shoulder. `
      + 'Cut a relief groove at the end of the thread, or shorten it.');
  }

  const firstDepth = Math.max(0, params.threadFirstDepth ?? 0.25);
  const schedule = threadInfeed({
    depth,
    passes: asked,
    // These fall back to the same numbers op-defaults.js writes into a new
    // operation, so a document saved before they existed threads the same way a
    // new one does rather than keeping the old schedule by omission.
    degression: params.threadDegression ?? 2,
    firstDepth,
    spring: Math.max(0, Math.round(params.threadSpringPasses ?? 1)),
  });
  const passes = schedule.length;
  // The schedule is capped, and a cap that is not mentioned is a lie told in
  // two numbers: the note said "more passes were needed to keep the first bite
  // down" beside a first bite that is nothing like the one asked for. A 0.10mm
  // first cut on a 3mm-pitch form wants 339 passes; it gets 200 and a 0.13mm
  // first cut. Say which of the two things it could not do.
  if (firstDepth > 0 && schedule[0] > firstDepth + 1e-9) {
    cl.warn(`a ${round(firstDepth)}mm first cut on a ${round(depth)}mm form needs more `
      + `than the ${MAX_THREAD_PASSES} passes a schedule is allowed, so the first cut is `
      + `${round(schedule[0])}mm instead. Take a bigger first cut, or rough the thread `
      + 'with a groove first.');
  }

  /**
   * The radius the tool goes back to between passes.
   *
   * Not the clearance radius. Threading is fifteen passes down the same helix,
   * and a cycle that returns to clearance after each of them pays for the whole
   * radial distance twice, fifteen times, to get back to a groove it is
   * standing in: measured on a ⌀16 thread in a ⌀40 bar, 692mm of rapid for a
   * 15mm thread. Clearing the *work* is what the return has to do, and the work
   * over the span the tool travels is the thread's own diameter — plus whatever
   * the profile actually reaches there, which is what is measured rather than
   * assumed. The tool still goes home at the end, and still comes in from
   * clearance at the start, because that is where the previous operation left
   * it.
   */
  const spanLo = Math.min(from, to);
  const spanHi = Math.max(from, to);
  let overWork = 0;
  for (const [, radius] of profileRange(ctx.profile, spanLo, spanHi)) {
    if (radius > overWork) overWork = radius;
  }
  const retractX = internal
    ? safeX
    : Math.min(clearX, Math.max(major, overWork) + RADIAL_GAP);

  let started = false;
  for (const d of schedule) {
    const at = major + sign * d;
    if (!started) {
      if (internal) safeToInternal(cl, safeX, from);
      else safeTo(cl, clearX, from);
      started = true;
    }
    // back along the corridor the last pass left by, at the radius it left at
    if (!internal) cl.rapid(retractX, 0, from);
    else safeToInternal(cl, safeX, from);
    // Rapid to depth only where the run-in is genuinely clear. Where it is not,
    // the move is a feed: the operation has already said this thread has no run
    // in space, and if it is going to be run anyway the tool should arrive at
    // cutting rate rather than at rapid.
    if (runIn.clear) cl.rapid(at, 0, from);
    else cl.cut(at, 0, from, FEED.PLUNGE);
    // the cut itself is locked to the spindle; the approach and the retract
    // around it are not
    cl.threadPass(pitch);
    cl.cut(at, 0, to);
    cl.threadEnd();
    // straight out at the end of the pass, never back along the thread
    cl.rapid(retractX, 0, to);
  }
  // and home once, at the end
  if (started && !internal) cl.rapid(clearX, 0, to);

  // The carriage has to keep up with the spindle for the whole pass and then
  // stop: a thread is cut at a fraction of the speed the same insert turns at.
  // A blank spindle field on a threading operation inherits the tool's roughing
  // rpm, which is the one inherited default here that is actively dangerous.
  const rpm = params.spindleRpm > 0 ? params.spindleRpm : 0;
  const carriage = rpm * pitch;
  if (carriage > 2000) {
    cl.warn(`at ${rpm}rpm a ${pitch}mm pitch feeds the carriage at `
      + `${Math.round(carriage)}mm/min — set a slower spindle speed on this `
      + 'operation (threading wants roughly a third of a turning speed)');
  }

  cl.info(`${pluralEs(passes, 'synchronised pass')} cutting a ${pitch}mm pitch `
    + `${leftHand ? 'left-hand ' : ''}${internal ? 'internal' : 'external'} thread `
    + `${(zHi - zLo).toFixed(2)}mm long, ${depth.toFixed(3)}mm deep from ⌀${dia(major)}`
    + `, first bite ${schedule[0].toFixed(3)}mm`
    + (passes > asked ? ` (${asked} asked for; more were needed to keep the first `
      + 'bite down)' : ''));
  return cl.finish();
}

/**
 * Which diameter the thread is cut on.
 *
 * This used to be read at the midpoint of the Z range and nowhere else, so a
 * thread that runs off a shoulder — which is most of them — was cut on
 * whichever of the two diameters the midpoint happened to land on. That is
 * "it threads what it wants": the choice was being made by arithmetic rather
 * than by the person who knows which face is the threaded one.
 *
 * @param face 'auto' | 'start' | 'end' — auto takes the surface the thread
 *   actually sits on: the largest diameter in the range outside, the smallest
 *   bore inside
 */
export function threadMajorRadius(profile, { zLo, zHi, internal, barRadius, face = 'auto' }) {
  const clamp = (r) => (internal
    ? Math.max(0.5, r)
    : Math.min(barRadius, r > 0 ? r : barRadius));
  if (face === 'start') return clamp(radiusAtZ(profile, zHi));
  if (face === 'end') return clamp(radiusAtZ(profile, zLo));
  const radii = profileRange(profile, zLo, zHi)
    .map(([, r]) => r).filter((r) => r > 1e-6);
  if (radii.length === 0) return clamp(radiusAtZ(profile, (zHi + zLo) / 2));
  return clamp(internal ? Math.min(...radii) : Math.max(...radii));
}

// --- axial drilling ---

/**
 * Drill down the centreline from the tailstock end.
 *
 * A hole on a lathe is drilled with the work spinning and the drill held still,
 * so there is exactly one of them and it is on the axis. That makes this the
 * simplest strategy in the app: one drill cycle at X0, from the end of the bar
 * to the depth asked for.
 */
export function generateTurnDrill({ mesh, tool, params, stock, fixtures }) {
  const cl = startProgram(tool, params);
  const ctx = turningContext({ mesh, params, stock, tool, fixtures });
  const zEnd = limitToChuck(cl, ctx, 'internal');
  const retract = Math.max(ctx.zStart, zEnd) + Math.max(1, params.entryGap ?? 1);

  if (!(ctx.zStart > zEnd + 1e-6)) {
    cl.warn('the hole has no depth — Top Z is not ahead of Bottom Z');
    return cl.finish();
  }
  if (!(tool?.diameter > 0)) {
    cl.warn('drilling needs a drill with a diameter');
    return cl.finish();
  }
  // A hole on the centreline is made by a drill and by nothing else. A turning
  // insert cannot reach the axis — it is a corner working on the outside of a
  // spinning bar — and a boring bar needs a hole to already be there before it
  // can go in. tool-match.js has said both are unusable here for a long time,
  // but the strategy went ahead and emitted the cycle anyway, and a drill cycle
  // with an insert fitted is what the simulation then had to draw: it rolled
  // the insert's profile along X0 and took the bar's outside radius down to
  // nothing over the whole depth of the "hole", which reads on screen as the
  // part being shoved backwards. Refusing here is the honest answer, and it
  // stops the picture being drawn at all.
  if (tool.type !== 'drill') {
    cl.warn(`${tool.name ? `${tool.name} is a ` : 'this is a '}${tool.type ?? 'non-drill'} `
      + 'tool, and a hole on the centreline can only be made by a drill. '
      + 'Fit a drill, or use Bore to open a hole that is already there.');
    return cl.finish();
  }

  cl.rapid(0, 0, retract);
  cl.drill(0, 0, zEnd, {
    retractZ: retract,
    peck: Math.max(0, params.peck ?? 0),
    dwell: Math.max(0, params.dwell ?? 0),
  });
  cl.rapid(0, 0, retract);

  const depth = ctx.zStart - zEnd;
  cl.info(`⌀${tool.diameter} hole ${depth.toFixed(2)}mm deep on the centreline`
    + (params.peck > 0 ? `, pecking ${params.peck}mm` : ''));
  return cl.finish();
}

// --- internal turning ---

/**
 * Bore a hole out to the part's inside profile.
 *
 * Roughing outward from a pilot hole, which is the mirror of OD roughing in
 * every direction at once: the passes get bigger rather than smaller, the tool
 * retracts inward, and the safe radius is near the axis instead of well clear of
 * the bar. The finish pass follows the bore profile with the nose radius offset
 * *inward*, because the nose is on the other side of the surface now.
 *
 * A boring bar also has a reach: it is a long thin thing sticking into a hole,
 * and past four or five diameters it will chatter whatever the numbers say. The
 * strategy stops where the tool says it stops, and says so.
 */
export function generateTurnBore({ mesh, tool, params, stock, fixtures }) {
  const cl = startProgram(tool, params);
  const ctx = turningContext({ mesh, params, stock, tool, fixtures });
  const { allowance, nose, bar } = ctx;
  const bore = boreProfile(mesh, { samples: 600 });
  const step = Math.max(0.05, params.stepdown ?? 0.8);
  let zEnd = limitToChuck(cl, ctx, 'internal');

  const zHi = Math.max(ctx.zStart, zEnd);
  const zLo = Math.min(ctx.zStart, zEnd);

  if (!hasBore(bore, zLo, zHi)) {
    cl.warn('no bore found in this Z range — the part is solid here, so there is '
      + 'nothing to open up. Drill it first, or check Top Z and Bottom Z.');
    return cl.finish();
  }

  // How far the bar can reach into the hole before it is all overhang.
  const reach = params.boreDepthLimit > 0 ? params.boreDepthLimit
    : tool?.maxDepth > 0 ? tool.maxDepth : Infinity;
  if (Number.isFinite(reach) && zHi - zLo > reach) {
    zEnd = zHi - reach;
    cl.warn(`the bar reaches ${reach}mm — stopped at Z${round(zEnd)} rather than `
      + `Z${round(zLo)}`);
  }
  const zStop = Math.max(zLo, zEnd);

  // The pilot: what is already there. From the field when the hole came from a
  // drill that is not in this program, from the stock's own bore on a tube,
  // and otherwise from the *part's narrowest section over this range*.
  //
  // That last one is the whole of the guess and it is the only honest one
  // available. A boring bar cannot start from solid, so something opened the
  // hole first, and on a stepped bore the narrowest section is what a drill
  // leaves and the wider ones are what boring is for — ⌀12 drilled and ⌀16
  // bored, on the test shaft. What it replaced was `target * 0.4`, a number
  // from nowhere: on that shaft it announced a ⌀6.40 pilot, refused because a
  // ⌀12 bar will not fit a ⌀6.40 hole, and cut nothing — a refusal invented
  // entirely by the fallback.
  const target = boreTargetRadius(bore, zStop, zHi);
  const known = params.boreStartRadius > 0 ? params.boreStartRadius
    : bar.innerRadius > 0 ? bar.innerRadius : 0;
  const pilot = known > 0 ? known : boreSmallestRadius(bore, zStop, zHi);

  const finishR = Math.max(0, target - allowance);
  if (!(finishR > pilot + 1e-6)) {
    // Where the pilot was guessed, saying "the hole is already ⌀16" states as
    // fact the very thing that was assumed. Say what was assumed instead.
    cl.warn(known > 0
      ? `nothing to bore — the hole is already ⌀${dia(pilot)} and the part `
        + `wants ⌀${dia(finishR)}`
      : `nothing to bore — this bore is ⌀${dia(target)} all the way, so there is `
        + 'no narrower section to open it from. Set the existing hole size, or '
        + 'drill it first.');
    return cl.finish();
  }
  // A hundredth, because bore sizes are quoted to a hundredth: without it a
  // pilot the profile puts at 5.9995 is refused by a ⌀12 bar in a message that
  // reads "needs a ⌀12 hole and the pilot is ⌀12.00".
  if (tool?.minBore > 0 && pilot * 2 < tool.minBore - 0.01) {
    cl.warn(`this bar needs a ⌀${tool.minBore} hole to fit in and the pilot is `
      + `⌀${dia(pilot)}`);
    return cl.finish();
  }

  const safeX = Math.max(0.2, pilot - 1);
  const state = { started: false, r: safeX, z: zHi + nose };
  let passes = 0;
  for (let radius = pilot + step; radius < finishR + step; radius += step) {
    const at = Math.min(radius, finishR);
    if (cutOneBorePass(cl, { bore, at, zHi, zLo: zStop, allowance, nose, safeX, state })) {
      passes++;
    }
    if (at >= finishR - 1e-9) break;
  }
  if (state.started) {
    cl.rapid(state.r, 0, zHi + nose);   // out along the hole, then in to safety
    cl.rapid(safeX, 0, zHi + nose);
  }

  if (passes === 0) {
    cl.warn('boring produced no passes — check the Z range against the hole');
    return cl.finish();
  }
  cl.info(`${pluralEs(passes, 'boring pass')} from ⌀${dia(pilot)} to ⌀${dia(finishR)}`
    + (allowance > 0 ? `, leaving ${allowance}mm on` : ''));
  return cl.finish();
}

/**
 * The narrowest *section* of the part's own bore over a Z range — the pilot,
 * when nothing else says what was drilled.
 *
 * A parallel section, not a sample and not a stretch below some size. Every
 * bore ends in a drill point or a radius, and those pass through every radius
 * down to nothing on the way: the smallest sample on the test shaft's ⌀16/⌀12
 * bore is ⌀2.16 and the whole taper below ⌀10 is 2.5mm long, so neither the
 * bare minimum nor a run-length floor answers it. What a drill leaves is a
 * *parallel* section, so that is what is looked for — ⌀12 over 13mm there, and
 * nothing constant anywhere on the taper.
 */
function boreSmallestRadius(bore, zLo, zHi, minLength = 2, flat = 0.05) {
  const { zMin, dz, r, samples } = bore;
  let best = Infinity;
  let start = -1;
  const close = (i) => {
    if (start >= 0 && (i - start) * dz >= minLength && r[start] < best) best = r[start];
    start = -1;
  };
  for (let i = 0; i < samples; i++) {
    const z = zMin + i * dz;
    if (z < zLo - dz || z > zHi + dz || !(r[i] > 1e-6)) { close(i); continue; }
    if (start < 0) start = i;
    else if (Math.abs(r[i] - r[start]) > flat) { close(i); start = i; }
  }
  close(samples);
  return Number.isFinite(best) ? best : 0;
}

/** The largest bore radius the part asks for over a Z range. */
function boreTargetRadius(bore, zLo, zHi) {
  const { zMin, dz, r, samples } = bore;
  let max = 0;
  for (let i = 0; i < samples; i++) {
    const z = zMin + i * dz;
    if (z < zLo - dz || z > zHi + dz) continue;
    if (r[i] > max) max = r[i];
  }
  return max;
}

/**
 * One constant-radius boring pass: in along the hole until the wall closes in
 * on the tool, then out.
 */
function cutOneBorePass(cl, { bore, at, zHi, zLo, allowance, nose, safeX, state }) {
  const { zMin, dz, r, samples } = bore;
  // walk from the mouth inward and stop where the bore is no longer big enough
  let stopZ = zHi;
  for (let i = samples - 1; i >= 0; i--) {
    const z = zMin + i * dz;
    if (z > zHi + 1e-9 || z < zLo - 1e-9) continue;
    if (r[i] === 0 || r[i] - allowance < at - 1e-9) break;
    stopZ = z;
  }
  if (!(zHi > stopZ + 1e-6)) return false;

  // the nose centre sits a radius *inside* the wall this pass leaves
  const centre = at - nose;
  if (!(centre > 0)) return false;
  const startZ = zHi + nose;
  if (!state.started) {
    safeToInternal(cl, safeX, startZ);
    approachRadially(cl, centre, startZ, true);
  } else {
    // The pass before this one opened the hole to its own radius over exactly
    // the span this travel covers, so coming back out along it — rather than
    // collapsing to the pilot radius and rapiding back in — is air by
    // construction. Same argument as cutOneRoughPass, mirrored.
    cl.rapid(state.r, 0, startZ);
    cl.cut(centre, 0, startZ, FEED.PLUNGE);
  }
  cl.cut(centre, 0, stopZ + nose);
  // come off the wall before travelling back out of the hole
  cl.rapid(centre - 0.3, 0, stopZ + nose);

  state.started = true;
  state.r = centre - 0.3;
  state.z = stopZ + nose;
  return true;
}

// --- parting off ---

/**
 * Cut the part off the bar at `bottomZ`.
 *
 * Pecked, because a parting blade buried to its full depth in a deep groove is
 * the single most reliable way to break one — the peck lifts it clear so the
 * chip can leave.
 */
export function generateTurnPart({ mesh, tool, params, stock, fixtures }) {
  const cl = startProgram(tool, params);
  const ctx = turningContext({ mesh, params, stock, tool, fixtures });
  const { bar, clearX, chuck } = ctx;
  const z = params.bottomZ;
  // on a tube there is no material inside the bore to part through
  const toRadius = Math.max(bar.innerRadius, params.partOffRadius ?? 0);
  const peck = Math.max(0, params.peck ?? 0);

  if (!(bar.radius > toRadius + 1e-6)) {
    cl.warn('parting off has no depth — the bar is already smaller than the finish radius');
    return cl.finish();
  }
  if (chuck && chuck.mode !== 'inside' && z < chuck.z - 1e-6) {
    cl.warn(`parting at Z${round(z)} is behind ${chuck.name} at Z${round(chuck.z)} — `
      + 'the blade cannot reach, and would hit the jaws trying');
    return cl.finish();
  }

  // A slot cut exactly as wide as the blade closes on it: the bar springs, the
  // parted end drops, and the blade is trapped at the bottom of a deep groove
  // with the spindle still running. Widening it by a fraction of the blade
  // gives the tool somewhere to be. The extra lane is on the *chuck* side, so
  // the finished length of the part is still Bottom Z.
  const blade = Math.max(0.2, tool?.bladeWidth || tool?.diameter || 3);
  const asked = Math.max(0, params.partWiden ?? 0);
  const widen = Math.min(asked, blade * 0.9);
  if (asked > widen + 1e-6) {
    cl.warn(`widening by ${asked}mm would leave a rib the ${blade}mm blade cannot `
      + `reach — cut ${widen.toFixed(2)}mm wider instead`);
  }

  safeTo(cl, clearX, z);
  cl.rapid(bar.radius + 0.5, 0, z);
  const pecks = plungeRadially(cl, {
    from: bar.radius, to: toRadius, peck, internal: false, clear: bar.radius,
    lanes: widen > 0 ? [z, z - widen] : null,
  });
  cl.rapid(clearX, 0, z);

  cl.info(`parted off at Z${round(z)} to ⌀${dia(toRadius)}`
    + (widen > 0 ? `, slot ${(blade + widen).toFixed(2)}mm wide` : '')
    + (peck > 0 ? ` in ${pecks} pecks of ${peck}mm` : ''));
  return cl.finish();
}
