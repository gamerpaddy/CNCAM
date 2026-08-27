// What is left of the billet, in the one frame every setup agrees on.
//
// A simulation is a height for every (x, y) *in the setup it belongs to*, and
// that is the right model for one fixturing and useless across two: turn the
// part over and "height" points the other way, so the second setup started from
// a full billet and cheerfully cut air through everything the first one had
// already taken off. The app said as much out loud — "the billet it comes back
// as is not something the app knows" — and that sentence is what this module
// deletes.
//
// The trick is not to resample anything. A setup's finished simulation already
// *is* a complete statement about the metal: in its own frame, everything above
// `heights[cell]` is gone and everything below it is still there. So the
// workpiece is not a new grid that the height grids get baked into — it is the
// height grids themselves, read through their own transforms:
//
//     there is metal at a part-space point p
//       ⟺  p is inside the raw stock
//       ∧  for every setup s:  (M_s p + t_s).z  ≤  h_s(x, y)
//
// One evaluation is one bilinear-free grid lookup per setup, so nothing is
// approximated beyond the resolution each setup was already simulated at, and a
// third setup adds a term rather than another copy of the metal. Which is the
// house rule: one description of the geometry, not two that can disagree.
//
// The one thing a stack of height fields cannot hold is an undercut *within a
// single setup* — a height grid has one surface per column by construction. It
// holds them fine across setups, which is where they come from: a lip machined
// from above in setup 1 and relieved from below in setup 2 is exactly two
// height fields whose intersection is undercut.

/**
 * What one setup's program removed, in that setup's own frame.
 *
 * `matrix` and `offset` are the setup's own (model → setup space, from
 * `resolveSetup`); the grid fields are the simulation's. Nothing here is
 * derived — it is the record the simulator already produced, plus the transform
 * that says which way up it was.
 *
 * @typedef {{
 *   matrix: number[], offset: number[],
 *   width: number, height: number, cellSize: number, origin: number[],
 *   heights: Float32Array, mask: Uint8Array,
 *   stockTop: number, stockBottom: number,
 * }} Cut
 */

/**
 * The cut record for a finished milling simulation.
 *
 * `playback.current` rather than `sim.initial`: the heights wanted are the ones
 * at the *end* of the program, and a simulation record holds the start plus the
 * events to get anywhere. Passing a playback that is parked mid-program is
 * legal and means what it says — the part as it stands at the playhead.
 */
export function cutFromSimulation(sim, heights, { matrix, offset }) {
  return {
    matrix, offset,
    width: sim.width, height: sim.height, cellSize: sim.cellSize, origin: sim.origin,
    heights,
    mask: sim.mask,
    stockTop: sim.stockTop, stockBottom: sim.stockBottom,
  };
}

/** Part space → this cut's setup space. */
function intoSetup({ matrix: m, offset: t }, x, y, z) {
  return [
    m[0] * x + m[1] * y + m[2] * z + t[0],
    m[3] * x + m[4] * y + m[5] * z + t[1],
    m[6] * x + m[7] * y + m[8] * z + t[2],
  ];
}

/**
 * This cut's setup space → part space.
 *
 * The rotation is orthonormal — it is built from three angles by
 * `rotationMatrix` and nothing ever scales it — so the inverse is the
 * transpose, and there is no matrix inversion anywhere in this file.
 */
export function intoPart({ matrix: m, offset: t }, x, y, z) {
  const [a, b, c] = [x - t[0], y - t[1], z - t[2]];
  return [
    m[0] * a + m[3] * b + m[6] * c,
    m[1] * a + m[4] * b + m[7] * c,
    m[2] * a + m[5] * b + m[8] * c,
  ];
}

/**
 * The cut surface's height over one of its own cells, nearest-cell.
 *
 * Nearest rather than interpolated because a cell *is* a square column of metal
 * in this model — that is what the simulator cut and what the viewport draws.
 * Interpolating would invent a surface between two columns that neither the
 * sweep nor the picture ever agreed to, and it would round a vertical wall into
 * a ramp half a cell wide, which is the wrong direction: a wall read as a ramp
 * hands the next setup metal that is not there.
 *
 * Returns `null` where the cut has nothing to say: off its grid, or on a cell
 * its stock never occupied.
 */
function heightAt(cut, x, y) {
  const i = Math.round((x - cut.origin[0]) / cut.cellSize);
  const j = Math.round((y - cut.origin[1]) / cut.cellSize);
  if (i < 0 || j < 0 || i >= cut.width || j >= cut.height) return null;
  const cell = j * cut.width + i;
  if (cut.mask[cell] === 0) return null;
  return cut.heights[cell];
}

/** Did this cut take the metal at part-space point p? */
export function removedBy(cut, [x, y, z]) {
  const q = intoSetup(cut, x, y, z);
  const h = heightAt(cut, q[0], q[1]);
  if (h === null) return false;
  return q[2] > h;
}

/**
 * Is there still metal at this part-space point, after all of these cuts?
 *
 * Says nothing about the raw stock — a point outside the billet was never metal
 * and no cut removed it. Callers that care (see `inheritedHeights`) bound the
 * question to the stock themselves, because "inside the billet" is a fact about
 * the setup asking, not about the setups that cut.
 */
export function materialAt(cuts, p) {
  for (const cut of cuts) if (removedBy(cut, p)) return false;
  return true;
}


/**
 * A hair, in millimetres.
 *
 * The march below stops when it has bracketed a surface this closely, which is
 * a hundred times finer than anything a cutter holds and a few hundred times
 * finer than the grid it is reading — so the answer's error is the *grid's*,
 * not the search's, which is the only honest place for it to live.
 */
const SURFACE_EPS = 0.001;

/** How many halvings that takes from a coarse first pass. Cheap; ~2^-12 of it. */
const REFINE_STEPS = 12;

/**
 * How many voids one column may carry into a setup.
 *
 * A column of a real part is metal, and then at most a hole through it — one
 * void. Two is a part machined from both ends into a middle web; three is
 * unusual; four is a number chosen so the array has a fixed stride rather than
 * because anybody expects to reach it. Voids past the cap are simply not
 * carried, which errs toward showing metal that is not there rather than
 * cutting air that is: the same direction every approximation in this app
 * leans, because that costs seconds and the other costs a cutter.
 */
export const MAX_VOIDS = 4;

/**
 * What the setups before this one left, column by column, in this setup's grid.
 *
 * A single height is not enough, and the flip is what shows it. Turn a part
 * over and the channel machined into its top is a void in the *underside* of
 * the new billet: the surface the cutter meets is still the full stock top, and
 * the hole is waiting three centimetres down. A height grid has no way to say
 * that, so the second setup would drill happily down to the channel, stop dead
 * at its own programmed depth and draw a floor across a hole. What a column
 * needs is not where the metal starts but where the metal *is*.
 *
 * So each column comes back as its top surface plus the voids under it, packed
 * flat: `voidAt[cell]` is where this cell's spans start in `voidTop`/`voidBot`
 * and `voidCount[cell]` how many there are. The simulator carries the pair
 * along and settles every height it writes down through any void it lands in
 * (see `settleThrough`), which is what turns a breakthrough into a hole.
 *
 * Marched rather than solved. The exact answer is a system of inequalities in
 * nearest-sampled grids, one per earlier setup, and along a general line each
 * of those is a staircase with a step at every cell boundary it crosses — there
 * is no closed form to have, only a different search. Marching at the finest
 * cell involved cannot step over a whole cell of that staircase, and the
 * bisection at each crossing lands on the surface within a micron. A void
 * thinner than one cell of the setup that made it can still be missed, which is
 * the grid's resolution talking and not this search's.
 *
 * @param cuts earlier setups' cut records
 * @param grid { width, height, cellSize, origin } — the new setup's grid
 * @param frame { matrix, offset } — the new setup's own transform
 * @param stock { top, bottom } — the new setup's billet, in its own frame
 * @param mask which of the new grid's cells are stock at all
 * @returns { initial, voidAt, voidCount, voidTop, voidBot, voids }
 */
export function inheritedColumns({ cuts, grid, frame, stock, mask }) {
  const { width, height, cellSize, origin } = grid;
  const cellCount = width * height;
  const initial = new Float32Array(cellCount).fill(stock.top);
  const voidAt = new Int32Array(cellCount);
  const voidCount = new Uint8Array(cellCount);
  const voidTop = new Float32Array(cellCount * MAX_VOIDS);
  const voidBot = new Float32Array(cellCount * MAX_VOIDS);
  const columns = { initial, voidAt, voidCount, voidTop, voidBot, voids: 0 };
  if (!cuts?.length) return columns;
  if (!(stock.top - stock.bottom > 0)) return columns;

  // The finest thing being read. A coarser march could step over a whole cell
  // of somebody's grid; a finer one resolves nothing that is in any of them.
  let march = cellSize;
  for (const cut of cuts) march = Math.min(march, cut.cellSize);

  let spans = 0;
  for (let j = 0; j < height; j++) {
    const y = origin[1] + j * cellSize;
    for (let i = 0; i < width; i++) {
      const cell = j * width + i;
      if (mask && mask[cell] === 0) continue;
      const x = origin[0] + i * cellSize;
      const at = (z) => materialAt(cuts, intoPart(frame, x, y, z));

      voidAt[cell] = spans;
      let z = stock.top;
      if (!at(z)) {
        // The column starts in air. That opening void is *above* the surface
        // rather than under it, so it is the surface that moves down and there
        // is no span to carry — which is the ordinary case for the second
        // setup of a job that faced the billet in the first.
        z = firstMetal(at, stock.top, stock.bottom, march);
        initial[cell] = z;
        if (z <= stock.bottom && !at(stock.bottom)) continue;   // nothing here at all
      }
      // and from the surface down: every stretch of air is a void to carry
      while (z > stock.bottom && voidCount[cell] < MAX_VOIDS) {
        const opens = firstAir(at, z, stock.bottom, march);
        if (opens === null) break;
        const closes = firstMetal(at, opens, stock.bottom, march);
        const k = spans++;
        voidTop[k] = opens;
        // a void that runs out of the bottom of the billet is a through hole,
        // and its floor is the stock bottom — which is where the viewport
        // already draws one
        voidBot[k] = closes;
        voidCount[cell]++;
        if (closes <= stock.bottom) break;
        z = closes;
      }
    }
  }
  columns.voids = spans;
  return columns;
}

/** Walking down from metal, the height where it first becomes air. Null if never. */
function firstAir(at, from, bottom, march) {
  let metal = from;
  for (let z = from - march; z > bottom; z -= march) {
    if (!at(z)) return refine(at, metal, z);
    metal = z;
  }
  if (!at(bottom)) return refine(at, metal, bottom);
  return null;
}

/** Walking down from air, the height where metal starts again. The bottom if never. */
function firstMetal(at, from, bottom, march) {
  let air = from;
  for (let z = from - march; z > bottom; z -= march) {
    if (at(z)) return refine(at, z, air);
    air = z;
  }
  if (at(bottom)) return refine(at, bottom, air);
  return bottom;
}

/**
 * Halve between a height known to be metal and one known to be air, and report
 * the boundary between them as the last height that is still metal.
 */
function refine(at, metal, air) {
  const metalIsLower = metal < air;
  let lo = Math.min(metal, air);
  let hi = Math.max(metal, air);
  for (let k = 0; k < REFINE_STEPS && hi - lo > SURFACE_EPS; k++) {
    const mid = (lo + hi) / 2;
    if (at(mid) === metalIsLower) lo = mid; else hi = mid;
  }
  return metalIsLower ? lo : hi;
}

/**
 * Settle a height down through any inherited void it has landed in.
 *
 * This is the whole point of carrying the voids: a cutter that reaches the top
 * of a hole machined from the other side has not made a floor there, it has
 * broken through, and the surface it leaves is the far side of the hole — or
 * nothing at all, if the hole goes through. One call per height the simulator
 * writes, and a column with no voids costs a single array read.
 */
export function settleThrough(columns, cell, z) {
  const n = columns.voidCount[cell];
  if (n === 0) return z;
  const base = columns.voidAt[cell];
  for (let k = 0; k < n; k++) {
    const top = columns.voidTop[base + k];
    if (z > top) return z;                  // above this void: nothing to do
    const bottom = columns.voidBot[base + k];
    if (z > bottom) return bottom;          // inside it: drop to its floor
  }
  return z;
}
