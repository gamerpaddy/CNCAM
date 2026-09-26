// Module-worker entry point for compute jobs. Register handlers in `jobs`.
// A handler gets (args, ctx) where ctx.progress(0..1) reports and
// ctx.cancelled() should be polled between slices of work.
// Return { result, transfer } to move buffers instead of copying them.

import { generateToolpath } from '../engine/toolpath.js';
import { simulateProgram, simulateTurning } from '../engine/simulate.js';
import { verifyRun } from '../engine/verify.js';
import { buildGcode, packLineMap } from '../post/index.js';
import { checkPost } from '../engine/backplot.js';

const jobs = {
  async ping(args, ctx) {
    ctx.progress(1);
    return { result: { pong: args?.value ?? null } };
  },

  async toolpath(args, ctx) {
    const cl = generateToolpath(args);
    ctx.progress(1);
    return { result: cl, transfer: [cl.moves.buffer] };
  },

  async simulate(args, ctx) {
    // The whole job, not one fixturing of it: the setups before the one being
    // watched have to run for it to know what billet it is starting from.
    // See engine/workpiece.js.
    //
    // Verification needs the setups *after* it too, since metal standing proud
    // of the model here is not excess if a later setup takes it off — so the
    // check is what decides whether the rest of the job is run.
    const check = args.verify;
    const { sim, cuts } = simulateProgram({ ...args, all: !!check });
    if (check) {
      const setup = args.setups[args.active ?? 0];
      sim.verify = verifyRun({
        sim,
        mesh: check.mesh,
        stock: setup.stock,
        cuts,
        frame: setup.frame,
        tolerance: check.tolerance,
      });
    }
    ctx.progress(1);
    return { result: sim, transfer: simTransfer(sim) };
  },

  /**
   * Print the program, and read the file back against the paths it came from.
   *
   * Here rather than on the page because it is a third of a second of work on
   * a large program, and on the page it froze the viewport right after the
   * paths it describes were drawn. See app/actions/program.js.
   */
  async post({
    postId, ops, settings, check,
  }, ctx) {
    const { text, lineMap } = buildGcode(postId, ops, settings);
    let postCheck = null;
    if (check && text.length <= check.maxLength) {
      try {
        postCheck = checkPost({ ops, text, lineMap, fitTolerance: check.fitTolerance });
      } catch (err) {
        // a check that cannot run is no verdict, not a failed post
        console.error(err);
      }
    }
    const packed = packLineMap(lineMap);
    ctx.progress(1);
    return {
      result: { text, lineMap: packed, postCheck },
      transfer: [packed.op.buffer, packed.move.buffer],
    };
  },

  async simulateTurn(args, ctx) {
    const sim = simulateTurning(args);
    ctx.progress(1);
    return { result: sim, transfer: simTransfer(sim) };
  },
};

/** Every buffer in a simulation record, moved to the main thread rather than copied. */
function simTransfer(sim) {
  const buffers = [sim.mask.buffer, sim.initial.buffer, sim.evStep.buffer,
    sim.evCell.buffer, sim.evHeight.buffer, sim.evPrev.buffer, sim.times.buffer];
  // the surface the program leaves, which verification measures against the model
  if (sim.final) buffers.push(sim.final.buffer);
  for (const key of ['low', 'high', 'judged', 'gouge', 'excess']) {
    if (sim.verify?.[key]) buffers.push(sim.verify[key].buffer);
  }
  // a milling record carries the tip at every step, and a turning one the
  // tool's own track — both one entry per sub-step rather than per CL move
  for (const key of ['tip', 'trackX', 'trackZ', 'trackTool']) {
    if (sim[key]) buffers.push(sim[key].buffer);
  }
  return buffers;
}

const cancelled = new Set();

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.cancel !== undefined) {
    cancelled.add(msg.cancel);
    return;
  }
  const { id, job, args } = msg;
  const ctx = {
    progress: (p) => self.postMessage({ id, progress: p }),
    cancelled: () => cancelled.has(id),
  };
  try {
    const handler = jobs[job];
    if (!handler) throw new Error(`unknown job: ${job}`);
    const { result, transfer = [] } = await handler(args, ctx);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  } finally {
    cancelled.delete(id);
  }
};
