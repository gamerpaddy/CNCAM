// Adaptive clearing: roughing that holds the radial bite to a set width.
//
// Z-level clearing walks concentric offsets of the region and takes whatever
// bite the geometry hands it — a comfortable one along a straight wall, a
// full-diameter slot where two offsets meet in an inside corner. That spike is
// what limits how deep and how fast a roughing pass can run, because the cut has
// to be tame enough for its worst moment.
//
// Adaptive inverts that. The bite is the parameter, so the cutter can go the
// full flute depth at a feed the spike would never have allowed:
//
//   * The pass peels inward from the stock boundary in steps of one bite, so
//     every cut meets material on one side and cleared space on the other.
//   * Material is tracked in a raster (geom/coverage.js), so a front that
//     reappears somewhere nothing has been cleared — inside a pocket the part
//     walls off — is recognised and left alone rather than driven into.
//   * Those regions are opened from the inside instead: down at the most
//     sheltered spot, then rings spiralling outward as far as that region's own
//     walls. Same peel, run the other way round, so the bite is bounded there
//     too.
//   * Moves between passes stay at depth when the way is already cleared,
//     instead of retracting to clearance and coming back.
//   * A wall pass at the end takes off the ≤ one bite the peel could not reach,
//     which leaves an even, predictable allowance for the finishing tool.
//
// Entry is the one motion the bite limit does not govern: a ramp descends
// through material by angle, not by width, and the pass that takes off the wedge
// it leaves is as wide as the cutter however light the rest of the cut is. That
// is what `rampAngle` is for, and why the entries are kept few — everything
// reachable is linked at depth instead. Those moves are emitted as leads, so
// what the bite limit does and does not cover stays visible downstream.

import { CLBuilder, FEED } from '../cl.js';
import { plural } from '../text.js';
import {
  offsetLoops, offsetNormalized, diffLoops, clipOpenPaths, loopToOpenPath,
  loopsBounds, loopArea, unionWithHoles,
} from '../../geom/clipper.js';
import { pointInLoops } from '../../geom/inside.js';
import { ClearingMap, engagementFraction } from '../../geom/coverage.js';
import { SilhouetteStack } from '../../geom/silhouette.js';
import { depthLevelsFor, depthRefusal, stockOutline } from '../stock.js';
import { applyRegionsToArea, regionRefusal } from '../regions.js';
import { orientLoop } from '../leads.js';
import { cutSpanWithRamp } from '../linking.js';
import { applyCutting } from '../cutting.js';
import { entryPlane, crossingPlane, goHome } from '../heights.js';
import { mergeTolerance } from '../simplify.js';

const MAX_RINGS = 4000;
const MAX_SEEDS = 24;
// How many spans the scheduler keeps in front of it. Enough that a corner can
// be followed several rings deep before the tool has to move on, small enough
// that choosing between them stays cheap.
const LOOKAHEAD = 12;
// At most this many engagement probes per span when deciding whether to cut it.
const PROBES = 12;
/**
 * The shortest move a roughing pass writes, in mm, before the user says
 * otherwise.
 *
 * A tenth of a millimetre is two orders below the finishing allowance the pass
 * leaves standing and one below anything a roughing cut can be said to hold, so
 * nothing is lost that was ever going to reach the part. What is gained is the
 * blocks: the difference between describing a corner fillet with four hundred
 * chords and with twenty.
 */
const DEFAULT_RESOLUTION = 0.1;

/** Tuple comparison, first difference wins. */
function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * Points spread evenly *along* a span, no further apart than `step` and no more
 * than `maxCount` of them, both ends included.
 *
 * By distance, not by index, and both halves of that matter. The spans used to
 * arrive resampled to a fixed step, so every nth point was also every nth
 * millimetre; they now arrive as the geometry the offsetter produced, where a
 * straight wall is two points and a fillet is forty. An index stride over that
 * would put eleven of its twelve probes inside the fillet and one along the
 * whole wall — and a fixed count would probe a 3mm leftover span at its two
 * ends only, which is how a pass that removes material in the middle of a short
 * span comes to be dropped as removing nothing.
 */
function samplePath(pts, step, maxCount = PROBES) {
  const cumulative = [0];
  for (let i = 1; i < pts.length; i++) {
    cumulative.push(cumulative[i - 1]
      + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = cumulative[cumulative.length - 1];
  if (!(total > 0)) return [pts[0]];
  // as many as the step asks for, up to the cap: a 200mm ring gets the cap
  // spread over it, a 3mm leftover gets one every step and not two at its ends
  const count = Math.max(2, Math.min(maxCount, Math.ceil(total / Math.max(step, 1e-6)) + 1));
  const out = [];
  let at = 0;
  for (let k = 0; k < count; k++) {
    const want = (k / (count - 1)) * total;
    while (at < cumulative.length - 1 && cumulative[at + 1] < want) at++;
    const span = cumulative[at + 1] - cumulative[at];
    const f = span > 0 ? (want - cumulative[at]) / span : 0;
    const a = pts[at];
    const b = pts[Math.min(at + 1, pts.length - 1)];
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}

export function generateAdaptive({
  mesh, tool, params, stock, regions, fixtures,
}) {
  const r = tool.diameter / 2;
  const stockToLeave = params.stockToLeave ?? 0;
  const tolerance = params.tolerance ?? 0.01;
  const clearance = params.clearanceHeight;
  const direction = params.direction ?? 'climb';
  const rampAngle = params.rampAngle ?? 0;
  // the parameter of the whole strategy: how wide a bite the cutter may take
  const target = Math.min(Math.max(params.engagement ?? 0.2, 0.01), 1);
  const bite = Math.max(0.05, target * tool.diameter);
  // fine enough that the raster's one-cell safety bias stays small next to the bite
  const cellSize = Math.min(Math.max(bite / 3, 0.1), r / 2, 1);
  // The shortest move worth writing out. A roughing pass leaves a finishing
  // allowance standing, so describing its path to a hundredth of a millimetre
  // is describing a surface that is going to be cut away — at a cost of tens of
  // thousands of blocks. Capped against the bite so that a resolution set
  // larger than the cut itself cannot square off the shape of it.
  const minSegment = Math.min(
    Math.max(params.resolution ?? DEFAULT_RESOLUTION, 0), bite, r / 2);

  const cl = new CLBuilder().simplify(mergeTolerance(tolerance)).setResolution(minSegment);
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  // The height a link may cross the part at — see engine/heights.js. Null when
  // a clamp could be standing in it, and then the links go home.
  const stockPlane = crossingPlane(params, stock, fixtures);

  const outer = stockOutline(stock, r);
  const bounds = loopsBounds(outer);
  const spread = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]);
  const silhouette = new SilhouetteStack(mesh, { tolerance });

  const report = {
    peak: 0, entries: 0, links: 0, hops: 0, steepest: 0, seeds: 0, opened: 0, unopened: 0,
  };
  let zEntry = params.topZ;
  let cutAnything = false;

  const levels = depthLevelsFor(params, mesh, tool);
  for (const z of levels) {
    const shadow = silhouette.down(z);
    // where the centre may go, and what is still standing at this level
    const allowed = applyRegionsToArea(
      diffLoops(outer, offsetLoops(shadow, r + stockToLeave, tolerance)),
      // depth-aware: see the note in clear2d.js and engine/rest.js
      // a bite's worth: cleared ground narrower than that saves no cutting
      regions, { radius: r, tolerance, z, minClearedWidth: target * tool.diameter },
    );
    // A level that clears nothing has lowered nothing, so it must not lower the
    // height the *next* level enters through — see the note on zEntry below.
    if (allowed.length === 0) continue;
    const material = diffLoops(
      stockOutline(stock, 0), offsetLoops(shadow, stockToLeave, tolerance),
    );

    // The allowed area in separate pieces — one per place the cutter can be
    // without crossing the part — worked out when the first seed asks, which on
    // a level with nothing walled off is never. See `within` in peel().
    let pieces = null;
    const pieceAt = ([x, y]) => {
      pieces ??= unionWithHoles(allowed).map((piece) => [piece.outer, ...piece.holes]);
      return pieces.find((loops) => pointInLoops(loops, x, y));
    };

    const map = new ClearingMap({ material, allowed, radius: r, cellSize, bounds });
    const level = new LevelCutter({
      cl, map, z, zEntry, clearance, rampAngle, bite, tolerance,
      feedPlane: entryPlane(params, zEntry, z),
      stockPlane,
      direction, allowed, report, minSegment,
    });

    // The stock boundary marched inward one bite at a time, starting one bite
    // in — every front then peels off the band the one before it cleared, and
    // the first one peels off the band beside the billet edge.
    //
    // It used to start *on* `outer`, described as "the first cuts are half in
    // air". They are not half in air: `outer` is the stock outline grown by the
    // whole radius, which is the locus where the cutter touches the billet
    // without entering it, so that front removes exactly nothing — and it is
    // where the level's entry ramp descends, so on a 12mm level the ramp spent
    // six laps of the billet perimeter cutting air before the peel began.
    // Starting at one bite gives the ramp material to descend into and drops
    // 239mm of the 1845mm cut on a 40mm part, with the finished surface
    // unchanged to a thousandth of a millimetre.
    level.peel((k) => offsetNormalized(outer, -(k + 1) * bite, tolerance));

    // whatever that could not reach, opened from the inside
    let stalled = 0;      // material still standing when seeding could go no further
    for (let attempt = 0; attempt < MAX_SEEDS; attempt++) {
      const seed = map.findSeed();
      if (!seed) break;
      const standing = map.remainingArea();
      report.seeds++;
      // How wide a circle the peel opens a walled-off region with.
      //
      // Small, and it has to be. Opening at a circle the ramp could take in one
      // lap would cut the number of little entry rings — which is what "it
      // makes six circles and then starts cutting from each outwards" is a
      // picture of — but it also breaks the one promise the strategy makes: a
      // seed wider than a bite meets material on both sides of itself, and the
      // measured peak bite goes from 0.15xD to over 0.4xD. The circles stay.
      //
      // And no wider than the region it is opening. A front is a *path*, not an
      // area: clipped to the region, a circle that does not fit inside it comes
      // back empty — not trimmed, empty, because none of it is in there. So a
      // walled-off region narrower than the opening circle was found, peeled at,
      // and left exactly as it was; `findSeed` is deterministic, so the next
      // attempt found the same spot, and the level spent its whole seed budget
      // on it and gave up. Measured on a plate with a ⌀8 hole and a ⌀6 cutter:
      // 47 of 48 seed attempts at one point, every one of them emitting nothing,
      // and the hole left full of stock while the pass reported success.
      // The room at the seed is the inradius there, which is exactly what has to
      // fit — see ClearingMap.roomAt.
      const seedR = Math.min(bite, r / 2, map.roomAt(seed[0], seed[1]));
      const start = circleLoop(seed, seedR, tolerance);
      level.peel(
        (k) => (k === 0 ? [start] : offsetNormalized([start], k * bite, tolerance)),
        {
          maxRings: Math.ceil(spread / bite) + 2,
          hole: true,
          openWith: true,
          // A ring tighter than the cutter itself is still the entry, whatever
          // the bite is set to: spiralling out of a hole barely wider than a
          // chip, the tool is buried on every side until the ring it is tracing
          // is wider than the tool is. That is boring, and boring is governed by
          // the ramp angle, so these are emitted as leads — same as the wedge a
          // ramp leaves. Calling them ordinary cutting would report a bite the
          // limit does not govern and cannot honour.
          entryRings: Math.ceil((r - seedR) / bite) + 1,
          // The rings stop at the walls of the region this seed opened.
          //
          // They are circles about the seed and they go on growing until they
          // are as wide as the whole job, so on a part with more than one
          // walled-off region they arrive — still centred on the first pocket —
          // over every other one, and over the band of stock the outer peel
          // leaves standing against the part for the wall pass to take. Being
          // the only thing left there with material under it, they cut it:
          // measured on a plate with three pockets in a billet 6mm oversize,
          // 1010 of the 2326 points a level's seeded peels emitted were outside
          // the plate altogether, sweeping the margin in arcs struck from a
          // pocket 40mm away. That is what "it carries on circling outward
          // outside the pocket, from the same centre" is a picture of.
          //
          // Clipping to the seed's own piece hands that band back to the wall
          // pass, whose it was: it comes out as one lap round the boundary
          // instead of forty arcs, and the peel is a peel again. Where a level
          // has one region only, this is the area it was clipping to anyway.
          within: pieceAt(seed),
        },
      );
      // An attempt that took nothing off leaves the map exactly as it was, and
      // the next `findSeed` answers the same question with the same numbers —
      // so it is the same seed, and every attempt after it is a rehearsal of
      // this one. Stopping here is not giving up early: it is the only other
      // outcome, said once instead of MAX_SEEDS times.
      if (map.remainingArea() >= standing - 1e-9) { stalled = standing; break; }
    }

    // wall pass: the ≤ one bite the peel left standing against the part
    level.cutSpans(allowed.map((loop) => {
      const oriented = orientLoop(loop, direction, loopArea(loop) < 0);
      return level.thin(loopToOpenPath(oriented));
    }));

    level.finish();
    // Counted here rather than where the seeding gave up, because the wall pass
    // comes after it and may well take the piece off: what makes this worth
    // saying is material still standing when the level is *over*.
    if (stalled > 0 && map.remainingArea() >= stalled - 1e-9) report.unopened++;
    // Only a level that cut something has taken the surface down to itself. A
    // level that found nothing to do leaves the material where it was, and the
    // pass below has to enter through *that*, not through a plane no cutter
    // ever reached.
    if (level.cut) { cutAnything = true; zEntry = z; }
  }

  goHome(cl, clearance);
  cl.info(summary(report, tool, target, cl.merger));
  if (!cutAnything) {
    // Naming the heights when a picked face is the reason sends the user to the
    // one tab that is not the problem — see engine/regions.js regionRefusal.
    const why = regionRefusal(regions, r, tolerance) ?? depthRefusal(params, levels);
    cl.warn(why
      ? `adaptive cleared nothing — ${why}`
      : 'adaptive cleared nothing — check the heights and the stock size');
  }
  return cl.finish();
}

/** One depth level's worth of cutting, with the material map that goes with it. */
class LevelCutter {
  constructor(options) {
    Object.assign(this, options);
    // The shortest move worth writing. Spans arrive as the geometry the
    // offsetter produced — chorded to the operation's tolerance, which on a
    // curve is a point every few hundredths of a millimetre — and a roughing
    // pass has no use for that resolution. See `resolution` in the params.
    this.minSegment = Math.max(0, this.minSegment ?? 0);
    // How finely a span is *asked about* — which is a different question from
    // how finely it is written out, and was the same number until the two were
    // separated. The decisions below (is there material under this span, does
    // it meet anything already cleared) have to be answered about the whole of
    // it, and a straight wall is two points.
    this.probeStep = Math.max(this.map.grid.cellSize, Math.min(this.bite, this.map.radius / 2));
    // the bite the *raster* reports for a cut of exactly one bite — see
    // touchesCleared, and geom/coverage.js for where the cell comes from
    this.contactLimit = engagementFraction(this.map.radius,
      Math.min(2 * this.map.radius, this.bite + this.map.grid.cellSize));
    // What counts as driving into a wall rather than taking a bite — see
    // splitAtWall. In millimetres of radial width, which is what the strategy
    // promises and what `widthAt` measures. Twice the bite, not the bite
    // itself: a span reading a hair over is the raster's own bias and the
    // ordinary business of a peel, and trimming those fragments the peel into
    // pieces, which costs an entry each and measurably *raises* the bite.
    this.wallWidth = Math.min(2 * this.map.radius, 2 * this.bite + this.map.grid.cellSize);
    // And what counts however short it is: the cutter buried past three
    // quarters of its width has material on both sides of itself and in front,
    // which no ring running beside its neighbour ever produces. That is the
    // second half of the test, and it is the one that catches an *island* — a
    // patch the peel left standing between two rings, a few millimetres across,
    // which the ring after them runs straight through at full width for the
    // whole depth of the level. Measured on the sloped part with a ⌀6 at a
    // 0.15xD bite: 1.00xD taken, 10.3mm deep, in one 7.8mm move.
    this.buriedWidth = 1.5 * this.map.radius;
    // The length that goes with it is one bite, and it has to be short: what
    // the cutter meets going into an island is over in the distance its leading
    // edge takes to cross the island's own edge, so an island a couple of
    // millimetres across is a couple of millimetres of full-width cutting and
    // no more. Nothing is shattered by it because the width has to reach three
    // quarters of the diameter first, and a peel running beside its last ring
    // reads one bite.
    this.minBuried = this.bite;
    this.thin = (path) => thinPath(path, this.minSegment);
    this.px = 0;
    this.py = 0;
    this.cursor = null;    // where the tool sits at depth, null when retracted
    this.cut = false;
    // How far a stay-down link may run: the vertical travel it saves, there and
    // back. See canStayDown.
    this.linkLimit = Math.max(4 * this.map.radius, 2 * Math.abs(this.clearance - this.z));
  }

  /**
   * Every move goes through here, so the material map never falls behind.
   *
   * Only moves at the level's own depth clear it. A ramp descending through
   * material has taken nothing off the floor it is heading for, and crediting it
   * would tell the map a span was clear while the pass that follows still has to
   * cut it.
   */
  emit = (x, y, z, feed = FEED.CUT) => {
    const atDepth = z <= this.z + 1e-9;
    // Only ordinary cutting is held to the bite limit; plunges and leads are the
    // entry, which the ramp angle governs.
    //
    // Read *along* the move, not at the point it arrives at. A bite is a
    // property of the cut and must not depend on how finely the path happens to
    // be written: taking one reading per emitted point reported 0.16xD for a
    // pass the replay measures at 0.22, because a straight wall is now one move
    // and the single reading at its far end is taken with the whole wall
    // already behind the cutter. Same hazard, opposite direction, as the one
    // adaptive.test.js documents.
    if (atDepth && feed === FEED.CUT) {
      const length = Math.hypot(x - this.px, y - this.py);
      const steps = Math.max(1, Math.min(64, Math.ceil(length / this.probeStep)));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        this.report.peak = Math.max(this.report.peak, this.map.widthAt(
          this.px + (x - this.px) * t, this.py + (y - this.py) * t,
          x - this.px, y - this.py));
      }
    }
    this.cl.cut(x, y, z, feed);
    if (atDepth) this.map.sweep(this.px, this.py, x, y);
    this.px = x; this.py = y;
    this.cut = true;
  };

  rapidTo(x, y, z) {
    this.cl.rapid(x, y, z);
    this.px = x; this.py = y;
  }

  /**
   * Walk a family of fronts, cutting where each one crosses the allowed region.
   *
   * @param frontAt k => closed loops, one bite further along than the last
   * @param hole whether the material lies outside the fronts rather than inside,
   *   which is what decides the sense that makes the cut climb
   * @param openWith whether the first front is an entry, and so exempt from
   *   needing cleared space beside it
   * @param within the one piece of the allowed area these fronts belong to;
   *   the whole of it when the peel is free to go wherever the level allows
   */
  peel(frontAt, {
    maxRings = MAX_RINGS, hole = false, openWith = false, entryRings = 0, within = null,
  } = {}) {
    const region = within ?? this.allowed;
    const pool = [];
    let ring = 0;
    let more = true;

    // Rings are pulled in as the pool drains rather than all at once: the
    // scheduler wants a few to choose between, and the filters that decide
    // whether a span may be cut yet only give the right answer against the
    // material as it stands at that moment.
    // Leftovers do not count toward the window. They are pieces of rings
    // already pulled in, waiting for the ring outside them to be cut, and
    // letting them fill the window stops fresh rings from arriving at all —
    // which ends the peel with the level half cleared.
    const fresh = () => pool.reduce((n, item) => n + (item.leftover ? 0 : 1), 0);
    const topUp = () => {
      while (more && fresh() < LOOKAHEAD && ring < maxRings) {
        const front = frontAt(ring);
        if (!front || front.length === 0) { more = false; break; }
        for (const loop of front) {
          const oriented = orientLoop(loop, this.direction, hole !== (loopArea(loop) < 0));
          for (const path of clipOpenPaths([loopToOpenPath(oriented)], region, 'intersect')) {
            const span = this.thin(path);
            if (span.length >= 2) {
              pool.push({
                span, ring, opener: openWith && ring === 0, entry: ring < entryRings,
              });
            }
          }
        }
        ring++;
      }
      if (ring >= maxRings) more = false;
    };

    for (;;) {
      topUp();
      if (pool.length === 0) break;
      const pick = this.chooseSpan(pool);
      // Nothing in the window may be cut yet, and nothing further in ever
      // unblocks something further out — the fronts are nested. Whatever is
      // left here belongs to a region this peel cannot reach, and a seeded peel
      // will open it from the inside.
      if (pick.index < 0) break;
      this.takeSpan(pool, pick);
    }
  }

  /** One family of spans with no ring structure — the wall pass, or a leftover. */
  cutSpans(spans, { requireContact = true } = {}) {
    const pool = spans.filter((s) => s.length >= 2)
      .map((span) => ({ span, ring: 0, opener: !requireContact }));
    for (;;) {
      const pick = this.chooseSpan(pool);
      if (pick.index < 0) break;
      this.takeSpan(pool, pick);
    }
  }

  /**
   * Which span to cut next, and the answer to "why does it wander".
   *
   * A span is reversed to shorten a hop only when the operation says either
   * direction will do: its direction is otherwise what makes the cut climb
   * rather than conventional, and that is worth more than the hop. So the
   * freedom is usually just the order, and it is spent in this priority:
   *
   *   1. a span the tool can reach without leaving the cut,
   *   2. the ring nearest the outside, so the peel stays a peel,
   *   3. the shortest hop.
   *
   * Putting the link first is what keeps the tool in one place. Cutting strictly
   * ring by ring means a front the part has broken into five pieces is five
   * separate visits, and the next ring is five more — the tool crosses the
   * billet and comes back for every one of them. Preferring what is reachable
   * finishes a corner through as many rings as it can before moving on, and
   * `touchesCleared` is what makes that safe: a span whose neighbour is still
   * standing is not offered whatever order we are in.
   *
   * `opener` marks the first ring of a seeded peel, which is an entry and so
   * exempt from needing cleared space beside it. Everything else must meet
   * something already cut, which is what stops an offset of the stock boundary
   * from reappearing inside a pocket and slotting into its wall at full width.
   *
   * @returns { index, reverse } — an index into `pool`, or -1 when nothing
   *   there may be cut
   */
  chooseSpan(pool) {
    // anything with no material left under it is finished business
    for (let i = pool.length - 1; i >= 0; i--) {
      if (!this.removesMaterial(pool[i].span)) pool.splice(i, 1);
    }
    const bothWays = this.direction === 'both';
    let best = -1;
    let bestKey = null;
    let bestReverse = false;
    for (let i = 0; i < pool.length; i++) {
      const { span, ring, opener } = pool[i];
      if (!opener && !this.touchesCleared(span)) continue;
      const ends = bothWays ? [[span[0], false], [span[span.length - 1], true]]
        : [[span[0], false]];
      for (const [entry, reverse] of ends) {
        const hop = this.cursor
          ? Math.hypot(entry[0] - this.cursor[0], entry[1] - this.cursor[1])
          : 0;
        const linked = this.cursor ? this.canStayDown(this.cursor, entry) : true;
        const key = [linked ? 0 : 1, ring, hop];
        if (bestKey === null || lexLess(key, bestKey)) {
          bestKey = key; best = i; bestReverse = reverse;
        }
      }
    }
    return { index: best, reverse: bestReverse };
  }

  /**
   * Which parts of a span have cleared space beside them, and which stand
   * against untouched material.
   *
   * `touchesCleared` asks whether *any* of it does, and a span that answers yes
   * is then cut from end to end. On a level where the peel reaches a ring from
   * one side only, that is a ring whose near edge takes the bite it was asked
   * for and whose far edge is driven into standing billet at full width, for the
   * whole depth of the level — measured on the sloped test part, a 6mm cut
   * 10.7mm deep from a cutter asked for 0.9mm. That is "it plunged straight into
   * a wall", and the strategy's own summary reported it: *peak bite 1.00xD,
   * heavier than the 0.15xD asked for*.
   *
   * So a span is cut where it may be, and the rest is handed back to be offered
   * again once the ring outside it has been taken. What no ring ever reaches is
   * left standing, which is not a loss: `findSeed` picks it up after the peel
   * and opens it from the inside with a bored entry, which is exactly what
   * adaptive does with walled-off material and what should have happened here.
   *
   * @returns { run, rest } — the longest part that may be cut now, and the
   *   pieces that may not
   */
  splitAtWall(span) {
    // A cell, not `probeStep`. This is the one question asked *along* a span
    // rather than about it as a whole, and an island is a couple of cells wide:
    // probed every bite instead, the samples straddle it and the run that comes
    // back is too short to be anything.
    const pts = densify(span, this.map.grid.cellSize);
    // read along the direction the cut will travel — see ClearingMap.widthAt
    const width = pts.map(([x, y], i) => {
      const [nx, ny] = pts[Math.min(i + 1, pts.length - 1)];
      const [px, py] = pts[Math.max(i - 1, 0)];
      return this.map.widthAt(x, y, nx - px, ny - py);
    });
    // A wall is a stretch at least as long as the cutter is wide.
    //
    // The raster reading crosses the limit and comes back from one cell to the
    // next, all along a ring running beside its neighbour, and splitting on
    // that shatters the ring into hundreds of pieces a bite long. Measured:
    // the tool nibbling alternately at two rings 0.9mm apart, every piece a
    // full-width cut because both its sides were still standing — worse than
    // the fault being fixed, and it passed every test in the suite except the
    // one that reads the bite back off the program.
    //
    // That length is what let an island through, so there is a second reading
    // beside it: buried past three quarters of the diameter counts at half the
    // length. See `buriedLimit`.
    const walls = [
      ...runsOf(width.map((w) => w > this.wallWidth), true)
        .filter(([a, b]) => pathLength(pts.slice(a, b)) >= 2 * this.map.radius),
      ...runsOf(width.map((w) => w > this.buriedWidth), true)
        .filter(([a, b]) => pathLength(pts.slice(a, b)) >= this.minBuried),
    ];
    if (walls.length === 0) return { run: span, rest: [] };

    const blocked = new Uint8Array(pts.length);
    for (const [a, b] of walls) for (let i = a; i < b; i++) blocked[i] = 1;
    const pieces = runsOf(blocked, 0)
      .map(([a, b]) => pts.slice(a, b))
      .filter((p) => p.length >= 2);
    let run = null;
    for (const p of pieces) if (!run || pathLength(p) > pathLength(run)) run = p;
    if (!run) return { run: null, rest: [] };
    // The other free pieces go back to be cut on a later turn. The walls do
    // not, and that is the whole point: offering a wall again gets it chosen
    // again, split again, and shaved by one bite from its end — the tool
    // nibbling alternately at two rings 0.9mm apart, every nibble a full-width
    // cut because both its sides are still standing. Left alone, the material
    // is still there when the peel finishes, `findSeed` picks it up, and a
    // seeded peel opens it from the inside with a bored entry and spirals
    // outward — which is what adaptive already does with anything the peel
    // cannot reach, and what should have happened to this from the start.
    return { run, rest: pieces.filter((p) => p !== run) };
  }

  /** Take one span out of the pool and cut it, either way round. */
  takeSpan(pool, pick) {
    const [item] = pool.splice(pick.index, 1);
    const span = pick.reverse ? [...item.span].reverse() : item.span;
    // An opener is the entry that starts a seeded peel; it is allowed to meet
    // material on every side, which is what boring a hole is.
    if (!item.opener) {
      const { run, rest } = this.splitAtWall(span);
      // Nothing here may be cut after all — leave it standing rather than
      // pushing a piece back that would be offered again on the same terms.
      if (!run) return;
      for (const piece of rest) {
        if (pathLength(piece) > this.map.grid.cellSize) {
          pool.push({ ...item, span: piece, opener: false, leftover: true });
        }
      }
      // Re-entering each ring at the vertex nearest the tool was tried here and
      // reverted — see the note below, which applies to this path too.
      this.cutSpan(run, item.entry);
      return;
    }
    // Re-entering each ring at the vertex nearest the tool was tried here and
    // reverted. It is free geometrically — a ring is a cycle — but it changes
    // which span the scheduler picks next, and the replayed peak bite on a
    // 0.10xD pass went to 0.137xD because a ring came up while the one outside
    // it was still standing. It also bought nothing worth having: the traverses
    // it was aimed at are arcs clipped out of the rings, not closed rings, and
    // the crossing planes in cutSpan took 3408mm of clearance travel down to
    // 117mm on the same job by themselves.
    this.cutSpan(span, item.entry);
  }

  /**
   * Would this span remove anything, or is it tracing air the peel already
   * passed? Sampled rather than walked: these run once per candidate per pick,
   * and the question is about whether a whole pass is worth making.
   */
  removesMaterial(span) {
    for (const [x, y] of samplePath(span, this.probeStep)) {
      if (this.map.engagementAt(x, y) > 0) return true;
    }
    return false;
  }

  /**
   * Does the span meet cleared space anywhere, or is it all fresh material?
   *
   * The limit has one cell of the raster added to it, and that cell is the
   * difference between a peel that keeps going and one that stops.
   *
   * A ring one bite outside the last one is, by construction, standing in
   * exactly one bite of material: the tool covers the band the previous ring
   * did not reach, and that band is a bite wide because that is what the ring
   * spacing *is*. So this test asks whether a number is at most the value it
   * was designed to equal — and the number is a raster reading whose material
   * mask is deliberately dilated by a cell so a sliver of stock is never
   * mistaken for air (see geom/coverage.js). The bias only goes one way. Every
   * ring therefore reads a hair over, every span is refused, the peel stops
   * after two rings, and the level is opened again three millimetres from the
   * hole it just opened — which is "it drills six holes instead of milling out
   * from one" seen from the outside.
   *
   * A cell is the exact size of that bias, and it is not slack for its own
   * sake: half a bite was tried instead and the replayed peak went from 0.11xD
   * to 0.21xD on a pass asked for 0.1. adaptive.test.js measures the emitted
   * program rather than this bookkeeping, which is why that attempt did not
   * survive and this one has to be no bigger than the error it corrects.
   */
  touchesCleared(span) {
    for (const [x, y] of samplePath(span, this.probeStep)) {
      if (this.map.engagementAt(x, y) <= this.contactLimit) return true;
    }
    return false;
  }

  /**
   * Somewhere near the start of this span where the tool can go straight down
   * to the level without cutting anything.
   *
   * Every span the peel offers has cleared space beside it — that is what
   * `touchesCleared` is — and cleared space at this level is *empty down to the
   * level*, so the tool can be lowered into it at rapid and walk in at depth.
   * The alternative is what adaptive did with every entry: ramp along the span
   * itself, which at the strategy's own defaults is a 2° descent through a two
   * diameter stepdown, i.e. three hundred millimetres of path at plunge feed
   * before the cut proper begins. Measured on the sloped test part, entry moves
   * were 84% of everything the program did at a feed rate.
   *
   * @returns [x, y] or null when nothing beside the span is open yet — the
   *   first entry of a level, or a region being opened from the inside
   */
  openDescent(span) {
    const [sx, sy] = span[0];
    // the direction the span runs, so the search starts to either side of it
    const [nx, ny] = span.length > 1
      ? [span[1][0] - sx, span[1][1] - sy] : [1, 0];
    const len = Math.hypot(nx, ny) || 1;
    const along = [nx / len, ny / len];
    const r = this.map.radius;
    for (const reach of [r + this.bite, 1.5 * r, 2.5 * r]) {
      for (let k = 0; k < 12; k++) {
        // alternate sides, widening away from the span's own direction
        const turn = (k % 2 === 0 ? 1 : -1) * (Math.PI / 2 + Math.floor(k / 2) * 0.3);
        const dx = along[0] * Math.cos(turn) - along[1] * Math.sin(turn);
        const dy = along[0] * Math.sin(turn) + along[1] * Math.cos(turn);
        const x = sx + dx * reach;
        const y = sy + dy * reach;
        if (!this.map.insideAt(x, y)) continue;
        // nothing under the cutter here, so going down is going down through air
        if (this.map.engagementAt(x, y) > 0) continue;
        if (!this.canStayDown([x, y], span[0])) continue;
        return [x, y];
      }
    }
    return null;
  }

  cutSpan(span, entry = false) {
    const [sx, sy] = span[0];
    const feed = entry ? FEED.LEAD : FEED.CUT;
    if (this.cursor && this.canStayDown(this.cursor, span[0])) {
      this.report.links++;
      this.emit(sx, sy, this.z, FEED.LEAD);
      for (let i = 1; i < span.length; i++) this.emit(span[i][0], span[i][1], this.z, feed);
      this.cursor = span[span.length - 1];
      return;
    }
    // Between staying down and going home there is a third move, and it is the
    // one nearly every relink wants: lift to the feed plane, cross, and come
    // back down. Measured on a 20mm pocket, the retracts that were left after
    // canStayDown had done its work climbed 21mm to clearance and back to move
    // the tool **2.3mm** across — forty-two millimetres of vertical travel to
    // cover two horizontal ones, and one of those per relink.
    //
    // What makes it safe is what already makes the *descent* to the feed plane
    // safe: inside this level's allowed region nothing stands higher than the
    // level above left it, which is what `feedPlane` is a gap above. The line
    // has to stay inside that region for the whole way — outside it is the part
    // and the tool has no business crossing that below clearance.
    const hop = this.feedPlane;
    // The link that has to leave the region — around a boss, from the outside
    // of a block to a pocket in the middle of it — can still cross below
    // clearance, just not as low. Above the *stock* nothing of the job can be
    // in the way, because the part is inside the stock by definition. What can
    // be is a clamp, which stands proud of the stock and is a keep-out for the
    // whole column above its footprint (see engine/fixtures.js), and adaptive
    // is not given enough to route around one — so with fixtures in the setup
    // this falls back to clearance, which is what clearance is for.
    // Go down where the level is already open, if anywhere near here is, and
    // walk in at depth. See openDescent.
    const open = entry ? null : this.openDescent(span);
    const [dx, dy] = open ?? [sx, sy];
    const cross = this.cursor && hop != null && this.canHop(this.cursor, [dx, dy])
      ? hop
      : this.stockPlane;
    if (this.cursor && cross != null) {
      this.report.hops++;
      this.rapidTo(this.px, this.py, cross);
      this.rapidTo(dx, dy, cross);
      if (hop != null && hop < cross - 1e-9) this.rapidTo(dx, dy, hop);
    } else {
      // Including the first entry of a level, which has no cursor: "the tool is
      // somewhere else on this job" is the same claim whether the somewhere
      // else was a span or the level above, and the crossing plane answers it.
      const home = this.stockPlane ?? this.clearance;
      if (this.cursor) this.rapidTo(this.px, this.py, home);
      this.rapidTo(dx, dy, home);
      // drop to the feed plane at rapid; with hundreds of entries per level, the
      // air above the material is where a clearing program spends its time
      if (hop != null && hop > this.zEntry + 1e-9) this.rapidTo(dx, dy, hop);
    }
    this.report.entries++;
    if (open) {
      // straight down through the space the peel has already emptied, then in
      this.report.opened++;
      this.px = dx; this.py = dy;
      this.emit(dx, dy, this.z, FEED.PLUNGE);
      this.emit(sx, sy, this.z, FEED.LEAD);
      for (let i = 1; i < span.length; i++) this.emit(span[i][0], span[i][1], this.z, feed);
      this.cursor = span[span.length - 1];
      return;
    }
    this.cursor = cutSpanWithRamp(
      entry ? (x, y, z) => this.emit(x, y, z, FEED.LEAD) : this.emit,
      span, this.zEntry, this.z, this.rampAngle,
      {
        // a span no longer than the cutter is wide cannot be ramped into — see
        // engine/linking.js
        minLength: 2 * this.map.radius,
        onSteepen: (deg) => {
          this.report.steepest = Math.max(this.report.steepest, deg);
        },
      },
    );
  }

  /**
   * May the tool travel between two points without lifting? Only if the whole
   * way is inside the allowed region and already cleared — anything less and a
   * "link" is a cut nobody asked for.
   *
   * "Cleared" cannot mean *nothing under the cutter*, because the far end of the
   * link is where the next pass starts and so is standing in material by
   * definition — the last stretch of any link is the tool meeting that material.
   * What it means is that the link never takes a bigger bite than the cut it is
   * travelling to, so nothing is ploughed on the way.
   *
   * Length is the other half of it. Staying down is only worth doing while it is
   * *quicker* than getting out of the way, and the cost of getting out of the way
   * is the lift and the descent back — so a link is worth feeding across up to
   * about that far, and beyond it the tool should lift and rapid like anything
   * else. Without the limit, clearing a part with two pockets feeds the whole way
   * between them at cutting feed for no reason.
   */
  /**
   * May the tool cross at the feed plane rather than at clearance?
   *
   * The same walk as canStayDown with the engagement test dropped, because at
   * the feed plane the tool is *above* the material rather than in it — what it
   * may not do is leave the region, where the part stands at its own height and
   * the feed plane means nothing. There is no length limit: crossing at the
   * feed plane costs the same per millimetre as crossing at clearance, so the
   * saving is the two vertical moves and it does not shrink with distance.
   */
  canHop(from, to) {
    const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const steps = Math.max(2, Math.ceil(dist / this.map.grid.cellSize));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = from[0] + (to[0] - from[0]) * t;
      const y = from[1] + (to[1] - from[1]) * t;
      // The two ends are span endpoints, which sit exactly on the region
      // boundary by construction and need the dilated reading. Everything
      // between them needs the eroded one — a "yes" there has to be a yes for
      // the real polygon, because the thing the crossing plane is above is one
      // level of stock and the thing it is *beside* is the part, standing its
      // full height. One cell of slack in the middle of a traverse is the tool
      // grazing a boss corner 0.25mm deep with 8mm of it above the cutter.
      const inside = i === 0 || i === steps
        ? this.map.insideAt(x, y) : this.map.allowedAt(x, y);
      if (!inside) return false;
    }
    return true;
  }

  canStayDown(from, to) {
    const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (dist > this.linkLimit) return false;
    const steps = Math.max(2, Math.ceil(dist / this.map.grid.cellSize));
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const x = from[0] + (to[0] - from[0]) * t;
      const y = from[1] + (to[1] - from[1]) * t;
      // `insideAt`, not `allowedAt`: both ends of a link are span endpoints, and
      // a span endpoint sits exactly on the region boundary by construction —
      // which the eroded mask reads as out of bounds. See geom/coverage.js.
      if (!this.map.insideAt(x, y)) return false;
      // `contactLimit`, not `biteLimit` — the same one cell of raster bias that
      // `touchesCleared` corrects for, and for exactly the same reason.
      //
      // A link runs from the end of one ring to the start of the next, one bite
      // inward: by construction it crosses ground standing in about one bite of
      // material, and the material mask is dilated by a cell so a sliver of
      // stock is never mistaken for air. So the reading came back a hair over
      // the number it was designed to equal — 0.095 against a limit of 0.094 —
      // and the link was refused. Measured on the sloped test part: 80 of 180
      // entries were caused by this, and an entry is not cheap here. At a 2xD
      // stepdown a 2° ramp descends over 300mm of path at plunge feed, so those
      // refusals turned a three-level clearing pass into 27 metres of ramping
      // and 140 minutes of machine time, most of it re-entering rings the tool
      // was already standing next to.
      if (this.map.engagementAt(x, y) > this.contactLimit) return false;
    }
    return true;
  }

  finish() {
    // The end of a level is a transition like any other: the next one starts
    // somewhere else on the same job, and the crossing plane clears the job.
    if (this.cursor) this.rapidTo(this.px, this.py, this.stockPlane ?? this.clearance);
    this.cl.flushMerged();
    this.cursor = null;
  }
}

/** Index ranges [start, end) over which `flags` is truthy (or falsy), in order. */
function runsOf(flags, value) {
  const want = Boolean(value);
  const out = [];
  let from = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (i < flags.length && Boolean(flags[i]) === want) { if (from < 0) from = i; continue; }
    if (from >= 0) out.push([from, i]);
    from = -1;
  }
  return out;
}

/** How far a [[x, y], …] path runs. */
function pathLength(pts) {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) {
    sum += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return sum;
}

/**
 * The same path with a point at least every `step`, its own vertices kept.
 *
 * Asked for by splitAtWall, which has to know *where* along a span the material
 * beside it stops being cleared. The span's own vertices are no guide to that:
 * a straight wall is two points and the change can be anywhere along it.
 */
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(step, 1e-6)));
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
  }
  return out;
}

/** A closed CCW circle, as a flat loop. */
function circleLoop([cx, cy], radius, tolerance) {
  const segments = arcSegments(radius, tolerance);
  const loop = new Array(segments * 2);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    loop[i * 2] = cx + radius * Math.cos(a);
    loop[i * 2 + 1] = cy + radius * Math.sin(a);
  }
  return loop;
}

/** Segments for a full circle whose chords stay within `tolerance` of it. */
function arcSegments(radius, tolerance) {
  const ratio = Math.max(1e-6, Math.min(1, tolerance / Math.max(radius, 1e-6)));
  const step = 2 * Math.acos(1 - ratio);
  return Math.max(8, Math.min(180, Math.ceil((2 * Math.PI) / step)));
}

/**
 * Flat path → [x, y] points, with anything closer together than `minSegment`
 * folded into its neighbour.
 *
 * The offsetter chords a curve to the operation's tolerance, which is a
 * *finishing* number: at 0.01mm a fillet on a roughing pass arrives as a point
 * every few hundredths of a millimetre, and every one of them is a block the
 * control has to read for a pass whose whole promise is that it leaves 0.3mm
 * standing. Dropping the points closer together than the resolution is the one
 * simplification the collinear filter downstream cannot make, because those
 * points are not collinear — they are a genuine curve, described far more
 * finely than the cut needs.
 *
 * The path can move by at most `minSegment` from doing this, and only across
 * gaps that short, so the error is bounded by the number the user set.
 */
function thinPath(path, minSegment) {
  const pts = [];
  const n = path.length / 2;
  if (n === 0) return pts;
  pts.push([path[0], path[1]]);
  for (let i = 1; i < n; i++) {
    const [ax, ay] = pts[pts.length - 1];
    const bx = path[i * 2];
    const by = path[i * 2 + 1];
    // the last point of a span is where the next pass links from, so it is
    // never the one dropped
    if (i < n - 1 && Math.hypot(bx - ax, by - ay) < minSegment) continue;
    pts.push([bx, by]);
  }
  return pts;
}

/**
 * What the pass actually did, in the units the parameter was set in — and a word
 * when the geometry beat the limit, since a bite half again as wide as asked is
 * the difference between a cut that runs at the feed you set and one that does not.
 */
function summary({
  peak, entries, links, hops, steepest, seeds, opened, unopened,
}, tool, target, merger) {
  // `peak` is already a radial width in mm — see ClearingMap.widthAt
  const peakBite = peak / tool.diameter;
  const over = peakBite > target * 1.5
    ? ` — heavier than the ${target.toFixed(2)}xD asked for; try a smaller cutter here`
    : '';
  const seen = merger?.seen ?? 0;
  const dropped = seen > 0 ? Math.round(((seen - merger.kept) / seen) * 100) : 0;
  // Steepening is not a detail: the ramp angle is a limit on how hard the tool
  // is asked to plunge, and somewhere in this program it was not honoured.
  const steep = steepest > 0
    ? `, one or more entries ramped at up to ${steepest.toFixed(1)}° — the span was `
      + 'too short for the angle set'
    : '';
  // `seeds` counts regions, not entries — it is how many places the peel could
  // not reach and had to be opened from the inside — so it cannot be written as
  // a share of the entries. It was, and on the plate that exposed the seeding
  // bug it read "17 entries (48 of them opening a walled-off region)".
  //
  // Which is also why the clause sits *after* the count of descents rather than
  // between it and the entries it counts: written the other way round, "them"
  // reached back to the regions instead of to the entries and the sentence read
  // "20 walled-off regions opened from the inside (29 of them straight down)" —
  // a share bigger than the whole it claims to be a share of.
  const walled = seeds > 0
    ? `, ${plural(seeds, 'walled-off region')} opened from the inside` : '';
  const left = unopened > 0
    ? `, ${plural(unopened, 'region')} too narrow for this cutter to open — `
      + 'material is left standing there'
    : '';
  return `adaptive: peak bite ${peakBite.toFixed(2)}xD, `
    + `${plural(entries, 'entry', 'entries')} `
    + `(${opened} of them straight down into space the pass had already cleared)`
    + `${walled}, `
    + `${plural(links, 'stay-down link')}, `
    + `${hops} crossing at the feed plane rather than at clearance, `
    + `${dropped}% of the sampled points merged away${steep}${left}${over}`;
}
