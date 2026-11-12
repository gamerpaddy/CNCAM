// node bench/audit/hash.mjs part type tool [k=v ...] — generation time and a hash of the program, to prove a speed-up changed nothing
import { loadPart, TOOLS, generate } from './lib.js';
import { MOVE_STRIDE } from '../../src/engine/cl.js';
const [n, type, tt, ...kv] = process.argv.slice(2);
const extra = {}; for (const a of kv) { const [k, v] = a.split('='); extra[k] = isNaN(+v) ? v : +v; }
const best = [];
let h = 0, moves = 0;
for (let r = 0; r < 2; r++) { const { cl, gen } = generate(type, TOOLS[tt], loadPart(n), extra); best.push(gen); moves = cl.count; h = 0; const d = cl.moves; for (let i = 0; i < cl.count * MOVE_STRIDE; i++) h = (h * 31 + Math.round(d[i] * 1000)) | 0; }
console.log(`${n}/${type}/${tt}: ${Math.min(...best).toFixed(2)}s ${moves} moves hash ${h}`);
