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
import { placedPaths, boundsOfPaths } from '../../engine/drawing.js';

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
    return newSetup();
  }

  /**
   * A new setup on the machine in front of you, named, stocked and added.
   *
   * Every way a setup gets made comes through here: "+ Setup", and the one made
   * on the way to a first operation. They used to be two, and only one of them
   * made sure the name was not already taken — so on a job whose mill had a
   * "Setup 2", the lathe's first setup could arrive as a second "Setup 2".
   */
  function newSetup() {
    const setup = createSetup(uniqueSetupName(`Setup ${doc.project.setups.length + 1}`),
      doc.machine);
    sizeNewStock(setup);   // one rule for every new setup — see below
    doc.addSetup(setup);
    return setup;
  }

  /**
   * A setup name nobody has used. Counting the setups gives the wrong name the
   * moment one has been deleted: two adds, delete the first, add again, and the
   * count says "Setup 2" alongside the existing "Setup 2".
   */
  function uniqueSetupName(base) {
    const taken = new Set(doc.project.setups.map((s) => s.name));
    if (!taken.has(base)) return base;
    // strip any number this name already ends with, so a clash on "Setup 2"
    // resolves to "Setup 3" rather than to "Setup 2 2" — the same reasoning as
    // uniqueOpName, which is the other half of this pair
    const stem = base.replace(/ \d+$/, '');
    for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}`)) return `${stem} ${n}`;
  }

  /**
   * Fill in a new setup's stock from what there is to cut, before anybody sees
   * it — for every way a setup gets made.
   *
   * There were two: "+ Setup" sized a plate for a drawing-only job, and the
   * setup made on the way to a first operation ("Add operation", "Engrave this
   * drawing") did not — so the one path a DXF-only job actually takes came up
   * with no stock at all, and Generate said the operations needed "a model"
   * for a job the app exists to do without one.
   *
   * Round stock resolves to a sensible bar whether or not the size has been
   * filled in (see engine/stock.js), but resolving and *displaying* are two
   * different things: leaving the fields empty means the viewport shows a ⌀31
   * bar while the panel beside it shows nothing at all. Writing the derived size
   * into the setup when it is created makes the panel and the picture the same
   * statement.
   */
  function sizeNewStock(setup) {
    if (isRoundStock(setup.stock)) {
      const derived = deriveCylinder([...doc.meshes.values()]);
      if (derived) setup.stock.cylinder = derived;
      return;
    }
    sizeStockToDrawings(setup);
  }

  /**
   * A plate to engrave on, when the job is a drawing and nothing else.
   *
   * Engraving a plate is a real job with no solid in it at all, and the auto
   * "box around the model" stock has no model to size itself from — so the
   * setup comes up with no stock, the operation has nothing to hang heights
   * off, and the whole thing reads as broken. A billet the size of the drawing
   * plus a margin is the answer anybody would have typed in.
   */
  function sizeStockToDrawings(setup) {
    if (doc.project.models.length > 0) return;
    const drawings = doc.project.drawings ?? [];
    if (drawings.length === 0) return;
    const bounds = boundsOfPaths(drawings.flatMap((d) => placedPaths(d, null)));
    if (!bounds) return;
    const margin = 5;
    const round3 = (v) => Math.round(v * 1000) / 1000;
    setup.stock.kind = 'box';
    setup.stock.box = {
      size: [
        round3(bounds.max[0] - bounds.min[0] + margin * 2),
        round3(bounds.max[1] - bounds.min[1] + margin * 2),
        6,
      ],
      align: 'center',
      offset: [0, 0, 0],
    };
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
    const profile = setupBoreProfile(setup);
    if (!profile) return null;
    const { z, r, samples } = profile;
    let i = samples - 1;
    for (let skipped = 0; i >= 0 && r[i] === 0 && skipped < 3; skipped++) i--;
    if (i < 0 || r[i] === 0) return null;
    while (i >= 0 && r[i] > 0) i--;
    return z[i + 1];
  }

  /** The part's bore, a radius for every Z — or null off the lathe or with no part. */
  function setupBoreProfile(setup) {
    if ((setup?.mode ?? 'mill') !== 'turn') return null;   // no bar, no axis to drill down
    const { meshes } = resolveSetupSpace(setup);
    if (meshes.length === 0) return null;
    return boreProfile(mergeMeshes(meshes));
  }

  return {
    setupMeshes, resolveSetupSpace, ensureSetup, newSetup, uniqueSetupName,
    setupModelBounds, setupBoreBottom, setupBoreProfile, sizeNewStock,
  };
}
