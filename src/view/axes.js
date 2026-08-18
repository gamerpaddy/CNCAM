// Which way is which.
//
// The viewport used to draw a bare three.js AxesHelper: three coloured lines of
// equal length meeting at a point, with nothing anywhere saying which was which.
// The colours are a convention (X red, Y green, Z blue) that a CAD user knows
// and nobody else does, and a convention you have to already know is not a
// label. Worse, the *machine* convention it was drawing — Z up — is right for a
// mill and wrong for a lathe, where Z runs along the spindle and X is the
// cross-slide going in.
//
// So: the axes get names, drawn as sprites so they face the camera from any
// orbit; the arrows say which way positive is; and a small triad in the corner
// holds the orientation when the part fills the screen and the origin is off it.

import * as THREE from 'three';

export const AXIS_COLORS = {
  x: 0xff5f6b,
  y: 0x7ddb63,
  z: 0x5aa9ff,
};

/**
 * A label that always faces the camera, drawn on a canvas so it stays crisp.
 *
 * Sprites rather than text geometry: a letter has to be legible at any orbit
 * angle and at any zoom, and a 3D letter seen edge-on is a line.
 */
function label(text, color, size) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 88px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // a dark halo, because the label has to read against both the bright grid
  // lines and the dark background it crosses as the camera moves
  ctx.lineWidth = 12;
  ctx.strokeStyle = 'rgba(10, 12, 16, 0.9)';
  ctx.strokeText(text, 64, 68);
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.fillText(text, 64, 68);

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, depthTest: false, transparent: true,
  }));
  sprite.scale.set(size, size, 1);
  sprite.renderOrder = 10;
  return sprite;
}

const AXIS_DIRS = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

/**
 * The world axes: an arrow from the origin per axis, each with its letter on
 * the end.
 *
 * Which axes, though, is a fact about the machine. A lathe has two — the
 * cross-slide and the bar — and drawing a Y arrow on one is drawing an axis
 * that does not exist, cannot be programmed, and is refused by the post on its
 * way out. See AXES_OF in view/views.js.
 *
 * @param size how long the arrows are, in scene units
 * @param axes which of x, y, z to draw
 * @returns a THREE.Group, with `dispose()` on it
 */
export function buildAxes(size = 20, axes = ['x', 'y', 'z']) {
  const group = new THREE.Group();
  group.name = 'axes';
  const dirs = Object.fromEntries(axes
    .filter((a) => AXIS_DIRS[a])
    .map((a) => [a, new THREE.Vector3(...AXIS_DIRS[a])]));
  const disposables = [];

  for (const [axis, dir] of Object.entries(dirs)) {
    const color = AXIS_COLORS[axis];
    const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), size, color,
      size * 0.16, size * 0.09);
    arrow.line.material.depthTest = false;
    arrow.cone.material.depthTest = false;
    arrow.renderOrder = 9;
    group.add(arrow);
    disposables.push(arrow);

    const text = label(axis.toUpperCase(), color, size * 0.24);
    text.position.copy(dir).multiplyScalar(size * 1.16);
    group.add(text);
    disposables.push(text);
  }

  group.userData.dispose = () => {
    for (const node of disposables) {
      node.traverse?.((child) => {
        child.geometry?.dispose();
        child.material?.map?.dispose();
        child.material?.dispose();
      });
      node.material?.map?.dispose();
      node.material?.dispose();
    }
  };
  return group;
}

/**
 * The corner triad: the same three axes, rendered small in the corner of the
 * viewport with their own camera.
 *
 * The world axes sit at the machine origin, which is usually under the part and
 * frequently off screen — so at the moment you most need to know which way you
 * are looking, they are not visible. This one always is. It shares the main
 * camera's *rotation* and nothing else, so it turns as you orbit and stays the
 * same size as you zoom.
 */
export class OrientationTriad {
  constructor(renderer) {
    this.renderer = renderer;
    this.size = 84;               // px along a side of the corner viewport
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1.9, 1.9, 1.9, -1.9, 0.1, 100);
    this.camera.up.set(0, 0, 1);
    this.axes = buildAxes(1);
    this.scene.add(this.axes);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    this.enabled = true;
  }

  /** Draw only the axes this machine has. */
  setAxes(axes) {
    const key = axes.join('');
    if (key === this.axesKey) return;
    this.axesKey = key;
    this.scene.remove(this.axes);
    this.axes.userData.dispose?.();
    this.axes = buildAxes(1, axes);
    this.scene.add(this.axes);
  }

  /**
   * Draw it over whatever is already in the framebuffer.
   *
   * Scissored to its own corner and cleared of depth only, so the triad is never
   * occluded by the part and never clears the render behind it.
   */
  render(mainCamera) {
    if (!this.enabled) return;
    const renderer = this.renderer;
    const canvas = renderer.domElement;
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    const s = Math.min(this.size, Math.floor(Math.min(w, h) * 0.28));
    if (s < 40) return;           // a panel too small for it is better without

    // the triad sits where the camera is looking from, at a fixed distance —
    // same direction as the main camera, so it reads as the same orientation
    const dir = new THREE.Vector3();
    mainCamera.getWorldDirection(dir);
    this.camera.position.copy(dir).multiplyScalar(-6);
    this.camera.up.copy(mainCamera.up);
    this.camera.lookAt(0, 0, 0);

    const margin = 10;
    renderer.setScissorTest(true);
    renderer.setViewport(margin, margin, s, s);
    renderer.setScissor(margin, margin, s, s);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
  }

  dispose() {
    this.axes.userData.dispose?.();
  }
}

// The named views themselves are plain data and live in ./views.js, so the
// toolbar can offer them without pulling three.js into a headless test run.
export {
  VIEW_PRESETS, viewsFor, extraViewsFor, defaultViewFor, AXIS_MEANING, AXES_OF,
} from './views.js';
