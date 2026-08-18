// Operation parameter descriptors for the properties panel.
//
// Grouped the way a machinist reasons about a cut — heights, then stepping,
// then how the tool gets into and out of the material — and filtered per
// strategy so a drill cycle does not offer a stepover it ignores. `ops: []`
// (or omitted) means the field applies everywhere.
//
// Each group also carries a `tab` key that says which top-level tab in the
// properties panel it belongs to. Grouping heights on their own tab is what
// lets the viewport's height gizmos hide when the user is editing anything
// else — so the handles do not clutter the scene while typing feeds.

export const LEAD_TYPES = ['none', 'arc', 'tangent'];
export const LEAD_TYPE_LABELS = {
  none: 'None (straight on)',
  arc: 'Arc',
  tangent: 'Tangent line',
};

export const CUT_DIRECTIONS = ['climb', 'conventional', 'both'];
export const CUT_DIRECTION_LABELS = {
  climb: 'Climb (down-cut)',
  conventional: 'Conventional (up-cut)',
  both: 'Either way — shortest path',
};

export const PATTERNS = ['zigzag', 'oneway', 'flow'];
export const PATTERN_LABELS = {
  zigzag: 'Zig-zag',
  oneway: 'One-way',
  flow: 'Follow slope (3D)',
};

export const PROFILES = ['outer', 'all'];
export const PROFILE_LABELS = {
  outer: 'Outer profile only (cut the part out)',
  all: 'Every profile (holes and pockets too)',
};

export const CONTOUR_OUTLINES = ['part', 'level'];
export const CONTOUR_OUTLINE_LABELS = {
  part: 'One outline — the whole part (cut it free)',
  level: 'The profile at each depth (stepped part)',
};

export const SIDES = ['outside', 'inside', 'on'];
export const SIDE_LABELS = {
  outside: 'Outside the profile (leave the part)',
  inside: 'Inside the profile (open it up)',
  on: 'On the profile (no compensation)',
};

export const DRILL_DEPTH_MODES = ['hole', 'bottomZ'];
export const DRILL_DEPTH_LABELS = {
  hole: 'Each hole to its own floor',
  bottomZ: 'All holes to Bottom Z',
};

export const CHAMFER_EDGES = ['all', 'outer', 'holes'];
export const CHAMFER_EDGE_LABELS = {
  all: 'Every edge — outline and holes',
  outer: 'The outline only',
  holes: 'Holes and pockets only',
};

export const THREAD_FACES = ['auto', 'start', 'end'];
export const THREAD_FACE_LABELS = {
  auto: 'The threaded surface (biggest ⌀ in the range)',
  start: 'The diameter at Top Z',
  end: 'The diameter at Bottom Z',
};

export const THREAD_HANDS = ['right', 'left'];
export const THREAD_HAND_LABELS = {
  right: 'Right hand — from the free end toward the chuck',
  left: 'Left hand — from inside outward, and up to a shoulder',
};

export const ENGRAVE_MODES = ['depth', 'width'];
export const ENGRAVE_MODE_LABELS = {
  depth: 'Cut to a depth',
  width: 'Cut to a line width (V bit)',
};

const MILLING = ['face', 'contour2d', 'pocket', 'clear2d', 'adaptive', 'bore',
  'slot', 'parallel3d', 'waterline'];
// Every milling strategy, including the three MILLING leaves out because they
// take no stock allowance. Heights and clearances apply to all of them.
const MILLING_ALL = [...MILLING, 'drill', 'chamfer', 'engrave'];
const TURNING = ['turnFace', 'turnRough', 'turnFinish', 'turnGroove', 'turnThread',
  'turnDrill', 'turnBore', 'turnPart'];
const CLOSED_PASSES = ['contour2d', 'pocket', 'clear2d', 'waterline'];
// adaptive cuts closed and open passes alike, and picks its own entries, so it
// takes a cut direction but has no use for leads; a chamfer is a single lap so
// it wants leads but no ramp
const DIRECTIONAL = [...CLOSED_PASSES, 'adaptive', 'chamfer', 'engrave', 'bore', 'slot'];
const LEADABLE = [...CLOSED_PASSES, 'chamfer'];

/**
 * What Top Z and Bottom Z mean for this strategy.
 *
 * They are the same two planes everywhere, but not the same *decision*: on a
 * pocket they are the top and bottom of the cut, on a chamfer the top one is
 * the edge being broken and the bottom one is only a limit, and on an engrave
 * the pair is the surface and the floor of a mark thousandths deep. Naming them
 * per strategy is the difference between a field you understand and a field you
 * experiment with.
 */
export const HEIGHT_LABELS_BY_OP = {
  chamfer: {
    topZ: 'Edge Z (mm)',
    bottomZ: 'Never below Z (mm)',
    topHint: 'The edge the cutter breaks — the surface the sharp corner is in',
    bottomHint: 'A floor the chamfer may not reach past; it does not set the depth',
  },
  engrave: {
    topZ: 'Surface Z (mm)',
    bottomZ: 'Never below Z (mm)',
    topHint: 'The face being marked, where it is flat. On a face that is not, '
      + 'the pass follows the surface and this is only where it starts looking',
    bottomHint: 'A floor the mark may not reach past. It does not set the depth '
      + '— "Mark depth" does, because a depth is measured from the surface and '
      + 'a surface is not always at one Z',
  },
  drill: { bottomZ: 'Bottom Z (mm)', bottomHint: 'Used when every hole goes to one depth' },
  // On a lathe Z runs along the bar, so the pair is where a pass starts and
  // where it stops — not a top and a bottom.
  turnFace: {
    topZ: 'Bar end Z (mm)',
    bottomZ: 'Faced back to Z (mm)',
    topHint: 'Where the end of the bar is now',
    bottomHint: 'The finished face',
  },
  turnRough: {
    topZ: 'Start at Z (mm)',
    bottomZ: 'Turn up to Z (mm)',
    topHint: 'The free end of the bar, where each pass begins',
    bottomHint: 'How far along the bar to turn — toward the chuck',
  },
  turnFinish: {
    topZ: 'Start at Z (mm)',
    bottomZ: 'Finish up to Z (mm)',
    topHint: 'The free end of the bar, where the pass begins',
    bottomHint: 'How far along the profile to follow',
  },
  turnPart: {
    topZ: 'Bar end Z (mm)',
    bottomZ: 'Part off at Z (mm)',
    bottomHint: 'Where the blade goes in — the finished length of the part',
  },
  // A groove is a *width*, so its two heights are its two shoulders rather than
  // a start and a stop. That is the same pair meaning the same kind of thing —
  // two planes along the bar — and naming them for what they are is the
  // difference between a field you set and a field you guess at.
  turnGroove: {
    topZ: 'Groove starts at Z (mm)',
    bottomZ: 'Groove ends at Z (mm)',
    topHint: 'The shoulder nearer the tailstock. The blade cuts this one full width',
    bottomHint: 'The shoulder nearer the chuck. The distance between the two is '
      + 'the width of the groove',
  },
  turnThread: {
    topZ: 'Thread starts at Z (mm)',
    bottomZ: 'Thread runs to Z (mm)',
    topHint: 'The free end, where each pass begins. The tool leads in ahead of it',
    bottomHint: 'Where the thread stops — leave room for the tool to run out',
  },
  turnDrill: {
    topZ: 'Face Z (mm)',
    bottomZ: 'Drill to Z (mm)',
    topHint: 'The end face the drill starts on',
    bottomHint: 'The bottom of the hole, measured along the bar',
  },
  turnBore: {
    topZ: 'Mouth of the bore Z (mm)',
    bottomZ: 'Bore in to Z (mm)',
    topHint: 'Where the hole opens onto the end face',
    bottomHint: 'How far down the hole the bar goes — the reach of the bar limits this',
  },
};

/** Panel tabs shown for an operation. */
// Strategy first, and deliberately: it is what the operation *is*, and opening
// on Heights meant every selected operation threw three translucent planes over
// the part before you had asked anything about its depths.
export const OP_TABS = [
  { key: 'strategy', label: 'Strategy' },
  { key: 'heights', label: 'Heights' },
  { key: 'entry', label: 'Entry' },
  { key: 'tabs', label: 'Tabs' },
  { key: 'speeds', label: 'Speeds' },
  { key: 'drill', label: 'Drill' },
];

export const OP_PARAM_GROUPS = [
  {
    tab: 'heights',
    title: 'Heights',
    fields: [
      {
        key: 'topZ',
        label: 'Top Z (mm)',
        labelFor: (op) => HEIGHT_LABELS_BY_OP[op.type]?.topZ,
        hintFor: (op) => HEIGHT_LABELS_BY_OP[op.type]?.topHint,
        // Parting is the one operation with a single height. The blade goes in
        // at Bottom Z from whatever diameter the bar happens to be, and nothing
        // in the strategy reads the other one — so a "Bar end Z" field sat on
        // the Heights tab, threw a plane over the part in the viewport, and
        // moved nothing whatever it was set to.
        when: (op) => op.type !== 'turnPart',
      },
      {
        key: 'bottomZ',
        label: 'Bottom Z (mm)',
        labelFor: (op) => HEIGHT_LABELS_BY_OP[op.type]?.bottomZ,
        hintFor: (op) => HEIGHT_LABELS_BY_OP[op.type]?.bottomHint,
      },
      {
        // A lathe has no clearance *plane*. Z runs along the bar, the tool comes
        // in from the side, and what a rapid has to clear is a radius — which is
        // `clearanceX`, two groups down, and is the only one of the two any
        // turning strategy reads. Offering both put a field on the Heights tab
        // that looked like the safety height, sat above Top Z under the same
        // validation as a mill's, and did nothing whatsoever.
        key: 'clearanceHeight', label: 'Clearance Z (mm)', ops: MILLING_ALL,
        hint: 'The plane long rapids cross the part at — above everything in the way',
      },
      {
        // Read by the milling strategies, and on the lathe by centre drilling
        // alone: everything else there stands off by a radius, not by a height.
        key: 'entryGap', label: 'Entry gap (mm)', step: 0.5, min: 0,
        ops: [...MILLING_ALL, 'turnDrill'],
        hint: 'How far above the surface the tool stops rapiding and starts feeding. '
          + 'Measured from the level above, so each pass only feeds one stepdown',
      },
    ],
  },
  {
    tab: 'strategy',
    title: 'Stepping',
    fields: [
      {
        key: 'stepdown', label: 'Stepdown (mm)', min: 0.01,
        // Not turnFinish. A finish pass is *one* pass down the profile — that
        // is what the strategy is and what its card says — so a depth of cut
        // has nothing to divide. The field was there, defaulted to 0.2, and
        // read as a promise about how much the insert takes; the strategy has
        // never looked at it.
        ops: ['face', 'contour2d', 'pocket', 'clear2d', 'adaptive', 'waterline', 'bore', 'engrave',
          'slot', 'turnFace', 'turnRough', 'turnBore'],
        labelFor: (op) => (op.type === 'bore' ? 'Helix pitch (mm/turn)'
          : op.type === 'turnFace' ? 'Z per pass (mm)'
            : op.type === 'turnBore' ? 'Depth of cut (radial, outward, mm)'
              : op.type === 'turnRough' ? 'Depth of cut (radial, mm)'
                : null),
        hint: 'For waterline this is the Z spacing between contours — the cusp control',
        hintFor: (op) => (op.type === 'bore'
          ? 'How far the spiral descends in one turn round the bore — the whole cut is '
            + 'the entry, so this is what keeps the plunge gentle'
          : null),
      },
      {
        key: 'flatPasses', label: 'Pass at every flat face', type: 'checkbox',
        ops: ['pocket', 'clear2d', 'adaptive'],
        hint: 'The stepdown shares the depth out evenly and knows nothing about '
          + 'the part, so a floor sitting between two levels is cleared to the '
          + 'level above and then walled off from the one below — the stock in '
          + 'between stays on a finished surface for good. This gives each flat '
          + 'face a level of its own.',
      },
      {
        key: 'flatPassGap', label: 'Flat needs clearing (% of stepdown)',
        step: 5, min: 0, max: 100,
        ops: ['pocket', 'clear2d', 'adaptive'],
        when: (op) => op.params.flatPasses !== false,
        hint: 'How far a flat must sit from the passes either side before it is '
          + 'worth one of its own. A casting with a face every millimetre would '
          + 'otherwise become a program of shavings.',
      },
      {
        key: 'stepover', label: 'Stepover (×D)', step: 0.05, min: 0.01, max: 2,
        ops: ['face', 'pocket', 'clear2d', 'parallel3d', 'bore', 'slot'],
        labelFor: (op) => (op.type === 'bore' ? 'Radial step (×D)'
          : op.type === 'slot' ? 'Step between lanes (×D)' : null),
        hint: 'Fraction of the tool diameter stepped between passes',
        // a slot no wider than the cutter is one lane; there is nothing to step
        when: (op) => op.type !== 'slot'
          || (op.params.slotWidth ?? 0) > 0,
      },
      {
        key: 'engagement', label: 'Radial bite (×D)', step: 0.05, min: 0.01, max: 1, ops: ['adaptive'],
        hint: 'Width of cut the pass holds to — small bites buy full-depth passes at high feed (0.1–0.3 is usual)',
      },
      {
        key: 'stockToLeave', label: 'Stock to leave (mm)', min: 0,
        // turnGroove reads it — for the floor and, where the groove is wider
        // than the blade, for both shoulders — and was the one operation in
        // the app that read it without being asked
        ops: [...MILLING, 'turnRough', 'turnFinish', 'turnBore', 'turnGroove'],
        hintFor: (op) => (op.type === 'turnGroove'
          ? 'Left on the floor of the groove, and on both walls where the blade is '
            + 'narrower than the groove'
          : op.type.startsWith('turn')
            ? 'Radial allowance — how much bigger than finished size roughing leaves it'
            : null),
      },
      {
        key: 'restMachining', label: 'Skip what earlier passes cleared', type: 'checkbox',
        ops: MILLING,
        hint: 'Rest machining: leave out the ground the operations above this '
          + 'one already took off, so a second cutter only visits what the '
          + 'first could not reach. They have to have been generated for this '
          + 'to know what they did.',
      },
      {
        key: 'finishPasses', label: 'Finish passes', step: 1, min: 0, max: 20,
        ops: ['contour2d', 'clear2d', 'pocket', 'bore'],
        hint: 'Extra wall passes at final depth, each taking off a share of the stock to leave',
        // Hidden when there is nothing for them to take off — but *not* when
        // some are still asked for. Taking the stock to leave back to zero used
        // to hide the field with a live value behind it, and the strategy then
        // warned about a number the panel refused to show.
        when: (op) => (op.params.stockToLeave ?? 0) > 0 || (op.params.finishPasses ?? 0) > 0,
      },
      {
        key: 'resolution', label: 'Resolution (mm)', step: 0.05, min: 0, max: 2,
        ops: ['adaptive'],
        hint: 'The shortest move worth writing. A roughing pass follows offsets '
          + 'of the part chorded to the tolerance — a finishing number — so a '
          + 'fillet arrives as hundreds of blocks describing a surface that is '
          + 'about to be cut away again. Raising this shortens the program; the '
          + 'path may move by up to this much, and arcs are fitted no tighter '
          + 'than it. 0 writes every point.',
      },
      {
        key: 'tolerance', label: 'Tolerance (mm)', step: 0.005, min: 0.001, max: 1,
        // Chording tolerance: how far the emitted path may stray from the true
        // shape. Only the strategies that follow a *curve* have one — a groove
        // is a plunge, a thread is a straight pass, and a drill cycle is a
        // single move, so the field was three numbers that did nothing.
        ops: [...MILLING, 'chamfer', 'engrave', 'drill', 'turnFinish'],
        hintFor: (op) => (op.type === 'turnFinish'
          ? 'How finely the finished profile is stepped along. Smaller is a '
            + 'smoother curve and a longer program.'
          : null),
      },
    ],
  },
  {
    tab: 'strategy',
    title: 'Cutting',
    fields: [
      {
        key: 'contourOutline', label: 'Follow', type: 'select', ops: ['contour2d'],
        options: CONTOUR_OUTLINES, labels: CONTOUR_OUTLINE_LABELS,
        hint: 'The shadow of a part is not the same at every depth. One outline '
          + 'cuts a slot down the outside of the whole part — the cut-out. Per '
          + 'depth re-reads the profile at each level, which on a part that '
          + 'widens as it goes down sends the first passes through the middle '
          + 'of the billet.',
      },
      {
        key: 'profile', label: 'Cut which profiles', type: 'select', ops: ['contour2d'],
        options: PROFILES, labels: PROFILE_LABELS,
        hint: 'A part is cut out by its outline; "every profile" also sends the '
          + 'tool round every hole and pocket',
      },
      {
        key: 'side', label: 'Tool side', type: 'select', ops: ['contour2d', 'engrave'],
        options: SIDES, labels: SIDE_LABELS,
        hint: 'Which side of the profile the cutter runs on',
        hintFor: (op) => (op.type === 'engrave'
          ? 'Engraving wants "on": the line is the feature, so any compensation '
            + 'at all moves the mark off it'
          : null),
      },
      {
        key: 'engraveLines', label: 'Which lines', type: 'select', ops: ['engrave'],
        options: CHAMFER_EDGES, labels: {
          all: 'Every boundary — outline and holes',
          outer: 'The outline only',
          holes: 'Holes and pockets only',
        },
        // a drawing has no "holes": every path in it is a line somebody drew
        when: (op) => !op.params.drawingId,
      },
      {
        key: 'direction', label: 'Direction', type: 'select',
        options: CUT_DIRECTIONS, labels: CUT_DIRECTION_LABELS,
        ops: DIRECTIONAL,
        hint: 'Climb is the finish; conventional is what an old machine with '
          + 'backlash wants. "Either way" lets a roughing pass take each cut '
          + 'from whichever end it is already near, which is shorter. One motion '
          + 'is bidirectional whatever this says: a ramp entry into an open '
          + 'channel zig-zags down it and has to come back over the wedge it '
          + 'left — set Ramp angle to 0 if that matters.',
      },
      {
        key: 'pattern', label: 'Pattern', type: 'select',
        options: PATTERNS, labels: PATTERN_LABELS,
        ops: ['face', 'parallel3d'],
        // facing is a flat operation; there is no slope for it to follow
        filterOptions: (op) => (op.type === 'face'
          ? PATTERNS.filter((p) => p !== 'flow') : PATTERNS),
      },
      {
        key: 'angleDeg', label: 'Raster angle (°)', min: -360, max: 360,
        ops: ['face', 'parallel3d'],
        hint: 'Direction the raster lines run, measured from +X',
        when: (op) => (op.params.pattern ?? 'zigzag') !== 'flow',
      },
      {
        key: 'linkDistance', label: 'Stay down across (mm)', min: 0, step: 1,
        ops: ['parallel3d'], nullable: true, placeholder: '3 × tool ⌀',
        hint: 'A raster over anything but a block breaks at every hole and every '
          + 'step, and climbing to clearance for each one is most of the program. '
          + 'A break shorter than this is driven straight across instead — but '
          + 'only when the part underneath is already below the cutter, so the '
          + 'link can never gouge. 0 retracts at every break.',
        when: (op) => (op.params.pattern ?? 'zigzag') !== 'flow',
      },
    ],
  },
  {
    tab: 'strategy',
    title: 'Chamfer',
    fields: [
      {
        key: 'chamferWidth', label: 'Chamfer width (mm)', min: 0.01, step: 0.1, ops: ['chamfer'],
        hint: 'The width of the flat you want to see on the edge, measured across '
          + 'the top face. The depth follows from the cutter\'s point angle',
      },
      {
        key: 'chamferEdges', label: 'Break which edges', type: 'select', ops: ['chamfer'],
        options: CHAMFER_EDGES, labels: CHAMFER_EDGE_LABELS,
        hint: 'Which side of each boundary the cutter goes is not a setting — the '
          + 'outline is chamfered from outside it and a hole from inside it',
      },
      {
        key: 'chamferPasses', label: 'Passes', step: 1, min: 1, max: 12, ops: ['chamfer'],
        hint: 'A wide chamfer taken in one bite loads the point of the cutter; each '
          + 'pass cuts a slightly wider chamfer than the one before',
      },
      {
        key: 'chamferClearance', label: 'Tip clearance (mm)', min: 0, step: 0.1, ops: ['chamfer'],
        hint: 'How far the tip is kept below the bottom of the chamfer, so the flat '
          + 'on the end of the cutter never rubs the wall underneath',
      },
      { key: 'chamferReport', type: 'report', ops: ['chamfer'] },
    ],
  },
  {
    tab: 'strategy',
    title: 'Slot',
    fields: [
      {
        key: 'drawingId', label: 'Follow', type: 'drawing', ops: ['slot'],
        hint: 'A DXF of the slot centreline. A keyway or a cable channel is a '
          + 'line you draw, not an outline the solid has — with no drawing the '
          + 'pass falls back to the part\'s own boundary at Top Z.',
      },
      {
        key: 'slotWidth', label: 'Slot width (mm)', min: 0, step: 0.5, ops: ['slot'],
        hint: 'The finished width. 0 is the cutter\'s own — a single full-width '
          + 'pass. Anything wider is cut down the middle first and then out to '
          + 'each wall, so the wall passes have somewhere to put the chip.',
      },
      { key: 'slotReport', type: 'report', ops: ['slot'] },
    ],
  },
  {
    tab: 'strategy',
    title: 'Bore',
    fields: [
      {
        key: 'boreDiameter', label: 'Only holes of ⌀ (mm)', min: 0, ops: ['bore'],
        hint: '0 bores every round hole the cutter fits inside',
      },
      {
        key: 'diameterTol', label: 'Diameter match (±mm)', step: 0.1, min: 0, max: 10, ops: ['bore'],
        when: (op) => (op.params.boreDiameter ?? 0) > 0,
      },
      {
        key: 'preDrilled', label: 'Already drilled ⌀ (mm)', min: 0, ops: ['bore'],
        hint: 'The hole that is there before this pass runs. 0 bores from solid, '
          + 'which means clearing the middle out as well as the wall',
      },
      {
        key: 'depthMode', label: 'Depth', type: 'select', ops: ['bore'],
        options: DRILL_DEPTH_MODES, labels: DRILL_DEPTH_LABELS,
      },
      { key: 'boreReport', type: 'report', ops: ['bore'] },
    ],
  },
  {
    tab: 'strategy',
    title: 'Engraving',
    fields: [
      {
        key: 'drawingId', label: 'Follow', type: 'drawing', ops: ['engrave'],
        hint: 'A DXF imported onto the stock, or the part\'s own outline. A logo, '
          + 'a part number and a fold line are none of them features of the '
          + 'solid, so a drawing is the only way to cut one.',
      },
      {
        key: 'parallelBoundary', label: 'How far past the part', type: 'select',
        ops: ['parallel3d'],
        options: ['part', 'stock'],
        labels: {
          part: 'Stop at the part (plus the cutter radius)',
          stock: 'The whole area, down to Bottom Z',
        },
        hint: 'A drop-cutter raster follows whatever is under the tool, so past '
          + 'the edge of the part it walks down the wall and ploughs a lap round '
          + 'the base at Bottom Z — through ground the roughing pass already '
          + 'took away. Inside geometry is the opposite case and is left alone: '
          + 'there the tool going as deep as it can reach is the right answer.',
      },
      {
        key: 'boundaryExtra', label: 'Overrun past the part (mm)', min: 0, step: 0.5,
        ops: ['parallel3d'],
        when: (op) => (op.params.parallelBoundary ?? 'part') !== 'stock',
        hint: 'On top of the cutter radius. Worth a little where the wall has to '
          + 'be finished right to the bottom and the floor beside it is scrap.',
      },
      {
        key: 'engraveFollow', label: 'Follow the surface', type: 'checkbox',
        ops: ['engrave'],
        hint: 'The depth of a mark is measured from the face it is scribed on. '
          + 'Off, every stroke is cut at one Z — which is the same thing on a '
          + 'flat face and breaks the surface halfway along a sloped one.',
      },
      {
        key: 'engraveMode', label: 'Depth from', type: 'select', ops: ['engrave'],
        options: ENGRAVE_MODES, labels: ENGRAVE_MODE_LABELS,
        hint: 'With a V bit the depth is the width — say which one you actually care about',
      },
      {
        key: 'engraveDepth', label: 'Mark depth (mm)', min: 0.01, max: 5, step: 0.05,
        ops: ['engrave'],
        when: (op) => (op.params.engraveMode ?? 'depth') !== 'width',
        hint: 'How far below the surface the mark is cut — a depth, not a '
          + 'height. Bottom Z is only a limit on it; on a face that is not flat '
          + 'there is no single Z the mark sits at, which is the whole reason '
          + 'the pass follows the surface.',
      },
      {
        key: 'grooveWidth', label: 'Line width (mm)', min: 0.01, step: 0.05, ops: ['engrave'],
        when: (op) => (op.params.engraveMode ?? 'depth') === 'width',
      },
      { key: 'engraveReport', type: 'report', ops: ['engrave'] },
    ],
  },
  {
    tab: 'strategy',
    title: 'Turning',
    fields: [
      {
        // Outside work only. A clearance *radius* is somewhere clear of the
        // bar, and the two operations that work down the middle of it can
        // never go there: a centre drill lives at X0 for the whole cycle, and a
        // boring bar retracts to just inside its own pilot hole — out past the
        // bar and it would have to come back in through the end face. Both
        // ignored the field, which is a safety number that looked set.
        key: 'clearanceX', label: 'Clearance radius (mm)', min: 0,
        ops: TURNING.filter((t) => t !== 'turnDrill' && t !== 'turnBore'),
        hint: 'How far off the axis the tool travels between cuts. 0 works it '
          + 'out from the bar, which is what you want unless something is in the way.',
      },
      {
        key: 'faceToRadius', label: 'Face in to radius (mm)', min: 0, ops: ['turnFace'],
        hint: '0 faces right through the centre. Leave a stub if the part is '
          + 'held on a mandrel or there is a centre in the end.',
      },
      {
        key: 'partOffRadius', label: 'Part down to radius (mm)', min: 0, ops: ['turnPart'],
        hint: '0 cuts right through. A small radius leaves a pip you snap off, '
          + 'which is kinder to the blade on a big bar.',
      },
      {
        key: 'partWiden', label: 'Cut the slot wider by (mm)', min: 0, step: 0.1,
        ops: ['turnPart'],
        hint: 'A slot exactly as wide as the blade closes on it as the bar '
          + 'springs, and the blade is trapped at the bottom of it. A few tenths '
          + 'wider gives the tool somewhere to be. Taken off the chuck side, so '
          + 'the part still finishes at Bottom Z.',
      },
      {
        key: 'peck', label: 'Peck (mm)', min: 0, ops: ['turnPart', 'turnGroove', 'turnDrill'],
        hint: 'How far the tool goes in before backing out to clear the chip. '
          + '0 plunges the whole way, which is how blades get broken.',
      },
      {
        key: 'dwell', label: 'Dwell at depth (s)', min: 0, max: 60, ops: ['turnDrill'],
        hint: 'Pause at the bottom of the hole to clean it up before retracting',
        when: (op) => !((op.params.peck ?? 0) > 0),
      },
      { key: 'turnReport', type: 'report', ops: TURNING },
    ],
  },
  {
    tab: 'strategy',
    title: 'Groove',
    fields: [
      {
        key: 'grooveRadius', label: 'Floor radius (mm)', min: 0, ops: ['turnGroove'],
        nullable: true, placeholder: 'a groove in the bar',
        hint: 'The radius the bottom of the groove sits at. On the G-code this '
          + 'comes out as a diameter, like every other X. Blank cuts a groove of '
          + 'a sensible depth into whatever diameter is there; 0 goes to the '
          + 'centreline, which parts the bar off.',
      },
      {
        key: 'grooveInternal', label: 'Inside a bore', type: 'checkbox', ops: ['turnGroove'],
        hint: 'An internal groove is cut outward from the bore rather than inward '
          + 'from the bar — the tool retracts toward the axis, not away from it',
      },
    ],
  },
  {
    tab: 'strategy',
    title: 'Thread',
    fields: [
      {
        key: 'threadPitch', label: 'Pitch (mm)', min: 0.1, step: 0.05, ops: ['turnThread'],
        hint: 'The distance from one crest to the next. M10×1.5 is a 1.5mm pitch.',
      },
      {
        key: 'threadPasses', label: 'Passes (at least)', step: 1, min: 1, max: 40,
        ops: ['turnThread'],
        hint: 'A minimum, not the answer: more passes are added if the first '
          + 'bite would come out deeper than the limit below.',
      },
      {
        key: 'threadFirstDepth', label: 'Deepest first pass (mm)', min: 0, step: 0.05,
        ops: ['turnThread'],
        hint: 'The first pass of a shared-area schedule is the biggest one there '
          + 'is — 41% of the form in six passes. Capping it is what makes the '
          + 'infeed gradual. 0 uses the pass count as given.',
      },
      {
        key: 'threadDegression', label: 'Infeed shape', min: 1, max: 2, step: 0.1,
        ops: ['turnThread'],
        hint: '2 shares the chip area out equally, which is what a threading '
          + 'cycle does. 1 is equal depth per pass — lighter at the start, '
          + 'heaviest at the end.',
      },
      {
        key: 'threadSpringPasses', label: 'Spring passes', min: 0, max: 5, step: 1,
        ops: ['turnThread'],
        hint: 'Repeats of the last pass at the same depth. The bar springs away '
          + 'from the insert under load, and this takes back what it sprang.',
      },
      {
        key: 'threadHand', label: 'Hand', type: 'select', ops: ['turnThread'],
        options: THREAD_HANDS, labels: THREAD_HAND_LABELS,
        hint: 'A left-hand thread is cut running the other way along the bar — '
          + 'which is also the only way to thread up to a shoulder.',
      },
      {
        key: 'threadDepth', label: 'Form depth (mm)', min: 0, step: 0.05, ops: ['turnThread'],
        hint: '0 works it out from the pitch, which is right for a standard ISO '
          + 'thread. Set it for anything else.',
      },
      {
        key: 'threadFace', label: 'Thread which face', type: 'select', ops: ['turnThread'],
        options: THREAD_FACES, labels: THREAD_FACE_LABELS,
        hint: 'A thread that runs off a shoulder has two diameters in its Z '
          + 'range, and the operation has to be told which one it sits on. '
          + 'Ignored when a start radius is set below.',
        when: (op) => !((op.params.threadStartRadius ?? 0) > 0),
      },
      {
        key: 'threadStartRadius', label: 'Start at radius (mm)', min: 0, ops: ['turnThread'],
        hint: '0 reads the major diameter off the part where the thread is. The '
          + 'diameter has to be turned to size before this runs.',
      },
      {
        key: 'threadInternal', label: 'Internal thread', type: 'checkbox', ops: ['turnThread'],
        hint: 'Cut outward from a bore rather than inward from a diameter',
      },
      { key: 'threadReport', type: 'report', ops: ['turnThread'] },
    ],
  },
  {
    tab: 'strategy',
    title: 'Bore',
    fields: [
      {
        key: 'boreStartRadius', label: 'Pilot hole radius (mm)', min: 0, ops: ['turnBore'],
        hint: 'The hole that is already there. 0 uses the tube\'s own bore, or '
          + 'guesses from the part — drill it first and this is the drill\'s size.',
      },
      {
        key: 'boreDepthLimit', label: 'Bar reaches (mm)', min: 0, ops: ['turnBore'],
        hint: 'How far the bar may go into the hole before the overhang is more '
          + 'than it can hold. 0 uses the tool\'s own figure.',
      },
    ],
  },
  {
    tab: 'entry',
    title: 'Entry & exit',
    fields: [
      {
        key: 'rampAngle', label: 'Ramp angle (°)', min: 0, max: 45,
        ops: ['contour2d', 'pocket', 'clear2d', 'adaptive', 'slot'],
        hint: '0 plunges straight down; a few degrees ramps in along the path',
        hintFor: (op) => (op.type === 'slot'
          ? 'Not optional here. A slot is a full-width cut on every side of the '
            + 'cutter at once, and plunging into one is how end mills get '
            + 'mistaken for drills.'
          : null),
      },
      {
        key: 'leadType', label: 'Lead in/out', type: 'select',
        options: LEAD_TYPES, labels: LEAD_TYPE_LABELS,
        ops: LEADABLE,
      },
      {
        key: 'leadRadius', label: 'Lead radius (mm)', min: 0,
        ops: LEADABLE,
        when: (op) => (op.params.leadType ?? 'none') !== 'none',
      },
    ],
  },
  {
    tab: 'tabs',
    title: 'Holding tabs',
    fields: [
      {
        key: 'tabCount', label: 'Tabs (count)', step: 1, min: 0, max: 24, ops: ['contour2d'],
        hint: 'Bridges of stock left standing so the part does not break free '
          + 'when the profile closes',
      },
      {
        key: 'tabWidth', label: 'Tab width (mm)', min: 0.1, ops: ['contour2d'],
        hint: 'The width of the bridge left in the part. The cutter lifts over this '
          + 'plus its own diameter, so a tab narrower than the tool still stands',
        when: (op) => (op.params.tabCount ?? 0) > 0,
      },
      {
        key: 'tabHeight', label: 'Tab height (mm)', min: 0.1, ops: ['contour2d'],
        hint: 'How tall the bridge stands above the bottom of the cut',
        when: (op) => (op.params.tabCount ?? 0) > 0,
      },
      {
        key: 'tabReport', type: 'report', ops: ['contour2d'],
        when: (op) => (op.params.tabCount ?? 0) > 0,
      },
    ],
  },
  {
    tab: 'speeds',
    title: 'Speeds & feeds',
    fields: [
      {
        key: 'spindleMode', label: 'Spindle holds', type: 'select', ops: TURNING,
        options: ['rpm', 'css'],
        labels: {
          rpm: 'A fixed speed (G97)',
          css: 'A surface speed (G96)',
        },
        hint: 'A lathe cuts at a surface speed, and at a fixed rpm that speed '
          + 'falls away as the tool works in toward the axis — which is why the '
          + 'middle of a faced end comes out burnished rather than cut. G96 lets '
          + 'the control wind the spindle up to hold it.',
      },
      {
        key: 'surfaceSpeed', label: 'Surface speed (m/min)', step: 5, min: 0,
        ops: TURNING,
        when: (op) => op.params.spindleMode === 'css',
        hint: 'The number off the insert box for the material you are cutting — '
          + '90–120 for steel with carbide, 200+ for aluminium.',
      },
      {
        key: 'cssMaxRpm', label: 'Never above (rpm)', step: 100, min: 0, ops: TURNING,
        when: (op) => op.params.spindleMode === 'css',
        hint: 'The cap, and it is not optional: at the centre of a facing cut '
          + 'the commanded speed goes to infinity. 0 uses the operation\'s own '
          + 'RPM as the ceiling.',
      },
      {
        key: 'spindleRpm', label: 'Spindle RPM', step: 100, min: 0, nullable: true,
        hint: 'Blank inherits the tool default',
        hintFor: (op) => (op.params.spindleMode === 'css'
          ? 'Still needed: it is what the cycle time and the chip load are '
            + 'worked out from, and what a control without G96 falls back to.'
          : null),
      },
      {
        key: 'feedCut', label: 'Feed (mm/min)', step: 10, min: 0, nullable: true,
        hint: 'Blank inherits the tool default',
      },
      {
        key: 'feedPlunge', label: 'Plunge (mm/min)', step: 10, min: 0, nullable: true,
        hint: 'Blank inherits the tool default',
      },
      {
        key: 'coolant', label: 'Coolant', type: 'select',
        options: ['off', 'flood', 'mist'],
        labels: { off: 'Off', flood: 'Flood (M8)', mist: 'Mist (M7)' },
        hint: 'A per-operation decision: flood for roughing, off for a finishing '
          + 'pass you want to watch, mist where flood would wash the chips back '
          + 'into the cut. Turned off again at the end of the program.',
      },
      { key: 'cuttingReport', type: 'report' },
    ],
  },
  {
    tab: 'drill',
    title: 'Drilling',
    fields: [
      {
        key: 'drawingId', label: 'Positions from', type: 'drawing', ops: ['drill'],
        hint: 'A DXF whose circles are the hole positions. With no drawing the '
          + 'holes are recognised off the solid, which is what a modelled part '
          + 'gives — but a plate is usually drawn, and a circle is how a hole '
          + 'position arrives.',
      },
      {
        key: 'depthMode', label: 'Depth', type: 'select', ops: ['drill'],
        options: DRILL_DEPTH_MODES, labels: DRILL_DEPTH_LABELS,
        hint: 'Blind holes of different depths want their own floors, not one Bottom Z',
        // a drawn circle has no floor to stop at, so there is nothing to choose
        when: (op) => !op.params.drawingId,
      },
      {
        key: 'diameterTol', label: 'Diameter match (±mm)', step: 0.1, min: 0, max: 10, ops: ['drill'],
        hint: 'How far a hole may be from the drill diameter and still be drilled',
      },
      {
        key: 'peck', label: 'Peck depth (mm)', min: 0, ops: ['drill'],
        hint: '0 drills in one go (G81); above 0 pecks and clears chips (G83)',
      },
      {
        key: 'dwell', label: 'Dwell (s)', min: 0, max: 60, ops: ['drill'],
        hint: 'Pause at depth to clean up the bottom of the hole (G82)',
        when: (op) => !((op.params.peck ?? 0) > 0),
      },
    ],
  },
];

/** Does this field belong on the given operation? */
export function paramApplies(field, op) {
  if (field.ops && !field.ops.includes(op.type)) return false;
  if (field.when && !field.when(op)) return false;
  return true;
}

/** Which of the OP_TABS actually contain applicable fields for this op. */
export function tabsForOp(op) {
  const active = new Set();
  for (const group of OP_PARAM_GROUPS) {
    if (group.fields.some((f) => paramApplies(f, op))) active.add(group.tab);
  }
  return OP_TABS.filter((t) => active.has(t.key));
}
