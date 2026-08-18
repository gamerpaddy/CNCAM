// Driving the whole app from the console, for the checks the node suite cannot make.
//
// `node src/test/node-run.js` loads the engine and nothing above it: no
// `src/app/`, no `src/view/`, no worker pool. A real class of defect lives up
// there — a setting read once and never applied, a strategy that disagrees with
// the simulation, a toolpath that is right and drawn wrong — and all of it
// passes the suite. So the way to check those is to load the page and drive
// `window.cncam`, and this is the boilerplate that takes.
//
//   const H = await (await import('/src/test/browser-harness.js')).attach();
//   H.reset('mill');
//   await H.loadModel('test-step-plate.stl');
//   H.addTool('12mm flat 3FL');
//   cncam.actions.addSetup();
//   const setup = cncam.doc.project.setups[0];
//   const op = H.addOp(setup, 'clear2d', {}, '12mm flat 3FL');
//   await cncam.actions.generate();
//   H.stats(op); H.levels(op); await H.simHeights([['base top', -45, 0]]);
//
// The parts it expects are in samples/ — see samples/make-test-parts.mjs, which
// builds them with every dimension a round number so an answer can be checked
// against the part rather than against itself.

/** Everything below, with the modules it needs already loaded. */
export async function attach() {
  const c = window.cncam;
  if (!c) throw new Error('window.cncam is not there — is the app loaded?');
  // `clearProject` asks before it throws work away, and a confirm nobody
  // answers is a confirm that returns false: without this the reset is a no-op
  // and operations pile up on the setup you thought you had emptied.
  window.confirm = () => true;

  const [stl, meshMod, tl, schema, clMod, dxf, defaults] = await Promise.all([
    import('../io/stl.js'), import('../geom/mesh.js'), import('../doc/tool-library.js'),
    import('../doc/schema.js'), import('../engine/cl.js'), import('../io/dxf.js'),
    import('../engine/op-defaults.js'),
  ]);
  const { OP, FEED, MOVE_STRIDE } = clMod;
  const presets = tl.allPresets();
  const round = (v) => Math.round(v * 1000) / 1000;

  const H = {
    c, doc: c.doc, actions: c.actions, presets, mods: { stl, meshMod, tl, schema, clMod, dxf, defaults },
  };

  /** Empty the project and pick a machine. */
  H.reset = (machine = 'mill') => {
    c.actions.clearProject();
    if (c.doc.machine !== machine) c.actions.setMachine(machine);
  };

  /** Import samples/<file> as a model, the way the file dialog would. */
  H.loadModel = async (file) => {
    const buffer = await (await fetch(`/samples/${file}`)).arrayBuffer();
    const model = schema.createModel(file.replace(/\.[^.]+$/, ''), file);
    c.doc.addModel(model, meshMod.meshFromSoup(stl.parseSTL(buffer)));
    return model;
  };

  /** Import samples/<file> as a drawing to engrave or slot along. */
  H.loadDrawing = async (file) => {
    const text = await (await fetch(`/samples/${file}`)).text();
    const { paths, bounds } = dxf.parseDXF(text);
    const drawing = schema.createDrawing(file.replace(/\.[^.]+$/, ''), file, paths, bounds);
    c.doc.addDrawing(drawing);
    return drawing;
  };

  /** A library preset by name, added to the project. */
  H.addTool = (name, number = null) => {
    const preset = presets.find((t) => t.name === name);
    if (!preset) throw new Error(`no preset named ${name}`);
    const tool = tl.toolFromPreset(preset, number ?? c.actions.nextToolNumber());
    c.doc.addTool(tool);
    return tool;
  };

  /**
   * An operation with a named tool on it.
   *
   * `addOperationTo` picks its own cutter and derives the tool-relative
   * defaults from *that* one, so swapping the tool in afterwards would leave a
   * ⌀12's stepdown on a ⌀3 — the harness would then be measuring a setting it
   * did not mean to make. The defaults are re-derived for the tool asked for.
   */
  H.addOp = (setup, type, params = {}, toolName = null) => {
    c.actions.addOperationTo(setup, type);
    const op = setup.operations[setup.operations.length - 1];
    if (toolName) {
      const tool = c.doc.project.tools.find((t) => t.name === toolName);
      if (!tool) throw new Error(`no tool named ${toolName} in the project`);
      c.doc.updateItem(op, { toolId: tool.id }, 'tool');
      c.doc.updateItem(op.params, defaults.defaultParamsFor(type, {
        stock: c.actions.setupStock(setup),
        modelBounds: c.actions.setupModelBounds(setup),
        boreBottomZ: c.actions.setupBoreBottom(setup),
        tool,
      }), 'defaults for this tool');
    }
    if (Object.keys(params).length) c.doc.updateItem(op.params, params, 'params');
    return op;
  };

  /**
   * Every number worth having about one operation's output.
   *
   * A rapid is `OP.RAPID`, its own opcode — not an `OP.LINE` carrying
   * `FEED.RAPID` — and `OP.RAPID === 0 === FEED.RAPID`, so the wrong filter
   * silently counts nothing. The split here is by opcode.
   */
  H.stats = (op) => {
    const cl = c.doc.toolpaths.get(op.id);
    if (!cl) return { name: op.name, type: op.type, missing: true };
    const d = cl.moves;
    let cut = 0; let rapid = 0; let plunge = 0;
    let lines = 0; let rapids = 0; let drills = 0;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let px = null; let py = null; let pz = null;
    for (let i = 0; i < cl.count; i++) {
      const o = i * MOVE_STRIDE;
      const [code, x, y, z] = [d[o], d[o + 1], d[o + 2], d[o + 3]];
      for (let k = 0; k < 3; k++) {
        if (d[o + 1 + k] < min[k]) min[k] = d[o + 1 + k];
        if (d[o + 1 + k] > max[k]) max[k] = d[o + 1 + k];
      }
      if (code === OP.DRILL) {
        drills++;
        if (d[o + 4] > max[2]) max[2] = d[o + 4];   // the cycle's retract is a real Z
      } else {
        const dist = px === null ? 0 : Math.hypot(x - px, y - py, z - pz);
        if (code === OP.RAPID) { rapid += dist; rapids++; } else {
          lines++;
          if (d[o + 7] === FEED.PLUNGE) plunge += dist; else cut += dist;
        }
      }
      px = x; py = y; pz = z;
    }
    return {
      name: op.name,
      type: op.type,
      moves: cl.count,
      lines,
      rapids,
      drills,
      cut: round(cut),
      rapid: round(rapid),
      plunge: round(plunge),
      min: min.map(round),
      max: max.map(round),
      notes: (cl.notes ?? []).map((n) => `${n.level}: ${n.text}`),
    };
  };

  /** The Z levels a pass actually held, as opposed to passed through on a ramp. */
  H.levels = (op, minMoves = 15) => {
    const cl = c.doc.toolpaths.get(op.id);
    if (!cl) return [];
    const runs = new Map();
    for (let i = 0; i < cl.count; i++) {
      const o = i * MOVE_STRIDE;
      if (cl.moves[o] !== OP.LINE) continue;
      const z = Math.round(cl.moves[o + 3] * 100) / 100;
      runs.set(z, (runs.get(z) ?? 0) + 1);
    }
    return [...runs.entries()].filter(([, n]) => n >= minMoves)
      .map(([z]) => z).sort((a, b) => b - a);
  };

  /**
   * Where the material stands when the whole program has run, at named points.
   *
   * The one measurement that answers "did the part come out right", as opposed
   * to "did the toolpath look plausible" — it is what caught a roughing pass
   * leaving 3mm on a face it reported clearing.
   *
   * @param probes [[label, x, y], …] in setup coordinates
   */
  H.simHeights = async (probes) => {
    await c.actions.simulate();
    const state = c.simulation;
    if (!state) throw new Error('nothing simulated — generate first');
    const { sim } = state;
    if (sim.kind === 'turn') throw new Error('this is a turning simulation — use H.simRadii');
    state.playback.seek(sim.stepCount);
    const grid = state.playback.current;
    const out = {};
    for (const [label, x, y] of probes) {
      const i = Math.round((x - sim.origin[0]) / sim.cellSize);
      const j = Math.round((y - sim.origin[1]) / sim.cellSize);
      out[label] = i >= 0 && j >= 0 && i < sim.width && j < sim.height
        ? round(grid[j * sim.width + i]) : null;
    }
    return out;
  };

  /** The same, for a lathe: the bar's radius at each Z when the program has run. */
  H.simRadii = async (zs) => {
    await c.actions.simulate();
    const state = c.simulation;
    if (!state) throw new Error('nothing simulated — generate first');
    const { sim } = state;
    if (sim.kind !== 'turn') throw new Error('this is a milling simulation — use H.simHeights');
    state.playback.seek(sim.stepCount);
    const bar = state.playback.current;
    const out = {};
    for (const z of zs) {
      const i = Math.round((z - sim.zMin) / sim.dz);
      out[`z${z}`] = i >= 0 && i < sim.count ? round(bar[i]) : null;
    }
    return out;
  };

  /** The posted program, refreshed, as lines. */
  H.gcode = () => {
    c.actions.refreshGcodePreview(false);
    return (c.lastProgram?.text ?? '').split('\n');
  };

  /** The posted block for one operation, by name. */
  H.gcodeFor = (name, lines = 20) => {
    const all = H.gcode();
    const i = all.findIndex((l) => l.startsWith(`(operation: ${name}`));
    return i < 0 ? null : all.slice(i, i + lines);
  };

  window.H = H;
  return H;
}
