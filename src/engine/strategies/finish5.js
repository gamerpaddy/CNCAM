// Simultaneous 5-axis surface finishing — the 5-axis beta's first strategy.
//
// A 3-axis finish drops a vertical cutter onto the part and lets the surface
// decide how it is met: on a steep wall it meets it with the flank of a ball,
// near the top of the cut, and on the flat it meets it with the dead centre of
// the ball, where the cutting speed is nothing at all. Tilting the cutter lets
// the *tool* decide: lean it so a different part of the ball does the cutting,
// or so the holder stays clear of a wall, or so a flat-ended cutter keeps its
// edge flat to the surface — and keep leaning it, differently, at every point.
//
// What is the same as the 3-axis finish is how the path is found. It is a raster
// over the part (parallel3d.js): rows at a stepover, the tool's height at each
// point taken from the drop-cutter on the part's heightmap, so the cutter
// *cannot* gouge the surface — for the tool as it is leaning at that point,
// which is the whole difference. The drop-cutter kernel is the one for the
// tilted cutter (five/tilt-kernel.js), solved from the same silhouette every
// other consumer of the cutter's shape reads.
//
// What is new is the axis:
//
//   * the cutter leans from the **surface normal** by a lead angle (back along
//     the feed, so the tip rather than the dead centre of a ball is cutting) and
//     a tilt angle (to the side), or from vertical by those angles with the
//     normal ignored ("fixed");
//   * the lean is never more than `maxTilt` from vertical — the rotary axes
//     have limits, and a cutter laid nearly flat is not a finishing pass;
//   * it changes no faster than `axisRate` degrees per millimetre of path, so
//     the table is not asked to spin at the feed it was never meant to follow;
//   * and it is backed off toward vertical wherever the shank or the holder
//     would be in the part, which is the other half of why anyone tilts.
//
// The part is seen from above, as the simulation sees it. An undercut — a face
// pointing down — is not in the heightmap, so this strategy does not machine
// one, and says so (the setup assistant checks for it too).
//
// The CL carries the axis as it always has been able to (cl.js: i, j, k per
// move). This strategy never calls `cl.simplify()`, which merges collinear
// points by position alone and would forget the axis between them.

import { CLBuilder } from '../cl.js';
import { checkMotion } from '../five/motion-check.js';
import { buildHeightmap, buildToolKernel, dropCutter } from '../../geom/heightmap.js';
import { regionRefusal } from '../regions.js';
import { applyCutting } from '../cutting.js';
import {
  approach, entryPlane, clearOfRoughing, roughingNote,
} from '../heights.js';
import { finishingWindow } from './parallel3d.js';
import { toolShells, leaningKernels, buildTiltedKernel } from '../five/tilt-kernel.js';
import { chooseAngles, recentre, trunnionOf } from '../five/kinematics.js';
import { bodyTouchTilted, angleBetween, blendAxis } from '../five/tilt-sweep.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const UP = Object.freeze([0, 0, 1]);


/** How many tilted kernels are kept: one per distinct leaning, reused all over the part. */
const KERNELS = 256;

/** A table-table machine as the post will see it, for a program made without one named. */
const STANDARD_TRUNNION = {
  rotary: [
    { letter: 'A', axis: [1, 0, 0], min: -120, max: 120 },
    { letter: 'C', axis: [0, 0, 1], min: -360, max: 360 },
  ],
};

export function generateFinish5({
  mesh, tool, params: given, stock, regions, earlier = null, five = null,
}) {
  const clear = clearOfRoughing(given, earlier);
  const { params } = clear;
  const R = tool.diameter / 2;
  const step = Math.max(0.05, (params.stepover ?? 0.1) * tool.diameter);
  const tolerance = params.tolerance ?? 0.01;
  const clearance = params.clearanceHeight;
  const stockToLeave = params.stockToLeave ?? 0;
  const oneWay = (params.pattern ?? 'zigzag') === 'oneway';
  const angle = ((params.angleDeg ?? 0) * Math.PI) / 180;
  const feedPlane = entryPlane(params, params.topZ, params.bottomZ);
  const lead = (params.leadAngle ?? 0) * RAD;
  const side = (params.tiltAngle ?? 0) * RAD;
  const maxTilt = Math.min(85, Math.max(0, params.maxTilt ?? 35)) * RAD;
  const fixed = params.tiltMode === 'fixed';
  const maxTurn = Math.max(0.5, params.axisRate ?? 40);
  const followFrom = Math.min(45, Math.max(0, params.flatBelow ?? 12)) * RAD;
  const axisTol = Math.min(45, Math.max(0, params.axisTol ?? 8)) * RAD;

  const cl = new CLBuilder();
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);
  roughingNote(cl, clear, tool);

  if (!(mesh?.positions?.length)) {
    cl.warn('5-axis finishing works from the part, and there is none to follow');
    return cl.finish();
  }

  // The grid is as fine as the pass needs to be: the tip's height is read at the
  // cell nearest the tip, so a coarse grid is a lateral error times the slope.
  const cellSize = Math.max(tolerance, Math.min(step / 5, R / 8, 0.15));
  const meshBox = boundsOf(mesh.positions);
  const map = buildHeightmap(mesh, {
    cellSize,
    bounds: {
      min: [meshBox.min[0] - R - cellSize, meshBox.min[1] - R - cellSize, meshBox.min[2]],
      max: [meshBox.max[0] + R + cellSize, meshBox.max[1] + R + cellSize, meshBox.max[2]],
    },
    floor: -Infinity,
  });
  const top = meshBox.max[2] + stockToLeave;
  const rise = Math.min(60, meshBox.max[2] - meshBox.min[2] + 2 * R);

  const scope = finishingWindow({
    mesh, stock, regions, params, radius: R, tolerance,
  });
  if (!scope) {
    cl.warn('5-axis finishing has nothing left to machine after the region filter');
    return cl.finish();
  }
  const { box } = scope;
  const patternCentre = () => {
    const cx=params.patternCenterX ?? (box.min[0]+box.max[0])/2;
    const cy=params.patternCenterY ?? (box.min[1]+box.max[1])/2;
    if(!Number.isFinite(cx) || !Number.isFinite(cy)) throw new Error('5-axis pattern centre must contain finite coordinates');
    const radius=Math.hypot(Math.max(Math.abs(box.min[0]-cx),Math.abs(box.max[0]-cx)),
      Math.max(Math.abs(box.min[1]-cy),Math.abs(box.max[1]-cy)));
    return {cx,cy,radius};
  };


  const shells = toolShells(tool);
  const upright = buildToolKernel(tool, map.cellSize);

  // --- the cutter as it leans: a kernel per leaning, kept ---------------------

  const kernels = leaningKernels(shells.cutting, map.cellSize, rise);
  const cache = new Map();
  /**
   * The axis snapped to a grid of leanings, with the kernel for it.
   *
   * The CL carries the *snapped* axis, so what the drop-cutter cleared is what
   * the program says. A degree of tilt and two of arc round it is finer than any
   * machine's rotary resolution is worth, and coarse enough that a curved part
   * asks for a couple of thousand kernels rather than one per point — each of
   * which is a table read through a rotation (five/tilt-kernel.js leaningKernels).
   */
  const leaning = (axis) => {
    const tilt = Math.acos(Math.min(1, Math.max(-1, axis[2]))) * DEG;
    if (tilt < 0.5) return { axis: UP, kernel: upright };
    const tiltQ = Math.round(tilt);
    const azStep = Math.min(30, Math.max(2, 2 / Math.sin(tiltQ * RAD)));
    const az = Math.round((Math.atan2(axis[1], axis[0]) * DEG) / azStep) * azStep;
    const key = `${tiltQ}|${az}`;
    let hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const a = [
      Math.sin(tiltQ * RAD) * Math.cos(az * RAD),
      Math.sin(tiltQ * RAD) * Math.sin(az * RAD),
      Math.cos(tiltQ * RAD),
    ];
    hit = { axis: a, kernel: kernels.kernel(tiltQ, az) };
    cache.set(key, hit);
    if (cache.size > KERNELS) cache.delete(cache.keys().next().value);
    return hit;
  };

  // --- where the pass may cut --------------------------------------------------

  const surfaceAt = (x, y) => {
    const z = dropCutter(map, upright, x, y);
    return Number.isFinite(z) ? z + stockToLeave : -Infinity;
  };
  const probe = scope.probeWith(surfaceAt);

  /**
   * The lowest tip at (x, y) for a cutter leaning like `lean`.
   *
   * The drop-cutter answers for the grid cell nearest the point, so read at a point
   * it is a staircase: a tip moving along a slope sees its height step by a cell's
   * worth of slope every cell, and the path that follows is a row of tiny stairs —
   * thirty thousand points where a planar slope needs two. The height is the
   * bilinear blend of the four cells round the point instead.
   */
  const tipAt = (x, y, lean, fallback) => {
    const cs = map.cellSize;
    const fx = (x - map.min[0]) / cs;
    const fy = (y - map.min[1]) / cs;
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fy);
    const u = fx - i0;
    const v = fy - j0;
    const at = (i, j) => dropCutter(map, lean.kernel, map.min[0] + i * cs, map.min[1] + j * cs);
    const z00 = at(i0, j0);
    const z10 = at(i0 + 1, j0);
    const z01 = at(i0, j0 + 1);
    const z11 = at(i0 + 1, j0 + 1);
    if (Number.isFinite(z00) && Number.isFinite(z10) && Number.isFinite(z01) && Number.isFinite(z11)) {
      return z00 * (1 - u) * (1 - v) + z10 * u * (1 - v) + z01 * (1 - u) * v + z11 * u * v + stockToLeave;
    }
    const z = dropCutter(map, lean.kernel, x, y);
    return Number.isFinite(z) ? z + stockToLeave : fallback;
  };

  // --- the tilt law --------------------------------------------------------------

  // The normal is the surface's *slope over the patch the cutter touches*, not its
  // slope at one cell. A mesh is facets, and a heightmap is a staircase of them:
  // read at a point the gradient jumps at every crease and every cell edge, and the
  // axis that follows it jumps with it. A ball nose cannot feel anything narrower
  // than a fraction of its own radius, so that is the scale the slope is measured
  // at — a plane fitted by least squares to the heights within it.
  const patch = Math.max(2, Math.min(12, Math.round((0.45 * R) / map.cellSize)));
  // how far a cell may stand off the fitted plane and still count as the same surface
  const tau = Math.max(0.1, 0.06 * R, 3 * map.cellSize);
  const cells = [];
  /** The surface's unit normal at (x, y), or null where the map has no surface to read. */
  const normalAt = (x, y) => {
    const ci = Math.round((x - map.min[0]) / map.cellSize);
    const cj = Math.round((y - map.min[1]) / map.cellSize);
    cells.length = 0;
    let total = 0;
    for (let dj = -patch; dj <= patch; dj++) {
      for (let di = -patch; di <= patch; di++) {
        if (di * di + dj * dj > patch * patch) continue;
        total++;
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= map.width || j >= map.height) continue;
        const h = map.data[j * map.width + i];
        if (h === map.floor) continue;
        cells.push(di * map.cellSize, dj * map.cellSize, h);
      }
    }
    // a patch that is mostly off the part says nothing about its slope
    if (cells.length / 3 < 0.6 * total) return null;
    // The surface the cutter is on is the plane most of the patch lies on. Several
    // first guesses are refitted — each reweighing the cells by how close they are to
    // the plane — and the one that ends up explaining the most of the patch wins:
    //
    //   * the cells nearest the point, fitted flat out — right on a slope;
    //   * every cell — right on a face of any size;
    //   * level with the cell under the point — right at the edge of a tread, where a
    //     fit over its neighbourhood sees a riser and a drop as well and reports a slope
    //     that is neither;
    //   * level with the median height — right where the point itself is the odd one out.
    //
    // A plain least-squares plane has none of this: a cutter at the foot of a wall was
    // leaned 45° over on a floor that is flat, because the wall was in the patch.
    const inner = (Math.max(1.5, patch / 3) * map.cellSize) ** 2;
    const heights = [];
    for (let n = 0; n < cells.length; n += 3) heights.push(cells[n + 2]);
    heights.sort((p, q) => p - q);
    const median = heights[heights.length >> 1];
    let under = median;
    let nearest = Infinity;
    for (let n = 0; n < cells.length; n += 3) {
      const d2 = cells[n] * cells[n] + cells[n + 1] * cells[n + 1];
      if (d2 < nearest) { nearest = d2; under = cells[n + 2]; }
    }

    /** Weighted least squares of z = a·x + b·y + c, weights from `weigh(dx, dy, h)`. */
    const fit = (weigh) => {
      let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, sw = 0, sxz = 0, syz = 0, sz = 0;
      for (let n = 0; n < cells.length; n += 3) {
        const dx = cells[n], dy = cells[n + 1], h = cells[n + 2];
        const w = weigh(dx, dy, h);
        if (w === 0) continue;
        sxx += w * dx * dx; sxy += w * dx * dy; sx += w * dx; syy += w * dy * dy; sy += w * dy; sw += w;
        sxz += w * dx * h; syz += w * dy * h; sz += w * h;
      }
      // the 3x3 normal equations, by Cramer's rule
      const det = sxx * (syy * sw - sy * sy) - sxy * (sxy * sw - sy * sx) + sx * (sxy * sy - syy * sx);
      if (Math.abs(det) < 1e-12 * Math.max(1, sw * sw * sw)) return null;
      return [
        (sxz * (syy * sw - sy * sy) - sxy * (syz * sw - sy * sz) + sx * (syz * sy - syy * sz)) / det,
        (sxx * (syz * sw - sy * sz) - sxz * (sxy * sw - sy * sx) + sx * (sxy * sz - syz * sx)) / det,
        (sxx * (syy * sz - sy * syz) - sxy * (sxy * sz - sx * syz) + sxz * (sxy * sy - syy * sx)) / det,
      ];
    };
    const robust = (p) => (dx, dy, h) => {
      const r = (h - (p[0] * dx + p[1] * dy + p[2])) / tau;
      return 1 / (1 + r * r * r * r);
    };
    const explained = (p) => {
      let sum = 0;
      const w = robust(p);
      for (let n = 0; n < cells.length; n += 3) sum += w(cells[n], cells[n + 1], cells[n + 2]);
      return sum;
    };
    const guesses = [
      fit((dx, dy) => (dx * dx + dy * dy <= inner ? 1 : 0)),
      fit(() => 1),
      [0, 0, under],
      [0, 0, median],
    ];
    let best = null;
    let bestScore = -1;
    for (let plane of guesses) {
      if (!plane) continue;
      for (let pass = 0; pass < 4; pass++) plane = fit(robust(plane)) ?? plane;
      const score = explained(plane);
      if (score > bestScore) { bestScore = score; best = plane; }
    }
    if (!best) return null;
    const n = Math.hypot(best[0], best[1], 1);
    return [-best[0] / n, -best[1] / n, 1 / n];
  };

  /**
   * A normal for every point of a run, taking the nearest known one where the surface
   * cannot be read.
   *
   * The edge of the part is where the patch the slope is measured over runs off it,
   * and answering "no normal" there put the cutter upright for the last few
   * millimetres of every row — a jump from the lean the surface asked for to none,
   * at the very place the cutter is swinging out over the edge. The surface does not
   * change direction because the grid ran out; the last slope read is the best
   * account of it.
   */
  const filled = (normals) => {
    const out = normals.slice();
    let last = null;
    for (let i = 0; i < out.length; i++) { if (out[i]) last = out[i]; else if (last) out[i] = last; }
    last = null;
    for (let i = out.length - 1; i >= 0; i--) { if (out[i]) last = out[i]; else if (last) out[i] = last; }
    return out;
  };

  /** Lean `axis` toward vertical by `scale` (1 = as it is, 0 = upright). */
  const eased = (axis, scale) => {
    if (scale >= 1) return axis;
    const h = Math.hypot(axis[0], axis[1]);
    if (h < 1e-9) return axis;
    const tilt = Math.acos(Math.min(1, Math.max(-1, axis[2]))) * scale;
    return [Math.sin(tilt) * axis[0] / h, Math.sin(tilt) * axis[1] / h, Math.cos(tilt)];
  };

  /**
   * The surface normal with its sideways lean faded out where the surface is gentle.
   *
   * What the lean does along the feed is the lead's business and is kept whole. What
   * it does *across* the feed is the direction the surface faces, and on a gentle
   * slope that direction turns fast while the slope barely changes: a dome's crown
   * is a degree of lean that faces every way in turn, and following it is half a turn
   * of the turntable for nothing the cutter can feel. So the across-feed lean is
   * weighted by how steep the surface is, from none at `flatBelow` to all of it
   * twice that — which costs the cutter at most a few degrees off the normal where
   * the normal is nearly vertical anyway, and the turntable the whole swing.
   */
  const gentled = (normal, heading) => {
    if (followFrom <= 0) return normal;
    const lean = Math.hypot(normal[0], normal[1]);
    const slope = Math.asin(Math.min(1, lean));
    const t = Math.min(1, Math.max(0, (slope - followFrom) / followFrom));
    const w = t * t * (3 - 2 * t);
    if (w >= 1 || lean < 1e-9) return normal;
    const along = normal[0] * heading[0] + normal[1] * heading[1];
    const across = (-normal[0] * heading[1] + normal[1] * heading[0]) * w;
    const hx = along * heading[0] - across * heading[1];
    const hy = along * heading[1] + across * heading[0];
    return [hx, hy, Math.sqrt(Math.max(0, 1 - hx * hx - hy * hy))];
  };

  /**
   * The axis the law asks for at a point: the surface normal (or vertical),
   * leaned back from the feed by `lead` and to the side by `side`, and never
   * further than `maxTilt` from vertical.
   */
  const lawAxis = (normal, heading) => {
    const base = fixed || !normal ? UP : gentled(normal, heading);
    // the feed direction, in the plane square to the base
    const dot = heading[0] * base[0] + heading[1] * base[1];
    let f = [heading[0] - dot * base[0], heading[1] - dot * base[1], -dot * base[2]];
    const fl = Math.hypot(f[0], f[1], f[2]);
    f = fl > 1e-9 ? [f[0] / fl, f[1] / fl, f[2] / fl] : [1, 0, 0];
    // to the left of the feed, looking down the base
    const s = [base[1] * f[2] - base[2] * f[1], base[2] * f[0] - base[0] * f[2], base[0] * f[1] - base[1] * f[0]];
    const cl_ = Math.cos(lead);
    const sl = Math.sin(lead);
    // back along the feed by the lead…
    const a1 = [base[0] * cl_ - f[0] * sl, base[1] * cl_ - f[1] * sl, base[2] * cl_ - f[2] * sl];
    // …and to the left by the tilt
    const ct = Math.cos(side);
    const st = Math.sin(side);
    let a = [a1[0] * ct + s[0] * st, a1[1] * ct + s[1] * st, a1[2] * ct + s[2] * st];
    const n = Math.hypot(a[0], a[1], a[2]) || 1;
    a = [a[0] / n, a[1] / n, a[2] / n];
    if (a[2] < 0) a = [a[0], a[1], 0.0];
    const tilt = Math.acos(Math.min(1, Math.max(-1, a[2])));
    return tilt > maxTilt ? eased(a, maxTilt / tilt) : a;
  };

  /**
   * Smooth the lean along a run: a Gaussian over about a third of the cutter's
   * radius, applied to the lean *vector* (the horizontal part of the axis).
   *
   * What the law asks for is as noisy as the surface under it, and a ball nose
   * cannot follow detail finer than itself anyway — the contact patch is a
   * fraction of the radius wide. Averaging the vector rather than the angles is
   * what lets it cross the pole: two leans on either side of vertical average to a
   * lean near vertical, where averaging their azimuths would give one of the two
   * directions it is not.
   */
  const smoothLean = (axes, samples, closed = false) => {
    if (axes.length < 3) return axes;
    const arc = new Float64Array(samples.length);
    for(let i=1;i<samples.length;i++) arc[i]=arc[i-1]+Math.hypot(
      samples[i][0]-samples[i-1][0],samples[i][1]-samples[i-1][1],samples[i][2]-samples[i-1][2]);
    const period=axes.length-1,total=arc[period];
    const sigma=Math.max(0.8*ds,0.35*R);
    const radius=closed ? Math.min(14,Math.floor((period-1)/2)) : 14;
    return axes.map((_,i)=>{
      let hx=0,hy=0,w=0;
      for(let k=-radius;k<=radius;k++){
        const j=closed ? ((i+k)%period+period)%period : i+k;
        if(j<0||j>=axes.length)continue;
        let distance=Math.abs(arc[j]-arc[i]);
        if(closed)distance=Math.min(distance,Math.max(0,total-distance));
        const weight=Math.exp(-(distance*distance)/(2*sigma*sigma));
        hx+=axes[j][0]*weight;hy+=axes[j][1]*weight;w+=weight;
      }
      hx/=w;hy/=w;
      return [hx,hy,Math.sqrt(Math.max(0,1-hx*hx-hy*hy))];
    });
  };

  /**
   * Turn the turntable as little as the cutter's freedom allows.
   *
   * The lean the law asks for is a vector that wanders about the pole — where a surface
   * rolls gently, the lead and the slope cancel and re-emerge again and again — and
   * every time it passes near the middle its direction swings through half a turn. The
   * turntable follows the *direction*. But a ball nose does not care to the degree: an
   * axis a dozen degrees off the normal cuts the same surface with the same ball, and the
   * only thing that moves is the point on it that does the cutting. So the direction is
   * free to stray from where the law put it by as much as keeps the axis within
   * `axisTol` of the law's — and close to the pole, where a half turn of direction is a
   * degree or two of axis, that is *all* of it.
   *
   * What is wanted of the direction inside that freedom is the least turning, which is
   * the shortest string through the tube it is allowed to lie in: pulled straight, and
   * touching the tube's sides only where it must bend. That is found by relaxation —
   * each point toward the middle of its neighbours, then back inside its own bounds —
   * which settles on it. The lean's size is not touched, only which way it faces, so
   * a lean that was following a slope exactly goes on doing so.
   */
  /**
   * The direction of each lean made continuous, a half turn at a time, *through* the
   * stretches where it is free. A lean within the tolerance of vertical has no
   * direction worth keeping — any line through the pole lies within reach of it — so
   * it must not carry one: a lean that passes the pole at two degrees sweeps through
   * a whole half turn there, and following that is the turntable spinning for nothing.
   * The directions on either side are joined the short way instead (a lean on the far
   * side of the pole being the same line with its sign turned).
   *
   * @returns { psi, free } — the unwrapped direction (the last known one, at a free
   *   point) and whether the point is free
   */
  const halfTurn = (axes, reach) => {
    const n = axes.length;
    const psi = new Float64Array(n);
    const free = new Uint8Array(n);
    let last = null;
    for (let i = 0; i < n; i++) {
      const m = Math.hypot(axes[i][0], axes[i][1]);
      if (m <= reach[i]) { free[i] = 1; psi[i] = last ?? 0; continue; }
      let target = Math.atan2(axes[i][1], axes[i][0]);
      if (last !== null) {
        let d = target - last;
        d -= Math.PI * Math.round(d / Math.PI);
        target = last + d;
      }
      psi[i] = target;
      last = target;
    }
    // a run that starts free takes the direction of the first point that is not
    const first = free.indexOf(0);
    if (first > 0) for (let i = 0; i < first; i++) psi[i] = psi[first];
    return { psi, free };
  };

  const relaxLean = (axes) => {
    const n = axes.length;
    if (n < 3 || axisTol <= 0) return axes;
    const sinTol = Math.sin(axisTol);
    // the distance in the plane of the lean that the axis may move: an axis `axisTol`
    // away is no further than that, and a little less where the lean is steep
    const reach = axes.map((a) => sinTol * Math.max(0.2, a[2]));
    const { psi, free } = halfTurn(axes, reach);
    // how far the direction may turn before the line it makes is out of reach of the lean
    const room = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const m = Math.hypot(axes[i][0], axes[i][1]);
      room[i] = free[i] ? 4 * Math.PI : Math.asin(Math.min(1, reach[i] / m));
    }
    const lo = Array.from(psi, (v, i) => v - room[i]);
    const hi = Array.from(psi, (v, i) => v + room[i]);
    // free points start on the straight line between their neighbours that are not
    const at = Float64Array.from(psi);
    // Fill each free interval once. Scanning left and right independently at
    // every free point was quadratic on long near-vertical spiral sections.
    for (let i = 0; i < n;) {
      if (!free[i]) { i++; continue; }
      const start = i;
      while (i < n && free[i]) i++;
      const left = start - 1, right = i;
      for (let k = start; k < right; k++) {
        if (left >= 0 && right < n) at[k] = psi[left] + (psi[right] - psi[left]) * (k - left) / (right - left);
        else if (left >= 0) at[k] = psi[left];
        else if (right < n) at[k] = psi[right];
      }
    }
    // the shortest string through the tube: each point toward the middle of its
    // neighbours (over-relaxed, since the string is long), then back inside its bounds
    for (let round = 0; round < 1500; round++) {
      let moved = 0;
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 0; k < n; k++) {
          const i = pass === 0 ? k : n - 1 - k;
          const left = at[Math.max(0, i - 1)];
          const right = at[Math.min(n - 1, i + 1)];
          const next = Math.min(hi[i], Math.max(lo[i], at[i] + 1.85 * ((left + right) / 2 - at[i])));
          moved = Math.max(moved, Math.abs(next - at[i]));
          at[i] = next;
        }
      }
      if (moved < 1e-6) break;
    }
    // the lean along the string: the part of the wanted lean that lies on it
    return axes.map((a, i) => {
      const c = Math.cos(at[i]);
      const s_ = Math.sin(at[i]);
      const h = Math.max(-0.999999, Math.min(0.999999, a[0] * c + a[1] * s_));
      return [h * c, h * s_, Math.sqrt(1 - h * h)];
    });
  };

  /**
   * Hold the axis to `maxTurn` degrees per millimetre of path, both ways along it,
   * and the direction it leans toward to twice that.
   *
   * One sweep forward and one back is not enough: pulling a point toward its
   * successor on the way back undoes the limit against its predecessor, so the
   * sweeps repeat until a whole round changes nothing. Each only moves a point
   * toward a neighbour, so it settles in a few rounds.
   */
  const limitTurn = (axes, samples) => {
    const distances = samples.map((p, i) => i ? Math.hypot(p[0]-samples[i-1][0], p[1]-samples[i-1][1], p[2]-samples[i-1][2]) : Infinity);
    const clamp = (from, to, distance) => {
      const most = maxTurn * distance;
      const turn = angleBetween(from, to);
      return turn > most ? blendAxis(from, to, most / turn) : to;
    };
    const out = limitAzimuth(axes, distances.map(d => d * 2 * maxTurn));
    for (let round = 0; round < 8; round++) {
      let moved = false;
      for (let i = 1; i < out.length; i++) {
        const next = clamp(out[i - 1], out[i], distances[i]);
        if (next !== out[i]) { out[i] = next; moved = true; }
      }
      for (let i = out.length - 2; i >= 0; i--) {
        const next = clamp(out[i + 1], out[i], distances[i+1]);
        if (next !== out[i]) { out[i] = next; moved = true; }
      }
      if (!moved) break;
    }
    return out;
  };

  /**
   * Hold the direction the cutter leans toward to `most` degrees per sweep.
   *
   * The angle limit is blind to the pole: close to vertical a lean can swing round
   * to the other side of it, two degrees of axis and a half turn of the turntable.
   * But a lean on the *opposite* side of the pole is the same lean with its sign
   * turned — the machine does it by A going through zero while C stays put — so
   * the direction is only ever a half-turn quantity: `m` is a signed lean along a
   * direction ψ, and (ψ + 180°, −m) is the same axis. Limiting ψ in those terms
   * costs nothing for a path that goes through the pole, and for one that goes
   * *near* it costs at most the size of the lean there, which is small precisely
   * where the turntable would be asked to spin. Limiting the full-turn azimuth
   * instead, which this used to do, held the lean on the wrong side of the pole
   * long after it had come out the other — thirty degrees off the surface.
   */
  const limitAzimuth = (axes, limits) => {
    const sweep = (list, reverse=false) => {
      const out = [];
      let psi = null;
      for (let index=0;index<list.length;index++) {
        const a=list[index];
        const cap=(limits[reverse ? list.length-index : index] ?? Infinity) * RAD;
        const m = Math.hypot(a[0], a[1]);
        if (m < 1e-9) { out.push(a); continue; }
        const target = Math.atan2(a[1], a[0]);
        if (psi === null) psi = target;
        // the way round a half turn that is shorter, and the sign it takes
        let d = target - psi;
        d -= Math.PI * Math.round(d / Math.PI);
        const step = Math.max(-cap, Math.min(cap, d));
        psi += step;
        const along = m * Math.cos(target - psi);
        // signed lean along ψ — the part of the wanted lean the capped direction can carry
        const lean = Math.abs(step - d) < 1e-12 ? m * Math.sign(Math.cos(target - psi) || 1) : along;
        const h = Math.min(Math.abs(lean), 0.999999) * Math.sign(lean || 1);
        out.push([h * Math.cos(psi), h * Math.sin(psi), Math.sqrt(1 - h * h)]);
      }
      return out;
    };
    // forward, then back over the result, so the lag does not all fall on one side
    return sweep(sweep(axes).reverse(),true).reverse();
  };

  // the shank and the holder against the part: the heightmap, seen as stock the
  // cutter must stay out of
  const world = {
    heights: map.data,
    mask: new Uint8Array(map.width * map.height).fill(1),
    grid: { width: map.width, height: map.height, cellSize: map.cellSize, origin: map.min },
    columns: null,
  };
  const bodyEps = Math.max(0.02, tolerance * 2);
  const bodyHits = (tip, axis) => bodyTouchTilted(world, tip, axis, shells, top + 1, bodyEps);

  // --- a row of the raster -------------------------------------------------------

  const ds = Math.max(map.cellSize, Math.min(step / 2, R / 3));
  const stats = { points: 0, tiltSum: 0, tiltMax: 0, eased: 0, held: 0, omitted: 0 };
  // Bounded verification against the strategy's discretized cutter kernels.
  // Body tests use the interpolated axis; cutting heights retain the same
  // angular/grid resolution as path generation (not continuous certification).
  const exactKernels=new Map();
  const requiredAt = (p,exact=false) => {
    if(!exact) return tipAt(p.x,p.y,leaning(p.a),-Infinity);
    const key=p.a.join(',');
    let kernel=exactKernels.get(key);
    if(!kernel) {
      const tilt=Math.acos(Math.min(1,Math.max(-1,p.a[2]))) * DEG;
      kernel=tilt<1e-7 ? upright : buildTiltedKernel(shells.cutting,p.a,map.cellSize,rise);
      exactKernels.set(key,kernel);
      if(exactKernels.size>256) exactKernels.delete(exactKernels.keys().next().value);
    }
    return tipAt(p.x,p.y,{kernel},-Infinity);
  };
  const motionCheck = (a, b) => checkMotion(a, b, {
    spacing: Math.max(0.01, Math.min(map.cellSize / 2, ds / 2)),
    check: (p) => {
      if (scope.probeWith(() => p.z)(p.x,p.y)[2] === null) return 'outside machining window';
      if (bodyHits([p.x,p.y,p.z],p.a)) return 'shank or holder collision';
      const required=requiredAt(p);
      if (Number.isFinite(required) && p.z < required - tolerance
        && p.z < requiredAt(p,true) - tolerance) return 'cutter interference';
      return null;
    },
  });


  /**
   * One run of the raster as points that carry their axis: the law, the turn
   * limit, the height the drop-cutter finds for each leaning, and the holder
   * check — easing any point it would hit toward vertical and trying again.
   */
  const solveRun = (samples, heading) => {
    const law0 = filled(samples.map((p) => normalAt(p[0], p[1]))).map((n, i) => lawAxis(n, typeof heading === 'function' ? heading(samples[i]) : heading));
    const closed = samples.length > 3 && Math.hypot(samples[0][0]-samples.at(-1)[0],samples[0][1]-samples.at(-1)[1]) < 1e-8;
    const sm0 = smoothLean(law0, samples, closed);
    const raw = relaxLean(sm0);
    if(closed) raw[0] = raw[raw.length-1] = blendAxis(raw[0],raw[raw.length-1],.5);
    const scale = new Float64Array(samples.length).fill(1);
    let leans = null;
    let z = null;
    for (let pass = 0; pass < 4; pass++) {
      const axes = limitTurn(raw.map((a, i) => eased(a, scale[i])), samples);
      if(closed) axes[0] = axes[axes.length-1] = blendAxis(axes[0],axes[axes.length-1],.5);
      leans = axes.map(leaning);
      z = samples.map((p, i) => tipAt(p[0], p[1], leans[i], p[2]));
      let clean = true;
      for (let i = 0; i < samples.length; i++) {
        if (scale[i] === 0) continue;
        if (!bodyHits([samples[i][0], samples[i][1], z[i]], leans[i].axis)) continue;
        clean = false;
        scale[i] = pass >= 2 ? 0 : scale[i] * 0.5;
      }
      if (clean) break;
    }
    const out = samples.map((p, i) => ({
      x: p[0], y: p[1], z: z[i], a: leans[i].axis,
    }));
    for (let i = 0; i < out.length; i++) {
      const tilt = Math.acos(Math.min(1, out[i].a[2])) * DEG;
      stats.points++;
      stats.tiltSum += tilt;
      if (tilt > stats.tiltMax) stats.tiltMax = tilt;
      if (scale[i] < 1) stats.eased++;
      if (bodyHits([out[i].x, out[i].y, out[i].z], out[i].a)) {
        throw new Error(`5-axis finish: shank or holder collision at X${out[i].x.toFixed(3)} Y${out[i].y.toFixed(3)} Z${out[i].z.toFixed(3)} after orientation adjustment; use a longer tool or restrict the machining region`);
      }
    }
    // The upright probe only selects candidate XY locations. Tilting changes
    // the final tip height, so apply the machining window again to that pose.
    // Preserve rejected samples as breaks: filtering them out would join across
    // a forbidden depth interval.
    const checked = out.map((p) => {
      const finalProbe = scope.probeWith(() => p.z);
      const valid = Number.isFinite(p.z) && p.z >= params.bottomZ - 1e-9
        && p.z <= params.topZ + 1e-9 && finalProbe(p.x, p.y)[2] !== null;
      return valid ? p : null;
    });
    const refined=[];
    let inserted=0;
    const appendSegment=(a,b,depth=0) => {
      const result=motionCheck(a,b);
      if(result.ok) {refined.push(b);return;}
      if(result.reason==='cutter interference' && depth<12 && inserted++<8192
        && (result.fraction<=1e-6 || result.fraction>=1-1e-6)) {
        const end=result.fraction<=1e-6 ? a : b;
        const height=requiredAt(end,true)+tolerance;
        if(height>end.z && height<=params.topZ+1e-9) {
          end.z=height;appendSegment(a,b,depth+1);return;
        }
      }
      if(result.reason==='cutter interference' && result.fraction>1e-6
        && result.fraction<1-1e-6 && depth<12 && inserted++<8192) {
        const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:(a.z+b.z)/2,a:blendAxis(a.a,b.a,.5)};
        mid.z=Math.max(mid.z,requiredAt(mid,true)+tolerance);
        if(mid.z<=params.topZ+1e-9 && mid.z>=params.bottomZ-1e-9) {
          appendSegment(a,mid,depth+1);appendSegment(mid,b,depth+1);return;
        }
      }
      if(result.reason==='cutter interference') {
        stats.omitted++;refined.push(null,b);return;
      }
      throw new Error(`5-axis finish: ${result.reason} between cutting samples near X${b.x.toFixed(3)} Y${b.y.toFixed(3)}`);
    };
    for(const p of checked) {
      const previous=refined[refined.length-1];
      if(p && previous) appendSegment(previous,p);
      else refined.push(p);
    }
    for(let i=1;i<refined.length;i++) {
      if(!refined[i-1] || !refined[i]) continue;
      const result=motionCheck(refined[i-1],refined[i]);
      if(!result.ok) {
        if(result.reason==='cutter interference') {stats.omitted++;refined.splice(i,0,null);i++;}
        else throw new Error(`5-axis finish: ${result.reason} after local refinement`);
      }
    }
    // A rejected sample must break the path, but must not disable thinning
    // for every other valid section of a long spiral.
    const simplified=[];
    let section=[];
    const flushSection=()=>{
      const reduced=thin(section,tolerance,0.5,(a,b)=>motionCheck(a,b).ok);
      for(const p of reduced) simplified.push(p);
      section=[];
    };
    for(const p of refined) {
      if(p) section.push(p);
      else {flushSection();simplified.push(null);}
    }
    flushSection();
    return simplified;
  };

  // Where the turntable will be as this is cut.
  //
  // The lean's direction makes the turntable go round, and a surface with hills and
  // hollows in it winds it one more turn each time a row goes round one — the turntable
  // has a travel, and a program that runs it into the end of that travel flips branch in the
  // middle of a cut (A through to the other sign, C half a turn back). The post cannot
  // prevent that, it only writes the angles. So this follows them: the same solver the post
  // uses, in the same order, from the same place, and where the next stretch of cut would take
  // C to within a margin of the end of its travel the tool lifts out instead. The swing at
  // clearance is where the post turns the table back within half a turn of zero.
  const machine = five?.rotary?.length ? { rotary: five.rotary } : STANDARD_TRUNNION;
  const turn = trunnionOf(machine)?.turn;
  const margin = 25;
  const roomFor = (angles) => !turn || (
    angles[turn.letter] <= (turn.max ?? Infinity) - margin
    && angles[turn.letter] >= (turn.min ?? -Infinity) + margin);
  const state = {
    cutting: false, last: null, angles: Object.fromEntries(machine.rotary.map((a) => [a.letter, 0])),
  };
  const linkMax = Math.max(0, params.linkDistance ?? tool.diameter * 3);

  const cutTo = (p) => {
    cl.setAxis(p.a[0], p.a[1], p.a[2]);
    cl.cut(p.x, p.y, p.z);
  };
  const retract = () => {
    const { x, y, a } = state.last;
    cl.setAxis(a[0], a[1], a[2]);
    cl.rapid(x, y, clearance);
    state.cutting = false;
  };
  const beginAt = (p) => {
    if (cl.count === 0) {
      // the first thing the program does is be above the work, upright
      cl.setAxis(0, 0, 1);
      cl.rapid(p.x, p.y, clearance);
    } else {
      cl.rapid(p.x, p.y, clearance);
    }
    // swing to the pass's own leaning up at clearance, where there is room to do it
    cl.setAxis(p.a[0], p.a[1], p.a[2]);
    cl.rapid(p.x, p.y, clearance);
    approach(cl, p.x, p.y, p.z, { clearance, feedPlane, positioned: true });
  };

  /**
   * The points of a straight link from one end of a run to the start of the next,
   * or null when it is not safe to stay down: the ground between has to be part
   * the pass may cut, all along it. Each point of it is dropped like any other,
   * so riding it cannot gouge.
   */
  const rideLink = (from, to) => {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist > linkMax + 1e-9) return null;
    // a link is not a run, so the turn limit has not been applied to it: where the
    // lean at one end differs from the other's by more than the rate allows over
    // this distance, the tool lifts out and swings at clearance instead
    if (angleBetween(from.a, to.a) > maxTurn * dist + 1.5) return null;
    const pieces = Math.max(1, Math.ceil(dist / ds));
    const points = [];
    for (let k = 1; k <= pieces; k++) {
      const t = k / pieces;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      const p = probe(x, y);
      if (p[2] === null) return null;
      const lean = leaning(blendAxis(from.a, to.a, t));
      const z = tipAt(x, y, lean, p[2]);
      if (!Number.isFinite(z) || z < params.bottomZ - 1e-9 || z > params.topZ + 1e-9) return null;
      if (bodyHits([x, y, z], lean.axis)) return null;
      points.push({ x, y, z, a: lean.axis });
    }
    for(let i=0;i<points.length;i++) if(!motionCheck(i ? points[i-1] : from,points[i]).ok) return null;
    return points;
  };

  /**
   * Walk points through the angle solver from `from`: the angles at each, and the index of
   * the first that leaves the turntable too little room (or -1).
   */
  const track = (points, from) => {
    let angles = from;
    for (let i = 0; i < points.length; i++) {
      const solution = chooseAngles(points[i].a, machine, angles);
      if (!solution.reachable) throw new Error(`5-axis finish: unreachable orientation at X${points[i].x.toFixed(3)} Y${points[i].y.toFixed(3)}; ${solution.reason ?? 'check rotary limits'}`);
      angles = solution.angles;
      if (!roomFor(angles)) return { end: angles, tight: i };
    }
    return { end: angles, tight: -1 };
  };

  const emitRun = (run) => {
    if (run.length === 0) return;
    if (run.includes(null)) {
      let chunk = [];
      for (const p of run) {
        if (p) chunk.push(p);
        else {
          if (chunk.length) emitRun(chunk);
          chunk = [];
          if (state.cutting) retract();
        }
      }
      if (chunk.length) emitRun(chunk);
      return;
    }
    const first = run[0];
    let link = state.cutting ? rideLink(state.last, first) : null;
    if (link) {
      // would carrying on from here take the turntable to the end of its travel?
      const through = track(link, state.angles);
      if (through.tight >= 0) link = null;
    }
    let from;
    if (link) {
      from = state.angles;
    } else {
      if (state.cutting) retract();
      beginAt(first);
      // the post turns the table back within half a turn of zero in the swing at clearance
      from = recentre(state.angles, machine);
    }
    // cut as far as the turntable has room for; the rest is a run of its own, begun from the last point
    const walked = track(run, link ? track(link, from).end : from);
    if (walked.tight === 0) throw new Error('5-axis finish: no rotary travel margin at the start of a cutting run; adjust the setup or rotary limits');
    const stop = walked.tight > 0 ? walked.tight : run.length;
    if (link) for (const p of link) cutTo(p);
    for (let k = link ? 0 : 1; k < stop; k++) cutTo(run[k]);
    state.cutting = true;
    state.last = run[stop - 1];
    state.angles = track(run.slice(0, stop), link ? track(link, from).end : from).end;
    if (stop < run.length) {
      // out of room: lift out, and take up again from the point the cut got to
      retract();
      state.angles = recentre(state.angles, machine);
      emitRun(run.slice(stop - 1));
    }
  };

  // --- the raster ----------------------------------------------------------------

  if (params.pattern === 'spiral' || params.pattern === 'radial') {
    const {cx,cy,radius} = patternCentre();
    const spiral = params.pattern === 'spiral';
    let samples = [];
    let sampled = 0;
    let radialHeading = [1, 0];
    const heading = p => {
      const x = p[0] - cx, y = p[1] - cy;
      const r = Math.hypot(x, y);
      if (!spiral) return radialHeading;
      const a = Math.atan2(y, x), dr = step / (2 * Math.PI);
      const dx = -dr * Math.cos(a) - r * Math.sin(a);
      const dy = -dr * Math.sin(a) + r * Math.cos(a);
      const length = Math.hypot(dx, dy);
      return length > 0 ? [dx / length, dy / length] : [1, 0];
    };
    const flush = () => {
      if (samples.length) emitRun(solveRun(samples, heading));
      samples = [];
    };
    const sample = (x, y) => {
      if (++sampled > 500000) throw new Error('5-axis finish exceeds sample budget; increase stepover or tolerance');
      const p = probe(x, y);
      if (p[2] === null) { flush(); return; }
      samples.push(p);
    };
    if (spiral) {
      const end = radius * 2 * Math.PI / step;
      for (let a = 0; a < end;) {
        const r = Math.max(0, radius - step * a / (2 * Math.PI));
        sample(cx + r * Math.cos(a), cy + r * Math.sin(a));
        a = Math.min(end, a + Math.min(0.15, ds / Math.max(ds, Math.hypot(r, step / (2 * Math.PI)))));
      }
      sample(cx, cy); flush();
    } else {
      const spokes = Math.max(12, Math.ceil(2 * Math.PI * radius / step));
      const points = Math.max(1, Math.ceil(radius / ds));
      if (spokes * (points + 1) > 500000) throw new Error('Radial finish exceeds sample budget; increase stepover or tolerance');
      // Cover the pole once. Subsequent spokes stop at a small central patch,
      // alternating direction so neighbouring spokes can share a short link.
      sample(cx, cy); flush();
      const core = Math.min(step / 2, radius);
      for (let spoke = 0; spoke < spokes; spoke++) {
        const a = 2 * Math.PI * spoke / spokes;
        const direction = params.radialDirection === 'inward' ? -1
          : params.radialDirection === 'outward' ? 1 : spoke % 2 === 0 ? 1 : -1;
        radialHeading = [direction * Math.cos(a), direction * Math.sin(a)];
        for (let k = 0; k <= points; k++) {
          const t = direction > 0 ? k / points : 1 - k / points;
          const r = core + (radius - core) * t;
          sample(cx + r * Math.cos(a), cy + r * Math.sin(a));
        }
        flush();
        if(['inward','outward'].includes(params.radialDirection) && state.cutting) retract();
      }
    }
    cl.info(spiral ? '5-axis spiral finish: outside to centre' : `5-axis radial finish: ${params.radialDirection ?? 'alternate'} spokes with a shared centre patch`);
  } else if (params.pattern === 'concentric') {
    // Concentric passes in setup XY, outside to centre. The normal/drop-cutter,
    // holder avoidance, region clipping and rotary-unwind planner are shared
    // with raster finishing. Tangential heading follows each circular pass.
    const {cx,cy,radius} = patternCentre();
    const rings = Math.max(1, Math.ceil(radius / step));
    const radialStep = radius / rings;
    let sampled = 0;
    if (rings > 20000) throw new Error('Concentric finishing needs too many passes; increase stepover');
    for (let ring = rings; ring >= 1; ring--) {
      const r = ring * radialStep;
      // Alternate complete laps to avoid winding C another turn on each ring.
      const direction = params.ringDirection === 'cw' ? -1
        : params.ringDirection === 'ccw' ? 1 : (rings - ring) % 2 === 0 ? 1 : -1;
      const count = Math.max(12, Math.ceil(2 * Math.PI * r / ds));
      sampled += count + 1;
      if (sampled > 2000000) throw new Error('Concentric finishing needs too many samples; increase tolerance or stepover');
      let samples = [];
      const heading = p => {
        const a = Math.atan2(p[1] - cy, p[0] - cx);
        return [-direction * Math.sin(a), direction * Math.cos(a)];
      };
      const flush = () => {
        if (samples.length) emitRun(solveRun(samples, heading));
        samples = [];
      };
      for (let k = 0; k <= count; k++) {
        const a = k === count ? 0 : direction * 2 * Math.PI * k / count;
        const p = probe(cx + r * Math.cos(a), cy + r * Math.sin(a));
        if (p[2] === null) { flush(); continue; }
        samples.push(p);
      }
      flush();
    }
    const centre = probe(cx, cy);
    if (centre[2] !== null) emitRun(solveRun([centre], [0, 1]));
    cl.info('Concentric finishing follows circular passes from outside to centre');
  } else {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const toWorld = (u, v) => [u * cos - v * sin, u * sin + v * cos];
  const corners = [
    [box.min[0], box.min[1]], [box.max[0], box.min[1]],
    [box.max[0], box.max[1]], [box.min[0], box.max[1]],
  ].map(([x, y]) => [x * cos + y * sin, -x * sin + y * cos]);
  const uMin = Math.min(...corners.map((c) => c[0]));
  const uMax = Math.max(...corners.map((c) => c[0]));
  const vMin = Math.min(...corners.map((c) => c[1]));
  const vMax = Math.max(...corners.map((c) => c[1]));

  let forward = true;
  for (let v = vMin; v <= vMax + 1e-9; v += step) {
    const u0 = forward ? uMin : uMax;
    const dir = forward ? 1 : -1;
    // The lean is measured from the raster direction, not from which way this row
    // happens to run: in a zig-zag the next row runs the other way, and a lean
    // measured from the direction of travel would flip by twice the lead at every
    // turn — a swing the rotary axes have a stepover to make. Measured from the
    // raster direction the lean is the same in every row; it leads in rows that
    // run with it and trails in rows that run against it, which a ball nose
    // cannot tell apart. One way passes lead in all of them.
    const heading = [cos, sin];
    let samples = [];
    const flush = () => {
      if (samples.length) emitRun(solveRun(samples, heading));
      samples = [];
    };
    for (let s = 0; s <= uMax - uMin + 1e-9; s += ds) {
      const [x, y] = toWorld(u0 + dir * s, v);
      const p = probe(x, y);
      if (p[2] === null) { flush(); continue; }
      samples.push(p);
    }
    flush();
    if (!oneWay) forward = !forward;
    else if (state.cutting) { retract(); }
  }

  }

  if (state.cutting) {
    retract();
    // hand the program over upright, at clearance, as every other operation does
    cl.setAxis(0, 0, 1);
    cl.rapid(state.last.x, state.last.y, clearance);
  }
  if (cl.count === 0) {
    const why = regionRefusal(regions, R, tolerance);
    cl.warn(why
      ? `5-axis finishing produced no passes — ${why}`
      : '5-axis finishing produced no passes — check Top Z and Bottom Z');
    return cl.finish();
  }

  if(stats.omitted) cl.warn(`5-axis finish is incomplete: ${stats.omitted} cutting intervals could not be verified and were omitted; inspect remaining stock and add a cleanup operation`);
  const mean = stats.points ? stats.tiltSum / stats.points : 0;
  cl.info(`5-axis finishing leans the cutter ${mean.toFixed(1)}° on average, `
    + `${stats.tiltMax.toFixed(1)}° at most (limit ${(maxTilt * DEG).toFixed(0)}°)`);
  if (stats.eased > 0) {
    cl.info(`${stats.eased} of ${stats.points} points were eased toward upright to keep the `
      + 'shank and holder out of the part');
  }
  if (stats.held > 0) {
    cl.warn(`the shank or holder is still in the part at ${stats.held} points, even upright — `
      + 'a longer cutter, or a part this tool can reach, is needed');
  }
  if (tool.type === 'flat' && !fixed) {
    cl.info('a flat end mill leaned to the surface cuts with one edge: a ball or bull nose '
      + 'gives a better finish when the tool follows the normal');
  }
  return cl.finish();
}

/**
 * Drop the points of a run a straight line between its neighbours would pass
 * within `tol` of — keeping every point where the tool *leans* differently,
 * because the line between two points says nothing about the axis between them.
 */
function thin(points, tol, axisTol, safe = () => true) {
  if (points.length <= 2) return points;
  const out = [points[0]];
  let anchor = 0;
  for (let i = 1; i < points.length - 1; i++) {
    if (fits(points, anchor, i + 1, tol, axisTol) && safe(points[anchor],points[i+1])) continue;
    out.push(points[i]);
    anchor = i;
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Do the points strictly between `a` and `b` all sit on the straight run from a to b? */
function fits(points, a, b, tol, axisTol) {
  const p = points[a];
  const q = points[b];
  const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  for (let k = a + 1; k < b; k++) {
    const m = points[k];
    const t = len2 > 0 ? ((m.x - p.x) * dx + (m.y - p.y) * dy + (m.z - p.z) * dz) / len2 : 0;
    const ex = p.x + dx * t - m.x, ey = p.y + dy * t - m.y, ez = p.z + dz * t - m.z;
    if (ex * ex + ey * ey + ez * ez > tol * tol) return false;
    if (angleBetween(blendAxis(p.a, q.a, t), m.a) > axisTol) return false;
  }
  // The direction of the lean, as well as the lean: close to vertical two axes
  // a degree apart can face opposite ways, and the straight line between them
  // says nothing about the half turn the turntable makes to get there.
  if (leanTurn(p.a, q.a) > AZIMUTH_STEP) return false;
  return true;
}

/** The most the direction of the lean may turn between two kept points, degrees. */
const AZIMUTH_STEP = 8;

/** How far the lean's direction turns between two axes (0 when either is vertical). */
function leanTurn(a, b) {
  if (Math.hypot(a[0], a[1]) < 1e-6 || Math.hypot(b[0], b[1]) < 1e-6) return 0;
  let d = Math.abs(Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0])) * DEG;
  if (d > 180) d = 360 - d;
  // a lean on the far side of the pole is the same lean with its sign turned, which
  // the turntable does not move for: only the half turn counts
  return Math.min(d, 180 - d);
}

function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}
