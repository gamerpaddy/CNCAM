// Toolpath rendering: CL programs → LineSegments with per-class colors.

import * as THREE from 'three';
import { MOVE_STRIDE, OP, FEED } from '../engine/cl.js';

// Cutting in a clear blue, plunging in amber, and the rapids in orange a step
// quieter than either: the metal being cut is what a backplot is read for, and
// on a job with a lot of retracts the rapids are most of the lines on screen.
const COLORS = {
  rapid: new THREE.Color(0xf08a4b).multiplyScalar(0.8),
  cut: new THREE.Color(0x4fb4ff),
  plunge: new THREE.Color(0xffcf5c),
};

/** How loud the backplot is, as a multiplier on every colour. */
const BRIGHTNESS = { dim: 0.55, normal: 1, bright: 1.45 };

/**
 * How much of itself an operation keeps while another one is selected.
 *
 * Eleven paths in one blue is the normal state of a finished job, and the one
 * you have selected is the one you are asking about. The rest stay on screen —
 * where they are is half of what the selected one means — but step back.
 */
const UNFOCUSED = 0.22;

/**
 * Build one LineSegments object for a list of CL programs.
 *
 * Written straight into typed arrays, counted first and filled second. The
 * build used to push three-element arrays onto a plain array for every point,
 * which on a finishing job is hundreds of thousands of short-lived arrays and a
 * redraw that took longer than the operation it drew had taken to compute.
 *
 * Each vertex carries the index of the program it came from, so one of them
 * can be brought forward (see `focusToolpath`) without rebuilding anything.
 *
 * @param style { rapids, brightness } — dropping rapids leaves only the metal
 *   being cut, which is what you want when checking a path rather than its
 *   linking; eleven overlapping paths in one colour is the normal state of a
 *   finished job.
 */
export function buildToolpathObject(clPrograms, style = {}) {
  const showRapids = style.rapids !== false;
  const gain = BRIGHTNESS[style.brightness] ?? 1;
  const palette = {};
  for (const [name, color] of Object.entries(COLORS)) {
    palette[name] = [
      Math.min(1, color.r * gain), Math.min(1, color.g * gain), Math.min(1, color.b * gain),
    ];
  }

  // pass one: how many segments
  let segments = 0;
  for (const cl of clPrograms) {
    const d = cl.moves;
    let started = false;
    for (let n = 0; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      if (d[o] === OP.DRILL) {
        segments += (started && showRapids ? 1 : 0) + 1 + (showRapids ? 1 : 0);
        started = true;
        continue;
      }
      if (started && (showRapids || d[o] !== OP.RAPID)) segments++;
      started = true;
    }
  }

  // pass two: the same walk, writing
  const positions = new Float32Array(segments * 6);
  const colors = new Float32Array(segments * 6);
  const owners = new Float32Array(segments * 2);
  let at = 0;
  const seg = (ax, ay, az, bx, by, bz, color, owner) => {
    const p = at * 6;
    positions[p] = ax; positions[p + 1] = ay; positions[p + 2] = az;
    positions[p + 3] = bx; positions[p + 4] = by; positions[p + 5] = bz;
    colors[p] = color[0]; colors[p + 1] = color[1]; colors[p + 2] = color[2];
    colors[p + 3] = color[0]; colors[p + 4] = color[1]; colors[p + 5] = color[2];
    owners[at * 2] = owner;
    owners[at * 2 + 1] = owner;
    at++;
  };

  clPrograms.forEach((cl, owner) => {
    const d = cl.moves;
    let started = false;
    let px = 0;
    let py = 0;
    let pz = 0;
    for (let n = 0; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      if (d[o] === OP.DRILL) {
        const x = d[o + 1];
        const y = d[o + 2];
        const top = d[o + 4];
        const bottom = d[o + 3];
        if (started && showRapids) seg(px, py, pz, x, y, top, palette.rapid, owner);
        seg(x, y, top, x, y, bottom, palette.plunge, owner);
        if (showRapids) seg(x, y, bottom, x, y, top, palette.rapid, owner);
        px = x; py = y; pz = top;
        started = true;
        continue;
      }
      const x = d[o + 1];
      const y = d[o + 2];
      const z = d[o + 3];
      const rapid = d[o] === OP.RAPID;
      if (started && (showRapids || !rapid)) {
        const color = rapid ? palette.rapid
          : d[o + 7] === FEED.PLUNGE ? palette.plunge : palette.cut;
        seg(px, py, pz, x, y, z, color, owner);
      }
      px = x; py = y; pz = z;
      started = true;
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('owner', new THREE.BufferAttribute(owners, 1));
  const material = new THREE.LineBasicMaterial({ vertexColors: true });
  const focus = { value: -1 };
  const unfocused = { value: UNFOCUSED };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFocus = focus;
    shader.uniforms.uUnfocused = unfocused;
    shader.vertexShader = `attribute float owner;
uniform float uFocus;
uniform float uUnfocused;
varying float vFade;
${shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
  vFade = (uFocus < -0.5 || abs(owner - uFocus) < 0.5) ? 1.0 : uUnfocused;`)}`;
    shader.fragmentShader = `varying float vFade;
${shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  diffuseColor.rgb *= vFade;`)}`;
  };
  const lines = new THREE.LineSegments(geometry, material);
  lines.userData.focus = focus;
  return lines;
}

/**
 * Bring one program of a toolpath object forward and step the rest back, or
 * pass -1 to show them all alike. A uniform, not a rebuild: selecting an
 * operation in the tree is instant however long the program is.
 */
export function focusToolpath(object, index) {
  const focus = object?.userData?.focus;
  if (!focus) return false;
  const next = Number.isInteger(index) && index >= 0 ? index : -1;
  if (focus.value === next) return false;
  focus.value = next;
  return true;
}

/**
 * Wireframe stock display — box, bar or tube, matching the setup's stock kind.
 *
 * A tube gets a second wireframe down the middle. Drawing it as a plain
 * cylinder said "solid bar", which is a different piece of material and a
 * different program: everything a roughing pass would do to the middle of it is
 * cutting air, and the operator finds out when the first part comes off short.
 */
export function buildStockObject(stock) {
  const size = stock.max.map((v, i) => v - stock.min[i]);
  const center = stock.min.map((v, i) => v + size[i] / 2);
  const round = (stock.kind === 'cylinder' || stock.kind === 'tube') && stock.cylinder;

  const material = new THREE.LineBasicMaterial({
    color: 0x8a94a6, transparent: true, opacity: 0.6,
  });
  const group = new THREE.Group();

  const addShell = (geometry, position) => {
    const edges = new THREE.EdgesGeometry(geometry, 20);
    const lines = new THREE.LineSegments(edges, material);
    lines.position.set(...position);
    group.add(lines);
    geometry.dispose();
  };

  if (round) {
    const { diameter, innerDiameter, height, center: c, baseZ } = stock.cylinder;
    const at = [c[0], c[1], baseZ + height / 2];
    const outer = new THREE.CylinderGeometry(diameter / 2, diameter / 2, height, 48, 1, true);
    outer.rotateX(Math.PI / 2);   // three's cylinder is Y-up; the scene is Z-up
    addShell(outer, at);
    if (innerDiameter > 0) {
      const inner = new THREE.CylinderGeometry(
        innerDiameter / 2, innerDiameter / 2, height, 32, 1, true);
      inner.rotateX(Math.PI / 2);
      addShell(inner, at);
    }
  } else {
    addShell(new THREE.BoxGeometry(...size), center);
  }

  return group;
}
