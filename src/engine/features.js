// What is on the part, and the operations that would make it.
//
// A first program for a part is mostly the same few decisions: face the top, pocket
// what is enclosed, spot and drill the holes (tap the ones that are tapping
// drills), cut the outline. Nothing in them needs judgement until they are
// written down, and typing them in is where the time goes — so this reads the
// part and proposes them, and the user takes or leaves each one.
//
// It recognises from the *triangles*, by slicing, which is what the hole,
// pocket and contour strategies themselves do: a STEP face adds a name to a
// feature and not a different way of finding it, and an STL has no faces at all.
// So whatever is proposed here is something the strategy it names will find too,
// and the proposal is never a feature the generator cannot see.
//
// It does not set a single pick. An operation with no region picks machines
// everything it finds, which is exactly what is wanted — and a pick that went
// stale would be the other way round (see engine/regions.js).

import { computeBounds, flatLevels } from '../geom/mesh.js';
import { sliceMeshZ } from '../geom/slice.js';
import { surfaceProbe } from '../geom/heightmap.js';
import {
  unionLoops, enclosedVoids, offsetLoops, loopArea, loopsBounds,
} from '../geom/clipper.js';
import { findHoles, fitCircle, roomAroundHole } from './strategies/drill.js';
import { tapDrillDiameter } from './strategies/holes.js';

/** Metric coarse threads and the pitch each is tapped at. */
const METRIC = [
  [3, 0.5], [4, 0.7], [5, 0.8], [6, 1], [8, 1.25], [10, 1.5], [12, 1.75],
];
/** A hole this much off a tapping drill is not one. */
const TAP_DRILL_TOLERANCE = 0.1;
/** A spot drill is this much narrower than the way down to the hole, mm. */
const SPOT_CLEARANCE = 0.4;
/** Above this a hole is bored with an end mill, not drilled. */
const BORE_FROM = 16;
/** Sizes an end mill comes in, mm. */
export const MILL_SIZES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20];

const round = (v, step) => Math.round(v / step) * step;
const fmt = (v) => `${Math.round(v * 100) / 100}`.replace(/\.0+$/, '');

/** A closed loop wound counter-clockwise, which is how the offsetter reads material. */
function counterClockwise(loop) {
  if (loopArea(loop) >= 0) return loop;
  const out = new Array(loop.length);
  const n = loop.length / 2;
  for (let i = 0; i < n; i++) {
    out[i * 2] = loop[(n - 1 - i) * 2];
    out[i * 2 + 1] = loop[(n - 1 - i) * 2 + 1];
  }
  return out;
}

/**
 * The widest circle that fits inside a void, found by shrinking it until it is
 * gone. This is what limits the cutter: a pocket is cleared by a tool that fits
 * in its narrowest part, or it is left with what the tool could not reach.
 */
export function inscribedDiameter(loop) {
  const shape = counterClockwise(loop);
  const b = loopsBounds([shape]);
  let hi = Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1]) / 2;
  let lo = 0;
  if (!(hi > 0)) return 0;
  for (let i = 0; i < 14 && hi - lo > 0.02; i++) {
    const mid = (lo + hi) / 2;
    const left = offsetLoops([shape], -mid);
    if (left.length > 0 && left.some((l) => Math.abs(loopArea(l)) > 1e-6)) lo = mid; else hi = mid;
  }
  return 2 * lo;
}

/** Slopes shallower than this are flat and steeper than this are wall; between is a surface to finish. */
const SLOPE_FROM = 2;
const SLOPE_TO = 88;
/** Where a slope is steep enough that waterline finishing beats a raster, degrees from horizontal. */
const STEEP_FROM = 40;
/** Plan area, mm², below which a slope is an edge break and not a surface. */
const SLOPE_MIN_AREA = 4;

/**
 * The sloped surface the part presents to the cutter from above: every triangle
 * that is neither flat nor a wall, and that is not under something else.
 *
 * Neither flat nor wall is the whole definition, which is why the flat floors, the
 * pocket strategy's walls and a drill's bore never count and a ring's bevel, a
 * cone or a dome always do. "Not under something" is asked of the surface itself
 * (the top surface is read at the triangle's centre) and not of its winding, which
 * nothing here trusts: a part that has been mirrored by a setup's orientation has
 * every triangle turned inside out.
 *
 * @returns { plan, shallow, steep, lo, hi, angle } — plan areas in mm², the Z range, and the mean angle
 */
export function slopedSurface(mesh) {
  const { positions, indices } = mesh;
  const probe = surfaceProbe(mesh);
  const count = indices.length / 3;
  const stride = Math.max(1, Math.floor(count / 30000));
  let shallow = 0, steep = 0, angleSum = 0, lo = Infinity, hi = -Infinity;
  for (let t = 0; t < count; t += stride) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-12)) continue;
    const angle = (Math.acos(Math.min(1, Math.abs(nz) / len)) * 180) / Math.PI;
    if (angle < SLOPE_FROM || angle > SLOPE_TO) continue;
    const cx = (positions[a] + positions[b] + positions[c]) / 3;
    const cy = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
    const cz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
    if (Math.abs(probe(cx, cy) - cz) > 0.05) continue;   // under something, or not top surface
    const plan = (Math.abs(nz) / 2) * stride;
    if (angle >= STEEP_FROM) steep += plan; else shallow += plan;
    angleSum += angle * plan;
    lo = Math.min(lo, positions[a + 2], positions[b + 2], positions[c + 2]);
    hi = Math.max(hi, positions[a + 2], positions[b + 2], positions[c + 2]);
  }
  const plan = shallow + steep;
  return { plan, shallow, steep, lo, hi, angle: plan > 0 ? angleSum / plan : 0 };
}

/** Operations that cut a round hole out to size whatever they were asked for, when the cutter is smaller than it. */
const CLEARS_HOLES = ['pocket', 'adaptive', 'clear2d', 'bore'];

/**
 * Whether the setup already does what a proposal would add, as a phrase for the
 * summary, or null.
 *
 * A proposal is the same as an operation when it is the same strategy with the
 * same reach: nothing restricted to picked faces counts, because it does not
 * cover the part. Holes are the case worth the care — a pocket, a clear or an
 * adaptive with a cutter narrower than a hole opens the hole as it clears, so a
 * spot and a drill proposed after one are a pair of cuts into air.
 */
function alreadyDone(p, existing) {
  const open = existing.filter((e) => !e.restricted);
  const same = (types) => open.find((e) => types.includes(e.type));
  const d = p.toolSpec?.diameter ?? p.diameter;
  switch (p.id) {
    case 'face': return same(['face']) && 'a facing operation';
    case 'outline': return same(['contour2d']) && 'an outline operation';
    case 'rough': return same(['adaptive', 'clear2d']) && 'a roughing operation';
    case 'pocket': return same(['pocket']) && 'a pocket operation';
    case 'slope-waterline': return same(['waterline']) && 'a waterline finish';
    case 'slope-parallel': return same(['parallel3d', 'scallop']) && 'a raster finish';
    case 'spot': return same(['spot']) && 'a spot operation';
    default: break;
  }
  if (p.id.startsWith('drill-')) {
    return open.some((e) => e.type === 'drill' && Math.abs((e.toolDiameter ?? -1) - d) <= 0.06) && `a ⌀${fmt(d)} drill`;
  }
  if (p.id.startsWith('bore-')) return same(['bore']) && 'a bore';
  if (p.id.startsWith('tap-')) return open.some((e) => e.type === 'tap') && 'a tap operation';
  return null;
}

/**
 * @param mesh the part, in the setup's own space (what the strategies are given)
 * @param options.stock the setup's resolved stock `{ min, max }`
 * @param options.existing what the setup already does, `[{ type, toolDiameter, restricted }]`
 *   — `restricted` when the operation is limited to picked faces. Whatever is
 *   already done is left out rather than proposed again, and said so.
 * @returns { proposals, summary, warnings } — proposals in running order, each
 *   `{ id, group, label, detail, opType, params, toolSpec, enabled, warnings }`
 */
export function recogniseFeatures(mesh, { stock = null, existing = [] } = {}) {
  const proposals = [];
  const warnings = [];
  if (!mesh?.positions?.length || !mesh.indices?.length) {
    return { proposals, summary: 'There is no part to read.', warnings: ['import a model first'] };
  }
  const bounds = computeBounds(mesh.positions);
  const top = bounds.max[2];
  const bottom = bounds.min[2];
  const height = top - bottom;
  const summary = [];
  const left = [];

  // --- the top: face it when the billet stands above the part --------------
  const skim = stock?.max ? stock.max[2] - top : 0;
  if (skim > 0.05) {
    proposals.push({
      id: 'face',
      group: 'Prepare the stock',
      label: `Face the top (${fmt(skim)} mm of stock above the part)`,
      opType: 'face',
      params: {},
      toolSpec: { family: 'face', maxDiameter: 0, prefer: 'largest' },
      enabled: true,
      warnings: [],
    });
    summary.push('a top to face');
  }

  // --- slopes: a surface a 2D operation cannot make ------------------------
  // Every other operation here is a profile at some depth; a bevel, a cone or a
  // dome is not one, and without a proposal for it the part comes out as the
  // stack of profiles at its widest — faced, drilled, outlined and still a block
  // where the slope should be.
  const slopes = slopedSurface(mesh);
  const hasSlope = slopes.plan >= Math.max(SLOPE_MIN_AREA, 0.005 * (bounds.max[0] - bounds.min[0]) * (bounds.max[1] - bounds.min[1]));
  if (hasSlope && stock?.max) {
    proposals.push({
      id: 'rough',
      group: 'Slopes',
      label: 'Rough the stock down to the part',
      detail: 'the billet over a slope is not a profile: it comes off in steps and the finish cut takes the last 0.3 mm',
      opType: 'adaptive',
      params: {},
      toolSpec: { family: 'flat', maxDiameter: 12, prefer: 'largest', what: 'rough', soft: true },
      enabled: true,
      warnings: [],
    });
  }
  if (hasSlope) {
    const share = (v) => v >= SLOPE_MIN_AREA && v >= 0.2 * slopes.plan;
    const what = (area) => `${fmt(area)} mm² of slope seen from above`;
    const finishers = [];
    if (share(slopes.steep) || !share(slopes.shallow)) {
      finishers.push({
        id: 'slope-waterline', opType: 'waterline', label: 'Finish the steep slopes',
        detail: `${what(slopes.steep)} at 40° or more from flat; a ball nose follows the surface level by level`,
      });
    }
    if (share(slopes.shallow)) {
      finishers.push({
        id: 'slope-parallel', opType: 'parallel3d', label: 'Finish the shallow slopes',
        detail: `${what(slopes.shallow)} under 40° from flat; a ball nose rasters over them`,
      });
    }
    for (const f of finishers) {
      proposals.push({
        group: 'Slopes',
        ...f,
        params: {},
        toolSpec: { family: 'ball', maxDiameter: 6, prefer: 'largest', what: 'finish' },
        enabled: true,
        warnings: [],
      });
    }
    summary.push(`a slope of about ${Math.round(slopes.angle)}°`);
  }

  // --- pockets: the enclosed voids that are not round holes ----------------
  const levels = flatLevels(mesh)
    .filter((l) => l.z < top - 0.25 && l.z > bottom + 0.25 && l.area > 1);
  const pockets = [];
  for (const level of levels) {
    // just above the floor, which is inside the void and never on its wall
    const loops = unionLoops(sliceMeshZ(mesh, level.z + Math.min(0.3, (top - level.z) / 2)));
    for (const loop of enclosedVoids(loops)) {
      if (fitCircle(loop)) continue;                 // a round hole: holes, below
      const area = Math.abs(loopArea(loop));
      if (!(area > 4)) continue;
      // the same pocket is seen at every floor it has: keep the deepest
      const b = loopsBounds([loop]);
      const mid = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
      const twin = pockets.find((p) => Math.hypot(p.mid[0] - mid[0], p.mid[1] - mid[1]) < 1 && Math.abs(p.area - area) < area * 0.1);
      if (twin) { if (level.z < twin.z) twin.z = level.z; continue; }
      pockets.push({ z: level.z, area, loop, mid, bounds: b });
    }
  }
  if (pockets.length) {
    const narrowest = Math.min(...pockets.map((p) => inscribedDiameter(p.loop)));
    const deepest = Math.min(...pockets.map((p) => p.z));
    proposals.push({
      id: 'pocket',
      group: 'Pockets',
      label: `${pockets.length === 1 ? 'Pocket' : `${pockets.length} pockets`}, down to Z${fmt(deepest)}`,
      detail: `the narrowest is ${fmt(narrowest)} mm across`,
      opType: 'pocket',
      params: {},
      toolSpec: { family: 'flat', maxDiameter: narrowest * 0.9, prefer: 'largest', what: 'pocket' },
      enabled: true,
      warnings: narrowest < MILL_SIZES[0]
        ? [`the narrowest pocket is ${fmt(narrowest)} mm across, narrower than any end mill listed`] : [],
    });
    summary.push(`${pockets.length} pocket${pockets.length === 1 ? '' : 's'}`);
  }

  // --- holes: grouped by diameter, and the ones that are tapping drills ----
  // A hole a pocket-type operation of the setup already opens, because its cutter
  // is narrower than the hole, is cut: it is not one to spot and drill.
  const opener = existing.filter((e) => !e.restricted && CLEARS_HOLES.includes(e.type) && e.toolDiameter > 0)
    .reduce((m, e) => Math.min(m, e.toolDiameter), Infinity);
  const allHoles = findHoles(mesh, { topZ: top, bottomZ: bottom, bounds });
  const found = allHoles.filter((h) => !(h.r * 2 > opener * 1.05));
  const opened = allHoles.length - found.length;
  if (opened) left.push(`a pocket or clear that already opens ${opened} hole${opened === 1 ? '' : 's'}`);
  const groups = new Map();
  for (const h of found) {
    const d = round(h.r * 2, 0.05);
    const g = groups.get(d) ?? { diameter: d, holes: [], through: 0, deepest: 0 };
    g.holes.push(h);
    if (h.runsOn || h.bottom <= bottom + 0.05) g.through++;
    g.deepest = Math.max(g.deepest, (h.top ?? top) - Math.max(h.bottom, bottom));
    groups.set(d, g);
  }
  const sizes = [...groups.values()].sort((a, b) => a.diameter - b.diameter);
  // The spot operation takes every hole, whatever its size — spotting is not
  // sized to the hole the way drilling is — so it is offered for all of them.
  if (found.length) {
    const bored = found.filter((h) => round(h.r * 2, 0.05) > BORE_FROM).length;
    // The spot drill has to go down to the highest hole on each centre, through
    // whatever stands round it: a hole in the floor of a 5mm pocket is not spotted
    // by a ⌀6 cutter, whatever it would do to a hole on the top face.
    const reach = new Map();
    for (const h of found) {
      const key = `${round(h.cx, 0.05)},${round(h.cy, 0.05)}`;
      if (!reach.has(key) || h.top > reach.get(key).top) reach.set(key, h);
    }
    let room = Infinity;
    const slices = new Map();
    for (const h of reach.values()) room = Math.min(room, roomAroundHole(mesh, h, top, slices));
    const fits = room === Infinity ? 0 : Math.max(0, room - SPOT_CLEARANCE);
    proposals.push({
      id: 'spot',
      group: 'Holes',
      label: `Spot the ${found.length} hole${found.length === 1 ? '' : 's'}`,
      detail: [
        bored
          ? `so each drill starts where it was told; ${bored === 1 ? 'the large one is' : `${bored} large ones are`} only marked`
          : 'so each drill starts where it was told',
        room < Infinity ? `the narrowest way down to one is ${fmt(room)} mm, so the spot drill is ⌀${fmt(fits)} or under` : null,
      ].filter(Boolean).join('; '),
      opType: 'spot',
      params: {},
      toolSpec: { family: 'spot', prefer: 'any', ...(room < Infinity ? { maxDiameter: fits } : {}) },
      enabled: !(fits < 1 && room < Infinity),   // no spot drill goes down it: offered, not ticked
      warnings: room < Infinity && fits < 1
        ? [`a hole is reached through ${fmt(room)} mm: no spot drill goes down it`] : [],
    });
  }
  for (const g of sizes) {
    const n = g.holes.length;
    const how = g.through === n ? 'through' : g.through === 0 ? 'blind' : 'through and blind';
    const thread = METRIC.find(([m, p]) => Math.abs(tapDrillDiameter(m, p) - g.diameter) <= TAP_DRILL_TOLERANCE);
    if (g.diameter > BORE_FROM) {
      proposals.push({
        id: `bore-${g.diameter}`,
        group: 'Holes',
        label: `Bore ${n} × ⌀${fmt(g.diameter)} (${how})`,
        detail: 'too large to drill; an end mill takes it in a helix',
        opType: 'bore',
        params: { diameterTol: 0.1 },
        toolSpec: { family: 'flat', maxDiameter: g.diameter * 0.6, prefer: 'largest', what: 'bore' },
        enabled: true,
        warnings: [],
      });
    } else {
      proposals.push({
        id: `drill-${g.diameter}`,
        group: 'Holes',
        label: `Drill ${n} × ⌀${fmt(g.diameter)} (${how})`,
        detail: thread ? `⌀${fmt(g.diameter)} is the tapping drill for M${thread[0]}×${thread[1]}` : null,
        opType: 'drill',
        // each op takes only its own size
        params: { diameterTol: 0.06 },
        toolSpec: { family: 'drill', diameter: g.diameter },
        enabled: true,
        warnings: [],
      });
    }
    if (thread && g.diameter <= BORE_FROM) {
      proposals.push({
        id: `tap-M${thread[0]}`,
        group: 'Holes',
        label: `Tap ${n} × M${thread[0]}×${thread[1]}`,
        // A 5mm hole is as likely a 5mm hole as an M6 one. Offered, not assumed.
        detail: 'off until you say they are threaded — a hole this size is also just a hole',
        opType: 'tap',
        params: { diameterTol: 0.3 },
        toolSpec: { family: 'tap', nominal: thread[0], pitch: thread[1] },
        enabled: false,
        warnings: [],
      });
    }
  }
  if (sizes.length) {
    summary.push(`${found.length} hole${found.length === 1 ? '' : 's'} in ${sizes.length} size${sizes.length === 1 ? '' : 's'}`);
  }

  // --- the outline: when there is billet outside the part ------------------
  if (stock?.min && stock?.max) {
    const around = Math.max(
      bounds.min[0] - stock.min[0], stock.max[0] - bounds.max[0],
      bounds.min[1] - stock.min[1], stock.max[1] - bounds.max[1]);
    if (around > 0.05) {
      proposals.push({
        id: 'outline',
        group: 'Profile',
        label: `Cut the outline (${fmt(around)} mm of billet round the part)`,
        detail: 'last: it frees the part',
        opType: 'contour2d',
        params: {},
        toolSpec: { family: 'flat', maxDiameter: 12, prefer: 'largest', what: 'outline' },
        enabled: true,
        warnings: height < 1 ? ['the part is thin: hold it down before this cut'] : [],
      });
      summary.push('an outline to cut');
    }
  }

  // --- what the setup already does -------------------------------------------
  const kept = proposals.filter((p) => {
    const why = alreadyDone(p, existing);
    if (why) left.push(why);
    return !why;
  });
  if (!kept.length && !left.length) warnings.push('nothing here to propose: no top to face, no pockets, no round holes, no billet round it');
  return {
    proposals: kept,
    summary: [
      summary.length ? `Found ${summary.join(', ')}.` : 'Nothing recognised.',
      left.length ? `Left out, because this setup already has ${left.join(', ')}.` : '',
    ].filter(Boolean).join(' '),
    warnings,
  };
}
