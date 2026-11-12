// Feed from engagement: slow down where the cutter is buried, speed up where it
// is barely touching.
//
// A toolpath carries one cutting feed, chosen for the cut the strategy meant to
// make — a pocket's stepover, an adaptive pass's stated bite. The cut it
// *actually* makes is not that cut everywhere: a corner is a heavy bite, the
// entry to a slot is a full-width one, a finishing run along a rim is a light
// one. One feed for all of them is slow where it could go faster and too fast
// where the cutter is loaded. The simulation already measures how wide and how
// deep every move cut (`moveLoad` in engine/simulate.js); this turns that into a
// feed per stretch of the path.
//
// It changes the feed and nothing else. Not one coordinate moves, so the metal
// removed is identical — a test holds it to that — and the only thing a post
// has to do differently is write an F word where the feed changes.
//
// The rules, each one earned:
//   * the chip stays as thick as the table intends where the cut is light
//     (chip thinning), and the removal rate stays where it was meant to be where
//     it is heavy — whichever is slower wins
//   * the spindle's power is a ceiling, and so is the machine's fastest feed
//   * it slows *before* a heavy bite, not as it arrives: a window ahead of the
//     tool is looked at, because a control cannot change the feed in zero
//     distance
//   * the feed moves in steps and holds each step for a cutter's width, so a
//     G2/G3 arc is not shattered into a feed change every few millimetres
//     (post/arcs.js breaks an arc at every event)
//   * entries, rapids, holes, taps and anything that turns the work are left as
//     they are — see `refusal`

import { MOVE_STRIDE, OP, FEED } from './cl.js';
import { effectiveCutting } from './cutting.js';
import { isLatheTool } from './insert.js';
import { chipThinningFactor, cuttingPowerKw, materialOf } from '../doc/materials.js';

export const FEED_OPT = Object.freeze({
  minScale: 0.4,     // never below 40% of the programmed feed
  maxScale: 1.6,     // never above 160%
  step: 0.1,         // feed moves in tenths of the programmed one
  lookAhead: 1.0,    // diameters ahead of the tool that are looked at
  lookBehind: 0.25,  // …and behind it
  hold: 1.0,         // a level is held at least this many diameters
});

/** Families whose feed is not a free choice: a screw, a drill, a thread. */
const FIXED_FEED = new Set(['tap', 'drill', 'spot', 'threadmill']);

/**
 * Why this toolpath is not one to change the feed of, or null when it is.
 */
export function refusal(cl, tool, moveLoad) {
  if (!cl || !(cl.count > 0)) return 'it has no moves';
  if (!tool) return 'it has no tool';
  if (isLatheTool(tool.type)) return 'a lathe feeds per revolution at a speed that follows the diameter';
  if (FIXED_FEED.has(tool.type)) return `a ${tool.type} cannot be fed at anything but its own rate`;
  if (cl.fiveAxis) return 'a simultaneous 5-axis program is written in inverse time';
  if (!moveLoad?.width || moveLoad.width.length < cl.count) return 'the simulation has not measured it';
  const d = cl.moves;
  for (let n = 0; n < cl.count; n++) if (d[n * MOVE_STRIDE] === OP.DRILL) return 'it contains hole cycles';
  const feeds = cl.events.filter((e) => e.type === 'feeds');
  const first = feeds[0];
  if (feeds.some((e) => e.cut !== first.cut || e.plunge !== first.plunge)) {
    return 'it already changes its own feed part-way through';
  }
  if (cl.events.some((e) => e.type === 'thread' || e.type === 'tapping')) return 'it is feed-synchronised';
  return null;
}

/**
 * @param cl the operation's toolpath
 * @param moveLoad { width, depth, kind } per CL move, from simulateRemoval
 * @param options.op the operation, for its own feed override and stated widths
 * @param options.tool its cutter
 * @param options.material the setup's material id
 * @param options.machine the machine record: `maxFeed`, `spindlePower`
 * @param options.nominalWidth the radial width the programmed feed is meant for,
 *   mm — omitted, the median width this very path takes
 * @param options.nominalDepth likewise for the depth — omitted, a high
 *   percentile of the depths the path takes
 * @returns { cl, changed, refused, stats } — a *new* toolpath when anything
 *   changed (the old one is not touched), the same one when nothing did
 */
export function optimiseFeeds(cl, moveLoad, {
  op = null, tool, material, machine = null, nominalWidth = null, nominalDepth = null,
  settings = {},
} = {}) {
  const cfg = { ...FEED_OPT, ...settings };
  const why = refusal(cl, tool, moveLoad);
  if (why) return { cl, changed: false, refused: why, stats: null };

  const base = effectiveCutting(op ?? {}, tool);
  const feeds0 = cl.events.find((e) => e.type === 'feeds');
  const F0 = feeds0?.cut > 0 ? feeds0.cut : base.feedCut;
  const plunge = feeds0?.plunge ?? base.feedPlunge;
  if (!(F0 > 0)) return { cl, changed: false, refused: 'it has no cutting feed', stats: null };
  const D = tool.diameter > 0 ? tool.diameter : 0;
  if (!(D > 0)) return { cl, changed: false, refused: 'the cutter has no diameter', stats: null };

  const d = cl.moves;
  const n = cl.count;
  const { width, depth, kind } = moveLoad;

  // length of each move, and the distance along the path at its end
  const at = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const o = i * MOVE_STRIDE;
    const p = i > 0 ? (i - 1) * MOVE_STRIDE : null;
    const len = p == null || d[o] === OP.DRILL ? 0
      : Math.hypot(d[o + 1] - d[p + 1], d[o + 2] - d[p + 2], d[o + 3] - d[p + 3]);
    at[i + 1] = at[i] + len;
  }

  // what the programmed feed is meant for
  const cutting = [];
  for (let i = 0; i < n; i++) if (kind[i] === 0 && width[i] > 1e-6) cutting.push(i);
  if (cutting.length === 0) return { cl, changed: false, refused: 'it takes no cut', stats: null };
  const percentile = (values, q) => {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };
  const ae0 = nominalWidth > 0 ? nominalWidth : percentile(cutting.map((i) => width[i]), 0.5);
  const ap0 = nominalDepth > 0 ? nominalDepth : percentile(cutting.map((i) => depth[i]).filter((v) => v > 0), 0.9) || 1;
  const mat = materialOf(material);
  const thin0 = chipThinningFactor(ae0 / D);

  // the scale each move wants, on its own
  const want = new Float64Array(n).fill(1);
  // …and the most each may have: the machine's fastest feed, and the spindle's
  // power. A ceiling is never rounded across, whatever the steps are.
  const cap = new Float64Array(n).fill(cfg.maxScale);
  for (let i = 0; i < n; i++) {
    if (kind[i] !== 0 || !(width[i] > 1e-6)) continue;
    const ae = Math.min(width[i], D);
    const ap = Math.max(depth[i], 1e-3);
    // the chip: keep it as thick as the table means it to be at this width
    const chip = chipThinningFactor(ae / D) / thin0;
    // the removal rate: not more than the cut the feed was chosen for
    const rate = (ae0 * ap0) / (ae * ap);
    let s = Math.min(chip, rate);
    let ceiling = cfg.maxScale;
    // power: the most the spindle can take at this width and depth
    if (machine?.spindlePower > 0) {
      const kwAtF0 = cuttingPowerKw({ ae, ap, feed: F0, material: mat.id });
      if (kwAtF0 > 0) ceiling = Math.min(ceiling, machine.spindlePower / kwAtF0);
    }
    if (machine?.maxFeed > 0) ceiling = Math.min(ceiling, machine.maxFeed / F0);
    s = Math.min(s, ceiling);
    // the floor of the scale wins over a ceiling it cannot meet: below 40% a
    // feed is rubbing, and a cut that heavy wants a shallower pass, not a crawl
    want[i] = Math.max(cfg.minScale, s);
    cap[i] = Math.max(cfg.minScale, ceiling);
  }

  // Slow down before the heavy part, not on it: each move takes the lowest scale
  // found in a window from a little behind it to a cutter's width ahead.
  const behind = cfg.lookBehind * D;
  const ahead = cfg.lookAhead * D;
  const windowed = new Float64Array(n);
  {
    // monotonic deque over the moves whose position lies in the window
    const deque = [];
    let hi = 0;
    for (let i = 0; i < n; i++) {
      const pos = at[i + 1];
      while (hi < n && at[hi + 1] <= pos + ahead) {
        while (deque.length && want[deque[deque.length - 1]] >= want[hi]) deque.pop();
        deque.push(hi);
        hi++;
      }
      while (deque.length && at[deque[0] + 1] < pos - behind) deque.shift();
      windowed[i] = deque.length ? want[deque[0]] : want[i];
    }
  }
  // never faster than programmed on an entry, a lead or a rapid's neighbour
  for (let i = 0; i < n; i++) if (kind[i] !== 0) windowed[i] = Math.min(1, windowed[i]);
  // a ceiling follows the move it belongs to, not its window: the window looks
  // ahead for something to slow down for, and it must not be what lets a move
  // exceed its own limit
  const capLevel = new Int16Array(n);
  for (let i = 0; i < n; i++) capLevel[i] = Math.floor(cap[i] * (1 / cfg.step) + 1e-9);

  // quantise, then hold each level for a cutter's width: a shorter run is
  // folded into the slower neighbour
  const level = new Int16Array(n);
  const inv = 1 / cfg.step;
  for (let i = 0; i < n; i++) level[i] = Math.round(windowed[i] * inv);
  const held = Array.from(level);
  const minRun = cfg.hold * D;
  for (let pass = 0; pass < 3; pass++) {
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && held[j + 1] === held[i]) j++;
      const length = at[j + 1] - at[i];
      // A short run is folded into its slower neighbour — except a short *dip*,
      // which is a heavy bite and stays: the slow side wins, always. (The
      // look-ahead already makes a dip at least a cutter's width, so this only
      // fires for the runs the quantising itself cut short.)
      if (length < minRun && i > 0 && j < n - 1 && held[i] >= Math.min(held[i - 1], held[j + 1])) {
        const target = Math.min(held[i - 1], held[j + 1]);
        for (let k = i; k <= j; k++) held[k] = target;
      }
      i = j + 1;
    }
  }

  for (let k = 0; k < n; k++) held[k] = Math.min(held[k], capLevel[k]);

  // the events: a feed word where the level changes, on cutting moves only —
  // a rapid takes whatever is in force
  const out = cl.events.filter((e) => e.type !== 'feeds');
  const runs = [];
  // the programmed feed is in force until the first change, so a stretch that
  // wants it is not restated
  let current = F0;
  for (let i = 0; i < n; i++) {
    if (d[i * MOVE_STRIDE] === OP.RAPID || d[i * MOVE_STRIDE + 7] === FEED.RAPID) continue;
    const cut = Math.max(1, Math.round(F0 * held[i] / inv));
    if (cut !== current) {
      runs.push({ index: i, cut });
      current = cut;
    }
  }
  const firstIndex = feeds0?.index ?? 0;
  const events = [...out, { type: 'feeds', index: firstIndex, cut: F0, plunge }];
  for (const r of runs) events.push({ type: 'feeds', index: r.index, cut: r.cut, plunge });
  events.sort((a, b) => a.index - b.index);

  const cuts = [F0, ...runs.map((r) => r.cut)];
  const stats = {
    programmed: F0,
    levels: new Set(cuts).size,
    changes: runs.length,
    slowest: Math.min(...cuts),
    fastest: Math.max(...cuts),
    nominalWidth: ae0,
    nominalDepth: ap0,
  };
  if (runs.length === 0) return { cl, changed: false, refused: null, stats };
  return {
    cl: { ...cl, events, feedOptimised: { programmed: F0, ...stats } },
    changed: true,
    refused: null,
    stats,
  };
}
