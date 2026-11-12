// Pencil finishing: trace the creases a bigger cutter could not reach.
//
// A finishing pass with a ⌀6 ball leaves a fillet of radius 3 in every inside
// corner, however sharp the part is there. A pencil pass takes a smaller cutter
// down those corners and along those valleys, once, and leaves a fillet of its own
// radius — a far smaller one, in a fraction of the time a second full finish
// would take.
//
// What it traces is found, not drawn. The reference ball is slid over the surface
// from above wherever it can go; everything inside the ball comes away, so what is
// left at any point is the *lowest* the ball's underside reaches there, over every
// position that covers it. Where that stands above the part — an inside corner, a
// valley narrower than the ball — is metal the reference cutter left, and the
// height it stands there is how much. The line along the top of that residue is
// the crease, and the pencil cutter is settled into it: slid along the line until
// it is as low as it can go, which in a square corner puts it a radius from the
// wall with its tip on the floor, and in a V puts it on the bottom.
//
// Seen from above, like the other heightmap finishers: an undercut is not a
// crease it can see.

import { dropCutter, buildToolKernel } from '../../geom/heightmap.js';
import { thin, tracePaths, simplifyRun } from '../../geom/skeleton.js';
import { prepareFinish, emitOrdered } from './parallel3d.js';
import { regionRefusal } from '../regions.js';

/** The part of a map's surface at (x, y), or −∞ where there is none. */
function surfaceOf(map, x, y) {
  const i = Math.round((x - map.min[0]) / map.cellSize);
  const j = Math.round((y - map.min[1]) / map.cellSize);
  if (i < 0 || j < 0 || i >= map.width || j >= map.height) return -Infinity;
  const z = map.data[j * map.width + i];
  return z === map.floor || !Number.isFinite(z) ? -Infinity : z;
}

export function generatePencil({
  mesh, tool, params: given, stock, regions, earlier = null,
}) {
  const prepared = prepareFinish({
    mesh, tool, params: given, stock, regions, earlier,
    // the cutter is small and goes one place: its own width sets the grid
    stepOf: (t) => Math.max(0.05, t.diameter * 0.25),
    label: 'pencil finishing',
  });
  if (prepared.empty) return prepared.cl.finish();
  const {
    cl, params, r, tolerance, clearance, feedPlane, map, box, probe, sample, link, stockToLeave,
  } = prepared;

  // The cutter whose leftovers these are. Auto is twice this one, which is the
  // usual finishing-to-pencil step; a bigger gap finds more, a smaller one less.
  const refDiameter = params.pencilRefDiameter > 0 ? params.pencilRefDiameter : tool.diameter * 2;
  if (!(refDiameter > tool.diameter * 1.05)) {
    cl.warn(`the reference cutter (⌀${refDiameter}) is no bigger than this one (⌀${tool.diameter}) — `
      + 'there is nothing a cutter of this size could clear that the other could not');
    return cl.finish();
  }
  const R = refDiameter / 2;
  // How much metal left has to be worth a pass. Below the tolerance it is not
  // metal, it is the model's own rounding.
  const minResidual = params.pencilMinResidual > 0
    ? params.pencilMinResidual : Math.max(0.02, tolerance * 2);

  const kernelRef = buildToolKernel({ type: 'ball', diameter: refDiameter }, map.cellSize);

  // --- the residue, on a grid fine enough to see it and coarse enough to afford ---
  const g = Math.max(map.cellSize, R / 8);
  const x0 = box.min[0];
  const y0 = box.min[1];
  const nx = Math.floor((box.max[0] - x0) / g) + 1;
  const ny = Math.floor((box.max[1] - y0) / g) + 1;
  if (nx * ny > 2_500_000) {
    cl.warn('pencil finishing: the area is too large for this reference cutter to measure — '
      + 'pick a region, or a larger reference diameter');
    return cl.finish();
  }
  const surf = new Float32Array(nx * ny).fill(-Infinity);
  const tip = new Float32Array(nx * ny).fill(-Infinity);
  const inside = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * g;
      const y = y0 + j * g;
      const k = j * nx + i;
      surf[k] = surfaceOf(map, x, y);
      if (!Number.isFinite(surf[k])) continue;
      const t = dropCutter(map, kernelRef, x, y);
      tip[k] = Number.isFinite(t) ? t : -Infinity;
      // may the pencil be here at all — the window, the regions, the boundary
      inside[k] = probe(x, y)[2] === null ? 0 : 1;
    }
  }
  // what is left: the lowest the reference ball's underside gets to at each cell,
  // over every position it can take that covers it
  const reach = Math.ceil(R / g);
  const rise = [];            // [di, dj, height of the ball above its own tip]
  for (let dj = -reach; dj <= reach; dj++) {
    for (let di = -reach; di <= reach; di++) {
      const d = Math.hypot(di * g, dj * g);
      if (d <= R) rise.push(di, dj, R - Math.sqrt(R * R - d * d));
    }
  }
  const residue = new Float32Array(nx * ny);
  let peak = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!inside[k] || !Number.isFinite(surf[k])) continue;
      let envelope = Infinity;
      for (let n = 0; n < rise.length; n += 3) {
        const ii = i + rise[n];
        const jj = j + rise[n + 1];
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const t = tip[jj * nx + ii];
        if (t === -Infinity) continue;
        const z = t + rise[n + 2];
        if (z < envelope) envelope = z;
      }
      const left = envelope - surf[k];
      if (Number.isFinite(envelope) && left > 0) {
        residue[k] = left;
        if (left > peak) peak = left;
      }
    }
  }
  if (peak < minResidual) {
    cl.warn(`pencil finishing found nothing to clean: a ⌀${refDiameter} cutter leaves no more than `
      + `${peak.toFixed(3)}mm anywhere on this part`);
    return cl.finish();
  }

  // --- the crease: the ridge of the residue, thinned to a line ---
  const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? 0 : residue[j * nx + i]);
  const ridge = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = residue[j * nx + i];
      if (v < minResidual) continue;
      // highest along any one of the four directions through it: a crease is
      // the top of a slope across it, whichever way it happens to run
      const top = (a, b) => v >= at(i + a, j + b) && v >= at(i - a, j - b)
        && (v > at(i + a, j + b) || v > at(i - a, j - b));
      if (top(1, 0) || top(0, 1) || top(1, 1) || top(1, -1)) ridge[j * nx + i] = 1;
    }
  }
  const line = thin(ridge, nx, ny);
  const runs = tracePaths(line, nx, ny);

  // --- from the crease to where the pencil sits: slide it down into the valley ---
  const kernel = prepared.kernel;
  const stride = Math.max(map.cellSize, g / 3);
  const search = r + g;
  const offsets = [];
  for (let dj = -Math.ceil(search / stride); dj <= Math.ceil(search / stride); dj++) {
    for (let di = -Math.ceil(search / stride); di <= Math.ceil(search / stride); di++) {
      if (Math.hypot(di * stride, dj * stride) <= search) offsets.push([di * stride, dj * stride]);
    }
  }
  const settle = (qx, qy) => {
    let lowest = Infinity;
    const tips = offsets.map(([dx, dy]) => {
      const z = dropCutter(map, kernel, qx + dx, qy + dy);
      if (Number.isFinite(z) && z < lowest) lowest = z;
      return z;
    });
    if (!Number.isFinite(lowest)) return null;
    // among the places that are as low as it can go, the nearest the crease:
    // that is a radius off the wall in a corner, and the bottom of a V
    let best = null;
    let bestD = Infinity;
    offsets.forEach(([dx, dy], n) => {
      if (!(tips[n] <= lowest + tolerance * 0.5)) return;
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = [qx + dx, qy + dy]; }
    });
    return best;
  };

  const minLength = tool.diameter;
  const paths = [];
  for (const run of runs) {
    // a crease shorter than the cutter is a speck, not a corner
    if (run.length * g < minLength) continue;
    const settled = [];
    for (const [i, j] of run) {
      const p = settle(x0 + i * g, y0 + j * g);
      if (p) settled.push(p);
    }
    const path = [];
    for (const [x, y] of simplifyRun(settled, tolerance)) {
      const s = sample(x, y);
      if (s) path.push(s);
    }
    if (path.length >= 2) paths.push(path);
  }

  if (paths.length === 0) {
    const why = regionRefusal(regions, r, tolerance);
    cl.warn(why
      ? `pencil finishing produced no passes — ${why}`
      : 'pencil finishing found creases but the cutter cannot be set into any of them — '
        + 'check Top Z and Bottom Z');
    return cl.finish();
  }
  cl.info(`${paths.length} crease${paths.length === 1 ? '' : 's'} traced, the worst leaving `
    + `${peak.toFixed(2)}mm after a ⌀${refDiameter} cutter${stockToLeave > 0 ? `, ${stockToLeave}mm left on` : ''}`);
  emitOrdered(cl, paths, { clearance, feedPlane, link });
  return cl.finish();
}
