// Did the program make the part?
//
// Everything else in this app checks a stage against the stage before it: a
// strategy against the geometry it was given, the linker against the strategy,
// the post against the CL data. None of that answers the only question anybody
// actually has, which is whether the metal that comes off the machine is the
// shape that was asked for. The simulation already knows what the program
// leaves behind and the model says what it should be; nobody was subtracting
// one from the other.
//
// So: two numbers per cell.
//
//   gouge   the finished surface is *below* the model — metal that should
//           still be there is gone, and no later operation can put it back.
//           This is the one that scraps parts.
//   excess  metal standing above the model that nothing is going to remove.
//           Cheap to fix and expensive to discover at inspection.
//
// Gouge is measured against this setup's own finished surface, because a gouge
// is absolute: a cut below the part is a cut below the part, and the setups
// that follow only ever remove more. Excess cannot be, and that is the whole
// difficulty with it — stock standing proud in setup 1 is not excess if setup 2
// is about to take it off. So excess is measured against the *workpiece*: what
// is left after every setup has run (engine/workpiece.js), seen down this
// setup's columns.
//
// The tolerance is not a fudge factor. A height grid samples the model at cell
// centres, and at a vertical wall one cell holds both the top of the wall and
// the floor beside it — so a single cell straddling an edge reads as a gouge as
// deep as the wall is tall, on a program that is perfect. What the grid knows
// at a cell is not a height but the *range* of heights across it, so a cell is
// only judged against the range its neighbourhood spans: below everything
// nearby to be a gouge, above everything nearby to be excess. Edges then say
// nothing rather than saying something false, which is the right answer for a
// check whose whole value is that it does not cry wolf.

import { inheritedColumns } from './workpiece.js';
import { buildHeightmap } from '../geom/heightmap.js';

/** Default tolerance, in mm — a twentieth, which is a finishing pass's world. */
export const DEFAULT_TOLERANCE = 0.05;

/**
 * Sample a heightmap onto another grid, nearest cell.
 *
 * The model raster and the simulation grid are built from the same bounds and
 * the same cell size and so are normally the same grid cell for cell; this is
 * the identity when they are, and the honest answer when a clamp inside the
 * rasteriser has made them differ. Cheap either way, and it means neither side
 * has to promise the other anything about how it laid its cells out.
 */
function sampleOnto(map, grid) {
  const out = new Float32Array(grid.width * grid.height);
  for (let j = 0; j < grid.height; j++) {
    const y = grid.origin[1] + j * grid.cellSize;
    const mj = Math.round((y - map.min[1]) / map.cellSize);
    for (let i = 0; i < grid.width; i++) {
      const x = grid.origin[0] + i * grid.cellSize;
      const mi = Math.round((x - map.min[0]) / map.cellSize);
      out[j * grid.width + i] = (mi < 0 || mj < 0 || mi >= map.width || mj >= map.height)
        ? -Infinity
        : map.data[mj * map.width + mi];
    }
  }
  return out;
}

/**
 * The range of model heights each cell has to answer to.
 *
 * One ring around the cell, which is the smallest window that can contain a
 * wall: the cell the wall lands in and the cells either side of it. A surface
 * below everything in that window is genuinely into the part; a surface above
 * everything in it is genuinely standing proud; anything between is a cell the
 * grid cannot resolve, and saying nothing there is the whole reason this check
 * can be trusted.
 *
 * Cells with no model geometry at all (through holes, the air around the part)
 * contribute nothing, so a hole does not drag its rim to −∞ and make a ring of
 * the part unjudgeable. A cell whose whole neighbourhood is empty comes back as
 * (+∞, −∞), which every comparison below reads as "nothing to judge".
 */
function modelRange(model, width, height) {
  const low = new Float32Array(width * height).fill(Infinity);
  const high = new Float32Array(width * height).fill(-Infinity);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const cell = j * width + i;
      let lo = Infinity;
      let hi = -Infinity;
      for (let dj = -1; dj <= 1; dj++) {
        const y = j + dj;
        if (y < 0 || y >= height) continue;
        for (let di = -1; di <= 1; di++) {
          const x = i + di;
          if (x < 0 || x >= width) continue;
          const v = model[y * width + x];
          if (!Number.isFinite(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      low[cell] = lo;
      high[cell] = hi;
    }
  }
  return { low, high };
}

/**
 * Which step last lowered a cell, and which operation that step was in.
 *
 * The event log already records it — every drop stores its step — so the answer
 * is a scan backwards for the cell rather than a re-run of anything. Called for
 * a handful of cells (the worst gouge, the worst excess), never per cell.
 */
export function lastTouch(sim, cell) {
  const { evCell, evStep, eventCount, opEnds } = sim;
  for (let k = eventCount - 1; k >= 0; k--) {
    if (evCell[k] !== cell) continue;
    const step = evStep[k];
    const op = opEnds ? opEnds.findIndex((end) => end > step) : -1;
    return { step, op: op < 0 ? (opEnds ? opEnds.length - 1 : -1) : op };
  }
  return { step: -1, op: -1 };
}

/**
 * Measure a finished program against the model it was made from.
 *
 * @param sim the active setup's simulation record (needs `final` and the grid)
 * @param map the model's top surface as a raster: { data, width, height, cellSize, min }
 * @param cuts every setup's cut record, this one included — see workpiece.js
 * @param frame the active setup's { matrix, offset }
 * @param tolerance how far off the model is still the model, in mm
 * @returns { gouge, excess, worstGouge, worstExcess, counts, tolerance }
 *   gouge/excess: mm per cell, zero where there is nothing to report
 */
export function verifyProgram({
  sim, map, cuts = null, frame = null, tolerance = DEFAULT_TOLERANCE,
}) {
  const { width, height, cellSize, origin, mask, stockTop, stockBottom } = sim;
  const cells = width * height;
  const grid = { width, height, cellSize, origin };
  const model = sampleOnto(map, grid);

  // What is left when the whole job has run, down this setup's columns. Excess
  // never has to know how many setups there are — the arithmetic below is the
  // same either way.
  //
  // On a one-setup job that answer is already in hand: the only cut is this
  // setup's own, so the workpiece *is* its finished surface, and marching every
  // column through the transforms to rediscover that is the whole cost of the
  // check for no information at all. Identity on the array rather than a count
  // of setups, so the shortcut can only fire when the two are literally the
  // same surface.
  const ownCut = cuts?.length === 1 && cuts[0].heights === sim.final;
  const remaining = cuts?.length && frame && !ownCut
    ? inheritedColumns({
      cuts, frame, mask, grid,
      stock: { top: stockTop, bottom: stockBottom },
    }).initial
    : sim.final;

  const { low, high } = modelRange(model, width, height);
  // Which cells this check has an opinion about at all. Written here rather
  // than re-derived by the viewport, because "is there part over this cell"
  // decides both what gets counted and what gets coloured, and two answers to
  // it is a red stripe round every through hole on a program that is clean.
  const judged = new Uint8Array(cells);
  const gouge = new Float32Array(cells);
  const excess = new Float32Array(cells);
  let worstGouge = { cell: -1, mm: 0 };
  let worstExcess = { cell: -1, mm: 0 };
  let gougeCells = 0;
  let excessCells = 0;
  let checked = 0;

  for (let cell = 0; cell < cells; cell++) {
    if (mask && mask[cell] === 0) continue;
    if (!Number.isFinite(model[cell])) continue;      // no part over this cell
    const lo = low[cell];
    const hi = high[cell];
    if (!Number.isFinite(lo)) continue;
    judged[cell] = 1;
    checked++;

    // A cell whose column was cut clean through has no surface to judge: the
    // model over it is a wall the grid cannot hold, or the part genuinely is
    // not there. Either way it is not a gouge measurement.
    const cut = sim.final[cell];
    if (cut > stockBottom + 1e-6) {
      const under = lo - cut;
      if (under > tolerance) {
        gouge[cell] = under;
        gougeCells++;
        if (under > worstGouge.mm) worstGouge = { cell, mm: under };
      }
    }

    const over = remaining[cell] - hi;
    if (over > tolerance) {
      excess[cell] = over;
      excessCells++;
      if (over > worstExcess.mm) worstExcess = { cell, mm: over };
    }
  }

  return {
    tolerance,
    // The range rather than the raw surface: this is what the verdict was
    // measured against, and it is what the viewport colours the stock by, so
    // the picture and the number can never disagree about what an edge is.
    low,
    high,
    judged,
    gouge,
    excess,
    gougeCells,
    excessCells,
    checked,
    worstGouge: worstGouge.cell >= 0
      ? { ...worstGouge, ...cellPlace(grid, worstGouge.cell), ...lastTouch(sim, worstGouge.cell) }
      : null,
    worstExcess: worstExcess.cell >= 0
      ? { ...worstExcess, ...cellPlace(grid, worstExcess.cell), ...lastTouch(sim, worstExcess.cell) }
      : null,
  };
}

/** Where a cell is, in the setup's own coordinates — what a message can name. */
function cellPlace({ width, cellSize, origin }, cell) {
  const i = cell % width;
  const j = (cell - i) / width;
  return { x: origin[0] + i * cellSize, y: origin[1] + j * cellSize };
}

/**
 * The same, from the mesh rather than from a raster.
 *
 * The model's top surface is rasterised onto the simulation's own grid —
 * undilated, because the dilation `buildHeightmap` does for the drop cutter is
 * deliberately generous (it grows every height by a cell so a finishing pass
 * cannot dive through a convex edge) and generosity in the *reference* surface
 * is a gouge report on a program that has not gouged. The neighbourhood window
 * above is this file's own answer to the same edge problem, and it is the
 * honest one for a measurement.
 */
export function verifyRun({
  sim, mesh, stock, cuts = null, frame = null, tolerance = DEFAULT_TOLERANCE,
}) {
  if (!mesh?.indices?.length) return null;
  const map = buildHeightmap(mesh, {
    cellSize: sim.cellSize,
    bounds: { min: stock.min, max: stock.max },
    floor: -Infinity,
    dilate: false,
  });
  return verifyProgram({ sim, map, cuts, frame, tolerance });
}
