// Project schema: factories and (de)serialization. Persisted state only —
// runtime data (parsed meshes, toolpaths) lives on Document, not here.
// All lengths are millimeters.

import { createStock } from '../engine/stock.js';
import { encodeMesh, decodeMesh } from './mesh-codec.js';
import { defaultMachines, MACHINE_KINDS } from './machines.js';

// v3 → v4: the project carries machines, not just a post id. A post is how a
// move is spelled; a machine is how far the table goes, how fast a rapid
// really is and what the spindle will turn — see doc/machines.js.
// v4 → v5: whether to post arcs is one of those machine facts too, and moved
// off the project's post options onto each machine.
export const PROJECT_VERSION = 5;

let counter = 0;
export function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}

export function createProject(name = 'Untitled') {
  const machines = defaultMachines();
  return {
    version: PROJECT_VERSION,
    name,
    units: 'mm',          // display units; internal is always mm
    // Which machine you are working on. A lathe is not a G-code flavour — it
    // has its own operations, its own coordinates and its own idea of what the
    // part is — so the whole app switches with it, and a project may hold both
    // a milling job and a turning job for the same part.
    machine: 'mill',
    // The rack of machines this project could run on, and the one chosen for
    // each kind. The post is a property of the machine; `post` below is what
    // older projects carry and what everything falls back to.
    machines,
    machineIds: Object.fromEntries(MACHINE_KINDS.map((kind) => [
      kind, machines.find((m) => m.kind === kind)?.id ?? null,
    ])),
    post: 'linuxcnc',     // key into POSTS registry
    postOptions: createPostOptions(),
    models: [],           // { id, name, sourceName }
    // 2D drawings imported from DXF: curves, not solids, placed on the stock.
    // An engraving pass drives straight down them. See engine/drawing.js.
    drawings: [],
    tools: [],
    setups: [],
    simulation: createSimulationSettings(),
  };
}

/**
 * Post options a user can tune.
 *
 * Whether to post arcs at all used to live here as well. It is a fact about the
 * controller — one takes G2/G3, the next takes it badly, the lathe post takes
 * none — so it moved onto the machine record, where it travels with the machine
 * and can differ between the router and the mill in the same project. What is
 * left is how tightly a fitted arc has to hug the path it replaces, which is a
 * tolerance and belongs to the job. See doc/machines.js.
 */
export function createPostOptions() {
  return {
    arcTolerance: 0.01,   // mm the fitted arc may stray from the planned path
  };
}

/**
 * Simulation settings a project used to carry.
 *
 * Both have moved and this is where they land coming the other way. Detail is a
 * preference — how good do you want it to look, how long will you wait — so it
 * lives in app/settings.js with the rest of them. The rapid rate is a fact
 * about the machine, so it lives on the machine record in doc/machines.js and
 * travels with the file.
 *
 * The block stays so that a project written before either move still restores,
 * and `Document.rapidFeed` still falls back through it.
 */
export function createSimulationSettings() {
  return {
    quality: 'medium',            // 'low' | 'medium' | 'high' | 'ultra'
    rapidFeed: 3000,              // mm/min — how fast G0 moves run
  };
}

/**
 * A model is its geometry and where it came from — and nothing about where it
 * sits.
 *
 * There used to be a `transform` here, a position and a rotation, written into
 * every project file. Nothing read it: not the strategies, not the silhouette,
 * not the viewport. Setting it moved the part in the saved file and nowhere
 * else, so the one thing it could do was mislead — a field the format promises
 * and the program ignores. Where a part sits is a property of the *setup*
 * (`setup.orientation`, applied in engine/setup.js), which is the only
 * description of it there is, and the right number of descriptions is one.
 */
export function createModel(name, sourceName) {
  return {
    id: uid('model'),
    name,
    sourceName,                       // original filename
  };
}

/**
 * A 2D drawing, as paths in millimetres plus where it sits on the job.
 *
 * Not a model: there is no solid here and nothing to compute a silhouette
 * from. What there is, is exactly what an engraving pass wants — lines with the
 * tool centre belonging on them.
 */
export function createDrawing(name, sourceName, paths, bounds) {
  return {
    id: uid('drawing'),
    name,
    sourceName,
    paths,
    bounds,
    placement: createDrawingPlacement(),
  };
}

export function createDrawingPlacement() {
  return {
    origin: 'stock-center',
    offset: [0, 0],
    rotationDeg: 0,
    scale: 1,
    mirrorX: false,
  };
}

export const TOOL_TYPES = [
  'flat', 'ball', 'bull', 'drill', 'spot', 'chamfer', 'face', 'tap', 'threadmill',
  'turning', 'boring', 'parting', 'threading',
];

export const TOOL_TYPE_LABELS = {
  flat: 'Flat end mill',
  ball: 'Ball nose',
  bull: 'Bull nose (corner radius)',
  drill: 'Drill',
  spot: 'Spot / centre drill',
  chamfer: 'Chamfer mill / V bit',
  face: 'Face mill',
  tap: 'Tap',
  threadmill: 'Thread mill',
  turning: 'Turning tool (external)',
  boring: 'Boring bar (internal)',
  parting: 'Parting / grooving blade',
  threading: 'Threading tool',
};

export function createTool(type = 'flat') {
  return {
    id: uid('tool'),
    type,
    name: `${type} 6mm`,
    number: 1,
    diameter: 6,
    // Lathe tooling. An insert is a shape letter, an inscribed circle and a
    // nose radius — the three parts of an ISO code that are geometry. `hand`
    // decides which way the tool cuts, and therefore which side of the cut its
    // holder is on. See engine/insert.js.
    insert: type === 'boring' ? 'C' : 'C',
    insertIc: 9.525,
    insertCode: '',
    hand: 'R',
    // The approach (lead) angle κ of the major cutting edge, measured from the
    // face — 0° is a pure facing edge, 90° a pure OD-turning edge, and a little
    // over 90° a tool that turns and back-faces a square shoulder. It is what
    // makes an SDJCR (93°) and an SDNCN (62.5°) different tools rather than the
    // same grey wedge. Zero on a parting blade and a threading tool, which go
    // straight in. See engine/insert.js.
    leadAngle: type === 'turning' ? 95 : type === 'boring' ? 92 : 0,
    // How the holder itself is clocked in the post — a Multifix or a quick-change
    // block indexes in steps, and every step rotates the whole insert and so its
    // effective lead and clearance. Composes with leadAngle. See toolPose.
    mountAngle: 0,
    // A custom insert corner angle, used when `insert` is 'X' (custom) so any
    // grind or off-catalogue shape can be described. Ignored otherwise.
    insertAngle: 60,
    // A hand-drawn custom insert outline — an array of [x, y] with the cutting
    // corner first — set by the shape editor when `insert` is 'X'. When present
    // it is the authority on the shape and its corner angle; null falls back to
    // a rhombus of `insertAngle`. See engine/insert.js and app/shape-editor.js.
    customPoints: null,
    // A photograph of the actual cutter, as a data URL, or null for the drawing
    // the app generates from the numbers above. Two 6mm 3-flute end mills are
    // one drawing and two different tools; a picture is the only thing that
    // tells them apart. See app/tool-photo.js.
    image: null,
    // boring bars: how far into a hole the bar reaches, and the smallest hole
    // it will fit down. Both are the reason a bore is or is not machinable.
    minBore: 0,
    maxDepth: 0,
    cornerRadius: type === 'bull' ? 1 : 0,   // ball is implied diameter/2
    // Pointed cutters: the included angle of the point, and the flat left on
    // its end. Most chamfer mills and V bits have one, and it is the difference
    // between a chamfer that lands where it was asked for and one that is off
    // by half the flat — see engine/strategies/chamfer.js.
    tipAngle: type === 'drill' ? 118 : type === 'chamfer' || type === 'spot' ? 90 : 0,
    tipDiameter: 0,
    // Screws: the thread a tap cuts or a thread mill forms, in mm per turn, and
    // how many threads of a tap's end are ground away as a lead. The pitch is
    // not a detail of a tap, it *is* the tap — one turn advances it one pitch,
    // which is the feed — and the lead is why a blind hole is tapped short of
    // its floor. Zero on everything that is not a screw. See engine/holes.js.
    pitch: type === 'tap' || type === 'threadmill' ? 1 : 0,
    leadThreads: type === 'tap' ? 2 : 0,
    // Lathe inserts: the nose radius is what a finishing pass is compensated
    // for, and the blade width is what a parting or grooving cut removes.
    noseRadius: type === 'turning' || type === 'boring' ? 0.4 : 0,
    bladeWidth: type === 'parting' ? 3 : type === 'threading' ? 1.5 : 0,
    fluteLength: 20,
    flutes: 2,
    // shank + holder as cylinder stacks from the cutter up: { diameter, length }
    shank: [{ diameter: 6, length: 30 }],
    holder: [{ diameter: 40, length: 50 }],
    // cutting defaults, overridable per operation
    spindleRpm: 10000,
    feedCut: 800,        // mm/min
    feedPlunge: 300,
  };
}

/**
 * @param mode 'mill' or 'turn'. A turning setup holds the part on a spindle
 *   axis and machines a profile rather than a solid; see engine/lathe.js. It
 *   also arrives with round stock, because a lathe is fed bar — a turning setup
 *   that opens on a rectangular billet is asking the user to correct the app
 *   before they can do anything.
 */
export function createSetup(name = 'Setup 1', mode = 'mill') {
  return {
    id: uid('setup'),
    name,
    mode,
    wcs: 'G54',
    stock: createStock(mode === 'turn' ? 'cylinder' : 'box-margin'),
    // how the part is fixtured, and where the controller's zero sits
    orientation: { rotationDeg: [0, 0, 0], origin: 'stock-top-center' },
    // Indexed multi-axis: when enabled, the machine's rotary axes swing the
    // part to `orientation.rotationDeg` and lock, and the operations below cut
    // in that tilted frame — 3+1 or 3+2 rather than a re-fixturing. Null (the
    // default) is an ordinary setup reached by hand. See engine/indexing.js.
    index: null,
    // Rotary wrap: when enabled, the program is written flat — against the
    // unrolled surface of a cylinder of `diameter` — and the post bends it
    // round the named rotary axis on the way out. Not a second kind of
    // toolpath: the CL data is the same flat CL data. See engine/wrap.js.
    wrap: null,
    // clamps and jaws holding the part down: keep-outs every operation in this
    // setup respects. See engine/fixtures.js
    fixtures: [],
    modelIds: [],
    operations: [],
  };
}

export const OP_TYPES = [
  // Not a cut: a block of G-code placed in the running order. See
  // engine/strategies/command.js.
  'command',
  'face', 'contour2d', 'pocket', 'slot', 'clear2d', 'adaptive',
  'spot', 'drill', 'tap', 'threadMill', 'bore', 'chamfer', 'engrave',
  'parallel3d', 'waterline',
  'turnFace', 'turnRough', 'turnFinish', 'turnGroove', 'turnThread',
  'turnDrill', 'turnBore', 'turnPart',
];

/** A setup is milled or turned; the two never share an operation. */
export const SETUP_MODES = ['mill', 'turn'];

export function createOperation(type = 'contour2d') {
  return {
    id: uid('op'),
    type,
    name: type,
    enabled: true,
    toolId: null,
    geometry: [],         // selection references, strategy-specific
    // Faces picked in the viewport. Machining is skipped over anything in
    // `avoid`; when `include` is non-empty it also becomes the only region
    // machined. Empty means "the whole part", the usual case.
    regions: { include: [], avoid: [] },
    params: {
      // A command operation's whole content: the lines it writes into the
      // program, verbatim, where it stands in the running order. Empty on every
      // other operation. See engine/strategies/command.js.
      gcode: '',
      tolerance: 0.01,
      stockToLeave: 0,
      stepdown: 2,
      stepover: 0.5,      // fraction of diameter
      // adaptive clearing: the radial bite it holds to, as a fraction of
      // diameter. Small enough and the cut stays light whatever the geometry
      // does, which is what pays for full-depth passes at a high feed.
      engagement: 0.2,
      finishPasses: 0,
      // Speeds and feeds default to inheriting the tool's — the tool represents
      // "as fast as this cutter runs comfortably in a middle-of-the-road
      // material". Set an op-level number to override for that pass alone,
      // e.g. dropping RPM for a plunge or a fragile finish. null = inherit.
      spindleRpm: null,
      feedCut: null,
      feedPlunge: null,
      // Coolant, per operation because it is a per-operation decision: flood
      // for a roughing pass, off for a finishing pass you want to watch, mist
      // where flood would wash the chips back into the cut. 'off' is the
      // default so an existing program posts exactly as it did.
      coolant: 'off',       // 'off' | 'flood' | 'mist'
      clearanceHeight: 10,
      // how far above the surface a pass enters through the tool stops rapiding
      // and starts feeding. See engine/heights.js
      entryGap: 1,
      topZ: 0,
      bottomZ: -5,
      // Give a flat face on the part a depth level of its own, so the stock
      // standing on it is taken off rather than left for a pass that can never
      // reach it. See engine/stock.js withFlatLevels.
      flatPasses: true,
      flatPassGap: 20,    // % of the stepdown a flat must clear a level by
      // The shortest move worth writing. Roughing paths are offsets of a
      // silhouette chorded to `tolerance`, which is a finishing number: honour
      // it on a pass that leaves 0.3mm standing and a fillet arrives as four
      // hundred blocks. See engine/strategies/adaptive.js.
      resolution: 0.1,
      rampAngle: 3,       // degrees; 0 = straight plunge
      leadType: 'none',   // 'none' | 'arc' | 'tangent'
      leadRadius: 2,
      direction: 'climb', // 'climb' | 'conventional'
      // contour: which of the part's boundaries to cut, and which side of them
      profile: 'outer',   // 'outer' = the cut-out | 'all' = every hole too
      side: 'outside',    // 'outside' | 'inside' | 'on'
      // Which outline the pass follows at each depth. 'part' is one outline —
      // the whole part's shadow — which is what cutting a part free means;
      // 'level' re-reads the profile at every depth, for a stepped part.
      // See engine/strategies/contour.js.
      contourOutline: 'part',
      pattern: 'zigzag',  // raster pattern for face/parallel3d
      angleDeg: 0,        // raster direction
      peck: 0,            // drill peck depth; 0 = plain G81
      dwell: 0,           // seconds paused at depth; > 0 with no peck = G82
      // how close a hole's diameter must be to the drill's to count as a match
      diameterTol: 0.5,
      // Spotting: how wide the cone is at the surface. 0 means "as wide as the
      // hole", which is the chamfer case. The depth is worked out from the
      // cutter's own point angle rather than typed — see strategies/holes.js.
      spotDiameter: 0,
      // 'bottomZ' takes every hole to the operation's Bottom Z; 'hole' takes
      // each one to its own measured floor
      depthMode: 'hole',
      // Contour tabs: bridges of stock left at the final depth so the part
      // does not break free when the outline closes. 0 tabs disables them.
      tabCount: 0,
      tabWidth: 4,
      tabHeight: 1.5,
      // Chamfer: the width of the edge break, how far the tip is kept clear of
      // the wall under it, and how many bites it is taken in.
      chamferWidth: 0.5,
      chamferClearance: 0.3,
      chamferPasses: 1,
      chamferEdges: 'all',    // 'outer' | 'holes' | 'all'
      // Bore: which holes, and what is already there to open up.
      boreDiameter: 0,        // 0 = every hole this cutter fits inside
      preDrilled: 0,          // existing hole diameter; 0 = boring from solid
      // Engrave: drive the depth directly, or ask for a line width and let the
      // cutter's point angle work the depth out.
      engraveMode: 'depth',   // 'depth' | 'width'
      // How deep the mark is, **below the surface it is cut into**. A depth,
      // not a pair of heights: Top Z and Bottom Z describe a mark on a flat
      // face at Top Z and describe nothing at all once the pass follows a
      // sloped one. See engine/strategies/engrave.js.
      engraveDepth: 0.3,
      grooveWidth: 0.4,
      engraveLines: 'all',    // 'outer' | 'holes' | 'all'
      // An imported DXF to drive the pass, instead of the part's own outline.
      // null is the old behaviour and the usual one; a drawing id engraves that
      // drawing where its placement puts it. See engine/drawing.js.
      drawingId: null,
      // Turning. X in the engine is a radius; the lathe post writes diameters.
      //
      // A lathe holds a *surface* speed, not an rpm: as the tool works in
      // toward the axis the diameter falls, and at a fixed rpm the metres per
      // minute fall with it until the insert is rubbing rather than cutting.
      // G96 lets the control wind the spindle up to compensate, and it always
      // carries a cap — at the centre the commanded speed goes to infinity.
      spindleMode: 'rpm',     // 'rpm' (G97) | 'css' (G96)
      surfaceSpeed: 0,        // m/min, for G96; 0 falls back to the tool's rpm
      cssMaxRpm: 0,           // rpm clamp for G96; 0 uses the operation's rpm
      clearanceX: 0,          // safe radius for rapids; 0 = just clear of the bar
      faceToRadius: 0,        // facing runs in to here (0 = the centre)
      partOffRadius: 0,       // parting cuts down to here
      // Grooving. The groove's two shoulders are Top Z and Bottom Z — a groove
      // is a width along the bar, which is exactly what that pair already
      // means — and this is the radius its floor sits at.
      // null works a depth out from the bar; 0 really does mean the centreline,
      // which for a groove is a part-off (see generateTurnGroove)
      grooveRadius: null,
      grooveInternal: false,  // a groove in a bore rather than on the outside
      // Threading: the pitch, the height of the form, and how the depth of cut
      // is shared out between passes. See engine/strategies/turning.js.
      threadPitch: 1.5,
      threadDepth: 0,         // 0 works it out from the pitch (0.61343 × P)
      threadPasses: 6,        // a floor: threadFirstDepth may raise it
      threadStartRadius: 0,   // 0 reads the major diameter off the bar
      threadInternal: false,
      threadHand: 'right',    // 'right' | 'left' — left runs the other way
      threadDegression: 2,    // 2 equal chip area, 1 equal depth per pass
      threadFirstDepth: 0.25, // the deepest first bite allowed, mm; 0 is off
      threadSpringPasses: 1,
      // Which diameter in the Z range the thread is cut on. 'auto' takes the
      // surface the thread actually sits on — the largest diameter outside, the
      // smallest bore inside — rather than whatever happens to be at the
      // midpoint, which is how a thread ends up on the wrong shoulder.
      threadFace: 'auto',     // 'auto' | 'start' | 'end'
      // Rest machining: skip what the operations before this one already took
      // off. See engine/rest.js.
      restMachining: false,
      // Engraving: cut at a depth below the surface rather than at one Z.
      // See engine/strategies/engrave.js.
      engraveFollow: true,
      // Parallel finishing: how far past the part the raster runs. 'part'
      // keeps it within a tool radius of the work; 'stock' is the whole
      // area, which digs a lap round the outside at Bottom Z.
      parallelBoundary: 'part',
      boundaryExtra: 0,
      // How far a finishing raster may travel across a break in the surface
      // instead of retracting out of it. null means "three tool diameters",
      // which is the width of the gaps a raster actually meets — a bore it
      // passes either side of, the step at a shoulder. Declared here because
      // the panel offers it and op-defaults sets it: a parameter the UI writes
      // and the schema does not know about is one the fingerprint cannot see,
      // so changing it would not mark the toolpath stale.
      linkDistance: null,
      // Parting: how much wider than the blade the slot is cut, so a deep part
      // off does not pinch the blade in its own groove.
      partWiden: 0,
      // Slotting: the finished width of the slot; 0 is the cutter's own.
      slotWidth: 0,
      // Internal turning: the hole that is already there, and how far the bar
      // may reach into it.
      boreStartRadius: 0,     // the pilot hole; 0 reads it from the part
      boreDepthLimit: 0,      // 0 = as far as the tool's own reach allows
    },
  };
}

/**
 * @param project the document's project
 * @param meshes optional Map of modelId → mesh; given, geometry is embedded so
 *   the file stands on its own without the CAD it was imported from
 */
export function serializeProject(project, meshes = null) {
  if (!meshes) return JSON.stringify(project, null, 2);
  const withGeometry = {
    ...project,
    models: project.models.map((model) => {
      const mesh = meshes.get(model.id);
      return mesh ? { ...model, geometry: encodeMesh(mesh) } : model;
    }),
  };
  return JSON.stringify(withGeometry, null, 2);
}

/**
 * Take the embedded geometry back out of a loaded project.
 *
 * Meshes live on the document, not in the project tree — everything downstream
 * expects `project.models` to be small, serialisable description. So the
 * geometry is lifted off here and handed back separately, and the project is
 * left the shape the rest of the app knows.
 *
 * @returns Map of modelId → mesh (without normals; the caller computes those)
 */
export function extractMeshes(project) {
  const meshes = new Map();
  for (const model of project.models ?? []) {
    if (!model.geometry) continue;
    const mesh = decodeMesh(model.geometry);
    delete model.geometry;
    if (mesh) meshes.set(model.id, mesh);
  }
  return meshes;
}

export function deserializeProject(json) {
  const p = JSON.parse(json);
  if (typeof p.version !== 'number' || p.version > PROJECT_VERSION) {
    throw new Error(`Unsupported project version: ${p.version}`);
  }
  p.machine ??= 'mill';
  p.post ??= 'linuxcnc';
  p.postOptions = { ...createPostOptions(), ...(p.postOptions ?? {}) };
  p.simulation = { ...createSimulationSettings(), ...(p.simulation ?? {}) };
  // v3 → v4: machines. A project written before they existed has a post and
  // nothing else, so it gets the stock rack with the machine matching its post
  // selected — which keeps the file posting exactly as it did.
  if (!Array.isArray(p.machines) || p.machines.length === 0) {
    p.machines = defaultMachines();
    p.machineIds = Object.fromEntries(MACHINE_KINDS.map((kind) => [
      kind,
      (p.machines.find((m) => m.kind === kind && m.post === p.post)
        ?? p.machines.find((m) => m.kind === kind))?.id ?? null,
    ]));
  }
  p.machineIds ??= {};
  // v4 → v5: arcs moved from the project's post options onto each machine. A
  // project that had them turned off meant it, so every machine in it inherits
  // that rather than quietly posting arcs again on the next export.
  if (p.postOptions.arcs === false) {
    for (const machine of p.machines) machine.arcs = false;
  }
  delete p.postOptions.arcs;
  // v3 → v4: imported drawings. A file written before they existed has none.
  p.drawings = (p.drawings ?? []).map((d) => ({
    ...d,
    paths: d.paths ?? [],
    placement: { ...createDrawingPlacement(), ...(d.placement ?? {}) },
  }));
  // v1 → v2: setups gained orientation, and stock gained explicit/cylinder shapes
  // v2 → v3: models carry their geometry, so a project file is self-contained.
  //          Older files simply have none, and say so when they are opened.
  const defaults = createOperation();
  // Tools gain fields too — a project saved before chamfering existed has no
  // tip angle on its cutters, and a missing number is not the same as zero to
  // every reader downstream.
  p.tools = (p.tools ?? []).map((t) => ({ ...createTool(t.type ?? 'flat'), ...t }));
  for (const setup of p.setups ?? []) {
    setup.mode ??= 'mill';
    setup.orientation ??= { rotationDeg: [0, 0, 0], origin: 'model' };
    // Indexed setups arrived after 3+2 support; a project written before it has
    // none, which reads as an ordinary re-fixtured setup.
    setup.index ??= null;
    setup.fixtures ??= [];
    setup.stock = { ...createStock(), ...(setup.stock ?? {}) };
    for (const op of setup.operations ?? []) {
      op.regions ??= { include: [], avoid: [] };
      op.params = { ...defaults.params, ...(op.params ?? {}) };
    }
  }
  p.version = PROJECT_VERSION;
  return p;
}
