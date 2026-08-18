import { test, assert } from './runner.js';
import { UndoStack } from '../doc/undo.js';
import { Document } from '../doc/document.js';
import { createTool, createModel, createSetup, createOperation, serializeProject, deserializeProject } from '../doc/schema.js';

test('undo stack do/undo/redo', () => {
  let value = 0;
  const stack = new UndoStack();
  stack.push({ label: 'inc', do: () => value++, undo: () => value-- });
  assert.eq(value, 1);
  stack.undo();
  assert.eq(value, 0);
  stack.redo();
  assert.eq(value, 1);
});

test('new commands clear the redo branch', () => {
  let value = 0;
  const stack = new UndoStack();
  const inc = () => ({ label: 'inc', do: () => value++, undo: () => value-- });
  stack.push(inc());
  stack.undo();
  stack.push(inc());
  assert.eq(stack.canRedo, false);
});

test('document add/remove tool is undoable', () => {
  const doc = new Document();
  doc.addTool(createTool());
  assert.eq(doc.project.tools.length, 1);
  doc.undo();
  assert.eq(doc.project.tools.length, 0);
  doc.redo();
  assert.eq(doc.project.tools.length, 1);
});

test('updateItem patches and restores', () => {
  const doc = new Document();
  const tool = createTool();
  doc.addTool(tool);
  doc.updateItem(tool, { diameter: 10 });
  assert.eq(tool.diameter, 10);
  doc.undo();
  assert.eq(tool.diameter, 6);
});

test('removeSetup drops its operations toolpaths, undo restores the setup', () => {
  const doc = new Document();
  const setup = createSetup();
  const op = createOperation();
  doc.addSetup(setup);
  doc.addOperation(setup, op);
  doc.toolpaths.set(op.id, { count: 0 });
  doc.removeSetup(setup.id);
  assert.eq(doc.project.setups.length, 0);
  assert.eq(doc.toolpaths.has(op.id), false, 'toolpath dropped');
  doc.undo();
  assert.eq(doc.project.setups.length, 1);
  assert.eq(doc.project.setups[0].operations.length, 1, 'ops ride along');
  // and so do the paths. removeOperation already restores the one it dropped;
  // a setup's worth came back as rows with nothing generated, which is a whole
  // job to compute again for a keystroke that was undone.
  assert.ok(doc.toolpaths.has(op.id), 'the generated path comes back with it');
});

// --- what happens to the job when the part it was written for is replaced ---

const withGeometry = (doc, name = 'part') => {
  const model = createModel(name);
  doc.addModel(model, { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) });
  return model;
};

test('clearing the setups is one undo step, and the paths come back with them', () => {
  const doc = new Document();
  const ops = [];
  for (const mode of ['mill', 'turn']) {
    const setup = createSetup(`Setup ${mode}`, mode);
    doc.addSetup(setup);
    for (let i = 0; i < 2; i++) {
      const op = createOperation();
      doc.addOperation(setup, op);
      doc.toolpaths.set(op.id, { count: 0 });
      ops.push(op);
    }
  }

  const cleared = doc.clearSetups();
  assert.eq(`${cleared.setups}/${cleared.operations}`, '2/4', 'both machines, not just this one');
  assert.eq(doc.project.setups.length, 0);
  assert.eq(doc.toolpaths.size, 0, 'their toolpaths went too');

  // one Ctrl+Z, because it was one decision — four would leave the user
  // stepping back through half a job
  doc.undo();
  assert.eq(doc.project.setups.length, 2);
  assert.eq(doc.project.setups.map((s) => s.operations.length).join(), '2,2', 'ops ride along');
  assert.eq(doc.toolpaths.size, 4, 'and so does everything that was generated');
  assert.eq(doc.project.setups[0].name, 'Setup mill', 'in the order they were in');

  const empty = new Document();
  const nothing = empty.clearSetups();
  assert.eq(`${nothing.setups}/${nothing.operations}`, '0/0', 'nothing to clear reports nothing');
  assert.eq(empty.undoStack.canUndo, false, 'and puts no empty step on the undo stack');
});

test('an import only offers to clear a job that is built on geometry', () => {
  const doc = new Document();
  assert.eq(doc.strandedJob(), null, 'an empty project has nothing to strand');

  withGeometry(doc);
  assert.eq(doc.strandedJob(), null, 'nor has a model with no job on it');

  const setup = createSetup();
  doc.addSetup(setup);
  doc.addOperation(setup, createOperation());
  assert.eq(JSON.stringify(doc.strandedJob()), '{"setups":1,"operations":1,"models":1}');
});

test('a project restored without its meshes is never asked to throw its job away', () => {
  // The one case that must not prompt. This project came back from an autosave
  // that could not carry its geometry, the setups and operations are the part
  // that survived, and the import about to happen is the repair.
  const doc = new Document();
  const setup = createSetup();
  doc.addSetup(setup);
  doc.addOperation(setup, createOperation());
  doc.project.models.push(createModel('re-import me'));   // a model with no mesh
  assert.eq(doc.strandedJob(), null);

  withGeometry(doc, 'and now it has one');
  assert.eq(doc.strandedJob()?.models, 2, 'once geometry is back, so is the offer');
});

test('undo puts a deleted item back where it was, not at the end', () => {
  // The list order is what is read: tools are drawn in it and operations are
  // machined in it. removeOperation was careful about this and the others were
  // not — delete the middle tool of three, undo, and the rack came back in a
  // different order from the one the project had a moment ago.
  const doc = new Document();
  const names = ['first', 'second', 'third'];
  const tools = names.map((name, i) => {
    const tool = createTool();
    tool.name = name;
    tool.number = i + 1;
    doc.addTool(tool);
    return tool;
  });
  doc.removeTool(tools[1].id);
  doc.undo();
  assert.eq(doc.project.tools.map((t) => t.name).join(), names.join(), 'tools');

  const models = names.map((name) => {
    const model = createModel(name);
    doc.addModel(model, { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) });
    return model;
  });
  doc.removeModel(models[0].id);
  doc.undo();
  assert.eq(doc.project.models.map((m) => m.name).join(), names.join(), 'models');
  assert.ok(doc.meshes.has(models[0].id), 'and its geometry with it');
});

test('removeSelected handles every kind and clears selection', () => {
  const doc = new Document();
  const tool = createTool();
  const setup = createSetup();
  const op = createOperation();
  doc.addTool(tool);
  doc.addSetup(setup);
  doc.addOperation(setup, op);

  doc.select('op', op.id);
  doc.removeSelected();
  assert.eq(setup.operations.length, 0);
  assert.eq(doc.selection, null);

  doc.select('tool', tool.id);
  doc.removeSelected();
  assert.eq(doc.project.tools.length, 0);

  doc.select('setup', setup.id);
  doc.removeSelected();
  assert.eq(doc.project.setups.length, 0);

  doc.removeSelected(); // nothing selected — must not throw
});

test('project JSON round-trips', () => {
  const doc = new Document();
  doc.addTool(createTool());
  doc.addModel(createModel('part', 'part.stl'), { positions: new Float32Array(), indices: new Uint32Array() });
  const p = deserializeProject(serializeProject(doc.project));
  assert.eq(p.tools.length, 1);
  assert.eq(p.models[0].name, 'part');
});

test('deserialize rejects future versions', () => {
  assert.throws(() => deserializeProject('{"version": 999}'));
});

// --- mill and lathe are two machines, not two ways of posting ---

/** A project with one milling setup and one turning setup, each with an op. */
function twoMachines() {
  const doc = new Document();
  const mill = createSetup('Mill 1');
  mill.mode = 'mill';
  mill.operations.push({ ...createOperation('contour2d'), name: 'outline' });
  const lathe = createSetup('Lathe 1');
  lathe.mode = 'turn';
  lathe.operations.push({ ...createOperation('turnRough'), name: 'rough' });
  doc.project.setups.push(mill, lathe);
  return { doc, mill, lathe };
}

test('the machine scopes what the app is looking at, and loses nothing', () => {
  const { doc } = twoMachines();
  assert.eq(doc.machine, 'mill', 'a new project is a milling project');
  assert.eq(doc.setups().length, 1);
  assert.eq([...doc.allOperations()].map(({ op }) => op.name).join(), 'outline');

  doc.setMachine('turn');
  assert.eq(doc.setups().length, 1);
  assert.eq([...doc.allOperations()].map(({ op }) => op.name).join(), 'rough');
  // and the milling work is still there, not deleted by looking away from it
  assert.eq(doc.project.setups.length, 2);

  doc.undo();
  assert.eq(doc.machine, 'mill', 'switching machines is an edit like any other');
});

test('a toolpath from the other machine is not drawn or posted', () => {
  const { doc, mill, lathe } = twoMachines();
  const fake = { version: 0, moves: new Float32Array(8), count: 1, events: [], notes: [] };
  doc.toolpaths.set(mill.operations[0].id, fake);
  doc.toolpaths.set(lathe.operations[0].id, fake);

  assert.eq(doc.enabledToolpaths().length, 1, 'only the mill program while on the mill');
  doc.setMachine('turn');
  assert.eq(doc.enabledToolpaths().length, 1, 'and only the lathe program on the lathe');
});

test('a tool is shared by both machines, so deleting it says so', () => {
  const { doc, mill, lathe } = twoMachines();
  const tool = createTool();
  doc.project.tools.push(tool);
  mill.operations[0].toolId = tool.id;
  lathe.operations[0].toolId = tool.id;
  assert.eq(doc.usageOf('tool', tool.id).operations, 2,
    'both machines are counted, whichever one you are standing at');
});

test('a project remembers which machine it was left on', () => {
  const { doc } = twoMachines();
  doc.setMachine('turn');
  const back = deserializeProject(serializeProject(doc.project, new Map()));
  assert.eq(back.machine, 'turn');
  // and a project saved before there were machines opens as a mill
  const old = JSON.parse(serializeProject(doc.project, new Map()));
  delete old.machine;
  for (const s of old.setups) delete s.mode;
  const legacy = deserializeProject(JSON.stringify(old));
  assert.eq(legacy.machine, 'mill');
  assert.ok(legacy.setups.every((s) => s.mode === 'mill'), 'and all its setups are milling setups');
});
