// Sensible starting parameters for a new operation.
//
// Every operation used to be born with one set of numbers — a 2mm stepdown, a
// 0.5×D stepover, top at the stock top and bottom at the bottom of the part —
// whatever strategy it was. That is roughly right for roughing and wrong for
// everything else, in ways that look like bugs rather than settings:
//
//   Facing inherited "bottom = bottom of the part", so a face on a 30mm billet
//   rastered the whole 30mm away instead of skimming the 1mm of margin on top.
//   Finishing inherited a roughing stepover, so a 3D finish pass ran at half the
//   cutter's width and came out visibly stepped — the operation was doing
//   exactly what it was told, and what it was told was a roughing pass.
//   Adaptive inherited a 2mm stepdown, which throws away the whole reason to
//   run it: a light radial bite is what buys deep, fast passes.
//
// So defaults are per strategy, and the ones that scale with the cutter are
// expressed as multiples of its diameter and resolved when the tool is known.
// Heights come from the stock and the model rather than from constants, so a
// new operation is already pointed at the material.

/**
 * Strategy-specific parameter defaults.
 *
 * `stepdownD` is a multiple of the tool diameter, resolved against the assigned
 * tool; `stepdown` (mm) wins where a strategy wants an absolute number — a
 * waterline's Z spacing is a cusp-height decision, not a cutter-width one.
 */
export const STRATEGY_DEFAULTS = {
  face: {
    stepdownD: 0.25,
    stepover: 0.6,          // a face mill overlaps generously; it is a finish
    stockToLeave: 0,        // the point of a face is a surface, not an allowance
    pattern: 'zigzag',
    depth: 'skim',          // down to the top of the part, not through it
  },
  contour2d: {
    stepdownD: 0.5,
    contourOutline: 'part',
    direction: 'climb',
    rampAngle: 3,
    leadType: 'arc',
    leadRadius: 2,
    depth: 'stock',         // profile the whole billet, top to bottom
  },
  pocket: {
    stepdownD: 0.5,
    stepover: 0.4,
    rampAngle: 3,
    leadType: 'arc',
    depth: 'stock',
  },
  slot: {
    // A slot is a full-width cut on every side of the cutter at once, which is
    // the heaviest thing it ever does — so the depth per pass is half what a
    // contour would take and the entry is always a ramp.
    stepdownD: 0.25,
    stepover: 0.4,
    slotWidth: 0,           // 0 is the cutter's own width
    rampAngle: 3,
    direction: 'climb',
    stockToLeave: 0,
    depth: 'stock',
  },
  clear2d: {
    stepdownD: 0.5,
    stepover: 0.5,
    stockToLeave: 0.3,      // roughing leaves something for the finish pass
    rampAngle: 3,
    depth: 'stock',
  },
  adaptive: {
    // the trade the strategy exists to make: a narrow radial bite, taken deep
    stepdownD: 2,
    engagement: 0.15,
    stockToLeave: 0.3,
    rampAngle: 2,
    depth: 'stock',
  },
  drill: {
    depthMode: 'hole',      // each hole to its own floor
    peck: 0,
    depth: 'through',
  },
  bore: {
    // helix pitch per revolution — shallow, because the whole cut is the entry
    stepdownD: 0.15,
    stepover: 0.4,
    stockToLeave: 0.15,     // a bore is a size, so it gets a finishing pass
    finishPasses: 1,
    depthMode: 'hole',
    direction: 'climb',
  },
  chamfer: {
    chamferWidth: 0.5,
    chamferClearance: 0.3,
    chamferPasses: 1,
    chamferEdges: 'all',
    direction: 'climb',
    // No lead, and not as a timidity. A chamfer pass runs on the *edge* — the
    // path is offset so the cone touches the corner and takes a fixed width off
    // it. A lead-in swings the cutter off that path into clear air before it
    // starts, which on a cone means it arrives at a different height on the
    // taper and cuts a chamfer that widens into the start of every pass. On a
    // profile it also puts the tool outside the part outline, where the material
    // it is breaking the edge of has already gone. Straight on, straight off.
    leadType: 'none',
    leadRadius: 2,
    stockToLeave: 0,
    depth: 'edge',          // the edge is the top of the part, not of the stock
  },
  engrave: {
    stepdown: 0.3,          // absolute: a mark is thousandths, not tool widths
    side: 'on',             // the line is the feature; compensating moves it
    engraveLines: 'all',
    direction: 'climb',
    engraveMode: 'depth',
    engraveDepth: 0.3,
    engraveFollow: true,
    rampAngle: 0,
    leadType: 'none',
    stockToLeave: 0,
    depth: 'mark',
  },
  parallel3d: {
    stepover: 0.08,         // finishing: cusp height, not material removal
    tolerance: 0.01,
    pattern: 'zigzag',
    stockToLeave: 0,
    // How far the tool may drive across a break in the surface rather than
    // retract out of it. Null means "three tool diameters", which is the width
    // of the gaps a raster actually keeps meeting — a bore it passes either
    // side of, the step at a shoulder — rather than a number to be typed.
    linkDistance: null,
  },
  // Turning. The heights mean the two ends of the cut *along the bar*: Top Z is
  // the free end where a pass starts, Bottom Z how far along it goes. Depth of
  // cut is radial, so `stepdown` is a radius step rather than a Z one.
  turnFace: {
    stepdown: 0.5,          // Z per facing pass
    depth: 'bar-end',
  },
  turnRough: {
    stepdown: 1.5,          // radial depth of cut
    stockToLeave: 0.3,
    depth: 'bar',
  },
  turnFinish: {
    // No stepdown: a finish pass is one pass down the profile. What decides how
    // finely it is written is the tolerance — see generateTurnFinish.
    stockToLeave: 0,
    tolerance: 0.05,
    depth: 'bar',
  },
  turnGroove: {
    // the two heights are the groove's shoulders, so they start one blade apart
    peck: 0.5,
    stockToLeave: 0,
    depth: 'bar-groove',
  },
  turnThread: {
    threadPitch: 1.5,
    threadPasses: 6,
    threadDepth: 0,
    threadFace: 'auto',
    threadHand: 'right',
    // 2 is equal chip area per pass. The first bite is the one that decides
    // whether the schedule looks gradual or not, so it is capped and the pass
    // count grows to suit — see threadInfeed.
    threadDegression: 2,
    threadFirstDepth: 0.25,
    threadSpringPasses: 1,
    // Threading is the one operation that must not inherit the tool's speed.
    // The carriage has to stay locked to the spindle for the whole pass and
    // then stop dead at the end of it, so a thread is cut at roughly a third of
    // the rpm the same insert turns at — and a blank field, which every other
    // operation is happy with, silently means "the roughing speed" here.
    spindleFactor: 0.3,
    spindleCap: 600,
    depth: 'bar-thread',
  },
  turnDrill: {
    peck: 3,
    dwell: 0,
    depth: 'bar-hole',
  },
  turnBore: {
    stepdown: 0.8,          // radial depth of cut, working outward
    stockToLeave: 0.2,
    depth: 'bar-hole',
  },
  turnPart: {
    peck: 1,
    depth: 'bar-far',
  },
  waterline: {
    stepdown: 0.25,         // absolute: this is the cusp on a vertical wall
    tolerance: 0.01,
    stockToLeave: 0,
    direction: 'climb',
  },
};

/**
 * How deep a new operation of this type should reach, given where the stock and
 * the part are.
 *
 *   stock   — the whole billet, its top down to its bottom. The bulk-removal
 *             and profiling strategies (contour, pocket, slot, Z-level rough,
 *             adaptive) start here: a contour parts the shape out of the block
 *             and a clearing pass takes the block down, so both want the stock,
 *             not the part. Finishing (parallel3d, waterline) does not — it is
 *             shaping the part's own surface — and stays on the part below.
 *   skim    — the margin on top of the part and no further (facing)
 *   edge    — Top Z is the *edge being broken*, so it sits on the part, not on
 *             the billet above it; Bottom Z is only a floor the pass may not
 *             pass (chamfering)
 *   mark    — a shallow cut into the top face (engraving)
 *   bar     — the whole length of a turned part
 *   bar-end — the free end of the bar (facing)
 *   bar-far — the plane that sets the finished length (parting off)
 *   bar-hole— from the end face inward, for anything working down the axis
 *   bar-groove — a short window near the free end; a groove is a width, and
 *             defaulting it to the whole part is a groove nobody wants
 *   bar-thread — the last third of the part, where a thread usually goes
 *   through — the full depth of the part (everything else)
 *
 * Facing is the one that matters: taking a facing op to the bottom of the model
 * is not a conservative default, it is a 30mm-deep raster.
 */
export function depthRangeFor(type, { stock, modelBounds, boreBottomZ = null }) {
  const top = stock.max[2];
  const spec = STRATEGY_DEFAULTS[type] ?? {};
  const partTop = modelBounds ? modelBounds.max[2] : top;
  const partBottom = modelBounds ? modelBounds.min[2] : stock.min[2];

  // Bulk removal and profiling span the whole billet: the top of the stock down
  // to the bottom of it, not the bottom of the part. Defaulting to the part
  // bottom leaves the ring of material between the part and the billet wall
  // standing, so a profile that should have parted the shape out, or a clearing
  // pass that should have taken the block down, stops short with nothing on
  // screen to say why.
  if (spec.depth === 'stock') return { topZ: top, bottomZ: stock.min[2] };
  if (spec.depth === 'skim') {
    // stop at the top of the part; if the stock has no margin there is nothing
    // to face, so leave a token pass rather than a zero-height one the user
    // cannot see or drag
    return { topZ: top, bottomZ: partTop < top - 1e-6 ? partTop : top - 0.5 };
  }
  if (spec.depth === 'edge') return { topZ: partTop, bottomZ: partBottom };
  // Engraving: Top Z is the face, and Bottom Z is only a floor the mark may not
  // pass. It is set well clear of any mark rather than snug against the default
  // depth — a limit that refuses the moment somebody deepens the mark by a
  // tenth is a limit that reads as a bug. The depth itself is `engraveDepth`.
  if (spec.depth === 'mark') return { topZ: partTop, bottomZ: round(partTop - 5) };
  // Turning: Z runs along the bar, so a pass starts at the free end (the
  // largest Z) and works toward the chuck. 'bar' covers the whole part;
  // 'bar-end' is the end face, where facing and parting happen.
  if (spec.depth === 'bar') return { topZ: partTop, bottomZ: partBottom };
  // facing works on the free end of the bar: from where the stock ends back to
  // where the part starts
  if (spec.depth === 'bar-end') return { topZ: top, bottomZ: partTop };
  // parting happens at the *other* end — the plane that gives the part its
  // finished length. Defaulting it to the free end parts off nothing at all.
  if (spec.depth === 'bar-far') return { topZ: top, bottomZ: partBottom };
  // Anything working down the axis starts at the end face and goes in — as far
  // as the part's own hole goes, where the part has one. A centre drill opens
  // the hole that is on the drawing and a boring bar sizes it; neither has any
  // business past the bottom of it. The share of the length below is only for a
  // solid bar, where there is nothing to read: it used to be the answer for
  // every part, and on the test shaft (bore 37mm in) it was born 55mm deep.
  if (spec.depth === 'bar-hole') {
    return {
      topZ: partTop,
      bottomZ: round(boreBottomZ != null && boreBottomZ < partTop - 1e-6
        ? boreBottomZ
        : partTop - (partTop - partBottom) * 0.6),
    };
  }
  // A groove is a width, not a length of bar. Two millimetres in from the end
  // is somewhere you can see it and drag it, which beats a groove the length of
  // the part that has to be corrected before it means anything.
  if (spec.depth === 'bar-groove') {
    const span = Math.max(0.5, Math.min(3, (partTop - partBottom) * 0.1));
    return { topZ: round(partTop - 2), bottomZ: round(partTop - 2 - span) };
  }
  if (spec.depth === 'bar-thread') {
    return {
      topZ: partTop,
      bottomZ: round(partTop - Math.max(2, (partTop - partBottom) * 0.35)),
    };
  }
  return { topZ: top, bottomZ: partBottom };
}

/**
 * Does Top Z / Bottom Z mean something different on these two strategies?
 *
 * Retyping keeps the heights, because they are a decision about this cut rather
 * than about the strategy — but only while both strategies read them the same
 * way. Facing measures the margin above the part, a chamfer's Top Z is an edge,
 * an engrave's is a surface, and everything else takes the pair as the top and
 * bottom of a cut. Across those boundaries the numbers have to be re-derived or
 * the new operation starts out aimed at the wrong plane.
 */
export function depthMeaningDiffers(fromType, toType) {
  const meaning = (t) => STRATEGY_DEFAULTS[t]?.depth ?? 'through';
  return meaning(fromType) !== meaning(toType);
}

/**
 * A complete params patch for a new (or retyped) operation.
 *
 * @param type strategy id
 * @param context { stock, modelBounds, tool, boreBottomZ } — any may be missing;
 *   whatever is known is used and the rest is left at the schema default
 * @returns a partial params object to merge over the existing ones
 */
export function defaultParamsFor(type, { stock, modelBounds, tool, boreBottomZ = null } = {}) {
  const spec = { ...(STRATEGY_DEFAULTS[type] ?? {}) };
  // Keys that describe how to *derive* a parameter rather than being one.
  // Left in, they end up on the operation as params nothing reads.
  const { stepdownD, spindleFactor, spindleCap } = spec;
  delete spec.depth;
  delete spec.stepdownD;
  delete spec.spindleFactor;
  delete spec.spindleCap;

  const patch = { ...spec };

  // A speed of the strategy's own, written onto the operation rather than left
  // blank to inherit — see turnThread above for the one case that needs it.
  if (spindleFactor > 0 && tool?.spindleRpm > 0) {
    patch.spindleRpm = Math.max(60,
      Math.round(Math.min(tool.spindleRpm * spindleFactor, spindleCap ?? Infinity)));
  }

  if (patch.stepdown == null) {
    const fromTool = stepdownFor(stepdownD, tool);
    if (fromTool != null) patch.stepdown = fromTool;
  }

  if (stock) {
    const { topZ, bottomZ } = depthRangeFor(type, { stock, modelBounds, boreBottomZ });
    patch.topZ = topZ;
    patch.bottomZ = bottomZ;
    // clearance clears the tallest thing on the table; the feed plane sits just
    // above the material, which is where feeding needs to start and no higher
    patch.clearanceHeight = round(stock.max[2] + 10);
    patch.retractHeight = round(stock.max[2] + 2);
  }
  return patch;
}

/**
 * The depth of cut a strategy's `stepdownD` comes to on this cutter, or null
 * where either of them has nothing to say.
 *
 * One place, because two callers need the same answer: a new operation asking
 * what its stepping should be, and an existing one being handed a different
 * cutter (see `retoolParams`). Stated twice, the second copy is the one that
 * forgets the flute length.
 */
function stepdownFor(stepdownD, tool) {
  const d = tool?.diameter;
  if (stepdownD == null || !(d > 0)) return null;
  // a cutter cannot take a deeper pass than it has flute, whatever the strategy
  // would like
  const flute = tool.fluteLength > 0 ? tool.fluteLength : Infinity;
  return round(Math.min(stepdownD * d, flute * 0.9));
}

/**
 * What changes when an operation is handed a different cutter.
 *
 * Almost nothing does. The heights, the allowances, the regions and the feeds
 * are decisions about *this cut*, and a new tool does not undo any of them. The
 * exception is the handful of numbers that were never absolute in the first
 * place: a strategy states its depth of cut as a multiple of the diameter, and
 * a 3mm stepdown that meant 0.25×D on a ⌀12 means 1.0×D on a ⌀3 — a slot taken
 * at full width by a cutter a quarter of the size, which is the safety default
 * gone without a word. Retyping the *strategy* has always re-derived these;
 * changing the tool did not, and that is the more common edit of the two.
 *
 * A number the user typed is theirs and is kept. "Typed" is decided by asking
 * what the cutter that is being removed would have given: if the operation is
 * still carrying that, nobody has been near it.
 *
 * @returns { patch, kept } — the params to write, and the tool-relative ones
 *   left alone because they no longer match what the old cutter implied
 */
export function retoolParams(type, params, { tool, previousTool = null } = {}) {
  const spec = STRATEGY_DEFAULTS[type] ?? {};
  const patch = {};
  const kept = [];

  const untouched = (key, was) => was == null
    || params[key] == null
    || Math.abs(params[key] - was) < 5e-4;

  const stepdown = stepdownFor(spec.stepdownD, tool);
  if (stepdown != null) {
    if (untouched('stepdown', stepdownFor(spec.stepdownD, previousTool))) {
      patch.stepdown = stepdown;
    } else {
      kept.push('stepdown');
    }
  }

  // A speed the strategy chose from the tool's own — threading's third of the
  // turning speed. Same rule: the new insert's, unless somebody set one.
  if (spec.spindleFactor > 0 && tool?.spindleRpm > 0) {
    const speedOf = (t) => (t?.spindleRpm > 0
      ? Math.max(60, Math.round(Math.min(t.spindleRpm * spec.spindleFactor,
        spec.spindleCap ?? Infinity)))
      : null);
    if (untouched('spindleRpm', speedOf(previousTool))) patch.spindleRpm = speedOf(tool);
    else kept.push('spindle speed');
  }

  return { patch, kept };
}

/**
 * Which params a strategy change may overwrite.
 *
 * Switching an operation from roughing to finishing has to move the stepover,
 * or the "finishing" pass is a roughing pass wearing a different name. But it
 * must not throw away the heights the user dragged into place, the tool they
 * chose, or the feeds they tuned — those are decisions about *this* cut, not
 * about the strategy. So a retype takes the strategy-shaped numbers and leaves
 * the rest alone.
 */
export function retypeParams(type, params, { tool, from = null } = {}) {
  const patch = defaultParamsFor(type, { tool });
  // heights belong to the operation, not the strategy — except facing, whose
  // whole depth range means something different (see depthRangeFor)
  delete patch.topZ;
  delete patch.bottomZ;
  delete patch.clearanceHeight;
  delete patch.retractHeight;
  // A speed the *strategy* chose is not a speed the user chose, so it does not
  // outlive the strategy. Threading writes one on because inheriting a turning
  // speed there is dangerous (see turnThread above); a roughing pass that used
  // to be a thread must not quietly keep running at a third of its own speed.
  if (STRATEGY_DEFAULTS[from]?.spindleFactor && !STRATEGY_DEFAULTS[type]?.spindleFactor) {
    patch.spindleRpm = null;
  }
  return { ...params, ...patch };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
