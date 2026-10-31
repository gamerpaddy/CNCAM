// Turning: the part as a profile, and the bar it comes out of.
//
// A milled part is a shape in three dimensions and a turned one is a shape in
// two — a radius for every position along the spindle axis, spun. Everything
// downstream of that is simpler than milling for exactly this reason: there is
// no XY plane to clear, no reachability problem in the usual sense, and the
// whole job is a curve in (Z, radius).
//
// The axis is **Z**, matching the rest of the app and matching a CNC lathe:
// Z runs along the bar, X is the cross-slide. Internally X is a *radius*,
// because that is what the geometry is; the lathe post doubles it on the way
// out, because that is what a lathe control expects. Getting that boundary
// wrong is the classic way to cut a part twice as deep as intended, so it lives
// in exactly one place — see post/lathe.js.

import { computeBounds } from '../geom/mesh.js';

/**
 * The widest step a part is sampled at for machining it: where a shoulder's
 * face can be wrong by, so also what a check of a pass against the part is
 * measured on.
 */
export const PROFILE_STEP = 0.02;

/** The most samples a profile is given, however long the part. */
const MAX_PROFILE_SAMPLES = 15000;

/**
 * The part's turning profile: the largest radius at each position along the
 * axis.
 *
 * Taken as the *envelope* rather than a true section, so a part that is not
 * quite a solid of revolution — a hex bar, a part with a flat milled on it —
 * still turns to the shape that contains it, which is the only answer a lathe
 * could give anyway.
 *
 * The maximum radius over a triangle at a given Z is attained on the triangle's
 * boundary (radius is convex, so on a segment it peaks at an end), so sampling
 * where the edges cross each Z plane is exact for the envelope rather than an
 * approximation of it.
 *
 * @param samples how many samples along the part, at least
 * @param maxStep the widest a sample may be, mm. A step in the diameter is
 *   placed to the nearest sample (and then dilated by one, below), so a
 *   shoulder's face lands up to a sample from where the drawing has it: 600
 *   samples along a 300mm shaft was a shoulder 0.7mm out in length, with no
 *   message, on the one dimension a finishing pass exists to hold.
 * @returns { z: Float32Array, r: Float32Array, zMin, zMax, dz, maxRadius }
 */
export function turningProfile(mesh, { samples = 400, maxStep = Infinity } = {}) {
  const { positions, indices } = mesh;
  const bounds = computeBounds(positions);
  const zMin = bounds.min[2];
  const zMax = bounds.max[2];
  const n = Math.max(2, Math.round(samples),
    Math.min(MAX_PROFILE_SAMPLES, Math.ceil((zMax - zMin) / maxStep) + 1) || 0);
  const dz = (zMax - zMin) / (n - 1) || 1;

  const r = new Float32Array(n);
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = zMin + i * dz;

  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    for (let e = 0; e < 3; e++) {
      const a = v[e];
      const b = v[(e + 1) % 3];
      const az = positions[a + 2];
      const bz = positions[b + 2];
      const ar = Math.hypot(positions[a], positions[a + 1]);
      const br = Math.hypot(positions[b], positions[b + 1]);
      const span = bz - az;
      if (Math.abs(span) < 1e-12) {
        // an edge lying in one Z plane: it contributes at the sample it is on
        const i = Math.round((az - zMin) / dz);
        if (i >= 0 && i < n) {
          if (ar > r[i]) r[i] = ar;
          if (br > r[i]) r[i] = br;
        }
        continue;
      }
      const i0 = Math.max(0, Math.ceil((Math.min(az, bz) - zMin) / dz));
      const i1 = Math.min(n - 1, Math.floor((Math.max(az, bz) - zMin) / dz));
      for (let i = i0; i <= i1; i++) {
        const f = (z[i] - az) / span;
        const radius = ar + (br - ar) * f;
        if (radius > r[i]) r[i] = radius;
      }
    }
  }

  // Dilate by one sample. A local bulge that peaks between two planes is missed
  // by both, and a profile that understates the part by half a sample is a
  // finishing pass that cuts into it. Overstating leaves material, which is the
  // failure you can fix at the machine.
  const dilated = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    dilated[i] = Math.max(r[Math.max(0, i - 1)], r[i], r[Math.min(n - 1, i + 1)]);
  }

  let maxRadius = 0;
  for (const value of dilated) if (value > maxRadius) maxRadius = value;
  return { z, r: dilated, zMin, zMax, dz, maxRadius, samples: n };
}

/**
 * The profile's radius at any Z, interpolated; 0 past either end of the part.
 *
 * "Past the end" is judged with half a sample of slack, and that slack is the
 * whole point. A caller stepping along the profile by `dz` accumulates float
 * error and overshoots the last sample by a fraction of a micron; answering
 * that with 0 says "no material here", which is the one answer that is
 * dangerous — it let a roughing pass conclude the part was a point and drive
 * the tool to the axis.
 */
export function radiusAtZ(profile, at) {
  const { zMin, dz, r, samples } = profile;
  const zMax = zMin + dz * (samples - 1);
  if (at < zMin - dz / 2 || at > zMax + dz / 2) return 0;
  const t = (at - zMin) / dz;
  const i = Math.min(samples - 2, Math.max(0, Math.floor(t)));
  const f = Math.min(1, Math.max(0, t - i));
  return r[i] + (r[i + 1] - r[i]) * f;
}

/** Every sample of the profile between two Z values, inclusive. */
export function profileRange(profile, zLo, zHi) {
  const { zMin, dz, r, samples } = profile;
  const from = Math.max(0, Math.floor((Math.min(zLo, zHi) - zMin) / dz));
  const to = Math.min(samples - 1, Math.ceil((Math.max(zLo, zHi) - zMin) / dz));
  const out = [];
  for (let i = from; i <= to; i++) out.push([zMin + i * dz, r[i]]);
  return out;
}

/**
 * The bar the part is turned from, as a radius and a Z range.
 *
 * Taken from the setup's cylinder stock when there is one, and from the part
 * plus a margin when there is not — a turned part with no bar defined is still
 * a turned part, and refusing to plan it is not more correct than assuming the
 * smallest bar it fits in.
 */
export function barFromStock(stock, profile, margin = 1) {
  const fallbackRadius = profile.maxRadius + margin;
  if (!stock) {
    return {
      radius: fallbackRadius, innerRadius: 0,
      zMin: profile.zMin, zMax: profile.zMax + margin,
    };
  }
  const round = stock.cylinder?.diameter > 0
    && (stock.kind === 'cylinder' || stock.kind === 'tube');
  const radius = round
    ? stock.cylinder.diameter / 2
    // a box billet turned on a lathe is round by the time it matters; the
    // largest bar that fits inside it is the honest reading
    : Math.max(fallbackRadius,
      Math.min(stock.max[0] - stock.min[0], stock.max[1] - stock.min[1]) / 2);
  // A tube's bore is material that is not there. Turning strategies use it to
  // stop roughing air, and the simulation uses it to draw the hole.
  const innerRadius = round && stock.cylinder.innerDiameter > 0
    ? Math.min(stock.cylinder.innerDiameter / 2, radius - 0.005)
    : 0;
  return { radius, innerRadius, zMin: stock.min[2], zMax: stock.max[2] };
}

/**
 * The part's *bore*: the smallest radius at each position along the axis, where
 * there is one.
 *
 * The outer profile is an envelope and can be taken from any triangle that
 * crosses a Z plane. A bore cannot: on a solid shaft the only surface at a given
 * Z is the outside, and reading the minimum radius there would report the OD as
 * a hole. So a sample only counts as bored when the surface at that Z has *two*
 * distinct radii with clear air between them — an inner wall and an outer one.
 *
 * Samples with no bore come back as 0, which reads as "solid here" everywhere
 * downstream, and the ends of the part come back 0 too: the end face is a
 * surface spanning every radius from the axis outward, which is not a hole.
 *
 * @returns { z, r, zMin, zMax, dz, samples } with r = 0 where the part is solid
 */
export function boreProfile(mesh, { samples = 400, minGap = 0.2, maxStep = Infinity } = {}) {
  const { positions, indices } = mesh;
  const bounds = computeBounds(positions);
  const zMin = bounds.min[2];
  const zMax = bounds.max[2];
  const n = Math.max(2, Math.round(samples),
    Math.min(MAX_PROFILE_SAMPLES, Math.ceil((zMax - zMin) / maxStep) + 1) || 0);
  const dz = (zMax - zMin) / (n - 1) || 1;

  const inner = new Float32Array(n).fill(Infinity);
  const outer = new Float32Array(n);
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = zMin + i * dz;

  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    for (let e = 0; e < 3; e++) {
      const a = v[e];
      const b = v[(e + 1) % 3];
      const az = positions[a + 2];
      const bz = positions[b + 2];
      const ar = Math.hypot(positions[a], positions[a + 1]);
      const br = Math.hypot(positions[b], positions[b + 1]);
      const span = bz - az;
      if (Math.abs(span) < 1e-12) continue;   // an edge in one plane says nothing here
      const i0 = Math.max(0, Math.ceil((Math.min(az, bz) - zMin) / dz));
      const i1 = Math.min(n - 1, Math.floor((Math.max(az, bz) - zMin) / dz));
      for (let i = i0; i <= i1; i++) {
        const f = (z[i] - az) / span;
        const radius = ar + (br - ar) * f;
        if (radius < inner[i]) inner[i] = radius;
        if (radius > outer[i]) outer[i] = radius;
      }
    }
  }

  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = inner[i];
    // a wall thin enough to be measurement noise is not a bore, and a "bore"
    // that reaches the axis is an end face seen edge on
    r[i] = Number.isFinite(lo) && lo > minGap && outer[i] - lo > minGap ? lo : 0;
  }
  // Erode by one sample, the mirror of the outer profile's dilation: a bore
  // overstated by half a sample is a boring bar cutting into the wall it was
  // supposed to leave, and understating leaves material you can take off later.
  const eroded = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = r[Math.max(0, i - 1)];
    const b = r[i];
    const c = r[Math.min(n - 1, i + 1)];
    eroded[i] = a === 0 || b === 0 || c === 0 ? 0 : Math.min(a, b, c);
  }
  return { z, r: eroded, zMin, zMax, dz, samples: n };
}

/**
 * How far a drill down the axis would open up a bore the part already has.
 *
 * A turned part's bore is drilled first and bored after, and the drill is
 * picked as the biggest in the rack. Where that is wider than the narrowest
 * section of the finished bore it goes down, it cuts that section oversize —
 * and no later pass can put the metal back. Only the drill's full diameter
 * counts: its point is in the cone at the bottom, which is where a drilled hole
 * ends anyway.
 *
 * @param profile a boreProfile of the part
 * @param drill { diameter, tipLength } — how far its point runs below the full
 *   diameter
 * @param zTop, zBottom where the hole starts, and how deep the point goes
 * @returns { oversize, bore } — millimetres over on the diameter (0 when it
 *   fits) and the narrowest diameter it passes, or null where it passes none
 */
export function drillOversize(profile, { diameter, tipLength = 0 }, zTop, zBottom) {
  const { zMin, dz, r, samples } = profile;
  const from = Math.min(zTop, zBottom) + Math.max(0, tipLength);
  const to = Math.max(zTop, zBottom);
  let narrowest = Infinity;
  for (let i = 0; i < samples; i++) {
    const z = zMin + i * dz;
    if (z < from - 1e-9 || z > to + 1e-9 || !(r[i] > 0)) continue;
    if (r[i] < narrowest) narrowest = r[i];
  }
  if (!Number.isFinite(narrowest)) return { oversize: 0, bore: null };
  return { oversize: Math.max(0, diameter - 2 * narrowest), bore: 2 * narrowest };
}

/**
 * The narrowest *section* of the part's own bore over a Z range, as a radius —
 * the hole a drill leaves, or a tube arrives with; 0 when there is none.
 *
 * A parallel section, not a sample and not a stretch below some size. Every
 * bore ends in a drill point or a radius, and those pass through every radius
 * down to nothing on the way: the smallest sample on the test shaft's ⌀16/⌀12
 * bore is the tip of its drill point, and the whole taper below ⌀10 is 2.5mm
 * long, so neither the bare minimum nor a run-length floor answers it. What a
 * drill leaves is a *parallel* section, so that is what is looked for — ⌀12
 * over 13mm there, and nothing constant anywhere on the taper.
 *
 * One answer for both places that ask: the boring pass's pilot, and the
 * setup's "fit the tube to the part" — which asked the bare minimum and offered
 * the test shaft a tube with a ⌀0.54 hole.
 */
export function boreNarrowestSection(bore, zLo = -Infinity, zHi = Infinity,
  minLength = 2, flat = 0.05) {
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

/** Does this profile have a bore anywhere in the Z range? */
export function hasBore(profile, zLo = -Infinity, zHi = Infinity) {
  const { zMin, dz, r, samples } = profile;
  for (let i = 0; i < samples; i++) {
    const z = zMin + i * dz;
    if (z >= zLo && z <= zHi && r[i] > 0) return true;
  }
  return false;
}

/**
 * Offset a turning profile outward by the insert's nose radius.
 *
 * A lathe insert touches the work on its nose, not at the point the drawing
 * calls the tip, so a finishing pass driven straight down the profile cuts a
 * radius short on every face and a radius deep on every diameter. What the
 * strategy needs is the path of the nose *centre*: the profile grown by the
 * nose radius, which is the curve a ball of that radius rolls along on the
 * outside of the metal.
 *
 * That curve is asked for as what it *is* — the lowest radius the nose centre
 * can stand at, for each Z, without the nose touching the part — rather than
 * built by walking the profile and fixing the corners up. Walking it was right
 * in the middle of a face and had to be patched at every corner: round a convex
 * one on an arc, trim a concave one back to where the two offsets cross. The
 * trimming carried the whole thing, and a sampled profile is full of corners a
 * hair off straight — the smear of a step, the ramp of a taper — each of which
 * trims the one before it. Measured against a brute-force check on 4800 random
 * stepped and tapered profiles with noses from 0.2mm to a ⌀10 round insert, one
 * in eight finishing paths put the nose into the part, up to 4.8mm with the
 * round insert: a ⌀10 insert dived 1.9mm into the journal below a 6mm step.
 *
 * Here every segment of the profile has a capsule round it — the offset line
 * along its upper side, and a disc of the nose radius at each end — and the
 * path is the top of the union. A convex corner is the arc of its disc, a
 * concave one is the crossing of two capsules, and a corner the nose is too big
 * to reach into is simply never visited: there is nothing to trim because
 * nothing was drawn past it.
 *
 * The top of the union is not continuous. A face the profile drops down is a
 * wall in it, and a wall is where a disc starts or stops being the highest
 * thing in reach, so both sides of it are written. Between those, the path is
 * sampled finely enough to stay within `tolerance` of the curve.
 *
 * The nose is not the whole of the insert, and given `body` — the underside of
 * the insert from `insertReach` — the path is the top of the union of that too:
 * the lowest the nose centre can stand without any of the insert being in the
 * part. Where the surface falls away behind the nose faster than the insert's
 * own edge does, the nose cannot follow it, and the path runs above it instead
 * of taking the edge through the metal. What the path then leaves is for
 * whoever planned it to say; see `unreachedBy`.
 *
 * @param points [[z, r], …] along the profile, in either direction, Z never
 *   going back on itself — a profile is a radius for every position along the bar
 * @param body [[dz, dr], …] the lowest metal of the insert at each offset along
 *   the bar from the nose centre, ascending in dz; null for the nose alone
 * @returns [[z, r], …] for the nose *centre*, in the order it was given
 */
export function offsetProfile(points, noseRadius, tolerance = 0.005, body = null) {
  if ((!(noseRadius > 0) && !body) || points.length < 2) return points.map((p) => [...p]);
  const descending = points[points.length - 1][0] < points[0][0];
  const walk = descending ? [...points].reverse() : points;

  // Repeated points carry no direction, and a zero-length segment has no
  // normal to offset along.
  const p = [];
  for (const q of walk) {
    const last = p[p.length - 1];
    if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-9) p.push([q[0], q[1]]);
  }
  if (p.length < 2) return points.map((q) => [...q]);

  // A point on the straight line between its neighbours is not a corner, and
  // the capsule round it is covered by theirs — the same path with fewer pieces
  // to ask about. A finishing pass samples a profile every hundredth of a
  // millimetre and a stepped shaft is almost all straight, so this is most of
  // the points of a long part: the cost below is every point times the points
  // within a nose radius of it, and a 300mm shaft took 7.6s with a round insert.
  // Judged against the line from the last point kept, so a run of them cannot
  // drift away from the line by a hair a point.
  const kept = [p[0]];
  for (let i = 1; i + 1 < p.length; i++) {
    const [az, ar] = kept[kept.length - 1];
    const dz = p[i + 1][0] - az;
    const dr = p[i + 1][1] - ar;
    const across = ((p[i][0] - az) * dr - (p[i][1] - ar) * dz) / Math.hypot(dz, dr);
    const along = (p[i][0] - az) * dz + (p[i][1] - ar) * dr;
    if (Math.abs(across) < 1e-7 && along > 0 && along < dz * dz + dr * dr) continue;
    kept.push(p[i]);
  }
  kept.push(p[p.length - 1]);
  p.length = 0;
  p.push(...kept);

  const rho = noseRadius;
  const n = p.length;
  // The upper side of each segment, moved out by the nose radius. Walking in +Z
  // with the metal below the curve, a segment heading (dz, dr) has the outward
  // normal (−dr, dz): straight up off a diameter, and along the bar off a face.
  const lines = [];
  for (let i = 0; i + 1 < n; i++) {
    const dz = p[i + 1][0] - p[i][0];
    const dr = p[i + 1][1] - p[i][1];
    const len = Math.hypot(dz, dr);
    const nz = (-dr / len) * rho;
    const nr = (dz / len) * rho;
    lines.push([p[i][0] + nz, p[i][1] + nr, p[i + 1][0] + nz, p[i + 1][1] + nr]);
  }

  // The insert's underside, read at any offset along the bar. It is a hull, so
  // between two of its vertices it is the straight line joining them.
  const hull = body && body.length >= 2 ? body : null;
  const underside = (dz) => {
    let lo = 0;
    let hi = hull.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (hull[mid][0] <= dz) lo = mid; else hi = mid;
    }
    const [az, ar] = hull[lo];
    const [bz, br] = hull[hi];
    return bz - az < 1e-12 ? Math.min(ar, br) : ar + ((br - ar) * (dz - az)) / (bz - az);
  };
  // First sample at or past z, by bisection: the insert is a dozen millimetres
  // long and the profile a few hundredths between samples.
  const firstAtOrPast = (z) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (p[mid][0] < z) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  // The profile's radius at z, where a vertical face has the higher of its two.
  const profileAt = (z) => {
    const i = firstAtOrPast(z);
    let best = -Infinity;
    if (i < n && Math.abs(p[i][0] - z) < 1e-12) {
      for (let k = i; k < n && Math.abs(p[k][0] - z) < 1e-12; k++) best = Math.max(best, p[k][1]);
      return best;
    }
    if (i === 0 || i === n) return -Infinity;
    const [az, ar] = p[i - 1];
    const [bz, br] = p[i];
    return ar + ((br - ar) * (z - az)) / (bz - az);
  };
  // The highest the nose centre has to be at z for the insert to clear the part.
  // The insert is straight between the vertices of its hull and the profile is
  // straight between its samples, so the worst contact is at a sample or where a
  // hull vertex lands on the profile — and nowhere else.
  const bodyTop = (z) => {
    if (!hull) return -Infinity;
    const from = z + hull[0][0];
    const to = z + hull[hull.length - 1][0];
    let best = -Infinity;
    for (let i = firstAtOrPast(from); i < n && p[i][0] <= to + 1e-12; i++) {
      best = Math.max(best, p[i][1] - underside(p[i][0] - z));
    }
    for (const [dz, dr] of hull) {
      const at = profileAt(z + dz);
      if (at > -Infinity) best = Math.max(best, at - dr);
    }
    return best;
  };

  // Only what is within a nose radius of Z can be the top there, and `p` is in
  // order of Z, so the ones that count are found by walking out from the last
  // place that was asked about.
  let near = 0;
  const topAt = (z) => {
    while (near > 0 && p[near][0] > z - 2 * rho) near--;
    while (near + 1 < n && p[near + 1][0] < z - 2 * rho) near++;
    let best = -Infinity;
    for (let i = near; i < n && p[i][0] <= z + 2 * rho + 1e-9; i++) {
      const across = z - p[i][0];
      if (Math.abs(across) <= rho) {
        best = Math.max(best, p[i][1] + Math.sqrt(Math.max(0, rho * rho - across * across)));
      }
      if (i + 1 < n) {
        const [az, ar, bz, br] = lines[i];
        const lo = Math.min(az, bz);
        const hi = Math.max(az, bz);
        if (z < lo - 1e-12 || z > hi + 1e-12) continue;
        best = Math.max(best, hi - lo < 1e-12
          ? Math.max(ar, br)
          : ar + ((br - ar) * (z - az)) / (bz - az));
      }
    }
    return Math.max(best, bodyTop(z));
  };
  // On either side of z: the top is not continuous where a face drops away.
  const EPS = 1e-9;
  const below = (z) => topAt(z - EPS);
  const above = (z) => topAt(z + EPS);

  // Where the top can change character: the profile's own samples, where a
  // disc comes into reach or goes out of it, and where an offset line starts
  // and stops.
  //
  // The path runs from where the first segment's offset starts to where the
  // last one's ends, which is not quite the span of the profile: off a face at
  // the end of the part it begins a nose radius clear of it, in the air, and
  // that is where a pass has to start from. Clipped to the profile's own span,
  // the path began on the end face with half the nose in the bar.
  const zLo = lines[0][0];
  const zHi = lines[lines.length - 1][2];
  const marks = [zLo, zHi];
  const mark = (z) => { if (z >= zLo && z <= zHi) marks.push(z); };
  for (let i = 0; i < n; i++) {
    mark(p[i][0]);
    mark(p[i][0] - rho);
    mark(p[i][0] + rho);
  }
  for (const [az, , bz] of lines) { mark(az); mark(bz); }
  marks.sort((a, b) => a - b);
  const zs = [];
  for (const z of marks) if (!zs.length || z - zs[zs.length - 1] > 1e-9) zs.push(z);

  const out = [];
  const put = (z, r) => {
    if (!Number.isFinite(r)) return;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - z) < 1e-12 && Math.abs(last[1] - r) < 1e-9) return;
    out.push([z, r]);
  };
  // Between two marks the top is smooth, so it is bisected until the chord is
  // within tolerance of it. Only the depth of the dip matters, which is why a
  // chord is judged at its middle.
  const tol = Math.max(1e-4, tolerance / 4);
  const fill = (za, ra, zb, rb, depth) => {
    if (depth <= 0 || zb - za < 1e-4) return;
    const zm = (za + zb) / 2;
    const rm = topAt(zm);
    if (!Number.isFinite(rm) || Math.abs(rm - (ra + rb) / 2) <= tol) return;
    fill(za, ra, zm, rm, depth - 1);
    put(zm, rm);
    fill(zm, rm, zb, rb, depth - 1);
  };
  const last = zs.length - 1;
  for (let k = 0; k <= last; k++) {
    const z = zs[k];
    const left = k === 0 ? -Infinity : (k === last ? topAt(z) : below(z));
    const right = k === last ? -Infinity : (k === 0 ? topAt(z) : above(z));
    if (k > 0 && out.length && Number.isFinite(left)) {
      fill(zs[k - 1], out[out.length - 1][1], z, left, 12);
    }
    if (Number.isFinite(left)) put(z, left);
    if (Number.isFinite(right)) put(z, right);
  }

  // A straight run was sampled at every mark and is the same line throughout.
  const lean = [out[0]];
  for (let i = 1; i + 1 < out.length; i++) {
    const [az, ar] = lean[lean.length - 1];
    const [bz, br] = out[i];
    const [cz, cr] = out[i + 1];
    const cross = (bz - az) * (cr - ar) - (br - ar) * (cz - az);
    const along = (bz - az) * (cz - az) + (br - ar) * (cr - ar);
    if (Math.abs(cross) < 1e-9 && along > 0) continue;
    lean.push(out[i]);
  }
  lean.push(out[out.length - 1]);
  return descending ? lean.reverse() : lean;
}

/**
 * The profile as a polyline over a Z range, coarse enough to machine and fine
 * enough to be the shape.
 *
 * @param direction -1 to walk from zMax down to zMin (the usual direction of a
 *   turning pass, working from the free end of the bar toward the chuck)
 */
export function profilePoints(profile, zStart, zEnd, { step = 0.25, direction = -1 } = {}) {
  const from = direction < 0 ? Math.max(zStart, zEnd) : Math.min(zStart, zEnd);
  const to = direction < 0 ? Math.min(zStart, zEnd) : Math.max(zStart, zEnd);
  const span = Math.abs(to - from);
  const count = Math.max(1, Math.ceil(span / Math.max(0.01, step)));
  const points = [];
  for (let i = 0; i <= count; i++) {
    const z = from + ((to - from) * i) / count;
    points.push([z, radiusAtZ(profile, z)]);
  }
  return points;
}
