// The one frame everything downstream agrees on.
//
// A setup says how the part is fixtured and where the controller's zero is;
// resolving it rotates the models into that frame and shifts them so the datum
// is (0,0,0). The viewport, the toolpaths and the G-code all go through here,
// which is why they agree — and why this is a module rather than three copies
// of the same three lines.

import { createSetup } from '../../doc/schema.js';
import { computeStock, deriveCylinder, isRoundStock } from '../../engine/stock.js';
import { resolveSetup } from '../../engine/setup.js';
import { computeBounds, mergeMeshes } from '../../geom/mesh.js';
import { boreProfile } from '../../engine/lathe.js';

/**
 * Which models a setup actually machines.
 *
 * An empty `modelIds` means "everything in the project", which is the normal
 * state — nothing in the UI fills the list in. So the models a setup machines
 * are not a property of the setup at all, and anything that has to notice when
 * they change has to ask *this* question rather than read the field. That is
 * why it is a function on its own: `opFingerprint` was comparing `modelIds`,
 * which stays `[]` however many models are imported, so importing a second part
 * silently changed the stock and every toolpath in the project while every
 * operation went on reporting itself up to date.
 */
export function setupModelIds(setup, project) {
  return setup.modelIds?.length ? setup.modelIds : project.models.map((m) => m.id);
}

export function makeSetupSpace(doc) {
  function setupMeshes(setup) {
    return setupModelIds(setup, doc.project).map((id) => doc.meshes.get(id)).filter(Boolean);
  }

  /**
   * Models and stock in setup space — rotated to how the part is fixtured and
   * shifted so the chosen datum is (0,0,0). Everything that machines or
   * measures goes through here so the viewport, the toolpaths and the G-code
   * all agree on one frame.
   */
  function resolveSetupSpace(setup) {
    return resolveSetup(setup, setupMeshes(setup), computeStock);
  }

  /**
   * The setup a new operation goes into, made if there is not one yet.
   * Scoped to the machine in front of you: adding a turning operation must not
   * land it in the milling setup that happens to be first in the project.
   */
  function ensureSetup() {
    const mine = doc.setups();
    if (mine.length > 0) return mine[0];
    const setup = createSetup(`Setup ${doc.project.setups.length + 1}`, doc.machine);
    // round stock arrives sized to the part, so the panel and the viewport are
    // the same statement from the first frame — see actions/editing.js
    const derived = isRoundStock(setup.stock) ? deriveCylinder([...doc.meshes.values()]) : null;
    if (derived) setup.stock.cylinder = derived;
    doc.addSetup(setup);
    return setup;
  }

  /**
   * The bounding box of everything this setup machines, in setup space — what a
   * new operation's heights are derived from.
   */
  function setupModelBounds(setup) {
    const { meshes } = resolveSetupSpace(setup);
    if (meshes.length === 0) return null;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const m of meshes) {
      const b = computeBounds(m.positions);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], b.min[k]);
        max[k] = Math.max(max[k], b.max[k]);
      }
    }
    return { min, max };
  }

  /**
   * How far the part's own hole reaches in from the free end, in setup space —
   * or null where there is no hole to follow.
   *
   * What a drill down the axis and a boring bar are both aimed at. Without it
   * they were aimed at a share of the length: on the test shaft, whose bore ends
   * 37mm in, a centre drill was born 55mm deep — eighteen millimetres of ⌀8
   * drill through solid metal, with nothing on screen to say so.
   *
   * Contiguous from the free end on purpose. A void in the middle of a part is
   * not something a drill can reach, and `boreProfile` reports the end face
   * itself as solid (it spans every radius from the axis out, which is a face
   * and not a hole), so the first sample or two of it are stepped over.
   */
  function setupBoreBottom(setup) {
    if ((setup?.mode ?? 'mill') !== 'turn') return null;   // no bar, no axis to drill down
    const { meshes } = resolveSetupSpace(setup);
    if (meshes.length === 0) return null;
    const { z, r, samples } = boreProfile(mergeMeshes(meshes));
    let i = samples - 1;
    for (let skipped = 0; i >= 0 && r[i] === 0 && skipped < 3; skipped++) i--;
    if (i < 0 || r[i] === 0) return null;
    while (i >= 0 && r[i] > 0) i--;
    return z[i + 1];
  }

  return {
    setupMeshes, resolveSetupSpace, ensureSetup, setupModelBounds, setupBoreBottom,
  };
}
