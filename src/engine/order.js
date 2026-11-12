// The running order of a setup's operations: fewer tool changes, less travel.
//
// Operations run in the order they were added, which is the order the user
// thought of them in, not the order that is cheapest to run. A face with the
// 12mm cutter, a pocket with the 6mm, a second pocket with the 12mm: three tool
// changes where two would do — and on a machine whose changer is a person with
// a spanner, forty-five seconds each.
//
// What stops it being a sort by tool number is that order is sometimes the
// meaning of the program. Rest machining reads what the passes above it left; a
// finish pass is judged against the rough that preceded it; a tap needs the
// drill's hole under it; the cut-out that frees the part goes last or the part
// is loose for everything after it. So every pair of operations is first asked
// whether it may change places at all, and the answer is no whenever there is a
// reason, and "same metal" is a reason: two operations whose cutters pass over
// the same ground do not commute, because the second is cutting what the first
// left. Only operations working in different places, with nothing between them,
// are free to swap — which is conservative, and is meant to be.
//
// It then chooses among what is free: stay on the cutter that is fitted, and
// among those take the nearest start. The result is used only if it is better,
// by the clock, than the order it was given: this never makes a program slower.

import { MOVE_STRIDE, OP, FEED } from './cl.js';
import { READS_EARLIER } from './toolpath.js';

/** Hole operations, in the order a hole is made: spot, drill, then the screw or the finish. */
const HOLE_RANK = { spot: 0, drill: 1, tap: 2, threadMill: 2, bore: 2 };
/** Faces, which every roughing pass reads whether or not it says so. */
const FACING = new Set(['face']);
/** Operations that take the part's last connection to the billet. */
const CUT_OUT = new Set(['contour2d']);

/**
 * @typedef {object} OrderOp
 * @property id
 * @property type
 * @property enabled
 * @property toolNumber the tool it is cut with, or null (a command has none)
 * @property params
 * @property cl its generated toolpath, or null
 * @property radius the cutter's radius, mm
 */

/** The cells an operation cuts in, on a grid shared by every operation. */
function footprintOf(op, grid) {
  const cl = op.cl;
  if (!cl || cl.count === 0) return null;
  const { x0, y0, cell, width, height } = grid;
  const marks = new Uint8Array(width * height);
  const reach = Math.max(1, Math.ceil(op.radius / cell));
  const stamp = (x, y) => {
    const ci = Math.round((x - x0) / cell);
    const cj = Math.round((y - y0) / cell);
    for (let dj = -reach; dj <= reach; dj++) {
      const j = cj + dj;
      if (j < 0 || j >= height) continue;
      for (let di = -reach; di <= reach; di++) {
        const i = ci + di;
        if (i < 0 || i >= width) continue;
        if (di * di + dj * dj <= reach * reach + reach) marks[j * width + i] = 1;
      }
    }
  };
  const d = cl.moves;
  let prev = null;
  for (let n = 0; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    if (d[o] === OP.DRILL) { stamp(d[o + 1], d[o + 2]); prev = null; continue; }
    const x = d[o + 1];
    const y = d[o + 2];
    const rapid = d[o] === OP.RAPID || d[o + 7] === FEED.RAPID;
    if (!rapid) {
      if (prev) {
        const len = Math.hypot(x - prev[0], y - prev[1]);
        const steps = Math.max(1, Math.ceil(len / cell));
        for (let s = 1; s <= steps; s++) {
          stamp(prev[0] + ((x - prev[0]) * s) / steps, prev[1] + ((y - prev[1]) * s) / steps);
        }
      } else stamp(x, y);
    }
    prev = [x, y];
  }
  return marks;
}

function overlap(a, b) {
  if (!a || !b) return true;       // not generated: unknown, so assume the worst
  for (let i = 0; i < a.length; i++) if (a[i] && b[i]) return true;
  return false;
}

/** Where the first and the last cutting move are, for the travel between operations. */
function endsOf(cl) {
  if (!cl || cl.count === 0) return null;
  const d = cl.moves;
  let first = null;
  let last = null;
  for (let n = 0; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    const p = [d[o + 1], d[o + 2], d[o + (d[o] === OP.DRILL ? 4 : 3)]];
    if (!first) first = p;
    last = p;
  }
  return { first, last };
}

const travelBetween = (a, b, rapid) => {
  if (!a?.last || !b?.first) return 0;
  const xy = Math.hypot(b.first[0] - a.last[0], b.first[1] - a.last[1]);
  const z = Math.abs(b.first[2] - a.last[2]);
  return xy / rapid.xy + z / rapid.z;
};

/** The score the clock gives an order: tool changes plus the rapids between operations, seconds. */
function scoreOf(order, ends, changeSeconds, rapid, inSpindle) {
  let changes = 0;
  let fitted = inSpindle;
  let travel = 0;
  let prev = null;
  for (const op of order) {
    if (op.toolNumber != null && op.toolNumber !== fitted) { changes++; fitted = op.toolNumber; }
    const e = ends.get(op.id);
    if (prev) travel += travelBetween(prev, e, rapid) * 60;
    if (e) prev = e;
  }
  return { changes, travelSeconds: travel, seconds: changes * changeSeconds + travel };
}

/**
 * Why `a` (earlier) and `b` (later) may not change places, or null when they may.
 */
export function mustStayOrdered(a, b, { stockBottom = null, footprints }) {
  // Operations that read what came before are tied to everything around them: a
  // rest-machining pass deducts the passes above it, so a pass moved above it, or
  // below it, changes what it cuts.
  const reads = (op) => READS_EARLIER.has(op.type) || !!op.params?.restMachining;
  if (reads(a) || reads(b)) return 'one of them works from what the other leaves';
  // Facing is the first thing done to the billet; roughing is judged against it.
  if (FACING.has(a.type) || FACING.has(b.type)) return 'facing first';
  // Spot, drill, then the tap or bore that follows.
  if (a.type in HOLE_RANK && b.type in HOLE_RANK && HOLE_RANK[a.type] !== HOLE_RANK[b.type]) {
    return 'a hole is spotted, then drilled, then tapped or bored';
  }
  // The cut that frees the part, last.
  const through = (op) => CUT_OUT.has(op.type) && stockBottom != null
    && op.params?.bottomZ != null && op.params.bottomZ <= stockBottom + 0.01;
  if (through(a) || through(b)) return 'the cut that frees the part goes last';
  // Same metal.
  if (overlap(footprints.get(a.id), footprints.get(b.id))) return 'they cut the same ground';
  return null;
}

/**
 * Plan a better running order for one setup.
 *
 * @param ops OrderOp[] in their current order, the whole setup
 * @param options.stock the setup's stock `{ min, max }`, for the grid and the cut-out test
 * @param options.rapid { xy, z } mm/min
 * @param options.changeSeconds the machine's tool change time
 * @param options.inSpindle the tool number already fitted when the setup starts
 * @returns { order: ids, changed, before, after, held }
 */
export function planOrder(ops, {
  stock, rapid = { xy: 3000, z: 3000 }, changeSeconds = 10, inSpindle = null,
} = {}) {
  const ids = ops.map((o) => o.id);
  const nothing = { order: ids, changed: false, before: null, after: null, held: 0 };
  if (ops.length < 3 || !stock?.min || !stock?.max) return nothing;

  // One grid for everyone: the stock, with a margin for the cutter hanging over
  // the edge, in cells of about half the smallest cutter.
  const radii = ops.filter((o) => o.radius > 0).map((o) => o.radius);
  const cell = Math.max(0.5, Math.min(...(radii.length ? radii : [2])) / 2);
  const margin = Math.max(0, ...radii) + cell;
  const grid = {
    x0: stock.min[0] - margin,
    y0: stock.min[1] - margin,
    cell,
    width: Math.ceil((stock.max[0] - stock.min[0] + 2 * margin) / cell) + 1,
    height: Math.ceil((stock.max[1] - stock.min[1] + 2 * margin) / cell) + 1,
  };
  if (grid.width * grid.height > 4_000_000) return { ...nothing, reason: 'the stock is too large to compare operations on' };

  const footprints = new Map();
  const ends = new Map();
  for (const op of ops) {
    footprints.set(op.id, footprintOf(op, grid));
    ends.set(op.id, endsOf(op.cl));
  }

  // The sequence is cut into runs by the operations that must not move at all —
  // a command is the operator's own instruction about *when* — and a disabled
  // operation is not in the program, so it neither moves nor holds anything.
  const result = [];
  let run = [];
  let held = 0;
  const flush = () => {
    if (run.length > 1) {
      const planned = planRun(run, { stock, grid, footprints, ends, rapid, changeSeconds, inSpindle: null });
      held += planned.held;
      result.push(...planned.order);
    } else result.push(...run);
    run = [];
  };
  for (const op of ops) {
    if (!op.enabled) continue;
    if (op.type === 'command' || op.toolNumber == null) {
      flush();
      result.push(op);
    } else run.push(op);
  }
  flush();
  // A disabled operation goes back exactly where it was.
  const live = result.slice();
  result.length = 0;
  ops.forEach((op) => result.push(op.enabled ? live.shift() : op));

  const enabled = (list) => list.filter((o) => o.enabled && o.type !== 'command');
  const before = scoreOf(enabled(ops), ends, changeSeconds, rapid, inSpindle);
  const after = scoreOf(enabled(result), ends, changeSeconds, rapid, inSpindle);
  // Better, or leave it: a reorder that saves a tenth of a second is noise.
  if (!(after.seconds < before.seconds - 1)) {
    return { order: ids, changed: false, before, after: before, held };
  }
  const order = result.map((o) => o.id);
  return { order, changed: order.some((id, i) => id !== ids[i]), before, after, held };
}

/** One run of free operations: a list scheduler that stays on the fitted tool. */
function planRun(run, ctx) {
  const stock = ctx.stock;
  const stockBottom = stock?.min?.[2] ?? null;
  const m = run.length;
  const before = Array.from({ length: m }, () => []);    // predecessors of each
  let held = 0;
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      if (mustStayOrdered(run[i], run[j], { stockBottom, footprints: ctx.footprints })) {
        before[j].push(i);
        held++;
      }
    }
  }
  const done = new Array(m).fill(false);
  const order = [];
  let fitted = null;
  let at = null;
  for (let step = 0; step < m; step++) {
    const ready = [];
    for (let k = 0; k < m; k++) {
      if (!done[k] && before[k].every((p) => done[p])) ready.push(k);
    }
    // the fitted cutter first; failing that, the lowest original position, which
    // disturbs the user's order least
    const same = ready.filter((k) => run[k].toolNumber === fitted);
    const pool = same.length ? same : ready;
    let pick = pool[0];
    if (same.length > 1 && at) {
      // among the same cutter's operations, the nearest start
      let best = Infinity;
      for (const k of pool) {
        const e = ctx.ends.get(run[k].id);
        const dist = e?.first ? Math.hypot(e.first[0] - at[0], e.first[1] - at[1]) : Infinity;
        // ties go to the earlier one, so nothing moves for no reason
        if (dist < best - 1e-6) { best = dist; pick = k; }
      }
    }
    done[pick] = true;
    order.push(run[pick]);
    fitted = run[pick].toolNumber;
    const e = ctx.ends.get(run[pick].id);
    if (e?.last) at = e.last;
  }
  return { order, held };
}
