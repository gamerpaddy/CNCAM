// Holding tabs for contour operations.
//
// The final contour pass cuts all the way through, and a part sitting inside
// its own outline pops loose the moment the cutter closes the loop — usually
// straight into the spindle. Tabs are small bridges of material left standing:
// the perimeter is walked at the target Z everywhere except a few short spans
// where the tool rises to `tabHeight`, leaves a shelf of stock, then dips back
// down. The tabs snap or file off after the part is unclamped.
//
// Windows are placed by arc length so they end up spaced evenly around the
// outline no matter how many vertices it has.

import { FEED } from './cl.js';

/** Perimeter length of a flat loop [x0,y0,...]. */
function perimeter(loop) {
  let total = 0;
  const n = loop.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    total += Math.hypot(loop[j * 2] - loop[i * 2], loop[j * 2 + 1] - loop[i * 2 + 1]);
  }
  return total;
}

/**
 * Pairs [start, end] of arc-length ranges over which the tool rides high.
 *
 * The window is *wider than the tab* by one tool diameter, and that is the
 * whole point. `width` is what the user wants left standing, but a cutter of
 * diameter D removes material for D/2 either side of its centre — so lifting
 * over exactly `width` of path leaves `width - D` of material, and for any tab
 * narrower than the cutter, nothing at all. Asking for a 3mm tab with a 6mm
 * cutter produced a tab 3mm wide in the settings and 0mm wide in the part.
 *
 * Widening the lift by D puts the cutter's near edge exactly on the tab's edge
 * at each end, so the standing material is the width that was asked for.
 *
 * Windows wrap around the origin naturally: a range spanning zero comes back
 * as two entries so the "am I inside a tab?" test is a simple comparison.
 */
function tabWindows({ count, width, loopLength, toolDiameter = 0 }) {
  if (count <= 0 || width <= 0 || loopLength <= 0) return [];
  const spacing = loopLength / count;
  const half = (width + toolDiameter) / 2;
  const windows = [];
  for (let n = 0; n < count; n++) {
    // Half a spacing in, so no tab straddles arc zero. The loop starts where
    // the tool entered — the plunge or the end of the ramp — and a tab centred
    // there is a tab the entry has already cut through.
    const centre = (n + 0.5) * spacing;
    let a = centre - half;
    let b = centre + half;
    if (a < 0) {
      windows.push([a + loopLength, loopLength]);
      windows.push([0, b]);
    } else if (b > loopLength) {
      windows.push([a, loopLength]);
      windows.push([0, b - loopLength]);
    } else {
      windows.push([a, b]);
    }
  }
  return windows;
}

function insideAny(windows, s) {
  for (const [a, b] of windows) if (s >= a && s <= b) return true;
  return false;
}

/**
 * Machine one full perimeter at depth, riding over the tabs.
 *
 * A tab is a flat-topped bridge: the tool steps *vertically* up at the near
 * edge, runs level across the top, and steps vertically down at the far edge.
 *
 * Getting that shape takes two points at every boundary, not one. Emitting a
 * single point at the crossing — at the height of the span it ends — makes the
 * next move a straight line from the floor to the top of the tab, so the tool
 * climbs diagonally across the whole tab and descends diagonally out of it. The
 * material left is a wedge that reaches the requested height at exactly one
 * point and tapers to nothing either side of it: a tab in the settings, a
 * ridge in the part.
 */
export function cutPerimeterWithTabs(cl, loop, z, {
  count, width, height, toolDiameter = 0, topZ = null,
}) {
  const total = perimeter(loop);
  const windows = tabWindows({ count, width, loopLength: total, toolDiameter });
  const n = loop.length / 2;
  if (windows.length === 0) {
    // no tabs: same behaviour as plain cutPerimeter
    for (let i = 1; i <= n; i++) {
      const k = i % n;
      cl.cut(loop[k * 2], loop[k * 2 + 1], z);
    }
    return;
  }

  // The top of a tab is a plane at a fixed height above the *floor of the
  // profile*, not above whichever pass happens to be running. Measuring it from
  // the current pass made the tool ride at a different, meaningless height on
  // every level — 8.5mm on one pass and 4.5mm on the next for one 4.5mm tab.
  const tabZ = topZ ?? z + height;
  const zFor = (arc) => (insideAny(windows, ((arc % total) + total) % total) ? tabZ : z);

  let current = zFor(0);
  // the caller arrives at loop[0] at cutting depth; if that lands on a tab, get
  // up onto it before moving off
  if (current !== z) cl.cut(loop[0], loop[1], current, FEED.LEAD);

  let s = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = [loop[i * 2], loop[i * 2 + 1]];
    const j = (i + 1) % n;
    const [bx, by] = [loop[j * 2], loop[j * 2 + 1]];
    const segLen = Math.hypot(bx - ax, by - ay);
    if (segLen < 1e-9) continue;

    // arc-length positions along this edge where a window starts or ends
    const crossings = [];
    for (const [a, b] of windows) {
      for (const bound of [a, b]) {
        const local = bound - s;
        if (local > 1e-6 && local < segLen - 1e-6) crossings.push(local);
      }
    }
    crossings.sort((p, q) => p - q);

    let prevLocal = 0;
    for (const cross of [...crossings, segLen]) {
      const wantZ = zFor(s + (prevLocal + cross) / 2);
      if (wantZ !== current) {
        // stand the tool up at the boundary itself, so the span that follows is
        // travelled level rather than as a climb out of the cut
        const t0 = prevLocal / segLen;
        cl.cut(ax + (bx - ax) * t0, ay + (by - ay) * t0, wantZ, FEED.LEAD);
        current = wantZ;
      }
      const t = cross / segLen;
      cl.cut(ax + (bx - ax) * t, ay + (by - ay) * t, current,
        current === z ? FEED.CUT : FEED.LEAD);
      prevLocal = cross;
    }
    s += segLen;
  }

  // finished on top of a tab that straddles the loop start: the caller retracts
  // from here, so there is nothing to come down for
}
