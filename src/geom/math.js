// Minimal 3D vector math on plain arrays [x, y, z].
// Used by the compute core (engine/sim) — deliberately independent of three.js.

export const EPS = 1e-9;

export function v3(x = 0, y = 0, z = 0) { return [x, y, z]; }

export function add(a, b, out = [0, 0, 0]) {
  out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
  return out;
}

export function sub(a, b, out = [0, 0, 0]) {
  out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
  return out;
}

export function scale(a, s, out = [0, 0, 0]) {
  out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
  return out;
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a, b, out = [0, 0, 0]) {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

export function len(a) { return Math.hypot(a[0], a[1], a[2]); }

export function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function normalize(a, out = [0, 0, 0]) {
  const l = len(a);
  if (l < EPS) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  return scale(a, 1 / l, out);
}

export function lerp(a, b, t, out = [0, 0, 0]) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

export function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }
