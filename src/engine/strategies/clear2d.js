// Z-level clearing (roughing / pocket): at each depth, clear the region
// between the stock footprint and the part slice with concentric offset
// passes. This is the "remove everything that isn't part" roughing op for
// box stock — also acts as a pocket cut where the part has pockets, since
// enclosed regions of stock-minus-part get cleared too.
//
// Pass order per depth: see `orderRings`. It is the whole difference between a
// pass that takes the stepover it was set and one that slots at full width.

import { CLBuilder, FEED, lastXY } from '../cl.js';
import { pluralEs } from '../text.js';
import { concentricRings } from '../rings.js';
import { cutSpanWithRamp } from '../linking.js';
import { mergeTolerance } from '../simplify.js';
import {
  offsetLoops, diffLoops, offsetNormalized, loopArea, unionWithHoles,
} from '../../geom/clipper.js';
import { SilhouetteStack } from '../../geom/silhouette.js';
import { depthLevelsFor, stockOutline } from '../stock.js';
import { applyRegionsToArea, regionRefusal } from '../regions.js';
import { loopBorderedBy } from '../../geom/inside.js';
import { cutLoopPass } from './contour.js';
import { applyCutting } from '../cutting.js';
import { crossingPlane, goHome, entryPlane } from '../heights.js';

const MAX_PASSES = 500;

export function generateClear({
  mesh, tool, params, stock, regions, fixtures,
}) {
  const r = tool.diameter / 2;
  const step = Math.max(0.1, (params.stepover ?? 0.5) * tool.diameter);
  const clearance = params.clearanceHeight;
  const tolerance = params.tolerance ?? 0.01;
  const direction = params.direction ?? 'climb';
  const lead = { type: params.leadType ?? 'none', radius: params.leadRadius ?? 0 };
  // how high a ring has to go to reach the next one — see engine/heights.js
  const crossAt = crossingPlane(params, stock, fixtures);

  // Allowed tool-centre region outer boundary: the stock footprint grown by the
  // radius, so the cutter fully clears the stock edges.
  //
  // Grown the way the part's keep-out is grown — round joins — and not as a
  // rectangle with square corners. The two are subtracted from one another
  // below, so where the part's own footprint reaches the edge of the billet
  // they have to cancel *exactly*; a square corner against a round offset
  // leaves a hairline of region behind along the whole edge, 0.03mm wide and
  // 66mm long on the test plate. That is not stock, it is the difference
  // between two ways of drawing the same boundary — and it was cut: the sliver
  // came back as a ring of its own, took a lead-in arc, and the arc plunged the
  // cutter 2mm inside the finished edge of the part and 7mm deep.
  //
  // Rounding costs nothing in reach. A centre on the quarter-circle round a
  // stock corner puts the cutter exactly on that corner; the square version
  // takes it out to the diagonal, √2·r away, where it clears no more billet and
  // only travels further through air.
  const outer = r > 0
    ? offsetLoops(stockOutline(stock, 0), r, tolerance)
    : stockOutline(stock, 0);
  const stockEdge = boundsOf(outer);

  /**
   * Which side of a ring the metal is on — the answer climb milling and the
   * lead-in arc both swing off, and one this loop cannot be asked for itself.
   *
   * Clearing is stock minus part, so the shapes are the other way round from a
   * pocket: the holes in the region are the *part*, and metal is what they
   * enclose, exactly as round a boss. The outer boundary is the stock edge,
   * with nothing but air beyond it — unless the part encloses a patch of stock,
   * which comes back as its own outer boundary sitting inside the billet with
   * walls all round it, and that one is a pocket.
   *
   * **Rest machining adds a third kind of outer boundary, and it is neither.**
   * Deducting what an earlier pass already took (see engine/rest.js) leaves the
   * remaining ribbon with an outer edge that is not the stock edge and not an
   * enclosed patch of stock: it is the rim of the hole that pass emptied, with
   * nothing beyond it but the air it left. "Not the stock edge" called that a
   * pocket wall, so the ring took a lead-in arc off the wrong side and cut
   * **1.9mm into the boss it had been sent in to clear round** — against 0.3mm
   * with rest machining off, same part, same cutter.
   *
   * So an outer that carries a lead has to show the part on the far side of it.
   * Asked only of the ring the lead is on, because that is the only one a wrong
   * answer can gouge with — the inner rings cut stock and take no lead.
   */
  const ringSide = (loop, base, keepout = null) => {
    const outerSide = loopArea(loop) > 0 && !reaches(boundsOf([loop]), stockEdge);
    if (outerSide && (base?.type ?? 'none') !== 'none' && (base?.radius ?? 0) > 0
      && !loopBorderedBy(loop, keepout, Math.max(0.05, tolerance * 2))) {
      return { ...base, materialOutside: false };
    }
    return { ...base, materialOutside: outerSide };
  };

  const cl = new CLBuilder().simplify(mergeTolerance(tolerance));
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  // keepout grows monotonically as we descend: the cutter is blocked by the
  // part at this depth *and* by everything above it
  const silhouette = new SilhouetteStack(mesh, { tolerance });

  // the region a cutter centre may occupy at this depth, leaving `allowance` mm
  // of stock standing on the part
  const regionAt = (shadow, allowance, z) => applyRegionsToArea(
    diffLoops(outer, offsetLoops(shadow, r + allowance, tolerance)),
    // `z` because what an earlier pass has already cleared depends on how deep
    // you ask: it has emptied the whole billet at the top and only the margin
    // outside the part at the bottom. See engine/rest.js.
    regions, { radius: r, tolerance, z, minClearedWidth: step },
  );

  // The height the material actually stands at where the next pass enters.
  //
  // Not "the level above", which is what it was: a level that cleared *nothing*
  // took the entry height down with it anyway, so the pass under it rapided to
  // a feed plane inside solid billet and then ramped one stepdown through
  // material standing several. Only a level that cut something has lowered the
  // surface the next one comes in through. See engine/heights.js entryPlane.
  let zEntry = params.topZ;
  let cutAnything = false;
  let finalShadow = null;
  for (const z of depthLevelsFor(params, mesh, tool)) {
    finalShadow = silhouette.down(z);
    // What the part occupies at this level, as the cutter sees it. The region
    // is bounded by exactly this wherever the part bounds it, so a boundary
    // lying against it is a wall and one that is not is an edge the earlier
    // pass left — see ringSide.
    const keepout = offsetLoops(finalShadow, r + (params.stockToLeave ?? 0), tolerance);
    const region = regionAt(finalShadow, params.stockToLeave ?? 0, z);
    if (region.length === 0) continue;

    let cutHere = false;
    // One family of concentric passes per connected piece of the region. Kept
    // apart because the order they should be cut in is a property of the piece
    // — whether there is air outside it or the part — and offsetting them all
    // together loses that.
    for (const piece of unionWithHoles(region)) {
      const loops = [piece.outer, ...piece.holes];
      // Spaced to divide the band rather than stepped off its edges — see
      // engine/rings.js for what the remainder costs when they are not.
      const rings = concentricRings(loops, step, tolerance, r);
      const passes = orderRings(rings, onStockEdge(piece.outer, outer),
        { air: [piece.outer], part: piece.holes }, step);
      // Everything cut so far at this level, as the rings it was cut along.
      // A span may drop straight to depth anywhere in here, because the pass
      // that cleared it has already run.
      const done = [];
      const clearedBeside = (x, y) => {
        for (const ring of done) if (distanceToLoops(x, y, ring) <= step * 0.75) return true;
        return false;
      };
      for (const { loop, k, closed } of passes) {
        // only the last ring is a finished wall, so leads are wasted motion on
        // the interior passes — ramp those in along the path instead
        const cut = closed
          ? cutLoopPass(cl, loop, zEntry, z, {
            clearance, direction, params, crossAt,
            lead: ringSide(loop, k === 0 ? lead : { type: 'none', radius: 0 }, keepout),
          })
          : cutSpanPass(cl, loop, zEntry, z, {
            clearance, params, crossAt, step,
            // Where the pass before this one cleared, so this one can drop into
            // the space rather than ramp its way in — see `cutSpanPass`.
            cleared: clearedBeside,
          });
        if (cut) { cutHere = true; done.push([loop]); }
      }
    }
    if (cutHere) { cutAnything = true; zEntry = z; }
  }

  // Finish passes: walk the wall again at final depth with progressively less
  // stock left on. Roughing leaves the allowance standing everywhere; these
  // peel it back with a cutter that is no longer buried, which is the whole
  // point of asking for stock to leave in the first place. Only the boundary
  // ring is re-cut — the interior is floor, and it is already down to size.
  // A finishing pass peels off the allowance a roughing pass left. With no
  // allowance there is nothing for it to peel, so it does nothing at all — and
  // did so silently, which reads as a setting that is broken rather than one
  // that has nothing to do. Say it.
  const finishPasses = Math.max(0, Math.round(params.finishPasses ?? 0));
  if (finishPasses > 0 && !((params.stockToLeave ?? 0) > 0)) {
    cl.warn(`${pluralEs(finishPasses, 'finish pass')} asked for with no stock to leave — `
      + 'they would re-cut the wall the roughing passes already left to size. '
      + 'Set a stock allowance for them to take off.');
  }
  if (finishPasses > 0 && (params.stockToLeave ?? 0) > 0 && finalShadow) {
    for (let i = 1; i <= finishPasses; i++) {
      const remaining = params.stockToLeave * (1 - i / finishPasses);
      const keepout = offsetLoops(finalShadow, r + remaining, tolerance);
      for (const loop of regionAt(finalShadow, remaining)) {
        // The region's boundary is the part on one side and the stock edge on
        // the other, and only one of them is a wall. Re-cutting the stock edge
        // is a lap of the billet perimeter with the cutter tangent to it —
        // 209mm of cutting feed per finish pass on a 46mm billet, taking off
        // nothing. The allowance stands against the part; peel it there.
        if (onStockEdge(loop, outer)) continue;
        if (cutLoopPass(cl, loop, params.bottomZ, params.bottomZ, {
          clearance, direction, params, lead: ringSide(loop, lead, keepout), crossAt,
        })) cutAnything = true;
      }
    }
  }

  if (!cutAnything) {
    // see engine/regions.js regionRefusal: a picked face that leaves the cutter
    // nowhere to go is not a heights problem, and saying it is wastes the user's
    // time in the wrong tab
    const why = regionRefusal(regions, r, tolerance);
    cl.warn(why
      ? `Z-level clearing removed nothing — ${why}`
      : 'Z-level clearing removed nothing — the stock may already match the part, '
        + 'or Top Z is below the stock top');
  }
  goHome(cl, clearance);
  return cl.finish();
}

/**
 * Which order to cut one piece's concentric rings in.
 *
 * A ring family is the piece eroded by one stepover at a time, so ring k's
 * boundary is everywhere k stepovers inside the piece — and that boundary has
 * two halves with nothing in common but the number: the part that came in from
 * the piece's *outer* edge, and the part that grew out of a hole. Cutting the
 * whole of ring k, then the whole of ring k−1, walks up and down the band
 * instead of across it.
 *
 * Where the piece is a band between the stock edge and the part — which is what
 * roughing box stock mostly is — the innermost ring is the band's medial axis,
 * the one place with material on *both* sides. Starting there is a full-width
 * slot the depth of the level, whatever stepover was set: measured on a 100×70
 * plate with a ⌀6 at a 0.5×D stepover, 1.7 metres of cutting at more than three
 * quarters of the cutter's width and a 70mm run of it unbroken.
 *
 * So a piece with air outside it is cut *across*: in from the stock edge one
 * stepover at a time, then out from the medial axis to the part, finishing on
 * the wall. Every pass then has the pass before it on one side and the stepover
 * is the stepover.
 *
 * Which half a ring belongs to used to be read off the sign of its area — a
 * loop that grew out of a hole runs the other way round. That holds only while
 * the two halves stay separate loops, and they do not: erode far enough and an
 * island's hole **merges** with the outer boundary, giving one positive loop
 * that is stock edge along one stretch and wraps the island along another.
 * Cut whole and ascending, its island stretch marches the wrong way and arrives
 * with material on both sides. Measured on the slope part with a ⌀6: one
 * complete ring around the dome, 198 of its 220 steps past three quarters of
 * the diameter, at every level.
 *
 * So the question is asked of the ring itself rather than of its winding: every
 * point of a ring eroded k stepovers sits k stepovers from whichever boundary
 * it came from, so the boundary it is *nearest* to is the boundary it came
 * from. A ring that is wholly air-side marches in with the rest of them; one
 * that touches the part at all joins the family that marches back out, where
 * its island stretch has the previous ring cleared beside it — and so does its
 * stock-edge stretch, which is one ring further in and cut one pass earlier.
 *
 * A piece walled in on every side has no air edge to start from, and one pass
 * has to be full width wherever it begins. Innermost first keeps that pass the
 * short one — the core rather than the wall — which is what it has always done.
 *
 * @param rings [k] => loops of the piece eroded by k stepovers
 * @param airOutside whether the piece's outer boundary is the stock edge
 * @param sides { air, part } — the boundaries the piece was eroded from
 * @param step the stepover, as the resolution the sides are told apart at
 */
function orderRings(rings, airOutside, sides, step) {
  const out = [];
  if (!airOutside) {
    for (let k = rings.length - 1; k >= 0; k--) {
      for (const loop of rings[k]) out.push({ loop, k, closed: true });
    }
    return out;
  }
  const air = [];
  const part = [];
  for (let k = 0; k < rings.length; k++) {
    for (const loop of rings[k]) {
      for (const run of splitBySide(loop, sides, step)) {
        (run.air ? air : part).push({ loop: run.path, k, closed: run.closed });
      }
    }
  }
  // in from the stock edge, starting one ring in.
  //
  // Ring 0 on the air side *is* the stock edge — the region's outer boundary is
  // `stockOutline(stock, r)`, which is the locus where the cutter touches the
  // billet and does not enter it. A pass there is exactly tangent: it removes
  // nothing, at cutting feed, once per level. Ring 1 sits one spacing inside it
  // and sweeps from the stock edge inward, so everything ring 0 could have
  // reached it reaches too. Measured on a 40mm part in a 46mm billet: 3173mm of
  // cutting became 2108mm and the finished surface was identical to a thousandth
  // of a millimetre.
  //
  // Only where air is outside, which is what this branch is: the same ring 0 on
  // the *part* side is the wall, and it is the one pass that must not be missed.
  // A piece bounded entirely by the stock edge always has something further in —
  // a region no wider than the cutter would need a billet narrower than nothing.
  const outermost = air.length > 0 ? Math.min(...air.map((pass) => pass.k)) : -1;
  const nothingElse = part.length === 0 && air.every((pass) => pass.k === outermost);
  for (const pass of air) if (nothingElse || pass.k > outermost) out.push(pass);
  // …then back out to the part, finishing on the wall it leaves to size
  part.sort((a, b) => b.k - a.k);
  for (const pass of part) out.push(pass);
  return out;
}

/**
 * How little of a ring may belong to the other side before it is worth cutting
 * the ring in two.
 *
 * Splitting is not free: each span enters and leaves on its own, so a ring cut
 * in two costs an extra descent and an extra retract. A ring with a hand's
 * breadth of island in it is not really two passes, and paying twice for it is
 * how a fix for full-width cutting turns into a third more cycle time.
 */
const SPLIT_SHARE = 0.15;

/**
 * One ring, split into the stretches that belong to each side of the march.
 *
 * Every point of a ring eroded k stepovers sits k stepovers from whichever
 * boundary it came from, so the boundary it is *nearest* to is the boundary it
 * came from. That is the whole test, and it is measured by **length**: a
 * straight run along the stock edge is two points and a hundred millimetres,
 * the curve round a dome is three hundred points and thirty, so counting
 * points calls a ring that is four fifths stock edge "one fifth air".
 *
 * Which is also why the ring is resampled first. The question is asked of the
 * ring's *points*, and a ring does not have points where the answer changes —
 * it has them where the geometry has corners. Offsetting a part outward rounds
 * its corners into hundreds of points and leaves the stock edge as two, so a
 * boundary that changes sides halfway along a straight edge is not asked about
 * until the far end of it. Measured on a 40mm part sitting off-centre in an
 * 89mm billet: one 37mm edge, air at the end where the two sides are exactly
 * equidistant and part along all the rest of it, cut whole in the air march
 * with untouched metal on both sides — 37mm at the full width of the cutter on
 * a pass set to half of it, at every level. The extra points are collinear and
 * `cl.simplify` takes them straight back out.
 *
 * @returns [{ path, closed, air }] — one closed entry where the ring is all of
 *   a piece, two or more open spans where it genuinely is not
 */
function splitBySide(rawLoop, { air, part }, step) {
  const loop = resampleLoop(rawLoop, step);
  const n = loop.length / 2;
  if (n < 3 || !part || part.length === 0) return [{ path: loop, closed: true, air: true }];

  const airward = new Array(n);
  const share = new Array(n);
  let total = 0;
  let airLength = 0;
  for (let i = 0; i < n; i++) {
    const x = loop[i * 2];
    const y = loop[i * 2 + 1];
    // half of each neighbouring segment belongs to this point
    const prev = (i + n - 1) % n;
    const next = (i + 1) % n;
    share[i] = (Math.hypot(x - loop[prev * 2], y - loop[prev * 2 + 1])
      + Math.hypot(loop[next * 2] - x, loop[next * 2 + 1] - y)) / 2;
    total += share[i];
    airward[i] = distanceToLoops(x, y, air) <= distanceToLoops(x, y, part);
    if (airward[i]) airLength += share[i];
  }
  if (total <= 0) return [{ path: loop, closed: true, air: true }];
  const airShare = airLength / total;
  // all of a piece, or near enough that cutting it in two costs more than it saves
  if (airShare > 1 - SPLIT_SHARE) return [{ path: loop, closed: true, air: true }];
  if (airShare < SPLIT_SHARE) return [{ path: loop, closed: true, air: false }];

  // Start where the class changes, so the walk below never wraps the array end.
  let start = 0;
  while (start < n && airward[start] === airward[(start + n - 1) % n]) start++;
  if (start >= n) return [{ path: loop, closed: true, air: airShare >= 0.5 }];

  const runs = [];
  let current = null;
  for (let i = 0; i <= n; i++) {
    const at = (start + i) % n;
    const x = loop[at * 2];
    const y = loop[at * 2 + 1];
    // the closing point of each run is the opening point of the next, so the
    // spans meet rather than leaving a rib standing between them
    if (current && airward[at] !== current.air) { current.pts.push(x, y); current = null; }
    if (!current) { current = { air: airward[at], pts: [] }; runs.push(current); }
    current.pts.push(x, y);
    if (i === n) break;
  }
  return runs.filter((run) => run.pts.length >= 4)
    .map((run) => ({ path: run.pts, closed: false, air: run.air }));
}

/**
 * One open pass: down to depth at the start of it, along it, and out.
 *
 * The span equivalent of `cutLoopPass`, and deliberately the plainer of the
 * two: a span is an interior pass, so it has no lead — there is no wall being
 * finished here — and no tabs. What it does share is where it comes from and
 * goes back to, which is the caller's business rather than the pass's.
 *
 * The entry is where a span differs from a ring, and it is most of the cost of
 * having one. A ring ramps down along itself and comes round again to take off
 * the wedge the ramp left, which is free — it was going that way anyway. An
 * open span has to *reverse* to do the same, so a 2.8mm stepdown at 3° buys
 * fifty millimetres of ramp and fifty more of re-walking it, per span, per
 * level. Measured on the slope part that was a third of the cycle time.
 *
 * So the span is entered the way a machinist would: down through the hole the
 * previous pass has already made, beside its start, then straight in at depth.
 * The pass before this one cut a band a stepover wide right there — that is
 * what marching in order *means* — and dropping into cleared space costs one
 * plunge through air. Only where nothing has been cleared beside the start
 * (the first pass of a level) does it fall back to ramping.
 */
function cutSpanPass(cl, span, zEntry, z, { clearance, params, crossAt, step, cleared }) {
  const n = span.length / 2;
  if (n < 2) return false;
  const home = crossAt != null && crossAt > z + 1e-9 ? Math.min(crossAt, clearance) : clearance;
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([span[i * 2], span[i * 2 + 1]]);
  // Entered from the end nearest the tool, for the same reason every other pass
  // here is: the alternative is a traverse of the piece to reach the far end of
  // a span whose near end is where the last pass stopped.
  if (cl.count > 0) {
    const at = lastXY(cl);
    const head = Math.hypot(pts[0][0] - at[0], pts[0][1] - at[1]);
    const tail = Math.hypot(pts[n - 1][0] - at[0], pts[n - 1][1] - at[1]);
    if (tail < head) pts.reverse();
  }
  const rawFeedPlane = entryPlane(params, zEntry, z);
  const feedPlane = rawFeedPlane == null ? null : Math.min(rawFeedPlane, home);

  const drop = entryBeside(pts, step, cleared);
  if (drop) {
    cl.rapid(drop[0], drop[1], home);
    if (feedPlane != null && feedPlane > z + 1e-9) cl.rapid(drop[0], drop[1], feedPlane);
    cl.cut(drop[0], drop[1], z, FEED.PLUNGE);          // through air the last pass made
    cl.cut(pts[0][0], pts[0][1], z, FEED.LEAD);        // and sideways into the cut
    for (let i = 1; i < pts.length; i++) cl.cut(pts[i][0], pts[i][1], z);
    cl.rapid(...lastXY(cl), home);
    return true;
  }

  cl.rapid(pts[0][0], pts[0][1], home);
  if (feedPlane != null && feedPlane > z + 1e-9) cl.rapid(pts[0][0], pts[0][1], feedPlane);
  cutSpanWithRamp((x, y, zz, feed = FEED.CUT) => cl.cut(x, y, zz, feed),
    pts, zEntry, z, params.rampAngle ?? 0);
  cl.rapid(...lastXY(cl), home);
  return true;
}

/**
 * The same loop with no edge longer than `at`, so a question asked of its
 * points is asked everywhere along it. Existing points are all kept.
 */
function resampleLoop(loop, at) {
  if (!(at > 0)) return loop;
  const n = loop.length / 2;
  if (n < 2) return loop;
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [x, y] = [loop[i * 2], loop[i * 2 + 1]];
    const [nx, ny] = [loop[j * 2], loop[j * 2 + 1]];
    out.push(x, y);
    const pieces = Math.ceil(Math.hypot(nx - x, ny - y) / at);
    for (let p = 1; p < pieces; p++) {
      out.push(x + (nx - x) * (p / pieces), y + (ny - y) * (p / pieces));
    }
  }
  return out;
}

/**
 * A point one stepover to the side of where this span starts, in ground an
 * earlier pass has already taken away — or null if there is no such place.
 *
 * Both sides are offered to `cleared` because which one is open depends on
 * which way the march is going, and the span does not know: an air-side span
 * has the cleared band on its outward side and a part-side span on its inward
 * one. Asking is cheaper than working it out, and it cannot be fooled — the
 * caller answers from the passes it has actually emitted.
 */
function entryBeside(pts, step, cleared) {
  if (!cleared || !(step > 0)) return null;
  const [x0, y0] = pts[0];
  const [x1, y1] = pts[1];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) return null;
  for (const side of [1, -1]) {
    const px = x0 - (dy / len) * step * side;
    const py = y0 + (dx / len) * step * side;
    if (cleared(px, py)) return [px, py];
  }
  return null;
}

/**
 * Is the whole of this boundary the stock edge, with air on the far side of all
 * of it?
 *
 * The question `orderRings` needs, and it has to be all of it. A boundary that
 * is stock edge along one stretch and part wall along another is one loop and
 * one pass: marching in from it clears the band beside the stock edge properly
 * and drives the same pass into the part along the rest. Where the part comes
 * out to the edge — a ramp running off the side of the plate — that is most of
 * the boundary, so those pieces keep the innermost-first order, where the wall
 * stretch is cut last with the band beside it already gone.
 */
function onStockEdge(loop, outer, eps = 1e-4) {
  for (let i = 0; i < loop.length; i += 2) {
    if (distanceToLoops(loop[i], loop[i + 1], outer) > eps) return false;
  }
  return true;
}

/** Distance from a point to the nearest edge of a set of flat loops. */
function distanceToLoops(x, y, loops) {
  let best = Infinity;
  for (const loop of loops) {
    const n = loop.length / 2;
    for (let i = 0, k = n - 1; i < n; k = i++) {
      const ax = loop[k * 2];
      const ay = loop[k * 2 + 1];
      const dx = loop[i * 2] - ax;
      const dy = loop[i * 2 + 1] - ay;
      const lenSq = dx * dx + dy * dy;
      let t = lenSq > 0 ? ((x - ax) * dx + (y - ay) * dy) / lenSq : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
      if (d < best) best = d;
    }
  }
  return best;
}

/** [minX, minY, maxX, maxY] of a set of flat loops. */
function boundsOf(loops) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i += 2) {
      b[0] = Math.min(b[0], loop[i]); b[1] = Math.min(b[1], loop[i + 1]);
      b[2] = Math.max(b[2], loop[i]); b[3] = Math.max(b[3], loop[i + 1]);
    }
  }
  return b;
}

/** Does `inner` run out to `outer` on every side? Then it is the stock edge. */
function reaches(inner, outer, eps = 1e-6) {
  return inner[0] <= outer[0] + eps && inner[1] <= outer[1] + eps
    && inner[2] >= outer[2] - eps && inner[3] >= outer[3] - eps;
}
