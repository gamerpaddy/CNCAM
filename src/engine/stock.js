// Raw stock for a setup: the billet the part is cut from.
//
// Four kinds, all reduced to { kind, min, max, cylinder? } so strategies only
// ever ask for the bounding box and the footprint outline:
//   box-margin  — auto box around the models with a per-axis margin
//   box         — explicit dimensions, positioned by its own min corner
//   cylinder    — round bar/disc, for lathe work and round billets
//   tube        — hollow bar. The same cylinder with a hole down the middle,
//                 which is what most turned parts over about 40mm actually come
//                 out of: nobody buys solid bar to bore most of it away.
//
// Round stock carries a `cylinder` block whatever its kind, with `innerDiameter`
// zero on solid bar — so every reader downstream handles a tube by doing
// nothing, rather than by learning about a fourth case.

import { computeBounds, flatLevels } from '../geom/mesh.js';

export const STOCK_KINDS = ['box-margin', 'box', 'cylinder', 'tube'];

export const STOCK_KIND_LABELS = {
  'box-margin': 'Box around model (margin)',
  box: 'Box (explicit size)',
  cylinder: 'Round bar (solid)',
  tube: 'Round tube (hollow bar)',
};

/** The kinds that are round, which is what a lathe can hold. */
export const ROUND_STOCK_KINDS = ['cylinder', 'tube'];

export function isRoundStock(stock) {
  return !!stock && ROUND_STOCK_KINDS.includes(stock.kind);
}

export function createStock(kind = 'box-margin') {
  return {
    kind,
    margin: [1, 1, 1],       // box-margin: X/Y all around, Z on top
    marginBottom: 0,         // box-margin: extra material under the model
    // box: the billet you actually have, as the size you bought it in plus
    // where the part sits inside it. See `resolveBox` for why it is not a pair
    // of absolute corners any more.
    box: null,               // { size: [w, d, h], align, offset: [x, y, z] }
    // cylinder and tube share one block; a tube is the one with a bore in it
    cylinder: null,          // { diameter, innerDiameter, height, align, offset }
  };
}

/** How a billet is registered against the part inside it. */
export const STOCK_ALIGNMENTS = ['center', 'min', 'max'];

export const STOCK_ALIGN_LABELS = {
  center: 'Centred on the part',
  min: 'Part at the X−Y− corner',
  max: 'Part at the X+Y+ corner',
};

/**
 * A billet of a given size, placed against the part.
 *
 * Stock used to be stored as two absolute corners, which is how the *code*
 * wants it and the worst possible way to ask a human for it: a model authored
 * at (-250, -540) produced fields reading "X min -250.4, X max -171.2", six
 * numbers with no relation to anything you could measure with a rule. You do
 * not buy stock by its coordinates. You buy 80 × 80 × 30 and put the part
 * somewhere in it.
 *
 * So a box is a size and an alignment, and the corners are derived. The Z axis
 * aligns to the top by default rather than the centre, because stock is
 * referenced off the face you skim first.
 */
function resolveBox(meshes, spec) {
  const size = spec.size ?? [100, 100, 25];
  const offset = spec.offset ?? [0, 0, 0];
  const align = spec.align ?? 'center';
  const b = modelBounds(meshes);

  // with no model to register against, the billet sits on the origin
  const partMin = b ? b.min : [0, 0, -size[2]];
  const partMax = b ? b.max : [0, 0, 0];

  const min = [0, 0, 0];
  for (let k = 0; k < 2; k++) {
    if (align === 'min') min[k] = partMin[k];
    else if (align === 'max') min[k] = partMax[k] - size[k];
    else min[k] = (partMin[k] + partMax[k]) / 2 - size[k] / 2;
    min[k] += offset[k];
  }
  // Z: the top of the billet meets the top of the part, so the stock grows
  // downward — the usual case, where you face the top and work down
  min[2] = partMax[2] - size[2] + offset[2];

  return {
    min,
    max: [min[0] + size[0], min[1] + size[1], min[2] + size[2]],
  };
}

/** Facing allowance on the free end of a bar, in mm. */
const FACE_ALLOWANCE = 1;

/**
 * How much bar to leave sticking into the chuck.
 *
 * Not decoration. A bar exactly as long as the part has nowhere to be held: the
 * jaws close on the finished diameter, every turning pass stops at them because
 * that is where the tool would hit, and parting off is impossible because the
 * plane that sets the length is inside the chuck. That is a project that opens
 * with five operations warning at you, and the cause is not any of them — it is
 * that nobody ever cuts a part out of a bar its own length.
 */
export function chuckingAllowanceFor(diameter) {
  return Math.round(Math.max(15, Math.min(40, diameter * 0.75)));
}

/**
 * The smallest bar the part fits in, for a round setup that has not been sized.
 *
 * Measured as the part's *swung* diameter about the Z axis rather than as its
 * bounding box: a shaft modelled on the axis is a ⌀30 bar, and its bounding box
 * is 30 × 30 only by coincidence — on anything with a flat milled on it, or
 * modelled off-centre, the box is the wrong answer and the swing is the right
 * one. A millimetre on the diameter, because bar is never quite round and never
 * quite the size it says.
 *
 * Longer than the part at both ends, and for different reasons: a millimetre
 * proud of the free end so there is something to face, and a chucking allowance
 * behind it so there is something to hold.
 */
export function deriveCylinder(meshes) {
  return autoCylinder(meshes);
}

function autoCylinder(meshes) {
  // a project restored without its geometry has models and no meshes; sizing
  // stock off nothing is not an error, it is simply not yet possible
  const real = meshes.filter((m) => m?.positions?.length > 0);
  if (real.length === 0) return null;
  let maxR = 0;
  for (const mesh of real) {
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const r = Math.hypot(p[i], p[i + 1]);
      if (r > maxR) maxR = r;
    }
  }
  const b = modelBounds(real);
  const diameter = Math.round((maxR * 2 + 1) * 1000) / 1000;
  const chucking = chuckingAllowanceFor(diameter);
  return {
    diameter,
    innerDiameter: 0,
    height: Math.round((b.max[2] - b.min[2] + FACE_ALLOWANCE + chucking) * 1000) / 1000,
    align: 'center',
    // Z aligns the top of the stock to the top of the part (see resolveBox), so
    // shifting up by the facing allowance leaves that much proud of the free
    // end and the whole of the chucking allowance behind the part
    offset: [0, 0, FACE_ALLOWANCE],
  };
}

function modelBounds(meshes) {
  if (meshes.length === 0) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    const b = computeBounds(mesh.positions);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  }
  return { min, max };
}

/**
 * @param meshes array of { positions } for the setup's models
 * @param stockDef setup.stock
 * @returns { kind, min: [x,y,z], max: [x,y,z], cylinder? } or null
 */
export function computeStock(meshes, stockDef, mode = 'mill') {
  if (!stockDef) return null;

  if (stockDef.kind === 'box' && stockDef.box) {
    const { min, max } = resolveBox(meshes, stockDef.box);
    return { kind: 'box', min, max };
  }

  if (ROUND_STOCK_KINDS.includes(stockDef.kind)) {
    // A setup that says "round bar" and has not been given a size yet still
    // means round bar. Falling through to the box below made a lathe setup draw
    // a rectangular billet, plan against a rectangular billet, and only become
    // round once the user happened to edit a field — the declared kind and the
    // resolved kind disagreed, and the viewport showed the wrong one.
    const spec = stockDef.cylinder ?? autoCylinder(meshes);
    if (!spec) return null;
    const { diameter, height } = spec;
    // a bore can never be as big as the bar it is in; a tube with no wall is a
    // set of numbers, not a piece of material
    const innerDiameter = stockDef.kind === 'tube'
      ? Math.max(0, Math.min(spec.innerDiameter ?? 0, diameter - 0.01))
      : 0;
    // A round bar is registered the same way a box is: by size against the
    // part — except across the axis on a lathe, where it is not registered
    // against the part at all. A chuck holds bar on the spindle centreline, so
    // the part is concentric with it by construction and there is no XY
    // decision to make. The panel already refuses to offer Shift X/Y here for
    // that reason; "Part sits" was the same offer in one field, and taking it
    // moved the bar off centre by half the difference in diameter. Measured: a
    // ⌀30 shaft in a ⌀32 bar came out 1mm off axis, and every turning strategy
    // then read a profile 1mm oversize on one side — roughing aimed at ⌀19.43
    // where the part is ⌀16, and a groove to ⌀15.06 on a ⌀16 journal.
    const onAxis = mode === 'turn';
    const { min, max } = resolveBox(meshes, {
      size: [diameter, diameter, height],
      align: onAxis ? 'center' : (spec.align ?? 'center'),
      offset: onAxis
        ? [0, 0, spec.offset?.[2] ?? 0]
        : (spec.offset ?? [0, 0, 0]),
    });
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
    return {
      kind: stockDef.kind,
      min,
      max,
      cylinder: { diameter, innerDiameter, height, center, baseZ: min[2] },
    };
  }

  // box-margin (also the fallback when an explicit shape has not been filled in)
  const b = modelBounds(meshes);
  if (!b) return null;
  const m = stockDef.margin ?? [0, 0, 0];
  const below = stockDef.marginBottom ?? 0;
  return {
    kind: 'box-margin',
    min: [b.min[0] - m[0], b.min[1] - m[1], b.min[2] - below],
    max: [b.max[0] + m[0], b.max[1] + m[1], b.max[2] + m[2]],
  };
}

/**
 * Stock footprint in XY as closed loops, grown by `grow` mm (pass the tool
 * radius to get the region a cutter centre may occupy while still clearing the
 * billet edge).
 *
 * A tube's bore comes back as a hole in that footprint, wound the other way.
 * Nothing inside it is material — which is what the panel's own field says the
 * bore is for — and the milling strategies read this function to find out where
 * the stock is, so leaving it out had them rough back and forth across the hole
 * cutting air. The hole shrinks by `grow` for the same reason the rim grows by
 * it: the cutter may hang that far over an edge, inner or outer, and a bore no
 * wider than the cutter is not an edge it can hang over at all.
 */
export function stockOutline(stock, grow = 0, segments = 96) {
  if (isRoundStock(stock) && stock.cylinder) {
    const { center, diameter, innerDiameter = 0 } = stock.cylinder;
    // outer loop counter-clockwise, the hole clockwise — the winding is what
    // says which one is the hole (see geom/clipper.js)
    const ring = (radius, clockwise) => {
      const loop = new Array(segments * 2);
      for (let i = 0; i < segments; i++) {
        const a = ((clockwise ? -i : i) / segments) * Math.PI * 2;
        loop[i * 2] = center[0] + radius * Math.cos(a);
        loop[i * 2 + 1] = center[1] + radius * Math.sin(a);
      }
      return loop;
    };
    const loops = [ring(diameter / 2 + grow, false)];
    const boreRadius = innerDiameter / 2 - grow;
    if (innerDiameter > 0 && boreRadius > 1e-6) loops.push(ring(boreRadius, true));
    return loops;
  }
  const [x0, y0] = stock.min;
  const [x1, y1] = stock.max;
  return [[
    x0 - grow, y0 - grow,
    x1 + grow, y0 - grow,
    x1 + grow, y1 + grow,
    x0 - grow, y1 + grow,
  ]];
}

/**
 * Depth pass sequence: topZ (exclusive) down to bottomZ (always included last).
 *
 * The stepdown is a *limit*, not a quantum. Stepping down by exactly it and
 * taking whatever is left over as a final pass is the obvious reading and the
 * wrong one: a 10mm cut at a 3mm stepdown came out as 3, 3, 3 and then 1, and a
 * 9.02mm one as 3, 3, 3 and then 0.02 — a pass that cuts a shaving, at the
 * bottom of the cut, where the tool is at its longest reach. Sharing the depth
 * out evenly instead gives passes that are all *at most* the stepdown and all
 * the same, which is what the number was asking for: 10mm becomes four of 2.5
 * and 9.02 becomes four of 2.255.
 */
export function depthPasses(topZ, bottomZ, stepdown, options = {}) {
  const depths = [];
  if (!(stepdown > 0) || bottomZ >= topZ) return [bottomZ];
  const total = topZ - bottomZ;
  // the tolerance keeps a depth that is an exact multiple of the stepdown from
  // rounding up to one more pass than it needs
  const passes = Math.max(1, Math.ceil(total / stepdown - 1e-9));
  const step = total / passes;
  for (let i = 1; i < passes; i++) depths.push(topZ - step * i);
  depths.push(bottomZ);
  return withFlatLevels(depths, topZ, stepdown, options);
}

/** Below this share of the stepdown, an extra level is not worth a whole pass. */
export const DEFAULT_FLAT_GAP = 0.2;

/**
 * How far apart two horizontal faces have to be before they are two floors.
 *
 * Closer than this and they are one face: a shallow slope the tessellator wrote
 * as steps, a fillet's last row, two halves of a surface that met a hair out.
 * An absolute, because that is what the claim is about — the part — and the
 * depth of cut the operation happens to be taking says nothing about it.
 */
export const FLAT_MERGE = 0.1;

/**
 * The depth levels for a clearing pass over `mesh` — the one place the three
 * clearing strategies ask the question, so they cannot answer it differently.
 *
 * `flatPasses: false` turns the extra levels off and gives back exactly the
 * even sharing-out; it is a switch because a roughing pass that is followed by
 * a floor-finishing operation does not need them, and because a level added to
 * a part with a great many faces is a pass the user may not want.
 */
export function depthLevelsFor(params, mesh, tool = null) {
  const on = params.flatPasses !== false;
  const radius = tool?.diameter > 0 ? tool.diameter / 2 : 0;
  return depthPasses(params.topZ, params.bottomZ, params.stepdown, {
    flats: on && mesh ? flatLevels(mesh) : null,
    flatGap: (params.flatPassGap ?? DEFAULT_FLAT_GAP * 100) / 100,
    // …and what the pass says it leaves everywhere else, which is a second and
    // stricter answer to the same question. `flatGap` is a share of the
    // stepdown, and adaptive's stepdown is two diameters: 20% of it is 4.8mm,
    // so a floor 3mm under a pass counted as cleared and the finishing cutter
    // sized for 0.3mm met ten times that.
    leaves: Math.max(0, params.stockToLeave ?? 0),
    // a floor the cutter does not fit on is not a floor it can be given a pass
    // for — the pass would find nowhere legal to put the tool centre and emit
    // nothing, which is a level's worth of nothing on every part with a fillet
    minFlatArea: Math.PI * radius * radius,
  });
}

/**
 * Add a pass at each of the part's flat faces.
 *
 * Sharing the depth out evenly is right about the *depth* and blind to the
 * *part*. A floor sitting between two levels is cleared down to the level above
 * it — and then the pass below cannot reach it, because at that depth the floor
 * is solid part and the silhouette walls the cutter out. The stock in between
 * stands on a finished surface and no pass in the operation ever takes it off:
 * "there is 2mm left and the stepdown is 5mm, so it gets ignored".
 *
 * Adding a level can only make passes shallower — the levels either side of the
 * new one are unmoved — so nothing here can produce a pass deeper than the
 * stepdown. What it can produce is *too many*, which is what the gap is for.
 *
 * Which levels *can* do that for a flat is the whole of it, and only the ones
 * at or above it can: at any depth below the flat, the flat is solid part and
 * the silhouette walls the cutter out, so the pass finds nowhere legal to put
 * the tool over it and takes nothing off. A level half a millimetre *under* a
 * floor is not a pass that clears it, and treating it as one leaves the whole
 * step standing — 3mm on a 0.3mm allowance, silently, on the commonest shape
 * there is. Nor is `topZ`: that is where the cut starts, not a pass.
 *
 * @param flats [{ z, area }] from geom/mesh.js flatLevels — or plain numbers
 * @param flatGap how far *above* a flat the nearest pass may sit before the
 *   flat is worth a pass of its own, as a fraction of the stepdown — which is
 *   also how much stock that pass may leave standing on it. A part machined
 *   from a stepped casting has a face every millimetre, and a level for each is
 *   a program of shavings; at 0.2, a run of faces within a fifth of the stepdown
 *   of the pass put in for the shallowest of them is left to that pass. Asked of
 *   the faces, not of every level — see the loop below.
 * @param leaves the operation's stock allowance, and the whole of what may be
 *   left standing on a floor: that number is what the next cutter was sized for.
 *   Zero is the strictest instruction there is and means the floor is cut to
 *   size, not that no instruction was given.
 * @param minFlatArea mm² a flat must cover to count. Where two surfaces meet at
 *   a shallow angle the tessellation leaves horizontal slivers, and a level for
 *   one of those is a pass over a face that is not there. Defaults to nothing,
 *   so callers that have not measured the cutter still get every real flat.
 */
export function withFlatLevels(depths, topZ, stepdown, {
  flats = null, flatGap = DEFAULT_FLAT_GAP, minFlatArea = 0, leaves = 0,
} = {}) {
  if (!flats || flats.length === 0 || !(stepdown > 0)) return depths;
  // Two questions, and they are not the same one. `leaves` is how much may be
  // left standing on a floor — a promise about the part, made to whichever
  // cutter comes next. `flatGap` is whether an extra pass is worth having — a
  // preference about the program, in the only unit a pass has, a share of the
  // stepdown.
  //
  // Reading a zero allowance as "no promise was made" made the first of them
  // vanish exactly where it matters most. Asking for 0.3mm bounded the floor at
  // 0.3mm; asking for **none** handed the question to the gap, which on
  // adaptive is a fifth of two tool diameters — so the same pocket floor was
  // left with 2.00mm on it, silently, and the cutter that came next was sized
  // for nothing at all. A tighter allowance must never leave more stock behind
  // than a looser one, and at the tightest of all the floor is cut to size.
  const gap = Math.max(1e-4, stepdown * Math.max(0, flatGap));
  const tol = Math.max(1e-4, Math.min(gap, leaves));
  const bottomZ = depths[depths.length - 1];
  const levels = [...depths];
  const added = [];

  // How close two faces have to be before they are one face rather than two
  // floors — `FLAT_MERGE`, and nothing else. Not a share of the stepdown: a run
  // of faces a tenth of a millimetre apart is a slope somebody tessellated,
  // whatever depth of cut the operation is taking, and a fifth of adaptive's
  // two-diameter stepdown calls two real steps 3mm apart the same face. Not the
  // allowance either: scaling it with what is being left means asking for more
  // allowance merges more faces, and the stock standing on the lowest of them
  // then grows faster than the number asked for.

  // Shallowest first. Within a run of faces too close together to each deserve
  // a pass, the one that keeps its level is the *highest*: a level there sits
  // above all the others and so clears them too, to within the gap. A level at
  // the deepest of them — which is what "the one holding the most stock above
  // it" argues for — is below every other face in the run and clears none of
  // them, because at any depth below a floor the floor is solid part and the
  // silhouette walls the cutter out.
  //
  // The two ends of the cut are not flats to machine: at `topZ` there is
  // nothing above to take off, and `bottomZ` is already a pass.
  const wanted = flats
    .map((f) => (typeof f === 'number' ? { z: f, area: Infinity } : f))
    .filter((f) => f.area >= minFlatArea)
    .filter((f) => f.z > bottomZ + 1e-3 && f.z < topZ - 1e-3)
    .sort((p, q) => q.z - p.z);

  // The run of faces being treated as one, as the last of them and the level
  // that was put in for it. Broken by the first face that is a real step down.
  let run = null;
  for (const flat of wanted) {
    // Part of the run above it — near enough to the face before it to be the
    // same face, and still close enough under that run's pass to be worth
    // leaving to it. This is where `flatGap` does its work, and it is asked of
    // the *faces*: a level that landed near a real floor by arithmetic is not a
    // reason to leave that floor standing, which is what handing this question
    // to every level did.
    if (run && run.last - flat.z <= FLAT_MERGE + 1e-6 && run.z - flat.z <= gap + 1e-6) {
      run.last = flat.z;
      continue;
    }
    // Served by a pass sitting on the flat or close enough above it — where
    // "close enough" is the allowance, because that is what the floor is
    // allowed to be left with.
    const served = levels.some((z) => z > flat.z - 1e-6 && z - flat.z <= tol + 1e-6);
    run = null;
    if (served) continue;
    // The pass goes at the flat *plus the allowance*, not on the flat itself.
    // A roughing pass that cuts a floor to size has left the finishing pass
    // nothing to do there and taken the last cut on that surface with the
    // roughing cutter — which is the one decision `stockToLeave` exists to
    // prevent. The walls have been getting the allowance all along; the floors
    // were getting the part.
    const z = Math.min(flat.z + leaves, topZ - 1e-3);
    if (z <= bottomZ + 1e-6) continue;
    levels.push(z);
    added.push(z);
    run = { last: flat.z, z };
  }
  if (added.length === 0) return depths;
  return [...depths, ...added].sort((a, b) => b - a);
}
