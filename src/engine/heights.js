// Where the tool is safe, and where it stops rapiding and starts cutting.
//
// An operation carries two heights above the work:
//
//   clearanceHeight — the plane long moves cross the part at. Everything above
//     the tallest thing in the way, so a rapid from one side of the part to the
//     other is always safe.
//   entryGap        — how far above the surface a pass enters through the tool
//     stops rapiding and starts feeding.
//
// The gap is what makes entries quick. Clearance sits well above the stock
// (10mm over the top by default) and every entry used to feed the whole way
// down from it at plunge rate — on a clearing pass with several hundred entries
// that is minutes of the tool descending through air at 300mm/min. Dropping to
// just above the material at rapid and feeding the rest costs nothing in safety
// and gives all of it back.
//
// The surface a pass enters through is the depth level above it, not the top of
// the job: a pass only removes what the level above left, so it only has to
// feed one stepdown. Entering from a fixed plane instead turned the last pass
// of a 30mm profile into a single 32mm plunge — the stepdown honoured by the
// cutting levels and thrown away by the entry.

import { FEED, lastXY } from './cl.js';
import { hasFixtures } from './fixtures.js';

/** Highest to lowest. Every rule below is a consequence of this order. */
export const HEIGHT_ORDER = ['clearanceHeight', 'topZ', 'bottomZ'];

const EPS = 0.001;   // mm; heights are held to 3 decimals everywhere else

export const HEIGHT_LABELS = {
  clearanceHeight: 'Clearance Z',
  topZ: 'Top Z',
  bottomZ: 'Bottom Z',
};

/**
 * Keep the heights in a machinable order when one of them is edited.
 *
 * Clearance is above the top of the cut, which is above the bottom. Nothing downstream checks this, so an operation
 * with Bottom Z above Top Z was accepted, generated, and produced either an
 * empty program or one full of passes in an order nobody asked for — a setting
 * you can reach by typing in a box or dragging a handle, that silently breaks
 * the operation and reports nothing.
 *
 * Where a height *can* be honoured by moving its neighbours in the safe
 * direction — clearance rising to stay above a raised top — it is, and the edit stands. Where it cannot, the edit is refused outright
 * rather than clamped to the nearest legal value.
 *
 * Refusing is the important half. Clamping a Bottom Z typed as `5` when the top
 * is `0` gives a cut one micron deep: an operation that is technically in
 * order, generates a program, and machines nothing — which is exactly the
 * failure this is here to prevent, arrived at by a different road. Keeping the
 * last good value and saying why leaves the operation working.
 *
 * @param params the operation's params (not mutated)
 * @param key which height was edited
 * @param value what it was set to
 * @returns { patch, adjusted, rejected } — the params to write, the names of
 *   any other heights that had to move, and whether the edit was refused
 */
export function constrainHeights(params, key, value) {
  const next = {
    clearanceHeight: params.clearanceHeight,
    topZ: params.topZ,
    bottomZ: params.bottomZ,
  };
  const adjusted = [];
  const move = (k, v) => {
    if (next[k] == null || Math.abs(next[k] - v) < 1e-9) return;
    next[k] = round(v);
    if (!adjusted.includes(k)) adjusted.push(k);
  };
  const refuse = () => ({ patch: next, adjusted: [], rejected: true });

  if (key === 'bottomZ') {
    if (!(value < next.topZ - EPS)) return refuse();
    next.bottomZ = value;
  } else if (key === 'topZ') {
    if (!(value > next.bottomZ + EPS)) return refuse();
    next.topZ = value;
    // clearance gets out of the way; raising it is always safe
    if (next.clearanceHeight <= value) move('clearanceHeight', value + EPS);
  } else if (key === 'clearanceHeight') {
    if (!(value > next.topZ)) return refuse();
    next.clearanceHeight = value;
  }

  next[key] = round(next[key]);
  return { patch: next, adjusted, rejected: false };
}

/** Why a height cannot go where it was put — the text the UI shows. */
export function heightRefusal(key) {
  return {
    bottomZ: 'Bottom Z must stay below Top Z',
    topZ: 'Top Z must stay above Bottom Z',
    clearanceHeight: 'clearance must stay above Top Z',
  }[key] ?? 'that would put the heights out of order';
}

/** Where a height may be dragged to, given the others — for the gizmo. */
export function heightLimits(params, key) {
  if (key === 'bottomZ') return { min: -Infinity, max: params.topZ - EPS };
  if (key === 'topZ') return { min: params.bottomZ + EPS, max: Infinity };
  if (key === 'clearanceHeight') return { min: params.topZ + EPS, max: Infinity };
  return { min: -Infinity, max: Infinity };
}

function round(v) {
  return typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
}

export const DEFAULT_ENTRY_GAP = 1;

/**
 * How far above the uncut surface the tool stops rapiding.
 *
 * This used to be an absolute "feed plane Z" the user typed in, which was the
 * wrong shape for the job twice over. It was redundant, because the surface a
 * pass enters through is already known — it is the level above. And it was
 * unsafe at its own best setting, because the one thing you must not do is
 * rapid *onto* the material: the top of a real billet is never exactly where
 * the model says it is, and arriving there at rapid feed is how a cutter gets
 * broken on stock that was 0.3mm proud.
 *
 * A gap is the right shape: it means the same thing at every depth of every
 * operation, and it needs setting once if ever.
 */
export function entryGapOf(params) {
  const gap = params.entryGap;
  return Number.isFinite(gap) && gap >= 0 ? gap : DEFAULT_ENTRY_GAP;
}

/**
 * How far down the tool may rapid before it has to start feeding, for one pass
 * of a multi-level cut.
 *
 * A depth pass only removes the material between the level above it and its
 * own. Everything higher at that XY was taken by earlier passes, so the tool
 * can rapid down to `zEntry` and feed only the last stepdown — which is what
 * the stepdown *means*. Dropping to the operation's feed plane instead makes
 * every entry a full-depth plunge: correct in the sense that the tool is in a
 * slot it cut itself, and wrong in every sense a machinist cares about, because
 * a lead-in starts off the path in material nothing has touched.
 *
 * The first pass has `zEntry` at the top of the stock, so it enters a gap above
 * that and nothing is lost.
 */
export function entryPlane(params, zEntry, z) {
  const surface = Number.isFinite(zEntry) ? Math.max(zEntry, z) : params.topZ;
  if (!Number.isFinite(surface)) return null;
  const plane = surface + entryGapOf(params);
  // never higher than clearance (that is where the tool already is) and never
  // below the cut it is entering
  if (plane >= params.clearanceHeight - 1e-9) return null;
  return plane <= z ? null : plane;
}

/**
 * The height a pass may travel to the next one at, instead of going home.
 *
 * Clearance is where the tool goes when nothing is known about what is between
 * here and there. Between two passes of the same operation something *is*
 * known: the part is inside the stock, so a gap above the stock clears every
 * part of the job by construction — no region test, no ordering assumption, and
 * true at any depth.
 *
 * The exception is the one thing that is not part of the job. A clamp stands
 * proud of the stock and is a keep-out for the whole column above its footprint
 * (see engine/fixtures.js), and none of the strategies is given enough to route
 * around one, so with fixtures in the setup this returns null and the passes go
 * home. That is what clearance is for; giving it up is not the optimisation.
 *
 * @returns the plane, or null when the passes should use clearance
 */
export function crossingPlane(params, stock, fixtures) {
  if (hasFixtures(fixtures)) return null;
  const top = Number.isFinite(stock?.max?.[2]) ? stock.max[2] : params.topZ;
  const highest = Math.max(
    Number.isFinite(top) ? top : -Infinity,
    Number.isFinite(params.topZ) ? params.topZ : -Infinity,
  );
  if (!Number.isFinite(highest)) return null;
  const plane = highest + entryGapOf(params);
  return plane < params.clearanceHeight - 1e-9 ? plane : null;
}

/**
 * Leave the tool at clearance at the end of an operation.
 *
 * Once passes are allowed to travel below clearance between themselves, the
 * *last* one has to put the tool back: the next operation may be a longer tool,
 * a different setup's idea of where the part is, or a tool change, and all of
 * them assume the program handed over from clearance. Nothing is emitted when
 * the tool is already there, and the peephole drops it if it turns out to be a
 * pure vertical move nothing follows.
 */
export function goHome(cl, clearance) {
  if (cl.count === 0 || !Number.isFinite(clearance)) return;
  const [x, y] = lastXY(cl);
  if (cl.data[(cl.count - 1) * 8 + 3] >= clearance - 1e-9) return;
  cl.rapid(x, y, clearance);
}

/**
 * Bring the tool from clearance down to the start of a cut at `z`.
 *
 * @param options.feedPlane rapid down to here first, then feed (null = feed all
 *   the way from clearance)
 * @param options.positioned the caller already rapided to (x, y) at clearance
 */
export function approach(cl, x, y, z, { clearance, feedPlane = null, positioned = false }) {
  if (!positioned) cl.rapid(x, y, clearance);
  // Down to the feed plane, and never *up* to it.
  //
  // The feed plane is a gap above the surface this pass enters through, and it
  // is worked out from the level above — which is fine when the tool arrives
  // from clearance, and wrong the moment a caller hands it a lower height to
  // arrive at. A pocket linking two rings inside itself arrives at one entry gap
  // above the cut, and then this rapided it back up to a plane above the *stock*
  // before plunging: down to Z9, up to Z11, down to Z8, on every ring. Read as
  // motion it is a hop over nothing, and it is exactly what the linking was
  // there to remove. Where the tool already is is never worse than the plane it
  // was going to rapid down to.
  const drop = feedPlane != null ? Math.min(feedPlane, clearance) : null;
  if (drop != null && drop > z + 1e-9) cl.rapid(x, y, drop);
  cl.cut(x, y, z, FEED.PLUNGE);
}

/**
 * How high the material still stands where a pass is about to enter, for a
 * strategy whose path changes from one depth level to the next.
 *
 * `entryPlane` is worked out from "the level above", which is the right answer
 * only where the level above cut *this ground*. A slot and a contour in `level`
 * mode both re-read the part's outline at every depth, so the moment the
 * cross-section changes the pass is following a line no earlier pass has been
 * anywhere near — and the material there is still standing at the top of the
 * billet.
 *
 * What that looked like on the 100×70×12 step plate with a 60×40 boss on it: at
 * Z13.5 the outline is the boss, at Z10.5 it is the plate, and the first pass on
 * the plate outline rapided down to a feed plane 11mm inside solid stock and
 * then took a **13.5mm-deep full-width cut** with a ⌀6 cutter. On the sloped
 * part it was 24.7mm. Both read as "one pass per stepdown" in the summary.
 *
 * Coverage is answered by the tool's own swath: this pass enters at the level
 * above only where the level above ran its cutter within a radius of here.
 * Sampled rather than solved with polygon booleans — the question is which of
 * two heights to start a ramp at, and the sampled answer errs toward the higher
 * one, which is the safe direction.
 */
export class EntrySurface {
  /**
   * @param topZ the top of the uncut material
   * @param radius the cutter's radius — how wide a swath a pass clears
   */
  constructor(topZ, radius) {
    this.topZ = topZ;
    this.radius = Math.max(1e-6, radius);
    this.cell = this.radius;
    this.previous = null;      // { z, grid } of the last level that cut anything
    this.current = null;
  }

  /** Start collecting what this level cuts. */
  beginLevel() {
    this.current = new Map();
  }

  /**
   * The height a pass along `points` (flat [x, y, …]) has to enter through.
   * @param closed whether the path is a ring, so the segment back to its first
   *   point is travelled too
   * @returns the Z the ramp starts from
   */
  entryFor(points, closed = true) {
    if (!this.previous) return this.topZ;
    let answer = this.previous.z;
    this.walk(points, closed, (x, y) => {
      if (answer !== this.topZ && !this.near(this.previous.grid, x, y)) answer = this.topZ;
    });
    return answer;
  }

  /** Record that the cutter ran along `points` at this level. */
  covered(points, closed = true) {
    this.walk(points, closed, (x, y) => this.mark(x, y));
  }

  /**
   * Every point of a path, no further apart than half a radius.
   *
   * The closing segment of a ring is part of it, and leaving it out is not a
   * near-miss: the next level asks about that segment, finds nothing, and reads
   * the whole ring as untouched ground — so every level re-entered from the top
   * of the billet and the program grew by half again.
   */
  walk(points, closed, visit) {
    const step = this.radius / 2;
    const n = points.length / 2;
    if (n === 0) return;
    const last = closed && n > 2 ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const ax = points[i * 2];
      const ay = points[i * 2 + 1];
      const k = (i + 1) % n;
      const bx = points[k * 2];
      const by = points[k * 2 + 1];
      const pieces = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let s = 0; s < pieces; s++) {
        const t = s / pieces;
        visit(ax + (bx - ax) * t, ay + (by - ay) * t);
      }
    }
    visit(points[(n - 1) * 2], points[(n - 1) * 2 + 1]);
  }

  /** Close the level off at `z`; only a level that cut anything counts. */
  endLevel(z) {
    if (this.current?.size) this.previous = { z, grid: this.current };
    this.current = null;
  }

  mark(x, y) {
    const key = `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
    let list = this.current.get(key);
    if (!list) { list = []; this.current.set(key, list); }
    list.push(x, y);
  }

  near(grid, x, y) {
    const i = Math.floor(x / this.cell);
    const j = Math.floor(y / this.cell);
    const r2 = this.radius * this.radius;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const list = grid.get(`${i + di},${j + dj}`);
        if (!list) continue;
        for (let k = 0; k < list.length; k += 2) {
          const dx = list[k] - x;
          const dy = list[k + 1] - y;
          if (dx * dx + dy * dy <= r2) return true;
        }
      }
    }
    return false;
  }
}

/**
 * The Z values worth snapping a height to, named as a machinist would name them.
 *
 * Typing -23.4 into Bottom Z means finding the number first, which means
 * reading it off the stock summary or guessing and generating twice. These are
 * the four answers that are almost always the intended one, and every one of
 * them is already known to the app.
 *
 * @param stock resolved stock bounds, or null
 * @param modelBounds the part's bounds in setup space, or null
 * @returns [{ key, label, z, hint }] — only those that exist
 */
export function snapTargets(stock, modelBounds) {
  const out = [];
  if (modelBounds) {
    out.push({
      key: 'model-top', label: 'Model top', z: modelBounds.max[2],
      hint: 'The highest point of the part',
    });
    out.push({
      key: 'model-bottom', label: 'Model bottom', z: modelBounds.min[2],
      hint: 'The lowest point of the part',
    });
  }
  if (stock) {
    out.push({
      key: 'stock-top', label: 'Stock top', z: stock.max[2],
      hint: 'The top of the billet, before anything is cut',
    });
    out.push({
      key: 'stock-bottom', label: 'Stock bottom', z: stock.min[2],
      hint: 'The bottom of the billet — through the part',
    });
  }
  return out;
}
