// node [--cpu-prof] bench/audit/profile.mjs part type tool [k=v ...] — one generation, timed
import { loadPart, TOOLS, generate } from './lib.js';
const [n, type, tt, ...kv] = process.argv.slice(2);
const extra = {}; for (const a of kv) { const [k, v] = a.split('='); extra[k] = isNaN(+v) ? v : +v; }
const { cl, gen } = generate(type, TOOLS[tt], loadPart(n), extra);
console.log(`${n}/${type}/${tt}: ${gen.toFixed(2)}s, ${cl.count} moves`);
