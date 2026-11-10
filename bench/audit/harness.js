// An audit that owes nothing to the code it audits.
//
//   const A = await (await import('/bench/audit/harness.js')).attach();
//
// The app's own tests ask the app's own simulator what a toolpath did. This
// asks the toolpath: it reads the CL moves an operation produced, sweeps a
// cutter it describes for itself over a grid it keeps for itself, and compares
// what is left with the part as a formula — the dimensions the sample parts
// were written from (samples/make-test-parts.mjs), not their meshes.
//
// Nothing here imports engine/simulate.js, engine/tool-geometry.js or
// geom/heightmap.js. The only things taken from the app are the opcodes of the
// CL format and the project it is driven through.

import { OP, FEED, MOVE_STRIDE } from '/src/engine/cl.js';
import { estimateSeconds as estimate } from '/src/engine/toolpath.js';

// ------------------------------------------------------------------ the parts
//
// Height of the finished part above (x, y) in the part's own coordinates, and
// -Infinity where there is no part (off the edge, down a through hole).

const NONE = -Infinity;

export const PARTS = {
  'test-step-plate': {
    size: [100, 70, 22],
    z(x, y) {
      if (x < 0 || x > 100 || y < 0 || y > 70) return NONE;
      if (y > 60 && y < 66) return 6;
      if (x > 32 && x < 68 && y > 25 && y < 45) return 15;
      if (x >= 20 && x <= 80 && y >= 15 && y <= 55) return 22;
      return 12;
    },
  },
  'test-hole-plate': {
    size: [90, 60, 14],
    holes: [
      { x: 15, y: 15, r: 3 }, { x: 75, y: 15, r: 3 }, { x: 15, y: 45, r: 3 }, { x: 75, y: 45, r: 3 },
      { x: 45, y: 12, r: 5 }, { x: 45, y: 42, r: 10 }, { x: 63, y: 30, r: 4, floor: 5 },
    ],
    z(x, y) {
      if (x < 0 || x > 90 || y < 0 || y > 60) return NONE;
      for (const h of this.holes) {
        if (Math.hypot(x - h.x, y - h.y) < h.r) return h.floor ?? NONE;
      }
      return 14;
    },
  },
  'test-slope': {
    size: [90, 72, 30],
    // The ramp and the dome as formulas...
    ideal(x, y) {
      let z = 8;
      if (x < 36) z = Math.max(z, 8 + 18 * (1 - x / 36));
      const d = Math.hypot(x - 63, y - 36);
      if (d < 22) z = Math.max(z, 8 + Math.sqrt(22 * 22 - d * d));
      return z;
    },
    // ...and as the part that was actually written: those formulas sampled on a
    // 1.5mm grid and joined with flat triangles, split along the a-c diagonal.
    // Round the foot of the dome the two differ by most of a millimetre, and it
    // is the triangles the app is asked to machine.
    z(x, y) {
      if (x < 0 || x > 90 || y < 0 || y > 72) return NONE;
      const s = 1.5;
      const i = Math.min(59, Math.floor(x / s));
      const j = Math.min(47, Math.floor(y / s));
      const u = x / s - i;
      const v = y / s - j;
      const za = this.ideal(i * s, j * s);
      const zb = this.ideal((i + 1) * s, j * s);
      const zc = this.ideal((i + 1) * s, (j + 1) * s);
      const ze = this.ideal(i * s, (j + 1) * s);
      return u >= v ? za + u * (zb - za) + v * (zc - zb) : za + u * (zc - ze) + v * (ze - za);
    },
  },
};

// ---------------------------------------------------------------- the cutters
//
// How far the cutter's surface stands above its own tip at a distance d from
// its axis. The tip is the point the CL data names.

export function profileOf(tool) {
  const R = tool.diameter / 2;
  const type = tool.type;
  if (type === 'ball') return (d) => R - Math.sqrt(Math.max(0, R * R - d * d));
  if (type === 'bull') {
    const cr = Math.min(tool.cornerRadius ?? 0, R);
    const flat = R - cr;
    return (d) => (d <= flat ? 0 : cr - Math.sqrt(Math.max(0, cr * cr - (d - flat) * (d - flat))));
  }
  if (type === 'chamfer' || type === 'drill' || type === 'spot' || type === 'vbit' || type === 'center') {
    const half = ((tool.tipAngle ?? (type === 'drill' ? 118 : 90)) / 2) * Math.PI / 180;
    const tipR = (tool.tipDiameter ?? 0) / 2;
    const slope = 1 / Math.tan(half);
    return (d) => (d <= tipR ? 0 : (d - tipR) * slope);
  }
  return () => 0;            // flat, face mill, and anything square-ended
}

// ------------------------------------------------------------------- the grid

/**
 * A field of heights over the billet, cut by stamping the cutter along every
 * move. A stamp only ever removes what the cutter really occupies at a point it
 * really visits, so the field is never lower than the truth: a gouge it reports
 * is a gouge.
 */
export class Field {
  constructor(stock, cell = 0.25) {
    // off the round numbers on purpose: no cell centre sits on a wall of a part
    // dimensioned in whole millimetres, so "is this cell inside" is never a tie
    const pad = 2;
    this.cell = cell;
    this.x0 = stock.min[0] - pad + 0.0613;
    this.y0 = stock.min[1] - pad + 0.0371;
    this.w = Math.ceil((stock.max[0] - stock.min[0] + 2 * pad) / cell);
    this.h = Math.ceil((stock.max[1] - stock.min[1] + 2 * pad) / cell);
    this.z = new Float32Array(this.w * this.h).fill(NONE);
    this.stock = stock;
    for (let j = 0; j < this.h; j++) {
      const y = this.y0 + j * cell;
      if (y < stock.min[1] || y > stock.max[1]) continue;
      for (let i = 0; i < this.w; i++) {
        const x = this.x0 + i * cell;
        if (x < stock.min[0] || x > stock.max[0]) continue;
        this.z[j * this.w + i] = stock.max[2];
      }
    }
  }

  clone() {
    const f = Object.create(Field.prototype);
    Object.assign(f, this);
    f.z = this.z.slice();
    return f;
  }

  /** Stamp the cutter with its tip at (x, y, z). Returns the volume it took, mm³. */
  stamp(x, y, z, R, prof, floor = NONE) {
    const c = this.cell;
    const i0 = Math.max(0, Math.ceil((x - R - this.x0) / c));
    const i1 = Math.min(this.w - 1, Math.floor((x + R - this.x0) / c));
    const j0 = Math.max(0, Math.ceil((y - R - this.y0) / c));
    const j1 = Math.min(this.h - 1, Math.floor((y + R - this.y0) / c));
    let took = 0;
    const R2 = R * R;
    for (let j = j0; j <= j1; j++) {
      const dy = this.y0 + j * c - y;
      for (let i = i0; i <= i1; i++) {
        const dx = this.x0 + i * c - x;
        const d2 = dx * dx + dy * dy;
        if (d2 > R2) continue;
        const zc = z + prof(Math.sqrt(d2));
        const k = j * this.w + i;
        const was = this.z[k];
        if (zc < was) {
          took += (was - Math.max(zc, floor)) > 0 ? (was - Math.max(zc, floor)) : 0;
          this.z[k] = zc;
        }
      }
    }
    return took * c * c;
  }

  at(x, y) {
    const i = Math.round((x - this.x0) / this.cell);
    const j = Math.round((y - this.y0) / this.cell);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return NONE;
    return this.z[j * this.w + i];
  }
}

/**
 * Run one operation's moves over the field.
 *
 * @param from where the tool is when the operation starts, or null
 * @returns what the moves did, by kind
 */
export function sweep(field, cl, tool, { from = null, floorZ = NONE } = {}) {
  const R = tool.diameter / 2;
  const prof = profileOf(tool);
  const d = cl.moves;
  const step = field.cell * 0.5;
  const out = {
    cutLen: 0, rapidLen: 0, airLen: 0, plungeLen: 0,
    cutVol: 0, rapidVol: 0, rapidHits: [], retracts: 0, moves: cl.count,
    steepCut: 0, steepCutAt: null, lowest: Infinity, drills: 0,
    airBy: {}, airMoves: [], lenBy: {}, airZ: {}, lenZ: {},
    // feed moves that go down into metal faster than a ramp may: the vertical
    // share of the move, weighted by what it removed
  };
  let p = from;
  for (let n = 0; n < cl.count; n++) {
    const o = n * MOVE_STRIDE;
    const code = d[o];
    if (code === OP.DRILL) {
      const x = d[o + 1]; const y = d[o + 2]; const zb = d[o + 3]; const zr = d[o + 4];
      // the way there, at rapid
      if (p) {
        const len = Math.hypot(x - p[0], y - p[1], zr - p[2]);
        const m = Math.max(1, Math.ceil(len / step));
        let v = 0;
        for (let s = 1; s <= m; s++) {
          const t = s / m;
          v += field.stamp(p[0] + (x - p[0]) * t, p[1] + (y - p[1]) * t, p[2] + (zr - p[2]) * t, R, prof, floorZ);
        }
        out.rapidLen += len;
        if (v > 0.05) { out.rapidVol += v; out.rapidHits.push({ n, v: +v.toFixed(2), at: [x, y, zr].map((q) => +q.toFixed(2)) }); }
      }
      const m = Math.max(1, Math.ceil((zr - zb) / step));
      for (let s = 0; s <= m; s++) out.cutVol += field.stamp(x, y, zr + (zb - zr) * (s / m), R, prof, floorZ);
      out.plungeLen += zr - zb;
      out.drills++;
      if (zb < out.lowest) out.lowest = zb;
      p = [x, y, zr];
      continue;
    }
    const q = [d[o + 1], d[o + 2], d[o + 3]];
    // A leaned ball is the same sphere wherever its shank points: stamp it as the
    // upright ball whose centre is where the leaned one has its own.
    const lean = Math.hypot(d[o + 4], d[o + 5], d[o + 6]);
    if (tool.type === 'ball' && lean > 0.9 && lean < 1.1) {
      q[0] += (R * d[o + 4]) / lean; q[1] += (R * d[o + 5]) / lean; q[2] += R * (d[o + 6] / lean - 1);
      out.leaned = Math.max(out.leaned ?? 0, Math.acos(Math.min(1, d[o + 6] / lean)) * 180 / Math.PI);
    }
    if (!p) { p = q; continue; }
    const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    const m = Math.max(1, Math.ceil(len / step));
    let v = 0;
    for (let s = 1; s <= m; s++) {
      const t = s / m;
      v += field.stamp(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, R, prof, floorZ);
    }
    if (code === OP.RAPID) {
      out.rapidLen += len;
      if (q[2] > p[2] + 1e-6 && Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6) out.retracts++;
      if (v > 0.05) { out.rapidVol += v; out.rapidHits.push({ n, v: +v.toFixed(2), from: p.map((a) => +a.toFixed(2)), to: q.map((a) => +a.toFixed(2)) }); }
    } else {
      const fc = d[o + 7];
      out.cutLen += len;
      out.cutVol += v;
      out.lenBy[fc] = (out.lenBy[fc] ?? 0) + len;
      const zk = (Math.abs(q[2] - p[2]) < 1e-6 ? '' : '~') + q[2].toFixed(1);
      out.lenZ[zk] = (out.lenZ[zk] ?? 0) + len;
      if (v < 1e-4 * len) out.airZ[zk] = (out.airZ[zk] ?? 0) + len;
      if (v < 1e-4 * len) {
        out.airLen += len;
        out.airBy[fc] = (out.airBy[fc] ?? 0) + len;
        if (len > 3) out.airMoves.push({ n, fc, len: +len.toFixed(1), from: p.map((a) => +a.toFixed(2)), to: q.map((a) => +a.toFixed(2)) });
      }
      if (fc === FEED.PLUNGE) out.plungeLen += len;
      // a straight plunge that takes metal: fine for a drill, not for an end mill
      if (fc === FEED.PLUNGE && v > 0.5 && Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6) {
        (out.plungeHits ??= []).push({ n, v: +v.toFixed(1), from: p.map((a) => +a.toFixed(2)), to: q.map((a) => +a.toFixed(2)) });
      }
      if (q[2] < out.lowest) out.lowest = q[2];
      // a move classed as a plain cut that is in fact going down into metal
      const dz = p[2] - q[2];
      if (fc !== FEED.PLUNGE && fc !== FEED.RAMP && dz > 0.02 && len > 1e-6 && v > 0.5) {
        const steep = dz / len;
        if (steep > out.steepCut) { out.steepCut = steep; out.steepCutAt = { n, from: p.map((a) => +a.toFixed(2)), to: q.map((a) => +a.toFixed(2)), v: +v.toFixed(1) }; }
      }
    }
    p = q;
  }
  out.end = p;
  return out;
}

/**
 * The field against the part.
 *
 * @param partZ (x, y) in the field's coordinates → finished height
 * @param allow { radial, axial } what the operation promised to leave
 * @param where optional (x, y) → bool: the ground this operation was asked to finish
 */
export function compare(field, partZ, { radial = 0, axial = 0, where = null, tol = 0.02, before = null } = {}) {
  const c = field.cell;
  let gouge = 0; let gougeCells = 0; let gougeAt = null;
  let under = 0; let underCells = 0; let underAt = null;   // into the allowance
  let left = 0; let leftAt = null; let leftSum = 0; let leftN = 0; let leftOver = 0;
  // The part grown by the allowance: an ellipsoid `radial` wide and `axial`
  // tall rolled over it. On a slope that is a good deal less than "out by the
  // radial and then up by the axial", which is what a square offset would say.
  const ring = [];
  if (radial > 0) {
    for (const f of [1, 0.85, 0.6, 0.3]) {
      const lift = axial * Math.sqrt(1 - f * f);
      for (let a = 0; a < 16; a++) ring.push([Math.cos(a * Math.PI / 8) * radial * f, Math.sin(a * Math.PI / 8) * radial * f, lift]);
    }
  }
  for (let j = 0; j < field.h; j++) {
    const y = field.y0 + j * c;
    for (let i = 0; i < field.w; i++) {
      const x = field.x0 + i * c;
      const h = field.z[j * field.w + i];
      let pz = partZ(x, y);
      if (h === NONE) continue;
      // through a hole, or off the edge of the part inside the billet: asked
      // about by name, the finished height there is the bottom of the stock
      if (pz === NONE) {
        if (where && where(x, y)) {
          const l = h - field.stock.min[2];
          leftSum += Math.max(0, l); leftN++;
          if (l > 0.05) leftOver++;
          if (l > left) { left = l; leftAt = [x, y, h, field.stock.min[2]]; }
        }
        continue;
      }
      const g = pz - h;
      if (g > tol && (!before || h < before[j * field.w + i] - 1e-6)) { gougeCells++; if (g > gouge) { gouge = g; gougeAt = [x, y, h, pz]; } }
      if (radial > 0 || axial > 0) {
        let grown = pz + axial;
        for (const [ox, oy, lift] of ring) { const q = partZ(x + ox, y + oy) + lift; if (q > grown) grown = q; }
        const u = grown - h;
        // only where the cutter has been at all
        if (u > tol + 0.03 && (before ? h < before[j * field.w + i] - 1e-6 : h < field.stock.max[2] - 1e-6)) { underCells++; if (u > under) { under = u; underAt = [x, y, h, grown]; } }
      }
      if (where && where(x, y)) {
        const l = h - pz;
        leftSum += Math.max(0, l); leftN++;
        if (l > axial + 0.05) leftOver++;
        if (l > left) { left = l; leftAt = [x, y, h, pz]; }
      }
    }
  }
  const r = (v) => (v == null ? v : Array.isArray(v) ? v.map((q) => +q.toFixed(3)) : +v.toFixed(3));
  return {
    gouge: r(gouge), gougeCells, gougeAt: r(gougeAt),
    under: r(under), underCells, underAt: r(underAt),
    left: r(left), leftAt: r(leftAt), leftMean: leftN ? r(leftSum / leftN) : null,
    leftOverPct: leftN ? r(100 * leftOver / leftN) : null,
  };
}

// ---------------------------------------------------------- driving the app

export async function attach() {
  const H = await (await import('/src/test/browser-harness.js')).attach();
  const c = window.cncam;
  const A = { H, c, PARTS, Field, sweep, compare, profileOf };

  /** A fresh project with one sample part and one setup; returns { setup, partZ, stock, shift }. */
  A.job = async (partName, machine = 'mill') => {
    H.reset(machine);
    await H.loadModel(`${partName}.stl`);
    c.actions.addSetup();
    const setup = c.doc.project.setups[c.doc.project.setups.length - 1];
    return A.frame(setup, partName);
  };

  /** Where the part sits in the setup's coordinates. */
  A.frame = (setup, partName) => {
    const part = PARTS[partName];
    const b = c.actions.setupModelBounds(setup);
    const stock = c.actions.setupStock(setup);
    const shift = [b.min[0], b.min[1], b.min[2]];
    const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    const partZ = (x, y) => {
      const z = part.z(x - shift[0], y - shift[1]);
      return z === NONE ? NONE : z + shift[2];
    };
    return { setup, part, partZ, stock, shift, size, partName };
  };

  /** Everywhere the part is: the ground an area operation answers for. */
  A.onPart = (job) => (x, y) => job.partZ(x, y) !== NONE;

  A.tool = (name) => c.doc.project.tools.find((t) => t.name === name) ?? H.addTool(name);

  A.op = (job, type, toolName, params = {}) => {
    A.tool(toolName);
    return H.addOp(job.setup, type, params, toolName);
  };

  /**
   * Generate everything, then run the setup's operations in order over one
   * field, reporting each against the part.
   *
   * @param expect opId → { radial, axial, where } what that operation promised
   */
  A.run = async (job, expect = {}, { cell = 0.25, isolate = false, keep = [] } = {}) => {
    const t0 = performance.now();
    await c.actions.generate({ force: true });
    const genMs = performance.now() - t0;
    let field = new Field(job.stock, cell);
    let base = null;      // the field after the operations every isolated run keeps
    const rows = [];
    let from = null;
    for (const op of job.setup.operations) {
      if (!op.enabled) continue;
      const cl = c.doc.toolpaths.get(op.id);
      const tool = c.doc.project.tools.find((t) => t.id === op.toolId);
      if (!cl || !cl.count) {
        rows.push({ op: op.name, type: op.type, EMPTY: true, fail: c.doc.failures?.get?.(op.id) ?? null, notes: (cl?.notes ?? []).map((n) => n.text.slice(0, 160)) });
        continue;
      }
      const t1 = performance.now();
      // A kept operation cuts the billet every isolated one then starts from,
      // wherever in the order it comes.
      if (isolate) {
        base ??= field.clone();
        field = keep.includes(op.id) ? base : base.clone();
      }
      const before = field.z.slice();
      const s = sweep(field, cl, tool, { from: null });
      const e = expect[op.id] ?? {};
      const cmp = compare(field, job.partZ, { ...e, before });
      const r = (v) => +v.toFixed(1);
      rows.push({
        op: op.name, type: op.type, tool: tool.name,
        cut: r(s.cutLen), rapid: r(s.rapidLen), air: r(s.airLen), airPct: s.cutLen ? r(100 * s.airLen / s.cutLen) : 0,
        vol: r(s.cutVol), retracts: s.retracts, drills: s.drills, lowest: +s.lowest.toFixed(3),
        rapidVol: r(s.rapidVol), rapidHits: s.rapidHits.slice(0, 3), nRapidHits: s.rapidHits.length,
        steepCut: +s.steepCut.toFixed(3), steepCutAt: s.steepCutAt,
        plungeHits: (s.plungeHits ?? []).sort((a, b) => b.v - a.v).slice(0, 4), nPlungeHits: (s.plungeHits ?? []).length, leaned: s.leaned ?? 0,
        airBy: Object.fromEntries(Object.entries(s.airBy).map(([k, v]) => [k, r(v)])),
        lenBy: Object.fromEntries(Object.entries(s.lenBy).map(([k, v]) => [k, r(v)])),
        byZ: Object.entries(s.lenZ).filter(([, v]) => v > 20).map(([k, v]) => `${k}: ${Math.round(s.airZ[k] ?? 0)}/${Math.round(v)}`),
        airMoves: s.airMoves.sort((a, b) => b.len - a.len).slice(0, 6), nAir: s.airMoves.length,
        secs: Math.round(estimate(cl, c.doc.rapidFeed())),
        ...cmp,
        notes: (cl.notes ?? []).map((n) => `${n.level}: ${n.text.slice(0, 200)}`),
        sweepMs: Math.round(performance.now() - t1),
      });
      from = s.end;
    }
    return { genMs: Math.round(genMs), rows, field };
  };

  /** One line per operation; the detail only where something is off. */
  A.brief = (res) => res.rows.map((r) => (r.EMPTY ? `${r.op}: EMPTY ${r.fail ?? ''} ${r.notes.join(' | ')}`
    : `${r.op} [${r.tool}] cut ${r.cut} rapid ${r.rapid} air ${r.air} (${r.airPct}%) ${r.secs}s vol ${r.vol} retr ${r.retracts}`
      + ` low ${r.lowest} | gouge ${r.gouge}/${r.gougeCells} under ${r.under}/${r.underCells} left ${r.left} mean ${r.leftMean} over% ${r.leftOverPct}`
      + (r.nRapidHits ? ` | RAPID-IN-METAL ${r.rapidVol}mm3 x${r.nRapidHits} ${JSON.stringify(r.rapidHits[0])}` : '')
      + (r.steepCut > 0.2 ? ` | STEEP ${r.steepCut} ${JSON.stringify(r.steepCutAt)}` : '')
      + (r.nPlungeHits ? ` | PLUNGE-IN-METAL x${r.nPlungeHits} ${JSON.stringify(r.plungeHits[0])}` : '')
      + (r.notes.length ? ` | notes: ${r.notes.join(' / ')}` : ''))).join(String.fromCharCode(10));

  window.A = A;
  return A;
}
