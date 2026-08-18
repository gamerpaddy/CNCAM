// Toolpath rendering: CL programs → LineSegments with per-class colors.

import * as THREE from 'three';
import { MOVE_STRIDE, OP, FEED } from '../engine/cl.js';

const COLORS = {
  rapid: new THREE.Color(0xcc7733),
  cut: new THREE.Color(0x37c8ff),
  plunge: new THREE.Color(0xffe14a),
};

/** How loud the backplot is, as a multiplier on every colour. */
const BRIGHTNESS = { dim: 0.55, normal: 1, bright: 1.45 };

/**
 * Build one LineSegments object for a list of CL programs.
 *
 * @param style { rapids, brightness } — dropping rapids leaves only the metal
 *   being cut, which is what you want when checking a path rather than its
 *   linking; eleven overlapping paths in one colour is the normal state of a
 *   finished job.
 */
export function buildToolpathObject(clPrograms, style = {}) {
  const positions = [];
  const colors = [];
  const showRapids = style.rapids !== false;
  const gain = BRIGHTNESS[style.brightness] ?? 1;

  const seg = (a, b, color) => {
    positions.push(...a, ...b);
    const r = Math.min(1, color.r * gain);
    const g = Math.min(1, color.g * gain);
    const bl = Math.min(1, color.b * gain);
    colors.push(r, g, bl, r, g, bl);
  };

  for (const cl of clPrograms) {
    const d = cl.moves;
    let prev = null;
    for (let n = 0; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      if (d[o] === OP.DRILL) {
        const top = [d[o + 1], d[o + 2], d[o + 4]];
        const bottom = [d[o + 1], d[o + 2], d[o + 3]];
        if (prev && showRapids) seg(prev, top, COLORS.rapid);
        seg(top, bottom, COLORS.plunge);
        if (showRapids) seg(bottom, top, COLORS.rapid);
        prev = top;
        continue;
      }
      const p = [d[o + 1], d[o + 2], d[o + 3]];
      const rapid = d[o] === OP.RAPID;
      if (prev && (showRapids || !rapid)) {
        const color = rapid ? COLORS.rapid
          : d[o + 7] === FEED.PLUNGE ? COLORS.plunge : COLORS.cut;
        seg(prev, p, color);
      }
      prev = p;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({ vertexColors: true });
  return new THREE.LineSegments(geometry, material);
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
    color: 0x7a8494, transparent: true, opacity: 0.7,
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
