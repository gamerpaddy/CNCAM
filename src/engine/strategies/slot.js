// Slotting: cut a channel along a line.
//
// Every other 2.5D strategy in here is told a *region* and works out where the
// cutter may go. A slot is the other way round: the line is given — a keyway, a
// cable channel, a T-slot, a groove for a seal — and what has to be worked out
// is how to get down it without breaking the cutter.
//
// Three things make that different from tracing the line at depth, and all
// three are why slotting has its own strategy rather than being a contour with
// no offset:
//
//   * **It is a full-width cut.** A cutter in a slot is engaged on both sides
//     at once, all the way round its nose, with nowhere for the chip to go.
//     That is the heaviest thing a milling cutter ever does, and it is why the
//     depth is taken in passes and why the entry is a ramp rather than a plunge
//     — a slotting operation that plunges is an operation that breaks drills
//     disguised as end mills.
//   * **The slot may be wider than the cutter.** A 10mm slot with a 6mm cutter
//     is three lanes: down the middle, then out to each wall. Cutting the
//     middle first is what turns the two wall passes into ordinary side cuts
//     with somewhere for the chip to go.
//   * **The finished width is the point.** The outer lanes land exactly on the
//     wall, so the slot comes out the width that was asked for rather than the
//     width the stepover happened to reach.
//
// The line comes from an imported DXF where there is one — a slot centreline is
// a thing you draw, not a thing the solid has an outline of — and from the
// part's own boundaries where there is not.

import { CLBuilder, FEED, lastXY } from '../cl.js';
import { plural, pluralEs } from '../text.js';
import { offsetLoops } from '../../geom/clipper.js';
import { silhouetteAbove } from '../../geom/silhouette.js';
import { depthPasses } from '../stock.js';
import { orderByProximity, cutLoopWithRamp, cutSpanWithRamp } from '../linking.js';
import { orientLoop } from '../leads.js';
import { applyRegionsToPaths } from '../regions.js';
import { entryPlane, crossingPlane, goHome, EntrySurface } from '../heights.js';
import { applyCutting } from '../cutting.js';
import { mergeTolerance } from '../simplify.js';
import { splitBoundaries } from './chamfer.js';

export function generateSlot({
  mesh, tool, params, regions, drawing, stock, fixtures,
}) {
  const clearanceZ = params.clearanceHeight;
  const tolerance = params.tolerance ?? 0.01;
  const direction = params.direction ?? 'climb';
  const rampAngle = params.rampAngle ?? 0;
  const diameter = Math.max(0.01, tool.diameter);
  const r = diameter / 2;

  // Stock to leave, which a slot has two places to put and the panel offers as
  // one number — the same number every other strategy here means by it, so it
  // is the same distance from the finished surface in both: the floor stops
  // that far above Bottom Z, and the outermost lane stops that far short of
  // each wall. Slotting read neither, so an operation asked to rough a channel
  // out and leave 0.3mm all round cut it to size and left the finishing pass
  // nothing to do.
  //
  // A slot no wider than the cutter has no wall allowance available — the cut
  // is full width by definition — so there the number applies to the floor
  // alone rather than being quietly rounded up into a slot 0.6mm narrow.
  const allowance = Math.max(0, params.stockToLeave ?? 0);
  const floorZ = params.bottomZ + allowance;

  // how high a pass has to go to reach the next one — see engine/heights.js
  const crossAt = crossingPlane(params, stock, fixtures);

  // The centrelines come off the same silhouette contouring uses, at the same
  // tolerance, so they carry the same crowd of near-collinear points. Every
  // other strategy that traces them collapses that on the way out; this one did
  // not, and posted seven G1s where a contour of the identical loop posted one.
  const cl = new CLBuilder().simplify(mergeTolerance(tolerance));
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  const asked = Math.max(0, params.slotWidth ?? 0);
  const width = asked > 0 ? asked : diameter;
  if (width < diameter - 1e-6) {
    cl.warn(`a ${width}mm slot cannot be cut with a ⌀${diameter} cutter — the slot is `
      + 'never narrower than the tool that makes it');
    return cl.finish();
  }
  if (!(params.topZ > params.bottomZ + 1e-6)) {
    cl.warn('the slot has no depth — Top Z is the surface and Bottom Z is its floor');
    return cl.finish();
  }
  if (allowance > 0 && !(params.topZ > floorZ + 1e-6)) {
    cl.warn(`${allowance}mm to leave is the whole depth of the slot — there is `
      + 'nothing left for this pass to cut');
    return cl.finish();
  }
  if (rampAngle <= 0) {
    cl.warn('ramp angle is 0, so every pass enters by plunging into a full-width '
      + 'cut — set a few degrees unless the cutter is centre-cutting and you mean it');
  }

  const drawnPaths = drawing?.length ? drawing : null;
  if (drawing && drawing.length === 0) {
    cl.warn('the drawing has no lines in it — check the DXF imported what you expected');
    return cl.finish();
  }

  const lanes = laneOffsets(Math.max(0, (width - diameter) / 2 - allowance),
    Math.max(0.05, (params.stepover ?? 0.5) * diameter));
  // One line for the whole cut, read at the bottom of it — not the outline as
  // it stands at each depth.
  //
  // A slot is a channel along a line, and a line that moves as you go down is
  // not one channel. Re-reading the part's boundary at every level meant that
  // the moment the cross-section changed, the pass was following a line nothing
  // had ever cut: on the step plate the outline jumps from the 60×40 boss to
  // the 100×70 plate at Z12, and that pass rapided down to a feed plane 11mm
  // inside solid billet and then took a **13.5mm-deep full-width cut** with a
  // ⌀6 cutter. On the sloped part the line crept outward at every level and did
  // it 473 times, up to 20.8mm deep. Both reported themselves as "16 depth
  // pass(es)", one stepdown each.
  //
  // The shadow at the floor of the cut is the outline that covers all of it, so
  // every level runs down the same line and each pass takes exactly the
  // stepdown — which is what the number means and what makes the cut safe. It
  // is the same choice contour makes by default, for the same reason.
  const centres = drawnPaths
    ? drawnPaths.map(({ points, closed }) => ({ points, closed }))
    : boundaryCentres(silhouetteAbove(mesh, floorZ, { tolerance }));
  const levels = [...depthPasses(params.topZ, floorZ, params.stepdown)];

  let cutAnything = false;
  // The line is fixed now, so a pass normally enters through what the level
  // above cut. This still tracks it, because the *regions* can clip a line
  // differently at different depths — a picked face, a clamp — and a span that
  // appears when a keep-out ends is untouched ground like any other.
  // See engine/heights.js EntrySurface.
  const surface = new EntrySurface(params.topZ, r);
  for (const z of levels) {
    surface.beginLevel();
    for (const lane of lanes) {
      const paths = [];
      for (const { points, closed } of centres) {
        for (const shifted of shiftPath(points, closed, lane, tolerance)) {
          paths.push({ points: shifted, closed });
        }
      }
      // nearest first: a plate with six slots in it is six entries, and the
      // order the geometry came out in is not where they are
      const ordered = orderByProximity(paths.map((p) => p.points),
        cl.count > 0 ? lastXY(cl) : null);
      const byPoints = new Map(paths.map((p) => [p.points, p]));

      for (const points of ordered) {
        const { closed } = byPoints.get(points);
        const { closed: keptLoops, open: keptOpen } = applyRegionsToPaths(
          [points], regions, { radius: r, tolerance });
        // Where this line's material actually starts, and how many passes it
        // takes to get down to this level from there.
        //
        // Normally one: the line was cut at the level above and the stepdown is
        // the whole of what is left. But a line that appears when the
        // cross-section changes has never been cut at all, and taking it in one
        // pass is a full-width cut as deep as the tool has been asked to go —
        // 13.5mm with a ⌀6 cutter on the step plate, 24.7mm on the sloped one,
        // both reported in the summary as "16 depth pass(es)". A slot is the
        // heaviest cut a mill makes; the depth per pass is the one promise it
        // has to keep.
        const top = surface.entryFor(points, closed);
        let from = top;
        for (const zz of depthPasses(top, z, params.stepdown)) {
          const feedPlane = entryPlane(params, from, zz);
          const pass = {
            z: zz, zEntry: from, clearanceZ, crossAt, rampAngle, feedPlane, direction,
          };
          from = zz;
          // A clipped loop is not a loop any more. `applyRegionsToPaths` hands
          // the surviving spans back as open polylines — and whenever any region
          // is active it returns *everything* that way, with `closed` empty — so
          // taking only `closed` for a closed input threw the whole path away.
          // What that looked like: a slot following the part's own boundary cut
          // nothing at all the moment the setup had a clamp in it, anywhere,
          // even 500mm clear of the work, and blamed the part for having no
          // outline. Contour and engrave both cut the two lists; this cuts them
          // too.
          for (const path of keptLoops) {
            if (cutOne(cl, path, closed, pass)) { cutAnything = true; surface.covered(path, closed); }
          }
          for (const path of keptOpen) {
            if (cutOne(cl, path, false, pass)) { cutAnything = true; surface.covered(path, false); }
          }
        }
      }
    }
    surface.endLevel(z);
  }

  if (!cutAnything) {
    cl.warn(drawnPaths
      ? 'slotting cut nothing — every line was clipped away by the picked regions'
      : 'slotting found no lines — with no drawing to follow it uses the part\'s '
        + 'own boundary at Top Z, and there is none here');
    return cl.finish();
  }
  // the passes are allowed below clearance, so the last one has to put the tool
  // back before the next operation or tool change assumes it is there
  goHome(cl, clearanceZ);
  const wallLeft = Math.min(allowance, Math.max(0, (width - diameter) / 2));
  cl.info(`${width.toFixed(2)}mm slot with a ⌀${diameter} cutter — `
    + `${plural(lanes.length, 'lane')} × ${pluralEs(levels.length, 'depth pass')}, `
    + `${(params.topZ - floorZ).toFixed(2)}mm deep`
    + (allowance > 0
      ? `, leaving ${allowance}mm on the floor and ${wallLeft.toFixed(2)}mm on each wall`
      : ''));
  return cl.finish();
}

/**
 * Where the cutter centre runs, to leave a slot `reach` wider than itself on
 * each side.
 *
 * The middle first, then out to alternating walls. Cutting the middle first is
 * what makes the wall passes ordinary side cuts instead of two more full-width
 * ones, and landing the outermost lane *exactly* on the wall is what makes the
 * finished slot the width that was asked for rather than the width the stepover
 * happened to reach.
 */
export function laneOffsets(reach, stepover) {
  if (!(reach > 1e-6)) return [0];
  const n = Math.max(1, Math.ceil(reach / stepover));
  const out = [0];
  for (let k = 1; k <= n; k++) {
    const d = (reach * k) / n;
    out.push(-d, d);
  }
  return out;
}

/** The part's own boundaries at a level, as centrelines to run down. */
function boundaryCentres(shadow) {
  const { outers, holes } = splitBoundaries(shadow, 'all');
  return [...outers, ...holes]
    .filter(({ loop }) => loop.length / 2 >= 3)
    .map(({ loop }) => ({ points: loop, closed: true }));
}

/**
 * The same path, moved sideways by `d`.
 *
 * Closed loops go through the offsetter, which is exact and handles a corner
 * turning into an arc or a loop vanishing. An open polyline has no inside for
 * the offsetter to work from, so it is moved along its own vertex normals —
 * good to a fraction of a millimetre for the offsets a slot uses, which are at
 * most half the difference between the slot and the cutter, and never asked to
 * survive a corner tighter than the cutter can cut anyway.
 */
function shiftPath(points, closed, d, tolerance) {
  if (Math.abs(d) < 1e-9) return [points];
  if (closed) return offsetLoops([points], d, tolerance);
  const n = points.length / 2;
  if (n < 2) return [];
  const out = new Array(points.length);
  for (let i = 0; i < n; i++) {
    const [ax, ay] = [points[Math.max(0, i - 1) * 2], points[Math.max(0, i - 1) * 2 + 1]];
    const [bx, by] = [points[Math.min(n - 1, i + 1) * 2], points[Math.min(n - 1, i + 1) * 2 + 1]];
    let nx = by - ay;
    let ny = -(bx - ax);
    const len = Math.hypot(nx, ny);
    if (len < 1e-9) { nx = 0; ny = 0; } else { nx /= len; ny /= len; }
    out[i * 2] = points[i * 2] + nx * d;
    out[i * 2 + 1] = points[i * 2 + 1] + ny * d;
  }
  return [out];
}

/**
 * One lane of one path at one depth. @returns whether anything was emitted
 *
 * A slot is the deepest thing in this app — ten passes down a 30mm channel is
 * ordinary — and it used to arrive at and leave from full clearance every one
 * of them. Measured on the sample part that was 82 climbs and 2.6m of vertical
 * rapid to cut 4.8m of slot. `crossAt` is the plane a gap above the stock,
 * which clears the whole job by construction; the passes travel at that instead
 * and `goHome` puts the tool back at the end. Fixtures in the setup take it
 * away again, because nothing here can route around a clamp.
 */
function cutOne(cl, path, closed,
  { z, zEntry, clearanceZ, crossAt, rampAngle, feedPlane, direction }) {
  const n = path.length / 2;
  const home = crossAt != null && crossAt > z + 1e-9
    ? Math.min(crossAt, clearanceZ) : clearanceZ;
  if (closed) {
    if (n < 3) return false;
    const loop = orientLoop(path, direction, false);
    cl.rapid(loop[0], loop[1], home);
    cutLoopWithRamp(cl, loop, zEntry, z, rampAngle, { feedPlane });
    cl.rapid(...lastXY(cl), home);
    return true;
  }
  if (n < 2) return false;
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([path[i * 2], path[i * 2 + 1]]);
  cl.rapid(pts[0][0], pts[0][1], home);
  if (feedPlane != null && feedPlane > z + 1e-9) cl.rapid(pts[0][0], pts[0][1], feedPlane);
  cutSpanWithRamp((x, y, zz, feed = FEED.CUT) => cl.cut(x, y, zz, feed),
    pts, zEntry, z, rampAngle);
  cl.rapid(...lastXY(cl), home);
  return true;
}
