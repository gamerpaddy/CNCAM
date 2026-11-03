// Golden hashes of the milling simulation, for the programs that never tilt.
//
// Simultaneous 5-axis taught `simulate.js` a second way to sweep a cutter. The
// first way — `cut()`, analytic, vertical tool — is what every 3-axis program in
// every setup has always been simulated with, and the rule for the change is
// that it stays *literally* the same code on the same path. A tolerance would
// hide a drift; a hash does not.
//
// The hashes in sim-golden.test.js were taken from `simulate.js` *before* the
// tilted sweep was added. If one changes, either the vertical path was touched
// (a bug) or the simulator was deliberately improved — re-take them with
// `node src/test/sim-golden.js` and say why in the commit.

import { simulateRemoval } from '../engine/simulate.js';
import { generateToolpath } from '../engine/toolpath.js';
import { CLBuilder, FEED } from '../engine/cl.js';
import { makeMushroom, makeStepped, makePocketBlock } from './fixtures.js';

const FLAT = { number: 1, type: 'flat', diameter: 6, fluteLength: 20, spindleRpm: 10000, feedCut: 800, feedPlunge: 300 };
const BALL = { ...FLAT, type: 'ball' };
const BULL = { ...FLAT, type: 'bull', cornerRadius: 1 };

/** Fields the tilted sweep adds; the vertical record must not depend on them. */
const ADDED = new Set(['axis', 'findings', 'five']);

function fnv(hash, bytes) {
  let h = hash;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** A stable hash of everything the simulation records, byte for byte. */
export function hashSim(sim) {
  let h = 2166136261 >>> 0;
  for (const key of Object.keys(sim).sort()) {
    if (ADDED.has(key)) continue;
    const value = sim[key];
    h = fnv(h, new TextEncoder().encode(key));
    if (ArrayBuffer.isView(value)) {
      h = fnv(h, new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    } else {
      h = fnv(h, new TextEncoder().encode(JSON.stringify(value)));
    }
  }
  return h.toString(16).padStart(8, '0');
}

function run(name, build) {
  const { stock, ops, maxCells } = build();
  return { name, sim: simulateRemoval({ stock, ops, maxCells: maxCells ?? 60_000 }) };
}

/** The programs the goldens are taken from. */
export function goldenRuns() {
  const out = [];

  out.push(run('mushroom roughing, flat', () => {
    const { mesh } = makeMushroom();
    const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 15] };
    return {
      stock,
      ops: [{
        tool: FLAT,
        cl: generateToolpath({
          type: 'clear2d', name: 'rough', tool: FLAT, mesh, stock,
          params: {
            topZ: 15, bottomZ: 0, stepdown: 3, stepover: 0.5, clearanceHeight: 25,
            stockToLeave: 0, rampAngle: 0, tolerance: 0.05, leadType: 'none',
          },
        }),
      }],
    };
  }));

  out.push(run('mushroom raster finish, ball', () => {
    const { mesh, postHeight, capHeight } = makeMushroom();
    const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, postHeight + capHeight] };
    return {
      stock,
      ops: [{
        tool: BALL,
        cl: generateToolpath({
          type: 'parallel3d', name: 'finish', tool: BALL, mesh, stock,
          params: {
            topZ: stock.max[2], bottomZ: 0, stepdown: 3, stepover: 1.2, clearanceHeight: 30,
            stockToLeave: 0, tolerance: 0.05, pattern: 'zigzag', angle: 0,
          },
        }),
      }],
    };
  }));

  out.push(run('stepped part, facing then slot', () => {
    const { mesh, height } = makeStepped();
    const stock = { kind: 'box', min: [-2, -2, 0], max: [42, 42, height + 2] };
    return {
      stock,
      ops: [
        {
          tool: FLAT,
          cl: generateToolpath({
            type: 'face', name: 'f', tool: FLAT, mesh, stock,
            params: {
              topZ: height + 2, bottomZ: height, stepdown: 1, stepover: 0.6, clearanceHeight: height + 12,
              tolerance: 0.01, stockToLeave: 0, pattern: 'zigzag',
            },
          }),
        },
        {
          tool: FLAT,
          cl: generateToolpath({
            type: 'slot', name: 's', tool: FLAT, mesh, stock,
            params: {
              topZ: height, bottomZ: 0, stepdown: 1.5, stepover: 0.4, slotWidth: 0,
              clearanceHeight: height + 12, entryGap: 1, tolerance: 0.01,
              stockToLeave: 0, rampAngle: 3, direction: 'climb',
            },
          }),
        },
      ],
    };
  }));

  out.push(run('pocket block, bull nose pocket', () => {
    const { mesh } = makePocketBlock();
    const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] };
    return {
      stock,
      ops: [{
        tool: BULL,
        cl: generateToolpath({
          type: 'pocket', name: 'p', tool: BULL, mesh, stock,
          params: {
            topZ: 10, bottomZ: 4, stepdown: 2, stepover: 0.5, clearanceHeight: 20,
            stockToLeave: 0, rampAngle: 3, tolerance: 0.05, leadType: 'none',
          },
        }),
      }],
    };
  }));

  // a hand-written program with the moves the strategies do not make: a ramp,
  // a plunge at rapid (a crash), a long diagonal
  out.push(run('hand-written ramps and a rapid crash', () => {
    const stock = { kind: 'box', min: [0, 0, 0], max: [40, 40, 10] };
    const cl = new CLBuilder();
    cl.event('feeds', { cut: 600, plunge: 200 });
    cl.rapid(-5, 5, 15);
    cl.cut(-5, 5, 8, FEED.PLUNGE);
    cl.cut(30, 5, 4, FEED.RAMP);          // a ramp
    cl.cut(30, 30, 4);                    // a level leg
    cl.cut(5, 36, 2.5);                   // a diagonal that goes deeper
    cl.rapid(5, 36, 12);
    cl.rapid(20, 20, 12);
    cl.rapid(20, 20, 3);                  // a rapid into metal
    cl.cut(20, 20, 1, FEED.PLUNGE);
    return { stock, ops: [{ tool: BALL, cl: cl.finish() }, { tool: FLAT, cl: cl.finish() }] };
  }));

  return out;
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('sim-golden.js')) {
  for (const { name, sim } of goldenRuns()) console.log(`${hashSim(sim)}  ${name}  (${sim.stepCount} steps, ${sim.eventCount} events)`);
}
