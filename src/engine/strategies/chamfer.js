// Chamfer / deburr: break the edges every other operation leaves sharp.
//
// This is the pass nobody models and everybody cuts. A contour leaves a wall
// with a knife edge on top of it; a pocket leaves the same edge pointing the
// other way. Deburring by hand is the slowest, least repeatable minute of a
// part's life, and a chamfer mill does it in seconds — but only if the toolpath
// puts the cone where the edge is, which is arithmetic nobody wants to do at
// the machine.
//
// The geometry, once, so the rest of the file can be about cutting:
//
//   The cutter is a cone of included angle A, half-angle a = A/2 from the axis,
//   ending in a flat of radius `tipR` (zero on a true point). Its radius at
//   height z above the tip is  R(z) = tipR + z·tan(a).
//
//   A chamfer of horizontal width w on an edge at Z = edgeZ is the plane that
//   runs from (profile − w, edgeZ) down to (profile, edgeZ − w/tan(a)). Putting
//   the cone flank on that plane and dropping the tip a further `clearance`
//   below it — so the flat never rubs the wall underneath — gives
//
//       axis offset from the profile = tipR + clearance·tan(a)
//       tip below the edge           = w/tan(a) + clearance
//
//   Both fall straight out of R(z); see chamferGeometry.
//
// Which side of a boundary the tool goes is not asked, because it is not a
// choice: the outline of the part is chamfered from outside it, and a hole is
// chamfered from inside it. Asking gets it wrong half the time.

import { CLBuilder, FEED, lastXY } from '../cl.js';
import { plural } from '../text.js';
import { offsetLoops, unionWithHoles, loopArea } from '../../geom/clipper.js';
import { silhouetteAbove } from '../../geom/silhouette.js';
import { orientLoop, leadInPoints, emitLeadOut } from '../leads.js';
import { cutPerimeter, orderByProximity } from '../linking.js';
import { applyRegionsToPaths, regionsActive } from '../regions.js';
import { approach, entryPlane } from '../heights.js';
import { applyCutting } from '../cutting.js';
import { tipAngleOf } from '../tool-geometry.js';
import { buildHeightmap } from '../../geom/heightmap.js';

/**
 * Where the cutter has to be to leave a chamfer of `width` on an edge.
 *
 * @param tool needs `tipAngle` (included, degrees) and optionally `tipDiameter`
 * @returns { pointed, halfAngle, offset, drop, faceDepth, engagedRadius }
 *   offset — how far the axis stands off the profile line, always positive
 *   drop   — how far the tip goes below the edge
 *   engagedRadius — the cutter radius in contact at the top of the chamfer,
 *     which is what has to fit inside the cutter's own radius
 */
export function chamferGeometry(tool, { width, clearance = 0 }) {
  // `tipAngleOf`, not the raw field: a chamfer mill with the angle left blank
  // is a 90° chamfer mill everywhere else in the app — that is what the icon
  // draws and what the simulator carves with. Reading the field directly here
  // meant the strategy refused to plan a cutter the simulation was perfectly
  // happy to cut with, which is the same shape described in two places
  // disagreeing about itself.
  const included = tipAngleOf(tool);
  // A cutter with no point angle is a cylinder; there is no cone to lay on the
  // edge and no honest number to invent for one.
  if (!(included > 0) || included >= 180) {
    return { pointed: false, halfAngle: 0, offset: 0, drop: 0, faceDepth: 0, engagedRadius: 0 };
  }
  const halfAngle = ((included / 2) * Math.PI) / 180;
  const tan = Math.tan(halfAngle);
  const tipR = Math.max(0, (tool?.tipDiameter ?? 0) / 2);
  const faceDepth = width / tan;
  const drop = faceDepth + clearance;
  return {
    pointed: true,
    halfAngle,
    faceDepth,
    drop,
    offset: tipR + clearance * tan,
    engagedRadius: tipR + drop * tan,
  };
}

/**
 * What a picked region means for a chamfer, in the two numbers the region
 * filter needs — and both of them are about the *cone*, not the cutter.
 *
 * A chamfer mill is a ⌀12 tool that takes metal off inside a millimetre of its
 * axis. Every other strategy's cutter removes material out to its full radius,
 * so `engine/regions.js` is handed `tool.diameter / 2` and grows a keep-out by
 * it; handed the same number here, a hole picked to be left alone reserved a
 * ⌀12 disc round itself. Measured: a ⌀6 hole 5mm clear of a pocket wall, marked
 * "never machine", took a 7.3mm bite out of the pocket's own chamfer — an
 * unbroken edge either side of a gap where nothing was ever going to be cut.
 * `engagedRadius` is where the cone actually touches, which is the overlap
 * worth checking.
 *
 * `includeGrow` is the other side of the same fact. A picked face selects
 * *edges*, and the tool centre stands `offset` outside them — so "machine only
 * here" has to be grown by that much to contain its own path, where a pass that
 * runs *over* the face erodes it by the radius instead. See toolAdjusted.
 *
 * @returns { cutRadius, includeGrow }
 */
export function chamferRegionReach(tool, params) {
  const g = chamferGeometry(tool, {
    width: Math.max(0, params?.chamferWidth ?? 0),
    clearance: Math.max(0, params?.chamferClearance ?? 0),
  });
  const tolerance = params?.tolerance ?? 0.01;
  // never wider than the cutter itself: a chamfer that needs more cone than the
  // tool has is refused below, but this is read before that and has to stay
  // honest about a tool that would be asked to do it
  const body = Math.max(0, (tool?.diameter ?? 0) / 2);
  const cone = Math.max(0, g.engagedRadius);
  return {
    cutRadius: body > 0 ? Math.min(cone, body) : cone,
    includeGrow: g.offset + Math.max(tolerance * 2, 0.05),
  };
}

export function generateChamfer({ mesh, tool, params, regions }) {
  const clearanceZ = params.clearanceHeight;
  const tolerance = params.tolerance ?? 0.01;
  const direction = params.direction ?? 'climb';
  const lead = { type: params.leadType ?? 'none', radius: params.leadRadius ?? 0 };
  const width = Math.max(0, params.chamferWidth ?? 0);
  const tipClear = Math.max(0, params.chamferClearance ?? 0);
  const edgeZ = params.topZ;
  const passes = Math.max(1, Math.round(params.chamferPasses ?? 1));
  const which = params.chamferEdges ?? 'all';

  const cl = new CLBuilder();
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  if (!(width > 0)) {
    cl.warn('chamfer width is 0 — set the width of the edge break you want');
    return cl.finish();
  }
  const full = chamferGeometry(tool, { width, clearance: tipClear });
  if (!full.pointed) {
    cl.warn(`${tool.name ?? 'this cutter'} has no point angle — chamfering needs a `
      + 'chamfer mill, a spot drill or a V bit (set Tip angle on the tool)');
    return cl.finish();
  }
  if (full.engagedRadius > tool.diameter / 2 + 1e-6) {
    const most = maxWidthFor(tool, tipClear);
    cl.warn(`a ${width}mm chamfer needs ⌀${(full.engagedRadius * 2).toFixed(2)} of cone and this `
      + `cutter is ⌀${tool.diameter} — the widest it reaches is ${most.toFixed(2)}mm`);
    return cl.finish();
  }
  if (full.drop > (tool.fluteLength || Infinity) + 1e-6) {
    cl.warn(`the chamfer reaches ${full.drop.toFixed(2)}mm below the edge and the cutter has `
      + `${tool.fluteLength}mm of flute`);
  }

  // Picked edges are followed as they are, at whatever height each one is at.
  //
  // Everything below this works from one horizontal slice, because with nothing
  // picked the edge being broken *is* the profile at Edge Z. Once an edge has
  // been pointed at, that is no longer an assumption worth making: an edge that
  // slopes, or spirals down a bore, is at a different Z at every point along it,
  // and the slice at Edge Z crosses it at one point or at none. Measured on a
  // ramp: every one of its six edges, including the two that live at Z0,
  // chamfered at Z8.5 — and on a spiral, whose plan view never touches the
  // profile, the operation reported that it had nothing to cut at all.
  const edgePaths = regions?.edgePaths ?? [];
  if (edgePaths.length) {
    return chamferAlongEdges(cl, edgePaths, {
      mesh, tool, params, width, tipClear, passes, tolerance, clearanceZ,
    });
  }

  // The boundary just under the edge is the edge, seen from above. Taken *at*
  // the edge plane it is empty or ragged, depending on which side of a
  // tessellated facet the slice lands on.
  const gap = Math.max(tolerance, 0.01);
  const shadow = silhouetteAbove(mesh, edgeZ - gap, { tolerance });
  const { outers, holes } = splitBoundaries(shadow, which);
  if (outers.length === 0 && holes.length === 0) {
    cl.warn(`nothing to chamfer at Z${edgeZ.toFixed(2)} — Top Z is the edge the tool breaks, `
      + 'so it belongs on the surface the edge is in');
    return cl.finish();
  }

  // Is this plane an edge at all?
  //
  // An edge is where material stops. If the part carries straight on upward
  // through Edge Z — because the height was left where another strategy put it,
  // or aimed at a wall rather than at the face the corner is in — then there is
  // no corner here, and the cone is placed a chamfer's depth *below* a surface
  // that continues above it: the cutter runs along inside the solid instead of
  // breaking anything. A setting mistake that produces a confident and
  // completely wrong toolpath is worth saying out loud.
  const above = coverage(silhouetteAbove(mesh, edgeZ + gap, { tolerance }));
  if (above > coverage(shadow) * 0.9) {
    cl.warn(`the part carries on upward through Z${edgeZ.toFixed(2)} — there is no edge `
      + 'here, so the cutter would run inside the material rather than break a corner. '
      + 'Edge Z belongs on the surface the sharp corner is in (Model top snaps to it).');
  }

  const floor = params.bottomZ;
  // The widest the cone gets in this operation, and the standoff every pass
  // shares — the offset does not depend on the width, only the depth does.
  const reach = chamferRegionReach(tool, params);
  let cutAnything = false;
  let deepest = edgeZ;
  for (let pass = 1; pass <= passes; pass++) {
    // Each pass cuts a complete, narrower chamfer off the same top edge, so the
    // one after it only has a sliver at the bottom left to take. Stepping the
    // *offset* instead would leave the last pass cutting the whole face.
    const g = chamferGeometry(tool, { width: (width * pass) / passes, clearance: tipClear });
    const z = edgeZ - g.drop;
    if (floor != null && z < floor - 1e-6) {
      cl.warn(`the chamfer reaches Z${z.toFixed(2)}, below Bottom Z ${floor.toFixed(2)} — `
        + 'lower Bottom Z or narrow the chamfer');
      break;
    }
    deepest = Math.min(deepest, z);
    for (const { loop, isHole } of [...outers, ...holes]) {
      // outward for the outline, inward for a hole: the tool always stands in
      // the air the edge faces
      const delta = isHole ? -g.offset : g.offset;
      const raw = offsetLoops([loop], delta, tolerance);
      // A picked face selects *edges*, not an area to stay inside. The cutter
      // centre stands `g.offset` off the boundary on the side the material
      // faces — outward on an outline, into the void of a hole — so the face has
      // to be grown by at least that much to contain its own chamfer path.
      // Shrinking it by the tool radius (what every area strategy wants) clips
      // every loop away and the operation reports empty offsets. And a keep-out
      // is grown by the cone rather than by the cutter, for the same reason from
      // the other side — both numbers come from chamferRegionReach above.
      const { closed, open } = applyRegionsToPaths(raw, regions, {
        radius: reach.cutRadius,
        tolerance,
        includeGrow: reach.includeGrow,
      });
      const feedPlane = entryPlane(params, edgeZ, z);
      // nearest first: a chamfer round eight holes visits eight boundaries, and
      // the order they come out of the offsetter in is not where they are
      for (const path of orderByProximity(closed, cl.count > 0 ? lastXY(cl) : null)) {
        if (cutChamferLoop(cl, path, z, {
          clearanceZ, direction, isHole, lead, feedPlane,
        })) cutAnything = true;
      }
      // What survives a region filter is an open span, not a loop — picking one
      // face of a top breaks the outline into the part of it that face owns.
      for (const path of orderByProximity(open, cl.count > 0 ? lastXY(cl) : null, { open: true })) {
        if (cutChamferSpan(cl, path, z, { clearanceZ, feedPlane })) cutAnything = true;
      }
    }
  }

  if (!cutAnything) {
    cl.warn(regionsActive(regions)
      ? 'chamfer produced no passes — none of the picked faces has an edge at Z'
        + `${edgeZ.toFixed(2)}. Pick the face the sharp corner is *in*, and check Top Z is `
        + 'on that face (Model top snaps to it).'
      : 'chamfer produced no passes — the offset profiles came back empty');
  } else {
    // `tipAngleOf`, not the raw field, for the same reason the cut itself uses
    // it: a chamfer mill with the angle left blank is a 90° one, and the report
    // read "0.5mm chamfer at undefined°" — on the line that says what was cut
    cl.info(`${width}mm chamfer at ${tipAngleOf(tool)}° — tip to Z${deepest.toFixed(2)}`
      + (passes > 1 ? ` in ${passes} passes` : ''));
  }
  return cl.finish();
}

/**
 * Chamfer the edges that were picked, along the edges that were picked.
 *
 * The cone still has to go on the outside of the corner, and on a 3D edge there
 * is no outline to say which side that is. The part itself says it: an edge is
 * where a surface stops, so of the two sides of the line the one with *less
 * material above it* is the air. Sampled off the height map a short way either
 * side, which is one question with one answer and needs no slice, no boolean and
 * no guess about whether the feature is a boss or a hole.
 *
 * @param paths [[x, y, z, …]] in setup space
 */
function chamferAlongEdges(cl, paths, {
  mesh, tool, params, width, tipClear, passes, tolerance, clearanceZ,
}) {
  const map = buildHeightmap(mesh, {
    cellSize: Math.max(0.1, Math.min(0.5, tolerance * 8)),
    floor: -Infinity,
    dilate: false,
  });
  const heightAt = (x, y) => {
    const i = Math.round((x - map.bounds.min[0]) / map.cellSize);
    const j = Math.round((y - map.bounds.min[1]) / map.cellSize);
    if (i < 0 || j < 0 || i >= map.width || j >= map.height) return -Infinity;
    return map.data[j * map.width + i];
  };
  // Far enough out to be on the surface either side rather than in the rounding
  // of the crease itself, and never further than the chamfer reaches.
  const probe = Math.max(map.cellSize * 1.5, tolerance * 4);

  const floor = params.bottomZ;
  let cutAnything = false;
  let deepest = Infinity;
  let belowFloor = false;
  let vertical = 0;
  let alongIt = 0;

  for (let pass = 1; pass <= passes; pass++) {
    const g = chamferGeometry(tool, { width: (width * pass) / passes, clearance: tipClear });
    for (const path of orderEdgePaths(paths, cl.count > 0 ? lastXY(cl) : null)) {
      const n = path.length / 3;
      if (n < 2) continue;
      const out = [];
      for (let k = 0; k < n; k++) {
        const x = path[k * 3];
        const y = path[k * 3 + 1];
        const z = path[k * 3 + 2];
        // the tangent from the neighbours, so a corner is mitred rather than
        // stepped
        const a = Math.max(0, k - 1);
        const b = Math.min(n - 1, k + 1);
        const tx = path[b * 3] - path[a * 3];
        const ty = path[b * 3 + 1] - path[a * 3 + 1];
        const len = Math.hypot(tx, ty);
        if (!(len > 1e-9)) { vertical++; continue; }   // this step goes straight down
        alongIt++;
        // the two ways off the line, and which of them is air
        const nx = -ty / len;
        const ny = tx / len;
        const here = heightAt(x + nx * probe, y + ny * probe);
        const there = heightAt(x - nx * probe, y - ny * probe);
        const sign = here <= there ? 1 : -1;
        const tip = z - g.drop;
        if (floor != null && tip < floor - 1e-6) { belowFloor = true; continue; }
        out.push([x + sign * nx * g.offset, y + sign * ny * g.offset, tip]);
        deepest = Math.min(deepest, tip);
      }
      if (out.length < 2) continue;
      const feedPlane = entryPlane(params, out[0][2] + g.drop, out[0][2]);
      approach(cl, out[0][0], out[0][1], out[0][2], { clearance: clearanceZ, feedPlane });
      for (let k = 1; k < out.length; k++) cl.cut(out[k][0], out[k][1], out[k][2]);
      cl.rapid(...lastXY(cl), clearanceZ);
      cutAnything = true;
    }
  }

  if (belowFloor && cutAnything) {
    cl.warn(`part of the chamfer reaches below Bottom Z ${floor.toFixed(2)} and was left `
      + 'uncut — lower Bottom Z or narrow the chamfer');
  }
  // Why it cut nothing, in the words of the thing that stopped it. "No passes"
  // on its own is the message that sent this here in the first place.
  if (!cutAnything) {
    if (alongIt === 0 && vertical > 0) {
      cl.warn('the picked edge runs straight down — a chamfer is cut by running the '
        + 'cone *along* an edge, and there is no along on a vertical corner. Pick the '
        + 'edge at the top or the bottom of that corner.');
    } else if (belowFloor) {
      cl.warn(`the chamfer reaches below Bottom Z ${floor.toFixed(2)} along all but a `
        + 'point or two of the picked edge, and what is left is too short to cut. The '
        + `cone goes ${chamferGeometry(tool, { width, clearance: tipClear }).drop.toFixed(2)}mm `
        + 'under the edge — lower Bottom Z, or narrow the chamfer.');
    } else {
      cl.warn('chamfer produced no passes — the picked edges are shorter than a '
        + 'single move');
    }
  } else {
    cl.info(`${width}mm chamfer along ${plural(paths.length, 'picked edge')} at ${tipAngleOf(tool)}° `
      + `— tip to Z${deepest.toFixed(2)}`
      + (passes > 1 ? ` in ${passes} passes` : ''));
  }
  return cl.finish();
}

/**
 * Nearest first, for paths that carry a Z. `orderByProximity` walks pairs, so
 * the ordering is done on flattened copies and the answer mapped back — the
 * alternative is a second copy of the same travelling-salesman rule that knows
 * about strides.
 */
function orderEdgePaths(paths, from) {
  if (paths.length < 2) return paths;
  const flat = new Map();
  for (const path of paths) {
    const xy = [];
    for (let k = 0; k < path.length; k += 3) xy.push(path[k], path[k + 1]);
    flat.set(xy, path);
  }
  return orderByProximity([...flat.keys()], from, { open: true }).map((xy) => flat.get(xy));
}

/** The widest chamfer this cutter's cone can reach before its shank fouls. */
export function maxWidthFor(tool, clearance = 0) {
  const g = chamferGeometry(tool, { width: 1, clearance: 0 });
  if (!g.pointed) return 0;
  const tan = Math.tan(g.halfAngle);
  const tipR = Math.max(0, (tool?.tipDiameter ?? 0) / 2);
  // engagedRadius = tipR + (w/tan + clearance)·tan = tipR + w + clearance·tan
  return Math.max(0, tool.diameter / 2 - tipR - clearance * tan);
}

/**
 * The boundaries of the material at the edge plane, split by which way the
 * material faces — because that is what decides which side of them the tool
 * goes, and it is the only thing that does.
 *
 * @param which 'outer' | 'holes' | 'all'
 */
export function splitBoundaries(shadow, which = 'all') {
  const outers = [];
  const holes = [];
  for (const region of unionWithHoles(shadow)) {
    if (which !== 'holes') outers.push({ loop: ccw(region.outer), isHole: false });
    if (which !== 'outer') {
      for (const hole of region.holes) holes.push({ loop: ccw(hole), isHole: true });
    }
  }
  return { outers, holes };
}

/** How much XY a set of loops covers, holes taken off. */
function coverage(loops) {
  let area = 0;
  for (const region of unionWithHoles(loops)) {
    area += Math.abs(loopArea(region.outer));
    for (const hole of region.holes) area -= Math.abs(loopArea(hole));
  }
  return Math.max(0, area);
}

/** Counter-clockwise, so a positive offset always means "grow". */
function ccw(loop) {
  if (loopArea(loop) > 0) return loop;
  const n = loop.length / 2;
  const out = new Array(loop.length);
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i;
    out[i * 2] = loop[j * 2];
    out[i * 2 + 1] = loop[j * 2 + 1];
  }
  return out;
}

/** One chamfer pass round one boundary. @returns whether anything was emitted */
function cutChamferLoop(cl, rawLoop, z, { clearanceZ, direction, isHole, lead, feedPlane }) {
  if (rawLoop.length / 2 < 3) return false;
  const loop = orientLoop(rawLoop, direction, isHole);
  const inPts = leadInPoints(loop, lead);
  const [sx, sy] = inPts.length ? inPts[0] : [loop[0], loop[1]];
  approach(cl, sx, sy, z, { clearance: clearanceZ, feedPlane });
  for (let i = 1; i < inPts.length; i++) cl.cut(inPts[i][0], inPts[i][1], z, FEED.LEAD);
  if (inPts.length) cl.cut(loop[0], loop[1], z, FEED.LEAD);
  cutPerimeter(cl, loop, z);
  emitLeadOut(cl, loop, z, lead);
  cl.rapid(...lastXY(cl), clearanceZ);
  return true;
}

/**
 * One chamfer pass along an open span — what a boundary becomes once a picked
 * face has taken its share of it. There is no direction to orient (the span
 * runs the way it was cut out) and no lead (a lead-in arcs onto a closed loop;
 * onto the end of a span it would arc through the corner being broken).
 *
 * @returns whether anything was emitted
 */
function cutChamferSpan(cl, path, z, { clearanceZ, feedPlane }) {
  if (path.length / 2 < 2) return false;
  approach(cl, path[0], path[1], z, { clearance: clearanceZ, feedPlane });
  for (let i = 1; i < path.length / 2; i++) cl.cut(path[i * 2], path[i * 2 + 1], z);
  cl.rapid(...lastXY(cl), clearanceZ);
  return true;
}
