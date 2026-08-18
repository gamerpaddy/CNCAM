// Tool library: stock presets plus import/export of a user's own tools.
//
// Presets carry sane starting feeds and speeds for aluminium in a hobby-class
// spindle. They are a starting point to edit, not a recommendation — real
// numbers depend on the machine, the material and the holder, so the values
// here are deliberately conservative.
//
// The exchange format is a plain JSON array of tool records, so a library
// travels between projects and can be hand-edited.

import { uid } from './schema.js';
import { parseInsertCode, isLatheTool, insertIcOf } from '../engine/insert.js';
import { reachCheck, fluteLengthOf } from '../engine/tool-geometry.js';

export const LIBRARY_VERSION = 1;

/** name, type, diameter and the cutting defaults that go with them. */
export const TOOL_PRESETS = [
  {
    group: 'End mills (flat)',
    tools: [
      { name: '3mm flat 2FL', type: 'flat', diameter: 3, flutes: 2, fluteLength: 12, spindleRpm: 16000, feedCut: 500, feedPlunge: 150 },
      { name: '6mm flat 2FL', type: 'flat', diameter: 6, flutes: 2, fluteLength: 20, spindleRpm: 12000, feedCut: 800, feedPlunge: 250 },
      { name: '8mm flat 3FL', type: 'flat', diameter: 8, flutes: 3, fluteLength: 25, spindleRpm: 10000, feedCut: 1000, feedPlunge: 300 },
      { name: '12mm flat 3FL', type: 'flat', diameter: 12, flutes: 3, fluteLength: 35, spindleRpm: 8000, feedCut: 1200, feedPlunge: 350 },
    ],
  },
  {
    group: 'Ball nose',
    tools: [
      { name: '3mm ball', type: 'ball', diameter: 3, flutes: 2, fluteLength: 12, spindleRpm: 16000, feedCut: 450, feedPlunge: 150 },
      { name: '6mm ball', type: 'ball', diameter: 6, flutes: 2, fluteLength: 20, spindleRpm: 12000, feedCut: 700, feedPlunge: 200 },
      { name: '10mm ball', type: 'ball', diameter: 10, flutes: 2, fluteLength: 30, spindleRpm: 9000, feedCut: 900, feedPlunge: 250 },
    ],
  },
  {
    group: 'Bull nose',
    tools: [
      { name: '6mm bull r1', type: 'bull', diameter: 6, cornerRadius: 1, flutes: 2, fluteLength: 20, spindleRpm: 12000, feedCut: 800, feedPlunge: 250 },
      { name: '10mm bull r2', type: 'bull', diameter: 10, cornerRadius: 2, flutes: 3, fluteLength: 30, spindleRpm: 9000, feedCut: 1000, feedPlunge: 300 },
    ],
  },
  {
    group: 'Drills',
    tools: [
      { name: '3mm drill', type: 'drill', diameter: 3, tipAngle: 118, flutes: 2, fluteLength: 30, spindleRpm: 3000, feedCut: 150, feedPlunge: 150 },
      { name: '5mm drill', type: 'drill', diameter: 5, tipAngle: 118, flutes: 2, fluteLength: 40, spindleRpm: 2200, feedCut: 180, feedPlunge: 180 },
      { name: '6mm drill', type: 'drill', diameter: 6, tipAngle: 118, flutes: 2, fluteLength: 45, spindleRpm: 1800, feedCut: 200, feedPlunge: 200 },
      { name: '8mm drill', type: 'drill', diameter: 8, tipAngle: 118, flutes: 2, fluteLength: 55, spindleRpm: 1400, feedCut: 220, feedPlunge: 220 },
      { name: '10mm spot drill 90°', type: 'drill', diameter: 10, tipAngle: 90, flutes: 2, fluteLength: 12, spindleRpm: 4000, feedCut: 200, feedPlunge: 200 },
    ],
  },
  {
    // Chamfer mills and V bits are the same cutter with different manners: a
    // point angle, and a tip flat that decides how fine a line it can hold.
    group: 'Chamfer & V bits',
    tools: [
      { name: '6mm chamfer 90°', type: 'chamfer', diameter: 6, tipAngle: 90, tipDiameter: 0.5, flutes: 1, fluteLength: 10, spindleRpm: 10000, feedCut: 600, feedPlunge: 200 },
      { name: '10mm chamfer 90°', type: 'chamfer', diameter: 10, tipAngle: 90, tipDiameter: 1, flutes: 2, fluteLength: 14, spindleRpm: 8000, feedCut: 700, feedPlunge: 250 },
      { name: '12mm chamfer 45°', type: 'chamfer', diameter: 12, tipAngle: 45, tipDiameter: 1, flutes: 2, fluteLength: 20, spindleRpm: 7000, feedCut: 700, feedPlunge: 250 },
      { name: '3.175mm V bit 60°', type: 'chamfer', diameter: 3.175, tipAngle: 60, tipDiameter: 0.1, flutes: 1, fluteLength: 8, spindleRpm: 18000, feedCut: 500, feedPlunge: 150 },
      { name: '3.175mm V bit 30°', type: 'chamfer', diameter: 3.175, tipAngle: 30, tipDiameter: 0.1, flutes: 1, fluteLength: 10, spindleRpm: 18000, feedCut: 400, feedPlunge: 120 },
    ],
  },
  {
    // Lathe tooling, by the ISO designation that is written on the box.
    //
    // The first letter is the shape and therefore the corner angle, which is
    // the whole trade: a C or a W roughs, a D profiles, a V finishes anything
    // and chips if you breathe on it. The last two digits are the nose radius,
    // which is what a finishing pass is compensated for. See engine/insert.js.
    group: 'Turning — roughing',
    tools: [
      { name: 'CNMG 120408 rougher', type: 'turning', insertCode: 'CNMG120408', insert: 'C', insertIc: 12.7, noseRadius: 0.8, hand: 'R', diameter: 12.7, spindleRpm: 900, feedCut: 200, feedPlunge: 120 },
      { name: 'WNMG 080408 rougher', type: 'turning', insertCode: 'WNMG080408', insert: 'W', insertIc: 12.7, noseRadius: 0.8, hand: 'R', diameter: 12.7, spindleRpm: 900, feedCut: 220, feedPlunge: 130 },
      { name: 'TNMG 160408 turn/face', type: 'turning', insertCode: 'TNMG160408', insert: 'T', insertIc: 9.525, noseRadius: 0.8, hand: 'R', diameter: 9.525, spindleRpm: 1100, feedCut: 180, feedPlunge: 110 },
      { name: 'SNMG 120408 facing', type: 'turning', insertCode: 'SNMG120408', insert: 'S', insertIc: 12.7, noseRadius: 0.8, hand: 'N', diameter: 12.7, spindleRpm: 900, feedCut: 200, feedPlunge: 120 },
    ],
  },
  {
    group: 'Turning — profiling & finishing',
    tools: [
      { name: 'DNMG 150604 profiling', type: 'turning', insertCode: 'DNMG150604', insert: 'D', insertIc: 12.7, noseRadius: 0.4, hand: 'R', diameter: 12.7, spindleRpm: 1300, feedCut: 130, feedPlunge: 90 },
      { name: 'DCMT 070204 finishing', type: 'turning', insertCode: 'DCMT070204', insert: 'D', insertIc: 5.95, noseRadius: 0.4, hand: 'R', diameter: 5.95, spindleRpm: 1800, feedCut: 90, feedPlunge: 60 },
      { name: 'VNMG 160404 profiling', type: 'turning', insertCode: 'VNMG160404', insert: 'V', insertIc: 9.525, noseRadius: 0.4, hand: 'R', diameter: 9.525, spindleRpm: 1500, feedCut: 100, feedPlunge: 70 },
      { name: 'CCMT 09T304 finishing', type: 'turning', insertCode: 'CCMT09T304', insert: 'C', insertIc: 9.525, noseRadius: 0.4, hand: 'R', diameter: 9.525, spindleRpm: 1600, feedCut: 100, feedPlunge: 70 },
      { name: 'RCMT 1003 copying', type: 'turning', insertCode: 'RCMT1003M0', insert: 'R', insertIc: 10, noseRadius: 5, hand: 'N', diameter: 10, spindleRpm: 1100, feedCut: 140, feedPlunge: 90 },
      // A left-hand tool is not an exotic: it is how you turn away from the
      // chuck, and there was no way to say so at all.
      { name: 'CCMT 09T308 left hand', type: 'turning', insertCode: 'CCMT09T308', insert: 'C', insertIc: 9.525, noseRadius: 0.8, hand: 'L', diameter: 9.525, spindleRpm: 1400, feedCut: 120, feedPlunge: 80 },
    ],
  },
  {
    group: 'Boring bars',
    tools: [
      { name: 'S12M CCMT 06 bar ⌀12', type: 'boring', insertCode: 'CCMT060204', insert: 'C', insertIc: 6.35, noseRadius: 0.4, hand: 'R', diameter: 12, minBore: 16, maxDepth: 60, spindleRpm: 1400, feedCut: 90, feedPlunge: 60 },
      { name: 'S16Q DCMT 07 bar ⌀16', type: 'boring', insertCode: 'DCMT070204', insert: 'D', insertIc: 5.95, noseRadius: 0.4, hand: 'R', diameter: 16, minBore: 21, maxDepth: 80, spindleRpm: 1200, feedCut: 110, feedPlunge: 70 },
      { name: 'S08K CCMT 04 bar ⌀8', type: 'boring', insertCode: 'CCMT040204', insert: 'C', insertIc: 4.76, noseRadius: 0.4, hand: 'R', diameter: 8, minBore: 10, maxDepth: 40, spindleRpm: 1800, feedCut: 60, feedPlunge: 45 },
    ],
  },
  {
    group: 'Parting, grooving & threading',
    tools: [
      { name: '2mm parting blade', type: 'parting', bladeWidth: 2, diameter: 2, maxDepth: 18, spindleRpm: 800, feedCut: 35, feedPlunge: 35 },
      { name: '3mm parting blade', type: 'parting', bladeWidth: 3, diameter: 3, maxDepth: 25, spindleRpm: 700, feedCut: 40, feedPlunge: 40 },
      { name: '2mm grooving tool', type: 'parting', bladeWidth: 2, diameter: 2, maxDepth: 6, spindleRpm: 900, feedCut: 30, feedPlunge: 30 },
      { name: '3mm internal grooving', type: 'parting', bladeWidth: 3, diameter: 3, maxDepth: 5, minBore: 16, spindleRpm: 900, feedCut: 25, feedPlunge: 25 },
      { name: '16ER AG60 threading', type: 'threading', bladeWidth: 1.5, diameter: 16, spindleRpm: 500, feedCut: 60, feedPlunge: 40 },
      { name: '16IR AG60 internal thread', type: 'threading', bladeWidth: 1.5, diameter: 16, minBore: 20, maxDepth: 40, spindleRpm: 500, feedCut: 60, feedPlunge: 40 },
    ],
  },
  {
    group: 'Face mills',
    tools: [
      { name: '25mm face mill', type: 'face', diameter: 25, flutes: 4, fluteLength: 8, spindleRpm: 6000, feedCut: 1500, feedPlunge: 300 },
      { name: '40mm face mill', type: 'face', diameter: 40, flutes: 5, fluteLength: 10, spindleRpm: 4000, feedCut: 1800, feedPlunge: 300 },
    ],
  },
];

const BASE = {
  cornerRadius: 0,
  tipAngle: 0,
  tipDiameter: 0,
  noseRadius: 0,
  bladeWidth: 0,
  insert: 'C',
  insertIc: 0,
  insertCode: '',
  hand: 'R',
  minBore: 0,
  maxDepth: 0,
  fluteLength: 20,
  flutes: 2,
  spindleRpm: 10000,
  feedCut: 800,
  feedPlunge: 300,
};

/**
 * Materialise a preset (or any partial record) into a full tool.
 *
 * Shank and holder are derived from the diameter so collision geometry exists
 * from the start, rather than defaulting to something that never matches — but
 * only for milling. A lathe tool has neither: a boring bar is a bar and a
 * turning tool is a square shank in a turret, and giving them a 40mm holder
 * around a revolved cone is where "lathe tools are drawn as mill tools" came
 * from. See engine/insert.js.
 */
export function toolFromPreset(preset, number = 1) {
  const merged = { ...BASE, ...preset };
  const type = merged.type ?? 'flat';
  const lathe = machineForType(type) === 'turn';
  // an ISO code in the preset is the authority on the geometry it encodes
  const fromCode = merged.insertCode ? parseInsertCode(merged.insertCode) : null;
  const shankDiameter = shankFor(merged.diameter);
  return {
    id: uid('tool'),
    number,
    name: merged.name ?? `${type} ${merged.diameter}mm`,
    type,
    diameter: merged.diameter ?? 6,
    insert: fromCode?.insert ?? merged.insert,
    insertIc: fromCode?.insertIc ?? (merged.insertIc || merged.diameter || 9.525),
    insertCode: merged.insertCode ?? '',
    hand: merged.hand ?? 'R',
    minBore: merged.minBore ?? 0,
    maxDepth: merged.maxDepth ?? 0,
    cornerRadius: merged.cornerRadius ?? 0,
    tipAngle: merged.tipAngle ?? 0,
    tipDiameter: merged.tipDiameter ?? 0,
    noseRadius: fromCode?.noseRadius ?? merged.noseRadius ?? 0,
    bladeWidth: merged.bladeWidth ?? 0,
    fluteLength: merged.fluteLength,
    flutes: lathe ? 1 : merged.flutes,
    shank: lathe ? [] : (merged.shank ?? [{ diameter: shankDiameter, length: 30 }]),
    holder: lathe ? [] : (merged.holder ?? [{ diameter: 40, length: 50 }]),
    spindleRpm: merged.spindleRpm,
    feedCut: merged.feedCut,
    feedPlunge: merged.feedPlunge,
  };
}

/** Nearest common collet size at or above the cutter diameter. */
export function shankFor(diameter) {
  for (const size of [3, 4, 6, 8, 10, 12, 16, 20]) {
    if (diameter <= size) return size;
  }
  return diameter;
}

/** Which machine a cutter family belongs to. */
export function machineForType(type) {
  return isLatheTool(type) ? 'turn' : 'mill';
}

/**
 * Can this machine hold this cutter?
 *
 * Not the same question as the one above, because of drills: a drill is a
 * milling tool that a lathe also uses, held in the tailstock, to put a hole
 * down the axis. Answering with `machineForType` alone hid every drill from the
 * lathe library and left centre drilling with nothing to do it with.
 */
export function machineCanHold(type, machine) {
  if (type === 'drill') return true;
  return machineForType(type) === machine;
}

/** The preset groups that belong to a machine, so a lathe never offers end mills. */
export function presetsFor(machine) {
  return TOOL_PRESETS
    .map((group) => ({
      ...group,
      tools: group.tools.filter((t) => machineCanHold(t.type, machine)),
    }))
    .filter((group) => group.tools.length > 0);
}

/**
 * Cutting speed to start from, by family — surface metres per minute, and the
 * feed per tooth as a fraction of the diameter.
 *
 * Conservative on purpose: these are numbers to edit, not numbers to trust. The
 * point of computing them rather than defaulting to 10000rpm and 800mm/min is
 * that a Ø1 cutter and a Ø20 cutter want speeds two orders of magnitude apart,
 * and handing both the same pair is how a new tool arrives already wrong.
 */
const CUTTING = {
  flat: { vc: 250, fz: 0.0055, maxRpm: 18000 },
  ball: { vc: 230, fz: 0.0045, maxRpm: 18000 },
  bull: { vc: 250, fz: 0.0055, maxRpm: 18000 },
  face: { vc: 350, fz: 0.0045, maxRpm: 12000 },
  chamfer: { vc: 220, fz: 0.0080, maxRpm: 20000 },
  drill: { vc: 35, fz: 0.0080, maxRpm: 6000 },
  // A spot drill only cuts on the tip, so it is spun like a mill rather than
  // like a jobber drill — three times the rpm at a fraction of the chip load.
  // Told apart by the point angle: 118° drills a hole, 90° or less spots one.
  spot: { vc: 125, fz: 0.0025, maxRpm: 8000 },
  // A lathe turns the work, so the surface speed is set by the *part* diameter,
  // and the feed is per revolution rather than per tooth. These are for a small
  // bar in free-cutting steel; the bar diameter scales them below.
  turning: { vc: 110, fz: 0.10, maxRpm: 2500 },
  // A boring bar is a cantilever. Everything about it is gentler than the same
  // insert on the outside, and the number that matters is not the speed but the
  // feed: chatter starts at the overhang, not at the surface metres.
  boring: { vc: 95, fz: 0.06, maxRpm: 2500 },
  parting: { vc: 65, fz: 0.055, maxRpm: 1500 },
  // Threading feed is the pitch, and the pitch is per pass — this is only the
  // spindle speed, kept low because the carriage has to keep up with it.
  threading: { vc: 55, fz: 0.10, maxRpm: 1200 },
};

/**
 * Sensible speeds, feeds, flute length and shank for a cutter of this family
 * and size — what the wizard fills in as you type a diameter.
 *
 * @param workDiameter for lathe tools, the diameter of the bar being cut, which
 *   is what sets the surface speed. Ignored for milling.
 */
export function suggestCutting({
  type = 'flat', diameter = 6, flutes, tipAngle = 0, workDiameter = 30,
}) {
  const family = type === 'drill' && tipAngle > 0 && tipAngle <= 100 ? 'spot' : type;
  const spec = CUTTING[family] ?? CUTTING.flat;
  const lathe = machineForType(type) === 'turn';
  const spinning = Math.max(0.5, lathe ? workDiameter : diameter);
  const teeth = Math.max(1, flutes ?? defaultFlutes(type, diameter));

  const rpm = clampRound((1000 * spec.vc) / (Math.PI * spinning), 300, spec.maxRpm, 50);
  // a lathe's feed is per revolution, not per tooth
  const feedCut = lathe
    ? clampRound(rpm * spec.fz, 10, 600, 5)
    : clampRound(rpm * teeth * spec.fz * diameter, 20, 6000, 10);
  return {
    flutes: teeth,
    fluteLength: Math.round(defaultFluteLength(type, diameter, tipAngle) * 10) / 10,
    spindleRpm: rpm,
    feedCut,
    feedPlunge: Math.max(10, Math.round((feedCut * (lathe ? 0.8 : 0.35)) / 5) * 5),
    shank: [{ diameter: shankFor(diameter), length: Math.max(25, diameter * 4) }],
    holder: [{ diameter: Math.max(25, diameter * 2.5), length: 50 }],
  };
}

/**
 * The two numbers a machinist actually judges a set of feeds by, worked back
 * out of the ones the tool carries.
 *
 * Spindle speed and feed rate are what the control wants and neither says
 * whether the cut is sane: 10000rpm is fast for a ⌀20 and slow for a ⌀1, and
 * 800mm/min is a heavy chip load on two flutes and a rubbing one on six. The
 * surface speed and the chip load are the same numbers expressed so that the
 * cutter's own size is already in them, which is why every catalogue quotes
 * those and not these.
 *
 * A lathe's feed is per revolution, not per tooth, and its surface speed comes
 * from the work rather than the tool — so both are reported against the bar.
 *
 * @returns { vc, load, loadLabel, workDiameter } — surface metres per minute,
 *   the per-tooth or per-revolution feed in mm, and what that feed is per
 */
export function cuttingReadout(tool, { workDiameter = 30 } = {}) {
  const lathe = machineForType(tool.type) === 'turn';
  const spinning = Math.max(0.5, lathe ? workDiameter : (tool.diameter ?? 0));
  const rpm = Math.max(0, tool.spindleRpm ?? 0);
  const feed = Math.max(0, tool.feedCut ?? 0);
  const teeth = lathe ? 1 : Math.max(1, tool.flutes ?? 1);
  return {
    vc: (Math.PI * spinning * rpm) / 1000,
    load: rpm > 0 ? feed / (rpm * teeth) : 0,
    loadLabel: lathe ? 'per rev' : 'per tooth',
    workDiameter: lathe ? workDiameter : null,
  };
}

/**
 * The sizes a family needs to be itself, for a tool changing family.
 *
 * The wizard's cards and the Type field in the properties panel are the same
 * decision, and before this only the wizard re-derived: retyping a ⌀6 flat end
 * mill as a boring bar left a ⌀6 bar with no nose radius, no minimum bore and
 * no reach — three fields that decide whether the tool can cut at all, all
 * silently zero. See [one description, not two].
 *
 * @param from the tool or draft being changed, for the sizes worth keeping
 */
export function defaultsForType(type, from = {}) {
  const lathe = isLatheTool(type);
  const patch = {
    type,
    cornerRadius: type === 'bull' ? Math.max(0.1, from.cornerRadius || 1) : 0,
    tipAngle: type === 'drill' ? (from.tipAngle || 118)
      : type === 'chamfer' ? (from.tipAngle || 90) : 0,
    tipDiameter: type === 'chamfer' ? (from.tipDiameter || 0.2) : 0,
    noseRadius: type === 'turning' || type === 'boring'
      ? Math.max(0.05, from.noseRadius || 0.8) : 0,
    bladeWidth: type === 'parting' ? (from.bladeWidth || 3)
      : type === 'threading' ? (from.bladeWidth || 1.5) : 0,
  };
  // A lathe tool arrives at a size a lathe tool comes in. Carrying a 6mm end
  // mill's diameter across into a boring bar gives a bar that fits down nothing.
  if (type === 'boring') {
    patch.diameter = isLatheTool(from.type) ? (from.diameter || 12) : 12;
    patch.minBore = from.minBore > patch.diameter ? from.minBore : patch.diameter + 4;
    patch.maxDepth = from.maxDepth || 60;
    patch.insertIc = from.insertIc || 6.35;
  } else if (lathe) {
    patch.minBore = 0;
    patch.maxDepth = type === 'parting' ? (from.maxDepth || 20) : 0;
    if (type === 'turning') {
      patch.diameter = isLatheTool(from.type) ? (from.diameter || 12.7) : 12.7;
      patch.insertIc = from.insertIc || 12.7;
    }
  } else {
    // coming back from a lathe family, a ⌀12.7 "insert" is not an end mill
    if (isLatheTool(from.type)) patch.diameter = 6;
    patch.minBore = 0;
    patch.maxDepth = 0;
    // flutes are a property of the family: a drill has two whatever the end
    // mill before it had
    patch.flutes = defaultFlutes(type, patch.diameter ?? from.diameter ?? 6);
  }
  return patch;
}

/**
 * The mistakes worth catching while the tool is being described, rather than
 * after it has generated a toolpath that cannot be cut.
 *
 * Shared by the wizard and the properties panel on purpose: they are two ways
 * of describing one tool, and for a while only the wizard checked — so every
 * one of these could be typed into an existing tool without a word.
 *
 * @returns [string] — plain sentences, worst first
 */
export function toolWarnings(tool) {
  const out = [];
  const r = (tool.diameter ?? 0) / 2;

  if (isLatheTool(tool.type)) {
    const ic = insertIcOf(tool);
    if ((tool.type === 'turning' || tool.type === 'boring') && !(tool.noseRadius > 0)) {
      out.push('With no nose radius, finishing passes cannot be compensated and '
        + 'every face will come out a nose radius short.');
    }
    if (tool.noseRadius > ic / 2) {
      out.push(`A ${trim(tool.noseRadius)}mm nose on an IC ${trim(ic)} insert is most `
        + 'of the insert — check the code.');
    }
    if (tool.type === 'boring') {
      if (tool.minBore > 0 && tool.minBore < tool.diameter) {
        out.push(`A ⌀${trim(tool.diameter)} bar cannot go down a ⌀${trim(tool.minBore)} hole.`);
      }
      const overhang = tool.maxDepth > 0 ? tool.maxDepth / Math.max(0.1, tool.diameter) : 0;
      if (overhang > 5) {
        out.push(`${overhang.toFixed(1)}×D of overhang on a boring bar will chatter — `
          + 'four diameters is the usual limit for a steel bar.');
      }
    }
    if ((tool.type === 'parting' || tool.type === 'threading') && !(tool.bladeWidth > 0)) {
      out.push('A blade with no width cannot cut a groove of any width.');
    }
  } else {
    if (tool.type === 'bull' && tool.cornerRadius > r + 1e-9) {
      out.push(`A ${trim(tool.cornerRadius)}mm corner on a ⌀${trim(tool.diameter)} cutter `
        + 'is a ball nose — the radius is capped at half the diameter.');
    }
    if (tool.type === 'chamfer' && tool.tipAngle > 0 && tool.tipAngle < 20) {
      out.push('Below about 20° the point is too fragile to cut anything but soft material.');
    }
    if (tool.tipDiameter > 0 && tool.tipDiameter >= tool.diameter) {
      out.push(`A ⌀${trim(tool.tipDiameter)} flat on a ⌀${trim(tool.diameter)} tool leaves `
        + 'no cone at all — the tip flat is the width across the very end.');
    }
    // The shank or the holder standing proud of the cutter is a depth limit the
    // flute length does not mention — see engine/tool-geometry.js reachCheck.
    const reach = reachCheck(tool, Infinity);
    if (reach.kind && reach.maxDepth < fluteLengthOf(tool) - 1e-6) {
      out.push(`The ${reach.kind} is wider than the cutter, so only `
        + `${reach.maxDepth.toFixed(1)}mm of the ${fluteLengthOf(tool).toFixed(0)}mm `
        + 'cutting length can go into a slot.');
    }
    // Not drills: a jobber drill is 10×D by definition and a long series is 15,
    // so this is a rule about cutters that work on their *side* — the ones that
    // deflect away from the wall they are cutting and chatter.
    if (tool.type !== 'drill' && tool.diameter > 0 && tool.fluteLength / tool.diameter > 8) {
      out.push(`${(tool.fluteLength / tool.diameter).toFixed(0)}×D of flute is a `
        + 'long-reach cutter — expect chatter unless the cut is very light.');
    }
  }

  // Speeds, checked in the units they are judged in rather than the ones they
  // are typed in — see cuttingReadout.
  //
  // The bands are wide on purpose, and they have to be: without knowing the
  // material there is no right answer, only an absurd one. HSS in steel wants
  // 30 m/min and carbide in aluminium will take 1000, so anything narrower than
  // this would fire on half the sane tools in the library — and a warning that
  // fires on sane tools is a warning nobody reads. What these catch is a
  // decimal point.
  const { vc, load, loadLabel } = cuttingReadout(tool);
  const lathe = isLatheTool(tool.type);
  if (vc > (lathe ? 700 : 1500)) {
    out.push(`${Math.round(vc)} m/min of surface speed is past what any cutter `
      + 'runs at in any material — check the diameter and the RPM.');
  }
  // The suggestion's own chip load is 0.0055×D for milling and a tenth of a
  // millimetre per revolution for turning; three or four times that is heavy
  // but real, and ten times it is a typo.
  const heavy = lathe ? 0.5 : Math.max(0.02, tool.diameter * 0.02);
  if (load > heavy) {
    out.push(`${load.toFixed(3)}mm ${loadLabel} is a heavier chip than this size `
      + 'takes — check the feed, the flute count and the RPM.');
  }
  if (tool.spindleRpm > 0 && tool.feedCut > 0 && load > 0 && load < (lathe ? 0.01 : 0.002)) {
    out.push(`${load.toFixed(4)}mm ${loadLabel} is too fine a chip to cut: `
      + 'the edge rubs instead, and rubbing is what burns a cutter.');
  }
  if (tool.feedPlunge > 0 && tool.feedCut > 0 && tool.feedPlunge > tool.feedCut) {
    out.push('Plunging faster than cutting asks the end of the tool, which barely '
      + 'cuts at all, to take more than its side.');
  }
  return out;
}

function defaultFlutes(type, diameter) {
  if (isLatheTool(type)) return 1;
  if (type === 'drill') return 2;
  if (type === 'chamfer') return diameter < 5 ? 1 : 2;
  if (type === 'face') return Math.max(3, Math.round(diameter / 8));
  return diameter < 4 ? 2 : diameter < 10 ? 3 : 4;
}

function defaultFluteLength(type, diameter, tipAngle = 0) {
  // a spot drill is stubby on purpose; that stiffness is the whole point of it
  if (type === 'drill') return tipAngle > 0 && tipAngle <= 100 ? diameter * 1.2 : diameter * 8;
  if (type === 'face') return Math.max(6, diameter * 0.25);
  if (isLatheTool(type)) return Math.max(10, diameter * 2);
  if (type === 'chamfer') {
    // The cone has to fit inside the flutes. A 30° V bit on a 3.175 shank has a
    // cone 5.9mm tall — give it the 5mm a "1.6 x D" rule suggests and the tool
    // is drawn, and machined, as a cone with its shoulder above its own top.
    return Math.max(6, diameter * 1.6, coneHeight(diameter, tipAngle) * 1.2);
  }
  return diameter * 3;
}

/** How far up the cutter a point of this included angle reaches. */
function coneHeight(diameter, tipAngle) {
  if (!(tipAngle > 0) || tipAngle >= 180) return 0;
  return (diameter / 2) / Math.tan((tipAngle / 2 * Math.PI) / 180);
}

function clampRound(value, lo, hi, step) {
  return Math.max(lo, Math.min(hi, Math.round(value / step) * step));
}

/**
 * A name that says what the cutter is, in the shorthand a machinist writes on
 * the shelf label.
 */
export function suggestName(tool) {
  const d = trim(tool.diameter);
  switch (tool.type) {
    case 'ball': return `${d}mm ball`;
    case 'bull': return `${d}mm bull r${trim(tool.cornerRadius)}`;
    case 'drill': return `${d}mm drill`;
    case 'chamfer':
      return tool.tipAngle && tool.tipAngle < 70
        ? `${d}mm V bit ${trim(tool.tipAngle)}°`
        : `${d}mm chamfer ${trim(tool.tipAngle ?? 90)}°`;
    case 'face': return `${d}mm face mill`;
    // A lathe tool is named by its insert, because that is what is written on
    // the box and what you go to the drawer looking for.
    case 'turning': case 'boring': {
      const code = String(tool.insertCode ?? '').trim().toUpperCase();
      const stem = code || `${tool.insert ?? 'C'} ${trim(insertIcOf(tool))}`;
      const hand = tool.hand && tool.hand !== 'R' ? ` ${tool.hand}H` : '';
      return tool.type === 'boring'
        ? `⌀${d} bar · ${stem}${hand}`
        : `${stem}${hand}`;
    }
    case 'parting': return `${trim(tool.bladeWidth || tool.diameter)}mm parting blade`;
    case 'threading': return `${trim(tool.bladeWidth || 1.5)}mm threading tool`;
    default: return `${d}mm flat ${tool.flutes ?? 2}FL`;
  }
}

function trim(v) { return String(Math.round((v ?? 0) * 1000) / 1000); }

// --- the user's own tools -------------------------------------------------
//
// The built-in presets are a starting point and cannot be edited away. Tools
// the user builds in the wizard, or saves out of a project, go here — and can
// be deleted again, which is the half of "a library" that was missing.

const USER_KEY = 'cncam.toolLibrary';

export function loadUserTools() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];      // private mode, or something else wrote to the key
  }
}

function writeUserTools(tools) {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(tools));
    return true;
  } catch {
    return false;
  }
}

/**
 * Put a tool in the library, replacing any entry of the same name.
 * Ids and tool numbers are not saved: those belong to the project it came from.
 */
export function saveUserTool(tool) {
  const { id, number, ...rest } = tool;
  const tools = loadUserTools().filter((t) => t.name !== rest.name);
  tools.push(rest);
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return writeUserTools(tools) ? tools : null;
}

export function removeUserTool(name) {
  return writeUserTools(loadUserTools().filter((t) => t.name !== name));
}

/** Flat list of every preset, with its group name attached. */
export function allPresets() {
  return TOOL_PRESETS.flatMap((g) => g.tools.map((t) => ({ ...t, group: g.group })));
}

export function serializeLibrary(tools) {
  return JSON.stringify({ version: LIBRARY_VERSION, tools }, null, 2);
}

/**
 * Parse an exported library. Accepts either the wrapped form or a bare array,
 * and re-ids every tool so importing into a project can never collide with
 * tools already in it.
 */
export function deserializeLibrary(json) {
  const parsed = JSON.parse(json);
  const tools = Array.isArray(parsed) ? parsed : parsed.tools;
  if (!Array.isArray(tools)) throw new Error('not a tool library (expected a tools array)');
  return tools.map((t, i) => toolFromPreset(t, t.number ?? i + 1));
}
