// node bench/audit/draw.mjs part type tool zmin zmax out.png [k=v ...]
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { TOOLS, loadPart, generate, Material, measure } from './lib.js';
import { cuttingRadiusOf } from '../../src/engine/tool-geometry.js';
const [partName, type, toolName, zmin, zmax, out, ...kv] = process.argv.slice(2);
const extra = {}; for (const a of kv) { const [k, v] = a.split('='); extra[k] = isNaN(+v) ? v : +v; }
const part = loadPart(partName); const tool = TOOLS[toolName];
const { cl } = generate(type, tool, part, extra);
const pre = process.env.AFTER_ROUGH ? (() => { const g = generate('adaptive', TOOLS.flat, part); const m = new Material(part.stock, 0.15); measure(g.cl, TOOLS.flat, part.stock, m); return m; })() : null; // FINISH_AFTER
const S = 8; const st = part.stock;
const W = Math.ceil((st.max[0] - st.min[0] + 20) * S), H = Math.ceil((st.max[1] - st.min[1] + 20) * S);
const img = new Uint8Array(W * H * 3).fill(255);
const px = (x, y, c) => { const i = Math.round((x - st.min[0] + 10) * S), j = H - 1 - Math.round((y - st.min[1] + 10) * S); if (i < 0 || j < 0 || i >= W || j >= H) return; const o = (j * W + i) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; };
const line = (a, b, c) => { const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * S)); for (let k = 0; k <= n; k++) px(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, c); };
// stock outline
line([st.min[0], st.min[1]], [st.max[0], st.min[1]], [0, 0, 0]); line([st.max[0], st.min[1]], [st.max[0], st.max[1]], [0, 0, 0]); line([st.max[0], st.max[1]], [st.min[0], st.max[1]], [0, 0, 0]); line([st.min[0], st.max[1]], [st.min[0], st.min[1]], [0, 0, 0]);
const stats = {};
const phaseAt = (i) => { let ph = '?'; for (const e of cl.events ?? []) { if (e.type === 'phase' && e.index <= i) ph = e.name; } return ph; }; const segs = [];
measure(cl, tool, st, pre ? (() => { const m = new Material(part.stock, pre.cell); m.top.set(pre.top); return m; })() : null, (a, b, feed, vol, len, rapid, index) => {
  const z = Math.min(a[2], b[2]);
  if (z < +zmin || z > +zmax) return;
  let c; let k;
  if (rapid) { c = [80, 120, 255]; k = 'rapid'; }
  else if (feed === 4) { c = [160, 0, 200]; k = 'plunge'; }
  else {
    const q = vol / Math.max(0.1, len);
    if (q < 0.02) { c = [255, 0, 0]; k = feed === 2 ? 'air-lead' : 'air-cut'; }
    else if (q < 0.4) { c = [255, 170, 0]; k = 'thin'; }
    else { c = [0, 160, 0]; k = 'cut'; }
    if (feed === 2 && q >= 0.02) { c = [0, 160, 160]; k = 'lead'; }
  }
  stats[k] = (stats[k] ?? 0) + len;
  if (process.env.PHASE) { const ph = phaseAt(index); k = k.startsWith('air') ? 'air-' + ph : k === 'cut' ? 'cut-' + ph : k; stats[k] = (stats[k] ?? 0) + len; if (!rapid && ph !== '?') c = ph === 'peel' ? (k.startsWith('air') ? [255, 0, 0] : [0, 170, 0]) : ph === 'seed' ? (k.startsWith('air') ? [255, 120, 0] : [0, 0, 255]) : ph === 'wall' ? [200, 0, 200] : [0, 0, 0]; }
  segs.push([a, b, c, k, rapid]);
});
segs.forEach(([a, b, c, k, rapid], n) => { if (process.env.ONLYAIR) { if (k === 'air-cut') c = [255, 0, 0]; else if (k === 'air-lead') c = [255, 150, 0]; else c = [215, 215, 215]; if (rapid) return; } if (process.env.TIME && !rapid) { const t = n / segs.length; c = k.startsWith('air') ? [255, 0, 0] : [0, Math.floor(200 * (1 - t)), Math.floor(255 * t)]; if (k === 'plunge') c = [255, 0, 255]; } line(a, b, c); });
console.log(JSON.stringify(Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Math.round(v)]))));
// png
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const b = Buffer.alloc(8 + d.length + 4); b.writeUInt32BE(d.length, 0); b.write(t, 4); Buffer.from(d).copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
const raw = Buffer.alloc((W * 3 + 1) * H); for (let j = 0; j < H; j++) { raw[j * (W * 3 + 1)] = 0; Buffer.from(img.buffer, j * W * 3, W * 3).copy(raw, j * (W * 3 + 1) + 1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
