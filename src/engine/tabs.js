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
// outline no matter how many vertices it has — and, given anchors, at the same
// places on the part for every lap that has them. Measured from each lap's own
// start instead, they moved: a descent ramping round the loop starts every
// level somewhere else, and a finish pass starts wherever its own loop does,
// so each lap lifted over its own windows and cut straight through the tabs
// the laps before it had left — full width, the height of the tab, and what
// stood at the end was a finish pass's allowance where the tabs should be.

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
 * Where the tabs go on a set of profiles, as points on them: `count` evenly
 * spaced round each loop by arc length, half a spacing on from a start that
 * belongs to the loop and not to any pass — its lowest point, leftmost of
 * those. Every lap of the operation lifts over these same places.
 */
export function tabAnchors(loops, count) {
  const out = [];
  if (!(count > 0)) return out;
  for (const loop of loops) {
    const n = loop.length / 2;
    if (n < 3) continue;
    let k0 = 0;
    for (let k = 1; k < n; k++) {
      const y = loop[k * 2 + 1];
      const y0 = loop[k0 * 2 + 1];
      if (y < y0 - 1e-9 || (Math.abs(y - y0) <= 1e-9 && loop[k * 2] < loop[k0 * 2])) k0 = k;
    }
    const total = perimeter(loop);
    if (!(total > 0)) continue;
    for (let t = 0; t < count; t++) out.push(pointAlong(loop, k0, ((t + 0.5) / count) * total));
  }
  return out;
}

/** The point `s` along a closed loop from vertex `k0`. */
function pointAlong(loop, k0, s) {
  const n = loop.length / 2;
  let left = s;
  for (let i = 0; i < n; i++) {
    const a = (k0 + i) % n;
    const b = (a + 1) % n;
    const len = Math.hypot(loop[b * 2] - loop[a * 2], loop[b * 2 + 1] - loop[a * 2 + 1]);
    if (left <= len || i === n - 1) {
      const t = len > 0 ? Math.min(1, left / len) : 0;
      return [loop[a * 2] + (loop[b * 2] - loop[a * 2]) * t,
        loop[a * 2 + 1] + (loop[b * 2 + 1] - loop[a * 2 + 1]) * t];
    }
    left -= len;
  }
  return [loop[k0 * 2], loop[k0 * 2 + 1]];
}

/** How far along `loop`, from its first point, the point of it nearest (x, y) is — and how far off. */
function arcOfNearest(loop, x, y) {
  const n = loop.length / 2;
  let best = { s: 0, d: Infinity };
  let s = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = loop[i * 2];
    const ay = loop[i * 2 + 1];
    const dx = loop[j * 2] - ax;
    const dy = loop[j * 2 + 1] - ay;
    const lenSq = dx * dx + dy * dy;
    const len = Math.sqrt(lenSq);
    let t = lenSq > 0 ? ((x - ax) * dx + (y - ay) * dy) / lenSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
    if (d < best.d) best = { s: s + len * t, d };
    s += len;
  }
  return best;
}

/**
 * The arc ranges a lap along `loop` rides over the tabs, measured from its
 * first point — round the anchors where there are any near it, and the old
 * way, evenly from the lap's own start, where there are none.
 */
function windowsOn(loop, { count, width, toolDiameter = 0, anchors = null, reach = 0 }) {
  const total = perimeter(loop);
  if (!anchors?.length) return tabWindows({ count, width, loopLength: total, toolDiameter });
  if (!(width > 0) || !(total > 0)) return [];
  const half = (width + toolDiameter) / 2;
  const windows = [];
  for (const [x, y] of anchors) {
    const { s, d } = arcOfNearest(loop, x, y);
    if (d > reach) continue;      // another profile's tab
    const a = s - half;
    const b = s + half;
    if (a < 0) {
      windows.push([a + total, total]);
      windows.push([0, b]);
    } else if (b > total) {
      windows.push([a, total]);
      windows.push([0, b - total]);
    } else {
      windows.push([a, b]);
    }
  }
  return windows.length ? windows : tabWindows({ count, width, loopLength: total, toolDiameter });
}

/**
 * What a ramp or a plunge along `loop` has to keep above, lapping at `z`: the
 * tab top over the windows, nothing elsewhere. Null where there is nothing to
 * keep above — no tabs, or a lap above them.
 *
 * @returns { total, tabZ, windows, floorAt(s) } — `s` the distance along the
 *   loop from its first point, any number of laps round
 */
export function tabLift(loop, tabs, z) {
  if (!tabs || !(tabs.count > 0) || !(tabs.height > 0)) return null;
  const tabZ = tabs.topZ ?? z + tabs.height;
  if (!(tabZ > z + 1e-9)) return null;
  const windows = windowsOn(loop, tabs);
  if (windows.length === 0) return null;
  const total = perimeter(loop);
  return {
    total,
    tabZ,
    windows,
    floorAt: (s) => (insideAny(windows, ((s % total) + total) % total) ? tabZ : -Infinity),
  };
}

/**
 * The same loop, started where no tab is: the first point past the window
 * its start is in. A pass comes down, and steps onto the wall, at its start —
 * straight through a tab that happens to be there. Unchanged when the start
 * is clear already, or when the tabs cover the whole loop.
 */
export function startClearOfTabs(loop, tabs) {
  if (!tabs || !(tabs.count > 0) || !(tabs.height > 0) || loop.length < 6) return loop;
  const windows = windowsOn(loop, tabs);
  if (!insideAny(windows, 0)) return loop;
  const total = perimeter(loop);
  let s = 0;
  for (let guard = 0; guard < windows.length + 1 && insideAny(windows, s); guard++) {
    let end = s;
    for (const [a, b] of windows) if (s >= a && s <= b) end = Math.max(end, b);
    s = end + 1e-6;
  }
  if (s >= total || insideAny(windows, s)) return loop;
  return startingAt(loop, s);
}

/** `loop` begun `s` along it, the point there becoming its first. */
function startingAt(loop, s) {
  const n = loop.length / 2;
  let left = s;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const len = Math.hypot(loop[j * 2] - loop[i * 2], loop[j * 2 + 1] - loop[i * 2 + 1]);
    if (left < len) {
      const t = len > 0 ? left / len : 0;
      const out = [loop[i * 2] + (loop[j * 2] - loop[i * 2]) * t,
        loop[i * 2 + 1] + (loop[j * 2 + 1] - loop[i * 2 + 1]) * t];
      for (let k = 1; k <= n; k++) {
        const idx = (i + k) % n;
        out.push(loop[idx * 2], loop[idx * 2 + 1]);
      }
      return out;
    }
    left -= len;
  }
  return loop;
}

/**
 * The stretches of a lap `cutPerimeterWithTabs` walks at depth, as open
 * polylines — everything but the windows it rides over at the tab top. What a
 * lap with tabs has cut is these at depth and the rest only down to the tabs,
 * and a pass that comes down beside it afterwards has to know which is which.
 */
export function spansBetweenTabs(loop, tabs) {
  const windows = windowsOn(loop, tabs);
  const n = loop.length / 2;
  if (windows.length === 0) return [[...loop, loop[0], loop[1]]];
  const spans = [];
  let span = null;
  const at = (ax, ay, bx, by, t) => [ax + (bx - ax) * t, ay + (by - ay) * t];
  let s = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = [loop[i * 2], loop[i * 2 + 1]];
    const j = (i + 1) % n;
    const [bx, by] = [loop[j * 2], loop[j * 2 + 1]];
    const segLen = Math.hypot(bx - ax, by - ay);
    if (segLen < 1e-9) continue;
    const cuts = [0, segLen];
    for (const [a, b] of windows) {
      for (const bound of [a, b]) {
        const local = bound - s;
        if (local > 1e-6 && local < segLen - 1e-6) cuts.push(local);
      }
    }
    cuts.sort((p, q) => p - q);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const mid = s + (cuts[k] + cuts[k + 1]) / 2;
      if (insideAny(windows, mid)) {
        if (span) { spans.push(span); span = null; }
        continue;
      }
      const p = at(ax, ay, bx, by, cuts[k] / segLen);
      const q = at(ax, ay, bx, by, cuts[k + 1] / segLen);
      if (!span) span = [...p];
      span.push(...q);
    }
    s += segLen;
  }
  if (span) {
    // a stretch running on through the loop's start joins the one it began with
    if (spans.length && !insideAny(windows, 0)) spans[0] = [...span, ...spans[0].slice(2)];
    else spans.push(span);
  }
  return spans;
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
export function cutPerimeterWithTabs(cl, loop, z, tabs) {
  const { height, topZ = null } = tabs;
  const total = perimeter(loop);
  const windows = windowsOn(loop, tabs);
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
