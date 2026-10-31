// Toolpath rendering: CL programs → LineSegments with per-class colors.

import * as THREE from 'three';
import { MOVE_STRIDE, OP, FEED } from '../engine/cl.js';

// Cutting in a clear blue, plunging in amber, and the rapids in orange a step
// quieter than either: the metal being cut is what a backplot is read for, and
// on a job with a lot of retracts the rapids are most of the lines on screen.
// The table itself lives in path-colors.js (see there for why).
import { PATH_COLORS } from './path-colors.js';
export { PATH_COLORS };

// The other ways of colouring the metal-cutting lines (the `colorBy` style).
// Rapids keep their own colour in every one of them: they are the lines that
// must never be taken for metal being cut, whatever the cut ones are saying.
const FEED_COLORS = {
  [FEED.CUT]: new THREE.Color(0x5aa8ec),
  [FEED.RAMP]: new THREE.Color(0x5fd08a),
  [FEED.LEAD]: new THREE.Color(0xb68cf0),
  [FEED.PLUNGE]: new THREE.Color(0xe8c25e),
};
const SCRATCH = new THREE.Color();

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
 * @param style { rapids, brightness, colors: { cut, rapid, plunge } as hex,
 *   colorBy: 'move' | 'operation' | 'depth' | 'feed' } — dropping rapids leaves only the metal
 *   being cut, which is what you want when checking a path rather than its
 *   linking; eleven overlapping paths in one colour is the normal state of a
 *   finished job.
 */
export function buildToolpathObject(clPrograms, style = {}) {
  const showRapids = style.rapids !== false;
  const gain = BRIGHTNESS[style.brightness] ?? 1;
  // a colour the person chose, falling back to the built-in for any not given
  const colorOf = (name) => new THREE.Color(style.colors?.[name] ?? PATH_COLORS[name]);
  const palette = {};
  for (const name of Object.keys(PATH_COLORS)) {
    const color = colorOf(name);
    palette[name] = [
      Math.min(1, color.r * gain), Math.min(1, color.g * gain), Math.min(1, color.b * gain),
    ];
  }

  const colorBy = style.colorBy ?? 'move';

  // pass one: how many segments — and, for the depth ramp, how deep the metal
  // cutting goes, so the ramp spans what is actually there rather than the
  // rapid heights above it
  let segments = 0;
  let cutLow = Infinity;
  let cutHigh = -Infinity;
  for (const cl of clPrograms) {
    const d = cl.moves;
    let started = false;
    for (let n = 0; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      if (d[o] === OP.DRILL) {
        segments += (started && showRapids ? 1 : 0) + 1 + (showRapids ? 1 : 0);
        started = true;
        if (d[o + 3] < cutLow) cutLow = d[o + 3];
        if (d[o + 3] > cutHigh) cutHigh = d[o + 3];
        continue;
      }
      if (started && (showRapids || d[o] !== OP.RAPID)) segments++;
      if (d[o] !== OP.RAPID) {
        if (d[o + 3] < cutLow) cutLow = d[o + 3];
        if (d[o + 3] > cutHigh) cutHigh = d[o + 3];
      }
      started = true;
    }
  }

  /**
   * The colour of one metal-cutting segment, written into a scratch array — a
   * fresh one per segment is the allocation this file was rewritten to avoid.
   * `z` is the segment's height, for the depth ramp.
   */
  const ink = [0, 0, 0];
  const cutInk = (feedClass, owner, z) => {
    if (colorBy === 'operation') {
      // golden-angle hues: neighbouring operations are as far apart as the
      // wheel allows, however many there are
      SCRATCH.setHSL((owner * 0.618034) % 1, 0.65, 0.62);
    } else if (colorBy === 'depth') {
      const t = cutHigh > cutLow ? (z - cutLow) / (cutHigh - cutLow) : 1;
      SCRATCH.setHSL(0.62 - 0.57 * Math.min(1, Math.max(0, t)), 0.8, 0.6);   // blue deep, orange high
    } else if (colorBy === 'feed') {
      SCRATCH.copy(FEED_COLORS[feedClass] ?? FEED_COLORS[FEED.CUT]);
    } else {
      return feedClass === FEED.PLUNGE ? palette.plunge : palette.cut;
    }
    ink[0] = Math.min(1, SCRATCH.r * gain);
    ink[1] = Math.min(1, SCRATCH.g * gain);
    ink[2] = Math.min(1, SCRATCH.b * gain);
    return ink;
  };

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
        seg(x, y, top, x, y, bottom, cutInk(FEED.PLUNGE, owner, (top + bottom) / 2), owner);
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
        const color = rapid ? palette.rapid : cutInk(d[o + 7], owner, (pz + z) / 2);
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
