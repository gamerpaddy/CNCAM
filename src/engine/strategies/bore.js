// Boring round holes by helical interpolation.
//
// Drilling gets you a hole the size of the drill. Everything else — a 20mm bore
// with a 10mm cutter, a hole that has to be round and on size rather than
// roughly where the drill wandered, a hole too big for any drill in the rack —
// is milled, and milling a round hole means going down it in a spiral.
//
// The advantage over sending a pocket at it is that the geometry is known: a
// circle has a centre, so the tool never has to plunge. It enters on the helix
// itself, at whatever pitch the user allows, and the same path that gets it to
// depth is the path that cuts. A pocket strategy would ramp in somewhere
// arbitrary and then trochoid around a shape it has to discover.
//
// Holes are found the same way drilling finds them (drill.js, findHoles), so an
// operation can be pointed at "every hole this cutter fits in" and get the
// answer the part actually contains.

import { CLBuilder, FEED, lastXY } from '../cl.js';
import { plural, verb, allOf } from '../text.js';
import { computeBounds } from '../../geom/mesh.js';
import { applyCutting } from '../cutting.js';
import { approach, entryPlane } from '../heights.js';
import { regionAllowsPoint } from '../regions.js';
import { findHoles } from './drill.js';

export function generateBore({ mesh, tool, params, regions }) {
  const clearanceZ = params.clearanceHeight;
  const tolerance = params.tolerance ?? 0.01;
  const toolR = tool.diameter / 2;
  const bounds = computeBounds(mesh.positions);
  const scanTop = Math.min(params.topZ, bounds.max[2]);
  const scanBottom = Math.max(params.bottomZ, bounds.min[2]);
  const stockToLeave = Math.max(0, params.stockToLeave ?? 0);
  const finishPasses = Math.max(0, Math.round(params.finishPasses ?? 0));
  const wanted = Math.max(0, params.boreDiameter ?? 0);
  const matchTol = Math.max(0, params.diameterTol ?? 0.5);
  const preDrillR = Math.max(0, (params.preDrilled ?? 0) / 2);
  const pitch = Math.max(0.01, params.stepdown ?? 1);
  const step = Math.max(0.05, (params.stepover ?? 0.4) * tool.diameter);
  // Material sits outside a bore, so the climb sense is the mirror of an
  // outside profile: counter-clockwise keeps the work on the cutter's right.
  const ccw = (params.direction ?? 'climb') === 'climb';

  const cl = new CLBuilder();
  cl.toolChange(tool.number);
  applyCutting(cl, { params }, tool);

  const found = findHoles(mesh, { topZ: scanTop, bottomZ: scanBottom, bounds });
  if (found.length === 0) {
    cl.warn(`no round holes found between Z${scanTop.toFixed(2)} and Z${scanBottom.toFixed(2)}`);
    return cl.finish();
  }

  // A cutter has to fit inside the hole with room to move, or there is no helix
  // to run — that is a drilling or a reaming job, not a boring one.
  const fits = found.filter((h) => h.r > toolR + 0.05);
  const wantedSize = wanted > 0
    ? fits.filter((h) => Math.abs(h.r * 2 - wanted) <= matchTol)
    : fits;

  // Where the cutter is allowed to be. A bore opens the hole out to its own
  // finished radius, so that — not the cutter's — is how far this operation
  // reaches, and it is what a keep-out has to be grown by. Boring took no
  // regions at all before this: a clamp over a hole was bored through, measured
  // against ten other strategies that all went round it. See engine/regions.js.
  const sized = wantedSize.filter((h) => regionAllowsPoint(regions, h.cx, h.cy, {
    radius: h.r, tolerance,
  }));
  const blocked = wantedSize.length - sized.length;

  if (sized.length === 0) {
    cl.warn(blocked > 0
      ? `${allOf(blocked, 'bore')} ${verb(blocked, 'is', 'are')} under a clamp or `
        + 'outside the picked regions'
      : reasonForNothing({
        found, fits, wanted, matchTol, tool,
      }));
    return cl.finish();
  }
  if (blocked > 0) {
    cl.info(`${plural(blocked, 'bore')} skipped — under a clamp or outside the picked regions`);
  }

  const perHole = (params.depthMode ?? 'bottomZ') === 'hole';
  sized.sort((a, b) => a.cy - b.cy || a.cx - b.cx);

  const done = [];
  let tooDeep = 0;
  for (const hole of sized) {
    const zTop = Math.min(params.topZ, hole.top);
    const zBottom = perHole ? Math.max(hole.bottom, params.bottomZ) : params.bottomZ;
    if (!(zTop > zBottom + 1e-6)) continue;
    if (tool.fluteLength > 0 && zTop - zBottom > tool.fluteLength) tooDeep++;

    const finishR = hole.r - toolR;
    // an allowance thicker than the annulus itself would put the roughing pass
    // inside out; there is nothing to leave on a wall the cutter barely reaches
    const allowance = Math.min(stockToLeave, Math.max(0, finishR - 0.05));
    const roughR = finishR - allowance;
    const radii = boreRadii({ finalR: roughR, startR: preDrillR + toolR, step });
    if (radii.length === 0) continue;

    // Finish passes peel the allowance off the wall, each one a full-depth
    // helix at its own radius — which is exactly what a wall finishing pass is.
    // With an allowance and no passes asked for, one still has to take it off.
    if (allowance > 0) {
      const n = Math.max(1, finishPasses);
      for (let i = 1; i <= n; i++) radii.push(roughR + (allowance * i) / n);
    }

    for (const radius of radii) {
      helixBore(cl, {
        cx: hole.cx,
        cy: hole.cy,
        radius,
        zTop,
        zBottom,
        pitch,
        ccw,
        tolerance,
        clearanceZ,
        feedPlane: entryPlane(params, zTop, zBottom),
      });
    }
    done.push(hole);
  }

  if (done.length === 0) {
    cl.warn('every matching hole was outside the Top Z / Bottom Z range');
    return cl.finish();
  }
  // The sizes that were actually bored, not the first one's standing for all of
  // them. Pointed at a plate of assorted holes the note read "3 bore(s), ⌀10.00
  // with a ⌀6 cutter" over a ⌀20, a ⌀10 and an ⌀8 — the paths were right and
  // the only thing wrong was the sentence, which is the one part of it anybody
  // reads before pressing cycle start.
  cl.info(`${plural(done.length, 'bore')}, ${describeSizes(done)} with a ⌀${tool.diameter} cutter`
    + (found.length > done.length ? ` — ${plural(found.length - done.length, 'hole')} skipped` : ''));
  if (tooDeep > 0) {
    cl.warn(`${plural(tooDeep, 'bore')} ${verb(tooDeep, 'goes', 'go')} deeper than the `
      + `cutter's ${tool.fluteLength}mm of flute`);
  }
  return cl.finish();
}

/**
 * The centreline radii a bore is cut at, innermost first.
 *
 * A helix at radius R sweeps the annulus [R − toolR, R + toolR], so starting at
 * `preDrilled/2 + toolR` puts the cutter's inner edge exactly on the existing
 * hole wall — and with no pre-drilled hole that start is `toolR`, whose inner
 * edge is the centre. Either way nothing is left behind in the middle, which is
 * the failure a single finish-radius helix has when it is pointed at solid
 * stock: a perfect ring and an untouched core.
 */
export function boreRadii({ finalR, startR, step }) {
  if (!(finalR > 1e-6)) return [];
  const radii = [];
  for (let R = Math.min(startR, finalR); R < finalR - 1e-6; R += Math.max(step, 1e-3)) {
    radii.push(R);
  }
  radii.push(finalR);
  return radii;
}

/**
 * Chords per revolution that keep a circle of `radius` within `tolerance`.
 *
 * Chorded at *half* the tolerance, deliberately. A polyline that spends the
 * whole budget leaves the post's arc fitter nothing to work with: replacing
 * those chords with the true arc moves the path by exactly the tolerance, which
 * is more than the fitter is allowed to add, so it refuses — and a bore, the one
 * shape in here that is a circle by definition, posts as three thousand G1
 * blocks. Half the budget each and both halves fit.
 */
export function circleSegments(radius, tolerance = 0.01) {
  if (!(radius > 1e-6)) return 0;
  const sagitta = Math.min(Math.max(tolerance / 2, 1e-4), radius * 0.5);
  const stepAngle = 2 * Math.acos(1 - sagitta / radius);
  return Math.max(12, Math.min(720, Math.ceil((2 * Math.PI) / stepAngle)));
}

/**
 * One helical pass: in at the top, down at `pitch` per revolution, then a full
 * lap at depth.
 *
 * The lap matters twice over. It finishes the floor the helix only spiralled
 * across, and it is the spring pass that takes the wall round — a helix alone
 * leaves the wall a shallow screw thread of exactly the pitch it descended at.
 */
export function helixBore(cl, {
  cx, cy, radius, zTop, zBottom, pitch, ccw = true, tolerance = 0.01,
  clearanceZ, feedPlane = null,
}) {
  const segs = circleSegments(radius, tolerance);
  if (segs === 0 || !(zTop > zBottom)) return false;
  const dir = ccw ? 1 : -1;
  const at = (i, z, feed) => {
    const a = (dir * 2 * Math.PI * i) / segs;
    cl.cut(cx + radius * Math.cos(a), cy + radius * Math.sin(a), z, feed);
  };

  approach(cl, cx + radius, cy, zTop, { clearance: clearanceZ, feedPlane });

  const dz = pitch / segs;
  let i = 0;
  let z = zTop;
  // a hard cap, so a pitch typed as 0.001 into a 50mm bore cannot spin here
  // long enough to look like a hang
  const maxSteps = segs * 5000;
  while (z > zBottom + 1e-9 && i < maxSteps) {
    i++;
    z = Math.max(zBottom, zTop - dz * i);
    at(i, z, FEED.RAMP);
  }
  for (let k = 1; k <= segs; k++) at(i + k, zBottom, FEED.CUT);
  cl.rapid(...lastXY(cl), clearanceZ);
  return true;
}

/** Say which of the two ways "no bores" happened, and with what numbers. */
function reasonForNothing({ found, fits, wanted, matchTol, tool }) {
  if (fits.length === 0) {
    return `every hole on this part is ⌀${(Math.max(...found.map((h) => h.r)) * 2).toFixed(2)} or `
      + `smaller and the cutter is ⌀${tool.diameter} — a bore needs room to move inside the hole`;
  }
  return `no hole matches ⌀${wanted}±${matchTol} — this cutter fits ${describeSizes(fits)}`;
}

function describeSizes(holes) {
  const counts = new Map();
  for (const h of holes) {
    const key = (h.r * 2).toFixed(2);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([d, n]) => `⌀${d}${n > 1 ? ` ×${n}` : ''}`)
    .join(', ');
}
