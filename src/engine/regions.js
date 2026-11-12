// Machining regions: the faces you picked in the viewport, applied to a path.
//
// Three lists, all optional and all in setup space:
//   avoid   — never machine here (clamps, fixtures, a surface already finished)
//   include — when non-empty, machine *only* here
//   cleared — already taken off by an earlier operation, so there is nothing
//             here to cut. See engine/rest.js.
//
// `cleared` is not `avoid` with a nicer name, and the difference is the sign of
// the tool adjustment. An avoided face is somewhere the cutter must not reach,
// so the region grows by the radius. A cleared area is somewhere the cutter may
// go freely — what is pointless is *cutting* there — so it shrinks by the
// radius instead: the tool has nothing to do only where the whole of it stands
// in air, and a centre within a radius of the boundary is still taking a chip
// off what is left.
//
// Areas and paths need different treatment. A clearing region is a filled shape,
// so it clips with ordinary polygon booleans. A contour pass is a line, so
// restricting it has to cut the line into surviving spans instead — clipping it
// as an area would return the region it encloses, which is a different curve.

import {
  diffLoops, intersectLoops, clipOpenPaths, loopToOpenPath, offsetLoops, loopArea,
  unionWithHoles,
} from '../geom/clipper.js';
import { pointInLoops } from '../geom/inside.js';

function hasAny(list) { return Array.isArray(list) && list.length > 0; }

/**
 * The cleared area that applies at depth `z`.
 *
 * `cleared` arrives as a stack — one set of loops per depth the operation cuts
 * at — because how much an earlier pass took off depends on how deep you ask
 * (see engine/rest.js clearedStack). A query lands on the deepest slice at or
 * above it, which is the conservative direction: a slice computed higher up
 * claims more has been cleared than has, and skipping ground that is still
 * solid is the one way this may not fail.
 *
 * No depth given — a 3D finishing pass has no single one — takes the deepest
 * slice, which is the smallest area and claims the least. The stack is deepest
 * first, so that is the head of it.
 */
function clearedAt(regions, z) {
  const stack = regions?.cleared;
  if (!hasAny(stack)) return [];
  // an ordinary loop list, from before this was a stack
  if (!stack[0]?.loops) return stack;
  if (!Number.isFinite(z)) return stack[0].loops;
  let best = null;
  for (const slice of stack) {
    if (slice.z <= z + 1e-6 && (!best || slice.z > best.z)) best = slice;
  }
  return best ? best.loops : [];
}

export function regionsActive(regions) {
  return !!regions
    && (hasAny(regions.avoid) || hasAny(regions.include) || hasAny(regions.cleared));
}

/**
 * What to add to "this pass cut nothing" when a region is in play.
 *
 * "Check the heights and the stock size" is the right thing to say about heights
 * and the wrong thing to say about a picked face — it sends somebody to the one
 * tab that is not the problem. A strategy that produced no motion asks this and
 * appends whatever comes back, so the Regions tab is named when it is the likely
 * cause and never claimed as the cause when there is no region at all.
 *
 * @returns a clause to append, or null when no region could be responsible
 */
export function regionRefusal(regions, radius = 0, tolerance = 0.01) {
  if (!regionsActive(regions)) return null;
  const { include } = toolAdjusted(regions, radius, tolerance);
  if (includeVanished(regions, include)) {
    return 'the faces picked to machine have no footprint at all — pick a surface '
      + 'rather than an edge, or clear the picks to machine the whole part';
  }
  if (hasAny(regions.include)) {
    return 'it is also restricted to the faces picked on the Regions tab, which may '
      + 'leave it nothing to do at these heights';
  }
  return 'the keep-outs on the Regions tab — and any clamps in the setup — may be '
    + 'covering all of it';
}

/**
 * Grow the picked regions by the tool radius. A face is a place on the part,
 * but what gets restricted is where the tool *centre* may go — without this the
 * cutter would still overhang an avoided face by its radius.
 *
 * `includeGrow` is that adjustment for the include list, and it is not always
 * −radius. Shrinking is right when the pass runs *over* the picked face, which
 * is every clearing and finishing strategy. It is exactly wrong when the pass
 * runs along the face's *edge* and stands off it — a chamfer's tool centre is
 * outside the face by construction, so shrinking the face discards the whole
 * toolpath and the operation reports that the offsets came back empty. There
 * the region says which edges were picked, and it has to be grown far enough to
 * contain the path those edges produce.
 */
function toolAdjusted(regions, radius, tolerance, includeGrow = -radius, keepPick = false,
  z, minClearedWidth = 0) {
  const cleared = clearedAt(regions, z);
  return {
    avoid: hasAny(regions?.avoid) ? offsetLoops(regions.avoid, radius, tolerance) : [],
    include: hasAny(regions?.include)
      ? adjustedInclude(regions.include, includeGrow, tolerance, keepPick)
      : [],
    // eroded, not grown: see the note at the top of the file
    cleared: cleared.length
      ? worthSkippingOnce(regions, cleared, radius, tolerance, minClearedWidth) : [],
  };
}

/**
 * `worthSkipping`, remembered for the region set it was asked of.
 *
 * A strategy asks the same question of the same level more than once — the
 * region it will cut, and then the edge of what is already cleared — and each
 * answer is two offsets of a union that may have thousands of vertices.
 */
const skipped = new WeakMap();
function worthSkippingOnce(regions, cleared, radius, tolerance, minClearedWidth) {
  let byKey = skipped.get(cleared);
  if (!byKey) { byKey = new Map(); skipped.set(cleared, byKey); }
  const key = `${radius}|${tolerance}|${minClearedWidth}`;
  if (!byKey.has(key)) byKey.set(key, worthSkipping(cleared, radius, tolerance, minClearedWidth));
  return byKey.get(key);
}

/**
 * The cleared area, eroded by the cutter and with the slivers thrown away.
 *
 * Eroding is the whole of the tool adjustment (see the note at the top), and on
 * a ribbon it very nearly closes: a 12.5mm-wide margin cleared by a ⌀12 cutter
 * erodes to a line half a millimetre across. Deducting that saves no cutting at
 * all — and it splits the region it comes out of into an inside and an outside,
 * which the clearing walker then walks separately. Measured on a plain billet,
 * every deep level came out twice as long with rest machining on as with it off.
 *
 * So a piece of already-cleared ground counts only if a pass fits down it. An
 * opening — erode by half a pass, dilate back — drops the ones that do not and
 * leaves the ones that do their own shape. `minClearedWidth` is the strategy's
 * own stepover; without one nothing is dropped, which is the old behaviour.
 */
function worthSkipping(loops, radius, tolerance, minClearedWidth) {
  const eroded = offsetLoops(loops, -radius, tolerance);
  if (!(minClearedWidth > 0) || eroded.length === 0) return eroded;
  const shrunk = offsetLoops(eroded, -minClearedWidth / 2, tolerance);
  return shrunk.length ? offsetLoops(shrunk, minClearedWidth / 2, tolerance) : [];
}

/**
 * An include list that survives picking and not the tool offset.
 *
 * "Machine only here" and "here is too small for this cutter" is an operation
 * that cuts nothing — but the test was `if (include.length)`, asked of what came
 * back from the offset, so an include list that eroded away stopped restricting
 * anything at all and the pass machined the *whole part*. Silently, and in the
 * one direction a region is never allowed to fail in.
 *
 * The question belongs to the list the user picked, not to what survived it, and
 * `regionAllowsPoint` below already asked it that way — this is the same rule
 * for areas and for paths. The strategies report an empty region as "this cut
 * nothing", which is how it reaches the user.
 */
function includeVanished(regions, include) {
  return hasAny(regions?.include) && include.length === 0;
}

/**
 * The include list moved by the tool adjustment — unless that is what empties it.
 *
 * Eroding by the radius asks "where does the whole cutter fit **inside** the
 * pick". That is the right question for a pocket floor with walls round it, and
 * the wrong one for an outside shoulder: there the cutter reaches the ledge from
 * off the part, and its centre is never inside the pick at all. A 10mm shoulder
 * picked with a ⌀12 cutter eroded away to nothing and the pass refused to cut a
 * step it can machine perfectly well.
 *
 * So where the erosion empties the pick, the pick stands as it was. Nothing is
 * made unsafe by that: the erosion is a *refinement*, not the thing keeping the
 * cutter off the part — the strategy's own region is stock minus part, and that
 * is what forbids a gouge. A centre anywhere inside the pick still sweeps the
 * whole of it, which is what "machine here" asked for.
 *
 * `keepPick` is off for `regionAllowsPoint`, and the difference is real rather
 * than an oversight: drilling has no path to trim, only a hole centre, and a
 * face too small for the drill is a face the drill cannot make a hole in. An
 * area strategy is not confined that way — it is removing stock.
 */
function adjustedInclude(loops, grow, tolerance, keepPick) {
  if (Math.abs(grow) < 1e-9) return loops;
  const moved = offsetLoops(loops, grow, tolerance);
  return moved.length || !keepPick ? moved : loops;
}

/**
 * The edge, in tool-centre terms, of what earlier passes have cleared at `z`.
 *
 * A cutter whose centre is on it has its whole disc over cleared ground and
 * touches the stock that remains only tangentially, so a pass along it removes
 * nothing — the same fact as the stock edge, which clearing already leaves out.
 */
export function clearedEdgeAt(regions, { radius = 0, tolerance = 0.01, z, minClearedWidth = 0 } = {}) {
  if (!regionsActive(regions)) return [];
  return toolAdjusted(regions, radius, tolerance, -radius, true, z, minClearedWidth).cleared;
}

/**
 * How high the stock still stands at (x, y), as far as earlier passes' cleared
 * ground says: the deepest level above `z` that cleared it, or null where no
 * level above did — which means nothing is known about it.
 *
 * What a level cleared is empty down to that level, so the stock under it
 * cannot be higher.
 */
export function standingTopAt(regions, x, y, z) {
  const stack = regions?.cleared;
  if (!hasAny(stack) || !stack[0]?.loops) return null;
  let best = null;
  for (const slice of stack) {
    if (slice.z <= z + 1e-6 || (best !== null && slice.z >= best)) continue;
    if (pointInLoops(slice.loops, x, y)) best = slice.z;
  }
  return best;
}

/** Restrict a filled machining region (clearing, facing, raster bounds). */
export function applyRegionsToArea(loops, regions, {
  radius = 0, tolerance = 0.01, includeGrow, z, minClearedWidth = 0,
} = {}) {
  if (!regionsActive(regions) || loops.length === 0) return loops;
  const { avoid, include, cleared } = toolAdjusted(
    regions, radius, tolerance, includeGrow ?? -radius, true, z, minClearedWidth);
  if (includeVanished(regions, include)) return [];
  let out = loops;
  if (include.length) out = intersectLoops(out, include);
  if (avoid.length) out = diffLoops(out, avoid);
  if (cleared.length) {
    out = diffLoops(out, cleared);
    out = reachingMetal(out, clearedAt(regions, z), radius, tolerance);
  }
  return out;
}

/** The thinnest film of standing metal a rest pass goes back for, in mm. */
const FILM = 0.02;

/**
 * What is left of a region once the cleared ground is out of it, less the
 * pieces that have no metal to cut.
 *
 * The deduction is a boolean between two shapes that are, along every wall the
 * earlier cutter reached, *the same curve* — the part offset by one radius and
 * the part offset by another and brought back. They agree to within the arc
 * tolerance and not exactly, so what survives the subtraction along such a wall
 * is a string of slivers a few microns wide, one at each facet of a round hole.
 * Each of them is a region, and a region gets an entry and a pass: a ⌀3 cutter
 * cleaning up after a ⌀8 one on the hole plate made 455 separate descents, 32
 * of them at every level round a hole the ⌀8 had finished, and 4.1m of ramping
 * for 0.8m of cut.
 *
 * Whether a piece is worth visiting is not a question about its own width — a
 * slot exactly as wide as the cutter is a region of no width at all with a
 * cutter's worth of metal in it. It is a question about the metal. So: take
 * everything the cutter would sweep from the surviving centres, remove what is
 * already cleared, and what remains is the standing metal those centres are
 * there for. A piece is kept when some of that metal is thicker than a film,
 * and dropped when none of it is.
 *
 * Whole pieces, kept or dropped; never trimmed. Trimming would put a new edge
 * through a region the walker is about to offset, for the sake of a few
 * millimetres of path.
 */
function reachingMetal(loops, cleared, radius, tolerance) {
  if (loops.length === 0 || cleared.length === 0 || !(radius > 0)) return loops;
  const film = Math.max(FILM, 2 * tolerance);
  const metal = diffLoops(offsetLoops(loops, radius, tolerance), cleared);
  const thick = metal.length ? offsetLoops(metal, -film / 2, tolerance) : [];
  if (thick.length === 0) return [];
  // back out to full size, and then to every centre whose cutter touches it
  const within = offsetLoops(thick, film / 2 + radius + tolerance, tolerance);
  const pieces = unionWithHoles(loops);
  const kept = [];
  let dropped = 0;
  for (const { outer, holes } of pieces) {
    if (intersectLoops([outer, ...holes], within).length === 0) { dropped++; continue; }
    kept.push(outer, ...holes);
  }
  return dropped ? kept : loops;
}

/**
 * Restrict closed contour passes.
 * @returns { closed, open } — closed loops survive untouched, clipped spans
 *          come back as open polylines to be cut end to end
 */
export function applyRegionsToPaths(loops, regions, {
  radius = 0, tolerance = 0.01, includeGrow, z,
} = {}) {
  if (!regionsActive(regions) || loops.length === 0) return { closed: loops, open: [] };
  const { avoid, include, cleared } = toolAdjusted(
    regions, radius, tolerance, includeGrow ?? -radius, true, z);
  if (includeVanished(regions, include)) return { closed: [], open: [] };

  let paths = loops.map(loopToOpenPath);
  if (include.length) paths = clipOpenPaths(paths, include, 'intersect');
  if (avoid.length) paths = clipOpenPaths(paths, avoid, 'difference');
  if (cleared.length) paths = clipOpenPaths(paths, cleared, 'difference');

  // A loop the clip never touched is still a loop.
  //
  // Everything above goes through the open-path clipper, which is right — a
  // line has to be cut into surviving spans — but it used to hand *everything*
  // back as an open span, including the loops it had not touched at all. That
  // is not a smaller claim about the same path, it is a different path: a
  // closed pass ramps down around itself and levels the floor as it goes, and
  // an open one descends along the span and then walks it again at depth. So
  // the mere presence of a region changed passes nowhere near it — measured on
  // the sample part, a clamp declared 500mm clear of the work made a contour
  // 32mm shorter and a slot 30% longer, with nothing clipped in either.
  //
  // `loopToOpenPath` marks a loop by repeating its first point, so a path that
  // still ends where it began is one that survived whole. It goes back as the
  // loop it *was* — not the clipper's copy of it.
  //
  // That distinction is the whole of the second half of this bug. An open-path
  // clip makes no promise about where a surviving path starts or which way
  // round it runs, and for a path it did not cut it hands back the same corners
  // rotated and, for a hole, reversed. The shape is identical and the winding
  // is not — and the winding is what says whether the metal is inside or
  // outside the loop (contour.js resolveLead reads `loopArea(loop) < 0`). So a
  // pocket wall came back reading as a boss: climb milling became conventional
  // and the lead curled the wrong way, on every ring of every pocket, because a
  // clamp was declared half a metre from the part.
  //
  // Returning the original array also restores the start point, so a pass that
  // nothing clipped is the same pass down to the byte.
  const closed = [];
  const open = [];
  let byKey = null;
  for (const path of paths) {
    if (!isClosedPath(path)) { open.push(path); continue; }
    const survivor = path.slice(0, -2);
    // built on the first survivor, because a clip that cut everything into
    // spans never needs it
    if (!byKey) {
      byKey = new Map();
      for (const loop of loops) {
        const k = loopKey(loop);
        if (k) byKey.set(k, loop);
      }
    }
    closed.push(byKey.get(loopKey(survivor) ?? '') ?? survivor);
  }
  return { closed, open };
}

/**
 * Vertex count, centroid and enclosed area — invariant under rotation and
 * reversal, which is what makes it a key the clipper's copy and the original
 * both hash to. Anything the clip actually cut comes back as an open path and
 * never reaches here, so the only question is which untouched loop this is, and
 * two loops agreeing on all three to a hundredth of a micron are the same loop.
 */
function loopKey(loop) {
  const n = loop.length / 2;
  if (n < 3) return null;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) { cx += loop[i * 2]; cy += loop[i * 2 + 1]; }
  const round = (v) => Math.round(v * 1e5);
  return `${n}|${round(cx / n)}|${round(cy / n)}|${round(Math.abs(loopArea(loop)))}`;
}

/**
 * Restrict an operation that works at a *point* rather than along a path.
 *
 * Drilling and boring do not have a curve to clip: they have a list of hole
 * centres, and the only question about each one is whether the tool is allowed
 * to be there. Both strategies used to not ask it at all — they never took
 * `regions` — so a picked keep-out face did nothing to them and, far worse, so
 * did a clamp: `resolveRegions` puts every fixture's footprint in `avoid` for
 * every operation, and a 30mm jaw sitting on top of a hole was measured being
 * drilled and bored straight through while all ten other strategies routed
 * round it.
 *
 * `radius` is how far the operation takes material off from that centre — the
 * drill's own radius, the bore's finished radius — so the same tool adjustment
 * the path-clipping functions make applies unchanged: `avoid` grows by it,
 * `include` shrinks by it, `cleared` erodes by it.
 *
 * An `include` list that shrinks away to nothing forbids everywhere rather than
 * permitting everywhere: the question is asked of the list the user picked, not
 * of what survived the offset, so a picked face smaller than the cutter refuses
 * the hole instead of quietly re-permitting the whole part.
 */
export function regionAllowsPoint(regions, x, y, { radius = 0, tolerance = 0.01, z } = {}) {
  if (!regionsActive(regions)) return true;
  const { avoid, include, cleared } = toolAdjusted(regions, radius, tolerance, -radius, false, z);
  if (hasAny(regions.include) && !pointInLoops(include, x, y)) return false;
  if (avoid.length && pointInLoops(avoid, x, y)) return false;
  if (cleared.length && pointInLoops(cleared, x, y)) return false;
  return true;
}

/** Whether a polyline ends where it started — see applyRegionsToPaths. */
function isClosedPath(path) {
  const n = path.length;
  // three distinct points plus the repeat: fewer is not a loop worth cutting
  if (n < 8) return false;
  // The clipper quantises to a fixed grid, so the returned endpoints are equal
  // to within it rather than bit-identical.
  return Math.abs(path[0] - path[n - 2]) < 1e-6 && Math.abs(path[1] - path[n - 1]) < 1e-6;
}
