// node bench/audit/buffer-check.mjs part — the cleared-ground union (rest.js clearedArea) timed, with its area
import { loadPart, TOOLS, generate } from './lib.js';
import { clearedArea } from '../../src/engine/rest.js';
import { loopArea } from '../../src/geom/clipper.js';
const part = loadPart(process.argv[2] ?? 'test-slope');
const { cl } = generate('adaptive', TOOLS.flat, part, { stepUp: 0 });
let total = 0, area = 0;
for (const z of [-2, -5, -10.3, -15, -20.7, -25]) { const t = performance.now(); const loops = clearedArea([{ cl, tool: TOOLS.flat }], z, {}); total += performance.now() - t; area += loops.reduce((s, l) => s + loopArea(l), 0); }
console.log(`${process.argv[2]}: ${total.toFixed(0)} ms, area sum ${area.toFixed(1)}`);
