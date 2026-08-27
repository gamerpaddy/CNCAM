import { test, assert } from './runner.js';
import { simulateRemoval, simulateProgram, SimulationPlayback } from '../engine/simulate.js';
import { CLBuilder, FEED } from '../engine/cl.js';
import { rotationMatrix } from '../engine/setup.js';
import {
  materialAt, removedBy, inheritedColumns, settleThrough, cutFromSimulation, intoPart,
} from '../engine/workpiece.js';

const FLAT = {
  number: 1, type: 'flat', diameter: 6, fluteLength: 20,
  spindleRpm: 10000, feedCut: 800, feedPlunge: 300,
};

// A 40×40×20 billet, centred on the model origin in X and Y so that turning it
// over lands it back on itself — which is what a real flip does and what makes
// the two setups comparable at all.
const TOP = { kind: 'box', min: [-20, -20, -10], max: [20, 20, 10] };

const IDENTITY = { matrix: rotationMatrix([0, 0, 0]), offset: [0, 0, 0] };
const FLIPPED = { matrix: rotationMatrix([180, 0, 0]), offset: [0, 0, 0] };

/** A single pass: plunge to z and sweep right across the middle of the billet. */
function sweep(z, y = 0, tool = FLAT) {
  const cl = new CLBuilder();
  cl.event('feeds', { cut: 600, plunge: 200 });
  cl.rapid(-25, y, 15);
  cl.cut(-25, y, z, FEED.PLUNGE);
  cl.cut(25, y, z);
  return { cl: cl.finish(), tool };
}

function heightAt(sim, heights, x, y) {
  const i = Math.round((x - sim.origin[0]) / sim.cellSize);
  const j = Math.round((y - sim.origin[1]) / sim.cellSize);
  return heights[j * sim.width + i];
}

function cellAt(sim, x, y) {
  const i = Math.round((x - sim.origin[0]) / sim.cellSize);
  const j = Math.round((y - sim.origin[1]) / sim.cellSize);
  return j * sim.width + i;
}

test('a finished simulation says where the metal went, in part space', () => {
  const sim = simulateRemoval({ stock: TOP, ops: [sweep(4)], frame: IDENTITY });
  const cut = cutFromSimulation(sim, sim.final, IDENTITY);

  assert.ok(removedBy(cut, [0, 0, 8]), 'metal above the cut is removed');
  assert.ok(!removedBy(cut, [0, 0, 2]), 'metal below the cut floor survives');
  assert.ok(!removedBy(cut, [0, 15, 9]), 'stock away from the path is untouched');
});

test('the cut record is read the same way whichever setup asks', () => {
  const sim = simulateRemoval({ stock: TOP, ops: [sweep(4)], frame: IDENTITY });
  const cut = cutFromSimulation(sim, sim.final, IDENTITY);
  // the flipped setup's own (x, y, z) for the same lump of metal
  assert.ok(removedBy(cut, intoPart(FLIPPED, 0, 0, -8)), 'the flipped frame finds the same hole');
});

test('material survives where no cut claims it', () => {
  const sim = simulateRemoval({ stock: TOP, ops: [sweep(4)], frame: IDENTITY });
  const cut = cutFromSimulation(sim, sim.final, IDENTITY);
  // a cut says nothing about metal it never had in front of it, which is not
  // the same as removing it
  assert.ok(materialAt([cut], [500, 500, 0]), 'a cut 500mm away removes nothing');
});

test('a flip puts the first setup\'s cut under the second setup\'s surface', () => {
  const first = simulateRemoval({ stock: TOP, ops: [sweep(4)], frame: IDENTITY });
  const cuts = [cutFromSimulation(first, first.final, IDENTITY)];
  const second = simulateRemoval({ stock: TOP, ops: [sweep(6)], frame: FLIPPED, cuts });

  // The first setup cut a 6mm-wide channel down to z = 4 along y = 0. Turned
  // over, that channel is in the *underside* of the second setup's billet: the
  // surface its cutter meets is still full stock and the hole is waiting 6mm
  // down — which is the fact a single height per column cannot carry.
  assert.close(heightAt(second, second.initial, 0, 0), 10, 1e-6,
    'the surface from this side is untouched stock');
  assert.ok(second.inherited, 'but the run knows there is a void under it');
});

test('cutting into a void from the other side breaks through rather than flooring it', () => {
  // the first setup takes the top 14mm off the middle, so metal survives from
  // the stock bottom up to z = −4
  const first = simulateRemoval({ stock: TOP, ops: [sweep(-4)], frame: IDENTITY });
  const cuts = [cutFromSimulation(first, first.final, IDENTITY)];
  // turned over, that is 6mm of web under the new top and air below it; a cut
  // 7mm deep from this side goes through the web
  const second = simulateRemoval({ stock: TOP, ops: [sweep(3)], frame: FLIPPED, cuts });
  const pb = new SimulationPlayback(second);
  pb.seek(second.stepCount);

  assert.close(heightAt(second, second.initial, 0, 0), 10, 1e-6, 'starts as full stock');
  assert.close(heightAt(second, pb.current, 0, 0), -10, 0.3,
    'the cutter went through the web, so the column is empty to the stock bottom');
});

test('a cut that stops short of the void still leaves its own floor', () => {
  const first = simulateRemoval({ stock: TOP, ops: [sweep(-4)], frame: IDENTITY });
  const cuts = [cutFromSimulation(first, first.final, IDENTITY)];
  // 2mm off the top, with the far side of the web still 4mm below it
  const second = simulateRemoval({ stock: TOP, ops: [sweep(8)], frame: FLIPPED, cuts });
  const pb = new SimulationPlayback(second);
  pb.seek(second.stepCount);
  assert.close(heightAt(second, pb.current, 0, 0), 8, 0.3, 'the floor is where the tool stopped');
});

test('nothing removed anywhere means the billet comes back whole', () => {
  const grid = { width: 5, height: 5, cellSize: 10, origin: [-20, -20] };
  const columns = inheritedColumns({
    cuts: [], grid, frame: IDENTITY, stock: { top: 10, bottom: -10 },
  });
  assert.ok(columns.initial.every((h) => h === 10), 'every column is full stock');
  assert.eq(columns.voids, 0, 'and carries no voids');
  assert.eq(settleThrough(columns, 4, 3), 3, 'so nothing settles anywhere');
});

test('a height landing in an inherited void drops to its floor', () => {
  const first = simulateRemoval({ stock: TOP, ops: [sweep(-4)], frame: IDENTITY });
  const cuts = [cutFromSimulation(first, first.final, IDENTITY)];
  const grid = { width: 41, height: 41, cellSize: 1, origin: [-20, -20] };
  const columns = inheritedColumns({
    cuts, grid, frame: FLIPPED, stock: { top: 10, bottom: -10 },
  });
  const cell = 20 * 41 + 20;                       // the middle of the channel
  assert.eq(columns.voidCount[cell], 1, 'one void under the web');
  assert.close(columns.voidTop[columns.voidAt[cell]], 4, 0.4, 'opening 6mm down');
  assert.close(settleThrough(columns, cell, 2), -10, 0.4, 'and it goes through');
  assert.close(settleThrough(columns, cell, 6), 6, 1e-6, 'above it, nothing moves');
});

test('a column the earlier setup took right off starts at the stock bottom', () => {
  // a 60mm cutter sweeping below the billet bottom removes the whole width of
  // it along y = 0, leaving nothing in those columns at all
  const first = simulateRemoval({
    stock: TOP, ops: [sweep(-11, 0, { ...FLAT, diameter: 20 })], frame: IDENTITY,
  });
  const cuts = [cutFromSimulation(first, first.final, IDENTITY)];
  const grid = { width: 41, height: 41, cellSize: 1, origin: [-20, -20] };
  const columns = inheritedColumns({
    cuts, grid, frame: FLIPPED, stock: { top: 10, bottom: -10 },
  });
  assert.close(columns.initial[20 * 41 + 20], -10, 1e-6, 'no metal anywhere in the column');
});

test('a whole job runs its setups in order and keeps one record per setup', () => {
  const { sim, cuts } = simulateProgram({
    setups: [
      { stock: TOP, ops: [sweep(-4)], frame: IDENTITY },
      { stock: TOP, ops: [sweep(3)], frame: FLIPPED },
    ],
    active: 1,
  });
  assert.eq(cuts.length, 2, 'both setups contributed a cut');
  assert.ok(sim.eventCount > 0, 'the watched setup keeps its event log');
  assert.ok(sim.inherited, 'and knows what the first setup left under it');
});

test('only the watched setup pays for an event log', () => {
  const { sim, cuts } = simulateProgram({
    setups: [
      { stock: TOP, ops: [sweep(4)], frame: IDENTITY },
      { stock: TOP, ops: [sweep(6)], frame: FLIPPED },
    ],
    active: 0,
  });
  assert.eq(cuts.length, 1, 'the setup after the active one was not run');
  assert.ok(sim.eventCount > 0, 'the watched setup scrubs');
  assert.close(heightAt(sim, sim.initial, 0, 0), 10, 1e-6, 'and starts from raw stock');
});

test('asking for the whole job runs the setups after the active one too', () => {
  const { cuts } = simulateProgram({
    setups: [
      { stock: TOP, ops: [sweep(4)], frame: IDENTITY },
      { stock: TOP, ops: [sweep(6)], frame: FLIPPED },
    ],
    active: 0,
    all: true,
  });
  assert.eq(cuts.length, 2, 'both, so verification can see what is still to come off');
});

test('a run kept only for its surface records no events', () => {
  const quiet = simulateRemoval({ stock: TOP, ops: [sweep(4)], logEvents: false });
  assert.eq(quiet.eventCount, 0, 'no log');
  assert.close(heightAt(quiet, quiet.final, 0, 0), 4, 0.3, 'but it still cut');
});

test('a surface machined in an earlier setup reads as machined, not as raw stock', () => {
  // face the whole top down by 3mm; the second setup is the same way up (a
  // re-fixturing rather than a flip), so it starts from that faced surface
  const first = simulateRemoval({
    stock: TOP, ops: [sweep(7, 0, { ...FLAT, diameter: 60 })], frame: IDENTITY,
  });
  const cuts = [cutFromSimulation(first, first.final, IDENTITY)];
  const second = simulateRemoval({ stock: TOP, ops: [sweep(6)], frame: IDENTITY, cuts });
  const pb = new SimulationPlayback(second);
  const cell = cellAt(second, 0, 0);
  assert.close(second.initial[cell], 7, 0.4, 'the inherited surface is 3mm down');
  assert.ok(pb.isCut(cell), 'inherited metal is below the raw top, so it reads as cut');
});
