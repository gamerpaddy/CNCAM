// Turning the document into a program: generate, simulate, post, export.
//
// Everything here is "what would the machine do", as opposed to editing (what
// the job is) and files (where it lives). Generation runs in the worker pool,
// so all of it is async and all of it reports through the status bar — a
// clearing pass takes seconds during which nothing else on screen moves.

import { mergeMeshes } from '../../geom/mesh.js';
import { plural, verb, allOf } from '../../engine/text.js';
import { checkPost, rapidCutFinding } from '../../engine/backplot.js';

/**
 * And how big a program is too big to re-read while somebody is waiting.
 *
 * Two megabytes is about forty thousand blocks, which is a long 3D finishing
 * job. Past that the check is skipped rather than allowed to hold up a preview
 * — a courtesy on top of the panel, never something the panel may hang on.
 */
const MAX_CHECKED_PROGRAM = 2_000_000;
import { transformMesh } from '../../engine/setup.js';
import { turningProfile, barFromStock } from '../../engine/lathe.js';
import { estimateSeconds } from '../../engine/toolpath.js';
import { orientationFor, indexingWarnings } from '../../engine/indexing.js';
import { wrapFor, wrapWarnings, wrapExtent, linearExtent } from '../../engine/wrap.js';
import { buildGcode, postsFor, defaultPostFor } from '../../post/index.js';
import { renderGcodePanel } from '../gcode-panel.js';
import { opStatus, formatTime, opFingerprint, toolNumberClashes } from '../op-status.js';
import { resolveRegions } from '../regions-ui.js';
import {
  SimulationPlayback, positionAtStep, positionAtTime, turnPositionAt, opSpindleRpm,
} from '../../engine/simulate.js';
import { describeMachine, machineWarnings } from '../../doc/machines.js';
import { fixtureTop } from '../../engine/fixtures.js';
import { MOVE_STRIDE, OP } from '../../engine/cl.js';
import { effectiveCutting } from '../../engine/cutting.js';
import { placedPaths } from '../../engine/drawing.js';
import { openMachineManager } from '../machine-manager.js';
import { getSetting, SIM_CELLS } from '../settings.js';
import { saveFile, saveFiles, safeFileName, ACCEPT } from '../../io/files.js';

export function makeProgramActions(ctx, space) {
  const { doc } = ctx;
  const { resolveSetupSpace } = space;

  /** The drawing an operation follows, already placed on the billet. */
  function drawingFor(op, stock) {
    const id = op.params?.drawingId;
    if (!id) return null;
    const drawing = (doc.project.drawings ?? []).find((d) => d.id === id);
    return drawing ? placedPaths(drawing, stock) : null;
  }

  async function generate() {
    // A simulation is a picture of a program that no longer exists once this
    // finishes. Leaving it up meant the viewport went on showing cut material
    // from the old toolpaths while the new ones were drawn over it, and the
    // scrub bar went on offering steps that no longer meant anything — so the
    // first thing anyone did after generating was close it by hand.
    if (ctx.simulation) closeSimulation({ quiet: true });

    const jobs = [];
    let disabled = 0;
    let unusable = 0;
    let orphaned = 0;
    for (const setup of doc.setups()) {
      const { meshes, stock, matrix, offset } = resolveSetupSpace(setup);
      const mesh = meshes.length ? mergeMeshes(meshes) : null;
      // picked faces are stored in model space; move them into setup space so
      // they line up with the toolpaths
      const intoSetup = (m) => transformMesh(m, matrix, offset);
      for (const op of setup.operations) {
        const tool = doc.project.tools.find((t) => t.id === op.toolId);
        if (!op.enabled) { disabled++; continue; }
        if (!tool || !stock) {
          // an op that can no longer be generated must not keep showing the
          // path it produced back when it could
          doc.toolpaths.delete(op.id);
          doc.fingerprints.delete(op.id);
          unusable++;
          continue;
        }
        // An operation that follows a drawing and can no longer find it must
        // not quietly follow the part instead. `drawingFor` answers null both
        // for "no drawing asked for" and for "the drawing asked for is gone",
        // and every strategy reads null as "use the model" — so deleting a DXF
        // turned an engraving of fifteen drawn paths into an engraving of the
        // part's own silhouette, and a slot along a centreline into a slot down
        // a channel in the model, with nothing said either time. The delete
        // dialog promises those operations "will stop cutting"; this is what
        // makes that true.
        if (op.params?.drawingId
          && !(doc.project.drawings ?? []).some((d) => d.id === op.params.drawingId)) {
          doc.toolpaths.delete(op.id);
          doc.fingerprints.delete(op.id);
          orphaned++;
          continue;
        }
        // Rest machining reads what the operations above this one actually cut,
        // so those have to have finished before this one is described. Only
        // then, and only in that setup: making every job wait for the one
        // before it would serialise a pool that exists to run them at once.
        if (op.params?.restMachining && jobs.length) await Promise.all(jobs);

        jobs.push(
          ctx.pool.run('toolpath', {
            // No name: what an operation is called is the *program's* business,
            // and the post writes it. A strategy that also wrote it into its own
            // CL made every block in the file name itself twice.
            type: op.type, params: op.params, tool, stock, mesh,
            // the tool goes through because a picked wall only becomes a region
            // once it has the width the cutter machines it at — see regions-ui.js
            // the mesh goes through as well as the tool: rest machining has to
            // know which depths this operation will cut at before it can say
            // what is already gone at each of them — see regions-ui.js
            regions: resolveRegions(doc, op, intoSetup, setup, tool, mesh),
            // An imported DXF the pass follows instead of the part's own
            // outline. Placed here rather than in the worker because where a
            // drawing sits depends on the stock, which is a document question.
            drawing: drawingFor(op, stock),
            // Milling reads the clamps as regions above; turning cannot, because
            // a chuck does not take away a patch of the table, it takes away
            // everything past a Z. The strategies need the fixtures themselves
            // to work that out. See engine/fixtures.js chuckLimit.
            fixtures: setup.fixtures ?? [],
          }).then((cl) => {
            doc.toolpaths.set(op.id, cl);
            doc.fingerprints.set(op.id, opFingerprint(doc, op, setup));
          }),
        );
      }
    }
    if (jobs.length === 0) {
      if (unusable) {
        return ctx.ui.setStatus('Nothing to generate — operations need a tool, a model and a setup', true);
      }
      if (orphaned) {
        return ctx.ui.setStatus(`Nothing to generate — ${plural(orphaned, 'operation')} `
          + `${verb(orphaned, 'follows a drawing', 'follow drawings')} `
          + 'that is no longer in the project', true);
      }
      if (disabled) {
        return ctx.ui.setStatus(
          `Nothing to generate — ${allOf(disabled, 'operation')} `
          + `${verb(disabled, 'is', 'are')} disabled`, true);
      }
      // the commonest way to see this is to be looking at the other machine
      const elsewhere = doc.project.setups
        .filter((s) => (s.mode ?? 'mill') !== doc.machine)
        .reduce((n, s) => n + s.operations.length, 0);
      return ctx.ui.setStatus(elsewhere
        ? `No operations on the ${doc.machine === 'turn' ? 'lathe' : 'mill'} — `
          + `${elsewhere} are on the other machine`
        : 'No operations to generate', true);
    }
    ctx.ui.setStatus(`Generating ${plural(jobs.length, 'toolpath')}…`);
    ctx.ui.setBusy(true);
    try {
      await Promise.all(jobs);
      const cls = doc.enabledToolpaths();
      ctx.viewport.setToolpaths(doc.visibleToolpaths());
      refreshGcodePreview();
      // the tree draws each operation's result badge, so it has to be told that
      // results exist — generation writes toolpaths straight onto the document
      // and would otherwise leave every row showing what it knew before
      doc.emitChange('toolpaths');
      // the machine's own rapid rate, not a guess: on a job with a lot of
      // retracts the rapids are most of the cycle time
      const rapidFeed = doc.rapidFeed();
      const machine = doc.machineRecord();
      // plus the tool changes, which on a machine without a changer are a
      // minute each and a real part of how long the job takes
      const seconds = cls.reduce((sum, cl) => sum + estimateSeconds(cl, rapidFeed), 0)
        + toolChangeCount() * (machine?.toolChangeSeconds ?? 0);
      const notes = [];
      if (disabled) notes.push(`${disabled} disabled`);
      if (unusable) notes.push(`${unusable} missing a tool`);
      if (orphaned) {
        notes.push(`${orphaned} following ${verb(orphaned, 'a drawing', 'drawings')} `
          + `${verb(orphaned, 'that is', 'that are')} no longer in the project`);
      }
      // An operation that generated nothing is the failure most worth saying
      // out loud: it looks identical to one that was never generated.
      //
      // Which is not the same question as whether it had anything to say. A
      // status is `warn` for any note the strategy raised — "3 of these holes
      // are wider than the cutter", "4 are too small to orbit in" — and reading
      // that as "cut nothing" reported a spot drill that spotted seven holes
      // and a thread mill that cut three threads as having done nothing at all.
      // The two are counted apart and said apart.
      const generated = [...doc.allOperations()]
        .filter(({ op }) => op.enabled && doc.toolpaths.has(op.id))
        .map(({ op }) => ({ op, status: opStatus(doc, op) }));
      const barren = generated.filter(({ status }) => status?.empty).map(({ op }) => op.name);
      const flagged = generated
        .filter(({ status }) => !status?.empty && status?.warnings?.length)
        .map(({ op }) => op.name);
      // Does the program fit the machine it is for? Travel and spindle range
      // are checked here rather than at the machine, which is where they were
      // being found: a soft-limit alarm halfway through a program is an hour of
      // setup wasted for something the app already knew.
      const limits = machineWarnings(doc.machineRecord(), travelExtent(cls),
        programSpeeds());
      // A clamp taller than the plane the job traverses at is a crash the
      // backplot draws as a straight orange line over the part. The operation
      // panel says so too, but this is the moment the whole program is in front
      // of you — and the clamp belongs to the setup, so one operation being
      // wrong about it means all of them are.
      limits.unshift(...clearanceWarnings());
      // An indexed setup on a machine without the rotary axes to reach it, or a
      // face past an axis's travel, alarms the moment it swings. The whole
      // program is in front of you here, so it is the moment to say so.
      limits.unshift(...indexingWarnings(doc.machineRecord(), doc.setups()));
      // A wrapped setup on a machine with no such rotary axis, or a pattern
      // wider than the bar is round — the second is invisible on the flat
      // program, where it is simply a long one.
      for (const setup of doc.setups()) {
        const wrap = wrapFor(setup, doc.machineRecord());
        if (!wrap) continue;
        const flat = cls.filter((cl) => setup.operations
          .some((o) => doc.toolpaths.get(o.id) === cl));
        limits.unshift(...wrapWarnings(wrap, programExtent(flat)));
      }
      // Two cutters on one T number is a wrong-tool crash and it is invisible
      // in the file — the second change is dropped as a restatement of the
      // first. The operation panel says so too, but this is the moment the
      // whole program is in front of you. See op-status.js toolNumberClashes.
      for (const [number, sharing] of toolNumberClashes(doc.project)) {
        limits.unshift({
          text: `T${number} is ${sharing.length} different cutters `
            + `(${sharing.map((t) => t.name).join(', ')}) — renumber before running this`,
        });
      }
      // And the file against the path it was printed from. The post is the one
      // stage nothing else checks; `refreshGcodePreview` reads its own output
      // back and this is where the answer is worth saying out loud.
      const post = ctx.lastProgram?.postCheck;
      if (post && post.over > 0) {
        limits.unshift({
          text: `the posted file does not match the path it came from — `
            + `${post.ops[post.op]?.name ?? 'an operation'} is out by `
            + `${post.worst.toFixed(3)}mm when the file is read back. That is a bug `
            + `in the post, not in the toolpath; do not run this`,
        });
      }

      // machineWarnings writes lowercase clauses meant to hang off a dash, so a
      // full stop in front of one reads as a sentence that forgot its capital.
      // And saying only the first of them means a job that is over on two axes
      // is a generate-fix-generate-fix cycle to find that out — the count says
      // there is more to come.
      const more = limits.length > 1 ? ` (+${limits.length - 1} more)` : '';
      const suffix = (notes.length ? `, ${notes.join(' and ')}` : '')
        + (limits.length ? ` — ${limits[0].text}${more}` : '');
      const said = [];
      if (barren.length) said.push(`${barren.length} cut nothing: ${barren.join(', ')}`);
      if (flagged.length) {
        said.push(`${plural(flagged.length, 'operation')} cut, but with something to `
          + `say about it: ${flagged.join(', ')}`);
      }
      const tail = said.length ? `. ${said.join('; ')} — see Result in the panel` : '';
      ctx.ui.setStatus(
        `Generated ${plural(jobs.length, 'toolpath')} — est. ${formatTime(seconds)}${suffix}${tail}`,
        limits.length > 0 || said.length > 0);
    } catch (err) {
      console.error(err);
      ctx.ui.setStatus(`Generation failed: ${err.message}`, true);
    } finally {
      ctx.ui.setBusy(false);
    }
  }

  /**
   * Setups whose clamps stand above the plane their operations traverse at.
   *
   * One line per setup rather than per operation: the clamp is the setup's, and
   * a twelve-operation setup would otherwise say the same thing twelve times.
   */
  function clearanceWarnings() {
    const out = [];
    for (const setup of doc.setups()) {
      if ((setup.mode ?? 'mill') === 'turn') continue;
      const clamp = fixtureTop(setup.fixtures);
      if (!clamp) continue;
      const low = setup.operations
        .filter((op) => op.enabled && doc.toolpaths.has(op.id)
          && op.params?.clearanceHeight < clamp.z);
      if (low.length === 0) continue;
      out.push({
        level: 'warn',
        text: `${clamp.name} stands to Z${Math.round(clamp.z * 1000) / 1000} and `
          + `${low.length === setup.operations.length ? 'every operation in '
            : `${plural(low.length, 'operation')} in `}${setup.name} rapids below that — `
          + 'raise Clearance Z or the tool goes through the clamp',
      });
    }
    return out;
  }

  /** How many times the operator or the turret has to change tool. */
  function toolChangeCount() {
    let changes = 0;
    let last = null;
    for (const { op } of doc.allOperations()) {
      if (!op.enabled || !doc.toolpaths.has(op.id) || !op.toolId) continue;
      if (op.toolId !== last) { changes++; last = op.toolId; }
    }
    return changes;
  }

  /** The box every move of the program stays inside, in setup coordinates. */
  function programExtent(programs) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const cl of programs) {
      const d = cl.moves;
      for (let n = 0; n < cl.count; n++) {
        const o = n * MOVE_STRIDE;
        for (let k = 0; k < 3; k++) {
          const v = d[o + 1 + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
        // a drill cycle's retract is a Z the tool really goes to
        if (d[o] === OP.DRILL && d[o + 4] > max[2]) max[2] = d[o + 4];
      }
    }
    return Number.isFinite(min[0]) ? { min, max } : null;
  }

  /**
   * The same, as the machine's *linear* axes will see it.
   *
   * A wrapped setup's developed axis is not a linear axis at all: that
   * direction is round the bar, the file has no word for it, and the table does
   * not move there. Measured flat, a pattern that goes right round a ⌀100 bar
   * asked for 314mm of Y — and every machine in the rack was told it had not
   * got it. See engine/wrap.js linearExtent.
   */
  function travelExtent(programs) {
    const machine = doc.machineRecord();
    const wrapped = doc.setups()
      .map((setup) => ({ setup, wrap: wrapFor(setup, machine) }))
      .filter(({ wrap }) => wrap);
    if (wrapped.length === 0) return programExtent(programs);

    const of = (setup) => programs.filter((cl) => setup.operations
      .some((o) => doc.toolpaths.get(o.id) === cl));
    const taken = new Set(wrapped.flatMap(({ setup }) => of(setup)));
    const parts = [programExtent(programs.filter((cl) => !taken.has(cl)))];
    for (const { setup, wrap } of wrapped) parts.push(linearExtent(wrap, programExtent(of(setup))));

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const part of parts) {
      if (!part) continue;
      for (let k = 0; k < 3; k++) {
        if (part.min[k] < min[k]) min[k] = part.min[k];
        if (part.max[k] > max[k]) max[k] = part.max[k];
      }
    }
    return Number.isFinite(min[0]) || Number.isFinite(min[1]) || Number.isFinite(min[2])
      ? { min, max } : null;
  }

  /**
   * The fastest and slowest the program asks the spindle and the feeds to go,
   * and which operation asks.
   *
   * Only operations that put something in the file count. An operation that
   * generated nothing states no tool, no speed and no feed — the post drops the
   * whole preamble for it (see post/core.js `silent`) — so counting its settings
   * warned about a spindle speed the program does not contain: a drill that
   * found no holes had the machine flagged for the 30000 rpm it would have asked
   * for. `programExtent` has always read the toolpaths; this now reads the same
   * program it does.
   */
  function programSpeeds() {
    let maxRpm = 0;
    let minRpm = Infinity;
    let maxFeed = 0;
    const at = {};
    for (const { op } of doc.allOperations()) {
      if (!op.enabled || !(doc.toolpaths.get(op.id)?.count > 0)) continue;
      const tool = doc.project.tools.find((t) => t.id === op.toolId);
      if (!tool) continue;
      const { spindleRpm, feedCut, feedPlunge } = effectiveCutting(op, tool);
      if (spindleRpm > 0) {
        if (spindleRpm > maxRpm) { maxRpm = spindleRpm; at.maxRpm = op.name; }
        if (spindleRpm < minRpm) { minRpm = spindleRpm; at.minRpm = op.name; }
      }
      const fastest = Math.max(feedCut, feedPlunge);
      if (fastest > maxFeed) { maxFeed = fastest; at.maxFeed = op.name; }
    }
    return { maxRpm, minRpm: Number.isFinite(minRpm) ? minRpm : 0, maxFeed, at };
  }

  /** Generated operations in program order, each with the tool that cuts it. */
  function simulatableOps(setup) {
    const out = [];
    for (const op of setup.operations) {
      const cl = doc.toolpaths.get(op.id);
      const tool = doc.project.tools.find((t) => t.id === op.toolId);
      // The name travels with it because the timeline draws a band per
      // operation and has nothing else to label it with — it arrived as
      // `undefined — 16:33` on every band the first time this was wired up.
      if (op.enabled && cl && tool) out.push({ name: op.name, cl, tool });
    }
    return out;
  }

  /**
   * Every milling setup of the job, in program order, ready for the simulator.
   *
   * The setups of a job are one billet held several ways round, so the second
   * one does not start from a fresh block — it starts from whatever the first
   * left, seen from the other side. That is only knowable by running them in
   * order, which is what `simulateProgram` does with these; each carries the
   * transform that says which way up it was (engine/workpiece.js).
   */
  function jobSetups() {
    return doc.setups().map((setup) => {
      const { stock, matrix, offset } = resolveSetupSpace(setup);
      return {
        setup, stock, frame: { matrix, offset }, ops: simulatableOps(setup),
      };
    });
  }

  /**
   * Simulate the active setup's program and hand the record to the timeline.
   * Runs in a worker: the sweep touches every grid cell under every move, which
   * is far too much to do on the frame thread.
   */
  async function simulate() {
    // the setup being worked on, not always the first — see Document.activeSetup
    const setup = doc.activeSetup();
    if (!setup) return ctx.ui.setStatus('Add a setup before simulating', true);

    const { meshes, stock } = resolveSetupSpace(setup);
    const ops = simulatableOps(setup);
    if (!stock) return ctx.ui.setStatus('Simulation needs stock — import a model first', true);
    if (ops.length === 0) return ctx.ui.setStatus('Generate toolpaths before simulating', true);

    // Two machines, two material models. A milled part is a height for every
    // (x, y); a turned one is a radius for every z, because the work is
    // spinning and every angle sees the same tool. Running a turning program
    // through the milling grid would draw a confident picture of the wrong
    // thing — see engine/simulate.js.
    const turning = (setup.mode ?? 'mill') === 'turn';

    ctx.ui.setStatus('Simulating material removal…');
    ctx.ui.setBusy(true);
    try {
      // Detail is a preference (how good do you want this to look, how long
      // will you wait) and the rapid rate is a fact about the machine — so they
      // come from two different places on purpose. See app/settings.js.
      const rapidFeed = doc.rapidFeed();
      // How much the run may remember, which is a different question from how
      // finely it draws — see the note on the setting.
      const record = Number(getSetting('simRecord')) || 1;
      const job = turning ? null : jobSetups();
      // findIndex cannot miss — the active setup comes from the same list — but
      // a -1 here would silently simulate nothing, so it is pinned.
      const active = turning ? 0 : Math.max(0, job.findIndex((s) => s.setup === setup));
      const sim = turning
        ? await ctx.pool.run('simulateTurn', {
          bar: barFromStock(stock, turningProfile(mergeMeshes(meshes))),
          ops: ops.map(({ cl, tool }) => ({ cl, tool })),
          samples: Number(getSetting('turnSamples')) || 1600,
          rapidFeed,
          record,
        })
        : await ctx.pool.run('simulate', {
          setups: job.map((s) => ({
            stock: s.stock,
            frame: s.frame,
            ops: s.ops.map(({ cl, tool }) => ({ cl, tool })),
          })),
          active,
          maxCells: SIM_CELLS[getSetting('simQuality')] ?? SIM_CELLS.high,
          rapidFeed,
          record,
          // The model the program was made from, in this setup's frame, so the
          // finished surface can be measured against it — see engine/verify.js.
          // Without a model there is nothing to check, which is the DXF-only
          // case: an engraving job has a drawing and no part.
          verify: getSetting('verify') && meshes.length ? {
            mesh: mergeMeshes(meshes),
            tolerance: Number(getSetting('verifyTolerance')) || undefined,
          } : null,
        });
      ctx.simulation = { sim, ops, playback: new SimulationPlayback(sim) };
      ctx.viewport.simulation.setSimulation(sim);
      // The stock is coloured by its distance from the model rather than by
      // what has been cut — see SimulationView.setDeviation. Set before the
      // first seek, so the opening frame is already the right picture.
      ctx.viewport.simulation.setDeviation(sim.verify ?? null);
      // The opening frame is the raw billet, and under this shading the raw
      // billet is already an answer — every millimetre of stock over the model
      // is metal the program still has to take off. Painted here because the
      // playback path only ever recolours the cells a move has *changed*.
      ctx.viewport.simulation.repaint(ctx.simulation.playback);
      ctx.viewport.setSimulationMode(true);
      ctx.ui.timeline.show(sim, ops);
      // Truncation means the tail of the program is *not on screen*, which looks
      // exactly like a toolpath that cuts nothing — so it is an error, and it
      // says what to do about it.
      // A rapid that takes metal is a crash, and unlike everything else the
      // simulation reports it is not a matter of degree. Said before the count
      // of operations, because it is the only line in the message that could
      // stop somebody running the program.
      const crash = rapidCutFinding(sim, ops);
      if (crash) {
        ctx.ui.setStatus(`${crash.text} Simulated ${plural(ops.length, 'operation')} `
          + `in ${setup.name} — scrub to the moment and look.`, true);
      } else if (sim.truncated) {
        ctx.ui.setStatus('Simulated, but the program outran the record — the last '
          + `part of it is not shown. Raise "Recording limit" in Options (it is at ${record}×), `
          + 'lower the simulation detail, or simulate fewer operations at a time.', true);
      } else {
        // Which operations these were, when they are not all of them.
        //
        // One setup is watched at a time, because a scrub bar is a picture of
        // one fixturing and the part is in a different place in the next. The
        // earlier setups still *ran* — this billet is what they left — so the
        // sentence says which ones are on screen rather than implying the rest
        // were ignored.
        const before = doc.setups().slice(0, active)
          .reduce((n, s) => n + s.operations.filter((o) => o.enabled).length, 0);
        const after = doc.setups().slice(active + 1)
          .reduce((n, s) => n + s.operations.filter((o) => o.enabled).length, 0);
        const inherited = before
          ? ` The billet it starts from is what ${plural(before, 'operation')} `
            + `in the setups before it left.`
          : '';
        const rest = after
          ? ` ${plural(after, 'operation')} ${verb(after, 'follows', 'follow')} in a later `
            + `setup — select it to watch ${verb(after, 'it', 'those')}.`
          : '';
        ctx.ui.setStatus(before || after
          ? `Simulated ${plural(ops.length, 'operation')} in ${setup.name} — scrub or press play.`
            + inherited + rest
          : `Simulated ${plural(ops.length, 'operation')} — scrub or press play`);
      }
    } catch (err) {
      console.error(err);
      ctx.ui.setStatus(`Simulation failed: ${err.message}`, true);
    } finally {
      ctx.ui.setBusy(false);
    }
  }

  /**
   * Move the simulation playhead; called by the timeline on every scrub tick.
   *
   * Cutter position uses continuous seconds rather than the destination-step's
   * end position — so a rapid appears as a fast traverse instead of teleporting
   * to its arrival point.
   */
  function seekSimulation(step, seconds) {
    const state = ctx.simulation;
    if (!state) return null;
    const changed = state.playback.seek(step);
    ctx.viewport.simulation.update(state.playback, changed);
    // A turning simulation walks each move in pieces, so its steps are no
    // longer its program's moves and the tool cannot be found by indexing into
    // the CL. It records where the tool actually was instead — see
    // engine/simulate.js turnPositionAt.
    const turning = state.sim.kind === 'turn';
    const cutter = turning
      ? turnPositionAt(state.sim, state.ops, step, seconds)
      : seconds != null
        ? positionAtTime(state.sim, state.ops, seconds)
        : positionAtStep(state.sim, state.ops, step);
    ctx.viewport.simulation.setCutter(cutter);
    // …and a dot on the metal that just came off, from the event log rather
    // than from the tool, so the two can be compared against each other
    ctx.viewport.simulation.setCutMarker(cutter, changed, state.playback);
    // A spinning bar is what says "the work turns and the tool does not". Some
    // people find it distracting when they are reading a profile, so it is a
    // choice rather than a fact. The speed is the program's own, scaled — a
    // threading pass really is slower than a roughing pass, and the picture
    // should say so.
    if (turning && getSetting('spinWork')) {
      const track = state.sim.trackTool;
      const at = Math.max(0, Math.min(track.length - 1, Math.round(step)));
      ctx.viewport.spinWork(seconds ?? state.playback.seconds,
        opSpindleRpm(state.ops[track[at]]));
    }
    ctx.viewport.requestRender();
    return { seconds: state.playback.seconds };
  }

  /**
   * Hide the backplot, or show it again.
   *
   * A finished job is a dozen overlapping paths drawn over the part, and the
   * question they are in the way of — does the surface look right — gets asked
   * more often than the one they answer. Hiding is a view state and nothing to
   * do with the program: the paths are still there, still posted, still
   * simulated.
   */
  function toggleToolpaths(show = null) {
    const next = ctx.viewport.setToolpathsVisible(
      show === null ? !ctx.viewport.toolpathsVisible() : show);
    ctx.ui.setStatus(next
      ? 'Toolpaths shown'
      : 'Toolpaths hidden — the program is unchanged');
    return next;
  }

  /**
   * Throw the computed toolpaths away.
   *
   * Different from hiding: this is for when the paths are *stale* rather than
   * in the way — after changing stock, or a tool, or anything the fingerprint
   * does not catch — and you would rather see nothing than see a plan of a job
   * that no longer exists. The operations stay exactly as they are.
   */
  function clearToolpaths() {
    if (doc.toolpaths.size === 0) return ctx.ui.setStatus('There are no toolpaths to clear');
    const count = doc.toolpaths.size;
    doc.toolpaths.clear();
    doc.fingerprints.clear();
    if (ctx.simulation) closeSimulation();
    ctx.viewport.setToolpaths(null);
    ctx.viewport.setMarker(null);
    refreshGcodePreview(false);
    doc.emitChange('toolpaths');
    return ctx.ui.setStatus(`Cleared ${plural(count, 'toolpath')} — Generate to compute them again`);
  }

  function closeSimulation({ quiet = false } = {}) {
    ctx.simulation = null;
    ctx.viewport.simulation.clear();
    ctx.viewport.setSimulationMode(false);
    ctx.ui.timeline.hide();
    if (!quiet) ctx.ui.setStatus('Simulation closed');
  }

  /**
   * Every generated operation on this machine, in program order.
   *
   * Each one carries the setup it belongs to, because a setup is a fixturing
   * and the post has to say so where one ends and the next begins — the part
   * comes out of the vice there. See post/core.js.
   */
  function postableOps() {
    const ops = [];
    const machine = doc.machineRecord();
    for (const setup of doc.setups()) {
      // An indexed setup carries the rotary swing that reaches its face; the
      // post applies it before the setup's operations and cancels it after.
      // Plain setups get null and post exactly as they always have.
      const orientation = orientationFor(setup, machine);
      // And a wrapped setup carries the cylinder its flat program bends round.
      const wrap = wrapFor(setup, machine);
      for (const op of setup.operations) {
        const cl = doc.toolpaths.get(op.id);
        if (op.enabled && cl) {
          ops.push({
            name: op.name, cl, wcs: setup.wcs, setup: setup.id, setupName: setup.name,
            orientation, wrap,
          });
        }
      }
    }
    return ops;
  }

  function refreshGcodePreview(show = true) {
    const ops = postableOps();
    if (ops.length === 0) {
      ctx.lastProgram = null;
      renderGcodePanel(ctx.ui.gcode, null, ctx);
      return;
    }
    // The same settings the exports use, and not a second copy of them: the
    // preview is what the file is checked in, so a preview built from different
    // options than the file is worse than no preview.
    const { text, lineMap } = buildGcode(doc.postId(), ops, postSettings());
    ctx.lastProgram = { text, lineMap, ops, postCheck: postCheck(ops, text, lineMap) };
    renderGcodePanel(ctx.ui.gcode, ctx.lastProgram, ctx);
    if (show) ctx.ui.showGcodePanel();
  }

  /**
   * How far the file that was just printed is from the path it was printed
   * from.
   *
   * The post is the one stage nothing downstream checks: a strategy is verified
   * against the part and the simulator against the CL data, and then the text
   * that actually goes to the machine is trusted because it was printed by code
   * that looked right. Reading it back closes that loop for free — the parser
   * already exists for the test suite, and running it here means every program
   * anybody posts is checked rather than only the ones a test happens to cover.
   *
   * Skipped on a program too big to re-read while somebody is waiting. That is
   * a real gap and it is the honest place for one: the check is a courtesy on
   * top of a preview, not something the preview may hang on.
   */
  function postCheck(ops, text, lineMap) {
    if (text.length > MAX_CHECKED_PROGRAM) return null;
    // eslint-disable-next-line no-use-before-define
    try {
      return checkPost({ ops, text, lineMap, fitTolerance: postSettings().arcTolerance });
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  function setPost(postId) {
    doc.updateItem(doc.project, { post: postId }, 'change post');
    refreshGcodePreview();
  }

  /**
   * Choose which machine the program is for.
   *
   * Not the same as choosing a dialect, which is what the toolbar used to do:
   * the machine brings its travel limits, its real rapid rate and its spindle
   * range with it, and all three change what the app tells you about a program
   * it has already generated. So the preview and the estimates are refreshed
   * rather than left saying what the last machine would have done.
   */
  function setMachineRecord(id) {
    if (!id || id === doc.project.machineIds?.[doc.machine]) return;
    doc.setMachineRecord(id);
    refreshGcodePreview(false);
    const machine = doc.machineRecord();
    if (machine) ctx.ui.setStatus(`${machine.name} — ${describeMachine(machine)}`);
  }

  function openMachines() {
    openMachineManager(doc, {
      onDone: () => {
        refreshGcodePreview(false);
        doc.emitChange('machines');
      },
    });
  }

  /**
   * Switch between the mill and the lathe.
   *
   * Nothing is thrown away: the other machine's setups stay in the project and
   * come back when you switch back. What changes is what the app is looking at
   * — which setups the tree lists, which strategies are on offer, which program
   * gets posted — and the post itself, because a lathe post cannot write a
   * milling program or the other way round.
   */
  function setMachine(machine) {
    if (machine === doc.machine) return;
    doc.setMachine(machine);
    if (!postsFor(machine).includes(doc.project.post)) {
      doc.updateItem(doc.project, { post: defaultPostFor(machine) }, 'change post');
    }
    // a backplot of the machine you just left is not a backplot of this one
    if (ctx.simulation) closeSimulation();
    doc.select(null, null);
    const setups = doc.setups();
    const label = machine === 'turn' ? 'Lathe' : 'Mill';
    ctx.ui.setStatus(setups.length
      ? `${label}: ${plural(setups.length, 'setup')}, `
        + `${plural([...doc.allOperations()].length, 'operation')}`
      : `${label} — no setups yet on this machine. Add one to start.`);
  }

  /**
   * Bring the toolpaths a file is about to be printed from up to date.
   *
   * A toolpath is computed once and then kept until something replaces it, so
   * changing a stepdown leaves the *old* path on the document with only a badge
   * in the tree to say so. Simulate has regenerated in that state for a while —
   * "watch a faithful animation of the previous stepdown" is a quiet failure —
   * and an export is the same failure with the machine on the end of it: the
   * file goes to the control, cuts the settings you replaced, and nothing
   * anywhere says which ones it used. So every export goes through here first.
   *
   * @param only one operation to check, or null for the whole program
   */
  async function freshenForExport(only = null) {
    const stale = staleOperations().filter((op) => !only || op === only);
    if (stale.length === 0) return;
    ctx.ui.setStatus(`${plural(stale.length, 'operation')} `
      + `${verb(stale.length, 'has', 'have')} changed since `
      + `${verb(stale.length, 'it was', 'they were')} generated — regenerating before export…`);
    await generate();
  }

  async function exportGcode() {
    await freshenForExport();
    const ops = postableOps();
    if (ops.length === 0) return ctx.ui.setStatus('Generate toolpaths before exporting', true);
    refreshGcodePreview();
    await saveFile(`${doc.project.name}.ngc`, ctx.lastProgram.text, ACCEPT.gcode);
    ctx.ui.setStatus(`Exported ${plural(ops.length, 'operation')} — ${doc.postId()} post`);
  }

  /** The post options every export uses, so one program cannot differ from another. */
  function postSettings() {
    const machine = doc.machineRecord();
    return {
      programName: doc.project.name,
      // the machine decides how a feed is written and whose name goes at the
      // top of the file — see post/lathe.js for why mm/rev is not a formatting
      // preference
      feedMode: machine?.feedMode ?? 'perMinute',
      machine: machine?.name ?? null,
      // a machine with no coolant gets a comment where the M8 would go, rather
      // than an M-word that switches a relay wired to something else
      coolant: machine?.coolant !== false,
      // and one with no changer gets a stop where the M6 would go, rather than
      // a comment the controller reads straight past — see post/grbl.js
      toolChanger: machine?.toolChanger ?? 'auto',
      ...(doc.project.postOptions ?? {}),
      // After the project's options, not before: whether this controller gets
      // G2/G3 is the machine's answer, and an old file still carrying the
      // project-wide tick must not override the machine it was migrated onto.
      // The dialect has the final say either way — post/core.js will not write
      // an arc for a post that cannot read one. See doc/machines.js.
      arcs: machine?.arcs !== false,
    };
  }

  /**
   * One file per operation.
   *
   * Not a formatting preference — a different way of working. Proving a program
   * out on the machine means running one operation, measuring the part, and
   * running the next; a shop with an operator loading each tool by hand wants
   * the same. Both are impossible with a single file unless you edit G-code by
   * hand, which is where mistakes come from.
   *
   * Each file is a complete, standalone program: its own header, its own tool
   * change, its own safe start and its own end. Posting the operations
   * separately rather than slicing the combined listing is what makes that
   * true — a slice of a longer program inherits modal state (the units, the
   * plane, the last feed, whether the spindle is already running) from lines
   * that are no longer there.
   */
  async function exportOperationsSeparately() {
    await freshenForExport();
    const ops = postableOps();
    if (ops.length === 0) return ctx.ui.setStatus('Generate toolpaths before exporting', true);

    const used = new Map();
    const files = ops.map((op, i) => {
      const base = safeFileName(op.name, `op${i + 1}`);
      // Two operations may share a name — the tree allows it — and two files
      // may not. Numbering every file also keeps them in machining order in a
      // directory listing, which is the order they have to be run in.
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      const suffix = n > 1 ? `-${n}` : '';
      return {
        name: `${String(i + 1).padStart(2, '0')} ${base}${suffix}.ngc`,
        content: buildGcode(doc.postId(), [op], postSettings()).text,
      };
    });

    const { written, folder } = await saveFiles(files);
    if (written === 0) return ctx.ui.setStatus('Export cancelled');
    ctx.ui.setStatus(folder
      ? `Exported ${plural(written, 'operation')} into ${folder} — ${doc.postId()} post`
      : `Exported ${plural(written, 'operation')} to your downloads — ${doc.postId()} post`);
  }

  /** One operation, on its own, from the tree or the operation panel. */
  async function exportOneOperation(op) {
    await freshenForExport(op);
    const cl = doc.toolpaths.get(op?.id);
    if (!cl) return ctx.ui.setStatus('Generate this operation before exporting it', true);
    const setup = doc.findSetupOf(op.id);
    const { text } = buildGcode(doc.postId(),
      [{
        name: op.name, cl, wcs: setup?.wcs,
        orientation: setup ? orientationFor(setup, doc.machineRecord()) : null,
        wrap: setup ? wrapFor(setup, doc.machineRecord()) : null,
      }], postSettings());
    await saveFile(`${safeFileName(op.name)}.ngc`, text, ACCEPT.gcode);
    ctx.ui.setStatus(`Exported ${op.name} — ${doc.postId()} post`);
  }

  /**
   * Operations whose toolpath no longer matches the operation that made it.
   *
   * The fingerprint is the same one the tree draws its "out of date" badge
   * from, so what Simulate regenerates is exactly what the panel is already
   * telling you is stale — one answer, in one place. An op with no toolpath at
   * all counts too: it is stale in the strongest sense.
   */
  function staleOperations() {
    const out = [];
    for (const { setup, op } of doc.allOperations()) {
      if (!op.enabled) continue;
      if (!doc.toolpaths.has(op.id)
        || doc.fingerprints.get(op.id) !== opFingerprint(doc, op, setup)) out.push(op);
    }
    return out;
  }

  /**
   * Simulate the current program, generating first when it would otherwise
   * simulate something that is no longer the job.
   *
   * Users think "let me watch it cut" as one action, not "generate then watch",
   * and the failure that made this worth widening is quiet: change a stepdown,
   * press Simulate, and watch a faithful animation of the *previous* stepdown.
   * Nothing on screen says the two disagree except a badge in the tree, and by
   * then you are looking at the part. Only checking for *no* toolpaths caught
   * the first press and never any of the ones after it.
   */
  async function simulateOrGenerate() {
    const stale = staleOperations();
    if (stale.length > 0) {
      ctx.ui.setStatus(doc.toolpaths.size === 0
        ? 'Generating before simulating…'
        : `${plural(stale.length, 'operation')} changed since ${stale.length === 1 ? 'it was' : 'they were'} generated — regenerating…`);
      await generate();
    }
    if (doc.toolpaths.size > 0) await simulate();
  }

  /**
   * Delete an item, asking first when the deletion reaches further than the row
   * the user clicked on.
   *
   * Deleting a setup takes its operations with it and deleting a tool leaves
   * every operation that used it unable to generate — both are one keystroke
   * away, both are undoable, and neither used to say a word. Undo is a safety
   * net, not a substitute for knowing what you are about to do.
   */

  return {
    generate,
    simulate,
    simulateOrGenerate,
    seekSimulation,
    closeSimulation,
    toggleToolpaths,
    clearToolpaths,
    refreshGcodePreview,
    setPost,
    setMachineRecord,
    openMachines,
    setMachine,
    exportGcode,
    exportOperationsSeparately,
    exportOneOperation,
  };
}
