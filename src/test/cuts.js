// What a simulated program cut, read off the simulator's own record.
//
// Shared by the tests that ask how much a pass took at once: every cell a step
// lowered, how far it came down under the cutter that lowered it, and whether
// it stood above the top of the flutes when it was cut.

/**
 * The deepest any step cut a cell strictly inside the cutter, and how far above
 * the top of the flutes any cell it cut had stood.
 *
 * A cell on the rim is the cutter touching a wall, not cutting into it, so it is
 * left out: `rim` is how far inside the cutter's edge a cell has to be to count.
 * A finish pass takes its allowance the whole height of the wall by design, and
 * a rim as wide as that allowance leaves exactly the allowance out.
 *
 * @param sim a `simulateRemoval` result recorded with steps (`record` ≥ 1)
 */
export function cutsOf(sim, radius, flutes, rim = 0.05) {
  const { evStep, evCell, evPrev, eventCount, tip, width, cellSize, origin } = sim;
  let deepest = 0;
  let overFlutes = 0;
  for (let e = 0; e < eventCount; e++) {
    const s = evStep[e];
    if (s < 1 || (s + 1) * 3 > tip.length) continue;
    const ax = tip[(s - 1) * 3];
    const ay = tip[(s - 1) * 3 + 1];
    const az = tip[(s - 1) * 3 + 2];
    const bx = tip[s * 3];
    const by = tip[s * 3 + 1];
    const bz = tip[s * 3 + 2];
    const c = evCell[e];
    const x = origin[0] + (c % width) * cellSize;
    const y = origin[1] + Math.floor(c / width) * cellSize;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((x - ax) * dx + (y - ay) * dy) / lenSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const off = Math.hypot(x - ax - dx * t, y - ay - dy * t);
    if (off > radius - 0.05) continue;
    const z = az + (bz - az) * t;
    overFlutes = Math.max(overFlutes, evPrev[e] - (z + flutes));
    if (off > radius - rim) continue;
    deepest = Math.max(deepest, evPrev[e] - z);
  }
  return { deepest, overFlutes };
}
