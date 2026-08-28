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

/**
 * The default catalogue: metric tooling for a hobby-class machine.
 *
 * name, type, diameter and the cutting defaults that go with them.
 */
const METRIC_GROUPS = [
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
      { name: '4.2mm tapping drill M5', type: 'drill', diameter: 4.2, tipAngle: 118, flutes: 2, fluteLength: 35, spindleRpm: 2600, feedCut: 170, feedPlunge: 170 },
      { name: '5mm drill', type: 'drill', diameter: 5, tipAngle: 118, flutes: 2, fluteLength: 40, spindleRpm: 2200, feedCut: 180, feedPlunge: 180 },
      { name: '6mm drill', type: 'drill', diameter: 6, tipAngle: 118, flutes: 2, fluteLength: 45, spindleRpm: 1800, feedCut: 200, feedPlunge: 200 },
      { name: '6.8mm tapping drill M8', type: 'drill', diameter: 6.8, tipAngle: 118, flutes: 2, fluteLength: 50, spindleRpm: 1650, feedCut: 210, feedPlunge: 210 },
      { name: '8mm drill', type: 'drill', diameter: 8, tipAngle: 118, flutes: 2, fluteLength: 55, spindleRpm: 1400, feedCut: 220, feedPlunge: 220 },
      { name: '8.5mm tapping drill M10', type: 'drill', diameter: 8.5, tipAngle: 118, flutes: 2, fluteLength: 60, spindleRpm: 1300, feedCut: 230, feedPlunge: 230 },
      { name: '10mm drill', type: 'drill', diameter: 10, tipAngle: 118, flutes: 2, fluteLength: 65, spindleRpm: 1100, feedCut: 240, feedPlunge: 240 },
    ],
  },
  {
    // Spot and centre drills: their own family, not a stubby jobber drill.
    //
    // Everything about one is different. It is spun three times as fast at a
    // fraction of the chip load, because it only ever cuts on its point; it is
    // deliberately short, because the stiffness is the whole reason it goes in
    // first; and its diameter is *not* the hole's — it is bigger than most of
    // what it spots. Calling it a drill made every one of those a value to
    // correct by hand, and made a spot drill the tool a drilling pass reached
    // for first.
    group: 'Spot & centre drills',
    tools: [
      { name: '3mm centre drill 60°', type: 'spot', diameter: 3, tipAngle: 60, flutes: 2, fluteLength: 4, spindleRpm: 8000, feedCut: 120, feedPlunge: 120 },
      { name: '6mm spot drill 90°', type: 'spot', diameter: 6, tipAngle: 90, flutes: 2, fluteLength: 7, spindleRpm: 6650, feedCut: 200, feedPlunge: 200 },
      { name: '8mm spot drill 90°', type: 'spot', diameter: 8, tipAngle: 90, flutes: 2, fluteLength: 10, spindleRpm: 4950, feedCut: 200, feedPlunge: 200 },
      { name: '10mm spot drill 90°', type: 'spot', diameter: 10, tipAngle: 90, flutes: 2, fluteLength: 12, spindleRpm: 4000, feedCut: 200, feedPlunge: 200 },
      // Ground at more than the drill's own point, so the drill touches at its
      // outer corners and not on the chisel edge it cannot cut with.
      { name: '12mm spot drill 120°', type: 'spot', diameter: 12, tipAngle: 120, flutes: 2, fluteLength: 14, spindleRpm: 3300, feedCut: 200, feedPlunge: 200 },
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
    // Taps, by the thread they cut. The pitch is not a detail of the tool, it
    // *is* the tool: one turn advances it one pitch, and the control has to
    // know the number to lock the axis to the spindle. Speeds are a fraction of
    // what the same size of end mill takes, because a tap is cutting on every
    // flute at full depth and cannot be backed off.
    group: 'Taps',
    tools: [
      { name: 'M2×0.4 tap', type: 'tap', diameter: 2, pitch: 0.4, flutes: 3, fluteLength: 10, spindleRpm: 1000, feedCut: 400, feedPlunge: 400 },
      { name: 'M2.5×0.45 tap', type: 'tap', diameter: 2.5, pitch: 0.45, flutes: 3, fluteLength: 12, spindleRpm: 800, feedCut: 360, feedPlunge: 360 },
      { name: 'M3×0.5 tap', type: 'tap', diameter: 3, pitch: 0.5, flutes: 3, fluteLength: 16, spindleRpm: 500, feedCut: 250, feedPlunge: 250 },
      { name: 'M4×0.7 tap', type: 'tap', diameter: 4, pitch: 0.7, flutes: 3, fluteLength: 20, spindleRpm: 450, feedCut: 315, feedPlunge: 315 },
      { name: 'M5×0.8 tap', type: 'tap', diameter: 5, pitch: 0.8, flutes: 3, fluteLength: 22, spindleRpm: 400, feedCut: 320, feedPlunge: 320 },
      { name: 'M6×1.0 tap', type: 'tap', diameter: 6, pitch: 1, flutes: 3, fluteLength: 25, spindleRpm: 350, feedCut: 350, feedPlunge: 350 },
      { name: 'M8×1.25 tap', type: 'tap', diameter: 8, pitch: 1.25, flutes: 3, fluteLength: 30, spindleRpm: 280, feedCut: 350, feedPlunge: 350 },
      { name: 'M10×1.5 tap', type: 'tap', diameter: 10, pitch: 1.5, flutes: 3, fluteLength: 35, spindleRpm: 220, feedCut: 330, feedPlunge: 330 },
      { name: 'M12×1.75 tap', type: 'tap', diameter: 12, pitch: 1.75, flutes: 4, fluteLength: 40, spindleRpm: 190, feedCut: 333, feedPlunge: 333 },
      // The fine series, which is a different tap and not a setting on the
      // coarse one — an M8×1 in a hole drilled for an M8×1.25 cuts about half
      // a thread, and the pitch is what tells the control how fast to feed.
      { name: 'M8×1.0 fine tap', type: 'tap', diameter: 8, pitch: 1, flutes: 3, fluteLength: 30, spindleRpm: 280, feedCut: 280, feedPlunge: 280 },
      { name: 'M10×1.25 fine tap', type: 'tap', diameter: 10, pitch: 1.25, flutes: 3, fluteLength: 35, spindleRpm: 220, feedCut: 275, feedPlunge: 275 },
      { name: 'M12×1.5 fine tap', type: 'tap', diameter: 12, pitch: 1.5, flutes: 4, fluteLength: 40, spindleRpm: 190, feedCut: 285, feedPlunge: 285 },
    ],
  },
  {
    // Thread mills. One cutter does every diameter of the same pitch, in either
    // hand, inside or out — so they are listed by pitch and by how far down
    // they reach, which is what actually decides whether one will do the job.
    group: 'Thread mills',
    tools: [
      { name: '⌀2.5 thread mill 0.45mm', type: 'threadmill', diameter: 2.5, pitch: 0.45, flutes: 2, fluteLength: 8, spindleRpm: 9000, feedCut: 240, feedPlunge: 80 },
      { name: '⌀3.5 thread mill 0.5mm', type: 'threadmill', diameter: 3.5, pitch: 0.5, flutes: 3, fluteLength: 10, spindleRpm: 6000, feedCut: 300, feedPlunge: 100 },
      { name: '⌀4.8 thread mill 0.8mm', type: 'threadmill', diameter: 4.8, pitch: 0.8, flutes: 3, fluteLength: 14, spindleRpm: 5000, feedCut: 320, feedPlunge: 110 },
      { name: '⌀6 thread mill 1.0mm', type: 'threadmill', diameter: 6, pitch: 1, flutes: 3, fluteLength: 18, spindleRpm: 4500, feedCut: 350, feedPlunge: 120 },
      { name: '⌀8 thread mill 1.25mm', type: 'threadmill', diameter: 8, pitch: 1.25, flutes: 4, fluteLength: 24, spindleRpm: 4000, feedCut: 400, feedPlunge: 130 },
      { name: '⌀10 thread mill 1.5mm', type: 'threadmill', diameter: 10, pitch: 1.5, flutes: 4, fluteLength: 28, spindleRpm: 2850, feedCut: 400, feedPlunge: 140 },
      { name: '⌀12 thread mill 1.75mm', type: 'threadmill', diameter: 12, pitch: 1.75, flutes: 4, fluteLength: 32, spindleRpm: 2400, feedCut: 400, feedPlunge: 140 },
      // Fine pitches, on a cutter of the same size: the pitch is the tooth
      // form, so one cutter never does two of them.
      { name: '⌀6 thread mill 0.75mm', type: 'threadmill', diameter: 6, pitch: 0.75, flutes: 3, fluteLength: 18, spindleRpm: 4500, feedCut: 350, feedPlunge: 120 },
      { name: '⌀8 thread mill 1.0mm', type: 'threadmill', diameter: 8, pitch: 1, flutes: 4, fluteLength: 24, spindleRpm: 3600, feedCut: 400, feedPlunge: 130 },
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

/**
 * The imperial catalogue, as an example of what a second one looks like.
 *
 * Not a translation of the metric one. A shop working in inches buys different
 * cutters, not the same cutters described in other units — a 1/4" end mill is
 * not a 6mm one, and a 1/4-20 UNC is not an M6. Everything here is still stored
 * in millimetres, because the geometry engine has exactly one unit and a second
 * one is how a program comes out twenty-five times too big; the *names* are
 * what a machinist reaches for.
 *
 * It is also here to be copied: "Duplicate to mine" in the tool
 * library gives you an editable version, which is how a shop's own drawer gets
 * built without typing forty tools in from nothing.
 */
const IMPERIAL_GROUPS = [
  {
    group: 'End mills',
    tools: [
      { name: '1/8" flat 2FL', type: 'flat', diameter: 3.175, flutes: 2, fluteLength: 12, spindleRpm: 18000, feedCut: 750, feedPlunge: 260 },
      { name: '1/4" flat 3FL', type: 'flat', diameter: 6.35, flutes: 3, fluteLength: 19, spindleRpm: 12000, feedCut: 1200, feedPlunge: 420 },
      { name: '3/8" flat 3FL', type: 'flat', diameter: 9.525, flutes: 3, fluteLength: 25, spindleRpm: 8350, feedCut: 1300, feedPlunge: 460 },
      { name: '1/2" flat 4FL', type: 'flat', diameter: 12.7, flutes: 4, fluteLength: 32, spindleRpm: 6250, feedCut: 1750, feedPlunge: 610 },
    ],
  },
  {
    group: 'Ball nose',
    tools: [
      { name: '1/8" ball', type: 'ball', diameter: 3.175, flutes: 2, fluteLength: 12, spindleRpm: 18000, feedCut: 560, feedPlunge: 200 },
      { name: '1/4" ball', type: 'ball', diameter: 6.35, flutes: 3, fluteLength: 19, spindleRpm: 11500, feedCut: 990, feedPlunge: 350 },
      { name: '1/2" ball', type: 'ball', diameter: 12.7, flutes: 4, fluteLength: 32, spindleRpm: 5750, feedCut: 1310, feedPlunge: 460 },
    ],
  },
  {
    group: 'Drills & spotting',
    tools: [
      // A tapping drill in this world is a number or a letter, not a size —
      // the name is what you go to the index looking for.
      { name: '#25 drill (10-24 tap)', type: 'drill', diameter: 3.797, tipAngle: 118, flutes: 2, fluteLength: 30, spindleRpm: 2900, feedCut: 175, feedPlunge: 175 },
      { name: '#7 drill (1/4-20 tap)', type: 'drill', diameter: 5.105, tipAngle: 118, flutes: 2, fluteLength: 40, spindleRpm: 2200, feedCut: 180, feedPlunge: 180 },
      { name: '1/4" drill', type: 'drill', diameter: 6.35, tipAngle: 118, flutes: 2, fluteLength: 45, spindleRpm: 1750, feedCut: 180, feedPlunge: 180 },
      { name: '5/16" drill (3/8-16 tap)', type: 'drill', diameter: 7.938, tipAngle: 118, flutes: 2, fluteLength: 55, spindleRpm: 1400, feedCut: 180, feedPlunge: 180 },
      { name: '1/2" drill', type: 'drill', diameter: 12.7, tipAngle: 118, flutes: 2, fluteLength: 70, spindleRpm: 875, feedCut: 180, feedPlunge: 180 },
      { name: '1/4" spot drill 90°', type: 'spot', diameter: 6.35, tipAngle: 90, flutes: 2, fluteLength: 8, spindleRpm: 6250, feedCut: 200, feedPlunge: 200 },
      { name: '1/2" spot drill 90°', type: 'spot', diameter: 12.7, tipAngle: 90, flutes: 2, fluteLength: 15, spindleRpm: 3150, feedCut: 200, feedPlunge: 200 },
    ],
  },
  {
    // The unified coarse series, by the pitch it actually is: threads per inch
    // is a *rate*, and a control feeds in millimetres per turn, so the number
    // stored is 25.4/TPI and the name is what is stamped on the shank.
    group: 'Taps (UNC)',
    tools: [
      { name: '#10-24 UNC tap', type: 'tap', diameter: 4.826, pitch: 1.058, flutes: 3, fluteLength: 22, spindleRpm: 550, feedCut: 582, feedPlunge: 582 },
      { name: '1/4-20 UNC tap', type: 'tap', diameter: 6.35, pitch: 1.27, flutes: 3, fluteLength: 25, spindleRpm: 400, feedCut: 508, feedPlunge: 508 },
      { name: '5/16-18 UNC tap', type: 'tap', diameter: 7.938, pitch: 1.411, flutes: 3, fluteLength: 28, spindleRpm: 300, feedCut: 423, feedPlunge: 423 },
      { name: '3/8-16 UNC tap', type: 'tap', diameter: 9.525, pitch: 1.588, flutes: 3, fluteLength: 32, spindleRpm: 300, feedCut: 476, feedPlunge: 476 },
      { name: '1/2-13 UNC tap', type: 'tap', diameter: 12.7, pitch: 1.954, flutes: 4, fluteLength: 38, spindleRpm: 300, feedCut: 586, feedPlunge: 586 },
    ],
  },
  {
    group: 'Thread mills',
    tools: [
      { name: '0.185" thread mill 20 TPI', type: 'threadmill', diameter: 4.7, pitch: 1.27, flutes: 3, fluteLength: 14, spindleRpm: 5000, feedCut: 320, feedPlunge: 110 },
      { name: '0.300" thread mill 16 TPI', type: 'threadmill', diameter: 7.62, pitch: 1.588, flutes: 3, fluteLength: 22, spindleRpm: 3750, feedCut: 300, feedPlunge: 105 },
      { name: '0.400" thread mill 13 TPI', type: 'threadmill', diameter: 10.16, pitch: 1.954, flutes: 4, fluteLength: 28, spindleRpm: 2800, feedCut: 400, feedPlunge: 140 },
    ],
  },
  {
    group: 'Chamfer & face',
    tools: [
      { name: '1/4" chamfer 90°', type: 'chamfer', diameter: 6.35, tipAngle: 90, tipDiameter: 0.5, flutes: 2, fluteLength: 11, spindleRpm: 11000, feedCut: 1100, feedPlunge: 390 },
      { name: '1/2" chamfer 90°', type: 'chamfer', diameter: 12.7, tipAngle: 90, tipDiameter: 1, flutes: 2, fluteLength: 21, spindleRpm: 5500, feedCut: 1100, feedPlunge: 390 },
      { name: '2" face mill', type: 'face', diameter: 50.8, flutes: 6, fluteLength: 13, spindleRpm: 2200, feedCut: 2650, feedPlunge: 930 },
    ],
  },
];

/**
 * The catalogues that ship with the app.
 *
 * Built in, so they cannot be edited away and are the same in every project and
 * every browser. Everything the user builds lives beside them in catalogues of
 * their own — see `loadCatalogs` below — and either kind can be exported to a
 * file and imported anywhere.
 */
export const BUILTIN_CATALOGS = [
  {
    id: 'metric',
    name: 'Metric workshop',
    note: 'The default: metric cutters and ISO turning inserts, at speeds for '
      + 'aluminium in a hobby-class spindle.',
    groups: METRIC_GROUPS,
  },
  {
    id: 'imperial',
    name: 'Imperial / inch',
    note: 'An example second catalogue: inch cutters and UNC taps, by the names '
      + 'they are bought under. Sizes are still stored in millimetres.',
    groups: IMPERIAL_GROUPS,
  },
];

/** The default catalogue's groups — what `TOOL_PRESETS` has always meant. */
export const TOOL_PRESETS = METRIC_GROUPS;

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
  leadAngle: null,
  mountAngle: 0,
  insertAngle: 60,
  customPoints: null,
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
    // the ground lead: default per family when a preset does not name one, so
    // the catalogue tools get a sensible approach rather than a flat zero
    leadAngle: Number.isFinite(merged.leadAngle) ? merged.leadAngle
      : (type === 'turning' ? 95 : type === 'boring' ? 92 : 0),
    mountAngle: Number.isFinite(merged.mountAngle) ? merged.mountAngle : 0,
    insertAngle: merged.insertAngle ?? 60,
    // A hand-drawn custom insert outline, when the shape is 'X'. An array of
    // [x, y] with the cutting corner first, or null for the rhombus fallback.
    customPoints: Array.isArray(merged.customPoints) ? merged.customPoints : null,
    minBore: merged.minBore ?? 0,
    maxDepth: merged.maxDepth ?? 0,
    cornerRadius: merged.cornerRadius ?? 0,
    tipAngle: merged.tipAngle ?? 0,
    // The thread a tap cuts or a thread mill forms, in mm per turn. Zero on
    // everything else, because nothing else is a screw.
    pitch: merged.pitch ?? 0,
    // How many threads of a tap's end are ground away as a lead. Those cut
    // nothing at full depth, which is why a blind hole is tapped short. A lead
    // belongs to a tap and to nothing else, so an end mill does not carry one —
    // see defaultsForType, which clears it the same way when a family changes.
    leadThreads: type === 'tap' ? (merged.leadThreads ?? 2) : 0,
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
  // …and a spot drill for the same reason: a centre drill in the tailstock is
  // how a bar is started, and it is the one thing that puts a hole on the axis
  // rather than a millimetre off it.
  if (type === 'drill' || type === 'spot') return true;
  return machineForType(type) === machine;
}

/**
 * The preset groups that belong to a machine, so a lathe never offers end mills.
 *
 * @param catalogId one built-in catalogue, or null for every one of them. Each
 *   group comes back tagged with the catalogue it is from, because two
 *   catalogues both have a group called "End mills" and a heading that does not
 *   say which is a heading that lies.
 */
export function presetsFor(machine, catalogId = null) {
  const catalogs = catalogId
    ? BUILTIN_CATALOGS.filter((c) => c.id === catalogId)
    : BUILTIN_CATALOGS;
  return catalogs
    .flatMap((catalog) => catalog.groups.map((group) => ({
      ...group,
      catalog: catalog.id,
      catalogName: catalog.name,
      tools: group.tools.filter((t) => machineCanHold(t.type, machine)),
    })))
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
  // A tap's feed is not a feed. It is the pitch, times the speed, and any other
  // number breaks the tap — so `fz` here is unused and only the surface speed
  // means anything. Slow: a tap cuts on every flute at full depth and cannot be
  // backed off, so it is run at a fraction of what an end mill of the same size
  // takes. See suggestCutting, which overrides the feed outright.
  tap: { vc: 8, fz: 0, maxRpm: 1200 },
  // A thread mill is an end mill with a form on it, run gently because the
  // whole cut is taken on the flank of one small tooth.
  threadmill: { vc: 90, fz: 0.0035, maxRpm: 12000 },
};

/** Families that only ever cut on the way down, so their two feeds are one. */
const PLUNGE_IS_THE_CUT = new Set(['drill', 'spot', 'tap']);

/**
 * The coarse pitch of a metric thread, from the table on every workshop wall.
 *
 * A tap's feed is its pitch times its speed, so a suggestion that does not know
 * the pitch cannot suggest a feed at all — and the pitch is not a free choice:
 * an M6 is 1.0 unless somebody has gone out of their way to buy a fine one. The
 * coarse series is what "M6" means when nobody says otherwise, so it is what is
 * filled in, and it is a starting point the field can be typed over.
 */
export function coarsePitch(diameter) {
  const table = [
    [1.6, 0.35], [2, 0.4], [2.5, 0.45], [3, 0.5], [3.5, 0.6], [4, 0.7], [5, 0.8],
    [6, 1], [8, 1.25], [10, 1.5], [12, 1.75], [14, 2], [16, 2], [18, 2.5],
    [20, 2.5], [22, 2.5], [24, 3],
  ];
  let best = table[0];
  for (const row of table) {
    if (Math.abs(row[0] - diameter) < Math.abs(best[0] - diameter)) best = row;
  }
  return best[1];
}

/**
 * Sensible speeds, feeds, flute length and shank for a cutter of this family
 * and size — what the wizard fills in as you type a diameter.
 *
 * @param workDiameter for lathe tools, the diameter of the bar being cut, which
 *   is what sets the surface speed. Ignored for milling.
 */
export function suggestCutting({
  type = 'flat', diameter = 6, flutes, tipAngle = 0, workDiameter = 30, pitch = 0,
}) {
  // A spot drill is its own family now, but projects saved before it was still
  // hold theirs as short, blunt drills — and those are spot drills whatever
  // they are typed as, so they are spun like one.
  const family = type === 'drill' && tipAngle > 0 && tipAngle <= 100 ? 'spot' : type;
  const spec = CUTTING[family] ?? CUTTING.flat;
  const lathe = machineForType(type) === 'turn';
  const spinning = Math.max(0.5, lathe ? workDiameter : diameter);
  const teeth = Math.max(1, flutes ?? defaultFlutes(type, diameter));

  const rpm = clampRound((1000 * spec.vc) / (Math.PI * spinning), 300, spec.maxRpm, 50);
  // a lathe's feed is per revolution, not per tooth
  const feedCut = family === 'tap'
    // A tap is a screw. One turn is one pitch, so the feed is arithmetic and
    // not a preference — and a suggestion that offered anything else would be
    // offering to break the tap.
    ? Math.round(rpm * (pitch > 0 ? pitch : coarsePitch(diameter)))
    : lathe
      ? clampRound(rpm * spec.fz, 10, 600, 5)
      : clampRound(rpm * teeth * spec.fz * diameter, 20, 6000, 10);
  return {
    flutes: teeth,
    fluteLength: Math.round(defaultFluteLength(type, diameter, tipAngle) * 10) / 10,
    spindleRpm: rpm,
    feedCut,
    // A tap goes in and comes out at the same rate, because both are the same
    // screw turning the other way — and a drill or a spot drill never does
    // anything *but* plunge, so a third of the cutting feed is not a gentler
    // entry, it is the whole operation running at a third speed. A drilling
    // cycle is emitted at FEED.PLUNGE from end to end (see cl.js drill), which
    // is why the hand-tuned drill presets all carry the two the same and only
    // a wizard-built drill came out slow.
    feedPlunge: PLUNGE_IS_THE_CUT.has(family) ? feedCut
      : Math.max(10, Math.round((feedCut * (lathe ? 0.8 : 0.35)) / 5) * 5),
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
      // 90° is what a spot drill is bought as: it leaves a cone the drill's
      // outer corners touch first, and it is the same cut as a chamfer.
      : type === 'spot' ? (from.tipAngle || 90)
        : type === 'chamfer' ? (from.tipAngle || 90) : 0,
    tipDiameter: type === 'chamfer' ? (from.tipDiameter || 0.2) : 0,
    noseRadius: type === 'turning' || type === 'boring'
      ? Math.max(0.05, from.noseRadius || 0.8) : 0,
    bladeWidth: type === 'parting' ? (from.bladeWidth || 3)
      : type === 'threading' ? (from.bladeWidth || 1.5) : 0,
    // A pitch belongs to a screw and to nothing else, so it is cleared when the
    // family changes to anything that is not one — a 6mm end mill with a 1mm
    // pitch left on it from a tap would feed as a tap the moment it was used.
    pitch: (type === 'tap' || type === 'threadmill')
      ? (from.pitch || coarsePitch(from.diameter || 6)) : 0,
    leadThreads: type === 'tap' ? (from.leadThreads || 2) : 0,
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
  // A tap is exempt, and not as a special case: its feed is the pitch times the
  // speed and there is no other number it could be, so "is the chip heavy" is
  // not a question about it. Checked as a *thread* instead, below.
  const heavy = lathe ? 0.5 : Math.max(0.02, tool.diameter * 0.02);
  if (tool.type !== 'tap' && load > heavy) {
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
  if (type === 'drill' || type === 'spot') return 2;
  if (type === 'chamfer') return diameter < 5 ? 1 : 2;
  if (type === 'face') return Math.max(3, Math.round(diameter / 8));
  return diameter < 4 ? 2 : diameter < 10 ? 3 : 4;
}

function defaultFluteLength(type, diameter, tipAngle = 0) {
  // a spot drill is stubby on purpose; that stiffness is the whole point of it
  if (type === 'spot') return diameter * 1.2;
  if (type === 'drill') return tipAngle > 0 && tipAngle <= 100 ? diameter * 1.2 : diameter * 8;
  // A tap's cutting length is the thread it can cut, which is what a blind hole
  // is measured against — three diameters is a stub tap's, and typical.
  if (type === 'tap') return Math.max(8, diameter * 3);
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
    // A spot drill is named by its point, because the point is what it does:
    // a 60° one centres, a 90° one spots and chamfers, a 120° one prepares a
    // 118° drill without letting it touch on the chisel edge.
    case 'spot': return tool.tipAngle > 0 && tool.tipAngle < 75
      ? `${d}mm centre drill ${trim(tool.tipAngle)}°`
      : `${d}mm spot drill ${trim(tool.tipAngle ?? 90)}°`;
    case 'chamfer':
      return tool.tipAngle && tool.tipAngle < 70
        ? `${d}mm V bit ${trim(tool.tipAngle)}°`
        : `${d}mm chamfer ${trim(tool.tipAngle ?? 90)}°`;
    case 'face': return `${d}mm face mill`;
    // A tap is named by the thread it cuts, which is the pair and not the
    // diameter: an M6×1 and an M6×0.75 are different taps for different holes.
    case 'tap': return `M${d}×${trim(tool.pitch ?? 0)} tap`;
    case 'threadmill': return `⌀${d} thread mill ${trim(tool.pitch ?? 0)}mm`;
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

// --- the user's own catalogues --------------------------------------------
//
// A catalogue is a named drawer of cutters. The built-in ones above cannot be
// edited away and are the same everywhere; these are the user's, they live in
// this browser, and either kind can be written to a file and read back.
//
// Why more than one drawer rather than one long list: a shop does not have "my
// tools", it has the tools in the mill's carousel, the ones in the lathe's
// turret, and the box of specials for the one job that comes back every March.
// A single list of ninety cutters is a list nobody scans, and the thing that
// makes it a library rather than a heap is being able to hand somebody *the
// carousel* as a file.

const USER_KEY = 'cncam.toolLibrary';         // the old flat list, read once
const CATALOG_KEY = 'cncam.toolCatalogs';

/** The catalogue a tool goes to when nobody says which. */
export const DEFAULT_CATALOG = 'mine';

function emptyCatalog() {
  return { id: DEFAULT_CATALOG, name: 'My tools', tools: [] };
}

/**
 * Every catalogue the user has, always with at least the default one.
 *
 * Migrates the single flat list this used to be, the first time it is asked:
 * those tools become "My tools" and the old key is left alone, so an older
 * build of the app opened against the same browser still finds them.
 */
export function loadCatalogs() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(CATALOG_KEY) ?? 'null');
  } catch {
    stored = null;              // private mode, or something else wrote the key
  }
  const catalogs = Array.isArray(stored?.catalogs)
    ? stored.catalogs.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.tools))
    : null;
  if (catalogs) {
    return catalogs.some((c) => c.id === DEFAULT_CATALOG)
      ? catalogs
      : [emptyCatalog(), ...catalogs];
  }
  return [{ ...emptyCatalog(), tools: readLegacyTools() }];
}

function readLegacyTools() {
  try {
    const parsed = JSON.parse(localStorage.getItem(USER_KEY) ?? 'null');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCatalogs(catalogs) {
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify({
      version: LIBRARY_VERSION, catalogs,
    }));
    return true;
  } catch {
    return false;               // storage is full, or unavailable
  }
}

/** One catalogue by id — built-in or the user's — or null. */
export function catalogById(id) {
  const builtin = BUILTIN_CATALOGS.find((c) => c.id === id);
  if (builtin) {
    return { ...builtin, builtin: true, tools: builtin.groups.flatMap((g) => g.tools) };
  }
  const mine = loadCatalogs().find((c) => c.id === id);
  return mine ? { ...mine, builtin: false } : null;
}

/**
 * A new catalogue, with whatever should already be in it.
 * @returns the catalogue, or null when storage would not take it
 */
export function createCatalog(name, tools = []) {
  const catalogs = loadCatalogs();
  const catalog = { id: uid('cat'), name: uniqueCatalogName(name, catalogs), tools };
  catalogs.push(catalog);
  return writeCatalogs(catalogs) ? catalog : null;
}

/**
 * Two drawers with the same name on them are two drawers you cannot tell apart,
 * and the place that bites is import: bring the same file in twice and the
 * picker shows two identical entries with different contents.
 */
function uniqueCatalogName(name, catalogs) {
  const base = String(name ?? '').trim() || 'Catalogue';
  const taken = new Set([
    ...catalogs.map((c) => c.name),
    ...BUILTIN_CATALOGS.map((c) => c.name),
  ]);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }
  return `${base} ${uid('')}`;
}

export function renameCatalog(id, name) {
  const catalogs = loadCatalogs();
  const catalog = catalogs.find((c) => c.id === id);
  if (!catalog) return false;
  const wanted = String(name ?? '').trim();
  if (!wanted || wanted === catalog.name) return false;
  catalog.name = uniqueCatalogName(wanted, catalogs.filter((c) => c.id !== id));
  return writeCatalogs(catalogs);
}

/**
 * Throw a catalogue away. The default one is emptied rather than removed: it is
 * where a tool goes when nobody says where, so it has to exist.
 */
export function deleteCatalog(id) {
  const catalogs = loadCatalogs();
  if (!catalogs.some((c) => c.id === id)) return false;
  return writeCatalogs(id === DEFAULT_CATALOG
    ? catalogs.map((c) => (c.id === id ? { ...c, tools: [] } : c))
    : catalogs.filter((c) => c.id !== id));
}

/**
 * Put a tool in a catalogue, replacing any entry of the same name in it.
 * Ids and tool numbers are not saved: those belong to the project it came from.
 */
export function saveUserTool(tool, catalogId = DEFAULT_CATALOG) {
  const { id, number, ...rest } = tool;
  const catalogs = loadCatalogs();
  const catalog = catalogs.find((c) => c.id === catalogId)
    ?? catalogs.find((c) => c.id === DEFAULT_CATALOG);
  if (!catalog) return null;
  catalog.tools = catalog.tools.filter((t) => t.name !== rest.name);
  catalog.tools.push(rest);
  catalog.tools.sort((a, b) => a.name.localeCompare(b.name));
  return writeCatalogs(catalogs) ? catalog.tools : null;
}

/**
 * Take a tool out again.
 * @param catalogId the one to take it from, or null for wherever it is
 */
export function removeUserTool(name, catalogId = null) {
  const catalogs = loadCatalogs().map((c) => (catalogId && c.id !== catalogId ? c : {
    ...c, tools: c.tools.filter((t) => t.name !== name),
  }));
  return writeCatalogs(catalogs);
}

/** Every tool the user has, across every catalogue of theirs. */
export function loadUserTools() {
  return loadCatalogs().flatMap((c) => c.tools);
}

/**
 * The user's catalogues holding only what this machine can hold, which is the
 * shape the picker lists them in — so a lathe never offers end mills out of a
 * drawer either.
 */
export function userCatalogsFor(machine) {
  return loadCatalogs().map((c) => ({
    ...c,
    tools: c.tools.filter((t) => machineCanHold(t.type, machine)),
  }));
}

/** Flat list of every built-in preset, with its group and catalogue attached. */
export function allPresets() {
  return BUILTIN_CATALOGS.flatMap((c) => c.groups.flatMap(
    (g) => g.tools.map((t) => ({ ...t, group: g.group, catalog: c.id })),
  ));
}

/**
 * A library, or a catalogue, as a file.
 *
 * One format for both, because they are one thing: a catalogue is a named list
 * of tools and a project's tools are the same list without a name on it. So an
 * exported catalogue imports straight into a project as tools, and a project's
 * tools import as a catalogue — which is most of what the file is for.
 */
export function serializeLibrary(tools, name = '') {
  return JSON.stringify({
    version: LIBRARY_VERSION, ...(name ? { name } : {}), tools,
  }, null, 2);
}

/** The same file read as a catalogue: the name on it, and its tools as records. */
export function deserializeCatalog(json) {
  const parsed = JSON.parse(json);
  const tools = Array.isArray(parsed) ? parsed : parsed?.tools;
  if (!Array.isArray(tools)) throw new Error('not a tool library (expected a tools array)');
  // Stored as records rather than as project tools: a catalogue entry has no id
  // and no tool number, because those belong to the project it is pulled into
  // and not to the drawer it sits in.
  return {
    name: typeof parsed?.name === 'string' ? parsed.name : '',
    tools: tools.map((t) => {
      const { id, number, ...rest } = toolFromPreset(t, 1);
      return rest;
    }),
  };
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
