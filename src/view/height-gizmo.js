// Draggable Z-plane handles for an operation's heights.
//
// Typing -16.5 into a box tells you nothing about where that is on the part.
// These draw the heights where they actually are — a translucent plane with a
// grab bar — so setting a depth becomes "put it here" instead of arithmetic.
//
// Dragging maps the pointer onto a vertical plane facing the camera and reads
// the Z off it, so the handle tracks the cursor from any viewing angle rather
// than only when looking side-on.

import * as THREE from 'three';

export const HEIGHT_HANDLES = [
  { key: 'topZ', label: 'Top', color: 0x6fd3ff },
  { key: 'bottomZ', label: 'Bottom', color: 0xff8a5c },
  { key: 'clearanceHeight', label: 'Clearance', color: 0x9be36f },
];

export class HeightGizmos {
  /**
   * @param camera the live camera, or a function returning it. A function is
   *   what the viewport passes: switching between perspective and orthographic
   *   swaps which camera is drawing, and a gizmo holding the other one
   *   raycasts against a view nobody is looking through.
   */
  constructor(scene, camera, renderer, controls, requestRender = () => {}) {
    this.cameraOf = typeof camera === 'function' ? camera : () => camera;
    this.renderer = renderer;
    this.controls = controls;
    this.requestRender = requestRender;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    // Visibility is two independent answers, and collapsing them into one flag
    // is what made the handles flicker between tabs. The properties panel says
    // whether the *user* is on the Heights tab; the viewport says whether
    // anything is allowed to be drawn over the part at all (it is not, during a
    // simulation). Either one saying no means no, and neither may overwrite the
    // other's answer — which is what `group.visible` alone could not express.
    this.wanted = false;
    this.allowed = true;

    this.handles = [];
    this.bounds = null;
    this.onDragStart = null;   // (key, z) when a handle is grabbed
    this.onChange = null;      // (key, z) while dragging
    this.onCommit = null;      // (key, z) on release — one undo entry per drag
    this.limitsFor = null;     // (key) => { min, max } the other heights allow

    this.raycaster = new THREE.Raycaster();
    this.dragging = null;
    this.dragPlane = new THREE.Plane();
    this.installDragging();
  }

  /**
   * Where the part is, so a plane can show what it cuts through.
   *
   * A height is a number until you can see what it meets. The corner brackets
   * say where the plane is; the *section* says what is at that depth — whether
   * Bottom Z lands in the middle of a boss or just misses the floor of a
   * pocket, which is the question the number was being typed to answer and the
   * one a bracket floating over the part cannot answer at all.
   *
   * @param sectionAt (z) => flat loops [[x0,y0,x1,y1,…], …], or null for none
   */
  setSectionSource(sectionAt) {
    this.sectionAt = sectionAt;
    for (const handle of this.handles) this.refreshSection(handle);
    this.requestRender();
  }

  /**
   * Show handles for one operation.
   * @param params the op's params (read for current heights)
   * @param bounds { min, max } of the stock, so planes are sized to the job
   */
  /**
   * @param keys which of the three heights this operation actually has, or null
   *   for all of them. The panel and the viewport have to agree on that: every
   *   operation carries a `clearanceHeight` in its params because the schema
   *   gives it one, but a turning operation does not have a clearance *plane* —
   *   nothing on the lathe reads it and the panel no longer offers it — so
   *   drawing a draggable handle for it put a control in the scene that edits a
   *   number with no effect and no box to check it against. `paramApplies` is
   *   the single answer to "does this operation have this field" and the caller
   *   passes what it says.
   */
  show(params, bounds, keys = null) {
    this.clear();
    if (!params || !bounds) return;
    this.bounds = bounds;
    const wanted = keys ? new Set(keys) : null;

    const width = bounds.max[0] - bounds.min[0];
    const depth = bounds.max[1] - bounds.min[1];
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const pad = Math.max(width, depth) * 0.08;

    for (const spec of HEIGHT_HANDLES) {
      if (wanted && !wanted.has(spec.key)) continue;
      const z = params[spec.key];
      if (typeof z !== 'number' || !Number.isFinite(z)) continue;

      // A corner bracket rather than a whole plane. Three filled rectangles the
      // size of the billet, stacked over the part, hid the thing they were
      // there to help you position against — you could no longer see the pocket
      // whose floor you were setting. Corners say where the plane is without
      // covering what is under it, and the grab bar is still the full width.
      const outline = new THREE.LineSegments(
        cornerBrackets(width + pad, depth + pad),
        new THREE.LineBasicMaterial({
          color: spec.color, transparent: true, opacity: 0.85, depthTest: false,
        }),
      );
      outline.renderOrder = 3;

      // a thin bar along one edge is the actual grab target — nothing else in
      // the gizmo is pickable, so it never steals a click from the model
      const barDepth = Math.max(0.6, pad * 0.28);
      const grip = new THREE.Mesh(
        new THREE.BoxGeometry(width + pad, barDepth, barDepth),
        new THREE.MeshBasicMaterial({
          color: spec.color, transparent: true, opacity: 0.9, depthTest: false,
        }),
      );
      grip.position.set(0, -(depth + pad) / 2, 0);
      grip.renderOrder = 4;

      // The intersection with the part, drawn on the plane itself. Its own
      // node, because it is rebuilt every time the handle moves while the
      // brackets and the grab bar are not.
      const section = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({
          color: spec.color, transparent: true, opacity: 0.95, depthTest: false,
        }),
      );
      section.renderOrder = 5;
      section.raycast = () => {};

      const handle = new THREE.Group();
      handle.add(outline, grip, section);
      handle.position.set(cx, cy, z);
      // the section is built in world XY, so it is drawn relative to the
      // handle's own centre rather than to the origin
      handle.userData = { key: spec.key, grip, section, label: spec.label, cx, cy };

      this.group.add(handle);
      this.handles.push(handle);
      this.refreshSection(handle);
    }
    this.applyVisibility();
  }

  /** Rebuild one handle's section outline for wherever it is now. */
  refreshSection(handle) {
    const { section, cx, cy } = handle.userData;
    if (!section) return;
    const loops = this.sectionAt?.(handle.position.z) ?? [];
    const points = [];
    for (const loop of loops) {
      const n = loop.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        points.push(loop[i * 2] - cx, loop[i * 2 + 1] - cy, 0,
          loop[j * 2] - cx, loop[j * 2 + 1] - cy, 0);
      }
    }
    section.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    if (points.length > 0) {
      geometry.setAttribute('position',
        new THREE.BufferAttribute(Float32Array.from(points), 3));
    }
    section.geometry = geometry;
    section.visible = points.length > 0;
  }

  /** Move handles to match params without rebuilding (cheap, for edits). */
  sync(params) {
    let moved = false;
    for (const handle of this.handles) {
      const z = params?.[handle.userData.key];
      if (typeof z === 'number' && Number.isFinite(z) && handle.position.z !== z) {
        handle.position.z = z;
        this.refreshSection(handle);
        moved = true;
      }
    }
    if (moved) this.requestRender();
  }

  installDragging() {
    const canvas = this.renderer.domElement;

    canvas.addEventListener('pointerdown', (event) => {
      if (!this.group.visible) return;
      const hit = this.pickGrip(event);
      if (!hit) return;

      // take the drag before OrbitControls can start spinning the camera
      event.stopPropagation();
      event.preventDefault();
      this.controls.enabled = false;
      this.dragging = hit.handle;
      canvas.setPointerCapture(event.pointerId);

      // a vertical plane through the handle, square to the camera: dragging
      // reads Z off it, which works from any orbit angle
      const normal = new THREE.Vector3();
      this.cameraOf().getWorldDirection(normal);
      normal.z = 0;
      if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0);   // looking straight down
      normal.normalize();
      this.dragPlane.setFromNormalAndCoplanarPoint(normal, hit.point);
      this.grabOffset = hit.handle.position.z - hit.point.z;
      this.onDragStart?.(hit.handle.userData.key, hit.handle.position.z);
    }, true);

    canvas.addEventListener('pointermove', (event) => {
      if (!this.dragging) return;
      const point = this.intersectDragPlane(event);
      if (!point) return;
      const key = this.dragging.userData.key;
      // clamped to the stock *and* to what the other heights allow — dragging
      // the bottom plane up through the top one produces an operation that
      // cannot cut, and the handle should simply refuse to go there rather than
      // let go of a setting that reads fine and machines nothing
      const limit = this.limitsFor?.(key) ?? { min: -Infinity, max: Infinity };
      const z = Math.min(Math.max(
        clampToBounds(point.z + this.grabOffset, this.bounds), limit.min), limit.max);
      this.dragging.position.z = z;
      // the whole point of the section is that it changes as the plane moves
      this.refreshSection(this.dragging);
      this.onChange?.(key, z);
    });

    const end = (event) => {
      if (!this.dragging) return;
      const key = this.dragging.userData.key;
      const z = this.dragging.position.z;
      this.dragging = null;
      this.controls.enabled = true;
      try { canvas.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
      this.onCommit?.(key, z);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  pickGrip(event) {
    const ndc = this.pointerNdc(event);
    this.raycaster.setFromCamera(ndc, this.cameraOf());
    const grips = this.handles.map((h) => h.userData.grip);
    const hits = this.raycaster.intersectObjects(grips, false);
    if (hits.length === 0) return null;
    const handle = this.handles.find((h) => h.userData.grip === hits[0].object);
    return { handle, point: hits[0].point };
  }

  intersectDragPlane(event) {
    this.raycaster.setFromCamera(this.pointerNdc(event), this.cameraOf());
    const point = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.dragPlane, point) ? point : null;
  }

  pointerNdc(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  clear() {
    for (const handle of this.handles) {
      this.group.remove(handle);
      handle.traverse((node) => {
        node.geometry?.dispose();
        node.material?.dispose();
      });
    }
    this.handles.length = 0;
    this.applyVisibility();
  }

  /** The properties panel: is the user looking at the Heights tab? */
  setVisible(visible) {
    this.wanted = !!visible;
    this.applyVisibility();
  }

  /** The viewport: may anything be drawn over the part right now? */
  setAllowed(allowed) {
    this.allowed = !!allowed;
    this.applyVisibility();
  }

  applyVisibility() {
    const next = this.wanted && this.allowed && this.handles.length > 0;
    if (next === this.group.visible) return;
    this.group.visible = next;
    // Showing or hiding an object changes nothing on screen until something
    // draws a frame. Leaving that to the next camera move is what made the
    // handles appear only after an orbit, and vanish after the next one.
    this.requestRender();
  }
}

/**
 * Four L-shaped corners of a `width` × `depth` rectangle centred on the origin,
 * as line segments — enough to read the rectangle, little enough to see through.
 */
function cornerBrackets(width, depth) {
  const hw = width / 2;
  const hd = depth / 2;
  const arm = Math.min(width, depth) * 0.18;
  const points = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = sx * hw;
      const y = sy * hd;
      points.push(x, y, 0, x - sx * arm, y, 0);
      points.push(x, y, 0, x, y - sy * arm, 0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position',
    new THREE.BufferAttribute(Float32Array.from(points), 3));
  return geometry;
}

/** Keep a dragged height within reach of the job, with room above for rapids. */
function clampToBounds(z, bounds) {
  if (!bounds) return z;
  const span = bounds.max[2] - bounds.min[2];
  const lo = bounds.min[2] - span;
  const hi = bounds.max[2] + span * 2 + 10;
  return Math.min(Math.max(z, lo), hi);
}
