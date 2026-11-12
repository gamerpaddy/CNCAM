// Strategy dispatch: op type → generator. Runs identically on the main
// thread (tests) and inside job-worker.js (app).

import {
  CLBuilder, MOVE_STRIDE, OP, FEED, eachMove, syncTrack, rapidRates, rapidSeconds, feedRate,
  descentOf,
} from './cl.js';
import { fixtureTop } from './fixtures.js';
import { clampParams, nonNumeric } from './param-limits.js';
import { generateCommand } from './strategies/command.js';
import { generateFace } from './strategies/face.js';
import { generateContour } from './strategies/contour.js';
import { generateClear } from './strategies/clear2d.js';
import { generateAdaptive } from './strategies/adaptive.js';
import { generateDrill } from './strategies/drill.js';
import { generateParallel3d } from './strategies/parallel3d.js';
import { generatePencil } from './strategies/pencil.js';
import { generateScallop } from './strategies/scallop.js';
import { generateFinish5 } from './strategies/finish5.js';
import { generateWaterline } from './strategies/waterline.js';
import { generatePocket } from './strategies/pocket.js';
import { generateChamfer } from './strategies/chamfer.js';
import { generateBore } from './strategies/bore.js';
import { generateEngrave } from './strategies/engrave.js';
import { generateVcarve } from './strategies/vcarve.js';
import { generateSlot } from './strategies/slot.js';
import { generateSpot, generateTap, generateThreadMill } from './strategies/holes.js';
import {
  generateTurnFace, generateTurnRough, generateTurnFinish, generateTurnPart,
  generateTurnGroove, generateTurnThread, generateTurnDrill, generateTurnBore,
} from './strategies/turning.js';

const strategies = {
  // Not a strategy at all — a block of G-code you typed, placed in the running
  // order. In here because everything downstream (generate, the tree, the
  // program, the export) works on operations, and being one is what makes it
  // survive a reorder and a save. See strategies/command.js.
  command: generateCommand,
  face: generateFace,
  contour2d: generateContour,
  pocket: generatePocket,
  clear2d: generateClear,
  adaptive: generateAdaptive,
  spot: generateSpot,
  drill: generateDrill,
  tap: generateTap,
  threadMill: generateThreadMill,
  bore: generateBore,
  slot: generateSlot,
  chamfer: generateChamfer,
  engrave: generateEngrave,
  vcarve: generateVcarve,
  parallel3d: generateParallel3d,
  // finishing the other two ways: the creases a bigger cutter left, and passes
  // spaced along the surface so the cusp is one height everywhere
  pencil: generatePencil,
  scallop: generateScallop,
  // the 5-axis beta; hidden unless the Experimental switch is on (engine/five/ops.js)
  finish5: generateFinish5,
  waterline: generateWaterline,
  turnFace: generateTurnFace,
  turnRough: generateTurnRough,
  turnFinish: generateTurnFinish,
  turnGroove: generateTurnGroove,
  turnThread: generateTurnThread,
  turnDrill: generateTurnDrill,
  turnBore: generateTurnBore,
  turnPart: generateTurnPart,
};

/**
 * Which strategies belong to a lathe setup. A turning operation in a milling
 * setup is meaningless and vice versa, so the pickers show one set or the other
 * rather than a list with several that will not work.
 *
 * In the order a turned part is actually made: face the end, drill and bore the
 * inside while the bar is still stiff, rough and finish the outside, cut the
 * grooves and threads that need finished diameters to sit on, part it off last.
 */
export const TURNING_OPS = [
  'command',
  'turnFace', 'turnDrill', 'turnBore', 'turnRough', 'turnFinish',
  'turnGroove', 'turnThread', 'turnPart',
];

/**
 * The operations that belong to both machines.
 *
 * There is one, and it is the exception that proves the rule above: a command
 * is a block of G-code somebody typed, so it is not about what is being cut and
 * has no reason to pick a side. Named as a set rather than by leaving it out of
 * `TURNING_OPS`, because the two lists are derived from each other — put it in
 * one and it is filtered out of the other, which is how it first appeared on
 * the lathe alone.
 */
export const BOTH_MACHINES = new Set(['command']);

export const IMPLEMENTED_OPS = Object.keys(strategies);
export const MILLING_OPS = IMPLEMENTED_OPS.filter(
  (t) => !TURNING_OPS.includes(t) || BOTH_MACHINES.has(t));

/** The strategies a setup of this mode may use. */
export function opsForMode(mode) {
  return mode === 'turn' ? TURNING_OPS : MILLING_OPS;
}

export const OP_LABELS = {
  command: 'Command (G-code)',
  face: 'Face',
  contour2d: 'Contour',
  pocket: 'Pocket',
  slot: 'Slot',
  clear2d: 'Z-level rough',
  adaptive: 'Adaptive rough',
  spot: 'Spot drill',
  drill: 'Drill',
  tap: 'Tap',
  // "Thread mill" rather than "Thread": the lathe already has a Thread and the
  // two are not the same operation — one runs a form tool along a turning bar,
  // the other spirals an end mill up a hole.
  threadMill: 'Thread mill',
  // Named apart from the lathe's 'Bore' on purpose: two strategies with the
  // same name in the same picker is a menu you have to guess at, and the two
  // are not the same operation — one spirals an end mill down a hole, the other
  // runs a bar along one while the work turns.
  bore: 'Helical bore',
  chamfer: 'Chamfer',
  engrave: 'Engrave',
  vcarve: 'V-carve',
  parallel3d: 'Parallel finish',
  pencil: 'Pencil finish',
  scallop: 'Constant-scallop finish',
  finish5: '5-axis finish (beta)',
  waterline: 'Waterline finish',
  turnFace: 'Face the end',
  turnRough: 'Rough turn',
  turnFinish: 'Finish turn',
  turnGroove: 'Groove',
  turnThread: 'Thread',
  turnDrill: 'Centre drill',
  turnBore: 'Bore',
  turnPart: 'Part off',
};

/**
 * The clearance a milling op may traverse at, never below a clamp.
 *
 * A clamp is a keep-out for the whole column above its footprint, so a traverse
 * plane below the tallest clamp rapids straight through it — and the cut moves
 * route around the clamp perfectly, which is exactly what makes it invisible.
 * The panel already warns when `clearanceHeight` sits under a clamp (see
 * doc/machines.js and app/actions/program.js), but a warning is not a guard: the
 * G-code still crashes if it is run. So the height every strategy homes and
 * links at is floored here to clear the tallest clamp with a 3mm gap, whatever
 * the operation asked for. The *stated* clearance on the operation is untouched,
 * so the warning still fires — this only stops the program driving through the
 * jaw. Turning has no overhead traverse plane (a chuck is a Z limit; see
 * engine/fixtures.js), so it is left alone.
 */
function clampSafeArgs(args) {
  // A command has no clearance plane to raise — it has no moves at all — and a
  // turning op has no overhead traverse to raise one for.
  if (BOTH_MACHINES.has(args.type) || TURNING_OPS.includes(args.type)) return args;
  const clamp = fixtureTop(args.fixtures);
  if (!clamp) return args;
  const floor = clamp.z + 3;
  const asked = args.params?.clearanceHeight;
  if (Number.isFinite(asked) && asked >= floor) return args;
  return { ...args, params: { ...args.params, clearanceHeight: floor } };
}

/**
 * How far the billet stands above the Top Z of a cut that starts from the top of
 * whatever is there, in mm - 0 when it does not, or when the strategy has a
 * Top Z of its own kind.
 *
 * Top Z is where the cut starts, and every one of these strategies comes down
 * onto it: a rapid to an entry gap above the first pass. Nothing in the
 * operation knows what was done before it, so it cannot tell whether the metal
 * over Top Z was taken off already or is still there - and if it is, that
 * rapid goes into it. The simulation sees which; the operation can say what it
 * counted on.
 */
function standingAboveTopZ(args) {
  const top = args.stock?.max?.[2];
  const topZ = args.params?.topZ;
  if (!CUT_FROM_TOP.has(args.type) || !Number.isFinite(top) || !Number.isFinite(topZ)) return 0;
  return Math.max(0, top - topZ);
}

/**
 * Strategies whose path depends on the operations ahead of them in the setup,
 * whatever they themselves are set to — so they are handed those operations as
 * `earlier`, and their fingerprint takes them in (app/op-status.js).
 *
 *   turnBore   starts from the hole the drill ahead of it made
 *   turnFinish comes in from clear air unless the end of the bar has been faced
 *              back to where it starts (see turning.js barEndAfter)
 *   waterline, parallel3d, finish5   enter and link clear of the steps a roughing
 *              pass ahead of them leaves (see heights.js clearOfRoughing)
 */
export const READS_EARLIER = new Set(['turnBore', 'turnFinish', 'waterline', 'parallel3d', 'finish5', 'pencil', 'scallop']);

/**
 * The strategies whose Top Z is simply "where the cut starts" — as opposed to a
 * chamfer's edge, an engraving's surface or a hole's top, which are features.
 */
const CUT_FROM_TOP = new Set(['face', 'contour2d', 'pocket', 'clear2d', 'adaptive', 'slot']);

/**
 * The milling strategies that cannot start without a part — or, for a slot and an
 * engraving, a drawing. Face and drill need neither and say so themselves.
 * The app asks for a model before it generates any of these (op-status.js), but
 * a project edited by hand, or a model removed after the pass was made, still
 * arrives here — and what came out was "Cannot read properties of null".
 */
const NEEDS_A_PART = new Set([
  'contour2d', 'pocket', 'clear2d', 'adaptive', 'spot', 'tap', 'threadMill', 'bore',
  'chamfer', 'parallel3d', 'waterline', 'finish5', 'pencil', 'scallop',
]);
const NEEDS_A_PART_OR_DRAWING = new Set(['slot', 'engrave', 'vcarve']);

/**
 * Start the cut at the top of the billet, not above it.
 *
 * There is nothing to cut above the stock, and these strategies step down from
 * Top Z whatever is there — so a Top Z left above the billet (the stock's top
 * margin trimmed after the operations were made, a height handle dragged too
 * far) fed full passes through air at cutting feed. Measured with Top Z 10mm
 * over a small part: Z-level roughing ran 1.9m of air, a contour 0.4m, facing
 * 0.35m. Left alone when the whole range is above the billet, because then
 * there is no cut to start and the strategy's own refusal says so.
 *
 * @returns { args, lowered } — how far Top Z came down, 0 when it did not
 */
function clampTopToStock(args) {
  const top = args.stock?.max?.[2];
  const { topZ, bottomZ } = args.params ?? {};
  if (!CUT_FROM_TOP.has(args.type) || !Number.isFinite(top) || !Number.isFinite(topZ)
    || !(topZ > top + 1e-6) || !(bottomZ < top)) {
    return { args, lowered: 0 };
  }
  return { args: { ...args, params: { ...args.params, topZ: top } }, lowered: topZ - top };
}

/** The widest cutter any strategy is asked to plan for, in mm. See generateToolpath. */
export const MAX_CUTTER_DIAMETER = 1000;

/** The longest side any billet is planned for, in mm: 100m. See generateToolpath. */
export const MAX_STOCK_EXTENT = 100000;

/** What is wrong with the stock's size, as a phrase ("2000000000mm long in Y"), or null. */
function stockTooBig(stock) {
  if (!stock?.min || !stock?.max) return null;
  for (let axis = 0; axis < 3; axis++) {
    const size = stock.max[axis] - stock.min[axis];
    if (!Number.isFinite(size)) return `not a size in ${'XYZ'[axis]}`;
    if (size > MAX_STOCK_EXTENT) return `${Math.round(size)}mm long in ${'XYZ'[axis]}`;
  }
  return null;
}

/**
 * What is wrong with the drawing's points, as a phrase, or null.
 *
 * The strategies that read a drawing (slot, engraving, a drill by circles) take
 * its points as numbers. A path whose list is `null`, or holds a string, a NaN
 * or an infinity, is not one an import can produce and a project file can carry:
 * the first was a TypeError out of three different strategies, the NaN came out
 * as NaN on every line of the slot, and an infinity ran an engraving out of
 * memory (4GB, then the tab). Said once, before any of them starts.
 */
function unreadableDrawing(drawing) {
  if (!Array.isArray(drawing)) return null;
  for (const path of drawing) {
    const points = path?.points;
    if (!Array.isArray(points) && !ArrayBuffer.isView(points)) return 'a path with no list of points';
    if (points.length % 2 !== 0) return 'a path with a coordinate missing (an odd number of values)';
    for (let i = 0; i < points.length; i++) {
      if (typeof points[i] !== 'number' || !Number.isFinite(points[i])) return 'a point that is not a number';
    }
  }
  return null;
}

/**
 * The name of the first setting of the operation or its cutter that is a number
 * gone wrong (NaN, ±Infinity), or null. `null` is not one: it is how an optional
 * setting says "inherit" or "work it out", and every strategy reads it so.
 */
function unreadableSetting({ type, params, tool }) {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'number' && !Number.isFinite(value)) return `the setting ${key}`;
  }
  const text = nonNumeric(params, type);
  if (text) return `the setting ${text}`;
  // the three heights are never optional: null reads as zero in every sum, so a
  // cleared field cut at Z0 (and a chamfer threw on it, asking for its digits)
  if (type !== 'command') {
    for (const key of ['topZ', 'bottomZ', 'clearanceHeight']) {
      if (params?.[key] === null) return `the setting ${key}`;
    }
  }
  for (const [key, value] of Object.entries(tool ?? {})) {
    if (typeof value === 'number' && !Number.isFinite(value)) return `the cutter's ${key}`;
  }
  return null;
}

/**
 * @param args { type, params, tool, stock, mesh?, fixtures? }
 * @returns finished CL program { version, moves, count, events }
 */
export function generateToolpath(given) {
  let args = given;
  const generate = strategies[args.type];
  if (!generate) throw new Error(`operation type not implemented: ${args.type}`);
  // A milling cutter with no width is not a cutter, and the strategies do not
  // expect one: a contour offset by a radius of nothing ran out of memory
  // before it returned. Refused here, once, with the reason.
  if (!BOTH_MACHINES.has(args.type) && !TURNING_OPS.includes(args.type)
    && !(args.tool?.diameter > 0)) {
    const cl = new CLBuilder();
    cl.warn(`${args.tool?.name ?? 'this cutter'} has no diameter — set its size before generating`);
    return cl.finish();
  }
  // And one no cutter is: a typed "1e9" is a legal number to every field, and
  // the offsetting under a contour never came back from it (a millimetre of
  // cutter is two thousand clipper units, a billion of them overflows its
  // integers), a waterline wrote ten million moves and an engraving ran out of
  // array. Refused the same way, for the same reason, with the limit in the words.
  if (!BOTH_MACHINES.has(args.type) && !TURNING_OPS.includes(args.type)
    && args.tool.diameter > MAX_CUTTER_DIAMETER) {
    const cl = new CLBuilder();
    cl.warn(`${args.tool.name ?? 'this cutter'} is ${args.tool.diameter}mm across — no milling `
      + `cutter is wider than ${MAX_CUTTER_DIAMETER}mm, so this is a typing slip. Set its size before generating`);
    return cl.finish();
  }
  const hasPart = !!args.mesh?.positions?.length;
  if (!hasPart && (NEEDS_A_PART.has(args.type)
    || NEEDS_A_PART_OR_DRAWING.has(args.type) && !args.drawing?.length)) {
    const cl = new CLBuilder();
    cl.warn('this operation works from the model, and there is none in the project — import one');
    return cl.finish();
  }
  // A billet no workshop has is a margin typed with too many zeros, and every
  // strategy plans over the whole of it: a facing pass of two billion mm ran out
  // of array, and an adaptive one did not come back at all.
  const oversize = stockTooBig(args.stock);
  if (oversize) {
    const cl = new CLBuilder();
    cl.warn(`the stock is ${oversize} — no billet is bigger than ${MAX_STOCK_EXTENT}mm, so this is a `
      + 'typing slip. Check the stock size and margins before generating');
    return cl.finish();
  }
  // A setting that is not a number is not a setting: NaN reaches every move the
  // strategy computes from it, and the program that comes out is NaN on every
  // line. A file can carry one (JSON writes NaN as null, and hand edits write
  // anything) — said by name, before anything is generated.
  const unreadable = unreadableSetting(args);
  if (unreadable) {
    const cl = new CLBuilder();
    cl.warn(`${unreadable} is not a number — set it before generating`);
    return cl.finish();
  }
  const badDrawing = unreadableDrawing(args.drawing);
  if (badDrawing) {
    const cl = new CLBuilder();
    cl.warn(`the drawing has ${badDrawing} — re-import it before generating`);
    return cl.finish();
  }
  // The panel keeps every number inside its field's range; a value that did not
  // come through the panel is held to the same range here, and the program says
  // so. See engine/param-limits.js.
  const { params: held, notes: heldNotes } = clampParams(args.params, args.type);
  if (held !== args.params) args = { ...args, params: held };
  const { args: clamped, lowered } = clampTopToStock(clampSafeArgs(args));
  // A cut that ends above where it starts has no depth to take. The panel keeps
  // Bottom Z under Top Z, so this only meets a file that was edited by hand —
  // and the strategies read it as a cut *at* Bottom Z, so a Bottom Z of 1e9 was
  // a program at a billion millimetres.
  if (CUT_FROM_TOP.has(clamped.type) && clamped.params.bottomZ > clamped.params.topZ + 1e-9) {
    const cl = new CLBuilder();
    cl.warn(`Bottom Z (${clamped.params.bottomZ}) is above Top Z (${clamped.params.topZ}) — `
      + 'there is no depth to cut');
    return cl.finish();
  }
  const cl = generate(clamped);
  if (heldNotes.length) {
    cl.notes = [...(cl.notes ?? []), ...heldNotes.map((text) => ({ level: 'warn', text }))];
  }
  const below = standingAboveTopZ(clamped);
  if (below > 0.05 && cl.count > 0) {
    const mm = (v) => Math.round(v * 1000) / 1000;
    cl.notes = [...(cl.notes ?? []), {
      level: 'info',
      text: `The billet stands ${mm(below)}mm above Top Z (Z${mm(clamped.params.topZ)}, `
        + `against Z${mm(clamped.stock.max[2])}): this operation comes down onto its first `
        + 'pass at rapid, so whatever stands over it has to have been taken off by an '
        + 'operation before this one, or the tool rapids into it',
    }];
  }
  if (lowered > 0.001) {
    cl.notes = [...(cl.notes ?? []), {
      level: 'info',
      text: `Top Z is ${Math.round(lowered * 1000) / 1000}mm above the billet, so the cut `
        + `starts at its top, Z${Math.round(clamped.params.topZ * 1000) / 1000}, rather than `
        + 'feeding through air',
    }];
  }
  return cl;
}

/**
 * What a generated program actually does, in numbers a user can act on.
 *
 * "This operation did nothing" is the single most common thing to go wrong, and
 * until there was something to look at, the only evidence was an empty patch of
 * viewport. Cut distance separates "no passes at all" from "passes that are all
 * rapids", and the warnings say which it is and usually why.
 */
export function toolpathStats(cl, rapidFeed = 3000) {
  let cuts = 0;
  let rapids = 0;
  let drills = 0;
  let cutLength = 0;
  let rapidLength = 0;
  let deepest = null;
  let prev = null;

  eachMove(cl, (opcode, x, y, z, i, j, k, feed) => {
    if (opcode === OP.DRILL) {
      drills++;
      deepest = deepest == null ? z : Math.min(deepest, z);
      prev = [x, y, z];
      return;
    }
    if (prev) {
      const d = Math.hypot(x - prev[0], y - prev[1], z - prev[2]);
      if (feed === FEED.RAPID) rapidLength += d; else cutLength += d;
    }
    prev = [x, y, z];
    if (feed === FEED.RAPID) rapids++;
    else {
      cuts++;
      deepest = deepest == null ? z : Math.min(deepest, z);
    }
  });

  const notes = cl.notes ?? [];
  return {
    moves: cl.count,
    cuts,
    rapids,
    drills,
    cutLength,
    rapidLength,
    deepest,
    seconds: estimateSeconds(cl, rapidFeed),
    notes,
    warnings: notes.filter((n) => n.level === 'warn'),
    // a program with no cutting moves and no holes has not machined anything,
    // whatever else it emitted
    empty: cuts === 0 && drills === 0,
  };
}

/**
 * Estimated machining time in seconds.
 *
 * `rapidFeed` is either one rate or `{ xy, z }` — see rapidRates.
 */
export function estimateSeconds(cl, rapidFeed = 3000) {
  const rapid = rapidRates(rapidFeed);
  let feeds = { cut: 600, plunge: 200 };
  const feedEvents = cl.events.filter((e) => e.type === 'feeds');
  feedEvents.sort((a, b) => a.index - b.index);
  // events come out in move order, so a cursor beats re-scanning the list on
  // every move — which made this quadratic, on a function the panels call for
  // every operation on every render
  let feedCursor = 0;
  let seconds = 0;
  let prev = null;
  const d = cl.moves;
  // A threading pass runs at pitch × rpm and at no other speed — see cl.js.
  const sync = syncTrack(cl);
  for (let n = 0; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    while (feedCursor < feedEvents.length && feedEvents[feedCursor].index <= n) {
      feeds = feedEvents[feedCursor++];
    }
    const synced = sync.at(n);
    if (d[o] === OP.DRILL) {
      // the approach to the hole's R plane, at rapid — the simulator counts the
      // same move (see simulate.js), and the two clocks have to agree
      if (prev) {
        seconds += rapidSeconds(Math.hypot(d[o + 1] - prev[0], d[o + 2] - prev[1]),
          d[o + 4] - prev[2], rapid);
      }
      // plunge down + rapid back up; pecking retracts are ignored (estimate)
      const depth = Math.max(0, d[o + 4] - d[o + 3]);
      seconds += (depth / feeds.plunge) * 60 + rapidSeconds(0, depth, rapid);
      prev = [d[o + 1], d[o + 2], d[o + 4]];
      continue;
    }
    const p = [d[o + 1], d[o + 2], d[o + 3]];
    if (prev) {
      const feedClass = d[o + 7];
      if (feedClass === FEED.RAPID) {
        seconds += rapidSeconds(Math.hypot(p[0] - prev[0], p[1] - prev[1]), p[2] - prev[2], rapid);
      } else {
        const dist = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
        // A ramp's speed depends on how steeply it descends — see cl.js feedRate.
        // The estimate has to ask the same question the post answers, or the
        // minutes on screen are not the minutes the machine takes.
        const mmPerMin = synced > 0 ? synced : feedRate(feedClass, feeds, descentOf(prev, p));
        seconds += (dist / mmPerMin) * 60;
      }
    }
    prev = p;
  }
  return seconds;
}
