// A second reading of a posted file, written without looking at post/parse.js.
//
// A modal interpreter for the words the posts are allowed to write, turned back
// into a list of straight pieces, and compared with the CL the file was printed
// from. If the two disagree by more than the arc tolerance, one of them is
// wrong — and because this file shares no code with the post or with the app's
// own read-back, it cannot be wrong in the same way.
//
//   const R = await import('/bench/audit/readback.js');
//   const file = R.interpret(lines);                 // { segs, unknown }
//   const path = R.clSegments(cl);
//   R.strayOf(file.segs, path);                      // file strays from path by…
//   R.strayOf(path, file.segs);                      // …and the path from the file

import { OP, MOVE_STRIDE } from '/src/engine/cl.js';

const KNOWN_G = new Set([17, 18, 19, 20, 21, 40, 43, 49, 54, 55, 56, 57, 58, 59, 64, 61, 94, 93,
  95, 96, 97, 4, 28, 30, 92, 68.2, 69, 43.4, 7, 8, 33, 76, 10]);
const CYCLES = new Set([81, 82, 83, 73, 33.1, 84, 74]);

/** Posted lines -> { segs: [{ rapid, a, b, f, line, tag }], unknown } (arcs as chords). */
export function interpret(lines, { chord = 0.002, lathe = false } = {}) {
  const out = [];
  const unknown = new Map();
  const note = (k, v = 1) => unknown.set(k, (unknown.get(k) ?? 0) + v);
  const lost = () => (lathe ? [NaN, 0, NaN] : [NaN, NaN, NaN]);
  let pos = lost();
  let motion = 0;
  let feed = NaN;
  let abs = true;
  let cycle = null;
  let retractInitial = true;
  let initialZ = NaN;
  const push = (rapid, to, n, tag = '') => {
    out.push({ rapid, a: pos.slice(), b: to.slice(), f: rapid ? 0 : feed, line: n, tag });
    pos = to.slice();
  };
  lines.forEach((raw, n) => {
    const text = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim().toUpperCase();
    if (!text || text === '%') return;
    const words = [...text.matchAll(/([A-Z])\s*([-+]?\d*\.?\d+)/g)].map((m) => [m[1], parseFloat(m[2])]);
    const get = (l) => { const w = words.find((x) => x[0] === l); return w ? w[1] : undefined; };
    let machineCoords = false;
    let threading = false;
    for (const [l, v] of words) {
      if (l !== 'G') continue;
      if (v === 0 || v === 1 || v === 2 || v === 3) { motion = v; cycle = null; }
      else if (v === 33) { motion = 1; threading = true; cycle = null; }
      else if (v === 90) abs = true;
      else if (v === 91) abs = false;
      else if (v === 53) machineCoords = true;
      else if (v === 80) { cycle = null; motion = 0; }
      else if (v === 98) retractInitial = true;
      else if (v === 99) retractInitial = false;
      else if (CYCLES.has(v)) { if (!cycle) initialZ = pos[2]; cycle = { g: v }; }
      else if (!KNOWN_G.has(v)) note('G' + v);
    }
    if (get('F') !== undefined) feed = get('F');
    let X = get('X'); const Y = get('Y'); const Z = get('Z');
    if (lathe && X !== undefined) X /= 2;            // a lathe file states diameters
    if (X === undefined && Y === undefined && Z === undefined) return;
    if (machineCoords) { pos = lost(); return; }
    if (words.some(([l, v]) => l === 'G' && (v === 28 || v === 30 || v === 92 || v === 10 || v === 4))) return;
    const target = pos.slice();
    const set = (i, v) => { if (v !== undefined) target[i] = abs ? v : pos[i] + v; };
    if (cycle) {
      set(0, X); set(1, Y);
      if (Z !== undefined) cycle.z = Z;
      if (get('R') !== undefined) cycle.r = get('R');
      if (get('Q') !== undefined) cycle.q = get('Q');
      if (cycle.g === 33.1) {            // rigid tap: down and back from where it stands
        const top = pos.slice();
        push(false, [pos[0], pos[1], cycle.z], n, 'tap');
        push(false, top, n, 'tap');
        return;
      }
      const z0 = Number.isFinite(initialZ) ? initialZ : pos[2];
      push(true, [target[0], target[1], pos[2]], n, 'cycle');
      push(true, [target[0], target[1], cycle.r], n, 'cycle');
      push(false, [target[0], target[1], cycle.z], n, 'cycle');
      push(true, [target[0], target[1], retractInitial ? Math.max(z0, cycle.r) : cycle.r], n, 'cycle');
      return;
    }
    set(0, X); set(1, Y); set(2, Z);
    if (motion === 0 || motion === 1) { push(motion === 0, target, n, threading ? 'thread' : ''); return; }
    // an arc in XY (G17), helical when Z moves
    const I = get('I'); const J = get('J'); const R = get('R');
    let cx; let cy;
    if (I !== undefined || J !== undefined) { cx = pos[0] + (I ?? 0); cy = pos[1] + (J ?? 0); }
    else {
      const dx = target[0] - pos[0]; const dy = target[1] - pos[1];
      const d = Math.hypot(dx, dy);
      const h = Math.sqrt(Math.max(0, R * R - (d * d) / 4));
      const sign = (motion === 2) === (R > 0) ? -1 : 1;
      cx = pos[0] + dx / 2 - sign * h * (dy / d); cy = pos[1] + dy / 2 + sign * h * (dx / d);
    }
    const r0 = Math.hypot(pos[0] - cx, pos[1] - cy);
    const r1 = Math.hypot(target[0] - cx, target[1] - cy);
    if (Math.abs(r0 - r1) > 0.005) unknown.set('arc radius mismatch', Math.max(unknown.get('arc radius mismatch') ?? 0, Math.abs(r0 - r1)));
    const a0 = Math.atan2(pos[1] - cy, pos[0] - cx);
    let turn = Math.atan2(target[1] - cy, target[0] - cx) - a0;
    if (motion === 2) { while (turn >= -1e-12) turn -= 2 * Math.PI; } else { while (turn <= 1e-12) turn += 2 * Math.PI; }
    const steps = Math.max(2, Math.ceil(Math.abs(turn) / (2 * Math.acos(Math.max(0, 1 - chord / Math.max(r0, chord))))));
    const from = pos.slice();
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const a = a0 + turn * t;
      const rr = r0 + (r1 - r0) * t;
      push(false, s === steps ? target : [cx + rr * Math.cos(a), cy + rr * Math.sin(a), from[2] + (target[2] - from[2]) * t], n, 'arc');
    }
  });
  return { segs: out, unknown: Object.fromEntries(unknown) };
}

/** A CL as the same list of straight pieces, drill cycles opened out. */
export function clSegments(cl) {
  const m = cl.moves;
  const out = [];
  let pos = [NaN, NaN, NaN];
  for (let i = 0; i + MOVE_STRIDE <= m.length; i += MOVE_STRIDE) {
    const o = m[i];
    const to = [m[i + 1], m[i + 2], m[i + 3]];
    if (o === OP.DRILL) {
      const top = [to[0], to[1], pos[2]];
      out.push({ rapid: true, a: pos.slice(), b: top });
      out.push({ rapid: true, a: top, b: [to[0], to[1], m[i + 4]] });
      out.push({ rapid: false, a: [to[0], to[1], m[i + 4]], b: to, drill: true });
      pos = [to[0], to[1], pos[2]];
      continue;
    }
    out.push({ rapid: o === OP.RAPID, a: pos.slice(), b: to, cls: m[i + 7] });
    pos = to;
  }
  return out;
}

/**
 * The furthest any piece of `from` strays from the pieces of `onto`, both
 * filtered to feed moves (or to rapids with `rapids: true`).
 */
export function strayOf(from, onto, { step = 0.2, cellSize = 2, rapids = false } = {}) {
  const grid = new Map();
  const key = (i, j, k) => (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
  const wanted = (s) => s.rapid === rapids && s.a.every(Number.isFinite) && s.b.every(Number.isFinite);
  const target = onto.filter(wanted);
  target.forEach((s, n) => {
    const lo = [0, 1, 2].map((d) => Math.floor((Math.min(s.a[d], s.b[d]) - 0.1) / cellSize));
    const hi = [0, 1, 2].map((d) => Math.floor((Math.max(s.a[d], s.b[d]) + 0.1) / cellSize));
    for (let i = lo[0]; i <= hi[0]; i++) {
      for (let j = lo[1]; j <= hi[1]; j++) {
        for (let k = lo[2]; k <= hi[2]; k++) {
          const h = key(i, j, k);
          let cell = grid.get(h);
          if (!cell) grid.set(h, cell = []);
          cell.push(n);
        }
      }
    }
  });
  const dist = (p, s) => {
    const d = [s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]];
    const L = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - s.a[0]) * d[0] + (p[1] - s.a[1]) * d[1] + (p[2] - s.a[2]) * d[2]) / L)) : 0;
    return Math.hypot(p[0] - s.a[0] - d[0] * t, p[1] - s.a[1] - d[1] * t, p[2] - s.a[2] - d[2] * t);
  };
  let worst = 0; let at = null; let length = 0; let lost = 0;
  for (const s of from) {
    if (!wanted(s)) continue;
    const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]);
    length += L;
    const n = Math.max(1, Math.ceil(L / step));
    for (let q = 0; q <= n; q++) {
      const p = [0, 1, 2].map((d) => s.a[d] + ((s.b[d] - s.a[d]) * q) / n);
      const cell = grid.get(key(...p.map((v) => Math.floor(v / cellSize))));
      let best = Infinity;
      if (cell) for (const idx of cell) { const dd = dist(p, target[idx]); if (dd < best) best = dd; }
      if (!Number.isFinite(best)) { lost++; best = cellSize; }
      if (best > worst) { worst = best; at = { p: p.map((v) => +v.toFixed(3)), line: s.line ?? null }; }
    }
  }
  return { worst: +worst.toFixed(4), at, length: Math.round(length), lost };
}

/** Every feed in the file that is not one the operation was given: { F: metres of path }. */
export function feedsUsed(segs) {
  const by = {};
  for (const s of segs) {
    if (s.rapid || !s.a.every(Number.isFinite)) continue;
    const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]);
    const k = Number.isFinite(s.f) ? String(s.f) : 'NONE';
    by[k] = (by[k] ?? 0) + L;
  }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Math.round(v)]));
}
