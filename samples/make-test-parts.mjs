// Test parts: one file per kind of geometry a strategy has to cope with.
//
// The point of these is that every dimension is a round number somebody chose,
// so an operation's output can be checked against the part rather than against
// itself. "The pocket pass covered 36 × 20 at Z15" is a statement that can be
// wrong; "the pocket pass produced 412 moves" is not.
//
//   test-step-plate.stl  stepped block, enclosed pocket, open-ended channel
//   test-hole-plate.stl  plate with exact circular holes, three sizes + a blind
//   test-slope.stl       a constant ramp and a dome — the 3D finishing pair
//   test-shaft.stl       turning: shoulders, taper, groove, relief, thread, bore
//   test-marks.dxf       lines to engrave and a centreline to slot
//
// Run: node samples/make-test-parts.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- primitives

/** A soup of triangles, as flat [x,y,z] triples. */
function soup() {
  const t = [];
  t.tri = (a, b, c) => { t.push(...a, ...b, ...c); return t; };
  // quad given in CCW order seen from outside
  t.quad = (a, b, c, d) => { t.tri(a, b, c); t.tri(a, c, d); return t; };
  return t;
}

/**
 * Coordinate lines every rectangle is cut at, so that a long face and the short
 * one that meets it in the middle share a vertex instead of T-junctioning.
 * A T-junction is watertight as a set of points and *not* watertight as a
 * topology, which is exactly the kind of mesh that slices into open contours.
 */
let SPLITS = { x: [], y: [], z: [] };

/** The pieces [a,b] falls into once the cut lines inside it are applied. */
function spans(a, b, lines) {
  const cuts = [a, ...lines.filter((v) => v > a + 1e-9 && v < b - 1e-9), b];
  return cuts.slice(0, -1).map((v, i) => [v, cuts[i + 1]]);
}

/** Horizontal rectangle at z. `up` picks which side the material is on. */
function faceZ(s, x0, y0, x1, y1, z, up = true) {
  for (const [a, b] of spans(x0, x1, SPLITS.x)) {
    for (const [c, d] of spans(y0, y1, SPLITS.y)) {
      const p = [[a, c, z], [b, c, z], [b, d, z], [a, d, z]];
      if (up) s.quad(...p); else s.quad(p[3], p[2], p[1], p[0]);
    }
  }
  return s;
}

/** Vertical rectangle at constant x. `plus` = outward normal is +X. */
function faceX(s, x, y0, z0, y1, z1, plus = true) {
  for (const [a, b] of spans(y0, y1, SPLITS.y)) {
    for (const [c, d] of spans(z0, z1, SPLITS.z)) {
      const p = [[x, a, c], [x, b, c], [x, b, d], [x, a, d]];
      if (plus) s.quad(...p); else s.quad(p[3], p[2], p[1], p[0]);
    }
  }
  return s;
}

/** Vertical rectangle at constant y. `plus` = outward normal is +Y. */
function faceY(s, y, x0, z0, x1, z1, plus = true) {
  for (const [a, b] of spans(x0, x1, SPLITS.x)) {
    for (const [c, d] of spans(z0, z1, SPLITS.z)) {
      const p = [[a, y, c], [a, y, d], [b, y, d], [b, y, c]];
      if (plus) s.quad(...p); else s.quad(p[3], p[2], p[1], p[0]);
    }
  }
  return s;
}

/** Binary STL, normals computed from the winding so the two cannot disagree. */
function writeSTL(name, s) {
  const count = s.length / 9;
  const buf = Buffer.alloc(84 + count * 50);
  buf.write('CNCAM test part', 0);
  buf.writeUInt32LE(count, 80);
  for (let i = 0; i < count; i++) {
    const o = i * 9;
    const ax = s[o], ay = s[o + 1], az = s[o + 2];
    const bx = s[o + 3], by = s[o + 4], bz = s[o + 5];
    const cx = s[o + 6], cy = s[o + 7], cz = s[o + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const p = 84 + i * 50;
    const f = [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz];
    for (let k = 0; k < 12; k++) buf.writeFloatLE(f[k], p + k * 4);
  }
  const path = join(DIR, name);
  writeFileSync(path, buf);
  console.log(`${name}: ${count} triangles`);
}

// ------------------------------------------------- 1. stepped plate + pocket
//
//   base   100 × 70 × 12
//   boss   x 20..80, y 15..55, up to Z22          (the step)
//   pocket x 32..68, y 25..45, floor Z15          (enclosed — pocketing)
//   channel y 60..66 across the whole X, floor Z6 (open ended — slotting)

function stepPlate() {
  const s = soup();
  const [W, D, H] = [100, 70, 12];
  const boss = { x0: 20, y0: 15, x1: 80, y1: 55, z: 22 };
  const pk = { x0: 32, y0: 25, x1: 68, y1: 45, z: 15 };
  const ch = { y0: 60, y1: 66, z: 6 };
  SPLITS = { x: [20, 32, 68, 80], y: [15, 25, 45, 55, 60, 66], z: [6, 12, 15] };

  faceZ(s, 0, 0, W, D, 0, false);                       // underside

  for (const [x, plus] of [[0, false], [W, true]]) {    // the two ends
    faceX(s, x, 0, 0, ch.y0, H, plus);
    faceX(s, x, ch.y0, 0, ch.y1, ch.z, plus);
    faceX(s, x, ch.y1, 0, D, H, plus);
  }
  faceY(s, 0, 0, 0, W, H, false);
  faceY(s, D, 0, 0, W, H, true);

  // top of the base, as the strips the boss and the channel leave behind
  faceZ(s, 0, 0, W, boss.y0, H);
  faceZ(s, 0, boss.y1, W, ch.y0, H);
  faceZ(s, 0, ch.y1, W, D, H);
  faceZ(s, 0, boss.y0, boss.x0, boss.y1, H);
  faceZ(s, boss.x1, boss.y0, W, boss.y1, H);

  // the channel
  faceZ(s, 0, ch.y0, W, ch.y1, ch.z);
  faceY(s, ch.y0, 0, ch.z, W, H, true);
  faceY(s, ch.y1, 0, ch.z, W, H, false);

  // the boss
  faceX(s, boss.x0, boss.y0, H, boss.y1, boss.z, false);
  faceX(s, boss.x1, boss.y0, H, boss.y1, boss.z, true);
  faceY(s, boss.y0, boss.x0, H, boss.x1, boss.z, false);
  faceY(s, boss.y1, boss.x0, H, boss.x1, boss.z, true);

  // the boss top, around the pocket mouth
  faceZ(s, boss.x0, boss.y0, boss.x1, pk.y0, boss.z);
  faceZ(s, boss.x0, pk.y1, boss.x1, boss.y1, boss.z);
  faceZ(s, boss.x0, pk.y0, pk.x0, pk.y1, boss.z);
  faceZ(s, pk.x1, pk.y0, boss.x1, pk.y1, boss.z);

  // the pocket
  faceX(s, pk.x0, pk.y0, pk.z, pk.y1, boss.z, true);
  faceX(s, pk.x1, pk.y0, pk.z, pk.y1, boss.z, false);
  faceY(s, pk.y0, pk.x0, pk.z, pk.x1, boss.z, true);
  faceY(s, pk.y1, pk.x0, pk.z, pk.x1, boss.z, false);
  faceZ(s, pk.x0, pk.y0, pk.x1, pk.y1, pk.z);

  writeSTL('test-step-plate.stl', s);
}

// ------------------------------------------------------- 2. plate with holes
//
// The circles are exact, which is the whole point — hole recognition is looking
// for a round loop and a stair-stepped one is not round. Each hole gets a
// square tile of the grid to itself, and the annulus between tile and circle is
// stitched with matching vertex counts so nothing T-junctions.

function holePlate() {
  const s = soup();
  const [W, D, H] = [90, 60, 14];
  const step = 1.5;
  const holes = [
    { x: 15, y: 15, r: 3, tile: 4.5 },
    { x: 75, y: 15, r: 3, tile: 4.5 },
    { x: 15, y: 45, r: 3, tile: 4.5 },
    { x: 75, y: 45, r: 3, tile: 4.5 },
    { x: 45, y: 12, r: 5, tile: 6 },
    { x: 45, y: 42, r: 10, tile: 12 },
    { x: 63, y: 30, r: 4, tile: 6, floor: 5 },   // blind, flat bottomed
  ];

  SPLITS = { x: [], y: [], z: [] };
  const inTile = (h, x, y) => x >= h.x - h.tile && x < h.x + h.tile
    && y >= h.y - h.tile && y < h.y + h.tile;

  // top and bottom as a grid, leaving each hole's tile out
  for (let x = 0; x < W - 1e-9; x += step) {
    for (let y = 0; y < D - 1e-9; y += step) {
      const top = holes.find((h) => inTile(h, x, y));
      if (!top) faceZ(s, x, y, x + step, y + step, H);
      // a blind hole leaves the underside untouched
      const bot = holes.find((h) => !h.floor && inTile(h, x, y));
      if (!bot) faceZ(s, x, y, x + step, y + step, 0, false);
    }
  }

  // the sides, one panel per grid step so the top edge shares the grid's vertices
  for (let x = 0; x < W - 1e-9; x += step) {
    faceY(s, 0, x, 0, x + step, H, false);
    faceY(s, D, x, 0, x + step, H, true);
  }
  for (let y = 0; y < D - 1e-9; y += step) {
    faceX(s, 0, y, 0, y + step, H, false);
    faceX(s, W, y, 0, y + step, H, true);
  }

  for (const h of holes) {
    const n = (8 * h.tile) / step;
    const circle = (i) => {
      const a = ((i % n) / n) * Math.PI * 2;
      return [h.x + h.r * Math.cos(a), h.y + h.r * Math.sin(a)];
    };
    // The tile boundary, anticlockwise, starting on the +X side so that vertex
    // i sits at the same angle as the circle's vertex i. Starting at the corner
    // instead — which is what falls out of the obvious parametrisation — puts a
    // 45° twist through the annulus and skews every quad in it.
    const square = (i) => {
      const t = (((i % n) / n) * 4 + 0.5) % 4;
      const side = Math.floor(t);
      const f = (t - side) * 2 - 1;
      const [ux, uy] = [[1, f], [-f, 1], [-1, -f], [f, -1]][side];
      return [h.x + ux * h.tile, h.y + uy * h.tile];
    };
    const floorZ = h.floor ?? 0;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = circle(i); const [bx, by] = circle(i + 1);
      const [px, py] = square(i); const [qx, qy] = square(i + 1);
      // the bore wall — the material is outside it, so the normal faces the axis
      s.quad([ax, ay, floorZ], [ax, ay, H], [bx, by, H], [bx, by, floorZ]);
      // top annulus, facing +Z
      s.quad([ax, ay, H], [px, py, H], [qx, qy, H], [bx, by, H]);
      if (h.floor) {
        s.tri([h.x, h.y, floorZ], [ax, ay, floorZ], [bx, by, floorZ]); // flat bottom, +Z
      } else {
        s.quad([ax, ay, 0], [bx, by, 0], [qx, qy, 0], [px, py, 0]);    // bottom annulus, -Z
      }
    }
  }
  writeSTL('test-hole-plate.stl', s);
}

// ---------------------------------------------------- 3. the ramp and the dome
//
// One face of constant slope and one of continuously changing slope, on the
// same part: a parallel finish should ride the ramp and struggle on the dome's
// flank, a waterline the other way round. Both answers are checkable because
// the ramp really is 26.57° everywhere and the dome really is a sphere.

function slopePart() {
  const s = soup();
  SPLITS = { x: [], y: [], z: [] };
  const [W, D] = [90, 72];
  const step = 1.5;
  const BASE = 8;
  const RAMP_TO = 36;          // ramp runs from x=0 down to x=36
  const RAMP_H = 18;
  const dome = { x: 63, y: 36, r: 22 };

  const zAt = (x, y) => {
    let z = BASE;
    if (x < RAMP_TO) z = Math.max(z, BASE + RAMP_H * (1 - x / RAMP_TO));
    const d = Math.hypot(x - dome.x, y - dome.y);
    if (d < dome.r) z = Math.max(z, BASE + Math.sqrt(dome.r * dome.r - d * d));
    return z;
  };

  for (let x = 0; x < W - 1e-9; x += step) {
    for (let y = 0; y < D - 1e-9; y += step) {
      const a = [x, y, zAt(x, y)];
      const b = [x + step, y, zAt(x + step, y)];
      const c = [x + step, y + step, zAt(x + step, y + step)];
      const e = [x, y + step, zAt(x, y + step)];
      s.quad(a, b, c, e);
      faceZ(s, x, y, x + step, y + step, 0, false);
    }
  }
  // the skirt, one panel per grid edge so its top follows the surface
  for (let x = 0; x < W - 1e-9; x += step) {
    s.quad([x, 0, 0], [x + step, 0, 0], [x + step, 0, zAt(x + step, 0)], [x, 0, zAt(x, 0)]);
    s.quad([x, D, zAt(x, D)], [x + step, D, zAt(x + step, D)], [x + step, D, 0], [x, D, 0]);
  }
  for (let y = 0; y < D - 1e-9; y += step) {
    s.quad([0, y, 0], [0, y, zAt(0, y)], [0, y + step, zAt(0, y + step)], [0, y + step, 0]);
    s.quad([W, y, 0], [W, y + step, 0], [W, y + step, zAt(W, y + step)], [W, y, zAt(W, y)]);
  }
  writeSTL('test-slope.stl', s);
}

// ------------------------------------------------------------- 4. the shaft
//
// A solid of revolution about Z, free end at Z90, chuck end at Z0 — the same
// convention as engine/lathe.js. The profile is listed once, outside in, and
// carries every feature a turned part needs one of:
//
//   Z0..20   ⌀38   the bit held in the chuck, and where it gets parted off
//   Z20..24  taper ⌀38 → ⌀30
//   Z24..50  ⌀30   body
//   Z50..54  ⌀24   groove, 4 wide, square shouldered
//   Z56      shoulder ⌀30 → ⌀20
//   Z56..59  ⌀17.2 thread relief
//   Z59..90  ⌀20   thread major diameter (M20 × 1.5)
//   bore     ⌀16 twenty deep, on a ⌀12 pilot to Z57, drill point to Z54

function shaft() {
  const s = soup();
  const segments = 72;
  // (z, radius), anticlockwise round the section: out along the end faces,
  // back down the bore
  const profile = [
    [0, 0], [0, 19], [20, 19], [24, 15], [50, 15], [50, 12], [54, 12], [54, 15],
    [56, 15], [56, 8.6], [59, 8.6], [59, 10], [90, 10],
    [90, 8], [70, 8], [70, 6], [57, 6], [54, 0],
  ];

  const at = (z, r, i) => {
    const a = (i / segments) * Math.PI * 2;
    return [r * Math.cos(a), r * Math.sin(a), z];
  };
  for (let k = 0; k < profile.length - 1; k++) {
    const [z0, r0] = profile[k];
    const [z1, r1] = profile[k + 1];
    if (r0 === 0 && r1 === 0) continue;
    for (let i = 0; i < segments; i++) {
      const a0 = at(z0, r0, i), a1 = at(z0, r0, i + 1);
      const b0 = at(z1, r1, i), b1 = at(z1, r1, i + 1);
      // wound so the normal points away from the axis on an outside surface
      // and toward it on the bore, which the profile's own direction encodes
      if (r0 === 0) s.tri(a0, b0, b1);
      else if (r1 === 0) s.tri(a0, a1, b0);
      else s.quad(a0, a1, b1, b0);
    }
  }
  writeSTL('test-shaft.stl', s);
}

// --------------------------------------------------------- 5. a DXF to follow

function marksDXF() {
  const ents = [];
  const line = (x0, y0, x1, y1) => ents.push(
    '0', 'LINE', '8', 'MARKS', '10', String(x0), '20', String(y0),
    '11', String(x1), '21', String(y1));
  const circle = (x, y, r) => ents.push(
    '0', 'CIRCLE', '8', 'MARKS', '10', String(x), '20', String(y), '40', String(r));

  // a border, 60 × 30 with its corner on the origin
  line(0, 0, 60, 0); line(60, 0, 60, 30); line(60, 30, 0, 30); line(0, 30, 0, 0);
  // "CNC" in straight strokes, 10 tall
  const C = (x) => { line(x + 6, 22, x, 22); line(x, 22, x, 12); line(x, 12, x + 6, 12); };
  C(6);
  line(16, 12, 16, 22); line(16, 22, 22, 12); line(22, 12, 22, 22);   // N
  C(26);
  // a centreline for a slot to follow, and a bolt circle to drill
  line(8, 6, 52, 6);
  circle(45, 22, 4);

  const dxf = ['0', 'SECTION', '2', 'HEADER',
    '9', '$INSUNITS', '70', '4',
    '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    ...ents, '0', 'ENDSEC', '0', 'EOF'].join('\n');
  writeFileSync(join(DIR, 'test-marks.dxf'), `${dxf}\n`);
  console.log('test-marks.dxf: 13 entities');
}

stepPlate();
holePlate();
slopePart();
shaft();
marksDXF();
