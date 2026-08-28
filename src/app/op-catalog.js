// What each machining strategy is for, in the words of the person choosing one.
//
// The strategy is the first decision in an operation and the one every other
// setting hangs off, and a list of eleven names is no help at all with it:
// "clear2d" and "adaptive" both say roughing, "parallel3d" and "waterline" both
// say finishing, and nothing on screen said which one suited the part in front
// of you. So each carries a picture of the cut it makes, a line on what it
// does, a line on when to reach for it, and the cutter it expects.
//
// Grouped by the stage of the job they belong to, because that is the order a
// program gets built in: face the billet, rough it out, cut the profiles, do
// the holes, break the edges, finish the surfaces.

import { OP_LABELS } from '../engine/toolpath.js';
import { depthPasses } from '../engine/stock.js';
import { plural, pluralEs } from '../engine/text.js';
// The sentence below is a check on the settings, so every number in it has to
// be the number the strategy will use. Restated here, four of them were not:
// the thread's form depth was the external constant whatever the thread, its
// pass count was the one asked for rather than the one the first-bite cap
// produces (six on screen against fifteen in the program), the depth of a
// depth pass was the stepdown rather than the share of the cut each pass takes,
// and an engraved mark's depth was the whole height between Top Z and Bottom Z.
import { threadFormDepth, threadInfeed, grooveBites } from '../engine/strategies/turning.js';
import { grooveGeometry } from '../engine/strategies/engrave.js';
// Same rule for the three hole operations: the tapping drill a tap looks for
// and the cone a spot drill sinks are worked out by the strategy, so the panel
// asks the strategy rather than restating the arithmetic.
import { tapDrillDiameter } from '../engine/strategies/holes.js';
import { tipAngleOf } from '../engine/tool-geometry.js';

/**
 * The strategies that ask `depthLevelsFor` for their levels rather than
 * `depthPasses`, and so take an extra pass at every flat face of the part.
 *
 * Named here because this sentence is written without the model in front of it
 * — the panel has the settings, not the mesh — and a count that ignores those
 * passes is wrong on any part with a floor in it. `defaults-notes.test.js`
 * checks the claim against what each strategy actually cuts.
 */
const FLAT_LEVELLED = new Set(['clear2d', 'pocket', 'adaptive']);

/**
 * A schematic of the cut, 24×24. Deliberately crude — these are read at 40px
 * next to a name, so what has to survive is the *shape of the motion*: a
 * raster, a spiral, a ring, a point.
 */
const ICONS = {
  face:
    '<rect x="2" y="7" width="20" height="12" rx="1"/>'
    + '<path d="M4 10h16M4 13h16M4 16h16" class="stroke"/>',
  contour2d:
    '<rect x="7" y="7" width="10" height="10" rx="1"/>'
    + '<path d="M4 4h16v16H4z" class="stroke dashed"/>',
  pocket:
    '<rect x="2" y="4" width="20" height="16" rx="1"/>'
    + '<path d="M6 8h12v8H6z" class="stroke"/><path d="M9 11h6v2H9z" class="stroke"/>',
  clear2d:
    '<path d="M2 18h5v-4h5v-4h5V6h5v14H2z"/>'
    + '<path d="M2 18h5v-4h5v-4h5V6h5" class="stroke"/>',
  adaptive:
    '<path d="M3 12a4 4 0 1 1 8 0 4 4 0 1 0 8 0" class="stroke wide"/>'
    + '<circle cx="19" cy="12" r="2.5"/>',
  // a channel through the block, with the cutter's line down the middle of it
  slot:
    '<path d="M2 3h20v18H2z"/>'
    + '<path d="M6 6h12v12H6z" class="stroke"/>'
    + '<path d="M12 6v12" class="stroke accent wide"/>',
  drill:
    '<path d="M12 3v9l-3 4v0h6l-3-4z"/>'
    + '<path d="M4 20h16" class="stroke"/><circle cx="12" cy="20" r="1.6"/>',
  // a shallow cone in the top face, and the plate it is sunk into
  spot:
    '<path d="M2 12h20v8H2z"/>'
    + '<path d="M8 12l4 5 4-5z" class="stroke accent wide"/>'
    + '<path d="M12 2v8" class="stroke"/>',
  // a screw thread down a hole: the flanks, drawn as the vee they are
  tap:
    '<path d="M2 4h20v16H2z"/>'
    + '<path d="M8 6v12M16 6v12" class="stroke"/>'
    + '<path d="M8 8l8 2M8 12l8 2M8 16l8 2" class="stroke accent"/>',
  // a cutter orbiting inside the hole it is threading
  threadMill:
    '<path d="M2 4h20v16H2z"/>'
    + '<circle cx="12" cy="12" r="7" class="stroke dashed"/>'
    + '<circle cx="16.5" cy="12" r="2.5"/>'
    + '<path d="M12 12h4.5" class="stroke"/>',
  bore:
    '<circle cx="12" cy="12" r="9" class="stroke dashed"/>'
    + '<path d="M12 5a7 7 0 1 1-6.9 8.2A5.5 5.5 0 1 0 12 8" class="stroke wide"/>',
  chamfer:
    '<path d="M4 20V9l6-5h10v16z"/>'
    + '<path d="M4 9l6-5" class="stroke accent"/>',
  engrave:
    '<path d="M12 2l3 8h-6z"/><path d="M12 10v4" class="stroke"/>'
    + '<path d="M3 20h18" class="stroke"/><path d="M9 18h6l-3-4z" class="stroke"/>',
  parallel3d:
    '<path d="M2 16c4-8 8 6 12-2s6 2 8 0v6H2z"/>'
    + '<path d="M2 13c4-8 8 6 12-2s6 2 8 0M2 17c4-8 8 6 12-2s6 2 8 0" class="stroke"/>',
  waterline:
    '<path d="M12 3c5 0 9 4 9 9v9H3v-9c0-5 4-9 9-9z"/>'
    + '<path d="M4 14h16M3.4 18h17.2M6 10h12" class="stroke"/>',

  // Turning: the bar lies along the drawing, the centreline is dashed, and the
  // insert comes at it from below — which is how a lathe is drawn everywhere.
  turnFace:
    '<rect x="2" y="7" width="14" height="10" rx="1"/>'
    + '<path d="M1 12h21" class="stroke dashed"/>'
    + '<path d="M17 5v14" class="stroke accent"/>',
  turnRough:
    '<path d="M2 7h9v3h6v4h-6v3H2z"/>'
    + '<path d="M1 12h21" class="stroke dashed"/>'
    + '<path d="M21 8h-6M21 12h-3M21 16h-6" class="stroke"/>',
  turnFinish:
    '<path d="M2 7h9v3h6v4h-6v3H2z"/>'
    + '<path d="M1 12h21" class="stroke dashed"/>'
    + '<path d="M21 6v2h-6v4h-6v4H2" class="stroke wide"/>',
  turnPart:
    '<rect x="2" y="7" width="18" height="10" rx="1"/>'
    + '<path d="M1 12h21" class="stroke dashed"/>'
    + '<path d="M13 4v8" class="stroke accent"/>',
  turnGroove:
    '<path d="M2 7h9v4h3V7h8v10h-8v-4h-3v4H2z"/>'
    + '<path d="M1 12h21" class="stroke dashed"/>'
    + '<path d="M12.5 2v5" class="stroke accent wide"/>',
  turnThread:
    '<rect x="2" y="8" width="18" height="8" rx="1"/>'
    + '<path d="M1 12h21" class="stroke dashed"/>'
    + '<path d="M4 8l2-3M8 8l2-3M12 8l2-3M16 8l2-3" class="stroke accent"/>',
  turnDrill:
    '<path d="M2 6h13v12H2z"/>'
    + '<path d="M1 12h21" class="stroke dashed"/>'
    + '<path d="M22 10h-6l-2 2 2 2h6" class="stroke accent wide"/>',
  turnBore:
    '<path d="M2 5h18v5H9v4h11v5H2z"/>'
    + '<path d="M1 12h21" class="stroke dashed"/>'
    + '<path d="M22 9H10" class="stroke accent wide"/>',
};

/**
 * @typedef {{ label, group, summary, when, cutter, icon }} StrategyCard
 */
export const OP_CATALOG = {
  face: {
    group: 'Prepare the stock',
    summary: 'Rasters the top of the billet flat.',
    when: 'First operation on sawn or cast stock, to make a surface everything '
      + 'else is measured from.',
    cutter: 'Face mill or a big flat end mill',
  },
  clear2d: {
    group: 'Roughing',
    summary: 'Empties the stock level by level, following the shape of the part '
      + 'at each depth.',
    when: 'The straightforward rougher. Predictable and easy to read; it takes '
      + 'the full width of the cutter in corners.',
    cutter: 'Flat or bull nose',
  },
  adaptive: {
    group: 'Roughing',
    summary: 'Rough with a light, constant radial bite, taken at full depth.',
    when: 'Faster and far kinder to the cutter than Z-level on anything with '
      + 'much material to move. The trade is a longer path.',
    cutter: 'Flat or bull nose, ideally full-flute',
  },
  contour2d: {
    group: 'Profiles',
    summary: 'Follows the part\'s outline, one depth pass at a time.',
    when: 'Cutting a part out of a sheet or a billet. Holding tabs live here.',
    cutter: 'Flat or bull nose',
  },
  pocket: {
    group: 'Profiles',
    summary: 'Clears an enclosed pocket down to its floor.',
    when: 'A recess with a closed boundary — a bearing seat, a lightening pocket, '
      + 'a cavity.',
    cutter: 'Flat',
  },
  slot: {
    group: 'Profiles',
    summary: 'Cuts a channel of a given width along a line, ramping in.',
    when: 'Keyways, cable channels, seal grooves — anywhere the *line* is what '
      + 'you have rather than a region to clear. A slot wider than the cutter is '
      + 'taken down the middle first and then out to each wall.',
    cutter: 'Flat or bull nose no wider than the slot',
  },
  spot: {
    group: 'Holes',
    summary: 'Sinks a shallow cone at every hole centre before the drill goes in.',
    when: 'Before drilling, on anything but a faced flat surface — a twist drill '
      + 'wanders as it enters. Spot to the hole diameter instead and the same '
      + 'cut breaks the edge as well.',
    cutter: 'Spot drill, centre drill or chamfer mill',
  },
  drill: {
    group: 'Holes',
    summary: 'Finds the round holes on the part and drills them with canned cycles.',
    when: 'Any hole a drill of that size can make. Pecks and dwells are here.',
    cutter: 'Drill of the hole\'s diameter',
  },
  tap: {
    group: 'Holes',
    summary: 'Cuts the thread with a tap, spindle locked to the feed.',
    when: 'Threads in a machine that can rigid tap, or one with a tapping head. '
      + 'It looks for the *tapping drill* — an M6 goes in a ⌀5 hole — so drill '
      + 'them first.',
    cutter: 'Tap of the thread size',
  },
  threadMill: {
    group: 'Holes',
    summary: 'Spirals a small cutter up the hole on the thread\'s own helix.',
    when: 'Threads on a machine that cannot rigid tap, which is most of them. '
      + 'One cutter does every diameter of the same pitch, and a broken one '
      + 'comes back out of the hole. Slower than tapping.',
    cutter: 'Thread mill about two thirds of the hole',
  },
  bore: {
    group: 'Holes',
    summary: 'Spirals a smaller cutter down a round hole to open it to size.',
    when: 'A hole bigger than any drill you have, or one that has to be round and '
      + 'on size. Never plunges — the helix is the entry.',
    cutter: 'Flat end mill smaller than the hole',
  },
  chamfer: {
    group: 'Edges & marking',
    summary: 'Runs a pointed cutter along the edges to break them.',
    when: 'After the profiles are cut. The chamfer width you ask for is what '
      + 'lands on the part; the depth comes from the cutter\'s point angle.',
    cutter: 'Chamfer mill, spot drill or V bit',
  },
  engrave: {
    group: 'Edges & marking',
    summary: 'Traces the lines with the cutter centred on them — no compensation.',
    when: 'Part numbers, scribe lines, V-grooves. With a V bit you can ask for a '
      + 'line width instead of a depth.',
    cutter: 'V bit, or a small flat for a square groove',
  },
  parallel3d: {
    group: '3D finishing',
    summary: 'Rasters a curved surface, the cutter riding the real form.',
    when: 'Shallow and rolling surfaces. Poor on steep walls, where the passes '
      + 'spread apart.',
    cutter: 'Ball or bull nose',
  },
  turnFace: {
    group: 'Turning',
    summary: 'Faces the end of the bar back to a Z, one pass at a time.',
    when: 'First operation on a bar, to get a square end to measure everything '
      + 'else from. Each pass sweeps from the outside in to the centre.',
    cutter: 'Turning insert',
  },
  turnRough: {
    group: 'Turning',
    summary: 'Takes the bar down to the profile at a constant depth of cut.',
    when: 'The bulk of a turned part. Each pass runs at one diameter until the '
      + 'work rises to meet the tool, then retracts and comes back further in.',
    cutter: 'Turning insert, the biggest nose you can use',
  },
  turnFinish: {
    group: 'Turning',
    summary: 'One pass down the finished profile, compensated for the insert nose.',
    when: 'After roughing. The nose radius is why this is not just a roughing '
      + 'pass with a small step: without it every face is a nose short.',
    cutter: 'Turning insert with a small nose radius',
  },
  turnGroove: {
    group: 'Turning',
    summary: 'Plunges a groove between Top Z and Bottom Z, down to a radius.',
    when: 'Circlip grooves, O-ring grooves, thread relief. Wider than the blade '
      + 'is walked out in overlapping plunges, both shoulders cut full width.',
    cutter: 'Grooving or parting blade',
  },
  turnThread: {
    group: 'Turning',
    summary: 'Single-point threading, one pass per depth down the same helix.',
    when: 'After the diameter is finished. The infeed shares the chip area out '
      + 'evenly rather than the depth, so the last pass is not doing five times '
      + 'the work of the first.',
    cutter: 'Threading insert of the right form',
  },
  turnDrill: {
    group: 'Turning',
    summary: 'Drills down the centreline from the end of the bar.',
    when: 'Before boring, and before the bar is turned down — a hole is easiest '
      + 'to start on a face that is square and a bar that is still stiff.',
    cutter: 'Drill in the tailstock',
  },
  turnBore: {
    group: 'Turning',
    summary: 'Opens an existing hole out to the part\'s inside profile.',
    when: 'Any bore that has to be round and on size, which is nearly all of '
      + 'them. Needs a hole to start from — drill it first.',
    cutter: 'Boring bar that fits down the pilot hole',
  },
  turnPart: {
    group: 'Turning',
    summary: 'Cuts the finished part off the bar.',
    when: 'Last. Pecked by default, because a blade buried in a deep groove is '
      + 'the easiest tool in the shop to break.',
    cutter: 'Parting blade',
  },
  waterline: {
    group: '3D finishing',
    summary: 'Cuts level contours down the form — the complement of a raster.',
    when: 'Steep walls and vertical faces, exactly where a parallel finish is '
      + 'worst. Often run as a pair with it.',
    cutter: 'Ball or bull nose',
  },
};

/** The stages of a job, in the order a program is usually built. */
export const OP_GROUPS = [
  'Prepare the stock', 'Roughing', 'Profiles', 'Holes', 'Edges & marking',
  '3D finishing', 'Turning',
];

/** Everything the picker needs about one strategy. */
export function strategyCard(type) {
  const entry = OP_CATALOG[type];
  return {
    type,
    label: OP_LABELS[type] ?? type,
    group: entry?.group ?? 'Other',
    summary: entry?.summary ?? '',
    when: entry?.when ?? '',
    cutter: entry?.cutter ?? '',
    icon: ICONS[type] ?? '',
  };
}

/**
 * What this operation, with these settings, is actually going to do.
 *
 * A panel of fields never says what the sum of them comes to, and the mistakes
 * that reach the machine are nearly always sums: a 30mm-deep pass at a 0.2mm
 * stepdown, a facing operation aimed 30mm below the part, a chamfer with a
 * width nobody converted to a depth. Reading the settings back as a sentence is
 * the cheapest possible check on all of them.
 *
 * @returns a sentence, or '' when there is nothing worth saying yet
 */
export function describeIntent(op, tool) {
  const p = op?.params ?? {};
  const cutter = tool ? `a ⌀${tool.diameter} ${tool.type}` : 'the assigned cutter';
  const depth = (p.topZ ?? 0) - (p.bottomZ ?? 0);
  const mm = (v) => `${Math.round(v * 100) / 100}mm`;
  // Asked of `depthPasses` rather than worked out again here, because the
  // stepdown is a *limit* and not the depth taken: it shares the cut out evenly
  // into passes that are all at most the stepdown, so 20mm at 3mm is seven
  // passes of 2.86 and the sentence used to read "seven passes of 3mm" — the
  // one number in it a machinist would check against the flute length.
  const levels = p.stepdown > 0 ? depthPasses(p.topZ ?? 0, p.bottomZ ?? 0, p.stepdown) : [];
  const inPasses = depth > 0 && levels.length > 0
    ? ` in ${pluralEs(levels.length, 'pass')} of ${mm(depth / levels.length)}`
      // …and a clearing strategy adds one wherever the part has a floor, which
      // is a property of the part rather than of these settings. Saying seven
      // where the program has nine is worse than not counting them at all.
      + (FLAT_LEVELLED.has(op?.type) && p.flatPasses !== false
        ? ', and one at each flat face' : '')
    : '';

  switch (op?.type) {
    case 'face':
      return `Skims ${mm(depth)} off the top with ${cutter}, stepping `
        + `${Math.round((p.stepover ?? 0.6) * 100)}% of its width between passes.`;
    case 'contour2d': {
      const outline = (p.contourOutline ?? 'part') === 'part'
        ? 'the outline of the whole part' : 'the profile at each depth';
      const side = { outside: 'outside', inside: 'inside', on: 'straight down' }[p.side ?? 'outside'];
      const tabs = p.tabCount > 0
        ? ` Leaves ${p.tabCount} tabs of ${mm(p.tabWidth)} × ${mm(p.tabHeight)} holding it.` : '';
      return `Runs ${cutter} ${side} ${outline}, ${mm(depth)} down${inPasses}.${tabs}`;
    }
    case 'pocket':
      return `Clears the enclosed pockets ${mm(depth)} deep with ${cutter}${inPasses}.`;
    case 'slot': {
      const width = (p.slotWidth ?? 0) > 0 ? p.slotWidth : (tool?.diameter ?? 0);
      const lanes = tool && width > tool.diameter
        ? ' down the middle first and then out to each wall' : '';
      return `Cuts a ${mm(width)} slot ${mm(depth)} deep with ${cutter}${inPasses}${lanes}, `
        + `${(p.rampAngle ?? 0) > 0 ? `ramping in at ${p.rampAngle}°` : 'plunging in — set a ramp angle'}.`;
    }
    case 'clear2d':
      return `Roughs everything between the stock and the part, ${mm(depth)} deep${inPasses}, `
        + `leaving ${mm(p.stockToLeave ?? 0)} on for finishing.`;
    case 'adaptive':
      // The bite falls back to the strategy's own default rather than to a
      // number of its own, and the depth is the depth taken rather than the
      // stepdown — which on adaptive is two whole tool diameters, so a cut
      // shallower than one pass read as the full limit.
      return `Roughs with ${cutter} at a ${Math.round((p.engagement ?? 0.15) * 100)}% radial bite, `
        + `${mm(depth)} deep${inPasses}, leaving ${mm(p.stockToLeave ?? 0)} on.`;
    case 'drill':
      return `Drills every hole matching ⌀${tool?.diameter ?? '?'}±${p.diameterTol ?? 0.5}, `
        + ((p.depthMode ?? 'hole') === 'hole' ? 'each to its own floor.' : `all to Z${p.bottomZ}.`)
        + (p.peck > 0 ? ` Pecking ${mm(p.peck)} at a time.` : '');
    case 'spot': {
      // The depth is not typed and the width usually is not either: the cone is
      // as wide as `spotDiameter`, or as wide as the hole when that is blank —
      // and never wider than the cutter, which is the case worth saying,
      // because a ⌀3 spot drill asked to spot a ⌀20 hole makes a ⌀3 cone.
      const angle = tipAngleOf(tool);
      const asked = p.spotDiameter > 0 ? p.spotDiameter : 0;
      const capped = tool ? Math.min(asked || Infinity, tool.diameter) : asked;
      const how = asked > 0
        ? `a ⌀${mm(capped)} cone`
          + (tool && asked > tool.diameter ? ` — ⌀${mm(asked)} is wider than this cutter` : '')
        : `a cone as wide as each hole, up to ⌀${tool?.diameter ?? '?'}`;
      return `Sinks ${how} at every hole centre with ${cutter}`
        + (angle > 0
          ? `, which its ${angle}° point reaches ${mm((capped / 2) / Math.tan((angle * Math.PI) / 360))} down.`
          : ' — this cutter has no point, so it cannot spot.');
    }
    case 'tap': {
      // Pitch comes from the tool unless this pass overrides it, exactly as the
      // strategy reads it — a tap carries its own thread, and a shared default
      // of 1.5 once turned every M6×1 into an M6×1.5.
      const pitch = p.threadPitch > 0 ? p.threadPitch : (tool?.pitch ?? 0);
      if (!(pitch > 0)) return 'This tap has no pitch — set one on the cutter or on this pass.';
      const drill = tapDrillDiameter(tool?.diameter ?? 0, pitch);
      const lead = pitch * (tool?.leadThreads ?? 2);
      return `Taps M${tool?.diameter ?? '?'}×${pitch} ${p.threadHand === 'left' ? 'left' : 'right'} hand `
        + `in every ⌀${Math.round(drill * 100) / 100}±${p.diameterTol ?? 0.3} hole, `
        + 'spindle locked to the feed'
        + (lead > 0 ? `, stopping ${mm(lead)} short of a blind floor for the tap's lead.` : '.');
    }
    case 'threadMill': {
      const pitch = p.threadPitch > 0 ? p.threadPitch : (tool?.pitch ?? 0);
      if (!(pitch > 0)) return 'This cutter has no pitch — a thread has one, so set it here or on the tool.';
      const internal = p.threadInternal !== false;
      return `Spirals ${cutter} up ${internal ? 'every hole it fits down' : 'every round boss'} `
        + `on a ${pitch}mm ${p.threadHand === 'left' ? 'left' : 'right'}-hand helix, `
        + `${mm(depth)} of thread, ${(p.direction ?? 'climb') === 'climb' ? 'climbing' : 'conventional'}.`;
    }
    case 'bore':
      return `Spirals ${cutter} down ${p.boreDiameter > 0 ? `⌀${p.boreDiameter} holes` : 'every hole it fits inside'}, `
        + `${mm(p.stepdown ?? 1)} per turn, ${mm(depth)} deep.`;
    case 'chamfer': {
      const angle = tool?.tipAngle > 0 ? tool.tipAngle : null;
      const drop = angle ? (p.chamferWidth ?? 0) / Math.tan(((angle / 2) * Math.PI) / 180) : null;
      return `Breaks the edges at Z${p.topZ} with a ${mm(p.chamferWidth ?? 0)} chamfer`
        + (angle ? `, which a ${angle}° cutter reaches ${mm(drop)} below them.` : '.');
    }
    case 'engrave': {
      // A mark's depth is `engraveDepth`, not Top Z minus Bottom Z. Bottom Z is
      // a floor the mark may not pass and arrives 5mm under the face, so the
      // sentence described a 0.3mm mark as five millimetres deep — the same
      // reading of those two heights that once had the strategy cutting
      // straight through the part. And a width is converted the way the cutter
      // converts it, through its own point angle: `grooveGeometry`, so the two
      // cannot disagree.
      const groove = grooveGeometry(tool);
      const width = Math.max(0, p.grooveWidth ?? 0);
      const byWidth = (p.engraveMode ?? 'depth') === 'width';
      const cut = byWidth ? groove.depthFor(width) : Math.max(0, p.engraveDepth ?? 0);
      const how = byWidth
        ? `a ${mm(width)} wide line`
          + (cut != null ? `, which that cutter reaches at ${mm(cut)} deep`
            : ' — this cutter has no point, so its mark is its own diameter at any depth')
        : `${mm(cut)} deep`;
      return `Traces the part's boundaries with ${cutter} centred on them, ${how}.`;
    }
    case 'parallel3d':
      return `Finishes the surface with ${cutter} in ${(p.pattern ?? 'zigzag') === 'flow' ? 'streamlines of the steepest slope' : `${p.angleDeg ?? 0}° passes`}, `
        + `stepping ${mm((p.stepover ?? 0.08) * (tool?.diameter ?? 6))} between them.`;
    case 'waterline':
      return `Finishes the walls with ${cutter} in level contours ${mm(p.stepdown ?? 0.25)} apart, `
        + `from Z${p.topZ} down to Z${p.bottomZ}.`;
    case 'turnFace':
      return `Faces the end of the bar from Z${p.topZ} back to Z${p.bottomZ}, `
        + `${mm(p.stepdown ?? 0.5)} per pass.`;
    case 'turnRough':
      return `Turns the bar down to the profile between Z${p.topZ} and Z${p.bottomZ} at `
        + `${mm(p.stepdown ?? 1.5)} depth of cut, leaving ${mm(p.stockToLeave ?? 0)} on.`;
    case 'turnFinish':
      return `One pass down the profile from Z${p.topZ} to Z${p.bottomZ}`
        + (tool?.noseRadius > 0
          ? `, offset for the insert's ${mm(tool.noseRadius)} nose.`
          : ' — set a nose radius on the insert so it can be compensated.');
    case 'turnGroove': {
      const blade = tool?.bladeWidth || tool?.diameter || 3;
      const width = Math.abs((p.topZ ?? 0) - (p.bottomZ ?? 0));
      const { plunges } = grooveBites(width, blade, Math.max(0, p.stockToLeave ?? 0));
      // Blank and zero are opposite instructions and `?? 0` made them the same
      // sentence: every new grooving operation — which is born with no floor
      // radius, deliberately — read as "down to ⌀0", which is the bar cut in
      // half. The strategy has not done that since the default was fixed; this
      // is the same bug living on in the description of it.
      const floor = p.grooveRadius == null
        ? 'to a depth worked out from the diameter it is cut into'
        : p.grooveRadius === 0
          ? 'right down to the centreline, which parts the bar off'
          : `down to ⌀${Math.round(p.grooveRadius * 200) / 100}`;
      return `Cuts a ${mm(width)} groove between Z${p.topZ} and Z${p.bottomZ} ${floor}, `
        + `in ${plural(plunges, 'plunge')} of a ${mm(blade)} blade.`;
    }
    case 'turnThread': {
      const pitch = p.threadPitch ?? 1.5;
      const internal = !!p.threadInternal;
      const depth = p.threadDepth > 0 ? p.threadDepth : threadFormDepth(pitch, internal);
      const schedule = threadInfeed({
        depth,
        passes: p.threadPasses ?? 6,
        degression: p.threadDegression ?? 2,
        firstDepth: p.threadFirstDepth ?? 0,
        spring: p.threadSpringPasses ?? 0,
      });
      return `Cuts a ${pitch}mm pitch ${internal ? 'internal' : 'external'} thread `
        + `${mm(Math.abs((p.topZ ?? 0) - (p.bottomZ ?? 0)))} long in `
        + `${pluralEs(schedule.length, 'pass')}, ${mm(depth)} deep, `
        + `first bite ${mm(schedule[0] ?? 0)}.`;
    }
    case 'turnDrill':
      return `Drills ⌀${tool?.diameter ?? '?'} down the centreline from Z${p.topZ} to `
        + `Z${p.bottomZ}` + (p.peck > 0 ? `, pecking ${mm(p.peck)} at a time.` : ' in one go.');
    case 'turnBore':
      return `Bores from Z${p.topZ} in to Z${p.bottomZ} at ${mm(p.stepdown ?? 0.8)} per pass, `
        + `working outward from ${p.boreStartRadius > 0 ? `⌀${p.boreStartRadius * 2}` : 'the existing hole'}`
        + `, leaving ${mm(p.stockToLeave ?? 0)} on.`;
    case 'turnPart':
      return `Parts off at Z${p.bottomZ}, down to ⌀${(p.partOffRadius ?? 0) * 2}`
        + (p.peck > 0 ? `, pecking ${mm(p.peck)} at a time.` : ' in one plunge.');
    default:
      return '';
  }
}

/**
 * An <svg> schematic of the strategy's cut.
 *
 * Filled shapes are the material, stroked ones the tool's motion; `accent`
 * marks the feature the strategy exists to make. The CSS lives in styles.css
 * under `.op-icon`.
 */
export function opIcon(type, size = 24) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', `op-icon op-icon-${type}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[type] ?? '<circle cx="12" cy="12" r="6"/>';
  return svg;
}
