// A G-code file, turned back into the thing the rest of the app understands.
//
// Everything downstream of a strategy — the toolpath in the viewport, the
// simulation, the timeline, the cycle-time estimate, the load report, the
// verification against the model — works on CL data and knows nothing about
// where it came from. So the cheapest possible way to be able to *check
// somebody else's program* is to parse it and hand it over as CL data. Not one
// of those things needs a second implementation; the file simply arrives by a
// different door.
//
// Which is also the honest way to check our own. A post is the one stage
// nothing verifies: the program is printed by code that looks right and then
// trusted. Read it back into CL data and it can be diffed against the CL data
// it was printed from, so a flipped G2/G3, a dropped modal word or a units slip
// is a path that no longer matches rather than a scrapped part.
//
// The checks here are the ones that need the *whole program* in front of them
// and so cannot live in a strategy: does it fit the machine, does it rapid
// through the billet, does it go over a clamp. A strategy knows its own moves
// and nothing about the file they end up in.

import { CLBuilder, FEED, MOVE_STRIDE, OP, eachMove } from './cl.js';
import { parseGcode } from '../post/parse.js';
import { fixtureLoops, fixtureTop } from './fixtures.js';
import { pointInLoops } from '../geom/inside.js';
import { machineWarnings } from '../doc/machines.js';
import { plural } from './text.js';

/**
 * A move that descends more steeply than this is boring its way in rather than
 * cutting across, whatever feed word it carries — the same test the engagement
 * suite and the simulator's load report use, so all three agree about what a
 * plunge is.
 */
const PLUNGE_SLOPE = 0.02;

/**
 * Parsed motion → CL data.
 *
 * Feed classes are recovered rather than read: a file says G0 or G1 and has no
 * word for "this one is a ramp". G0 is a rapid, a G1 that goes almost straight
 * down is a plunge, and everything else is a cut. That is the whole of what the
 * distinction is used for downstream (colouring, timing, the load report), and
 * inventing more of it than the file contains would be a picture of a program
 * that was not posted.
 *
 * Canned cycles stay cycles. The CL data has a drill move for exactly this
 * reason, so a G83 arrives as one hole and not as eleven pecks that the
 * simulator would then have to recognise as a hole again.
 *
 * @param parsed from parseGcode
 * @returns { cl, extent, speeds, stats }
 */
export function clFromGcode(parsed) {
  const cl = new CLBuilder();
  const events = [...(parsed.events ?? [])];
  let nextEvent = 0;
  let feed = null;
  let maxFeed = 0;
  let maxRpm = 0;
  let minRpm = Infinity;
  let tools = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  // Where in the CL every G-code line ended up, so a click in one panel can
  // find the other. The post builds the same map the other way round.
  const lineOf = [];

  const grow = (x, y, z) => {
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  };

  const flushEventsTo = (line) => {
    while (nextEvent < events.length && events[nextEvent].line <= line) {
      const e = events[nextEvent++];
      if (e.type === 'tool') { tools++; cl.toolChange(e.tool ?? 1); }
      else if (e.type === 'spindle') {
        if (e.rpm > 0) {
          cl.spindle(e.rpm, e.dir);
          if (e.rpm > maxRpm) maxRpm = e.rpm;
          if (e.rpm < minRpm) minRpm = e.rpm;
        }
      } else if (e.type === 'coolant') cl.coolant(e.mode);
      else if (e.type === 'feed') {
        feed = e.feed;
        if (feed > maxFeed) maxFeed = feed;
        // Plunge and cut are one number in a file — there is only ever one F in
        // force — so saying so is the truthful translation.
        cl.event('feeds', { cut: feed, plunge: feed });
      }
    }
  };

  let prev = null;
  for (const m of parsed.motion) {
    flushEventsTo(m.line);
    lineOf.push(m.line);
    if (m.kind === 'cycle') {
      grow(m.x, m.y, m.z);
      grow(m.x, m.y, m.retract);
      // `r` is where the feed starts, which is what a CL cycle carries; the
      // *return* is where the control leaves the tool, which is what the next
      // move has to start from.
      cl.drill(m.x, m.y, m.z, { retractZ: m.r ?? m.retract, peck: m.q ?? 0, dwell: m.p ?? 0 });
      prev = [m.x, m.y, m.retract];
      continue;
    }
    grow(m.x, m.y, m.z);
    if (m.rapid) {
      cl.rapid(m.x, m.y, m.z);
    } else {
      const travel = prev ? Math.hypot(m.x - prev[0], m.y - prev[1]) : 0;
      const drop = prev ? prev[2] - m.z : 0;
      const plunging = drop > 0 && drop > travel * PLUNGE_SLOPE;
      cl.cut(m.x, m.y, m.z, plunging ? FEED.PLUNGE : FEED.CUT);
    }
    prev = [m.x, m.y, m.z];
  }
  flushEventsTo(Infinity);

  return {
    cl: cl.finish(),
    lineOf,
    extent: Number.isFinite(min[0]) ? { min, max } : null,
    speeds: {
      maxRpm, minRpm: Number.isFinite(minRpm) ? minRpm : 0, maxFeed, at: {},
    },
    stats: { tools, blocks: parsed.blocks, units: parsed.units },
  };
}

/** Parse and convert in one step, which is how every caller wants it. */
export function readGcode(text, options = {}) {
  const parsed = parseGcode(text, options);
  return { parsed, ...clFromGcode(parsed) };
}

/**
 * What is wrong with a program, read as a whole.
 *
 * Three questions a strategy cannot answer about itself, because each of them
 * is about the file rather than about a pass:
 *
 *   - does every move fit inside the machine's travels
 *   - does anything pass over a clamp below the clamp's own height
 *
 * The other question of that kind — does anything rapid *through* metal — is
 * not here, and deliberately. Read off the geometry it is a guess ("a G0 that
 * travels while below the top of the billet") that fires on every stay-down
 * link this app makes on purpose, and a warning that fires on correct programs
 * is a warning nobody reads. The simulation knows what was actually in front of
 * the tool, so it counts them: `sim.rapidCut`.
 *
 * Plus whatever the parser could not read, which matters more here than
 * anywhere else: a program half-understood is a check that passes for the wrong
 * reason.
 *
 * @returns [{ level, text, line }] — empty when there is nothing to say
 */
export function reviewProgram({
  cl, parsed, machine, stock, fixtures, extent, speeds,
}) {
  const out = [];

  const unread = new Map();
  for (const u of parsed?.unsupported ?? []) {
    if (!unread.has(u.code)) unread.set(u.code, u.line);
  }
  if (unread.size) {
    const codes = [...unread.keys()];
    out.push({
      level: 'warn',
      line: unread.get(codes[0]),
      text: `${plural(codes.length, 'code')} in this file went unread `
        + `(${codes.slice(0, 6).join(', ')}${codes.length > 6 ? '…' : ''}). `
        + 'Everything below is a check on the part of the program that was understood.',
    });
  }

  for (const w of machineWarnings(machine, extent, speeds)) out.push({ ...w, line: -1 });

  const over = movesOverClamps(cl, fixtures);
  if (over.count) {
    out.push({
      level: 'warn',
      line: over.line,
      text: `${plural(over.count, 'move')} ${over.count === 1 ? 'passes' : 'pass'} over `
        + `${over.name} below its own height of Z${over.top.toFixed(1)}.`,
    });
  }

  return out;
}

/**
 * Moves whose XY is inside a clamp's footprint and whose Z is below its top.
 *
 * The footprint alone is not the keep-out: the column *above* a clamp is
 * blocked too, and a traverse at clearance height is exactly the move that
 * finds that out. So the test is the pair — inside the footprint, and not
 * clear over the top of it.
 */
function movesOverClamps(cl, fixtures) {
  const loops = fixtureLoops((fixtures ?? []).filter((f) => f.kind !== 'chuck'));
  const top = fixtureTop(fixtures);
  if (!loops.length || !top) return { count: 0 };
  let count = 0;
  let line = -1;
  eachMove(cl, (opcode, x, y, z, _a, _b, _c, _f, n) => {
    if (z >= top.z - 1e-6) return;
    if (!pointInLoops(loops, x, y)) return;
    count++;
    if (line < 0) line = n;
  });
  return {
    count, line, name: top.name, top: top.z,
  };
}

/**
 * How far apart two programs' motion is.
 *
 * This is the post's own check: the CL data that went in, against the CL data
 * that comes back out of the text it printed. A post is not allowed to reorder
 * anything — its whole job is to spell the same moves differently — so the two
 * paths should be the same path, walked in the same direction.
 *
 * Comparing point for point does not work, because the counts legitimately
 * differ: the post fits a run of short lines into one G2, and reading that back
 * expands it into chords which are near the originals but not on them. Nor does
 * "how far is each point from the nearest point of the other path", which is the
 * obvious fix and a trap — it is blind to exactly the bugs worth catching. An
 * arc posted the wrong way round traces the *same circle*, so every point of
 * one path lies on the other and the distance is zero; a program with its moves
 * shuffled scores zero too.
 *
 * So both paths are walked from start to end together, each at its own pace,
 * and compared where they are at each step. That is insensitive to how either
 * side chose to divide the path up, and sensitive to order, direction and
 * position — the three things a post can get wrong.
 *
 * By fraction of each path's own length rather than by absolute distance along
 * it, because arc fitting makes the two lengths differ *by design*: a fitted
 * arc is a hair longer than the chords it replaced, a few parts per million of
 * the program. Walked by absolute distance that mismatch accumulates into a
 * drift down the whole path, and an eighty-metre roughing program reports a
 * third of a millimetre of "post bug" that is nothing but the arc fitter doing
 * its job.
 *
 * A fraction absorbs that stretch where it is *uniform*, and it is not: the
 * fitter lengthens the arced stretches of a path and leaves the straight ones
 * alone, so the two walks slip past each other wherever the arcs are bunched.
 * Measured on a plate with fifteen operations on it, a helical bore drifted
 * 2.1mm and read as 0.28mm of "post bug"; the same operation posted without
 * arcs read 0.03mm.
 *
 * So `worst` cannot be read on its own, and `extra`, `length` and `steps` come
 * back with it: they are what says how far these two walks could have slipped
 * without anything being wrong. `checkPost` reads all four together, and the
 * arithmetic for turning them into an allowance is documented there — including
 * why `extra` is only half the story, the other half being that a printed
 * coordinate rounds and the rounding wanders.
 *
 * Leading and trailing rapids are trimmed off both. A post is entitled to add a
 * safe approach at the start and a retract at the end — that is what a post is
 * *for* — and a tail nobody asked for would otherwise shift the whole
 * comparison sideways. What is being checked is the path through the metal.
 *
 * @returns { worst, at, samples, extra, length, steps } — the furthest the two
 *   paths get apart in mm, the length one has that the other does not, how long
 *   the path is (which says whether that difference is plausible), and how many
 *   moves it took to get there (which says how far the walks can have slipped)
 */
export function comparePaths(a, b) {
  const A = arcLengths(trimRapids(collapsePecks(pathPoints(a))));
  const B = arcLengths(trimRapids(collapsePecks(pathPoints(b))));
  // Two paths with no motion in them agree perfectly, and an operation that
  // machines nothing is common enough — a drill that matched no hole, a rest
  // pass with nothing left to take — that calling it an infinite discrepancy
  // would put a post-bug warning on half the programs in the app.
  if (!A && !B) return { worst: 0, at: -1, samples: 0, extra: 0, length: 0, steps: 0 };
  if (!A || !B) {
    return {
      worst: Infinity, at: -1, samples: 0, extra: 0, steps: 0,
      length: A?.total ?? B?.total ?? 0,
    };
  }
  const samples = Math.min(MAX_COMPARE_SAMPLES, Math.max(A.points.length, B.points.length) * 2);
  let worst = 0;
  let at = -1;
  for (let k = 0; k <= samples; k++) {
    const t = k / samples;
    const pa = alongPath(A, t * A.total);
    const pb = alongPath(B, t * B.total);
    const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
    if (d > worst) { worst = d; at = t; }
  }
  return {
    worst,
    at,
    samples,
    extra: Math.abs(A.total - B.total),
    length: A.total,
    steps: Math.max(A.points.length, B.points.length),
  };
}

/** Enough to put a sample on every move of a long program, and no more. */
const MAX_COMPARE_SAMPLES = 20000;

/**
 * Every point of a CL program, drill cycles included as their own tip path.
 *
 * Points carry whether they were rapid, so the trim below can find the linking
 * at each end. An array of points is passed through untouched, so a caller that
 * has already sliced a path up (see `checkPost`) does not have to build a CL to
 * be compared.
 */
function pathPoints(cl) {
  if (Array.isArray(cl)) return cl;
  const out = [];
  eachMove(cl, (opcode, x, y, z, a, _b, _c, feedClass) => {
    // A hole is where the cycle feeds from and how deep it goes, and that is
    // *all* the CL data says about it. Where the tool ends up afterwards is the
    // control's business: G98 returns to whatever height the run started at and
    // G99 to the R plane, and neither of those is a number this program wrote
    // down. Adding the return here would be comparing the file against an
    // assumption rather than against the path — which reported a drilling
    // operation as thirty-nine millimetres of post bug, all of it the retract
    // plane being exactly what it was asked to be.
    if (opcode === OP.DRILL) out.push([x, y, a, true], [x, y, z, false]);
    else out.push([x, y, z, opcode === OP.RAPID || feedClass === FEED.RAPID]);
  });
  return out;
}

/**
 * A hole drilled in bites, reduced to the hole.
 *
 * A control with canned cycles is told a hole in one block — `G83 … Q2` — and
 * the CL data says the same thing in one move, so the two match point for
 * point. A control without them is told the same hole as forty blocks of down,
 * out, down again, and the two paths no longer resemble each other at all: the
 * file is four times longer than the path it came from, and walked side by side
 * they part company by the depth of the hole. On this shaft that read as 30.8mm
 * of "post bug" on a centre drill that was perfectly correct, and it fired on
 * *every* drilling operation posted for GRBL or for the lathe, which are the
 * two posts here that write pecks out long-hand.
 *
 * How a hole is spelled is the post's business, in exactly the way the approach
 * and the retract trimmed below are. What both sides state, and what a post can
 * get wrong, is where the hole is and how deep it goes — so a run of moves that
 * never leaves one XY is reduced to where it started and how far down it got.
 * Applied to both paths, so the canned-cycle case is untouched (it is already
 * those two points) and the long-hand case becomes it.
 *
 * Only a *pecked* run is touched, and pecking is what the shape says it is: the
 * tool goes down, comes back out, and goes down again. A plain plunge only
 * descends and is left alone, and so is the end of a closed profile — which
 * arrives back at the point it started from and then retracts, three moves at
 * one XY that are not a hole and whose retract is real motion. Reducing those
 * as well cost an engraved rectangle its lift-off and read as 22mm of "post
 * bug" on a file that was right.
 */
function collapsePecks(points) {
  const out = [];
  for (let i = 0; i < points.length;) {
    let j = i;
    while (j + 1 < points.length
      && Math.abs(points[j + 1][0] - points[i][0]) < SAME_XY
      && Math.abs(points[j + 1][1] - points[i][1]) < SAME_XY) j++;
    const deepest = pecked(points, i, j);
    if (deepest < 0) {
      for (let k = i; k <= j; k++) out.push(points[k]);
    } else {
      // The hole starts where the feeding starts, not where the run does: the
      // file comes down to the R plane at rapid and the CL data says the R
      // plane and nothing above it. Keeping the whole approach on one side and
      // trimming it on the other made a through hole nine millimetres deeper in
      // the file than in the path — which is the clearance height, not a fault.
      // The rule is trimRapids', applied inside the run.
      let start = i;
      while (start < deepest && points[start + 1][3]) start++;
      out.push(points[start], points[deepest]);
    }
    i = j + 1;
  }
  return out;
}

/**
 * Is this run of same-XY points a hole, and if so where is the bottom?
 *
 * A hole goes down and comes back up. A peck does it several times over, which
 * is the case this was written for — but a plain single-plunge hole is the same
 * shape with one bite, and it has to be recognised too.
 *
 * Requiring the *turn* — down after having risen — meant only a peck counted,
 * and a single-plunge hole came through with its return leg still on it. That
 * looked harmless for years because `trimRapids` runs next and a drill's return
 * is a **rapid**, so it was thrown away at the end of the path by accident
 * rather than by decision.
 *
 * A tap's is not a rapid. A control with no rigid tapping cycle is fed back out
 * of the hole under power with the spindle reversed — that is what the
 * long-hand idiom *is* (see expandTap in post/core.js) — so the return survived
 * the trim on the file's side while the CL side, which states a hole as the R
 * plane and the depth and nothing else, had never had one. `checkPost` then
 * walked a 38mm path against a 19mm one and reported every correctly posted
 * GRBL tapping program as **19mm off the path it planned**.
 *
 * Collapsing to the bottom on both sides is the same decision `pathPoints`
 * already takes for the CL: where the tool ends up after a hole is the
 * control's business, not a path this program wrote down.
 *
 * @returns the index of the deepest point, or -1 when the run is not a hole
 */
function pecked(points, from, to) {
  let deepest = from;
  let rising = false;
  let turned = false;
  for (let k = from + 1; k <= to; k++) {
    const dz = points[k][2] - points[k - 1][2];
    if (dz > 1e-9) rising = true;
    else if (dz < -1e-9) {
      if (rising) turned = true;
      rising = false;
    }
    if (points[k][2] < points[deepest][2]) deepest = k;
  }
  if (deepest <= from) return -1;
  // came back up out of the hole, however many bites it took to get down
  const returned = points[to][2] > points[deepest][2] + 1e-9;
  return turned || returned ? deepest : -1;
}

/**
 * Close enough to be the same hole. Coordinates are printed to three decimals,
 * so two blocks that name one position can differ by half a thousandth.
 */
const SAME_XY = 1e-3;

/** Drop the linking at either end, keeping the path through the metal. */
function trimRapids(points) {
  let first = 0;
  let last = points.length - 1;
  // The rapid that *arrives* is kept: it is the point the first cut starts
  // from, and a path with no start has nothing to compare its first move to.
  while (first < last && points[first + 1]?.[3]) first++;
  while (last > first && points[last][3]) last--;
  return points.slice(first, last + 1);
}

/** A path with its cumulative length, ready to be sampled by fraction. */
function arcLengths(points) {
  if (points.length < 2) return null;
  const at = new Float64Array(points.length);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0, z0] = points[i - 1];
    const [x1, y1, z1] = points[i];
    total += Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    at[i] = total;
  }
  if (!(total > 0)) return null;
  return { points, at, total };
}

/** The point a given distance along a path. */
function alongPath(path, target) {
  const { at, points } = path;
  let lo = 0;
  let hi = at.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at[mid] < target) lo = mid + 1; else hi = mid;
  }
  if (lo === 0) return points[0];
  const span = at[lo] - at[lo - 1];
  const f = span > 1e-12 ? (target - at[lo - 1]) / span : 0;
  const a = points[lo - 1];
  const b = points[lo];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * Does the file say what the program said? Asked of a whole posted program.
 *
 * Operation by operation, because a post puts motion of its own *between*
 * them — a retract, a tool change, an approach — and a single walk down the
 * whole file would be knocked out of step by the first one and stay out of step
 * for the rest of the program. Which lines belong to which operation is
 * something the post already knows and already writes down: the line map it
 * returns for the G-code panel is exactly that, read the other way round.
 *
 * Each operation is judged against the tolerance *it was posted at*, which is
 * not one number: the arc fitter is allowed to stray by the post's own arc
 * tolerance, and never works tighter than the path was written at, so an
 * adaptive pass planned at a tenth of a millimetre is legitimately a tenth of a
 * millimetre off its polyline and a finishing pass is not. A check with one
 * fixed threshold either cries wolf on roughing or sleeps through a real fault
 * on finishing — `over` is the number that means something.
 *
 * Three approximations stand between the two paths and each is allowed its
 * tolerance: the strategy's own chords, the fitter's arcs, and the chords this
 * reader expands those arcs back into. They do not cancel. On a helix they
 * compound in a way worth naming — chords are *shorter* than the arc they
 * stand for, so a refitted spiral comes back a third of a millimetre longer
 * over fifteen turns, and a comparison walked in step drifts by that much.
 *
 * Hence the floor. A tenth of a millimetre is far above any of that and far
 * below every fault this check exists to find: a flipped arc is out by a
 * diameter, a lost modal word by the width of the part, a units slip by a
 * factor of twenty-five.
 *
 * And hence the drift term, which the floor on its own was not: the comparison
 * walks both paths by fraction of their own length, so a path the fitter has
 * made `extra` millimetres longer puts its samples up to `extra` out of step —
 * that is the metric's own noise, not a discrepancy in the file. A plate with
 * fifteen ordinary operations on it had four of them over the floor on that
 * alone, every one of which told the person holding the file "do not run this".
 *
 * There is a second slip and it is not the fitter's: a coordinate printed to
 * three decimals moves by up to half a thousandth, so every segment in the file
 * is a shade longer or shorter than the one it came from, at random. Those
 * cancel — the *ends* of the two paths agree to a twentieth of a millimetre
 * over a hundred and thirty metres — but they cancel by wandering, and the walk
 * is furthest from zero somewhere in the middle. Measured on a slope: a 21,000
 * move roughing pass ended 0.054mm apart and got 0.158mm apart on the way,
 * which is the 0.144mm this check was calling a post bug. It grows with the
 * square root of the moves, as a random walk does, so that is how it is
 * allowed for — `extra` is the end of the walk and cannot see its excursion.
 *
 * The drift is forgiven, but only as much of it as refitting can account for.
 * Refitting is a parts-per-million business — the worst legitimate case
 * measured here was 4e-4 of the path, on a helix — while a post that has
 * actually gone wrong changes the length by a *percent* or more: every one of
 * the seven faults injected to check this (G2 swapped for G3, and the sign of
 * I inverted) came back between 1.5e-2 and 8e-1. A cap at a thousandth of the
 * path sits two orders of magnitude clear of both, and forgiving `extra` only
 * up to it means a fault that does not lengthen the path is forgiven nothing.
 *
 * @param ops [{ name, cl }] as they were posted
 * @param text the posted program
 * @param lineMap from buildGcode: line index → { op, move }
 * @param fitTolerance the post's arc tolerance, as it was posted
 * @returns { worst, over, op, ops } — `over` is how far past what the fitting
 *   allows the worst operation is; at or below zero there is nothing to say
 */
export function checkPost({
  ops, text, lineMap, arcTolerance = 0.005, fitTolerance = 0.01,
}) {
  if (!ops?.length || !lineMap?.size) return null;
  const parsed = parseGcode(text, { arcTolerance });
  // The mapped lines in order, so a parsed block can be attributed to the
  // operation whose stretch of the file it falls in.
  const marks = [...lineMap.entries()]
    .map(([line, ref]) => [line, ref.op])
    .sort((a, b) => a[0] - b[0]);
  const buckets = ops.map(() => []);
  for (const m of parsed.motion) {
    const op = opAtLine(marks, m.line);
    if (op < 0 || op >= buckets.length) continue;
    // the R plane and the bottom, matching what a CL cycle states — see pathPoints
    if (m.kind === 'cycle') buckets[op].push([m.x, m.y, m.r, true], [m.x, m.y, m.z, false]);
    else buckets[op].push([m.x, m.y, m.z, !!m.rapid]);
  }

  const each = ops.map((op, i) => {
    // A wrapped operation is posted in a different space from the one it was
    // planned in: the file's Y is an angle and its feed is a duration. Walking
    // the two paths side by side would be comparing millimetres with degrees,
    // so it is not attempted — the wrap is checked where it is applied, in
    // engine/wrap.js, not by pretending the file is flat.
    if (op.wrap?.diameter > 0) {
      return { name: op.name, allowed: Infinity, over: -Infinity, worst: 0, wrapped: true };
    }
    const result = comparePaths(op.cl, buckets[i]);
    const allowed = Math.max(ARC_REFIT_FLOOR,
      3 * Math.max(fitTolerance, op.cl?.resolution ?? 0) + ROUNDING)
      + Math.min(result.extra, result.length * PLAUSIBLE_DRIFT)
      + PRINTED_STEP * Math.sqrt(result.steps);
    return { name: op.name, allowed, over: result.worst - allowed, ...result };
  });
  let over = -Infinity;
  let at = -1;
  each.forEach((r, i) => {
    if (r.over > over) { over = r.over; at = i; }
  });
  return {
    worst: at >= 0 ? each[at].worst : 0, over, op: at, ops: each,
  };
}

/** What printing a coordinate to three decimals can cost, twice over. */
const ROUNDING = 0.005;

/** And what refitting a path into arcs and back costs, whatever the tolerance. */
const ARC_REFIT_FLOOR = 0.1;

/**
 * How much longer refitting a path is allowed to have made it — a thousandth,
 * where the measured worst case is four ten-thousandths and the smallest
 * injected fault is fifteen thousandths. See `checkPost`.
 */
const PLAUSIBLE_DRIFT = 1e-3;

/**
 * And how much a single move's length can change in being printed: two ends,
 * each rounded to three decimals. Multiplied by the square root of the moves,
 * this is how far the two walks can have slipped apart in the middle.
 */
const PRINTED_STEP = 0.001;

/**
 * A rapid that took metal, as the simulation counted them.
 *
 * The one check in this file that needs the billet rather than the program, and
 * the most serious of them: a G0 is not a cut, so the machine takes it at full
 * traverse and the tool arrives at the metal at three metres a minute. Reported
 * from `sim.rapidCut` rather than worked out again here — the simulation had
 * the in-process stock in front of it and this file does not.
 *
 * @returns a finding, or null when nothing was hit
 */
export function rapidCutFinding(sim, ops = []) {
  const hit = sim?.rapidCut;
  if (!hit?.count) return null;
  const op = sim.opEnds ? sim.opEnds.findIndex((end) => end > hit.step) : -1;
  const where = ops[op]?.name;
  return {
    level: 'warn',
    line: -1,
    step: hit.step,
    text: `${plural(hit.count, 'rapid')} ${hit.count === 1 ? 'cuts' : 'cut'} metal`
      + `${where ? `, in ${where}` : ''} — the deepest takes ${hit.depth.toFixed(2)}mm `
      + 'at traverse speed. A G0 is not a cut; the machine will not slow down for it.',
  };
}

/** Which operation a line of the file belongs to. */
function opAtLine(marks, line) {
  let lo = 0;
  let hi = marks.length - 1;
  if (!marks.length || line < marks[0][0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (marks[mid][0] <= line) lo = mid; else hi = mid - 1;
  }
  return marks[lo][1];
}

export { MOVE_STRIDE };
