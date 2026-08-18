// Waterline (Z-level) finishing: follow the part's own contour at each depth.
//
// The complement of parallel finishing. A raster leaves its best finish on
// steep walls and its worst on flat ground; waterline is the reverse — it walks
// the silhouette at each Z, so vertical and near-vertical faces come out with
// an even cusp while flats get nothing. Most parts want both.
//
// Unlike contour, which offsets the *outer* profile to size, waterline machines
// every loop the part presents at that level, including pocket walls and the
// sides of bosses.
//
// Ordered by *feature*, not by level. The levels are all computed first, the
// loops are chained across them into columns — the outer profile's rings, one
// bore's rings, the next bore's — and each column is machined from its top ring
// to its bottom one. Cutting level by level instead means the tool visits every
// feature at every depth: on this part, four loops a level and a hundred and
// sixteen levels is four hundred and sixty-four full climbs to the crossing
// plane, one for every five millimetres of cut. Within a column the next ring
// is a stepdown below the one just cut and a fraction of a millimetre away from
// it, so the link is a lift of one entry gap and the tool works its way down
// the wall — which is what the operation looks like it should do.
//
// It is a finishing operation, so descending one feature at a time is safe in
// the way it would not be for roughing: the material either side of the wall
// has already been cleared, and each ring only takes the cusp its neighbour
// above left.

import { CLBuilder } from '../cl.js';
import { mergeTolerance } from '../simplify.js';
import { offsetLoops, unionLoops } from '../../geom/clipper.js';
import { SilhouetteStack } from '../../geom/silhouette.js';
import { computeBounds } from '../../geom/mesh.js';
import { depthPasses } from '../stock.js';
import { applyRegionsToPaths } from '../regions.js';
import {
  cutLoopPass, cutOpenPass, orderLoopForEntry, loopEntryPoint, loopExitPoint, resolveLead,
} from './contour.js';
import { zLevelLinker } from '../linking.js';
import { entryPlane, crossingPlane, goHome, entryGapOf } from '../heights.js';
import { applyCutting } from '../cutting.js';
import { tipLengthOf, cuttingPoints } from '../tool-geometry.js';

/**
 * The heights a shaped cutter has to be asked about, and how wide it is by then.
 *
 * Offsetting the level's silhouette by the tool's radius asks one question —
 * "where would a cylinder of this diameter foul what stands above this Z" —
 * and that is the right question for a flat end mill and the wrong one for
 * every other shape. A ball nose is a point at its tip and only reaches full
 * width a radius further up, so on anything that is not a vertical wall it may
 * sit closer in than its radius. Asking the cylinder's question of it held the
 * ball a full radius off a surface it touches with its nose, and left a step
 * there: a ⌀6 ball, a ⌀6 bull nose and a ⌀6 flat produced *byte-identical*
 * programs, which is the tell — the only thing being read off the tool was its
 * diameter.
 *
 * Two things keep it cheap and keep it safe:
 *
 *   The heights land on the pass grid. `down(z)` is an accumulator walked once
 *   from the top, and asking it about heights between the levels would double
 *   or treble the silhouettes a pass builds — the expensive half of the
 *   operation. Every height here is a whole number of stepdowns, so `z + dz` is
 *   a level that is being computed anyway.
 *
 *   Each band carries the radius the cutter has by the *top* of it, which is
 *   the direction that cannot gouge. A band spans heights [dz, dz + band), and
 *   material anywhere in it must clear the widest the cutter is anywhere in it
 *   — so the standoff is the radius at `dz + band`, not the one at `dz`.
 *
 *   Getting that the other way round is a gouge, not a rounding: taking the
 *   radius at the bottom of each band held a ⌀6 ball 0.375mm from a face
 *   0.24mm above the pass, where it needs 1.2mm, and its flank cut 0.33mm into
 *   the finished surface. Erring the other way leaves at most the cusp the
 *   stepdown leaves anyway, on ground too near horizontal for waterline to be
 *   finishing in the first place.
 *
 * A flat cutter has no tip length and comes back as the single question it
 * always was — unchanged, to the byte.
 *
 * @returns [{ dz, radius }] with dz measured up from the tip
 */
export function profileSteps(tool, spacing, maxBands = 12) {
  const r = Math.max(0.05, tool.diameter / 2);
  const tip = tipLengthOf(tool);
  if (!(tip > 1e-6) || !(spacing > 0)) return [{ dz: 0, radius: r }];

  // the profile as [radius, height], densely enough to read either way
  const points = cuttingPoints(tool, 48).filter(([, z]) => z <= tip + 1e-9);
  /** The widest the cutter is anywhere at or below `h`. */
  const radiusBelow = (h) => {
    let widest = 0;
    for (const [pr, pz] of points) if (pz <= h + 1e-9 && pr > widest) widest = pr;
    return Math.min(r, widest);
  };

  // One band per pass level, so every height asked about is a level `down()` is
  // computing anyway — coarsened when the tip is taller than that many levels.
  const levels = Math.max(1, Math.ceil(tip / spacing - 1e-9));
  const band = Math.max(1, Math.ceil(levels / maxBands)) * spacing;
  const steps = [];
  for (let k = 0; k * band < tip - 1e-9; k++) {
    steps.push({ dz: k * band, radius: radiusBelow(Math.min((k + 1) * band, tip)) });
  }
  // anything higher than the tip is the full width, which the last band above
  // already carries — but a cutter whose tip is shorter than one band has no
  // bands at all, and that one still needs the question asking
  if (steps.length === 0) steps.push({ dz: 0, radius: r });
  return steps;
}

export function generateWaterline({
  mesh, tool, params, regions, stock, fixtures,
}) {
  const r = tool.diameter / 2;
  const stockToLeave = params.stockToLeave ?? 0;
  const clearance = params.clearanceHeight;
  const tolerance = params.tolerance ?? 0.01;
  const direction = params.direction ?? 'climb';
  const lead = { type: params.leadType ?? 'none', radius: params.leadRadius ?? 0 };
  // finishing steps down far finer than roughing; stepdown is the cusp control
  const stepdown = Math.max(0.05, params.stepdown ?? 0.5);
  // how high a pass has to go to reach the next one — see engine/heights.js
  const crossAt = crossingPlane(params, stock, fixtures);

  const cl = new CLBuilder().simplify(mergeTolerance(tolerance));
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  const silhouette = new SilhouetteStack(mesh, { tolerance });
  const clip = { radius: r, tolerance };
  let zEntry = params.topZ;
  let cutAnything = false;

  // Never cut *at* the mesh's own bottom face. It is a flat horizontal cap,
  // and STL exporters routinely tessellate flat faces with a few very large
  // triangles — so at exact-bottom Z the "contour" is those triangles' chords
  // rather than the part's true side wall. Lifting the deepest pass by a
  // tolerance clears the cap and puts us on the wall geometry, which is what
  // finishing is actually meant to trace.
  const meshBottom = computeBounds(mesh.positions).min[2];
  const floorZ = Math.max(params.bottomZ, meshBottom + tolerance);

  // Every level first: the link planner needs the whole stack to answer how
  // high anything is, and the columns cannot be chained until they all exist.
  // Every height the cutter's own profile makes a question of, asked of one
  // descending walk: `down` accumulates from the top and only answers a z below
  // the last one it was given, so the queries are sorted together rather than
  // run as one stack per step.
  const passZs = depthPasses(params.topZ, floorZ, stepdown);
  // the grid the levels actually landed on: depthPasses shares the depth out
  // evenly, so the spacing is at most the stepdown and rarely exactly it
  const spacing = passZs.length > 1 ? passZs[0] - passZs[1] : params.topZ - passZs[0];
  const steps = profileSteps(tool, spacing);
  const shadows = new Map();
  const asked = [...new Set(passZs.flatMap((z) => steps.map((s) => z + s.dz)))]
    .sort((a, b) => b - a);
  for (const at of asked) shadows.set(at, silhouette.down(at));

  const levels = [];
  for (const z of passZs) {
    // the union of "how close may the tool get to what stands above *this*
    // height, given how wide it is by *then*"
    // One offset per *distinct* silhouette, at the widest the cutter is by the
    // time it is asked about. Where nothing new comes into the band — a plain
    // vertical wall, which is most of what waterline is for — `down` hands back
    // the very same array, so this collapses the whole profile to the single
    // question a cylinder asks and costs nothing over the old code.
    const widest = new Map();
    for (const step of steps) {
      const shadow = shadows.get(z + step.dz);
      if (!shadow?.length) continue;
      widest.set(shadow, Math.max(widest.get(shadow) ?? 0, step.radius));
    }
    const pieces = [];
    for (const [shadow, radius] of widest) {
      pieces.push(...offsetLoops(shadow, radius + stockToLeave, tolerance));
    }
    if (pieces.length === 0) continue;
    const raw = widest.size === 1 ? pieces : unionLoops(pieces);
    if (raw.length === 0) continue;
    const { closed, open } = applyRegionsToPaths(raw, regions, { ...clip, z });
    levels.push({ z, region: raw, closed, open });
  }

  // The highest the tool is ever asked to travel between passes. `crossAt` is
  // null when there are fixtures in the way, and then nothing below clearance
  // may be trusted at all — see heights.js.
  const ceiling = crossAt != null ? Math.min(crossAt, clearance) : clearance;
  const linkAt = zLevelLinker(levels, {
    entryGap: entryGapOf(params),
    ceiling,
    // the same step the loops themselves are built to, so the probe cannot
    // miss a feature the geometry does resolve
    probeStep: Math.max(tolerance * 4, r / 2, 0.05),
  });

  // Planned before any of it is emitted, because a pass has to know the height
  // it *leaves* at as well as the one it arrives at, and that one belongs to
  // the move to the pass after it. The two must agree: they are the two ends of
  // one traverse, and a retract to one height followed by a positioning move to
  // a lower one is a diagonal that cuts the corner off whatever is between.
  const passes = [];
  let from = null;   // the [x, y] the previous pass finishes on
  for (const column of chainColumns(levels)) {
    for (const { z, loop } of column) {
      if (loop.length / 2 < 3) continue;
      // Which side the metal is on, settled here against the loop the offsetter
      // produced and then carried. Re-derived from `ready` it would come out the
      // other way — orienting the loop is exactly what destroys the winding the
      // derivation reads — so the plan below and the pass further down would
      // disagree about both the direction of cut and where the tool arrives.
      const passLead = resolveLead(loop, lead);
      const ready = orderLoopForEntry(loop, direction, passLead, from);
      const entry = loopEntryPoint(ready, passLead);
      passes.push({
        z,
        loop: ready,
        lead: passLead,
        link: from ? linkAt([...from, passes[passes.length - 1].z], [...entry, z]) : ceiling,
      });
      from = loopExitPoint(ready, passLead);
    }
  }

  for (let i = 0; i < passes.length; i++) {
    const { z, loop, link, lead: passLead } = passes[i];
    // each level is entered at depth: the wall above is already cut away, so
    // there is nothing to ramp through
    if (cutLoopPass(cl, loop, z, z, {
      clearance,
      direction,
      lead: passLead,
      params,
      crossAt: link,
      // the last pass hands the tool back at clearance — see goHome
      exitAt: passes[i + 1]?.link ?? ceiling,
    })) {
      cutAnything = true;
    }
  }

  // Open paths are what the region filter leaves of a ring it cut in two. They
  // are not part of any column — a trimmed ring has no next one to descend to —
  // so they run afterwards, level by level, as they always did.
  for (const { z, open } of levels) {
    let cutHere = false;
    for (const path of open) {
      if (cutOpenPass(cl, path, z, { clearance, feedPlane: entryPlane(params, zEntry, z) })) cutHere = true;
    }
    // a level with no open paths cut nothing, so it has not lowered the surface
    // the next descent comes through — see engine/heights.js entryPlane
    if (cutHere) { cutAnything = true; zEntry = z; }
  }

  if (!cutAnything) cl.warn('waterline produced no passes — check Top Z and Bottom Z');
  goHome(cl, clearance);
  return cl.finish();
}

/**
 * Chain each level's loops into columns: the same feature's ring at one depth
 * after another, top to bottom.
 *
 * Matched on centroid, nearest first. A wall that is vertical hardly moves
 * between levels and a sloped one moves by a stepdown's worth of run, so
 * "nearest" is the whole of the rule — there is nothing subtler to be had from
 * a shape that may split, merge or vanish as the part is descended through.
 *
 * Getting a match wrong costs an ordering, never a gouge: how high the tool
 * travels between two passes is answered by the silhouette stack, not by this.
 * A ring that matches nothing starts a column of its own, which is exactly what
 * happens where a bore first opens up.
 */
function chainColumns(levels) {
  const columns = [];
  let openColumns = [];   // { column, at: [x, y] } still being extended

  for (const { z, closed } of levels) {
    const free = [...openColumns];
    const next = [];
    for (const loop of closed) {
      const c = centroid(loop);
      let best = -1;
      let bestDistance = Infinity;
      for (let i = 0; i < free.length; i++) {
        const d = (free[i].at[0] - c[0]) ** 2 + (free[i].at[1] - c[1]) ** 2;
        if (d < bestDistance) { bestDistance = d; best = i; }
      }
      let entry;
      if (best >= 0) {
        [entry] = free.splice(best, 1);
      } else {
        entry = { column: [], at: c };
        columns.push(entry.column);
      }
      entry.column.push({ z, loop });
      entry.at = c;
      next.push(entry);
    }
    // a column with no ring at this level has ended: the feature closed up
    openColumns = next;
  }
  return columns;
}

/** Centroid of a flat [x, y, x, y, …] loop, by vertex. */
function centroid(loop) {
  let x = 0;
  let y = 0;
  const n = loop.length / 2;
  for (let i = 0; i < n; i++) { x += loop[i * 2]; y += loop[i * 2 + 1]; }
  return [x / n, y / n];
}
