// Document: the live project + runtime data (parsed meshes) + undo + change events.
// All mutations go through commands so undo/redo stays consistent.
// Listen with doc.addEventListener('change', e => ...); e.detail = { kind }.

import { UndoStack } from './undo.js';
import {
  createProject, serializeProject, deserializeProject, extractMeshes,
} from './schema.js';
import { computeNormals } from '../geom/mesh.js';
import { activeMachine } from './machines.js';
import { postsFor, defaultPostFor } from '../post/index.js';

export class Document extends EventTarget {
  constructor() {
    super();
    this.project = createProject();
    this.meshes = new Map();     // modelId -> { positions, indices, normals, faceRanges? }
    this.toolpaths = new Map();  // opId -> finished CL program (runtime, not persisted)
    // opId -> what the operation looked like when that toolpath was made, so
    // the UI can tell a current path from one the settings have moved past
    this.fingerprints = new Map();
    // Operations whose path is not drawn. This is a *view* filter, not part of
    // the program — a hidden operation is still generated, posted and
    // simulated. Which is the point: eleven overlapping paths in one colour
    // soup is the normal state of a finished job, and the only way to check one
    // of them is to look at it on its own.
    this.hiddenPaths = new Set();
    this.undoStack = new UndoStack();
    this.selection = null;       // { kind: 'model'|'tool'|'setup'|'op', id }
  }

  emitChange(kind) {
    this.dispatchEvent(new CustomEvent('change', { detail: { kind } }));
  }

  apply(label, doFn, undoFn) {
    const emit = () => this.emitChange(label);
    this.undoStack.push({
      label,
      do: () => { doFn(); emit(); },
      undo: () => { undoFn(); emit(); },
    });
  }

  /**
   * Run `fn` as one undoable step, however many commands it applies.
   *
   * For an action that is one gesture and two edits — see undo.js `group`.
   */
  group(label, fn) { return this.undoStack.group(label, fn); }

  undo() { this.undoStack.undo(); }
  redo() { this.undoStack.redo(); }

  // --- models ---

  addModel(model, mesh) {
    this.apply('add model',
      () => { this.project.models.push(model); this.meshes.set(model.id, mesh); },
      () => { this.removeById(this.project.models, model.id); this.meshes.delete(model.id); });
  }

  removeModel(id) {
    const index = this.project.models.findIndex((m) => m.id === id);
    if (index < 0) return;
    const model = this.project.models[index];
    const mesh = this.meshes.get(id);
    // back where it was, for the same reason removeOperation is careful about
    // it: undo is supposed to return the project you had, and a list that comes
    // back in a different order is not that project
    this.apply('remove model',
      () => { this.project.models.splice(index, 1); this.meshes.delete(id); },
      () => { this.project.models.splice(index, 0, model); this.meshes.set(id, mesh); });
  }

  // --- drawings (imported DXF) ---

  addDrawing(drawing) {
    this.apply('add drawing',
      () => this.project.drawings.push(drawing),
      () => this.removeById(this.project.drawings, drawing.id));
  }

  removeDrawing(id) {
    const index = this.project.drawings.findIndex((d) => d.id === id);
    if (index < 0) return;
    const drawing = this.project.drawings[index];
    // The operations that follow it keep pointing at it, dangling and all.
    //
    // Unpointing them looks tidier and is a different operation: `drawingId:
    // null` is not "no drawing", it is the setting that means *follow the part
    // instead*, and every strategy reads it that way. So clearing it turned an
    // engraving of fifteen drawn paths into an engraving of the part's own
    // silhouette and a slot along a centreline into a slot down a channel in
    // the model — both generated, both reported as up to date, neither the job
    // anybody set up, and the delete dialog promising they "will stop cutting"
    // while they did nothing of the kind. Held as a dangling id, generation
    // refuses them and says why (see actions/program.js) and the panel says the
    // drawing is gone rather than claiming the part's outline was chosen.
    this.apply('remove drawing',
      () => this.project.drawings.splice(index, 1),
      () => this.project.drawings.splice(index, 0, drawing));
  }

  // --- tools ---

  addTool(tool) {
    this.apply('add tool',
      () => this.project.tools.push(tool),
      () => this.removeById(this.project.tools, tool.id));
  }

  removeTool(id) {
    const index = this.project.tools.findIndex((t) => t.id === id);
    if (index < 0) return;
    const tool = this.project.tools[index];
    // the rack is read in the order it is drawn — put it back where it was
    this.apply('remove tool',
      () => this.project.tools.splice(index, 1),
      () => this.project.tools.splice(index, 0, tool));
  }

  // --- setups ---

  addSetup(setup) {
    this.apply('add setup',
      () => this.project.setups.push(setup),
      () => this.removeById(this.project.setups, setup.id));
  }

  removeSetup(id) {
    const index = this.project.setups.findIndex((s) => s.id === id);
    if (index < 0) return;
    const setup = this.project.setups[index];
    // the paths its operations had, so undo brings back the generated job and
    // not just the rows — the same bargain removeOperation already makes
    const paths = new Map();
    this.apply('remove setup',
      () => {
        this.project.setups.splice(index, 1);
        for (const op of setup.operations) {
          if (this.toolpaths.has(op.id)) paths.set(op.id, this.toolpaths.get(op.id));
          this.toolpaths.delete(op.id);
        }
      },
      () => {
        this.project.setups.splice(index, 0, setup);
        for (const [opId, cl] of paths) this.toolpaths.set(opId, cl);
      });
  }

  /**
   * Drop every setup, and everything under it, as one undoable step.
   *
   * The whole job at once, because that is how it is decided: a different part
   * has landed and nothing written for the old one applies to it. Four
   * `removeSetup` calls would put four entries on the undo stack for one
   * decision, and the first Ctrl+Z would bring back a job that is half there.
   *
   * @returns { setups, operations } — what it dropped, for the caller to say so
   */
  clearSetups() {
    const list = this.project.setups;
    const removed = list.slice();
    const operations = removed.reduce((n, s) => n + s.operations.length, 0);
    if (removed.length === 0) return { setups: 0, operations: 0 };
    // the generated paths ride along, the way removeSetup takes them, so undo
    // brings back the job that was there rather than just the rows
    const paths = new Map();
    for (const setup of removed) {
      for (const op of setup.operations) {
        if (this.toolpaths.has(op.id)) paths.set(op.id, this.toolpaths.get(op.id));
      }
    }
    this.apply('clear setups',
      () => {
        list.length = 0;
        for (const opId of paths.keys()) this.toolpaths.delete(opId);
      },
      () => {
        list.push(...removed);
        for (const [opId, cl] of paths) this.toolpaths.set(opId, cl);
      });
    return { setups: removed.length, operations };
  }

  /**
   * The job a newly imported model would strand.
   *
   * A setup is not free-standing: its stock is measured from the models in the
   * project, its zero is a corner of that stock, and every operation under it
   * holds heights, picked faces and rest state that were chosen on the part
   * that is there now. Import a different part and all of it goes on pointing
   * at the old one — which still generates, still posts, and looks entirely
   * plausible.
   *
   * Null when there is nothing to strand, and — the case that matters — when
   * the project has models but no geometry for any of them. That project came
   * back from an autosave or a file that could not carry its meshes, and the
   * import about to happen is the repair: the setups and operations are the
   * expensive part that survived, and offering to throw them away at exactly
   * that moment would be the worst advice in the app.
   *
   * @returns { setups, operations, models } — the job, and how many models it
   *   was built on; null when there is nothing to strand
   */
  strandedJob() {
    if (!this.project.models.some((m) => this.meshes.has(m.id))) return null;
    const setups = this.project.setups;
    if (setups.length === 0) return null;
    return {
      setups: setups.length,
      operations: setups.reduce((n, s) => n + s.operations.length, 0),
      models: this.project.models.length,
    };
  }

  /**
   * What would be affected by deleting this item.
   *
   * Deleting a tool used to be silent: the operations pointing at it stayed put
   * and simply stopped generating, which the user discovers later as a missing
   * toolpath. Naming the damage before it happens is the difference between a
   * decision and an accident.
   *
   * @returns { operations, models } — how many of each the deletion takes with
   *   it, or leaves unable to generate
   */
  usageOf(kind, id) {
    let operations = 0;
    if (kind === 'tool') {
      // both machines share the rack, so both are counted
      for (const setup of this.project.setups) {
        for (const op of setup.operations) if (op.toolId === id) operations++;
      }
    } else if (kind === 'setup') {
      operations = this.project.setups.find((s) => s.id === id)?.operations.length ?? 0;
    } else if (kind === 'model') {
      // a model is machined by every setup that does not name a subset
      for (const setup of this.project.setups) {
        if (setup.modelIds.length === 0 || setup.modelIds.includes(id)) {
          operations += setup.operations.length;
        }
      }
    } else if (kind === 'drawing') {
      for (const setup of this.project.setups) {
        for (const op of setup.operations) if (op.params?.drawingId === id) operations++;
      }
    }
    return { operations };
  }

  /** Delete whatever is selected (model/tool/setup/op) and clear selection. */
  removeSelected() {
    const sel = this.selection;
    if (!sel) return;
    const remove = {
      model: () => this.removeModel(sel.id),
      drawing: () => this.removeDrawing(sel.id),
      tool: () => this.removeTool(sel.id),
      setup: () => this.removeSetup(sel.id),
      op: () => this.removeOperation(sel.id),
      fixture: () => this.removeFixture(sel.id),
    }[sel.kind];
    remove?.();
    this.select(null, null);
  }

  // --- fixtures (clamps, jaws) ---

  addFixture(setup, fixture) {
    this.apply('add clamp',
      () => setup.fixtures.push(fixture),
      () => this.removeById(setup.fixtures, fixture.id));
  }

  removeFixture(id) {
    for (const setup of this.project.setups) {
      const index = (setup.fixtures ?? []).findIndex((f) => f.id === id);
      if (index < 0) continue;
      const fixture = setup.fixtures[index];
      this.apply('remove clamp',
        () => setup.fixtures.splice(index, 1),
        () => setup.fixtures.splice(index, 0, fixture));
      return;
    }
  }

  findFixture(id) {
    for (const setup of this.project.setups) {
      const found = (setup.fixtures ?? []).find((f) => f.id === id);
      if (found) return found;
    }
    return null;
  }

  // --- operations ---

  addOperation(setup, op) {
    this.apply('add operation',
      () => setup.operations.push(op),
      () => { this.removeById(setup.operations, op.id); this.toolpaths.delete(op.id); });
  }

  /** Add an operation at a position — used by duplicate, which lands next to its original. */
  insertOperation(setup, op, index) {
    const at = Math.max(0, Math.min(index, setup.operations.length));
    this.apply('add operation',
      () => setup.operations.splice(at, 0, op),
      () => { this.removeById(setup.operations, op.id); this.toolpaths.delete(op.id); });
  }

  /**
   * Move an operation within its setup.
   *
   * Operation order is machining order — rough before finish, drill before the
   * bore that opens it up. Without a way to reorder, getting a program right
   * meant deleting operations and rebuilding them in sequence.
   */
  reorderOperation(setup, from, to) {
    if (from === to) return;
    const move = (a, b) => {
      const [op] = setup.operations.splice(a, 1);
      setup.operations.splice(b, 0, op);
    };
    this.apply('reorder operation', () => move(from, to), () => move(to, from));
  }

  removeOperation(id) {
    for (const setup of this.project.setups) {
      const index = setup.operations.findIndex((o) => o.id === id);
      if (index < 0) continue;
      const op = setup.operations[index];
      const cl = this.toolpaths.get(id);
      this.apply('remove operation',
        () => { setup.operations.splice(index, 1); this.toolpaths.delete(id); },
        () => {
          // back where it was: operation order is machining order, so undo
          // putting it last would silently reorder the program
          setup.operations.splice(index, 0, op);
          if (cl) this.toolpaths.set(id, cl);
        });
      return;
    }
  }

  // --- which machine we are working on ---

  /**
   * Mill or lathe. Not a G-code flavour: the two have different operations,
   * different coordinates and a different idea of what the part is, so the app
   * switches wholesale rather than posting the same program two ways.
   */
  // A project file is not ours to trust either: an unreadable value here reads
  // downstream as "a machine with no setups, no strategies and no post", which
  // looks exactly like an empty project.
  get machine() {
    return Document.MACHINES.includes(this.project.machine) ? this.project.machine : 'mill';
  }

  /**
   * The two there are. Anything else is a typo, and one that hides: every
   * comparison downstream is `=== 'turn'` or `=== this.machine`, so a machine
   * called 'lathe' lists no setups, offers no strategies, posts with the mill's
   * post and hands a turning program to the milling simulator — all without an
   * error anywhere. It has to be refused where it arrives.
   */
  static MACHINES = ['mill', 'turn'];

  setMachine(machine) {
    if (!Document.MACHINES.includes(machine)) {
      throw new Error(`no such machine: ${machine} — it is `
        + `${Document.MACHINES.join(' or ')}`);
    }
    if (machine === this.machine) return;
    const before = this.machine;
    this.apply('switch machine',
      () => { this.project.machine = machine; },
      () => { this.project.machine = before; });
  }

  /**
   * The setups of the machine currently in front of you.
   *
   * A project may hold both — a shaft that is turned and then has a flat milled
   * on it is one part and two jobs — and everything downstream of this is
   * scoped by it: what the tree lists, what generates, what the backplot draws,
   * what gets posted. Nothing is hidden or lost by switching; the other
   * machine's setups are still there when you switch back.
   */
  setups() {
    return this.project.setups.filter((s) => (s.mode ?? 'mill') === this.machine);
  }

  /**
   * The machine record the current program will run on.
   *
   * Never null while there is a machine of this kind in the project: a dangling
   * id falls back to the first, because the whole value of these records is
   * that the travel limits and the rapid rate are *always* applied, and a null
   * here would silently switch both off.
   */
  machineRecord() {
    return activeMachine(this.project, this.machine);
  }

  setMachineRecord(id) {
    const before = { ...(this.project.machineIds ?? {}) };
    const after = { ...before, [this.machine]: id };
    this.apply('choose machine',
      () => { this.project.machineIds = after; },
      () => { this.project.machineIds = before; });
  }

  /**
   * How fast a rapid actually travels, for the clock and the estimates.
   *
   * Two rates, because a machine has two: Z is geared for a screw holding a
   * head up and is routinely half the XY rate (4000 against 6000 on the stock
   * LinuxCNC record, 2000 against 4000 on the router). `rapidFeedZ` was on the
   * machine, editable in the manager and printed in the panel, and read by
   * nothing — every retract was clocked at the XY rate, which under-estimated
   * the sample program's rapids by 19% on the mill and 39% on the router.
   */
  rapidFeed() {
    const machine = this.machineRecord();
    const xy = machine?.rapidFeed ?? this.project.simulation?.rapidFeed ?? 3000;
    return { xy, z: machine?.rapidFeedZ ?? xy };
  }

  addMachine(machine) {
    this.apply('add machine',
      () => this.project.machines.push(machine),
      () => this.removeById(this.project.machines, machine.id));
  }

  removeMachine(id) {
    const index = this.project.machines.findIndex((m) => m.id === id);
    if (index < 0) return;
    const machine = this.project.machines[index];
    const before = { ...(this.project.machineIds ?? {}) };
    // whatever pointed at it has to point somewhere else, or the project comes
    // back with no machine and no way to say which one it lost
    const after = Object.fromEntries(Object.entries(before)
      .map(([kind, value]) => [kind, value === id ? null : value]));
    this.apply('remove machine',
      () => {
        this.project.machines.splice(index, 1);
        this.project.machineIds = after;
      },
      () => {
        this.project.machines.splice(index, 0, machine);
        this.project.machineIds = before;
      });
  }

  /**
   * The post that will actually be used — never one belonging to the other
   * machine.
   *
   * Switching machines re-points the post, but that is not the only way the two
   * can part company: a project file written by an older version, an autosave
   * caught mid-switch, or anything that sets the field directly. Posting a
   * milling program through the lathe dialect does not fail — it writes a file
   * with no Y axis and no arcs in it, which reads like a G-code bug and is not
   * one. So the pairing is enforced where the program is built rather than only
   * where the machine is chosen.
   */
  postId() {
    const machine = this.machine;
    // The machine owns the dialect. `project.post` is what a pre-machines file
    // carries and what a machine with a nonsense post falls back through.
    const candidates = [this.machineRecord()?.post, this.project.post];
    for (const id of candidates) {
      if (id && postsFor(machine).includes(id)) return id;
    }
    return defaultPostFor(machine);
  }

  /** Every operation on the current machine, in program order. */
  *allOperations() {
    for (const setup of this.setups()) {
      for (const op of setup.operations) yield { setup, op };
    }
  }

  /**
   * Generated toolpaths for enabled operations only, in program order.
   *
   * A disabled operation keeps its toolpath so re-enabling it is instant, but
   * nothing downstream — backplot, time estimate, G-code, simulation — may see
   * it. Everything that consumes toolpaths goes through here so "disabled"
   * means the same thing everywhere.
   */
  enabledToolpaths() {
    const out = [];
    for (const { op } of this.allOperations()) {
      const cl = this.toolpaths.get(op.id);
      if (op.enabled && cl) out.push(cl);
    }
    return out;
  }

  /** The subset of those the viewport should draw. */
  visibleToolpaths() {
    const out = [];
    for (const { op } of this.allOperations()) {
      const cl = this.toolpaths.get(op.id);
      if (op.enabled && cl && !this.hiddenPaths.has(op.id)) out.push(cl);
    }
    return out;
  }

  /** What is currently drawable, as a string — changes when a toggle changes. */
  toolpathSignature() {
    const parts = [];
    for (const { op } of this.allOperations()) {
      if (!this.toolpaths.has(op.id)) continue;
      parts.push(`${op.id}:${op.enabled ? 1 : 0}${this.hiddenPaths.has(op.id) ? 'h' : ''}`);
    }
    return parts.join(',');
  }

  isPathVisible(opId) { return !this.hiddenPaths.has(opId); }

  /**
   * Show or hide one operation's path. Not undoable on purpose: looking at
   * something is not an edit, and filling the undo stack with "hid a path"
   * would bury the edits that matter.
   */
  setPathVisible(opId, visible) {
    if (visible) this.hiddenPaths.delete(opId); else this.hiddenPaths.add(opId);
    this.emitChange('visibility');
  }

  /** Show only this one. Called again on the same op, show everything again. */
  soloPath(opId) {
    const ops = [...this.allOperations()].map(({ op }) => op.id);
    const alreadySolo = ops.every((id) => (id === opId) === !this.hiddenPaths.has(id));
    this.hiddenPaths = alreadySolo ? new Set() : new Set(ops.filter((id) => id !== opId));
    this.emitChange('visibility');
  }

  showAllPaths() {
    this.hiddenPaths.clear();
    this.emitChange('visibility');
  }

  /**
   * The setup being worked on: whatever the selection is inside, and the first
   * one otherwise.
   *
   * "The first setup" is right until a project has two, and then it is wrong
   * everywhere at once — selecting an operation in the second setup showed the
   * *first* setup's billet, clamps and datum in the viewport, and simulating
   * ran the first setup's program, while the panel beside both edited the
   * second.
   */
  activeSetup() {
    const setups = this.setups();
    const sel = this.selection;
    if (sel?.kind === 'setup') {
      const found = setups.find((s) => s.id === sel.id);
      if (found) return found;
    }
    if (sel?.kind === 'op') {
      const owner = this.findSetupOf(sel.id);
      if (owner && setups.includes(owner)) return owner;
    }
    if (sel?.kind === 'fixture') {
      const owner = setups.find((s) => (s.fixtures ?? []).some((f) => f.id === sel.id));
      if (owner) return owner;
    }
    return setups[0] ?? null;
  }

  findSetupOf(opId) {
    return this.project.setups.find((s) => s.operations.some((o) => o.id === opId)) ?? null;
  }

  /** Generic property edit on any schema object, undoable. */
  updateItem(item, patch, label = 'edit') {
    const before = {};
    for (const key of Object.keys(patch)) before[key] = item[key];
    this.apply(label,
      () => Object.assign(item, patch),
      () => Object.assign(item, before));
  }

  select(kind, id) {
    this.selection = id == null ? null : { kind, id };
    this.emitChange('selection');
  }

  findSelected() {
    const sel = this.selection;
    if (!sel) return null;
    const pools = {
      model: this.project.models,
      drawing: this.project.drawings,
      tool: this.project.tools,
      setup: this.project.setups,
    };
    if (sel.kind === 'op') {
      for (const s of this.project.setups) {
        const op = s.operations.find((o) => o.id === sel.id);
        if (op) return op;
      }
      return null;
    }
    if (sel.kind === 'fixture') return this.findFixture(sel.id);
    return pools[sel.kind]?.find((x) => x.id === sel.id) ?? null;
  }

  removeById(array, id) {
    const i = array.findIndex((x) => x.id === id);
    if (i >= 0) array.splice(i, 1);
  }

  // --- persistence ---

  /** The whole document as a `.cncam` file: project plus the geometry it needs. */
  toJSON() { return serializeProject(this.project, this.meshes); }

  /**
   * Replace everything with a restored project (autosave or file). Not
   * undoable: undoing your way back into a project you just closed would be
   * more confusing than helpful, so the history starts fresh.
   */
  restore(project, meshes = new Map()) {
    this.project = project;
    this.meshes = new Map(meshes);
    this.toolpaths.clear();
    this.fingerprints.clear();
    this.undoStack = new UndoStack();
    this.selection = null;
    this.emitChange('load');
  }

  /** Throw the project away and start over. */
  clear() {
    this.restore(createProject());
  }

  /**
   * Load a project file. Geometry saved with it comes back with it; a file from
   * before geometry was embedded restores its machining intent and reports how
   * many models still need re-importing.
   *
   * @returns { models, restored } — how many models the project has, and how
   *   many of them arrived with their geometry
   */
  loadJSON(json) {
    const project = deserializeProject(json);
    const meshes = extractMeshes(project);
    for (const [id, mesh] of meshes) meshes.set(id, computeNormals(mesh));
    this.restore(project, meshes);
    return { models: project.models.length, restored: meshes.size };
  }
}
