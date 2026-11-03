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
import { buildHeightmap, buildToolKernel, dropCutter } from '../../geom/heightmap.js';
import { regionRefusal } from '../regions.js';
import { applyCutting } from '../cutting.js';
import {
  approach, entryPlane, clearOfRoughing, roughingNote,
} from '../heights.js';
import { finishingWindow } from './parallel3d.js';
import { toolShells, leaningKernels } from '../five/tilt-kernel.js';
import { bodyTouchTilted, angleBetween, blendAxis } from '../five/tilt-sweep.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const UP = Object.freeze([0, 0, 1]);

/** How many tilted kernels are kept: one per distinct leaning, reused all over the part. */
const KERNELS = 256;

export function generateFinish5({
  mesh, tool, params: given, stock, regions, earlier = null,
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
  const maxTurn = Math.max(0.5, params.axisRate ?? 10);

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

  const tipAt = (x, y, lean, fallback) => {
    const z = dropCutter(map, lean.kernel, x, y);
    return Number.isFinite(z) ? z + stockToLeave : fallback;
  };

  // --- the tilt law --------------------------------------------------------------

  const reach = Math.max(1, Math.min(8, Math.round((0.25 * R) / map.cellSize)));
  /** The surface's unit normal at (x, y), or null where the map has no surface to read. */
  const normalAt = (x, y) => {
    const ci = Math.round((x - map.min[0]) / map.cellSize);
    const cj = Math.round((y - map.min[1]) / map.cellSize);
    const at = (i, j) => {
      if (i < 0 || j < 0 || i >= map.width || j >= map.height) return null;
      const h = map.data[j * map.width + i];
      return h === map.floor ? null : h;
    };
    const xp = at(ci + reach, cj);
    const xm = at(ci - reach, cj);
    const yp = at(ci, cj + reach);
    const ym = at(ci, cj - reach);
    if (xp === null || xm === null || yp === null || ym === null) return null;
    const gx = (xp - xm) / (2 * reach * map.cellSize);
    const gy = (yp - ym) / (2 * reach * map.cellSize);
    const n = Math.hypot(gx, gy, 1);
    return [-gx / n, -gy / n, 1 / n];
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
   * The axis the law asks for at a point: the surface normal (or vertical),
   * leaned back from the feed by `lead` and to the side by `side`, and never
   * further than `maxTilt` from vertical.
   */
  const lawAxis = (normal, heading) => {
    const base = fixed || !normal ? UP : normal;
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
   * Hold the axis to `maxTurn` degrees per millimetre of path, both ways along it.
   *
   * One sweep forward and one back is not enough: pulling a point toward its
   * successor on the way back undoes the limit against its predecessor, so the
   * sweeps repeat until a whole round changes nothing. Each only moves a point
   * toward a neighbour, so it settles in a few rounds.
   */
  const limitTurn = (axes, spacing) => {
    const most = maxTurn * spacing;
    const clamp = (from, to) => {
      const turn = angleBetween(from, to);
      return turn > most ? blendAxis(from, to, most / turn) : to;
    };
    for (let round = 0; round < 8; round++) {
      let moved = false;
      for (let i = 1; i < axes.length; i++) {
        const next = clamp(axes[i - 1], axes[i]);
        if (next !== axes[i]) { axes[i] = next; moved = true; }
      }
      for (let i = axes.length - 2; i >= 0; i--) {
        const next = clamp(axes[i + 1], axes[i]);
        if (next !== axes[i]) { axes[i] = next; moved = true; }
      }
      if (!moved) break;
    }
    return limitAzimuth(axes, spacing * 2 * maxTurn);
  };

  /**
   * Hold the direction the cutter leans toward to `most` degrees per sweep.
   *
   * The 3-D limit above is blind to the pole. Close to vertical a lean can swing
   * clean round the other side of it — from tilted one way by a degree to tilted
   * the opposite way by a degree — and that is two degrees of axis and a half turn
   * of the turntable. Left alone it is a block of the program in which C spins
   * through 180°. Held to a rate of its own, the lean's direction follows the law
   * as fast as the turntable can, and where it cannot the cutter is a degree or
   * two from where the law put it — which is all there is *to* lose there, since
   * the whole lean is a degree or two.
   *
   * It is a rate on the azimuth, not on the angle, which is why it binds near the
   * pole and nowhere else: at a 30° lean it is the same limit as the one above.
   */
  const limitAzimuth = (axes, most) => {
    const tilt = axes.map((a) => Math.acos(Math.min(1, Math.max(-1, a[2]))));
    const az = axes.map((a) => Math.atan2(a[1], a[0]));
    // unwrap, so a lean passing through ±180° is a small step and not a lap
    for (let i = 1; i < az.length; i++) {
      while (az[i] - az[i - 1] > Math.PI) az[i] -= 2 * Math.PI;
      while (az[i] - az[i - 1] < -Math.PI) az[i] += 2 * Math.PI;
    }
    const cap = most * RAD;
    for (let round = 0; round < 8; round++) {
      let moved = false;
      for (let i = 1; i < az.length; i++) {
        const d = az[i] - az[i - 1];
        if (Math.abs(d) > cap + 1e-12) { az[i] = az[i - 1] + Math.sign(d) * cap; moved = true; }
      }
      for (let i = az.length - 2; i >= 0; i--) {
        const d = az[i] - az[i + 1];
        if (Math.abs(d) > cap + 1e-12) { az[i] = az[i + 1] + Math.sign(d) * cap; moved = true; }
      }
      if (!moved) break;
    }
    return axes.map((a, i) => (tilt[i] < 1e-9 ? a
      : [Math.sin(tilt[i]) * Math.cos(az[i]), Math.sin(tilt[i]) * Math.sin(az[i]), Math.cos(tilt[i])]));
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
  const stats = { points: 0, tiltSum: 0, tiltMax: 0, eased: 0, held: 0 };

  /**
   * One run of the raster as points that carry their axis: the law, the turn
   * limit, the height the drop-cutter finds for each leaning, and the holder
   * check — easing any point it would hit toward vertical and trying again.
   */
  const solveRun = (samples, heading) => {
    const raw = samples.map((p) => lawAxis(normalAt(p[0], p[1]), heading));
    const scale = new Float64Array(samples.length).fill(1);
    let leans = null;
    let z = null;
    for (let pass = 0; pass < 4; pass++) {
      const axes = limitTurn(raw.map((a, i) => eased(a, scale[i])), ds);
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
      if (bodyHits([out[i].x, out[i].y, out[i].z], out[i].a)) stats.held++;
    }
    return thin(out, tolerance, 0.5);
  };

  const state = { cutting: false, last: null };
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
      points.push({ x, y, z: tipAt(x, y, lean, p[2]), a: lean.axis });
    }
    return points;
  };

  const emitRun = (run) => {
    if (run.length === 0) return;
    const first = run[0];
    const link = state.cutting ? rideLink(state.last, first) : null;
    if (link) {
      for (const p of link) cutTo(p);
    } else {
      if (state.cutting) retract();
      beginAt(first);
    }
    for (let k = link ? 0 : 1; k < run.length; k++) cutTo(run[k]);
    state.cutting = true;
    state.last = run[run.length - 1];
  };

  // --- the raster ----------------------------------------------------------------

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
function thin(points, tol, axisTol) {
  if (points.length <= 2) return points;
  const out = [points[0]];
  let anchor = 0;
  for (let i = 1; i < points.length - 1; i++) {
    if (fits(points, anchor, i + 1, tol, axisTol)) continue;
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
  return d;
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
