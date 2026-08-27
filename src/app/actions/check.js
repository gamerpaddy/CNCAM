// Read a program back in and check it.
//
// A file is the one thing this app produces, and up to now the only way to look
// at one was to trust it. That is backwards: a G-code file is motion, and this
// app already knows how to draw motion, simulate it against a billet, time it,
// measure what it leaves against the model and say whether it fits the machine.
// The only thing missing was a door for the motion to come in by.
//
// So a file is parsed into CL data (engine/backplot.js) and then handed to
// exactly the machinery a generated program goes through. Nothing here is a
// second implementation of anything — the simulation, the timeline, the load
// report, the verification and the G-code panel are the same ones, and the
// program simply did not come from a strategy.
//
// Which makes this work on *anybody's* file: another CAM system's, a
// controller's own conversational output, or something typed by hand. The
// checks it runs are the ones a person would want before pressing cycle start
// on a file they did not write.

import { openFile, ACCEPT } from '../../io/files.js';
import { readGcode, reviewProgram, rapidCutFinding } from '../../engine/backplot.js';
import { renderGcodePanel } from '../gcode-panel.js';
import { SimulationPlayback } from '../../engine/simulate.js';
import { mergeMeshes } from '../../geom/mesh.js';
import { getSetting, SIM_CELLS } from '../settings.js';
import { plural } from '../../engine/text.js';

/**
 * The cutter to simulate an imported program with.
 *
 * A file says `T3` and nothing else: no diameter, no shape, no corner radius.
 * If the library has a tool with that number then that is what the person who
 * wrote the file meant, and it is the only honest answer available. Failing
 * that the widest cutter in the library is used, because the picture it draws
 * is the pessimistic one — a wider tool takes more metal, so anything it shows
 * as safe is safe with the real one.
 *
 * @returns { tool, why } — the second is said out loud, because a simulation of
 *   the wrong tool is a confident picture of a program nobody is going to run
 */
function toolForProgram(parsed, tools) {
  const wanted = parsed.events.find((e) => e.type === 'tool')?.tool;
  const byNumber = wanted != null && tools.find((t) => t.number === wanted);
  if (byNumber) return { tool: byNumber, why: `T${wanted} in your library` };
  const widest = tools.reduce((a, b) => ((b.diameter ?? 0) > (a?.diameter ?? 0) ? b : a), null);
  if (!widest) return { tool: null, why: 'no tools in the project' };
  return {
    tool: widest,
    why: wanted != null
      ? `⌀${widest.diameter} — the file asks for T${wanted} and there is no T${wanted} here`
      : `⌀${widest.diameter} — the file never names a tool`,
  };
}

/** G-code line → the move it became, for the panel's click-to-marker. */
function lineMapFrom(lineOf) {
  const map = new Map();
  for (let move = 0; move < lineOf.length; move++) {
    // First move wins: an arc becomes many moves on one line, and the one worth
    // marking is where the line begins.
    if (!map.has(lineOf[move])) map.set(lineOf[move], { op: 0, move });
  }
  return map;
}

export function makeCheckActions(ctx, space) {
  const { doc } = ctx;
  const { resolveSetupSpace } = space;

  /**
   * @param file an already-read { name, text } — how the harness gets in. The
   *   menu passes nothing and gets the dialog.
   */
  async function checkGcode(file = null) {
    // eslint-disable-next-line no-param-reassign
    file ??= await openFile(ACCEPT.gcode);
    if (!file) return;
    const text = file.text ?? new TextDecoder().decode(file.buffer);

    ctx.ui.setStatus(`Reading ${file.name}…`);
    let read;
    try {
      read = readGcode(text);
    } catch (err) {
      console.error(err);
      return ctx.ui.setStatus(`${file.name} could not be read: ${err.message}`, true);
    }
    const {
      parsed, cl, lineOf, extent, speeds, stats,
    } = read;
    if (cl.count === 0) {
      return ctx.ui.setStatus(`${file.name} has no motion in it — `
        + `${plural(stats.blocks, 'block')} read, none of them a move`, true);
    }

    const setup = doc.activeSetup();
    const space_ = setup ? resolveSetupSpace(setup) : {};
    const { stock = null, meshes = [] } = space_;

    // The program in the panel, so its text can be read and clicked through
    // beside the path — the same panel a generated program uses, and the same
    // line map, built the other way round.
    ctx.lastProgram = {
      text,
      lineMap: lineMapFrom(lineOf),
      ops: [{ name: file.name, cl }],
      imported: file.name,
    };
    renderGcodePanel(ctx.ui.gcode, ctx.lastProgram, ctx);
    ctx.ui.showGcodePanel();
    ctx.viewport.setToolpaths([cl]);

    const findings = reviewProgram({
      cl,
      parsed,
      machine: doc.machineRecord(),
      stock,
      fixtures: setup?.fixtures,
      extent,
      speeds,
    });

    const { tool, why } = toolForProgram(parsed, doc.project.tools ?? []);
    let simulated = false;
    if (stock && tool) {
      try {
        ctx.ui.setBusy(true);
        const sim = await ctx.pool.run('simulate', {
          setups: [{
            stock,
            frame: { matrix: space_.matrix, offset: space_.offset },
            ops: [{ cl, tool }],
          }],
          active: 0,
          maxCells: SIM_CELLS[getSetting('simQuality')] ?? SIM_CELLS.high,
          rapidFeed: doc.rapidFeed(),
          record: Number(getSetting('simRecord')) || 1,
          // The same question as for a program of our own, and a better one
          // here: this file was written somewhere else, and whether it makes
          // *this* part is exactly what cannot be told by reading it.
          verify: getSetting('verify') && meshes.length ? {
            mesh: mergeMeshes(meshes),
            tolerance: Number(getSetting('verifyTolerance')) || undefined,
          } : null,
        });
        const ops = [{ name: file.name, cl, tool }];
        ctx.simulation = { sim, ops, playback: new SimulationPlayback(sim) };
        ctx.viewport.simulation.setSimulation(sim);
        ctx.viewport.simulation.setDeviation(sim.verify ?? null);
        ctx.viewport.simulation.repaint(ctx.simulation.playback);
        ctx.viewport.setSimulationMode(true);
        ctx.ui.timeline.show(sim, ops);
        simulated = true;
        // The check that needs the billet rather than the file, and the one
        // most worth having on somebody else's program.
        const crash = rapidCutFinding(sim, ops);
        if (crash) findings.unshift(crash);
      } catch (err) {
        console.error(err);
        findings.push({ level: 'warn', line: -1, text: `it could not be simulated: ${err.message}` });
      } finally {
        ctx.ui.setBusy(false);
      }
    }

    ctx.ui.setStatus(summarise({
      file, stats, cl, findings, simulated, tool, why, stock, setup,
    }), findings.length > 0);
    return undefined;
  }

  /**
   * What the check found, in one sentence and then the list.
   *
   * The tool is named whether or not it was guessed, because the whole picture
   * downstream of it — what the billet ends up looking like, what the load
   * report says, whether anything reads as a gouge — is a picture of *that*
   * cutter, and a file does not say which one it meant.
   */
  function summarise({ file, stats, cl, findings, simulated, tool, why, stock, setup }) {
    const parts = [`${file.name}: ${plural(stats.blocks, 'block')}, `
      + `${plural(cl.count, 'move')}, written in ${stats.units}`];
    if (!stock) {
      parts.push('There is no stock to simulate it against — add a setup with a billet.');
    } else if (!simulated) {
      parts.push(`It was not simulated: ${why}.`);
    } else {
      parts.push(`Simulated in ${setup.name} with ${tool.name ?? `T${tool.number}`} (${why}).`);
    }
    if (findings.length === 0) {
      parts.push(stock
        ? 'Nothing to report: it fits the machine, it stays out of the clamps, '
          + 'and no rapid crosses the job below the top of the billet.'
        : 'Nothing to report about the file itself.');
    } else {
      parts.push(`${plural(findings.length, 'thing')} to look at — `
        + findings.map((f) => f.text).join(' '));
    }
    return parts.join(' ');
  }

  return { checkGcode };
}

export { toolForProgram, lineMapFrom };
