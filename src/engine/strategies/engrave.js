// Engraving: run the cutter *down the line*, not beside it.
//
// Every other milling strategy in here offsets the path by the cutter's radius,
// because every other strategy is cutting a surface the part keeps. Engraving
// is not: the line is the feature. Marking a part number, scribing a fold line,
// cutting a V-groove for a sign — in all of them the tool centre belongs on the
// geometry, and any compensation at all puts the mark in the wrong place.
//
// The second thing that is different is how deep to go. With a V bit the depth
// *is* the width: a 90° cutter at 0.2mm deep leaves a 0.4mm line. Machinists
// think in the width they want to see and the arithmetic runs the other way, so
// the operation will take either — a depth, or a width it converts using the
// cutter's own point angle.

import { CLBuilder, lastXY } from '../cl.js';
import { plural } from '../text.js';
import { offsetLoops } from '../../geom/clipper.js';
import { SilhouetteStack } from '../../geom/silhouette.js';
import { depthPasses } from '../stock.js';
import { cutPerimeter, orderByProximity } from '../linking.js';
import { orientLoop } from '../leads.js';
import { applyRegionsToPaths } from '../regions.js';
import { approach, entryPlane } from '../heights.js';
import { applyCutting } from '../cutting.js';
import { splitBoundaries } from './chamfer.js';
import { buildHeightmap, buildToolKernel, dropCutter } from '../../geom/heightmap.js';

/** How deep a mark is when nobody has said. Deep enough to see, shallow enough to be a mark. */
const DEFAULT_ENGRAVE_DEPTH = 0.3;

/**
 * The deepest thing this operation will call an engraved mark.
 *
 * Not a safety limit — a sanity one. Every value above it that has been seen in
 * practice came from the operation's old meaning (the floor of the mark as an
 * absolute Z, arriving from the model bounds) rather than from anybody deciding
 * to cut 10mm with a V bit. Cutting it as asked is hours of machine time and a
 * broken cutter; refusing it outright throws away a document that is only
 * wrong in one field.
 */
const MAX_ENGRAVE_DEPTH = 5;

/**
 * The steepest the surface may fall between two samples and still count as the
 * same face — one of rise per one of run, i.e. 45°.
 *
 * Above that the pass breaks and starts a new mark on the other side. See
 * cutAlong.
 */
const MAX_FOLLOW_SLOPE = 1;

/**
 * How wide a mark this cutter leaves at a given depth, and the inverse.
 *
 * A pointed cutter widens as it goes down; a flat or ball one cuts its own
 * diameter however deep it is, so `depthFor` has no answer for it and says so
 * rather than returning a number that would be obeyed.
 */
export function grooveGeometry(tool) {
  const included = tool?.tipAngle > 0 && tool.tipAngle < 180 ? tool.tipAngle : 0;
  const tipDiameter = Math.max(0, tool?.tipDiameter ?? 0);
  if (!included) {
    return { pointed: false, widthAt: () => tool?.diameter ?? 0, depthFor: () => null };
  }
  const tan = Math.tan(((included / 2) * Math.PI) / 180);
  return {
    pointed: true,
    included,
    widthAt: (depth) => Math.min(tool.diameter, tipDiameter + 2 * Math.max(0, depth) * tan),
    depthFor: (width) => (width <= tipDiameter ? 0 : (width - tipDiameter) / (2 * tan)),
  };
}

/**
 * @param drawing an imported DXF, already placed in setup coordinates — see
 *   engine/drawing.js. Given one, the pass follows *those* lines instead of the
 *   part's own outline, which is what makes engraving a logo, a part number or
 *   a scribed fold line possible at all: none of them exist in the solid.
 */
export function generateEngrave({ mesh, tool, params, regions, drawing }) {
  const clearanceZ = params.clearanceHeight;
  const tolerance = params.tolerance ?? 0.01;
  const direction = params.direction ?? 'climb';
  const surfaceZ = params.topZ;
  const r = tool.diameter / 2;
  const side = params.side ?? 'on';

  const cl = new CLBuilder();
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  const groove = grooveGeometry(tool);
  const mode = params.engraveMode ?? 'depth';

  /**
   * How deep the mark is, **as one number, below the surface it is cut into.**
   *
   * This was a pair of absolute heights — Top Z the surface, Bottom Z the floor
   * of the mark — and that only describes a mark on a face that is flat and at
   * Top Z. Once the pass follows the surface it is a description of nothing: on
   * a part 10mm tall the two heights arrive from the model bounds, the depth
   * works out at 10mm, and the operation dutifully cuts a 10mm-deep groove that
   * follows the slope **straight through the part** in ten passes. Measured on a
   * 40mm wedge: the tool reached Z−8.75, eight millimetres below the billet.
   *
   * A depth is a depth. Bottom Z stays as a floor the mark may not pass, which
   * is what a limit is for, and is no longer what sets the depth.
   */
  let depth = Math.max(0, params.engraveDepth ?? DEFAULT_ENGRAVE_DEPTH);
  if (mode === 'width') {
    const want = Math.max(0, params.grooveWidth ?? 0);
    if (!groove.pointed) {
      cl.warn(`${tool.name ?? 'this cutter'} has no point angle, so its mark is ⌀${tool.diameter} `
        + 'at any depth — set the depth directly, or use a V bit');
      return cl.finish();
    }
    if (!(want > 0)) {
      cl.warn('groove width is 0 — set the width of the line you want to see');
      return cl.finish();
    }
    if (want > tool.diameter) {
      cl.warn(`a ${want}mm groove is wider than the ⌀${tool.diameter} cutter can open`);
      return cl.finish();
    }
    depth = groove.depthFor(want);
  }

  if (!(depth > 1e-6)) {
    cl.warn('engraving depth is zero — set how deep the mark is, or the width of '
      + 'the line you want to see');
    return cl.finish();
  }
  // A depth that reads as a plunge rather than a mark is nearly always the old
  // meaning of the field arriving from a saved document, and it is worth
  // saying so rather than cutting it.
  if (depth > MAX_ENGRAVE_DEPTH) {
    cl.warn(`${depth.toFixed(2)}mm is a slot, not an engraved mark — engraving `
      + `is capped at ${MAX_ENGRAVE_DEPTH}mm. Use a slot or a pocket for a `
      + 'cut that deep.');
    depth = MAX_ENGRAVE_DEPTH;
  }
  // Where the mark's floor lands on a face at Top Z. Bottom Z is a limit on
  // that — "do not cut deeper than here" — and it is checked against the
  // nominal floor rather than clamped against the followed one: on a sloped
  // face the followed floor is nowhere near Top Z, and clamping to an absolute
  // Z there flattens the mark back onto a plane, which is the bug following
  // exists to fix.
  const floorZ = surfaceZ - depth;
  if (Number.isFinite(params.bottomZ) && floorZ < params.bottomZ - 1e-6) {
    cl.warn(`a ${depth.toFixed(3)}mm mark reaches Z${floorZ.toFixed(3)}, below Bottom Z `
      + `${params.bottomZ.toFixed(3)} — lower Bottom Z, or cut a shallower mark`);
    return cl.finish();
  }

  // Two sources of lines, and the drawing wins when there is one. A drawing is
  // the *only* source for the things engraving is usually for — a logo, a part
  // number, a fold line — because none of them are features of the solid and
  // none of them appear in its silhouette.
  const drawnPaths = drawing?.length ? drawing : null;
  if (drawing && drawing.length === 0) {
    cl.warn('the drawing has no lines in it — check the DXF imported the entities '
      + 'you expected');
    return cl.finish();
  }

  const silhouette = drawnPaths ? null : new SilhouetteStack(mesh, { tolerance });
  const clip = { radius: side === 'on' ? 0 : r, tolerance };
  const levels = [...depthPasses(surfaceZ, floorZ, params.stepdown)];

  // How deep below the *surface* each level cuts, rather than what absolute Z
  // it sits at. The two are the same thing on a flat face and nothing like each
  // other on a sloped one — see `surface` below.
  const depthsBelow = levels.map((z) => surfaceZ - z);
  const surface = engraveSurface(mesh, tool, params, { tolerance, surfaceZ });
  // How finely the surface is followed. Zero on a flat job — there is nothing
  // to follow, and resampling a straight line into two hundred pieces would
  // triple the file to say the same thing.
  const following = params.engraveFollow !== false && !!mesh?.positions?.length;
  const followStep = following ? Math.max(0.2, Math.min(1, (params.tolerance ?? 0.05) * 8)) : 0;
  // How long a stretch with no surface under it the mark carries straight on
  // across — the cutter's own width, because nothing narrower than that is a
  // gap the cutter could follow into. See cutAlong.
  const bridge = Math.max(tool.diameter, followStep * 2);

  let cutAnything = false;
  let zEntry = surfaceZ;
  for (let level = 0; level < levels.length; level++) {
    const z = levels[level];
    let cutHere = false;
    const below = depthsBelow[level];
    // The mark's floor at a point: the surface there, less this level's depth.
    // On a flat face this is the constant the code used to cut at.
    const zAt = (x, y) => {
      const s = surface(x, y);
      return s === null ? null : s - below;
    };
    const { outers, holes } = drawnPaths
      ? drawingBoundaries(drawnPaths)
      : splitBoundaries(silhouette.down(z), params.engraveLines ?? 'all');
    const feedPlane = entryPlane(params, zEntry, z);
    // Nearest first. It matters most here of anywhere: an engraved drawing is
    // often hundreds of short separate strokes, and the order a DXF happens to
    // list its entities in is the order they were drawn in, which on any real
    // logo means the tool crossing the plate between every letter.
    for (const { loop, isHole, isOpen } of orderEntries([...outers, ...holes], cl)) {
      // an open path is a line, not a boundary: there is no inside to offset
      // toward and nothing to close, so it is cut as it was drawn
      if (isOpen) {
        if (loop.length < 4) continue;
        if (cutAlong(cl, loop, { zAt, clearanceZ, feedPlane, step: followStep, tolerance, bridge })) {
          cutHere = true;
        }
        continue;
      }
      const delta = offsetFor(side, r, isHole);
      const raw = delta === 0 ? [loop] : offsetLoops([loop], delta, tolerance);
      const { closed, open } = applyRegionsToPaths(raw, regions, clip);
      for (const path of closed) {
        if (path.length / 2 < 3) continue;
        const oriented = orientLoop(path, direction, isHole);
        // closed: walk it and come back to where it started
        if (cutAlong(cl, [...oriented, oriented[0], oriented[1]],
          { zAt, clearanceZ, feedPlane, step: followStep, tolerance, bridge })) {
          cutHere = true;
        }
      }
      for (const path of open) {
        if (path.length < 4) continue;
        if (cutAlong(cl, path, { zAt, clearanceZ, feedPlane, step: followStep, tolerance, bridge })) {
          cutHere = true;
        }
      }
    }
    // A level that engraved nothing has not lowered the surface the next one
    // descends through — see engine/heights.js entryPlane.
    if (cutHere) { cutAnything = true; zEntry = z; }
  }

  if (!cutAnything) {
    cl.warn(drawnPaths
      ? 'engraving cut nothing — every line was clipped away by the picked regions'
      : 'engraving found no lines — the part has no boundary at Top Z');
    return cl.finish();
  }
  cl.info((drawnPaths ? `${plural(drawnPaths.length, 'drawn path')}, ` : '')
    + `engraved ${depth.toFixed(3)}mm deep`
    + (following ? ', following the surface' : ' at one Z')
    + (groove.pointed ? ` — a ${groove.widthAt(depth).toFixed(3)}mm wide mark` : '')
    + (levels.length > 1 ? ` in ${levels.length} passes` : ''));
  return cl.finish();
}

/**
 * The surface the mark is cut into, as a height for every point.
 *
 * "Engraving only follows 2D" was this: every point of every stroke was cut at
 * one Z per level, so a line scribed across a slope started at the right depth,
 * broke the surface halfway along, and finished cutting air — or ploughed in,
 * depending which way the slope ran. A spiralling slope does both within one
 * revolution.
 *
 * The depth of an engraved line is measured from the surface it is scribed on,
 * always. That is the whole of the fix: sample the surface, cut below it.
 *
 * Sampled directly at the tool's centreline rather than dropped like a milling
 * cutter, because the two answer different questions. A dropped cutter rests on
 * whatever its *widest* contact touches, which is right for a pass whose job is
 * to not gouge; the floor of a V-groove is set by the point of the tool, which
 * is on the axis. Dropping here would lift the mark off the surface by the
 * cutter's own radius wherever the surface was convex.
 *
 * @returns (x, y) => height, and a flat plane when there is nothing to follow
 */
function engraveSurface(mesh, tool, params, { tolerance, surfaceZ }) {
  const flat = () => surfaceZ;
  if (params.engraveFollow === false || !mesh?.positions?.length) return flat;
  const map = buildHeightmap(mesh, {
    cellSize: Math.max(0.1, Math.min(0.5, (tolerance ?? 0.05) * 4)),
    floor: -Infinity,
    // No dilation: a heightmap for a *clearing* pass is grown so a sliver of
    // material is never missed, and growing it here would put the mark on the
    // dilated shoulder of a feature rather than on the face beside it.
    dilate: false,
  });
  // Dropped with the tool's own shape, not sampled at the centreline.
  //
  // Sampling the point was tried first, on the argument that a V-groove's floor
  // is set by the tip and the tip is on the axis. True, and it misses the
  // question the drop-cutter is *for*: whether the tool can get there at all. A
  // point sample reads the floor of a pocket the cutter does not fit in and
  // takes the mark down into it — "it wants to engrave pockets it can't even
  // reach", which is exactly what a drop-cutter refuses to do. On the gentle
  // slopes engraving actually runs on, the two answers are the same number.
  const kernel = buildToolKernel(tool, map.cellSize);
  const { data, width, height, cellSize, bounds } = map;
  // How far the dropped tool may sit above the surface under its own tip and
  // still be said to be *on* that surface. A cell, because that is the
  // resolution the surface is known to.
  const seated = Math.max(cellSize, 2 * (tolerance ?? 0.05));

  return (x, y) => {
    const z = dropCutter(map, kernel, x, y);
    // Off the part, or over a void. Not a height — and saying `surfaceZ` here
    // is what made a line that runs past the edge of the model climb back to
    // the nominal top and cut air on the way. The caller breaks the pass.
    if (!Number.isFinite(z)) return null;

    // Is the tool resting on the surface, or bridging something it does not fit
    // in? A drop-cutter answers "how low can this tool go without gouging",
    // which inside a 4mm slot with a ⌀6 cutter is the tool wedged between the
    // two rims — a height that belongs to no surface at all. Marking there is
    // "it wants to engrave pockets it can't even reach": the groove is cut into
    // the corners of the slot rather than into a face.
    //
    // The test is exact: the tool is on the surface when its tip is at the
    // surface directly beneath it. Anywhere it is held up, there is nothing
    // here to engrave.
    const i = Math.round((x - bounds.min[0]) / cellSize);
    const j = Math.round((y - bounds.min[1]) / cellSize);
    if (i < 0 || j < 0 || i >= width || j >= height) return null;
    const under = data[j * width + i];
    if (!Number.isFinite(under)) return null;
    return z - under > seated ? null : z;
  };
}

/**
 * Cut along a polyline at a depth that follows the surface.
 *
 * Resampled, because Z is only right where there is a point to put it on: a
 * 40mm straight line across a slope is two points, and cutting it as two points
 * is exactly the flat behaviour this replaces. The step is the resolution the
 * *surface* is being followed at, not the resolution of the geometry.
 */
function cutAlong(cl, flat, {
  zAt, clearanceZ, feedPlane, step, tolerance = 0.01, bridge = 0,
}) {
  const source = [];
  for (let i = 0; i < flat.length; i += 2) source.push([flat[i], flat[i + 1]]);
  if (source.length < 2) return false;

  // Every point the pass could put the tool at, at the resolution the surface
  // is followed at, with `null` where there is no surface to follow.
  const walk = [];
  for (let i = 0; i < source.length; i++) {
    if (i > 0) {
      const [x0, y0] = source[i - 1];
      const [x1, y1] = source[i];
      const span = Math.hypot(x1 - x0, y1 - y0);
      const pieces = step > 0 ? Math.max(1, Math.ceil(span / step)) : 1;
      for (let k = 1; k < pieces; k++) {
        const t = k / pieces;
        walk.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, true]);
      }
    }
    walk.push([...source[i], false]);
  }

  // Split into runs of consecutive points that have a surface under them. A
  // line that leaves the part and comes back is two marks, not one mark with a
  // dive through the middle of it.
  let cut = false;
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const [fx, fy, fz] = run[0];
      approach(cl, fx, fy, fz, { clearance: clearanceZ, feedPlane });
      for (let i = 1; i < run.length; i++) {
        const [x, y, z, interpolated] = run[i];
        // An interpolated point is only worth writing where the surface departs
        // from the straight line the move would otherwise be. On a flat face
        // that is never, so a two-point line stays a two-point line rather than
        // becoming fifty moves that say the same thing.
        if (!interpolated) { cl.cut(x, y, z); continue; }
        const prev = run[i - 1];
        const next = run[i + 1] ?? prev;
        const mid = (prev[2] + next[2]) / 2;
        if (Math.abs(z - mid) > tolerance) cl.cut(x, y, z);
      }
      const last = run[run.length - 1];
      cl.cut(last[0], last[1], last[2]);
      cl.rapid(...lastXY(cl), clearanceZ);
      cut = true;
    }
    run = [];
  };

  // How far the surface may drop between two samples before it stops being the
  // same surface. A groove follows a *slope*; it cannot follow a *wall*, and a
  // pocket edge is a wall. Without this the mark dives off every step it
  // crosses and climbs out the other side — "it goes up and down", and on a
  // feature the cutter does not fit into it dives as far as the cutter's own
  // flanks allow, which is a gouge nobody asked for in the middle of a line.
  //
  // One sample of rise per sample of run is 45°, which no engraving cutter cuts
  // as a floor and every real engraved face is well under.
  const maxDrop = step > 0 ? step * MAX_FOLLOW_SLOPE : Infinity;

  // How far the surface may go missing and the pass carry on across it.
  //
  // A gap shorter than the cutter is not a gap the cutter can honour: every
  // point of it lies inside one footprint, so the tool spans it whatever the
  // path says, and lifting out and back in cuts the same metal with two extra
  // moves and a peck. And they are everywhere — a mark run *along* an edge puts
  // the tool centre exactly on the boundary, where "is the tool seated" is a
  // coin flip from one sample to the next. Measured on the sample part: 106
  // fragments averaging 1.5mm of cut, three quarters of them within a
  // millimetre of the one before. That is the reported pecking.
  //
  // **Bridged by carrying the points, not by dropping them.** Leaving them out
  // was the first fix, and it trades a peck for a chord: the tool jumps straight
  // from the last seated sample to the next one. Along a *circular* boundary —
  // the commonest engraved line there is — the seated test is a coin flip from
  // one sample to the next, so half the points disappear, at random, and the
  // circle comes out as a polygon with unequal sides. Measured on a ⌀20 rim: 200
  // points in, 94 out, chords of 0.31mm next to chords of 1.26mm. That is the
  // reported "jagged, not circular at all".
  //
  // The line was drawn where it was drawn. A bridge only says the tool does not
  // *lift* across the gap, so the XY is kept exactly as it was and only the
  // height is invented — interpolated along the span between the surface either
  // side of it, which is the one thing that really is unknown in the middle.
  let pending = [];   // points with no surface under them, waiting to be bridged
  for (const [x, y, interpolated] of walk) {
    const z = zAt(x, y);
    const from = run[run.length - 1];
    if (z === null) {
      // too far to span: this really is the end of the mark
      if (!from || Math.hypot(x - from[0], y - from[1]) > bridge) {
        flush();
        pending = [];
      } else {
        pending.push([x, y, interpolated]);
      }
      continue;
    }
    // A bridge is only a bridge if the far side is within reach of the near one.
    // The slope limit is judged from the last *seated* point across the ground
    // the bridge actually covers, so a gap with a wall hidden in it still breaks
    // the mark instead of being ramped smoothly through.
    const span = from ? Math.hypot(x - from[0], y - from[1]) : 0;
    const tooFar = pending.length > 0 && span > bridge;
    const stepped = !!from
      && Math.abs(z - from[2]) > Math.max(maxDrop, span * MAX_FOLLOW_SLOPE);
    if (tooFar || stepped) flush();
    else if (pending.length) carryAcross(run, pending, [x, y, z]);
    pending = [];
    run.push([x, y, z, interpolated]);
  }
  flush();
  return cut;
}

/**
 * Put the bridged points back, at a height interpolated across the gap.
 *
 * By distance along the points rather than by count, so a bridge made of one
 * long chord and six short ones carries its height at the rate the tool travels
 * and not at the rate the samples happen to fall.
 *
 * @param run the points cut so far; its last entry is the surface before the gap
 * @param pending [x, y, interpolated] for each point with no surface under it
 * @param far [x, y, z] the first point on the other side, where the surface is
 *   known again
 */
function carryAcross(run, pending, far) {
  const from = run[run.length - 1];
  const stops = [from, ...pending, far];
  const along = [0];
  let total = 0;
  for (let i = 1; i < stops.length; i++) {
    total += Math.hypot(stops[i][0] - stops[i - 1][0], stops[i][1] - stops[i - 1][1]);
    along.push(total);
  }
  for (let i = 0; i < pending.length; i++) {
    const t = total > 0 ? along[i + 1] / total : 0;
    run.push([pending[i][0], pending[i][1], from[2] + (far[2] - from[2]) * t, pending[i][2]]);
  }
}

/**
 * The same boundaries, in an order that does not cross the work between each
 * one. `orderByProximity` works on flat loops, so the entries are matched back
 * to their reordered loops afterwards.
 */
function orderEntries(entries, cl) {
  if (entries.length < 3) return entries;
  const from = cl.count > 0 ? lastXY(cl) : null;
  const ordered = orderByProximity(entries.map((e) => e.loop), from);
  const byLoop = new Map(entries.map((e) => [e.loop, e]));
  return ordered.map((loop) => byLoop.get(loop)).filter(Boolean);
}

/**
 * A drawing's paths in the shape the loop below expects.
 *
 * The difference from a silhouette is that a drawing has *open* paths in it —
 * a scribed line, a letter stroke, a fold mark — and an open path is not a
 * boundary. It has no inside, so there is nothing to offset toward and nothing
 * to close, and treating it as a loop joins its two ends with a line nobody
 * drew. Closed paths still go through the boundary machinery, because a closed
 * drawn outline *is* a boundary and cutting to one side of it is exactly how
 * you cut a shape out of a plate.
 */
function drawingBoundaries(paths) {
  const outers = [];
  for (const { points, closed } of paths) {
    if (closed && points.length / 2 >= 3) {
      outers.push({ loop: points, isHole: false, isOpen: false });
    } else if (points.length >= 4) {
      outers.push({ loop: points, isHole: false, isOpen: true });
    }
  }
  return { outers, holes: [] };
}

/**
 * How far off the line the cutter runs. `on` is the whole point of engraving;
 * the other two are here because the same machinery traces a line to one side
 * of itself, which is what you want for a scribed cut-off or a witness groove.
 */
function offsetFor(side, radius, isHole) {
  if (side === 'on') return 0;
  const outward = side === 'outside' ? 1 : -1;
  return radius * outward * (isHole ? -1 : 1);
}
