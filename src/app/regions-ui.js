// Face picking: turn viewport clicks into an operation's machining regions.
//
// Pick mode is app state, not document state — it is a transient way of
// editing, so it lives here and is cleared whenever the selection changes.
// Clicks toggle, so clicking a picked face again removes it.
//
// Face groups are derived from the mesh and cached per model: recovering them
// walks the whole adjacency graph, which is far too slow to redo on every click.

import {
  buildFaces, buildEdges, faceFootprint, edgeFootprint, edgePolylines, edgeAtPoint,
} from '../geom/faces.js';
import { fixtureLoops } from '../engine/fixtures.js';
import { clearedStack } from '../engine/rest.js';
import { depthLevelsFor } from '../engine/stock.js';
import { regionReachFor } from '../engine/op-reach.js';
import { offsetLoops } from '../geom/clipper.js';

export const PICK_MODES = ['include', 'avoid'];

/**
 * What a click selects. Faces are the default because most operations are
 * about a surface; edges exist because chamfering is not — it is about the line
 * between two surfaces, and picking the face to get its whole boundary breaks
 * twelve corners when the part wanted three.
 */
export const PICK_KINDS = ['face', 'edge'];

export const PICK_KIND_LABELS = {
  face: 'Faces',
  edge: 'Edges',
};

/**
 * How wide a picked edge's region is, either side of the line.
 *
 * The tool centre stands off the edge by the operation's own offset, so the
 * band has to reach at least that far or the pass it is meant to select falls
 * outside it. Chamfer grows the include region by its offset already (see
 * strategies/chamfer.js), so this only has to be wide enough not to be a
 * rounding error on a coarse mesh.
 */
const EDGE_BAND = 0.25;

const OVERLAY_COLORS = { include: 0x3ddc84, avoid: 0xff5566 };

const faceCache = new Map(); // modelId -> { mesh, groups }

export function facesFor(modelId, mesh) {
  const cached = faceCache.get(modelId);
  if (cached && cached.mesh === mesh) return cached.groups;
  const groups = buildFaces(mesh);
  faceCache.set(modelId, { mesh, groups });
  return groups;
}

const edgeCache = new Map(); // modelId -> { mesh, edges }

/** The creases, built from the faces and cached the same way and for the same
 * reason: it is an adjacency walk, and a click must not pay for one. */
export function edgesFor(modelId, mesh) {
  const cached = edgeCache.get(modelId);
  if (cached && cached.mesh === mesh) return cached.edges;
  const { faces, faceOfTriangle } = facesFor(modelId, mesh);
  const edges = buildEdges(mesh, faces, faceOfTriangle);
  edgeCache.set(modelId, { mesh, edges });
  return edges;
}

export function invalidateFaces(modelId) {
  if (modelId) { faceCache.delete(modelId); edgeCache.delete(modelId); } else {
    faceCache.clear();
    edgeCache.clear();
  }
}

/**
 * Region entries are { modelId, faceId } or { modelId, edgeId }; compared by
 * value, not identity. A face 3 and an edge 3 are different things, so the key
 * has to carry which — comparing on the number alone would have picking an edge
 * silently remove a face.
 */
function sameRef(a, b) {
  return a.modelId === b.modelId && a.faceId === b.faceId && a.edgeId === b.edgeId;
}

/**
 * Toggle whatever the click landed on in the op's region list.
 * A pick can only be in one list, so adding to one drops it from the other.
 *
 * @param kind 'face' | 'edge'
 */
export function togglePicked(doc, op, mode, hit, kind = 'face') {
  const mesh = doc.meshes.get(hit.modelId);
  if (!mesh) return null;

  let ref = null;
  if (kind === 'edge') {
    const { edgeOfSegment } = edgesFor(hit.modelId, mesh);
    const at = hit.localPoint ?? hit.point;
    const edgeId = at ? edgeAtPoint(mesh, edgeOfSegment, hit.triangleIndex, at) : null;
    // Clicking the middle of a face in edge mode is not a request for one of
    // its far corners — it is a miss, and saying so beats guessing.
    if (edgeId == null) return { missed: true };
    ref = { modelId: hit.modelId, edgeId };
  } else {
    const { faceOfTriangle } = facesFor(hit.modelId, mesh);
    const faceId = faceOfTriangle[hit.triangleIndex];
    if (faceId === undefined || faceId < 0) return null;
    ref = { modelId: hit.modelId, faceId };
  }

  const other = mode === 'include' ? 'avoid' : 'include';
  const list = (op.regions[mode] ?? []).filter((x) => !sameRef(x, ref));
  const added = list.length === (op.regions[mode] ?? []).length;

  doc.updateItem(op.regions, {
    [mode]: added ? [...list, ref] : list,
    [other]: (op.regions[other] ?? []).filter((x) => !sameRef(x, ref)),
  }, added ? `add ${mode} ${kind}` : `remove ${mode} ${kind}`);

  return { faceId: ref.faceId, edgeId: ref.edgeId, kind, added };
}

/** @deprecated the face-only spelling, kept so older callers still work */
export function togglePickedFace(doc, op, mode, hit) {
  return togglePicked(doc, op, mode, hit, 'face');
}

/** All triangle indices for a mode's picked faces, grouped by model. */
function trianglesByModel(doc, op, mode) {
  const byModel = new Map();
  for (const ref of op.regions?.[mode] ?? []) {
    if (ref.faceId == null) continue;
    const mesh = doc.meshes.get(ref.modelId);
    if (!mesh) continue;
    const { faces } = facesFor(ref.modelId, mesh);
    const tris = faces[ref.faceId];
    if (!tris) continue;
    if (!byModel.has(ref.modelId)) byModel.set(ref.modelId, { mesh, triangles: [] });
    byModel.get(ref.modelId).triangles.push(...tris);
  }
  return byModel;
}

/**
 * The picked edges as 3D line segments, grouped by model.
 *
 * Drawn as lines rather than as the triangles either side of them, because the
 * triangles either side are the *faces* — highlighting those would make an edge
 * pick look exactly like two face picks, which is the one thing the mode exists
 * to distinguish.
 */
function edgeLinesByModel(doc, op, mode) {
  const byModel = new Map();
  for (const ref of op.regions?.[mode] ?? []) {
    if (ref.edgeId == null) continue;
    const mesh = doc.meshes.get(ref.modelId);
    if (!mesh) continue;
    const { edges } = edgesFor(ref.modelId, mesh);
    const edge = edges[ref.edgeId];
    if (!edge) continue;
    if (!byModel.has(ref.modelId)) byModel.set(ref.modelId, { mesh, points: [] });
    const { points } = byModel.get(ref.modelId);
    for (const [a, b] of edge.segments) {
      points.push(
        mesh.positions[a * 3], mesh.positions[a * 3 + 1], mesh.positions[a * 3 + 2],
        mesh.positions[b * 3], mesh.positions[b * 3 + 1], mesh.positions[b * 3 + 2],
      );
    }
  }
  return byModel;
}

/** Repaint region overlays for the selected operation (or clear them). */
export function syncRegionOverlays(doc, viewport) {
  viewport.clearRegionOverlays();
  if (doc.selection?.kind !== 'op') return;
  const op = doc.findSelected();
  if (!op?.regions) return;

  for (const mode of PICK_MODES) {
    for (const [modelId, { mesh, triangles }] of trianglesByModel(doc, op, mode)) {
      viewport.setRegionOverlay(`${mode}:${modelId}`, modelId, mesh, triangles,
        OVERLAY_COLORS[mode]);
    }
    for (const [modelId, { points }] of edgeLinesByModel(doc, op, mode)) {
      viewport.setEdgeOverlay(`${mode}-edge:${modelId}`, modelId, points,
        OVERLAY_COLORS[mode]);
    }
  }
}

/**
 * Resolve an op's picked faces into 2D loops for the generator.
 * `transform` maps model space into setup space, so regions land in the same
 * frame as the toolpaths.
 */
/**
 * What the operations above this one in the same setup have already cleared.
 *
 * Read off their generated toolpaths, so it says what the program *does* rather
 * than what the settings imply. Two consequences, both of them deliberate:
 *
 *   * An operation with no toolpath yet contributes nothing, and the pass is
 *     generated as though it were first — which is the old behaviour, and the
 *     safe direction to fail in.
 *   * Regenerating one operation after changing an earlier one is not enough;
 *     the later one has to be regenerated too. Generation does them in order
 *     for exactly this reason — see actions/program.js.
 *
 * Disabled operations are skipped, because a disabled operation is not going to
 * run and its ground is still standing.
 */
function clearedByEarlier(doc, op, setup, mesh, tool) {
  if (!setup || !op.params?.restMachining) return [];
  const earlier = [];
  for (const previous of setup.operations ?? []) {
    if (previous.id === op.id) break;
    if (!previous.enabled) continue;
    const cl = doc.toolpaths.get(previous.id);
    const previousTool = doc.project.tools.find((t) => t.id === previous.toolId);
    if (cl && previousTool) earlier.push({ cl, tool: previousTool });
  }
  if (earlier.length === 0) return [];
  // One area per depth this operation is going to cut at, because how much has
  // already come off depends entirely on how deep you ask. Asking once, at the
  // operation's own Bottom Z, was the whole of the old fault: at the bottom of
  // a part nothing has been cleared but the margin outside it, so the deduction
  // was a ring round the outside and every shallow level — where the earlier
  // pass really had taken everything — got none. Switching rest machining on
  // then made the program *longer*, because the pass had to route round that
  // ring at each level: measured on the step plate, an identical ⌀12 pass
  // repeated with rest machining on cut 11054mm against the 6310mm of the pass
  // it was supposed to be cleaning up after.
  return clearedStack(earlier, depthLevelsFor(op.params, mesh, tool),
    { tolerance: op.params.tolerance ?? 0.01 });
}

/**
 * How wide the band round a picked wall has to be, for each list.
 *
 * A wall projects to a line, so it only becomes a region once it has a width —
 * and the right width is not the same for the two lists, because
 * `engine/regions.js` adjusts them in opposite directions.
 *
 *   include is eroded by the tool radius, because the usual picked face is one
 *     the cutter runs *over*. A wall is one it runs *beside*: the centres that
 *     machine it are the ones within a radius of it. Half-width 2r erodes to
 *     exactly that, so "cut only along this step" means the cutter may be
 *     anywhere it touches the step and nowhere else.
 *
 *   avoid is grown by the tool radius, which is already the whole adjustment a
 *     keep-out needs — the cutter then clears the wall by whatever the band
 *     itself is. A hair is enough, and the same hair a picked edge uses.
 *
 * The erosion is what makes 2r right, so a pass that *grows* the include list
 * instead is not entitled to it. A chamfer stands its cutter off the edge of
 * what was picked and grows the region by that standoff (see
 * engine/op-reach.js), and 2r there is 2r of slack: a ⌀12 chamfer mill on a
 * pocket wall selected a band twelve millimetres either side of it, caught the
 * rim of a hole 5mm away in the pocket's own pick, and chamfered a hole nobody
 * had asked for. Marking the line is all such a pass needs from the band.
 */
function wallBandFor(mode, includeGrow) {
  return mode === 'include' && includeGrow < 0
    ? Math.max(includeGrow * -2, EDGE_BAND)
    : EDGE_BAND;
}

export function resolveRegions(doc, op, transformMeshFn, setup = null, tool = null, mesh = null) {
  // `edgePaths` is the picked edges as they are — polylines in space, in
  // machining order. The three loop lists are filters, and a filter is flat by
  // nature; an operation that runs *along* what was picked needs the height too.
  // See geom/faces.js:edgePolylines.
  const out = {
    include: [], avoid: [], cleared: [], edgePaths: [],
  };
  let any = false;
  // What this operation's cutter reaches, which is what every list below is
  // sized against — see engine/op-reach.js.
  const { cutRadius, includeGrow } = regionReachFor(op, tool);
  const tolerance = op.params?.tolerance ?? 0.01;

  const cleared = clearedByEarlier(doc, op, setup, mesh, tool);
  if (cleared.length) { out.cleared.push(...cleared); any = true; }

  // The setup's clamps are already in setup space — they were measured off the
  // machine, not derived from the model — so they go straight in. They apply to
  // every operation: a clamp does not care which pass is running.
  //
  // What it is not is a face on the part. Every keep-out is grown downstream by
  // how far the operation *cuts* from its axis, which is the right question to
  // ask of a surface that must come out unmachined and the wrong one to ask of
  // a lump of steel bolted to the table: a clamp stands proud of the work, and
  // what has to miss it is the whole cutter, cone or no cone. So the difference
  // between the two is added here, where both numbers are known. It is zero for
  // every strategy whose cutter takes material off at its full radius, which is
  // all of them but the chamfer.
  const body = Math.max(0, (tool?.diameter ?? 0) / 2);
  const clamps = fixtureLoops(setup?.fixtures);
  if (clamps.length) {
    out.avoid.push(...(body > cutRadius + 1e-9
      ? offsetLoops(clamps, body - cutRadius, tolerance)
      : clamps));
    any = true;
  }

  if (!op.regions) return any ? out : null;

  for (const mode of PICK_MODES) {
    const byModel = new Map();
    for (const ref of op.regions[mode] ?? []) {
      if (!byModel.has(ref.modelId)) byModel.set(ref.modelId, { faceIds: [], edgeIds: [] });
      const entry = byModel.get(ref.modelId);
      if (ref.edgeId != null) entry.edgeIds.push(ref.edgeId);
      else if (ref.faceId != null) entry.faceIds.push(ref.faceId);
    }
    for (const [modelId, { faceIds, edgeIds }] of byModel) {
      const mesh = doc.meshes.get(modelId);
      if (!mesh) continue;
      const placed = transformMeshFn(mesh);
      if (faceIds.length) {
        const { faces } = facesFor(modelId, mesh);
        const loops = faceFootprint(placed, faces, faceIds,
          { wallBand: wallBandFor(mode, includeGrow) });
        if (loops.length) { out[mode].push(...loops); any = true; }
      }
      if (edgeIds.length) {
        // The edges are indexed against the model's own mesh, and the band is
        // built from the *placed* one — same vertex numbering, setup-space
        // coordinates. Mixing those up puts the region where the part was
        // before the setup moved it.
        const { edges } = edgesFor(modelId, mesh);
        const loops = edgeFootprint(placed, edges, edgeIds, EDGE_BAND);
        if (loops.length) { out[mode].push(...loops); any = true; }
        // Only the ones picked to *machine*. An edge picked to avoid is a
        // keep-out, and a keep-out is exactly the flat band above.
        if (mode === 'include') {
          const paths = edgePolylines(placed, edges, edgeIds);
          if (paths.length) { out.edgePaths.push(...paths); any = true; }
        }
      }
    }
  }
  return any ? out : null;
}

export function regionCount(op, mode) {
  return op?.regions?.[mode]?.length ?? 0;
}
