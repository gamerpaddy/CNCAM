import { test, assert } from './runner.js';
import { parseSTL } from '../io/stl.js';

function binarySTL(triangles) {
  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles.length, true);
  let o = 84;
  for (const tri of triangles) {
    o += 12; // normal, ignored
    for (const v of tri.flat()) { view.setFloat32(o, v, true); o += 4; }
    o += 2;
  }
  return buffer;
}

const TRI = [[0, 0, 0], [10, 0, 0], [0, 10, 0]];

test('binary STL parses one triangle', () => {
  const positions = parseSTL(binarySTL([TRI]));
  assert.eq(positions.length, 9);
  assert.close(positions[3], 10);
  assert.close(positions[7], 10);
});

test('ASCII STL parses vertices', () => {
  const text = `solid t
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 10 0 0
    vertex 0 10 0
  endloop
endfacet
endsolid t`;
  const positions = parseSTL(new TextEncoder().encode(text).buffer);
  assert.eq(positions.length, 9);
  assert.close(positions[3], 10);
});

test('ASCII STL with incomplete facet throws', () => {
  const text = 'solid t\nvertex 0 0 0\nvertex 1 0 0\nendsolid';
  assert.throws(() => parseSTL(new TextEncoder().encode(text).buffer));
});

test('a binary STL with bytes after its last facet is still binary', () => {
  // Some exporters pad or append a trailer. Demanding the exact size sent the
  // file to the ASCII reader, which found no "vertex" and returned nothing.
  const buffer = new ArrayBuffer(84 + 50 + 3);
  const view = new DataView(buffer);
  view.setUint32(80, 1, true);
  [0, 0, 0, 10, 0, 0, 0, 10, 0].forEach((p, i) => view.setFloat32(84 + 12 + i * 4, p, true));
  const soup = parseSTL(buffer);
  assert.eq(soup.length, 9, 'the one facet is read');
  assert.close(soup[3], 10, 1e-9);
});

test('a facet with a corner that is not a number is left out', () => {
  const buffer = new ArrayBuffer(84 + 100);
  const view = new DataView(buffer);
  view.setUint32(80, 2, true);
  [0, 0, 0, 10, 0, 0, 0, 10, 0].forEach((p, i) => view.setFloat32(84 + 12 + i * 4, p, true));
  [0, 0, 0, NaN, 0, 0, 0, 10, 0].forEach((p, i) => view.setFloat32(134 + 12 + i * 4, p, true));
  const soup = parseSTL(buffer);
  assert.eq(soup.length, 9, 'one good facet, the NaN one dropped');
  assert.ok([...soup].every(Number.isFinite));
});
