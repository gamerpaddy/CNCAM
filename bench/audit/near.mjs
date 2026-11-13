// STOCK_TOP=5 node bench/audit/near.mjs part type tool x y z [k=v ...] — the moves around the first one near (x, y, z)
import { loadPart, TOOLS, generate } from './lib.js';
import { eachMove } from '../../src/engine/cl.js';
const [n, type, tt, x0, y0, z0, ...kv] = process.argv.slice(2);
const extra = {}; for (const a of kv) { const [k, v] = a.split('='); extra[k] = isNaN(+v) ? v : +v; }
const { cl } = generate(type, TOOLS[tt], loadPart(n), extra);
const rows = []; eachMove(cl, (op, x, y, z, i, j, k, feed, index) => rows.push([index, op, feed, +x.toFixed(2), +y.toFixed(2), +z.toFixed(2)]));
const hit = rows.findIndex((r) => Math.abs(r[3] - +x0) < 0.3 && Math.abs(r[4] - +y0) < 0.3 && Math.abs(r[5] - +z0) < 0.3);
console.log('hit', hit, 'of', rows.length, ' [index, op, feed, x, y, z]');
for (let q = Math.max(0, hit - 4); q < Math.min(rows.length, hit + 5); q++) console.log(rows[q].join(' '));
console.log(JSON.stringify((cl.notes ?? []).map((n) => n.text.slice(0, 160))));
if (process.env.ORDER) { const seq = []; let last = null; for (const r of rows) { if (r[1] === 1 && r[2] !== 0) { const z = r[5].toFixed(1); if (z !== last) { seq.push(z + '@' + r[0]); last = z; } } } console.log('level order:', seq.slice(0, 60).join(' ')); }
