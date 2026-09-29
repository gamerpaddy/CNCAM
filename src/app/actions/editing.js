// Editing the job: setups, operations, clamps, and what order they run in.
//
// Nothing here computes anything — it changes what the program *is*, and every
// change goes through doc.updateItem or doc.apply so undo stays honest. The
// interesting decisions are which parameters a new or retyped operation
// inherits (see engine/op-defaults.js) and which deletions are big enough to be
// worth asking about first.

import { createOperation, uid } from '../../doc/schema.js';
import { plural } from '../../engine/text.js';
import { OP_LABELS } from '../../engine/toolpath.js';
import {
  defaultParamsFor, retypeParams, retoolParams, depthRangeFor, depthMeaningDiffers,
} from '../../engine/op-defaults.js';
import { createFixture } from '../../engine/fixtures.js';
import { pickToolFor } from '../../engine/tool-match.js';
import { drillOversize } from '../../engine/lathe.js';
import { tipLengthOf } from '../../engine/tool-geometry.js';
import { getSetting } from '../settings.js';
import { openStrategyPicker } from '../strategy-picker.js';
import { removalOf, nounFor } from '../item-labels.js';
import { roughingLeftover, suggestedEntryGap, isFinishingPass } from '../op-status.js';

/**
 * How much bar a new chuck leaves between its jaws and the part: a parting
 * blade's slot, which is cut behind the part's last face, and a little air
 * either side of it. See sizeChuckToStock.
 */
const PART_OFF_ROOM = 6;

export function makeEditActions(ctx, space) {
  const { doc } = ctx;
  const {
    resolveSetupSpace, ensureSetup, setupModelBounds, setupBoreBottom, setupBoreProfile,
    newSetup, uniqueSetupName,
  } = space;

  /**
   * Add an operation to the setup being worked in, asking which strategy.
   *
   * One way in for every door: the tree's "+ Add operation…", the A key, the
   * setup's menu and the checklist all come here. The checklist used to call a
   * second version that skipped the question and made a Contour, and the key
   * refused outright when there was no setup while the checklist quietly made
   * one — the same request, three different answers.
   *
   * The strategy is the first thing you know about an operation and the thing
   * every parameter depends on, so it is asked up front, on cards that say
   * what each one is for — see strategy-picker.js.
   *
   * @param setup where it goes; by default the setup being worked in, made if
   *   this machine has none yet
   */
  function addOperation(setup = null) {
    const existing = setup ?? doc.activeSetup();
    // Only a setup that has to be *made* needs something to make it from. A
    // drawing is enough on its own: engraving a plate does not need a solid,
    // and refusing to start until there is one is refusing the job.
    if (!existing && doc.project.models.length === 0 && (doc.project.drawings ?? []).length === 0) {
      return ctx.ui.setStatus('Import a model or a DXF before adding operations', true);
    }
    // The setup a first operation needs is made when the operation is — not
    // when the picker opens. Made up front, cancelling the picker left an empty
    // "Setup 1" behind that nobody had asked for, and choosing a strategy took
    // two presses of Ctrl+Z to undo: one for the operation, one for the setup.
    return openStrategyPicker({
      title: existing ? `Add an operation to ${existing.name}` : 'Add an operation to a new setup',
      confirm: 'Add operation',
      mode: existing?.mode ?? doc.machine ?? 'mill',
      onPick: (type) => {
        let op = null;
        doc.group('add operation', () => { op = addOperationTo(existing ?? ensureSetup(), type); });
        return op;
      },
    });
  }

  /**
   * An engraving pass pointed at a drawing, ready to generate.
   *
   * Importing a DXF and then having to add an operation, change its strategy to
   * engrave and find the Follow dropdown is four steps to do the one thing a
   * DXF is for.
   */
  function engraveDrawing(drawing) {
    if (!drawing) return;
    let op = null;
    // One click, one undo: the setup, the operation, the drawing it follows and
    // the name it takes from that drawing are four commands and one gesture.
    doc.group('engrave drawing', () => {
      const setup = ensureSetup();
      op = addOperationTo(setup, 'engrave');
      doc.updateItem(op.params, { drawingId: drawing.id }, 'follow drawing');
      doc.updateItem(op, { name: uniqueOpName(setup, `Engrave ${drawing.name}`) }, 'name op');
    });
    if (!op.toolId) ctx.ui.setStatus(noToolYet(op), true);
    else ctx.ui.setStatus(`${op.name} follows ${drawing.name} — set the depth and generate`);
  }

  /**
   * For the tree's per-setup "+ Add operation" affordance.
   *
   * The new operation arrives pointed at the material: heights taken from the
   * stock and the model, and stepping taken from what the strategy is for and
   * how big the cutter is. A default that has to be corrected before the first
   * generate is not a default, it is homework.
   */
  function addOperationTo(setup, type = null) {
    // eslint-disable-next-line no-param-reassign
    type ??= (setup.mode ?? 'mill') === 'turn' ? 'turnRough' : 'contour2d';
    const op = createOperation(type);
    // and holding a cutter that can do the job: a chamfer born holding a flat
    // end mill cannot cut at all, which is a mistake to find rather than a
    // default (see engine/tool-match.js)
    let tool = pickToolFor(type, doc.project.tools);
    const { stock } = resolveSetupSpace(setup);
    const defaults = (cutter) => defaultParamsFor(type, {
      stock, modelBounds: setupModelBounds(setup), tool: cutter, boreBottomZ: setupBoreBottom(setup),
    });
    let params = defaults(tool);
    if (type === 'turnDrill') {
      const fitting = drillThatFits(setup, params);
      if (fitting && fitting !== tool) {
        tool = fitting;
        params = defaults(tool);
      }
    }
    op.toolId = tool?.id ?? null;
    Object.assign(op.params, params, clearOfRoughing(setup, op, type, params));
    op.name = uniqueOpName(setup, OP_LABELS[type] ?? type);
    doc.addOperation(setup, op);
    doc.select('op', op.id);
    if (type === 'command') ctx.ui.setStatus(`Added ${op.name} — type the lines it writes`);
    else if (!op.toolId) ctx.ui.setStatus(noToolYet(op), true);
    else ctx.ui.setStatus(`Added ${op.name} with T${tool.number} ${tool.name}`);
    return op;
  }

  /**
   * A finishing pass's entry gap, raised to clear what the roughing before it
   * leaves — see op-status.js roughingLeftover. Only ever raised, and only for
   * a pass that treats the part's surface as all there is.
   */
  function clearOfRoughing(setup, op, type, params) {
    if (!setup || !isFinishingPass(type)) return {};
    const leftover = roughingLeftover(setup, op);
    if (!(leftover > 0) || (params.entryGap ?? 1) > leftover) return {};
    return { entryGap: suggestedEntryGap(leftover) };
  }

  /**
   * What to say about an operation that arrived with no cutter to hold.
   *
   * Said by name, and said the same wherever an operation is made: the one-click
   * engrave used to report "set the depth and generate" over an empty tool
   * box, and Generate then refused it.
   */
  function noToolYet(op) {
    return `Added ${op.name} with no tool — nothing in the rack can do it. `
      + 'Add a cutter that can (Tools…), then pick it in the panel';
  }

  /**
   * The biggest drill in the rack that goes down the part's bore without
   * opening it up — or null when none does, or the part has no bore to spoil.
   *
   * "The biggest drill" is the right pick for a solid bar and the wrong one for
   * a part whose bore is already drawn: it put a ½" drill down the test shaft's
   * ⌀12 pilot, 0.7mm oversize. The strategy says so too (see turning.js
   * generateTurnDrill); this is the same check, made before the choice.
   */
  function drillThatFits(setup, params) {
    const profile = setupBoreProfile(setup);
    if (!profile) return null;
    const fits = doc.project.tools
      .filter((t) => t.type === 'drill' && t.diameter > 0)
      .filter((t) => drillOversize(profile, { diameter: t.diameter, tipLength: tipLengthOf(t) },
        params.topZ, params.bottomZ).oversize <= 0.005)
      .sort((a, b) => b.diameter - a.diameter);
    return fits[0] ?? null;
  }

  /**
   * A name no other operation in this setup already has.
   *
   * Three facing passes all called "Face (2.5D)" are indistinguishable in the
   * tree, in the status bar and in the G-code comments — and a program is read
   * by whoever is standing at the machine, who did not build it.
   */
  function uniqueOpName(setup, base, except = null) {
    const taken = new Set(setup.operations.filter((o) => o.id !== except).map((o) => o.name));
    if (!taken.has(base)) return base;
    // strip any number this name already ends with, so copies of "Face 2" do
    // not become "Face 2 2"
    const stem = base.replace(/ \d+$/, '');
    for (let n = 2; ; n++) {
      const candidate = `${stem} ${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /**
   * Whether an operation is still wearing the name its strategy gave it —
   * "Waterline finish", or "Waterline finish 2" where a second one needed
   * telling apart. Anything else was typed by somebody and is not ours to move.
   */
  function isAutoName(name, type) {
    const label = OP_LABELS[type] ?? type;
    if (name === label) return true;
    // matched by hand rather than by regex: a label like "Face (2.5D)" is not
    // a pattern, and escaping one into a pattern is a bug waiting for the next
    // strategy whose name has a bracket in it
    if (!name?.startsWith(`${label} `)) return false;
    return /^\d+$/.test(name.slice(label.length + 1));
  }

  /**
   * Change an operation's strategy, moving the strategy-shaped parameters with
   * it. Heights, tool and feeds stay: those are decisions about this cut, not
   * about which strategy makes it — except where the new strategy *reads* the
   * heights differently, which is what depthMeaningDiffers picks out.
   */
  function retypeOperation(op, type) {
    const setup = doc.findSetupOf(op.id);
    const tool = doc.project.tools.find((t) => t.id === op.toolId);
    const params = retypeParams(type, op.params, { tool, from: op.type });
    if (setup && depthMeaningDiffers(op.type, type)) {
      const { stock } = resolveSetupSpace(setup);
      if (stock) {
        Object.assign(params, depthRangeFor(type, {
          stock, modelBounds: setupModelBounds(setup), boreBottomZ: setupBoreBottom(setup),
        }));
      }
    }
    // The name follows the strategy, unless somebody typed it.
    //
    // An operation called "Contour" that adaptively roughs is a lie in the
    // tree, in the status line and in the G-code comment a machinist reads —
    // and it is the *only* label on the row, so there is nothing else to go by.
    // A name the user chose is theirs and is left alone; one that is still the
    // strategy's own label (with or without the number that made it unique) was
    // never a decision, so it moves with the strategy.
    Object.assign(params, clearOfRoughing(setup, op, type, params));
    const patch = { type, params };
    // A command holds no cutter, and an operation that was one has none to
    // bring — so the tool goes with the change in either direction.
    if (type === 'command') patch.toolId = null;
    else if (op.type === 'command' || !op.toolId) {
      patch.toolId = pickToolFor(type, doc.project.tools)?.id ?? null;
    }
    const label = OP_LABELS[type] ?? type;
    if (setup && isAutoName(op.name, op.type)) {
      patch.name = uniqueOpName(setup, label, op.id);
    }
    doc.updateItem(op, patch, 'change strategy');
    ctx.ui.setStatus(`Strategy set to ${label} — stepping reset to suit it`);
  }

  /**
   * Put a different cutter in an operation, and move the numbers that were the
   * old cutter's with it.
   *
   * Writing `toolId` on its own is what the panel used to do, and it leaves the
   * operation stepping the way the cutter that is no longer in it wanted: a slot
   * created while a ⌀12 was picked keeps a 3mm stepdown when a ⌀3 is assigned,
   * which is 1.0×D on the one strategy whose default is a quarter of that
   * because it cuts on both sides at once. Nothing on screen said so.
   *
   * See engine/op-defaults.js retoolParams for what does and does not move.
   */
  function assignTool(op, toolId) {
    const previousTool = doc.project.tools.find((t) => t.id === op.toolId) ?? null;
    const tool = doc.project.tools.find((t) => t.id === toolId) ?? null;
    if ((tool?.id ?? null) === (previousTool?.id ?? null)) return;
    // The tool and the stepping that comes with it are one edit, not two:
    // undoing half of it leaves the operation holding the new cutter with the
    // old one's stepping, which is the state this function exists to prevent.
    let patch = {};
    let kept = [];
    doc.group('assign tool', () => {
      doc.updateItem(op, { toolId: tool?.id ?? null }, 'assign tool');
      if (!tool) return;
      ({ patch, kept } = retoolParams(op.type, op.params, { tool, previousTool }));
      if (Object.keys(patch).length) {
        doc.updateItem(op.params, patch, 'stepping for the new tool');
      }
    });
    if (!tool) return ctx.ui.setStatus(`${op.name} has no tool — it will not generate`, true);

    const moved = patch.stepdown != null ? `stepdown ${patch.stepdown}mm` : null;
    ctx.ui.setStatus(`${op.name}: T${tool.number} ${tool.name}`
      + (moved ? ` — ${moved} for a ⌀${tool.diameter}` : '')
      // A number somebody typed is kept, and saying so is the whole point:
      // silence here reads as "the app has taken care of it", and on a smaller
      // cutter it has not.
      + (kept.length ? ` — your ${kept.join(' and ')} kept, check it suits a ⌀${tool.diameter}` : ''),
      kept.length > 0);
  }

  /**
   * Copy a whole setup — stock, fixturing, clamps and every operation.
   *
   * A second-op setup is the first one flipped over: the same billet, mostly
   * the same operations, a different datum. Rebuilding that by hand is the
   * longest piece of retyping in the app, and it is the one where a number
   * copied wrongly is a crash.
   */
  function duplicateSetup(setup) {
    if (!setup) return;
    const copy = structuredClone({ ...setup, id: undefined });
    copy.id = uid('setup');
    copy.name = uniqueSetupName(`${setup.name} copy`);
    // Fresh ids all the way down: sharing one with the original would make the
    // two rows the same row as far as selection, toolpaths and deletion are
    // concerned.
    copy.fixtures = (copy.fixtures ?? []).map((f) => ({ ...f, id: uid('fixture') }));
    copy.operations = (copy.operations ?? []).map((op) => ({ ...op, id: uid('op') }));
    doc.addSetup(copy);
    doc.select('setup', copy.id);
    ctx.ui.setStatus(`${copy.name} — ${plural(copy.operations.length, 'operation')} copied, `
      + 'set the datum for the second op');
  }

  /** Copy an operation, with its parameters and picks, right after the original. */
  function duplicateOperation(op) {
    const setup = doc.findSetupOf(op.id);
    if (!setup) return;
    const copy = {
      ...structuredClone({ ...op, id: undefined }),
      id: uid('op'),
      name: uniqueOpName(setup, op.name),
    };
    doc.insertOperation(setup, copy, setup.operations.indexOf(op) + 1);
    doc.select('op', copy.id);
    ctx.ui.setStatus(`Duplicated ${op.name}`);
  }

  /**
   * Move an operation earlier or later in the program. Order is machining order.
   *
   * Through reorderOperation, so Move up says where the operation landed the
   * way a drag always has — they are the same edit made two ways.
   */
  function moveOperation(op, delta) {
    const setup = doc.findSetupOf(op.id);
    if (!setup) return;
    const from = setup.operations.indexOf(op);
    reorderOperation(setup, from, from + delta);
  }

  /** Drop an operation at an index — what the tree's drag-to-reorder calls. */
  function reorderOperation(setup, from, to) {
    if (from === to || from < 0 || to < 0 || to >= setup.operations.length) return;
    const name = setup.operations[from].name;
    doc.reorderOperation(setup, from, to);
    ctx.ui.setStatus(`${name} is now operation ${to + 1} of ${setup.operations.length}`);
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
  function deleteItem(kind, id) {
    const { operations } = doc.usageOf(kind, id);
    const item = doc.findItem(kind, id);
    if (!item) return;
    const removal = removalOf(kind, item);

    // Asking is a preference, not a safety net — undo is the safety net. Somebody
    // who has decided they do not want the dialog has decided; the message still
    // goes to the status bar either way.
    const ask = getSetting('confirmDelete')
      ? (text) => confirm(text)
      : () => true;

    if (kind === 'setup' && operations > 0
      && !ask(`Delete this setup and its ${plural(operations, 'operation')}?`)) return;
    if (kind === 'tool' && operations > 0
      && !ask(`${plural(operations, 'operation')} ${operations === 1 ? 'uses' : 'use'} this tool and will stop generating. Delete it anyway?`)) return;
    if (kind === 'model' && !ask('Remove this model from the project?')) return;
    if (kind === 'drawing' && operations > 0
      && !ask(`${plural(operations, 'operation')} ${operations === 1 ? 'follows' : 'follow'} this drawing and will stop cutting. Remove it anyway?`)) return;

    const remove = {
      model: () => doc.removeModel(id),
      drawing: () => doc.removeDrawing(id),
      tool: () => doc.removeTool(id),
      setup: () => doc.removeSetup(id),
      op: () => doc.removeOperation(id),
      fixture: () => doc.removeFixture(id),
    }[kind];
    remove?.();
    if (doc.selection?.id === id) doc.select(null, null);
    ctx.ui.setStatus(`${removal.done} ${item.name || `the ${nounFor(kind, item)}`}`
      + `${operations && kind !== 'op' ? ` (${plural(operations, 'operation')} affected)` : ''}`
      + ' — Ctrl+Z to undo');
  }

  /** Delete whatever the tree has selected. Bound to the Delete key. */
  function deleteSelected() {
    const sel = doc.selection;
    if (!sel) return;
    deleteItem(sel.kind, sel.id);
  }

  /**
   * Add a clamp to a setup, sized and placed against the stock so it lands
   * somewhere you can see rather than at the origin under the part.
   */
  function addFixture(setup, kind = 'box') {
    const fixture = createFixture(kind);
    const { stock } = resolveSetupSpace(setup);
    if (stock && kind === 'chuck') {
      sizeChuckToStock(fixture, stock, setupModelBounds(setup));
    } else if (stock) {
      const w = stock.max[0] - stock.min[0];
      const d = stock.max[1] - stock.min[1];
      // parked just off the Y- edge of the billet: visible, and not silently
      // eating half the part the moment it is created
      fixture.center = [(stock.min[0] + stock.max[0]) / 2, stock.min[1] - d * 0.12];
      fixture.size = [Math.max(10, w * 0.35), Math.max(8, d * 0.18)];
      fixture.diameter = Math.max(8, Math.min(w, d) * 0.2);
      fixture.baseZ = stock.max[2] - Math.max(2, (stock.max[2] - stock.min[2]) * 0.25);
      fixture.height = Math.max(5, (stock.max[2] - stock.min[2]) * 0.5);
    }
    fixture.name = uniqueFixtureName(setup,
      { chuck: 'Chuck', cylinder: 'Clamp', box: 'Jaw' }[kind] ?? 'Jaw');
    doc.addFixture(setup, fixture);
    doc.select('fixture', fixture.id);
    ctx.ui.setStatus(kind === 'chuck'
      ? `Added ${fixture.name}, gripping ⌀${fixture.clampDiameter} at Z${fixture.faceZ} — `
        + 'turning passes stop at the jaws'
      : `Added ${fixture.name} — every operation in this setup keeps out of it`);
  }

  /**
   * Put the chuck where the bar goes into it.
   *
   * A chuck at the origin with default jaws is a chuck in the middle of the
   * part, which is not a starting point, it is a mistake to find. The bar goes
   * in at the low-Z end — that is what "toward the chuck" means everywhere else
   * in the app — and it grips at the bar's own diameter.
   *
   * How far it reaches up the bar is the number that matters, and the answer is
   * "not as far as the part". Bar stock arrives with a chucking allowance behind
   * the part for exactly this (see engine/stock.js), so gripping that allowance
   * holds the work without burying any of it — but not all of it: the part is
   * parted off from the bar behind it, and the blade cuts its slot there, in
   * front of the jaws. Jaws brought right up to the part's last face left no
   * room for it at all, and the part-off went into them.
   *
   * Where there is not that much allowance — a part the full length of its
   * stock — the jaws take a diameter's worth and the operations say so, which
   * is the honest answer rather than a chuck that pretends to hold nothing.
   */
  function sizeChuckToStock(fixture, stock, modelBounds) {
    const diameter = stock.cylinder?.diameter
      ?? Math.min(stock.max[0] - stock.min[0], stock.max[1] - stock.min[1]);
    fixture.center = [stock.cylinder?.center?.[0] ?? 0, stock.cylinder?.center?.[1] ?? 0];
    fixture.clampDiameter = round3(diameter);
    fixture.faceZ = round3(stock.min[2]);

    const spare = modelBounds ? modelBounds.min[2] - stock.min[2] : 0;
    const grip = spare - PART_OFF_ROOM;
    fixture.jawLength = round3(grip >= 5 ? Math.min(grip, Math.max(10, diameter))
      : spare > 1 ? Math.min(spare, Math.max(10, diameter))
        : Math.max(5, Math.min(diameter, (stock.max[2] - stock.min[2]) * 0.25)));
    fixture.jawWidth = round3(Math.max(8, diameter * 0.5));
    fixture.bodyDiameter = round3(Math.max(80, diameter * 3));
    fixture.bodyLength = round3(Math.max(40, diameter * 1.6));
  }

  function round3(v) { return Math.round(v * 1000) / 1000; }

  function uniqueFixtureName(setup, base) {
    const taken = new Set((setup.fixtures ?? []).map((f) => f.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  /**
   * Call the project something. It is the name of the save, of the export and
   * of the program's first comment, so it is an edit like any other: undoable,
   * and said on the status line.
   */
  function renameProject(name) {
    const next = String(name ?? '').trim();
    if (!next || next === doc.project.name) return;
    doc.updateItem(doc.project, { name: next }, 'rename project');
    ctx.ui.setStatus(`The project is now called ${next}`);
  }

  return {
    renameProject,
    addOperation,
    addOperationTo,
    engraveDrawing,
    duplicateSetup,
    // the panels need the resolved billet to place a drawing against it
    setupStock: (setup) => resolveSetupSpace(setup).stock,
    retypeOperation,
    assignTool,
    duplicateOperation,
    moveOperation,
    reorderOperation,
    deleteItem,
    deleteSelected,
    addFixture,
    // a setup belongs to the machine it was made on, and arrives with the shape
    // of stock that machine is fed — bar for a lathe, a billet for a mill
    addSetup: () => {
      const setup = newSetup();
      doc.select('setup', setup.id);
      // said, like every other add: a new setup is a billet and a zero the
      // app chose, and those are the two things to look at before cutting
      ctx.ui.setStatus(`Added ${setup.name} — check the stock and where zero is`);
      return setup;
    },
  };
}
