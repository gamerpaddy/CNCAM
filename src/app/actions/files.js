// Getting work in and out: models, projects and tool libraries.
//
// Import is the only place that knows about file formats; everything after it
// works on meshes. Clearing and opening both throw the current document away,
// so both ask first when there is something to lose.

import { createModel, createDrawing } from '../../doc/schema.js';
import { plural } from '../../engine/text.js';
import { openFile, saveFile, ACCEPT } from '../../io/files.js';
import { parseSTL } from '../../io/stl.js';
import { parseOBJ } from '../../io/obj.js';
import { parseDXF, totalLength } from '../../io/dxf.js';
import { importCad, kindFromName } from '../../io/step.js';
import { meshFromSoup, computeNormals, dropDegenerate } from '../../geom/mesh.js';
import { clearSaved } from '../../doc/autosave.js';
import { invalidateFaces } from '../regions-ui.js';
import { openToolPicker } from '../tool-picker.js';
import {
  toolFromPreset, serializeLibrary, deserializeLibrary, saveUserTool,
} from '../../doc/tool-library.js';
import { openToolWizard } from '../tool-wizard.js';
import { describeTool } from '../tool-shape.js';
import { toolNumberClashes } from '../op-status.js';

export function makeFileActions(ctx, program) {
  const { doc } = ctx;

  /**
   * @param file an already-read { name, buffer } — how the harness and any
   *   future drop target get in. The toolbar passes nothing and gets the dialog.
   */
  async function openModel(file = null) {
    // eslint-disable-next-line no-param-reassign
    file ??= await openFile(ACCEPT.model);
    if (!file) return;
    ctx.ui.setStatus(`Importing ${file.name}…`);
    try {
      // A DXF is not a solid and never becomes one. It is curves, and it comes
      // in as a drawing to be placed on the stock and engraved — which is the
      // one thing a solid cannot give you, because a logo or a part number is
      // not a feature of the part.
      if (file.name.toLowerCase().endsWith('.dxf')) return importDrawing(file);
      const parts = await importModelFile(file);
      // Measured before the new part lands, and asked about after it has: the
      // counts have to be of the job being replaced, but a parse that throws
      // must not have cost anybody their setups on the way to failing.
      const stranded = doc.strandedJob();
      for (const { name, mesh } of parts) {
        const model = createModel(name, file.name);
        doc.addModel(model, mesh);
      }
      ctx.viewport.frameAll();
      ctx.ui.setStatus(`Imported ${file.name}${clearStrandedJob(stranded)}`);
    } catch (err) {
      console.error(err);
      ctx.ui.setStatus(`Import failed: ${err.message}`, true);
    }
    return undefined;
  }

  /**
   * Offer to start the job again, now that the part it was written for has been
   * replaced.
   *
   * Loading a model into a project that already has one is nearly always the
   * next part rather than the second half of an assembly, and the setups do not
   * come with it: the stock is measured off geometry that has gone, the datum
   * is a corner of that stock, and every operation's heights and picked faces
   * were chosen on a part that is no longer in front of you. None of that
   * announces itself — it generates, it posts, and it is wrong. So it is asked
   * about at the one moment the answer is obvious, rather than found later.
   *
   * Asked, not done: an assembly is a real thing, and Cancel leaves the project
   * exactly as it was.
   *
   * @returns the tail of the import's status line — '' when nothing was cleared
   */
  function clearStrandedJob(stranded) {
    if (!stranded) return '';
    const ok = confirm(
      `This project already holds ${jobSize(stranded)}, built on the model that was in it.\n\n`
      + 'Clear them and start the job again for the part just imported?\n\n'
      + 'Their stock, datum and picked faces still belong to the old geometry. '
      + 'Cancel keeps them; clearing is undoable.');
    if (!ok) return '';

    if (ctx.simulation) program.closeSimulation();
    const cleared = doc.clearSetups();
    // whatever the tree had selected may have been one of the rows that went
    if (['setup', 'op', 'fixture'].includes(doc.selection?.kind)) doc.select(null, null);
    program.refreshGcodePreview(false);

    // The old models are still here, and a setup with an empty `modelIds`
    // machines *every* model in the project — so the next setup sizes its stock
    // across the part that has just been replaced as well as the new one. That
    // is said rather than done: deleting somebody's geometry is a bigger answer
    // than was asked for. See actions/setup-space.js setupModelIds.
    return ` — cleared ${jobSize(cleared)}, Ctrl+Z brings them back.`
      + ` The ${plural(stranded.models, 'model')} it was built on are still in the project`
      + ' — delete them, or the next setup sizes its stock over those too';
  }

  /**
   * How much job that is, said once — the question and the report of what it
   * did have to describe the same thing, and a setup with nothing in it yet is
   * not "and 0 operation(s)".
   */
  function jobSize({ setups, operations }) {
    return `${plural(setups, 'setup')}${operations ? ` and ${plural(operations, 'operation')}` : ''}`;
  }

  /**
   * Bring a DXF in as a drawing on the stock.
   *
   * Reported with its size and how much line is in it, because "imported 412
   * paths" tells you nothing about whether the drawing is the size you thought
   * — and a drawing exported in inches from a package that did not write
   * $INSUNITS is 25 times too big, which is a thing you want to hear about now
   * rather than at the machine.
   */
  function importDrawing(file) {
    const text = new TextDecoder().decode(file.buffer);
    const { paths, bounds, skipped } = parseDXF(text);
    if (paths.length === 0) {
      return ctx.ui.setStatus(
        `${file.name} has no 2D geometry this can read`
        + (Object.keys(skipped).length ? ` (skipped ${describeSkipped(skipped)})` : ''), true);
    }
    const name = file.name.replace(/\.[^.]+$/, '');
    const drawing = createDrawing(name, file.name, paths, bounds);
    doc.addDrawing(drawing);
    doc.select('drawing', drawing.id);

    const size = bounds
      ? `${(bounds.max[0] - bounds.min[0]).toFixed(1)} × ${(bounds.max[1] - bounds.min[1]).toFixed(1)}mm`
      : 'no extent';
    const length = (totalLength(paths) / 1000).toFixed(2);
    const note = Object.keys(skipped).length ? ` — skipped ${describeSkipped(skipped)}` : '';
    ctx.ui.setStatus(
      `${name}: ${plural(paths.length, 'path')}, ${size}, ${length}m of line${note}`,
      Object.keys(skipped).length > 0);
    return undefined;
  }

  function describeSkipped(skipped) {
    return Object.entries(skipped).map(([type, n]) => `${n}× ${type}`).join(', ');
  }

  async function importModelFile(file) {
    const ext = file.name.toLowerCase().split('.').pop();
    const baseName = file.name.replace(/\.[^.]+$/, '');

    if (ext === 'stl') {
      return [{ name: baseName, mesh: meshFromSoup(parseSTL(file.buffer)) }];
    }
    if (ext === 'obj') {
      const text = new TextDecoder().decode(file.buffer);
      return [{ name: baseName, mesh: meshFromSoup(parseOBJ(text)) }];
    }
    const kind = kindFromName(file.name);
    if (kind) {
      const meshes = await importCad(file.buffer, kind);
      return meshes.map((m, i) => ({
        name: meshes.length > 1 ? `${baseName} (${m.name || i + 1})` : baseName,
        mesh: m.normals
          ? { positions: m.positions, indices: m.indices, normals: m.normals, faceRanges: m.faceRanges }
          : computeNormals(dropDegenerate({ positions: m.positions, indices: m.indices })),
      }));
    }
    throw new Error(`unsupported format: .${ext}`);
  }

  async function saveProject() {
    await saveFile(`${doc.project.name}.cncam`, doc.toJSON(), ACCEPT.project);
    ctx.ui.setStatus('Project saved');
  }

  /**
   * Throw away the project and start clean. Destructive and easy to hit by
   * accident next to the other toolbar buttons, so it asks first — unless
   * there is nothing to lose.
   */

  async function openProject() {
    const file = await openFile(ACCEPT.project);
    if (!file) return;
    try {
      const { models, restored } = doc.loadJSON(new TextDecoder().decode(file.buffer));
      ctx.viewport.frameAll();
      const missing = models - restored;
      ctx.ui.setStatus(missing
        ? `Project loaded — ${missing} of ${plural(models, 'model')} saved without geometry, re-import them`
        : 'Project loaded');
    } catch (err) {
      ctx.ui.setStatus(`Open failed: ${err.message}`, true);
    }
  }

  /**
   * Throw away the project and start clean. Destructive and easy to hit by
   * accident next to the other toolbar buttons, so it asks first — unless
   * there is nothing to lose.
   */
  function clearProject() {
    const { models, tools, setups } = doc.project;
    const hasWork = models.length || tools.length || setups.length;
    if (hasWork && !confirm('Clear the project? Models, tools, setups and operations will be discarded.')) {
      return;
    }
    if (ctx.simulation) program.closeSimulation();
    doc.clear();
    clearSaved();
    invalidateFaces();
    ctx.viewport.setToolpaths(null);
    ctx.viewport.setMarker(null);
    program.refreshGcodePreview(false);
    ctx.ui.setStatus('Project cleared');
  }

  /** Next free tool number, so library adds do not collide with existing tools. */
  function nextToolNumber() {
    const used = new Set(doc.project.tools.map((t) => t.number));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  function addToolsFromLibrary() {
    openToolPicker({
      machine: doc.machine,
      onAdd: (presets) => {
        for (const preset of presets) doc.addTool(toolFromPreset(preset, nextToolNumber()));
        ctx.ui.setStatus(`Added ${plural(presets.length, 'tool')} from the library`);
      },
      onNew: newTool,
      onImport: importTools,
      onExport: exportTools,
      // The catalogue buttons read and write their own files: what goes in one
      // is a catalogue, and only the dialog knows which drawer is open.
      files: {
        open: () => openFile(ACCEPT.toolLibrary),
        save: (name, text) => saveFile(name, text, ACCEPT.toolLibrary),
      },
      onStatus: (message, isError = false) => ctx.ui.setStatus(message, isError),
    });
  }

  /**
   * Build a cutter from scratch.
   *
   * The old affordance was "+ Blank tool", which added a Ø6 flat end mill and
   * left you to correct eighteen fields — including the ones that do not apply
   * to the cutter you wanted. The wizard asks for the shape first, because the
   * shape is what decides which of the other questions exist.
   */
  function newTool() {
    openToolWizard({
      machine: doc.machine,
      number: nextToolNumber(),
      onCreate: (tool) => {
        doc.addTool(tool);
        doc.select('tool', tool.id);
        ctx.ui.setStatus(`Added T${tool.number} ${tool.name} — ${describeTool(tool)}`);
      },
      onSaveToLibrary: (tool, catalogId) => saveUserTool(tool, catalogId),
    });
  }

  /**
   * The same dialog, on a tool that already exists.
   *
   * The properties panel can edit every field, and that is the flat form of
   * eighteen boxes the wizard was built to replace — no drawing, no warnings,
   * and no sense of which of them this family even has. The difference between
   * creating and editing is one seeded draft, so there is no reason for the
   * good version to be reachable only once per tool.
   */
  function editTool(tool) {
    if (!tool) return;
    openToolWizard({
      machine: doc.machine,
      number: tool.number,
      tool,
      onCreate: (next) => {
        // the identity stays with the tool: the operations point at its id, and
        // the program calls it by its number
        const { id, number, ...geometry } = next;
        doc.updateItem(tool, geometry, `edit ${tool.name}`);
        ctx.ui.setStatus(`T${tool.number} is now ${next.name} — ${describeTool(next)}`);
      },
    });
  }

  /** Keep a project's tool for other projects: it joins "My tools" in the picker. */
  function saveToolToLibrary(tool) {
    if (!tool) return;
    const saved = saveUserTool(tool);
    ctx.ui.setStatus(saved
      ? `${tool.name} saved to My tools — it is in the Tool Library dialog now`
      : 'Could not save to the library (browser storage is unavailable)', !saved);
  }

  async function importTools() {
    const file = await openFile(ACCEPT.toolLibrary);
    if (!file) return;
    try {
      const tools = deserializeLibrary(new TextDecoder().decode(file.buffer));
      for (const tool of tools) doc.addTool(tool);
      // A library carries the numbers the shop gave it, and those are worth
      // keeping — but the project already had some, and two cutters on one T
      // number is a wrong-tool crash the file cannot express. Renumbering
      // behind the user's back would be a third answer nobody asked for, so
      // the clash is named at the moment it is made. See op-status.js.
      const clashes = [...toolNumberClashes(doc.project).keys()];
      ctx.ui.setStatus(clashes.length
        ? `Imported ${plural(tools.length, 'tool')} from ${file.name} — but T${clashes.join(', T')} `
          + 'now name more than one cutter each. Renumber them before generating.'
        : `Imported ${plural(tools.length, 'tool')} from ${file.name}`, clashes.length > 0);
    } catch (err) {
      ctx.ui.setStatus(`Tool import failed: ${err.message}`, true);
    }
  }

  async function exportTools() {
    if (doc.project.tools.length === 0) {
      return ctx.ui.setStatus('No tools to export', true);
    }
    await saveFile(`${doc.project.name}-tools.json`,
      // named after the project, so importing it back as a catalogue gives a
      // drawer that says where those cutters came from
      serializeLibrary(doc.project.tools, doc.project.name), ACCEPT.toolLibrary);
    ctx.ui.setStatus(`Exported ${plural(doc.project.tools.length, 'tool')}`);
  }

  /**
   * For the tree's per-setup "+ Add operation" affordance.
   *
   * The new operation arrives pointed at the material: heights taken from the
   * stock and the model, and stepping taken from what the strategy is for and
   * how big the cutter is. A default that has to be corrected before the first
   * generate is not a default, it is homework.
   */

  return {
    openModel,
    importDrawing,
    saveProject,
    openProject,
    clearProject,
    addToolsFromLibrary,
    newTool,
    editTool,
    saveToolToLibrary,
    importTools,
    exportTools,
    nextToolNumber,
  };
}
