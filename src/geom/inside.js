// Point-in-polygon-set test for CNCAM loop sets.
//
// Loop sets follow the clipper convention: outers CCW, holes CW, non-zero fill.
// Crossing-number over every loop gives the right answer for that convention
// without needing to know which loop is which — a point inside an outer and
// inside a hole crosses both, and the parity cancels.

/** Is (x, y) inside the filled area described by `loops`? */
export function pointInLoops(loops, x, y) {
  let inside = false;
  for (const loop of loops) {
    const n = loop.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = loop[i * 2 + 1];
      const yj = loop[j * 2 + 1];
      if ((yi > y) === (yj > y)) continue;
      const xi = loop[i * 2];
      const xj = loop[j * 2];
      if (x < xi + ((y - yi) / (yj - yi)) * (xj - xi)) inside = !inside;
    }
  }
  return inside;
}
