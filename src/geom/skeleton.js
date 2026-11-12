// Thin a raster mask to a one-cell-wide line, and walk the line as paths.
//
// The pencil pass finds where the surface is hollower than a cutter can reach as a
// *mask* of cells, and what it has to cut is a line: the middle of that mask, which
// is where a small cutter belongs. Thinning (Zhang–Suen) takes a blob to its middle
// without breaking it into pieces, and tracing turns the result into the ordered
// runs of cells a toolpath is made from.

/**
 * Zhang–Suen thinning, in place on a copy.
 * @param mask Uint8Array, width × height, nonzero = on
 * @returns a new Uint8Array, 1 where the thinned line is
 */
export function thin(mask, width, height) {
  const a = Uint8Array.from(mask, (v) => (v ? 1 : 0));
  const at = (i, j) => (i < 0 || j < 0 || i >= width || j >= height ? 0 : a[j * width + i]);
  const remove = [];
  let changed = true;
  // each pass peels one layer, so a blob needs about half its width in passes
  for (let guard = 0; changed && guard < Math.max(width, height); guard++) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      remove.length = 0;
      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          if (!a[j * width + i]) continue;
          // neighbours clockwise from the north: p2 p3 p4 p5 p6 p7 p8 p9
          const p2 = at(i, j - 1); const p3 = at(i + 1, j - 1); const p4 = at(i + 1, j);
          const p5 = at(i + 1, j + 1); const p6 = at(i, j + 1); const p7 = at(i - 1, j + 1);
          const p8 = at(i - 1, j); const p9 = at(i - 1, j - 1);
          const around = [p2, p3, p4, p5, p6, p7, p8, p9];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          let transitions = 0;
          for (let k = 0; k < 8; k++) if (!around[k] && around[(k + 1) % 8]) transitions++;
          if (transitions !== 1) continue;
          const ok = step === 0
            ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0
            : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0;
          if (ok) remove.push(j * width + i);
        }
      }
      if (remove.length) changed = true;
      for (const k of remove) a[k] = 0;
    }
  }
  return a;
}

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

/**
 * The runs of cells in a thin line, each an array of [i, j] in order.
 *
 * Open lines are walked from an end; what is left after them is loops. A branch
 * point ends a run and starts the next, so a junction is shared rather than
 * walked twice. Every cell is in exactly one run.
 */
export function tracePaths(line, width, height) {
  const on = (i, j) => i >= 0 && j >= 0 && i < width && j < height && line[j * width + i] === 1;
  const seen = new Uint8Array(width * height);
  const degree = (i, j) => {
    let d = 0;
    for (const [di, dj] of NEIGHBOURS) if (on(i + di, j + dj)) d++;
    return d;
  };
  const walk = (i0, j0) => {
    const run = [[i0, j0]];
    seen[j0 * width + i0] = 1;
    let [i, j] = [i0, j0];
    for (;;) {
      // prefer the straight neighbours, which keeps a run from cutting corners
      let next = null;
      for (const [di, dj] of NEIGHBOURS) {
        const ni = i + di;
        const nj = j + dj;
        if (!on(ni, nj) || seen[nj * width + ni]) continue;
        next = [ni, nj];
        break;
      }
      if (!next) break;
      [i, j] = next;
      seen[j * width + i] = 1;
      run.push([i, j]);
      if (degree(i, j) > 2) break;       // a junction: the run ends, the branches begin there
    }
    return run;
  };
  const runs = [];
  // ends first, then junction-adjacent cells, then whatever is left (loops)
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      if (!on(i, j) || seen[j * width + i] || degree(i, j) !== 1) continue;
      runs.push(walk(i, j));
    }
  }
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      if (!on(i, j) || seen[j * width + i]) continue;
      const run = walk(i, j);
      // a loop closes on itself: put its first cell on the end
      if (run.length > 2 && Math.abs(run[0][0] - run[run.length - 1][0]) <= 1
        && Math.abs(run[0][1] - run[run.length - 1][1]) <= 1) run.push(run[0]);
      runs.push(run);
    }
  }
  return runs;
}

/** Douglas–Peucker on a run of [x, y, …] points, keeping the ends. */
export function simplifyRun(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    let far = -1;
    let worst = tolerance;
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs((points[k][0] - ax) * dy - (points[k][1] - ay) * dx) / len;
      if (d > worst) { worst = d; far = k; }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, k) => keep[k]);
}
