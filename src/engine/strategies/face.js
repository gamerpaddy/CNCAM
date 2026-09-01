// Facing: raster over the stock footprint to bring the top down to size.
//
// No model geometry is needed — facing exists to make a reference surface, so
// it clears the stock top whatever is underneath. Passes run at a chosen angle
// and either zig-zag (fast, alternating climb and conventional) or go one way
// only (slower, but every pass cuts in the same direction and leaves a more
// even finish).
//
// Entry and exit happen off the material: rows are extended past the stock so
// the cutter is never asked to plunge into the middle of a face.

import { CLBuilder, lastXY } from '../cl.js';
import { mergeTolerance } from '../simplify.js';
import { depthPasses, stockOutline } from '../stock.js';
import { loopsBounds, clipOpenPaths } from '../../geom/clipper.js';
import { applyRegionsToArea, regionsActive } from '../regions.js';
import { applyCutting } from '../cutting.js';
import { approach, entryPlane, crossingPlane, goHome } from '../heights.js';
import { radiusAt } from '../tool-geometry.js';

export function generateFace({
  stock, tool, params, regions, fixtures,
}) {
  const r = tool.diameter / 2;
  const step = Math.max(0.1, (params.stepover ?? 0.5) * tool.diameter);
  const clearance = params.clearanceHeight;
  const oneWay = (params.pattern ?? 'zigzag') === 'oneway';
  const angle = ((params.angleDeg ?? 0) * Math.PI) / 180;
  const tolerance = params.tolerance ?? 0.01;

  // Stock to leave on the face, which for a raster over a flat floor is one
  // thing only: how high above Bottom Z the cut stops.
  //
  // The panel has always offered this field for facing and facing has always
  // ignored it, so a roughing face asked to leave 0.2mm for the finish pass
  // took the surface to size and the pass after it cut air. It is not the
  // sideways allowance the profiling strategies mean by the same words — a face
  // has no wall to leave anything on — and saying so is the whole of the fix.
  const allowance = Math.max(0, params.stockToLeave ?? 0);
  const floorZ = params.bottomZ + allowance;


  const cl = new CLBuilder().simplify(mergeTolerance(tolerance));
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  const area = applyRegionsToArea(stockOutline(stock, 0), regions, { radius: r, tolerance });
  if (area.length === 0) {
    cl.warn('facing has nothing left to machine after the region filter');
    return cl.finish();
  }
  // Only when the allowance is what took the depth away. A pass with Top Z and
  // Bottom Z already equal is the ordinary way to ask for one cut at a height,
  // and `depthPasses` answers it with exactly that.
  if (allowance > 0 && !(params.topZ > floorZ + 1e-6)) {
    cl.warn(`${allowance}mm to leave is the whole of the ${(params.topZ - params.bottomZ).toFixed(2)}mm `
      + 'this pass had to take off — there is nothing left for it to cut');
    return cl.finish();
  }

  // A billet flush with the top of the part has nothing above it to face. The
  // pass is still emitted — one cut at that height, which is what Top Z equal
  // to Bottom Z asks for — but silence here reads as an operation that did
  // nothing for no reason.
  if (!(params.topZ > params.bottomZ + 1e-6)) {
    cl.info('nothing to face — the billet is already level with the top of the '
      + 'part here, so this pass runs on the finished face without cutting. '
      + 'Give the stock some margin above the part, or lower Bottom Z to take '
      + 'a skim off the part itself.');
  }

  // How far a row runs past the edge of the stock, so the cutter comes right
  // off it rather than stopping with its centre on the corner.
  const overrun = r + 1;

  // What the rows are clipped against, as opposed to what sizes them.
  //
  // These have to be two different shapes. The rows are laid out to overrun the
  // stock by `overrun` at each end — and clipping them against the stock
  // outline took that straight back off, so the moment a setup had any region
  // at all the facing pass stopped at the edge instead of driving off it. The
  // clamp that caused it was 500mm from the part.
  //
  // Growing the outline *before* the regions are subtracted is what keeps both
  // claims: the outer boundary is generous by exactly the overrun, and an
  // avoided island — a clamp, a picked face — is still subtracted at its true
  // size, grown by the tool radius, so it is still a keep-out.
  const clipArea = applyRegionsToArea(stockOutline(stock, overrun), regions,
    { radius: r, tolerance });

  // work in a frame aligned to the raster so the angle is just a rotation
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const toWorld = (u, v) => [u * cos - v * sin, u * sin + v * cos];
  const box = loopsBounds(area);
  const corners = [
    [box.min[0], box.min[1]], [box.max[0], box.min[1]],
    [box.max[0], box.max[1]], [box.min[0], box.max[1]],
  ].map(([x, y]) => [x * cos + y * sin, -x * sin + y * cos]);
  const uMin = Math.min(...corners.map((c) => c[0])) - overrun;
  const uMax = Math.max(...corners.map((c) => c[0])) + overrun;
  const vMin = Math.min(...corners.map((c) => c[1]));
  const vMax = Math.max(...corners.map((c) => c[1]));

  // How wide the cutter is *where it cuts the floor*.
  //
  // Not `r`. A face mill's inserts lead in at an angle, so the ⌀25 preset is
  // 21.25mm across at the tip and only reaches its full 25 some 1.9mm up the
  // side; a bull nose is narrower at the tip by its corner radius. The floor is
  // cut by the tip plane, so the tip plane is what has to reach the edge —
  // engine/tool-geometry.js is the one description of that silhouette and this
  // asks it rather than restating `diameter / 2` and being wrong for every
  // cutter that is not a plain flat mill.
  // A ball nose answers 0 here, and that is the honest answer: its tip is a
  // point, so it never clears a flat floor at any width and the rows have to
  // run right out to the edges. Falling back to `r` when the answer is zero
  // reads as tidiness and is the worst available guess — it was worth 3mm of
  // untouched stock along one side.
  const rFloor = Math.min(r, radiusAt(tool, 0));

  // How far a row may sit inside the edge and still cut it.
  //
  // A radius short of `rFloor`, less the same 1mm cushion the row *ends* take
  // through `overrun`: tangency is not contact. A row placed so its cutting
  // edge lands exactly on the boundary leaves the boundary to rounding, which
  // is a strip of full-height stock down one side of the job.
  const reach = Math.max(0, rFloor - Math.min(1, rFloor));

  // Rows step across the face, the first and last kept within reach of the
  // edges so the full width is covered without cutting needless air.
  //
  // Both ends answer the same question — where must a row sit for the cutter to
  // reach the edge? — and both now answer it the same way. The start used to
  // say `vMin - r + step`, which is "one step on from where the cutter stops
  // touching the work", a different claim: with any stepover under 100% that
  // began the raster a whole cutter early and bought a needless full-width row.
  // A ⌀25 mill at 60% over a 62mm billet cut five rows where four cover it,
  // 507mm against 403mm.
  //
  // The rows are then spread across that span rather than marched out at the
  // full stepover from one end, which is the same distinction one step further
  // on. Marching leaves whatever does not divide evenly at the far end: a ⌀25
  // mill at 0.6 over 70mm of stock put its last row 9.25mm past the edge, so
  // the raster covered −2.88 to 82.13 for a billet running 0 to 70, and the
  // last row cut a third of the bite the others took. Spreading uses the same
  // number of rows — the count is what the stepover decides — at a hair under
  // it, so every row takes the same width of cut and the swath lands on the
  // billet at both ends.
  const first = vMin + reach;
  const last = vMax - reach;
  const span = Math.max(0, last - first);
  const count = Math.max(1, Math.ceil(span / step - 1e-9) + 1);
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(count === 1 ? (first + last) / 2 : first + (span * i) / (count - 1));
  }

  // Whether the region is the raster's bounds or its actual shape.
  //
  // It used to be only the bounds: `area` was computed, `loopsBounds` was taken
  // of it, and every row then ran the full width of that box. So an avoided
  // face — or a clamp, which is an avoided face the app adds for you — shrank
  // the rectangle if it happened to be at the edge and did *nothing at all* if
  // it was in the middle. The pass drove straight over it and reported success.
  //
  // Rows are clipped against the region when there is one to clip against.
  // Without a region the box is the region, and clipping is skipped so the
  // ordinary case stays one span per row.
  //
  // "Without a region" is not the same as "without a *picked* region", which is
  // what this used to ask. The billet has a shape of its own, and on anything
  // but a rectangle the box is emphatically not the region: a facing pass over
  // ⌀120 bar rastered the full 120 × 120 square and drove through four corners
  // of thin air, and over a tube it went straight across the bore — the very
  // failure the paragraph above describes, with the stock playing the part of
  // the island in the middle. So the question is whether the area *is* its own
  // bounding box, and a plain billet still answers yes and is still unclipped.
  const shaped = regionsActive(regions) || !isOwnBounds(area);
  const crossAt = crossingPlane(params, stock, fixtures);

  let zEntry = params.topZ;
  for (const z of depthPasses(params.topZ, floorZ, params.stepdown)) {
    let forward = true;
    let started = false;
    const feedPlane = entryPlane(params, zEntry, z);
    const home = crossAt != null && crossAt > z + 1e-9
      ? Math.min(crossAt, clearance) : clearance;

    for (const v of rows) {
      const a = toWorld(forward ? uMin : uMax, v);
      const b = toWorld(forward ? uMax : uMin, v);
      // one span across the whole row, or the pieces of it that survive the
      // region — in the order the tool is travelling, so a row broken by an
      // island is still cut left to right
      const spans = shaped
        ? orderSpans(clipOpenPaths([[a[0], a[1], b[0], b[1]]], clipArea, 'intersect'), a)
        : [[a[0], a[1], b[0], b[1]]];

      for (const span of spans) {
        const from = [span[0], span[1]];
        const to = [span[span.length - 2], span[span.length - 1]];
        const contiguous = started && !oneWay && spans.length === 1;
        if (!started) {
          approach(cl, from[0], from[1], z, { clearance, feedPlane });
          started = true;
        } else if (contiguous) {
          cl.cut(from[0], from[1], z);        // step over, still off the material
        } else {
          // a gap the region made, or a one-way pass: lift, cross, come back
          cl.rapid(...lastXY(cl), home);
          approach(cl, from[0], from[1], z, { clearance: home, feedPlane });
        }
        for (let i = 2; i < span.length; i += 2) cl.cut(span[i], span[i + 1], z);
        if (span.length === 4) cl.cut(to[0], to[1], z);
      }
      if (!oneWay && spans.length > 0) forward = !forward;
    }
    cl.rapid(...lastXY(cl), home);
    // Only a level that cut something has taken the surface down to itself; a
    // level whose rows were all clipped away leaves the material standing where
    // it was, and the pass below must still enter through that.
    if (started) zEntry = z;
  }
  goHome(cl, clearance);
  return cl.finish();
}

/**
 * Is this area exactly the axis-aligned rectangle its own bounds describe?
 *
 * Only then can a row span the bounds and be certain it stayed inside the area,
 * which is what lets the common case skip the clipper entirely.
 */
function isOwnBounds(loops, eps = 1e-6) {
  if (loops.length !== 1 || loops[0].length !== 8) return false;
  const { min, max } = loopsBounds(loops);
  const at = (v, lo, hi) => Math.abs(v - lo) < eps || Math.abs(v - hi) < eps;
  for (let i = 0; i < 8; i += 2) {
    if (!at(loops[0][i], min[0], max[0]) || !at(loops[0][i + 1], min[1], max[1])) return false;
  }
  return true;
}

/** Clipped spans in the order the row is being travelled, nearest end first. */
function orderSpans(spans, from) {
  const withEnds = spans.map((span) => {
    const head = [span[0], span[1]];
    const tail = [span[span.length - 2], span[span.length - 1]];
    // the clipper does not promise which way round a span comes back
    const flip = Math.hypot(tail[0] - from[0], tail[1] - from[1])
      < Math.hypot(head[0] - from[0], head[1] - from[1]);
    if (!flip) return span;
    const out = [];
    for (let i = span.length - 2; i >= 0; i -= 2) out.push(span[i], span[i + 1]);
    return out;
  });
  return withEnds.sort((p, q) => (
    Math.hypot(p[0] - from[0], p[1] - from[1]) - Math.hypot(q[0] - from[0], q[1] - from[1])
  ));
}
