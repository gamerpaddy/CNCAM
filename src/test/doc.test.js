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

// One gesture, one undo. Assigning a cutter writes two things — the tool, and
// the stepping that was the old cutter's — and pushing them separately made a
// single Ctrl+Z leave the operation holding the new tool with the old tool's
// stepping: exactly the state the action exists to prevent.
test('a group is one step on the stack, undone and redone together', () => {
  const stack = new UndoStack();
  const seen = [];
  const step = (name) => ({
    label: name,
    do: () => seen.push(`+${name}`),
    undo: () => seen.push(`-${name}`),
  });
  stack.group('assign tool', () => { stack.push(step('tool')); stack.push(step('stepping')); });
  assert.eq(seen.join(' '), '+tool +stepping', 'both ran, in the order they were pushed');
  assert.eq(stack.done.length, 1, 'and they are one entry');
  assert.eq(stack.undoLabel, 'assign tool', 'labelled by the gesture, not by its halves');

  seen.length = 0;
  stack.undo();
  assert.eq(seen.join(' '), '-stepping -tool', 'undone in reverse');
  assert.eq(stack.canUndo, false, 'one press was the whole of it');
  seen.length = 0;
  stack.redo();
  assert.eq(seen.join(' '), '+tool +stepping', 'and redone forwards');

  // A group holding one command records that command, and one that collects
  // nothing records nothing — an action that decided there was nothing to do
  // must not leave a Ctrl+Z that does nothing.
  const lone = new UndoStack();
  lone.group('one', () => lone.push(step('only')));
  assert.eq(lone.done.length, 1);
  assert.eq(lone.undoLabel, 'only', 'a single command keeps its own label');
  lone.group('nothing', () => {});
  assert.eq(lone.done.length, 1, 'an empty group is not a step');

  // and it clears the redo branch like any other new command
  lone.undo();
  assert.eq(lone.canRedo, true);
  lone.group('later', () => lone.push(step('later')));
  assert.eq(lone.canRedo, false, 'a group starts a new branch');
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

// --- a project file is not ours to trust ---

/** A saved project with one of everything, as the text a file would hold. */
function fullProject() {
  const doc = new Document();
  const tool = createTool('flat');
  doc.addTool(tool);
  const setup = createSetup('Setup 1');
  doc.addSetup(setup);
  const op = createOperation('contour2d');
  op.toolId = tool.id;
  doc.addOperation(setup, op);
  return JSON.parse(serializeProject(doc.project));
}

test('a project whose lists are not lists, or hold things that are not records, still opens', () => {
  // Each of these used to fail with a raw TypeError ("Cannot read properties of
  // null (reading 'regions')") — or, worse, load and take the tree or Generate
  // down afterwards, and then be restored by the autosave on every reload.
  const damage = [
    (p) => { p.setups[0].operations[0] = null; },
    (p) => { p.setups[0].operations = 'x'; },
    (p) => { p.setups[0].operations.push(7, 'a'); },
    (p) => { p.setups[0].fixtures = 3; },
    (p) => { p.setups[0].modelIds = 'abc'; },
    (p) => { p.setups[0] = 'x'; },
    (p) => { p.setups = null; },
    (p) => { p.tools[0] = null; },
    (p) => { p.tools = {}; },
    (p) => { p.models = 5; },
    (p) => { p.drawings = 'x'; },
    (p) => { p.machines = [null, 3]; },
    (p) => { p.setups[0].operations[0].regions.include = [null]; },
    (p) => { p.setups[0].operations[0].regions = 4; },
    (p) => { p.setups[0].orientation.rotationDeg = 7; },
    (p) => { p.setups[0].stock.margin = 'x'; },
  ];
  for (const [i, hurt] of damage.entries()) {
    const p = fullProject();
    hurt(p);
    const doc = new Document();
    const { repairs } = doc.loadJSON(JSON.stringify(p));
    assert.ok(Array.isArray(repairs), `case ${i}: the repairs are reported`);
    for (const s of doc.project.setups) {
      assert.ok(Array.isArray(s.operations) && Array.isArray(s.fixtures) && Array.isArray(s.modelIds),
        `case ${i}: a setup's lists are lists`);
      assert.ok(s.operations.every((o) => o.params && o.regions && Array.isArray(o.regions.include)),
        `case ${i}: every operation has its settings and picks`);
    }
    // and everything that reads a loaded project afterwards runs
    doc.setups(); doc.activeSetup(); doc.strandedJob(); doc.machineRecord(); doc.postId();
  }
});

test('a number that went missing in a file is reset to the default, and said', () => {
  // JSON writes NaN as null: a tool with a null diameter, an operation with a
  // null stepdown. Both loaded, and both put NaN into everything downstream.
  const p = fullProject();
  p.tools[0].diameter = null;
  p.setups[0].operations[0].params.stepdown = 'deep';
  p.setups[0].operations[0].params.feedCut = 'fast';
  const doc = new Document();
  const { repairs } = doc.loadJSON(JSON.stringify(p));
  assert.eq(doc.project.tools[0].diameter, 6, 'the default cutter width');
  const op = doc.project.setups[0].operations[0];
  assert.eq(op.params.stepdown, 2, 'the default stepdown');
  assert.eq(op.params.feedCut, null, 'a feed that is no number goes back to inheriting the tool\'s');
  const said = repairs.join(' | ');
  assert.ok(/diameter/.test(said) && /stepdown/.test(said) && /feedCut/.test(said),
    `each change is named: ${said}`);
});

test('ids are strings and unique after loading, and an unknown operation type is dropped', () => {
  const p = fullProject();
  const twin = JSON.parse(JSON.stringify(p.setups[0].operations[0]));
  p.setups[0].operations.push(twin);                          // the same id twice
  p.setups[0].operations.push({ ...twin, id: 'ok', type: 'laser' });
  p.tools[0].id = 12;
  const doc = new Document();
  const { repairs } = doc.loadJSON(JSON.stringify(p));
  const ops = doc.project.setups[0].operations;
  assert.eq(ops.length, 2, 'the unknown type is dropped, the twin kept');
  assert.ok(ops[0].id !== ops[1].id, 'and given an id of its own');
  assert.eq(typeof doc.project.tools[0].id, 'string');
  assert.ok(repairs.some((r) => /laser/.test(r)), 'the dropped operation is named');
});

test('a file that is not a project is refused in words, not with a TypeError', () => {
  for (const [text, fragment] of [
    ['not json at all', /not valid JSON/],
    ['null', /not a project/],
    ['[1,2]', /not a project/],
    ['{"name":"x"}', /does not look like a CNCAM project/],
    ['{"version":"x"}', /does not look like a CNCAM project/],
    ['{"version":999}', /Unsupported project version: 999/],
  ]) {
    let message = '';
    try { deserializeProject(text); } catch (err) { message = err.message; }
    assert.ok(fragment.test(message), `${text}: "${message}"`);
  }
});

test('saved geometry that cannot be a mesh is dropped with a reason, the project kept', () => {
  const doc = new Document();
  const model = createModel('part', 'part.stl');
  doc.addModel(model, {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  });
  const p = JSON.parse(doc.toJSON());
  // a triangle naming a vertex that is not there
  const bad = JSON.parse(JSON.stringify(p));
  // btoa, not Buffer: this file runs in the browser's test page as well as in node
  bad.models[0].geometry.indices = btoa(String.fromCharCode(...new Uint8Array(new Uint32Array([0, 1, 9]).buffer)));
  let loaded = new Document().loadJSON(JSON.stringify(bad));
  assert.eq(loaded.restored, 0, 'no geometry came back');
  assert.ok(loaded.repairs.some((r) => /damaged/.test(r)), 'and it says why');
  // base64 that is not base64
  const garbage = JSON.parse(JSON.stringify(p));
  garbage.models[0].geometry.positions = '!!!';
  loaded = new Document().loadJSON(JSON.stringify(garbage));
  assert.eq(loaded.models, 1, 'the model is still in the project');
  assert.ok(loaded.repairs.some((r) => /decoded/.test(r)), 'with the reason');
  // and the good one is untouched
  assert.eq(new Document().loadJSON(JSON.stringify(p)).restored, 1);
});
