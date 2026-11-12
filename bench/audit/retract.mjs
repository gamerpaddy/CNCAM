// node bench/audit/retract.mjs part type tool [k=v...] — what the rapids are made of
import { loadPart, TOOLS, generate } from './lib.js';
import { eachMove, OP, FEED } from '../../src/engine/cl.js';
const [n, type, tt, ...kv] = process.argv.slice(2);
const extra = {}; for (const a of kv) { const [k, v] = a.split('='); extra[k] = isNaN(+v) ? v : +v; }
const part = loadPart(n); const tool = TOOLS[tt];
const { cl, gen } = generate(type, tool, part, extra);
const st = part.stock;
let prev = null, vert = 0, horiz = 0, nRapid = 0, cycles = 0; const tops = []; let seq = null;
const cuts = []; // z of cutting moves
eachMove(cl, (op, x, y, z, i, j, k, feed) => {
  if (!prev) { prev = [x, y, z]; return; }
  const rapid = op === OP.RAPID || feed === FEED.RAPID;
  if (rapid && op !== OP.DRILL) {
    nRapid++;
    const dz = Math.abs(z - prev[2]), dxy = Math.hypot(x - prev[0], y - prev[1]);
    vert += dz; horiz += dxy;
    if (!seq) seq = { from: [...prev], top: Math.max(prev[2], z), pts: 0 };
    seq.top = Math.max(seq.top, z); seq.pts++; seq.to = [x, y, z];
  } else {
    if (seq) { seq.land = [x, y, z]; tops.push(seq); seq = null; }
  }
  prev = [x, y, z];
});
const hdist = tops.map(s => Math.hypot(s.to[0]-s.from[0], s.to[1]-s.from[1]));
const lift = tops.map(s => s.top - Math.max(s.from[2], s.to[2]));
const short = tops.filter((s, i) => hdist[i] < 15);
console.log(`${n}/${type}/${tt}: gen ${gen.toFixed(2)}s moves ${cl.count} rapid-seqs ${tops.length}  vertical ${vert.toFixed(0)}mm horizontal ${horiz.toFixed(0)}mm`);
const sorted = [...lift].sort((a,b)=>a-b);
console.log(`  lift above endpoints: median ${sorted[sorted.length>>1]?.toFixed(1)} p90 ${sorted[Math.floor(sorted.length*0.9)]?.toFixed(1)} max ${sorted.at(-1)?.toFixed(1)};  seqs with hop<15mm: ${short.length}  (stock top ${st.max[2]}, tops: ${[...new Set(tops.map(s => s.top.toFixed(1)))].slice(0, 12).join(' ')})`);
const hist = new Map(); tops.forEach((s) => { const k = (s.top - Math.max(s.from[2], s.to[2])).toFixed(0); hist.set(k, (hist.get(k) ?? 0) + 1); });
console.log('  lift histogram (mm: count):', [...hist].sort((a, b) => a[0] - b[0]).slice(0, 14).map(([k, v]) => `${k}:${v}`).join(' '));
