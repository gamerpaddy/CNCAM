// node bench/audit/levels.mjs part type tool [k=v ...] — cutting length by level (rounded to 0.1mm)
import { loadPart, TOOLS, generate } from './lib.js';
import { eachMove, OP, FEED } from '../../src/engine/cl.js';
const [n, type, tt, ...kv] = process.argv.slice(2);
const extra = {}; for (const a of kv) { const [k, v] = a.split('='); extra[k] = isNaN(+v) ? v : +v; }
const { cl } = generate(type, TOOLS[tt], loadPart(n), extra);
const by = new Map(); let prev = null;
eachMove(cl, (op, x, y, z, i, j, k, feed) => { if (prev && op === OP.LINE && feed !== FEED.RAPID && Math.abs(z - prev[2]) < 1e-3) { const key = z.toFixed(1); by.set(key, (by.get(key) ?? 0) + Math.hypot(x - prev[0], y - prev[1])); } prev = [x, y, z]; });
console.log([...by].sort((a, b) => b[0] - a[0]).filter(([, l]) => l > 40).map(([k, l]) => `${k}:${l.toFixed(0)}`).join(' '));
