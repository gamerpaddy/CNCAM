// Material removal simulation.
//
// Stock is a grid of surface heights; each move lowers the cells its cutter
// sweeps over. The obvious implementation mutates that grid in place, but then
// the timeline can only ever run forwards — going back would mean re-running
// from the start every frame.
//
// So the pass records an *event log* instead: every time a cell drops, it logs
// (step, cell, newHeight, previousHeight). Events come out already ordered by
// step, so seeking anywhere is just applying or undoing the events between
// where the playhead was and where it is going. Scrubbing costs the number of
// changes crossed, not the length of the program, and reverse costs the same as
// forward.

import { MOVE_STRIDE, OP, FEED, syncFeed, rapidSeconds, feedRate, descentOf } from './cl.js';
import { inheritedColumns, settleThrough, cutFromSimulation } from './workpiece.js';
import { profileTable } from './tool-geometry.js';
import { isRoundStock } from './stock.js';

const DEFAULT_MAX_CELLS = 40_000;   // ~200x200; keeps re-shading interactive

/** A micron. Not a quality limit — just somewhere for the arithmetic to stop. */
const MIN_CELL = 0.001;

/**
 * How many surface changes a run may record before it gives up.
 *
 * A fixed ceiling is what made a simulation stop halfway *because the detail
 * setting was raised*: a finer grid records more events for exactly the same
 * program, so the same job that finished on Medium ran out of log on Ultra and
 * the last third of the toolpath appeared not to cut anything. The budget is
 * therefore a multiple of the grid, with a hard cap that is about memory rather
 * than about detail — an event is sixteen bytes, so the cap is ~256MB.
 */
const EVENTS_PER_CELL = 40;
const MIN_EVENTS = 2_000_000;
const MAX_EVENTS_CAP = 16_000_000;

/**
 * How much of that the user is willing to spend.
 *
 * The cap above is a *default*, chosen so that a simulation cannot quietly eat
 * a quarter of a gigabyte on a machine that may not have it. On a long program
 * it is also the thing that runs out, and "the program outran the record" is
 * then a message about a limit the person reading it has no way to raise —
 * their only options were to coarsen the picture or simulate half the job.
 *
 * So the limit is a preference. It is stated as a multiplier rather than as a
 * number of events because events are not a unit anybody thinks in; what the
 * setting means is "let it use more memory", and the memory cost of each step
 * is on the option itself.
 *
 * @see app/settings.js simRecord
 */
export const RECORD_SCALES = [1, 2, 4, 8];

function recordScale(scale) {
  const n = Number(scale);
  return Number.isFinite(n) ? Math.max(1, Math.min(8, n)) : 1;
}

/**
 * The smallest surface change worth writing down.
 *
 * A pass is walked in pieces, and consecutive pieces often shave the same cell
 * by a fraction of a micron — a change nothing can see, on a surface whose
 * whole point is what it looks like, costing sixteen bytes of log each time. On
 * a long program those sub-micron shavings were most of the record, and running
 * out of record is what stops a simulation halfway. A micron is two orders
 * below anything machined here and three below what a pixel can show.
 */
const MIN_CHANGE = 0.001;

export function eventBudget(cellCount, scale = 1) {
  const factor = recordScale(scale);
  return factor * Math.min(MAX_EVENTS_CAP, Math.max(MIN_EVENTS, cellCount * EVENTS_PER_CELL));
}

/** Growable parallel arrays for the event log. */
class EventLog {
  constructor(capacity = 1 << 16) {
    this.step = new Int32Array(capacity);
    this.cell = new Int32Array(capacity);
    this.height = new Float32Array(capacity);
    this.prev = new Float32Array(capacity);
    this.count = 0;
  }

  push(step, cell, height, prev) {
    if (this.count === this.step.length) this.grow();
    const i = this.count++;
    this.step[i] = step; this.cell[i] = cell;
    this.height[i] = height; this.prev[i] = prev;
  }

  grow() {
    const size = this.step.length * 2;
    for (const key of ['step', 'cell', 'height', 'prev']) {
      const next = new this[key].constructor(size);
      next.set(this[key]);
      this[key] = next;
    }
  }

  trimmed() {
    return {
      evStep: this.step.slice(0, this.count),
      evCell: this.cell.slice(0, this.count),
      evHeight: this.height.slice(0, this.count),
      evPrev: this.prev.slice(0, this.count),
      eventCount: this.count,
    };
  }
}

/**
 * The log that records nothing, for a run whose surface is all that is wanted.
 *
 * A stand-in rather than an `if` at the two hundred million call sites the
 * sweep makes: `cut` pushes an event every time a cell drops and must not learn
 * that there is a mode where it does not.
 */
const NULL_LOG = {
  count: 0,
  push() {},
  trimmed: () => ({
    evStep: new Int32Array(0), evCell: new Int32Array(0),
    evHeight: new Float32Array(0), evPrev: new Float32Array(0), eventCount: 0,
  }),
};

/**
 * @param stock { kind, min, max, cylinder? } in setup space
 * @param ops [{ cl, tool }] in program order
 * @param cuts what earlier setups already removed — see engine/workpiece.js
 * @param frame this setup's own { matrix, offset }, needed to read `cuts`
 * @param logEvents false for a run that only needs its finished surface
 * @returns a simulation record; feed it to SimulationPlayback
 */
export function simulateRemoval({
  stock, ops, maxCells = DEFAULT_MAX_CELLS, rapidFeed = 3000, record = 1,
  cuts = null, frame = null, logEvents = true,
}) {
  const spanX = stock.max[0] - stock.min[0];
  const spanY = stock.max[1] - stock.min[1];
  // The cell budget is the whole limit; there is no separate floor on how fine
  // a cell may be.
  //
  // There used to be one, at 0.05mm, and it was the answer to "the simulation
  // is rough however high I set the detail". A 20mm part wants 0.032mm cells at
  // Ultra and a 10mm part 0.016mm — both were clamped to 0.05, so on anything
  // small every setting above Medium produced *the same grid*. The setting was
  // still there, still redrew, and changed nothing: the worst kind of control.
  // `maxCells` already bounds the memory, which is what the floor was reaching
  // for; MIN_CELL only keeps the arithmetic finite on a degenerate stock.
  const cellSize = Math.max(MIN_CELL, Math.sqrt((spanX * spanY) / maxCells));
  const width = Math.max(2, Math.ceil(spanX / cellSize) + 1);
  const height = Math.max(2, Math.ceil(spanY / cellSize) + 1);
  const cellCount = width * height;

  const stockTop = stock.max[2];
  const mask = buildMask(stock, width, height, cellSize);
  // What the setups before this one left. The grid is decided here, so the
  // inherited surface is sampled onto it here too rather than by a caller
  // reproducing this arithmetic — see engine/workpiece.js.
  const columns = cuts?.length && frame
    ? inheritedColumns({
      cuts, frame, mask,
      grid: { width, height, cellSize, origin: stock.min },
      stock: { top: stockTop, bottom: stock.min[2] },
    })
    : null;
  const initial = columns
    ? columns.initial
    : new Float32Array(cellCount).fill(stockTop);

  const heights = initial.slice();
  // A run whose only product is its finished surface — one setup's contribution
  // to the workpiece the next one starts from — has no use for the event log,
  // and the log is by far the largest thing a simulation makes. Skipping it is
  // the difference between carrying three previous setups and running out of
  // memory on the second.
  const log = logEvents ? new EventLog() : NULL_LOG;
  const times = [0];
  let step = 0;
  let seconds = 0;
  let truncated = false;

  const maxEvents = eventBudget(cellCount, record);
  const grid = { width, height, cellSize, origin: stock.min };
  // How far the tool may travel before the metal under it comes off.
  //
  // A cutter's own width is the natural unit: at one diameter the material
  // never disappears further ahead of the tool than the tool is wide, which is
  // what "it takes it off where it is" looks like. Finer costs real time — the
  // sweep re-tests every cell inside the cutter footprint on every piece, so
  // halving the piece roughly doubles the work — and buys nothing the eye can
  // see. Never below a cell, because a piece shorter than the grid cannot show
  // anything, and never so fine that a whole program cannot be walked: the
  // budget below spreads the pieces over the length of the job rather than
  // giving a facing pass ten thousand of them.
  const minSubStep = Math.max(cellSize, programLength(ops) / MAX_MILL_STEPS);
  // Where each operation finishes, in steps. The timeline needs this to draw a
  // band per operation, and it is the simulator that knows it: a run that stops
  // early on the event budget, or one that subdivides moves (see simulateTurn),
  // does not have one step per CL move, so counting moves outside here is a
  // second description of the same thing and it disagrees.
  const opEnds = [];
  // Where the tip is at the end of every step, recorded rather than re-derived.
  //
  // A step used to *be* a CL move, so "where is the tool at step k" could be
  // answered by indexing into the program. Now that a long move is walked in
  // pieces (see `subStepsFor`) that correspondence is gone, and a second
  // description of it would be wrong the moment the two disagreed. The
  // simulator knows where the tool was, so it says so.
  const tip = [];
  // What each step asked of the cutter — see `cut` and `LoadLog`.
  const load = new LoadLog();
  // And whether any of it was taken at rapid, which is not a heavy cut but a
  // crash. Counted here rather than guessed at from the geometry, because the
  // guess — "a G0 that travels while below the top of the billet" — fires on
  // every stay-down link this app deliberately makes, and a warning that fires
  // on correct programs is a warning nobody reads. The simulation knows what
  // was actually in front of the tool.
  const rapidCut = { count: 0, depth: 0, step: -1 };
  for (const { cl, tool } of ops) {
    // the profile *and* the radius it covers, from one builder, so the sweep and
    // the shape it sweeps with can never disagree about how wide the cutter is
    const cutter = profileTable(tool);
    const radius = cutter.radius;
    // this cutter's own width, or the budget's piece if that is coarser
    const subStepLength = Math.max(radius * 2, minSubStep);
    const d = cl.moves;
    let feeds = { cut: 600, plunge: 200 };
    let prev = null;
    // Events are recorded in move order, so a cursor finds the current feeds in
    // constant time. Re-scanning the whole event list on every move made this
    // quadratic in the length of the program — invisible on a test fixture and
    // the dominant cost on a real one.
    const feedEvents = cl.events.filter((e) => e.type === 'feeds');
    feedEvents.sort((a, b) => a.index - b.index);
    let feedCursor = 0;

    for (let n = 0; n < cl.count && !truncated; n++) {
      while (feedCursor < feedEvents.length && feedEvents[feedCursor].index <= n) {
        feeds = feedEvents[feedCursor++];
      }
      const o = n * MOVE_STRIDE;
      const opcode = d[o];

      if (opcode === OP.DRILL) {
        const [x, y, zBottom, retractZ] = [d[o + 1], d[o + 2], d[o + 3], d[o + 4]];
        const took = cut(heights, mask, log, step, grid,
          [x, y, retractZ], [x, y, zBottom], cutter, stockTop, columns);
        // a hole is full width by definition and travels no distance across the
        // floor, so there is no radial width to report — only how deep it went
        load.push(2 * radius, took.depth, radius, false);
        seconds += drillSeconds(retractZ, zBottom, feeds.plunge, rapidFeed);
        prev = [x, y, retractZ];
        step++;
        times.push(seconds);
        tip.push(x, y, retractZ);
      } else {
        const p = [d[o + 1], d[o + 2], d[o + 3]];
        if (!prev) {
          prev = p;
          step++;
          times.push(seconds);
          tip.push(p[0], p[1], p[2]);
          load.push(0, 0, radius, false);
        } else {
          // A move is walked in pieces, so the metal comes off under the cutter.
          //
          // One step per move meant the whole swath of a move vanished the
          // instant the playhead reached it, while the tool was still drawn
          // travelling the first millimetre of it — on a facing pass the entire
          // 115mm cut disappeared in one frame and the cutter then flew over
          // bare stock. The picture said the cut was already made everywhere the
          // tool had not been yet, which is the one thing a simulation is for.
          const subs = subStepsFor(prev, p, subStepLength);
          for (let s = 1; s <= subs; s++) {
            const a = lerp(prev, p, (s - 1) / subs);
            const b = lerp(prev, p, s / subs);
            const took = cut(heights, mask, log, step, grid, a, b, cutter, stockTop, columns);
            const travel = Math.hypot(b[0] - a[0], b[1] - a[1]);
            // A rapid that removes anything is a crash, not a cut, and dividing
            // its swath by its length would report it as a gentle one.
            const feedClass = d[o + 7];
            const rapid = feedClass === FEED.RAPID;
            // A move descending faster than a fiftieth of its own length is
            // boring its way in rather than cutting across, whatever the feed
            // class calls it — the same test the engagement suite uses.
            const entry = rapid || feedClass !== FEED.CUT
              || a[2] - b[2] > travel * 0.02;
            load.push(
              rapid || travel < 1e-9 ? (took.swath > 0 ? 2 * radius : 0)
                : Math.min(took.swath / travel, 2 * radius),
              took.depth, radius, !entry, travel,
            );
            if (rapid && took.depth > RAPID_CUT_EPS) {
              rapidCut.count++;
              if (took.depth > rapidCut.depth) {
                rapidCut.depth = took.depth;
                rapidCut.step = step;
              }
            }
            seconds += moveSeconds(a, b, d[o + 7], feeds, rapidFeed);
            step++;
            times.push(seconds);
            tip.push(b[0], b[1], b[2]);
          }
          prev = p;
        }
      }

      if (log.count > maxEvents) truncated = true;
    }
    opEnds.push(step);
  }

  return {
    opEnds,
    // the voids the earlier setups left under this one's surface, so a
    // breakthrough is drawn as one — see engine/workpiece.js
    inherited: columns ? columns.voids > 0 : false,
    width, height, cellSize,
    origin: [stock.min[0], stock.min[1]],
    stockTop, stockBottom: stock.min[2],
    mask, initial,
    // the surface the program leaves behind, which is what the next setup
    // inherits and what verification measures against the model
    final: heights,
    ...log.trimmed(),
    stepCount: step,
    // three floats per step: where the tip finished it — see `tip` above
    tip: new Float32Array(tip),
    times: new Float32Array(times),
    ...load.trimmed(opEnds),
    rapidCut,
    totalSeconds: seconds,
    truncated,
  };
}

/**
 * How much metal a rapid has to take before it is a crash rather than a
 * rounding error.
 *
 * A hundredth of a millimetre. Below that is a cell the sweep grazes as the
 * tool passes tangent to a wall it has already cut — the same tangency that the
 * widening in `cut` exists to settle — and counting those would report a crash
 * on every retract that leaves a finished face.
 */
const RAPID_CUT_EPS = 0.01;

/**
 * A whole job, not one fixturing of it.
 *
 * The setups of a milling job are one billet held several ways round, and each
 * of them is simulated in its own frame — so the only way the second can start
 * from what the first left is for the first to have been run. This runs them in
 * order, keeping each finished surface as a cut record (engine/workpiece.js)
 * that the next one reads through its own transform.
 *
 * Only the setup being watched keeps an event log, because only that one is
 * scrubbed; the others contribute a surface and nothing else, which is a
 * fraction of the memory. Setups *after* the active one are run when `all` is
 * set — nothing about the picture on screen needs them, but verification does:
 * metal standing proud of the model in setup 1 is not excess if setup 2 is
 * about to take it off.
 *
 * @param setups [{ stock, ops, frame }] in program order, all the same machine
 * @param active which of them is on screen and gets the full record
 * @param all also run the setups after the active one, for their cuts
 * @returns { sim, cuts } — cuts in setup order, one per setup that ran
 */
export function simulateProgram({
  setups, active = 0, all = false,
  maxCells = DEFAULT_MAX_CELLS, rapidFeed = 3000, record = 1,
}) {
  const cuts = [];
  const last = all ? setups.length - 1 : active;
  let sim = null;
  for (let k = 0; k <= last; k++) {
    const setup = setups[k];
    const watched = k === active;
    const run = simulateRemoval({
      stock: setup.stock,
      ops: setup.ops,
      frame: setup.frame,
      cuts: cuts.slice(),
      maxCells,
      rapidFeed,
      record,
      logEvents: watched,
    });
    cuts.push(cutFromSimulation(run, run.final, setup.frame));
    if (watched) sim = run;
  }
  if (!sim) throw new Error(`no setup at index ${active} to simulate`);
  return { sim, cuts };
}

/**
 * What every step asked of the cutter, and the worst of it.
 *
 * The simulation's answer used to be a shape and nothing else, and a shape
 * cannot tell you that the pass which produced it was a full-width slot at the
 * whole depth of cut — the floor looks the same either way. These are the two
 * numbers that separate them, kept per step so the timeline can show where the
 * heavy moments are and summarised so the panel can name the worst one.
 *
 * The radial width is averaged over the piece the sweep walks, which is one
 * cutter diameter (see `subStepLength`). That window is not a compromise, it is
 * the right one: a spike shorter than the cutter's own width is an inside
 * corner, which every concentric toolpath makes and no cutter minds, and what
 * matters is the stretch where the tool is buried for longer than that.
 */
class LoadLog {
  constructor() {
    this.width = [];
    this.depth = [];
    this.peakWidth = 0;
    this.peakWidthAt = -1;
    this.peakDepth = 0;
    this.peakDepthAt = -1;
    this.buried = 0;
    this.cutting = 0;
    this.radius = 1;
  }

  /**
   * @param counts whether this step is ordinary cutting, and so governed by the
   *   stepover. An entry is not: a plunge, a ramp and the little circle a
   *   seeded peel bores are full width by nature, and what governs them is the
   *   ramp angle and the plunge feed. Counting them would report every program
   *   in the app at 1.00xD and say nothing about any of them.
   */
  /**
   * @param radius the cutter's, or 0 for a lathe — where there is no radial
   *   width to speak of, because the tool is a corner rather than a disc, and
   *   the number that decides whether the cut is heavy is the depth of cut on
   *   its own.
   */
  push(width, depth, radius, counts, travel = 0) {
    const step = this.width.length;
    this.width.push(width);
    this.depth.push(depth);
    if (radius > 0) this.radius = radius;
    if (!counts) return;
    if (radius === 0) {
      this.cutting += travel;
      if (depth > this.peakDepth) { this.peakDepth = depth; this.peakDepthAt = step; }
      return;
    }
    // As a fraction of the diameter, because that is the number a machinist
    // sets and the only one comparable between a ⌀3 and a ⌀20.
    const fraction = width / (2 * radius);
    // How *far* the cutter runs buried, which is the number that separates a
    // program with a hard moment in it from one that is heavy throughout. Three
    // quarters of the diameter is clear of every stepover the app defaults to,
    // so it is not a reading of the setting.
    this.cutting += travel;
    if (fraction > 0.75) this.buried += travel;
    if (fraction > this.peakWidth) { this.peakWidth = fraction; this.peakWidthAt = step; }
    // Depth on its own says nothing — a 12mm stepdown is what adaptive is for.
    // What is worth naming is the deepest cut taken at nearly the full width,
    // which is the combination that breaks cutters.
    if (fraction > 0.9 && depth > this.peakDepth) {
      this.peakDepth = depth;
      this.peakDepthAt = step;
    }
  }

  trimmed(opEnds) {
    const opOf = (step) => {
      if (step < 0) return -1;
      for (let i = 0; i < opEnds.length; i++) if (step < opEnds[i]) return i;
      return Math.max(0, opEnds.length - 1);
    };
    return {
      stepWidth: Float32Array.from(this.width),
      stepDepth: Float32Array.from(this.depth),
      load: {
        peakWidth: this.peakWidth,
        peakWidthAt: this.peakWidthAt,
        peakWidthOp: opOf(this.peakWidthAt),
        peakDepth: this.peakDepth,
        peakDepthAt: this.peakDepthAt,
        peakDepthOp: opOf(this.peakDepthAt),
        buried: this.buried,
        cutting: this.cutting,
      },
    };
  }
}

// --- turning ---------------------------------------------------------------
//
// The same idea one dimension down. A milled part is a height for every (x, y);
// a turned one is a radius for every z, because the work is spinning and every
// angle sees the same tool. So the "surface" is a line, the "cells" are Z
// samples, and everything downstream — the event log, the playback cursor, the
// timeline — is exactly the machinery above with a shorter array in it.
//
// This is why the lathe used to say "material simulation is milling only": the
// milling grid is Z-up and running a turning program through it would show a
// tool ploughing across the top of a bar that is actually rotating underneath
// it. The answer was not to force the program into the wrong model but to write
// the right one, which turns out to be smaller.

const DEFAULT_TURN_SAMPLES = 800;

// How finely a move is walked, as a fraction of the sample spacing.
//
// This is the fix for "the simulation removes the stock all at once". A turning
// pass is *one* CL move sixty millimetres long, and the simulator recorded one
// event step for it — so the whole length of bar vanished on a single frame,
// which is not a picture of turning, it is a picture of a diameter changing.
// Milling never showed this because a milling strategy emits a point every
// millimetre or two for reasons of its own.
//
// Fixing it in the strategies would have meant emitting sixty G1s where one is
// correct, so the subdivision lives here: the *simulation* walks the move in
// pieces and records a step for each, while the program keeps the single move
// that belongs in it.
const SUB_STEP = 0.75;
// Safety nets only. What actually sizes a piece is the budget below.
const MAX_SUB_STEPS = 4096;
const MAX_TURN_STEPS = 400_000;

/**
 * How many pieces the whole program is walked in.
 *
 * The piece length used to come only from the sample spacing, so raising the
 * turning detail shortened the pieces and multiplied the number of steps for
 * exactly the same program — and past MAX_TURN_STEPS the run stopped, which is
 * the reported "the simulation ends midway depending on the detail setting".
 * Detail says how finely the *bar* is sampled and has nothing to say about how
 * many frames the program takes to play. So a piece is whichever is longer: a
 * fraction of a sample, or the program's own length shared over a fixed budget.
 */
const TARGET_TURN_STEPS = 80_000;

/**
 * How many surface changes a turning run may record.
 *
 * Stated outright rather than derived from the step budget or the sample count,
 * because it is neither: a bar has three thousand cells and a hundred thousand
 * steps, so a budget sized off the surface starves it, and one sized off the
 * steps shrinks the moment the step target is tuned. What it is sized off is
 * memory — sixteen bytes an event, so this is about 128MB in the worst case,
 * and the worst case is a program hours long at the finest detail.
 */
const TURN_EVENT_BUDGET = 8_000_000;

/** Total distance the tool travels in the (radius, Z) plane, over every op. */
function turnPathLength(ops) {
  let total = 0;
  for (const { cl } of ops) {
    const d = cl.moves;
    let prev = null;
    for (let n = 0; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      const isDrill = d[o] === OP.DRILL;
      const target = isDrill ? [0, d[o + 3]] : [d[o + 1], d[o + 3]];
      if (prev) total += Math.hypot(target[0] - prev[0], target[1] - prev[1]);
      prev = isDrill ? [0, d[o + 4]] : target;
    }
  }
  return total;
}

/** Tools that work inside the part rather than on the outside of it. */
function isInternalTool(tool) {
  return tool?.type === 'boring' || tool?.type === 'drill';
}

/**
 * @param bar { radius, innerRadius, zMin, zMax } — the stock, from engine/lathe.js
 * @param ops [{ cl, tool }] in program order
 * @returns a simulation record; feed it to SimulationPlayback
 *
 * The surface is two lines, not one: an outer radius and an inner radius for
 * every Z. A bar is the pair (bore, OD) at every point along it, and modelling
 * only the OD meant a boring bar and a drill did nothing visible at all — the
 * hole they made was inside a surface that had no inside. They are packed into
 * one array so the event log, the playback cursor and the timeline are the same
 * machinery they were: cells [0, count) are the outside, [count, 2·count) the
 * bore.
 */
export function simulateTurning({
  bar, ops, samples = DEFAULT_TURN_SAMPLES, rapidFeed = 3000, record = 1,
}) {
  const zMin = bar.zMin;
  const zMax = bar.zMax;
  const count = Math.max(2, Math.round(samples));
  const dz = (zMax - zMin) / (count - 1) || 1;
  const barInner = Math.max(0, bar.innerRadius ?? 0);

  const initial = new Float32Array(count * 2);
  initial.fill(bar.radius, 0, count);
  initial.fill(barInner, count, count * 2);
  const surface = initial.slice();
  const mask = new Uint8Array(count * 2).fill(1);
  const log = new EventLog();

  // The tool's own track, one entry per sub-step. The milling simulator reads
  // the cutter position back out of the CL by step index, which only works
  // while the two are one-to-one — and subdividing breaks that. Recording where
  // the tool actually was is both simpler and exact.
  const times = [0];
  const trackX = [0];
  const trackZ = [zMax];
  const trackTool = [0];

  let step = 0;
  let seconds = 0;
  let truncated = false;

  const pieceLength = Math.max(dz * SUB_STEP,
    turnPathLength(ops) / TARGET_TURN_STEPS, 1e-6);
  // both of the ways a turning run can stop early scale together: raising one
  // and not the other just moves which limit the message names
  const scale = recordScale(record);
  const maxEvents = TURN_EVENT_BUDGET * scale;
  const maxSteps = MAX_TURN_STEPS * scale;
  const grid = { zMin, dz, count };
  // see the note in `simulate`: a turning run walks each move in pieces, so its
  // step count is not its move count and only it can say where an op ends
  const opEnds = [];
  // What each step asked of the insert. On a lathe there is no radial *width*
  // to speak of — the tool is a corner, not a disc — so the number that decides
  // whether the cut is heavy is the depth of cut, which is how far the bar's
  // radius drops under the tool. See LoadLog.
  const load = new LoadLog();
  ops.forEach(({ cl, tool }, opIndex) => {
    // The insert's nose is what actually touches the work, and it is why a
    // sharp internal corner comes out with a radius in it. Modelled as a circle
    // rolled along the path, which is the same drop-cutter idea as milling.
    const nose = Math.max(0, tool?.noseRadius ?? 0);
    const half = tool?.type === 'parting' || tool?.type === 'threading'
      ? Math.max(0.05, (tool.bladeWidth || tool.diameter || 1) / 2)
      : 0;
    const internal = isInternalTool(tool);
    // The radius a drill *cycle* opens, read from the tool's diameter whatever
    // the tool is: a DRILL opcode means a hole on the centreline, and that is
    // not a move different tooling performs differently. See the `isDrill`
    // branch below.
    const cycleR = Math.max(0.05, (tool?.diameter ?? 3) / 2);
    // The radius a drill *tool* sweeps on its ordinary moves, and zero for
    // everything else — an insert cuts with its nose, not with its shank.
    const drillR = tool?.type === 'drill' ? cycleR : 0;
    const d = cl.moves;
    let feeds = { cut: 120, plunge: 80 };
    let prev = null;
    const feedEvents = cl.events.filter((e) => e.type === 'feeds');
    feedEvents.sort((a, b) => a.index - b.index);
    let feedCursor = 0;
    // Threading passes are marked, and the mark carries the pitch. Reading it
    // here is what makes the pitch *visible*: a thread pass is one straight
    // move at one radius, so without the form the only thing changing the pitch
    // did on screen was change the depth it works out to — which is the
    // reported bug. See threadCut.
    const threadEvents = cl.events.filter((e) => e.type === 'thread');
    threadEvents.sort((a, b) => a.index - b.index);
    let threadCursor = 0;
    let pitch = 0;
    // and the spindle, because a synchronised pass's speed is pitch × rpm
    const spindleEvents = cl.events.filter((e) => e.type === 'spindle');
    spindleEvents.sort((a, b) => a.index - b.index);
    let spindleCursor = 0;
    let rpm = 0;

    for (let n = 0; n < cl.count && !truncated; n++) {
      while (feedCursor < feedEvents.length && feedEvents[feedCursor].index <= n) {
        feeds = feedEvents[feedCursor++];
      }
      while (threadCursor < threadEvents.length && threadEvents[threadCursor].index <= n) {
        pitch = Math.max(0, threadEvents[threadCursor++].pitch ?? 0);
      }
      while (spindleCursor < spindleEvents.length && spindleEvents[spindleCursor].index <= n) {
        rpm = Math.max(0, spindleEvents[spindleCursor++].rpm ?? 0);
      }
      const o = n * MOVE_STRIDE;
      // X in CL data is a radius; Z runs along the bar. See engine/lathe.js.
      const isDrill = d[o] === OP.DRILL;
      // a drill cycle carries its retract in the axis slot: it starts up there
      // and ends at the bottom of the hole
      const target = isDrill ? [0, d[o + 3]] : [d[o + 1], d[o + 3]];
      if (isDrill && !prev) prev = [0, d[o + 4]];

      if (!prev) {
        prev = target;
        trackX[step] = target[0];
        trackZ[step] = target[1];
        trackTool[step] = opIndex;
        continue;
      }

      const moveSecs = turnSeconds(prev, target, isDrill ? FEED.PLUNGE : d[o + 7],
        feeds, rapidFeed, syncFeed(pitch, rpm));
      const length = Math.hypot(target[0] - prev[0], target[1] - prev[1]);
      const pieces = Math.max(1, Math.min(MAX_SUB_STEPS, Math.ceil(length / pieceLength)));

      for (let s = 1; s <= pieces; s++) {
        const t0 = (s - 1) / pieces;
        const t1 = s / pieces;
        const a = [prev[0] + (target[0] - prev[0]) * t0, prev[1] + (target[1] - prev[1]) * t0];
        const b = [prev[0] + (target[0] - prev[0]) * t1, prev[1] + (target[1] - prev[1]) * t1];
        step++;
        // What the move *is* decides how it cuts, before what the tool is does.
        // A drill cycle opens a hole on the centreline and can do nothing else;
        // only a move that is not a cycle is a question about what is in the
        // turret. Asking the tool first is what let a centre drill programmed
        // with a turning insert fall through to `turnCut` along X0 — an
        // external pass at radius zero, which takes the whole bar with it.
        const took = isDrill
          ? boreCut(surface, mask, log, step, grid, a, b, cycleR, cycleR, true, 0)
          : internal
            ? boreCut(surface, mask, log, step, grid, a, b,
              drillR > 0 ? drillR : nose, drillR > 0 ? drillR : half, drillR > 0, pitch)
            : turnCut(surface, mask, log, step, grid, a, b, nose, half, bar.radius, pitch);
        // A plunge — a groove, a parting cut, a drill — is full depth by nature
        // and is governed by the peck, not by the depth of cut. What the depth
        // of cut governs is a pass running *along* the bar.
        const alongZ = Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]);
        load.push(0, took, 0,
          alongZ && !isDrill && d[o + 7] !== FEED.RAPID && pitch === 0,
          Math.hypot(b[0] - a[0], b[1] - a[1]));
        seconds += moveSecs / pieces;
        times.push(seconds);
        trackX.push(b[0]);
        trackZ.push(b[1]);
        trackTool.push(opIndex);
        if (log.count > maxEvents || step > maxSteps) { truncated = true; break; }
      }

      // a drill cycle ends back at its retract height, so the tool is not left
      // sitting at the bottom of the hole it just made
      prev = isDrill ? [0, d[o + 4]] : target;
    }
    opEnds.push(step);
  });

  return {
    opEnds,
    kind: 'turn',
    zMin, dz, count,
    barRadius: bar.radius,
    barInner,
    mask, initial,
    ...log.trimmed(),
    stepCount: step,
    times: new Float32Array(times),
    ...load.trimmed(opEnds),
    trackX: new Float32Array(trackX),
    trackZ: new Float32Array(trackZ),
    trackTool: new Int32Array(trackTool),
    totalSeconds: seconds,
    truncated,
  };
}

/**
 * How fast the picture of the spindle turns: a hundredth of the programmed rpm.
 *
 * Not the real speed. A bar at 1200rpm is twenty revolutions a second and
 * renders as a blur at any frame rate a browser can offer, which reads as noise
 * rather than as rotation. A hundredth is slow enough to see and still
 * *proportional*, so a roughing pass at 400rpm and a threading pass at 120 look
 * as different as they are — which a fixed rate could not say.
 *
 * One ratio, in one place: the work and the chuck are the same spindle and must
 * never be given two answers about where it is pointing.
 */
export const SPIN_RATIO = 1 / 100;

/** Where the spindle is pointing, in radians, at a moment of the playback clock. */
export function spinAngle(seconds, rpm) {
  if (!(rpm > 0) || !(seconds > 0)) return 0;
  const turns = (rpm * SPIN_RATIO * seconds) / 60;
  // wrapped at a whole turn, which is invisible; wrapping anywhere else puts a
  // jump in the rotation that reads as a glitch rather than as a spindle
  return (turns % 1) * Math.PI * 2;
}

/**
 * The spindle speed an operation was generated with.
 *
 * Read back off the program rather than off the tool, because the operation may
 * override it — and a threading pass that runs at a fifth of the roughing speed
 * should look like it does.
 */
export function opSpindleRpm(op) {
  const event = op?.cl?.events?.find((e) => e.type === 'spindle');
  return event?.rpm > 0 ? event.rpm : 0;
}

/**
 * Where the tool is at a sub-step of a turning simulation.
 *
 * The milling simulator reads this back out of the CL program by step index,
 * which is only possible while one step is one move. A turning simulation walks
 * each move in pieces so the metal comes off where the tool is, so it records
 * the track instead — and reading a recorded position back is both cheaper and
 * incapable of drifting out of step with the events beside it.
 */
export function turnPositionAt(sim, ops, step, seconds = null) {
  const n = sim.trackX.length;
  if (n === 0) return null;
  let i = Math.max(0, Math.min(n - 1, Math.round(step)));
  if (seconds != null) {
    // interpolate within the sub-step, so a rapid reads as a fast traverse
    // rather than as a series of jumps
    const times = sim.times;
    let k = Math.max(0, Math.min(times.length - 1, i));
    while (k > 0 && times[k] > seconds) k--;
    while (k < times.length - 1 && times[k + 1] < seconds) k++;
    i = k;
    const t0 = times[i];
    const t1 = times[Math.min(i + 1, times.length - 1)];
    const f = t1 > t0 ? Math.max(0, Math.min(1, (seconds - t0) / (t1 - t0))) : 0;
    const j = Math.min(i + 1, n - 1);
    return {
      tool: ops[sim.trackTool[j]]?.tool ?? null,
      position: [
        sim.trackX[i] + (sim.trackX[j] - sim.trackX[i]) * f,
        0,
        sim.trackZ[i] + (sim.trackZ[j] - sim.trackZ[i]) * f,
      ],
    };
  }
  return {
    tool: ops[sim.trackTool[i]]?.tool ?? null,
    position: [sim.trackX[i], 0, sim.trackZ[i]],
  };
}

/**
 * Roll the insert along one move, taking the outside of the bar down to
 * whatever it reaches.
 *
 * The programmed point is the *centre* of the nose radius — the same convention
 * a milling CL uses, where the point is the cutter axis rather than a point on
 * its edge (see strategies/turning.js). So the nose is a circle centred on the
 * path, and at a distance `e` along the bar from it the smallest radius it can
 * reach is `r - sqrt(nose² - e²)`. A parting blade has no nose radius; it is a
 * flat of `half` either side, because that is what a blade is.
 */
function turnCut(surface, mask, log, step, grid, p0, p1, nose, half, barRadius, pitch = 0) {
  const { zMin, dz, count } = grid;
  // The move is walked rather than solved: a segment that changes both Z and
  // radius has no closed form for "the lowest radius at this sample", and the
  // pieces are cheap.
  const dr = p1[0] - p0[0];
  const dZ = p1[1] - p0[1];
  const length = Math.hypot(dr, dZ);
  const pieces = Math.max(1, Math.ceil(length / (dz / 2)));
  // A threading pass reaches half a pitch either side of itself, because that
  // is how far the groove it is cutting extends before the next one starts.
  const reach = Math.max(nose, half, pitch > 0 ? pitch / 2 : 0);
  // the deepest the bar's radius drops anywhere under this piece — the lathe's
  // whole answer to "how hard is this cut", the way a radial width is the
  // mill's. See LoadLog.
  let deepest = 0;

  for (let s = 0; s <= pieces; s++) {
    const t = s / pieces;
    const r = p0[0] + dr * t;
    const z = p0[1] + dZ * t;
    if (r - reach >= barRadius) continue;      // still clear of the bar
    const i0 = clampIndex(Math.floor((z - reach - zMin) / dz), count);
    const i1 = clampIndex(Math.ceil((z + reach - zMin) / dz), count);
    for (let i = i0; i <= i1; i++) {
      if (mask[i] === 0) continue;
      const before = surface[i];
      if (before <= r - reach) continue;       // already cut deeper than this can reach
      const zi = zMin + i * dz;
      const e = Math.abs(zi - z);
      let cutTo;
      if (pitch > 0) cutTo = threadFloor(zi, r, pitch, 1);
      else if (e <= half) cutTo = r;           // inside the blade's own width
      else if (nose > 0 && e < nose) cutTo = r - Math.sqrt(nose * nose - e * e);
      else if (nose === 0 && half === 0 && e <= dz / 2) cutTo = r;
      else continue;
      // never past the bore: a parting cut through a tube stops at the hole
      const floor = Math.max(0, surface[count + i]);
      if (cutTo < floor) cutTo = floor;
      if (cutTo >= before - MIN_CHANGE) continue;
      if (before - cutTo > deepest) deepest = before - cutTo;
      surface[i] = cutTo;
      log.push(step, i, cutTo, before);
    }
  }
  return deepest;
}

/**
 * The same, from the inside: a boring bar or a drill opening the hole outward.
 *
 * Every sign is the other way round. The bore *grows*, the tool's nose sits on
 * the far side of the surface from where an external one would, and a cell
 * already bored bigger than this pass can reach is the one to skip. A drill is
 * the degenerate case — a flat of its own radius, which is what a hole is.
 */
function boreCut(surface, mask, log, step, grid, p0, p1, nose, half, isDrill, pitch = 0) {
  const { zMin, dz, count } = grid;
  const dr = p1[0] - p0[0];
  const dZ = p1[1] - p0[1];
  const length = Math.hypot(dr, dZ);
  const pieces = Math.max(1, Math.ceil(length / (dz / 2)));
  const reach = Math.max(nose, half, dz / 2, pitch > 0 ? pitch / 2 : 0);
  // how far the bore opens out under this piece — see turnCut
  let deepest = 0;

  for (let s = 0; s <= pieces; s++) {
    const t = s / pieces;
    const r = p0[0] + dr * t;
    const z = p0[1] + dZ * t;
    const i0 = clampIndex(Math.floor((z - reach - zMin) / dz), count);
    const i1 = clampIndex(Math.ceil((z + reach - zMin) / dz), count);
    for (let i = i0; i <= i1; i++) {
      const cell = count + i;
      if (mask[cell] === 0) continue;
      const before = surface[cell];
      if (before >= r + reach) continue;      // already bigger than this can reach
      const zi = zMin + i * dz;
      const e = Math.abs(zi - z);
      let cutTo;
      if (pitch > 0 && !isDrill) {
        cutTo = threadFloor(zi, r, pitch, -1);
      } else if (isDrill) {
        // a drill cuts its own diameter for the whole length it has reached
        if (e > dz) continue;
        cutTo = Math.max(half, r);
      } else if (e <= half) {
        cutTo = r;
      } else if (nose > 0 && e < nose) {
        cutTo = r + Math.sqrt(nose * nose - e * e);
      } else if (nose === 0 && half === 0 && e <= dz / 2) {
        cutTo = r;
      } else continue;
      // a bore can never be bigger than the outside of the bar at that point
      const ceiling = surface[i];
      if (cutTo > ceiling) cutTo = ceiling;
      if (cutTo <= before + MIN_CHANGE) continue;
      if (cutTo - before > deepest) deepest = cutTo - before;
      surface[cell] = cutTo;
      log.push(step, cell, cutTo, before);
    }
  }
  return deepest;
}

// The flank of a thread form, as radial rise per millimetre along the bar. A
// 60° ISO form leaves the groove centre at 30° to the radius, so it opens out
// √3 times faster than it moves along — which is why a coarse pitch leaves a
// flat crest between the grooves and a fine one does not.
const THREAD_FLANK = 1 / Math.tan(Math.PI / 6);

/**
 * The floor of a thread groove at one point along the bar.
 *
 * A single-point pass cuts a helix, and the axial profile of a helix is the
 * same V groove repeated once per pitch. Modelling it is what makes the pitch
 * something you can see and count: without it a threading pass is one straight
 * move at one radius, so the only thing changing the pitch did on screen was
 * change the depth the form works out to — the tool appeared to move in X when
 * the setting was about Z.
 *
 * @param at the radius the pass is cutting at — the deepest point of the groove
 * @param side +1 on the outside of the bar, −1 in a bore
 */
function threadFloor(z, at, pitch, side) {
  const e = Math.abs(z - Math.round(z / pitch) * pitch);
  return at + side * e * THREAD_FLANK;
}

/**
 * How long a turning move takes, in seconds.
 *
 * @param synced mm/min for a spindle-synchronised move (pitch × rpm), or 0.
 *   It outranks the tool's feeds: a threading pass has no feedrate of its own,
 *   and reading one off the insert is what made a short thread take an hour on
 *   the clock. See cl.js `syncFeed`.
 */
function turnSeconds(p0, p1, feedClass, feeds, rapidFeed, synced = 0) {
  const distance = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (distance === 0) return 0;
  // The cross slide and the carriage have their own rapid rates and run at once
  // — the same axis-limited G0 the mill uses, with X standing in for XY.
  if (feedClass === FEED.RAPID) {
    return rapidSeconds(Math.abs(p1[0] - p0[0]), p1[1] - p0[1], rapidFeed);
  }
  // No descent term: on a lathe the tool is a corner working in one plane, and
  // "down" is along the bar rather than into it — a Z move is a cut, not a
  // plunge. `feedRate` still answers the two classes that matter here.
  const rate = synced > 0 ? synced : feedRate(feedClass, feeds);
  return (distance / Math.max(1, rate)) * 60;
}

/**
 * 1 where the cell is inside the stock footprint, 0 outside (round bar).
 *
 * `isRoundStock`, not `kind === 'cylinder'`: a tube is round stock too, and
 * testing the name meant a piece of pipe simulated as a **square billet** — no
 * bore, and not even round. Its bore is masked off as well, because nothing in
 * there is material.
 */
function buildMask(stock, width, height, cellSize) {
  const mask = new Uint8Array(width * height).fill(1);
  if (!isRoundStock(stock) || !stock.cylinder) return mask;
  const { center, diameter, innerDiameter = 0 } = stock.cylinder;
  const r = diameter / 2;
  const bore = innerDiameter / 2;
  for (let j = 0; j < height; j++) {
    const y = stock.min[1] + j * cellSize;
    for (let i = 0; i < width; i++) {
      const x = stock.min[0] + i * cellSize;
      const d = Math.hypot(x - center[0], y - center[1]);
      if (d > r || d < bore) mask[j * width + i] = 0;
    }
  }
  return mask;
}

/**
 * The tool's surface height at radial distance `d`, read straight off the
 * profile table.
 *
 * `clearanceProfile` answers the same question through a closure, and that is
 * the right shape for every caller but this one: the sweep below asks it once
 * per grid cell per move — tens of millions of times on a real program — and at
 * that rate the call is a measurable part of the simulation. Same table, same
 * numbers, no second description of the cutter.
 */
function surfaceAt(table, scale, samples, d) {
  const t = d * scale;
  const i = t | 0;
  if (i >= samples) return table[samples];
  return table[i] + (table[i + 1] - table[i]) * (t - i);
}

/** The same, for a cell at offset (ex, ey) from the start of a move, at time t. */
function heightOver(ex, ey, dx, dy, z0, dz, t, table, scale, samples) {
  const gx = ex + dx * t;
  const gy = ey + dy * t;
  const d2 = gx * gx + gy * gy;
  return z0 + dz * t + surfaceAt(table, scale, samples, d2 > 0 ? Math.sqrt(d2) : 0);
}

/**
 * How far past its closest approach a descending cutter is still going down
 * over one cell, measured along the floor.
 *
 * Picture the cell in the cutter's own frame: the tool passes at a closest
 * distance `nearest`, so as it goes by, the cell slides *up* the flank — from
 * the tool's edge in to `nearest` and back out again. Meanwhile the whole tool
 * is descending at `fall`. The cell keeps getting deeper for as long as the
 * tool drops faster than the cell climbs the flank, and the moment those two
 * cancel is the bottom of the cut. Balanced:
 *
 *     fall = m · (offset / distance)
 *
 * where `m` is how steeply the flank rises out there. Solved for the offset,
 * that is `√nearest · fall / √(m² − fall²)`.
 *
 * That is an equation in `m`, and `m` depends on where the answer lands. This
 * function breaks the circle by reading the profile's own slope where the
 * caller's first guess landed and then solving as though the flank were a *cone*
 * of that slope — which is exactly what a V bit, a chamfer mill and the corner
 * of a face mill are, since a cone has the same slope all the way along, so for
 * those it is not an approximation at all.
 *
 * It is one of the three the sweep tries; see `cut`.
 *
 * (Iterating this instead of taking the best of three looks tidier and buys
 * nothing: for a cell the tool passes directly over, `nearest` is zero, and then
 * the expression below is zero however often it is applied — it would report the
 * deepest moment as the closest approach for every cutter alike, which is a
 * 2.4mm ridge left along the middle of a plunging ball-nose cut.)
 *
 * A flank shallower than the fall never cancels it: the tool is still going
 * down when the cell leaves it, so the deepest moment is the last one, `reach`.
 *
 * @param nearest squared closest approach in the floor plane
 * @param from where to read the flank slope — the sphere's answer
 * @param reach half the length of the contact, along the floor
 * @param fall the path's descent per unit of travel across the floor
 */
function coneStop(slope, scale, samples, nearest, from, reach, fall) {
  const at = Math.sqrt(nearest + from * from) * scale;
  const i = at | 0;
  const m = slope[i < samples ? i : samples - 1];
  if (!(m > fall)) return reach;
  const off = (Math.sqrt(nearest) * fall) / Math.sqrt(m * m - fall * fall);
  return off < reach ? off : reach;
}

/**
 * Lower every cell the cutter sweeps between p0 and p1.
 *
 * The question for one cell is: over the move, what is the lowest the tool's
 * surface ever gets directly above it? Written out, that is
 *
 *     min over t of   z(t) + profile(|p(t) − cell|)
 *
 * on the stretch of t where the cell is under the cutter at all. Both terms are
 * convex in t — one is a straight line, the other a rising profile of a
 * distance — so the sum is convex, and its minimum is in one of three places:
 * where the cell comes under the cutter, where it leaves, or a single turning
 * point between the two.
 *
 * It used to be sampled at the two *ends of the move* and the closest approach
 * instead, and those are not the same three points. On a level cut they happen
 * to coincide, which is why roughing looked right. On a ramp they do not: the
 * deepest moment for a cell is the last instant it is still under the descending
 * cutter, and that instant is in the middle of the move, so nothing evaluated
 * it. A 15° ramp came out **0.8mm shallow** and a plunging ball nose 2mm — the
 * simulation drew a ramp entry as a shallower ramp with a ridge along it, which
 * is exactly the shape a real one leaves when it is cutting badly.
 *
 * The window is solved rather than searched: |p(t) − cell| = r is a quadratic in
 * t, and its two roots are the moments the cell enters and leaves. Its
 * discriminant also answers "does this cell get touched at all", which throws
 * out the corners of the bounding box before any of the work below — so the
 * exact version is *cheaper* than the sampled one it replaces, not dearer.
 *
 * The turning point is where the tool's flank stops falling faster than the path
 * does. Where that is depends on how steep the flank is *there*, which is what
 * the answer is for, so it is estimated three ways — see the three candidates
 * below — and the deepest of them kept. Each is a moment the tool really passes
 * through, so the lowest is the best bound available and none of them can remove
 * metal the cutter did not reach.
 *
 * A square-ended cutter has no flank at all, so there is nothing between the two
 * ends worth looking at and all of that is skipped: roughing, which is most of a
 * program, takes the cheap path.
 *
 * @param cutter from `profileTable` — the same silhouette everything else uses
 */
/**
 * How much metal one piece of a move took off, in the two numbers that decide
 * whether it breaks the cutter.
 *
 * Both fall out of a sweep that is already visiting every cell it lowers, so
 * this costs two comparisons per cell and nothing else. They are worth having
 * because the shape of the finished part — which is all the simulation used to
 * report — cannot show them: a pass that takes a tenth of a millimetre and one
 * that takes the whole diameter leave the same floor behind, and only one of
 * them arrives at the machine in one piece.
 *
 * `swath` counts only cells brought down to the tool's own tip plane, and that
 * is the whole of why it is a *radial width* rather than a volume. Counting
 * every cell the tool lowered reads a face mill at a 0.6xD stepover as 4xD,
 * because a cell in the corner radius comes closer to the axis as the tool
 * advances and is lowered again by every step.
 */
const NOTHING_REMOVED = { swath: 0, depth: 0 };

function cut(heights, mask, log, step, grid, p0, p1, cutter, stockTop, columns) {
  // nothing below the stock top can be touched by a move that stays above it
  const lowestZ = p0[2] < p1[2] ? p0[2] : p1[2];
  if (lowestZ >= stockTop) return NOTHING_REMOVED;

  const { width, height, cellSize, origin } = grid;
  const { table, slope, scale, samples, radius, edge, flat } = cutter;
  const x0 = p0[0], y0 = p0[1], z0 = p0[2];
  const dx = p1[0] - x0, dy = p1[1] - y0, dz = p1[2] - z0;
  const lenSq = dx * dx + dy * dy;
  // A nanometre of extra cutter, so that a cell sitting exactly one radius from
  // the path is reliably touched.
  //
  // Such a cell is *tangent* to the sweep — the edge passes through it and
  // removes a contact of zero width — and axis-aligned toolpaths on an
  // axis-aligned grid produce them by the row: every pass of a facing cut has
  // one down each side. The test for contact is the sign of a discriminant that
  // is exactly zero there, so in floating point it lands either side from one
  // cell to the next, and a strict reading scatters speckles of raw stock
  // through a machined floor and shortens the cut by a cell at each end.
  //
  // Widening decides them all the same way instead. Nothing real is added: this
  // is a thousandth of the micron the log is even able to record.
  const r2 = radius * radius * (1 + 1e-9);
  const ox = origin[0], oy = origin[1];
  // the deepest point of the cutter, anywhere on this move: a cell already at
  // or under it cannot be lowered, whatever the geometry works out to
  const floor = lowestZ + table[0];
  // the tip plane, for the swath — see NOTHING_REMOVED above
  const plane = lowestZ + 1e-4;
  const cellArea = cellSize * cellSize;
  let swathCells = 0;
  let deepest = 0;

  const i0 = clampIndex(Math.floor((Math.min(x0, p1[0]) - radius - ox) / cellSize), width);
  const i1 = clampIndex(Math.ceil((Math.max(x0, p1[0]) + radius - ox) / cellSize), width);
  const j0 = clampIndex(Math.floor((Math.min(y0, p1[1]) - radius - oy) / cellSize), height);
  const j1 = clampIndex(Math.ceil((Math.max(y0, p1[1]) + radius - oy) / cellSize), height);

  // A move with no travel in XY is a plunge or a retract: the distance to every
  // cell is fixed for the whole of it, so the deepest moment is simply whichever
  // end is lower. Kept apart because the window below divides by the travel.
  if (lenSq <= 1e-12) {
    const zLow = lowestZ;
    for (let j = j0; j <= j1; j++) {
      const ey = y0 - (oy + j * cellSize);
      const row = j * width;
      for (let i = i0; i <= i1; i++) {
        const cell = row + i;
        const before = heights[cell];
        if (before <= floor || mask[cell] === 0) continue;
        const ex = x0 - (ox + i * cellSize);
        const d2 = ex * ex + ey * ey;
        if (d2 > r2) continue;
        const lowest = zLow + surfaceAt(table, scale, samples, Math.sqrt(d2));
        if (lowest >= before - MIN_CHANGE) continue;
        const settled = columns ? settleThrough(columns, cell, lowest) : lowest;
        if (before - lowest > deepest) deepest = before - lowest;
        if (before > plane && lowest <= plane) swathCells++;
        log.push(step, cell, settled, before);
        heights[cell] = settled;
      }
    }
    return { swath: swathCells * cellArea, depth: deepest };
  }

  const inv = 1 / lenSq;
  const z1 = z0 + dz;
  // How steeply the path falls, per millimetre of travel across the floor, and
  // which way along it the deepest moment therefore lies.
  const invTravel = 1 / Math.sqrt(lenSq);
  const fall = Math.abs(dz) * invTravel;
  const toward = dz < 0 ? 1 : -1;
  // A square-ended cutter reaches the same depth everywhere under itself, so
  // its deepest moment over a cell is always one of the two contacts and there
  // is nothing between them to look at. Every other cutter has a flank, and on
  // a level cut its deepest moment is the closest approach — which the fall
  // being zero puts the search at, so that is not a third case.
  const interior = !flat;
  // Where the sphere through both contacts bottoms out, as a fraction of the
  // half-contact. Constant over the move, so it is worked out here rather than
  // per cell.
  const sphere = fall / Math.sqrt(1 + fall * fall);
  // And how far out the flank first climbs faster than the path falls. Below
  // this the tool is still going down; the profile is convex, so its slope only
  // ever increases and the crossing can be found by halving. For a cell the
  // tool passes directly over — the ones along the middle of a cut, where the
  // eye goes — this *is* the answer, since there the cell rides straight up the
  // flank and nothing dilutes it.
  let lo = 0;
  let hi = samples;
  while (lo < hi) {
    const k = (lo + hi) >> 1;
    if (slope[k] > fall) hi = k; else lo = k + 1;
  }
  const climb = lo / scale;
  const climb2 = climb * climb;
  for (let j = j0; j <= j1; j++) {
    const ey = y0 - (oy + j * cellSize);
    const row = j * width;
    for (let i = i0; i <= i1; i++) {
      const cell = row + i;
      const before = heights[cell];
      if (before <= floor || mask[cell] === 0) continue;
      const ex = x0 - (ox + i * cellSize);

      // when the cell is under the cutter: |e + t·d| = r
      const b = ex * dx + ey * dy;
      const c0 = ex * ex + ey * ey;
      const disc = b * b - lenSq * (c0 - r2);
      if (disc <= 0) continue;                   // the sweep misses it entirely
      const root = Math.sqrt(disc);
      const half = root * inv;                   // half the window, in t
      const mid = -b * inv;                      // the closest approach
      let ta = mid - half;
      let tb = mid + half;
      if (tb <= 0 || ta >= 1) continue;          // the window is off this move

      // Where it enters. Inside the window the tool is at its full radius, so
      // the height there is the edge of the profile and needs no lookup; only a
      // cell already under the cutter when the move began has to be measured.
      let lowest;
      if (ta > 0) {
        lowest = z0 + dz * ta + edge;
      } else {
        ta = 0;
        lowest = z0 + surfaceAt(table, scale, samples, Math.sqrt(c0));
      }

      // and where it leaves
      if (tb < 1) {
        const v = z0 + dz * tb + edge;
        if (v < lowest) lowest = v;
      } else {
        tb = 1;
        const fx = ex + dx, fy = ey + dy;
        const v = z1 + surfaceAt(table, scale, samples, Math.sqrt(fx * fx + fy * fy));
        if (v < lowest) lowest = v;
      }

      // and the turning point between the two, when the cutter has a flank
      //
      // Three offsets from the closest approach, each exact for a flank of one
      // shape: a sphere through both contacts (a ball nose), a cone of whatever
      // slope the profile has out there (a V bit, a chamfer mill, the corner of
      // a face mill), and the distance at which the flank starts out-climbing
      // the fall (a bull nose, and exact for a cell the tool passes over). The
      // deepest of the three wins — each is a moment the tool really passes
      // through, so the lowest is the best bound and none can invent a cut.
      if (interior) {
        const near = r2 - disc * inv;            // squared closest approach
        const nearest = near > 0 ? near : 0;
        const reach = root * invTravel;          // half the contact, along the floor
        const spherical = reach * sphere;
        let ti = mid + toward * spherical * invTravel;
        if (ti > ta && ti < tb) {
          const v = heightOver(ex, ey, dx, dy, z0, dz, ti, table, scale, samples);
          if (v < lowest) lowest = v;
        }
        // A level cut is already answered: with nothing falling, the sphere put
        // the search at the closest approach, which is where a flank is deepest.
        // The other two only say anything on a ramp — and `reach` is the end of
        // the contact, which is one of the two ends above, so only a turning
        // point strictly inside is worth another look.
        const conical = fall === 0 ? reach
          : coneStop(slope, scale, samples, nearest, spherical, reach, fall);
        if (conical < reach) {
          ti = mid + toward * conical * invTravel;
          if (ti > ta && ti < tb) {
            const v = heightOver(ex, ey, dx, dy, z0, dz, ti, table, scale, samples);
            if (v < lowest) lowest = v;
          }
        }
        if (climb2 > nearest) {
          const climbing = Math.sqrt(climb2 - nearest);
          ti = mid + toward * climbing * invTravel;
          if (climbing < reach && ti > ta && ti < tb) {
            const v = heightOver(ex, ey, dx, dy, z0, dz, ti, table, scale, samples);
            if (v < lowest) lowest = v;
          }
        }
      }

      if (lowest >= before - MIN_CHANGE) continue;
      // What the cutter took is measured against where the metal was; where the
      // surface ends up is that, dropped through anything an earlier setup
      // already hollowed out under it. The two differ exactly at a
      // breakthrough, and each is the right answer to its own question.
      const settled = columns ? settleThrough(columns, cell, lowest) : lowest;
      if (before - lowest > deepest) deepest = before - lowest;
      if (before > plane && lowest <= plane) swathCells++;
      log.push(step, cell, settled, before);
      heights[cell] = settled;
    }
  }
  return { swath: swathCells * cellArea, depth: deepest };
}

function clampIndex(v, n) { return v < 0 ? 0 : v > n - 1 ? n - 1 : v; }

/**
 * The most pieces a whole milling program may be walked in.
 *
 * Each one costs three floats of tip and an entry in the clock, so this is
 * about 2MB at the cap — the same order as the event log it sits beside. A
 * program long enough to hit it is already finer than a scrub bar can resolve.
 */
const MAX_MILL_STEPS = 200_000;

/** Total XY travel of every move in the program, for the piece budget. */
function programLength(ops) {
  let total = 0;
  for (const { cl } of ops) {
    const d = cl.moves;
    for (let n = 1; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      const p = (n - 1) * MOVE_STRIDE;
      total += Math.hypot(d[o + 1] - d[p + 1], d[o + 2] - d[p + 2], d[o + 3] - d[p + 3]);
    }
  }
  return total;
}

/** How many pieces this move is walked in. One, for anything short. */
function subStepsFor(a, b, length) {
  const span = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (!(span > length)) return 1;
  return Math.min(MAX_MOVE_PIECES, Math.ceil(span / length));
}

/** A single move never becomes most of the program's steps on its own. */
const MAX_MOVE_PIECES = 512;

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function moveSeconds(a, b, feedClass, feeds, rapidFeed = 3000) {
  if (feedClass === FEED.RAPID) {
    return rapidSeconds(Math.hypot(b[0] - a[0], b[1] - a[1]), b[2] - a[2], rapidFeed);
  }
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  // the same rule the post writes and the estimate counts on — see cl.js feedRate
  const rate = feedRate(feedClass, feeds, descentOf(a, b));
  return (dist / rate) * 60;
}

function drillSeconds(retractZ, zBottom, plunge, rapidFeed = 3000) {
  const depth = Math.max(0, retractZ - zBottom);
  return (depth / plunge) * 60 + rapidSeconds(0, depth, rapidFeed);
}

/**
 * Playhead over a simulation record.
 *
 * Holds the current surface and a cursor into the event log. Seeking forward
 * applies events, seeking back undoes them using the height each cell had
 * before — so reverse is exact, not approximate, and costs the same as forward.
 */
export class SimulationPlayback {
  constructor(sim) {
    this.sim = sim;
    this.current = sim.initial.slice();
    this.cursor = 0;   // number of events applied
    this.step = 0;
  }

  /** Move the playhead; returns the cells whose height changed. */
  seek(step) {
    const { evStep, evCell, evHeight, evPrev, eventCount } = this.sim;
    const target = Math.max(0, Math.min(step, this.sim.stepCount));
    const changed = new Set();

    while (this.cursor < eventCount && evStep[this.cursor] <= target) {
      const i = this.cursor++;
      this.current[evCell[i]] = evHeight[i];
      changed.add(evCell[i]);
    }
    while (this.cursor > 0 && evStep[this.cursor - 1] > target) {
      const i = --this.cursor;
      this.current[evCell[i]] = evPrev[i];
      changed.add(evCell[i]);
    }

    this.step = target;
    return changed;
  }

  /** Seconds of machining elapsed at the playhead. */
  get seconds() {
    return this.sim.times[Math.min(this.step, this.sim.times.length - 1)];
  }

  /**
   * Has this cell been cut at all by now?
   *
   * Against the *raw* stock top, not against where this simulation started:
   * with a second setup starting from what the first one left, a surface
   * machined an hour ago is below the billet but exactly at this run's initial
   * height, and comparing with the initial would paint it as untouched stock.
   * A turning record has no single top — its bar has a bore — so there it is
   * the initial radius, which is the same statement one dimension down.
   */
  isCut(cell) {
    return this.current[cell] < (this.sim.stockTop ?? this.sim.initial[cell]) - 1e-6;
  }
}

/**
 * The playhead clock, in seconds.
 *
 * Time is the authority and the step is derived from it — never the other way
 * round. Steps are coarse in time (a single plunge can run for seconds), so
 * advancing by rounding the clock onto a step and reading that step's timestamp
 * back would snap the clock to the start of the current step every tick and
 * playback would sit still forever.
 */
export class PlaybackClock {
  constructor(times, stepCount) {
    this.times = times;
    this.stepCount = stepCount;
    this.seconds = 0;
    this.cursor = 0;   // last step found, so forward scanning stays local
  }

  get total() { return this.times[this.times.length - 1] ?? 0; }

  /** Snap the clock to a step (used when the user scrubs). */
  toStep(step) {
    const clamped = Math.max(0, Math.min(Math.round(step), this.stepCount));
    this.seconds = this.times[clamped] ?? 0;
    this.cursor = clamped;
    return clamped;
  }

  /** Run the clock forward and report the step it lands on. */
  advance(dtSeconds) {
    this.seconds += dtSeconds;
    return this.stepAt(this.seconds);
  }

  stepAt(seconds) {
    const times = this.times;
    if (times[this.cursor] > seconds) this.cursor = 0;
    let i = this.cursor;
    while (i < times.length - 1 && times[i + 1] <= seconds) i++;
    this.cursor = i;
    return i;
  }

  get finished() {
    return this.seconds >= this.total || this.cursor >= this.stepCount;
  }
}

/**
 * Tool tip position at the end of a given step.
 *
 * Read off the record the simulator wrote rather than counted out of the
 * program: a step is no longer one CL move, because a move long enough to
 * matter is walked in pieces so the metal comes off under the cutter. Counting
 * moves would put the tool somewhere it never was, and getting further out the
 * longer the program ran.
 *
 * Which tool it is still comes from `opEnds`, which is the same list the
 * timeline draws its bands from.
 */
export function positionAtStep(sim, ops, step) {
  if (ops.length === 0) return null;
  const { tip, opEnds, stepCount } = sim ?? {};
  const at = Math.max(0, Math.min(step, (stepCount ?? 1) - 1));
  if (!tip || tip.length < 3) return null;
  const k = Math.min(at, tip.length / 3 - 1);
  // the first op whose end is past this step
  let index = 0;
  while (index < opEnds.length - 1 && opEnds[index] <= at) index++;
  return {
    position: [tip[k * 3], tip[k * 3 + 1], tip[k * 3 + 2]],
    tool: ops[Math.min(index, ops.length - 1)].tool,
  };
}

/**
 * Tool tip position at a moment in time.
 *
 * The step at that time is the *destination*; the tool is interpolated from
 * the previous point toward it based on how much of the move has elapsed. This
 * is what turns a rapid from an instant teleport into a visible fast traverse.
 *
 * `times[k]` is the wall-clock at which step k *starts* — simulateRemoval seeds
 * it with 0 and pushes after each move, so the entry for a step is the clock
 * before it runs. Step k therefore occupies times[k] to times[k+1], and that is
 * the interval the search below finds and the one the interpolation divides by.
 * (This said "finishes" and "times[k-1] to times[k]", which reads as an
 * off-by-one in code that has none.)
 */
export function positionAtTime(sim, ops, seconds) {
  if (ops.length === 0) return null;
  const times = sim?.times;
  if (!times || times.length === 0) return null;

  // find the step whose interval contains this instant
  let step = 0;
  while (step < times.length - 1 && times[step + 1] < seconds) step++;
  const target = positionAtStep(sim, ops, step);
  if (!target) return null;
  if (step === 0) return target;

  const start = positionAtStep(sim, ops, step - 1);
  const t0 = times[step];
  const t1 = times[step + 1] ?? t0;
  const span = Math.max(1e-9, t1 - t0);
  const frac = Math.max(0, Math.min(1, (seconds - t0) / span));
  return {
    tool: target.tool,
    position: [
      start.position[0] + (target.position[0] - start.position[0]) * frac,
      start.position[1] + (target.position[1] - start.position[1]) * frac,
      start.position[2] + (target.position[2] - start.position[2]) * frac,
    ],
  };
}
