// Loading real sample models in tests.
//
// Synthetic fixtures are clean in ways real exports never are: their walls are
// exactly vertical, their vertices meet exactly, and their unions collapse
// neatly. Some failures only appear on a mesh that came out of real CAD, so the
// suite keeps one and runs the heavy strategies against it.
//
// Works in both hosts — fetch in the browser, fs in Node — so `samples/` is
// reachable from test.html and node-run.js alike.

const isNode = typeof process !== 'undefined' && process.versions?.node;

export async function loadSampleBuffer(name) {
  if (isNode) {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL(`../../samples/${name}`, import.meta.url));
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const response = await fetch(new URL(`../../samples/${name}`, import.meta.url));
  if (!response.ok) throw new Error(`could not load sample ${name}: ${response.status}`);
  return response.arrayBuffer();
}
