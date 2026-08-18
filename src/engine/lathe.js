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
 * @returns { z: Float32Array, r: Float32Array, zMin, zMax, dz, maxRadius }
 */
export function turningProfile(mesh, { samples = 400 } = {}) {
  const { positions, indices } = mesh;
  const bounds = computeBounds(positions);
  const zMin = bounds.min[2];
  const zMax = bounds.max[2];
  const n = Math.max(2, Math.round(samples));
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
export function boreProfile(mesh, { samples = 400, minGap = 0.2 } = {}) {
  const { positions, indices } = mesh;
  const bounds = computeBounds(positions);
  const zMin = bounds.min[2];
  const zMax = bounds.max[2];
  const n = Math.max(2, Math.round(samples));
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
    eroded[i] = a === 0 || b === 0 || c === 0 ? 0 : Math.max(a, b, c);
  }
  return { z, r: eroded, zMin, zMax, dz, samples: n };
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
 * This is a curve offset, and a curve offset is not "move every point along its
 * own normal". Doing that is right in the middle of a face and wrong at both
 * ends of one, in opposite directions:
 *
 *   * At a **convex** corner — the outside corner of a shoulder — the two
 *     surfaces disagree about which way to move the corner point, and averaging
 *     them lands the nose centre a chord short of both. The corner has to be
 *     gone *round*, on an arc of the nose radius: that arc is the corner the
 *     insert leaves on the part.
 *   * At a **concave** corner — where a shoulder meets the diameter behind it —
 *     the two offsets overlap, and a point averaged between them sits *inside*
 *     the metal. Measured on a ⌀30/⌀16 shaft with a 0.4mm nose, the finishing
 *     pass dived 0.33mm into the ⌀16 journal and took 0.15mm off the shoulder
 *     face, on the one operation in the app whose whole job is to hold a size.
 *     The two offsets have to be *trimmed* to where they cross.
 *
 * Corners are told apart by which way the surface normal turns, and the walk is
 * canonicalised to ascending Z first so that "outward" is one expression rather
 * than a sign that depends on which end the pass started from.
 *
 * @param points [[z, r], …] along the profile
 * @returns [[z, r], …] for the nose *centre*, in the order it was given
 */
export function offsetProfile(points, noseRadius, tolerance = 0.005) {
  if (!(noseRadius > 0) || points.length < 2) return points.map((p) => [...p]);
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

  // Walking in +Z with the metal below the curve, the outward normal of a
  // segment heading (dz, dr) is (−dr, dz): straight up off a diameter, and
  // along the bar off a face.
  const normals = [];
  for (let i = 0; i + 1 < p.length; i++) {
    const dz = p[i + 1][0] - p[i][0];
    const dr = p[i + 1][1] - p[i][1];
    const len = Math.hypot(dz, dr);
    normals.push([-dr / len, dz / len]);
  }

  const shift = (point, n) => [point[0] + n[0] * noseRadius, point[1] + n[1] * noseRadius];
  const out = [shift(p[0], normals[0]), shift(p[1], normals[0])];

  // A concave corner is trimmed to where the two offsets cross, and that point
  // can lie further along the outgoing surface than the next few samples of it
  // do: a step in the profile is sampled as a short steep ramp, so the crossing
  // sits about a nose radius past the first millimetre of the diameter behind
  // it. `gate` is that point and the direction the path leaves it in; nothing
  // behind it is written, so the insert does not walk back down the diameter it
  // has just reached and then forward again over the same ground.
  let gate = null;
  const push = (q) => {
    if (gate) {
      if ((q[0] - gate.at[0]) * gate.dir[0] + (q[1] - gate.at[1]) * gate.dir[1] <= 1e-9) return;
      gate = null;
    }
    out.push(q);
  };

  for (let i = 1; i < normals.length; i++) {
    const a = normals[i - 1];
    const b = normals[i];
    const turn = a[0] * b[1] - a[1] * b[0];
    const start = shift(p[i], b);
    const end = shift(p[i + 1], b);
    if (turn < -1e-12) {
      // convex: the nose rolls round the corner, so the corner arc is drawn
      gate = null;
      arcAbout(out, p[i], a, b, noseRadius, tolerance);
      push(end);
    } else if (turn > 1e-12) {
      // concave: the offsets overlap, so both are cut back to where they cross
      gate = null;
      const hit = trimBack(out, start, end);
      const dz = end[0] - start[0];
      const dr = end[1] - start[1];
      const len = Math.hypot(dz, dr) || 1;
      gate = { at: hit, dir: [dz / len, dr / len] };
      push(end);
    } else {
      push(end);   // straight on
    }
  }
  return descending ? out.reverse() : out;
}

/**
 * Join `out` to the segment start→end where the two overlap, by cutting both
 * back to the point they cross. Returns the joining point.
 *
 * The overlap can run back over more than one segment — a step is sampled as a
 * short ramp, so the diameter behind a shoulder is buried under several of
 * them — so the output is trimmed until the crossing lands on a piece of it
 * that is still there.
 */
function trimBack(out, start, end) {
  while (out.length >= 2) {
    const hit = crossing(out[out.length - 2], out[out.length - 1], start, end);
    if (hit && between(hit, out[out.length - 2], out[out.length - 1])) {
      out[out.length - 1] = hit;
      return hit;
    }
    out.pop();
  }
  out.push(start);
  return start;
}

/** Is `x` on the segment a→b, to within a hair? */
function between(x, a, b) {
  const dz = b[0] - a[0];
  const dr = b[1] - a[1];
  const lenSq = dz * dz + dr * dr;
  if (lenSq < 1e-18) return false;
  const t = ((x[0] - a[0]) * dz + (x[1] - a[1]) * dr) / lenSq;
  return t > -1e-6 && t < 1 + 1e-6;
}

/**
 * The arc the nose centre sweeps round a convex corner, from normal `a` to
 * normal `b`, chorded fine enough to stay within `tolerance` of the circle.
 *
 * Chorded on the *outside* of it. An inscribed polygon's chords cut across the
 * circle by the sagitta, and here the circle is the finished corner: every
 * chord would take that much off it. Blowing the radius up by 1/cos(half a
 * step) puts the chord midpoints on the true arc and everything else outside,
 * so the error is metal left rather than metal taken.
 */
function arcAbout(out, corner, a, b, radius, tolerance) {
  const from = Math.atan2(a[1], a[0]);
  let sweep = Math.atan2(b[1], b[0]) - from;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const perStep = 2 * Math.acos(Math.max(-1, 1 - tolerance / radius));
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(1e-3, perStep)));
  const outer = radius / Math.cos(Math.abs(sweep) / (2 * steps));
  for (let k = 0; k <= steps; k++) {
    const angle = from + (sweep * k) / steps;
    out.push([corner[0] + outer * Math.cos(angle), corner[1] + outer * Math.sin(angle)]);
  }
}

/** Where the infinite lines through a→b and c→d cross, or null if they do not. */
function crossing(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const denominator = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denominator) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / denominator;
  return [a[0] + r[0] * t, a[1] + r[1] * t];
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
