// V-carve: a V bit cut to a depth that follows the width of the shape.
//
// Engraving puts the cutter on a line. V-carving fills a *shape* — a letter, a
// logo, a sign — with a groove whose depth is set by how far from the edge the
// cutter is: the nearer the wall, the shallower, so the wall of the groove is the
// V of the cutter itself and the opening at the surface is exactly the outline.
//
// The geometry is simple and exact. A V bit of included angle 2·a with a flat tip
// of diameter t, its centre at distance i from a wall, reaches that wall *at the
// surface* when it is down by d where  i = t/2 + d·tan a.  So at every depth the
// centreline is the shape pulled in by that inset, and as the cutter goes deeper
// the inset grows until the shape has nothing left to pull in: that is the medial
// axis, and it is where the groove bottoms out on its own. No skeleton is
// computed; the offsetter finds it by running out of shape.
//
//   depth cap    the deepest the groove may go (vcarveDepth). Past it the cutter
//                stops sinking and — if the bottom is to be flat — clears what is
//                left at that depth with passes a tip-width apart.
//   inlay        the same carve, twice, so that the pieces fit. The *female* is
//                the recess: the shape, to the depth, flat-bottomed. The *male*
//                is its plug: the shape pulled in at the top by Df·tan a + gap,
//                its skirt falling away on the outside at the same angle, so
//                that, turned over, it sits in the recess with `gap` all round.
//
// The depth levels are `stepdown` apart; between two of them the V's own flank
// leaves a ridge of height about (stepdown·tan a)², which is the smallest thing
// this leaves and is why the default step is fine.

import { CLBuilder, lastXY } from '../cl.js';
import { plural } from '../text.js';
import { offsetLoops, diffLoops, loopArea, loopsBounds } from '../../geom/clipper.js';
import { pointInLoops } from '../../geom/inside.js';
import { orientLoop } from '../leads.js';
import { applyRegionsToPaths } from '../regions.js';
import { approach, entryPlane, holeSurfaceZ } from '../heights.js';
import { applyCutting } from '../cutting.js';
import { grooveGeometry } from './engrave.js';
import { unfacedNote } from './chamfer.js';

const DEFAULT_DEPTH = 1;
/** The deepest a V-carve is allowed to be called one. */
const MAX_DEPTH = 12;
/** More levels than this and the step is the mistake, not the depth. */
const MAX_LEVELS = 400;

/** The loops of a drawing's closed paths, as even-odd fills: outers CCW, holes CW. */
export function drawnShape(paths) {
  const loops = [];
  for (const { points, closed } of paths) {
    if (closed && points.length / 2 >= 3 && Math.abs(loopArea(points)) > 1e-9) loops.push(points);
  }
  // a loop inside an odd number of others is a hole — a letter O is two circles
  const out = [];
  loops.forEach((loop, n) => {
    let inside = 0;
    for (let m = 0; m < loops.length; m++) {
      if (m !== n && pointInLoops([loops[m]], loop[0], loop[1])) inside++;
    }
    const wantCcw = inside % 2 === 0;
    const ccw = loopArea(loop) > 0;
    out.push(ccw === wantCcw ? loop : reversedLoop(loop));
  });
  return out;
}

function reversedLoop(loop) {
  const n = loop.length / 2;
  const out = new Array(loop.length);
  for (let i = 0; i < n; i++) {
    out[i * 2] = loop[(n - 1 - i) * 2];
    out[i * 2 + 1] = loop[(n - 1 - i) * 2 + 1];
  }
  return out;
}

/**
 * The pieces of one carve: a region, the deepest it may go and the surface it
 * starts from, as the list of [centreline loops, depth] to cut.
 *
 * @returns { levels: [{ depth, loops }], deepest, reach } — `reach` is how deep
 *   the shape alone would let the cutter go (to its medial axis)
 */
export function carveLevels(region, { tan, tip, cap, step, flat, clearStep }) {
  const levels = [];
  const inset = (d) => tip / 2 + d * tan;
  // the depths asked for, shallowest first; the cap itself is always one
  const depths = [];
  for (let d = step; d < cap - 1e-9; d += step) depths.push(d);
  depths.push(cap);
  let reached = 0;
  let last = null;
  for (const d of depths) {
    const loops = offsetLoops(region, -inset(d), 0.005).filter((l) => Math.abs(loopArea(l)) > 1e-6);
    if (loops.length === 0) break;
    levels.push({ depth: d, loops });
    reached = d;
    last = loops;
  }
  // a shape narrower than the cap runs out of room before it: the deepest level
  // that had something is where the groove ends, on its own medial axis
  let reach = reached;
  if (reached < cap - 1e-9 && levels.length) {
    // refine: the last depth the shape still holds, to a hundredth of a millimetre
    let lo = reached;
    let hi = Math.min(cap, reached + step);
    for (let i = 0; i < 12 && hi - lo > 0.005; i++) {
      const mid = (lo + hi) / 2;
      if (offsetLoops(region, -inset(mid), 0.005).some((l) => Math.abs(loopArea(l)) > 1e-6)) lo = mid; else hi = mid;
    }
    if (lo > reached + 1e-6) {
      levels.push({ depth: lo, loops: offsetLoops(region, -inset(lo), 0.005).filter((l) => Math.abs(loopArea(l)) > 1e-6) });
      reach = lo;
    }
  }
  // the flat bottom: at the cap, passes a tip apart across whatever is left
  if (flat && reached >= cap - 1e-9 && last) {
    let i = inset(cap) + clearStep;
    for (let guard = 0; guard < 400; guard++, i += clearStep) {
      const loops = offsetLoops(region, -i, 0.005).filter((l) => Math.abs(loopArea(l)) > 1e-6);
      if (loops.length === 0) break;
      levels.push({ depth: cap, loops, clearing: true });
    }
  }
  return { levels, reach, deepest: levels.length ? Math.max(...levels.map((l) => l.depth)) : 0 };
}

export function generateVcarve({
  mesh, tool, params, regions, drawing, stock = null,
}) {
  const clearanceZ = params.clearanceHeight;
  const tolerance = params.tolerance ?? 0.01;
  const surfaceZ = params.topZ;
  const direction = params.direction ?? 'climb';

  const cl = new CLBuilder();
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  const groove = grooveGeometry(tool);
  if (!groove.pointed) {
    cl.warn(`V-carving needs a V bit or a chamfer mill: ${tool.name ?? 'this cutter'} has no point angle, `
      + 'so its groove is the same width at any depth');
    return cl.finish();
  }
  const drawnPaths = drawing?.length ? drawing : null;
  if (!drawnPaths) {
    cl.warn(drawing && drawing.length === 0
      ? 'the drawing has no lines in it — check the DXF imported the entities you expected'
      : 'V-carving follows a drawing: import a DXF and point this operation at it');
    return cl.finish();
  }
  const shape = drawnShape(drawnPaths);
  if (shape.length === 0) {
    cl.warn('V-carving needs closed shapes to fill — the drawing has only open lines. '
      + 'Close them in the drawing program, or engrave the lines instead');
    return cl.finish();
  }

  const tan = Math.tan(((groove.included / 2) * Math.PI) / 180);
  const tip = Math.max(0, tool.tipDiameter ?? 0);
  let cap = params.vcarveDepth > 0 ? params.vcarveDepth : DEFAULT_DEPTH;
  if (cap > MAX_DEPTH) {
    cl.warn(`${cap}mm is deeper than a V-carve goes — capped at ${MAX_DEPTH}mm`);
    cap = MAX_DEPTH;
  }
  // a V bit reaches no deeper than its own flutes: its width there is its diameter
  const reachOfBit = ((tool.diameter - tip) / 2) / tan;
  if (cap > reachOfBit + 1e-9) {
    cl.warn(`a ⌀${tool.diameter} ${groove.included}° bit is as wide as it goes at ${reachOfBit.toFixed(2)}mm — `
      + `the carve is capped there, not at ${cap}mm`);
    cap = reachOfBit;
  }
  const step = Math.max(0.01, params.stepdown > 0 ? params.stepdown : 0.15);
  if (cap / step > MAX_LEVELS) {
    cl.warn(`${plural(Math.ceil(cap / step), 'depth level')} is more than this will cut — a deeper step keeps it sensible`);
    return cl.finish();
  }
  const flat = (params.vcarveBottom ?? 'flat') === 'flat';
  // Passes across a flat bottom. With a flat on the tip they are a little closer
  // than the flat is wide, so the floor is the flat itself, end to end. A *sharp*
  // V has no flat to make a floor with: between two passes a spacing s apart it
  // leaves a ridge s/(2·tan a) high, so the spacing is chosen to keep that under
  // 0.04mm — which is close, and is the honest cost of a flat floor from a point.
  const clearStep = tip > 0 ? Math.max(0.05, tip * 0.9) : Math.max(0.06, 2 * tan * 0.04);

  // --- what is carved: the shape, or, for a plug, everything round it ---------
  const inlay = params.inlay ?? 'none';
  const gap = Math.max(0, params.inlayGap ?? 0.05);
  let region = shape;
  let note = '';
  if (inlay === 'male') {
    // The island is the shape pulled in by the V's run over the depth, and the
    // clearance on top of it. Everything outside it, out to a margin, is carved.
    const pullIn = cap * tan + gap;
    const island = offsetLoops(shape, -pullIn, tolerance);
    if (island.length === 0) {
      cl.warn(`the shape is narrower than the ${pullIn.toFixed(2)}mm the plug has to be pulled in by — `
        + 'a shallower inlay depth, or a bigger shape, leaves a plug to make');
      return cl.finish();
    }
    const b = loopsBounds(shape);
    const margin = Math.max(0, params.inlayMargin ?? 4) + cap * tan + tool.diameter;
    const frame = [b.min[0] - margin, b.min[1] - margin, b.max[0] + margin, b.min[1] - margin,
      b.max[0] + margin, b.max[1] + margin, b.min[0] - margin, b.max[1] + margin];
    region = diffLoops([frame], island);
    note = `, a plug ${pullIn.toFixed(2)}mm smaller at its top than the recess is at its bottom, with a ${gap}mm gap`;
  } else if (inlay === 'female') {
    note = ', the recess for a plug';
  }
  if (region.length === 0) {
    cl.warn('there is nothing to carve');
    return cl.finish();
  }

  const { levels, reach, deepest } = carveLevels(region, { tan, tip, cap, step, flat, clearStep });
  if (levels.length === 0) {
    cl.warn(`the shape is narrower than the cutter's own tip (⌀${tip}) — nothing for it to carve`);
    return cl.finish();
  }
  if (reach < cap - 1e-6 && !(inlay === 'male')) {
    cl.info(`the narrowest part of the shape is only ${(reach * 2 * tan + tip).toFixed(2)}mm wide at the surface — `
      + `the groove stops at ${reach.toFixed(2)}mm there, short of the ${cap}mm asked for`);
  }

  // --- cut them, shallowest first, nearest loop first within a level ---------
  const clip = { radius: 0, tolerance };
  let zEntry = holeSurfaceZ(surfaceZ, stock);
  unfacedNote(cl, zEntry - surfaceZ, 'V-carving');
  let cutAnything = false;
  let at = null;
  for (const level of levels) {
    const z = surfaceZ - level.depth;
    const feedPlane = entryPlane(params, zEntry, z);
    const pending = level.loops.map((loop) => ({ loop }));
    let cutHere = false;
    while (pending.length) {
      // nearest to where the tool is
      let pick = 0;
      if (at) {
        let best = Infinity;
        pending.forEach(({ loop }, n) => {
          const d = Math.hypot(loop[0] - at[0], loop[1] - at[1]);
          if (d < best) { best = d; pick = n; }
        });
      }
      const { loop } = pending.splice(pick, 1)[0];
      const isHole = loopArea(loop) < 0;
      const { closed, open } = applyRegionsToPaths([loop], regions, clip);
      for (const path of closed) {
        if (path.length / 2 < 3) continue;
        const oriented = orientLoop(path, direction, isHole);
        approach(cl, oriented[0], oriented[1], z, { clearance: clearanceZ, feedPlane });
        for (let i = 2; i < oriented.length; i += 2) cl.cut(oriented[i], oriented[i + 1], z);
        cl.cut(oriented[0], oriented[1], z);
        cl.rapid(...lastXY(cl), clearanceZ);
        at = [oriented[0], oriented[1]];
        cutHere = true;
      }
      for (const path of open) {
        if (path.length < 4) continue;
        approach(cl, path[0], path[1], z, { clearance: clearanceZ, feedPlane });
        for (let i = 2; i < path.length; i += 2) cl.cut(path[i], path[i + 1], z);
        cl.rapid(...lastXY(cl), clearanceZ);
        at = [path[path.length - 2], path[path.length - 1]];
        cutHere = true;
      }
    }
    if (cutHere) { cutAnything = true; if (!level.clearing) zEntry = z; }
  }

  if (!cutAnything) {
    cl.warn('V-carving cut nothing — every pass was clipped away by the picked regions');
    return cl.finish();
  }
  cl.info(`${plural(shape.length, 'closed shape')}, carved to ${deepest.toFixed(2)}mm with a ${groove.included}° bit`
    + `${flat ? ', flat-bottomed' : ''}${note} in ${plural(levels.length, 'pass level')}`);
  void mesh;
  return cl.finish();
}
