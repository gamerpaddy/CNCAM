// Dragging a clamp to where it actually is.
//
// A keep-out is measured off a real machine with a rule and typed into two
// boxes, and the only way to know the numbers landed where you meant is to look
// at the clamp next to the part. Which means the correction — "no, another ten
// millimetres back" — should be made in the same place you spotted it, not by
// going back to the panel, guessing a sign, and looking again.
//
// So the selected clamp gets handles: two arrows for one axis at a time, and a
// square in the middle for both at once. The drag is read off the horizontal
// plane the clamp sits on, which is the plane it can actually move in — a clamp
// bolted to the table has two degrees of freedom and a gizmo that offers three
// is a gizmo that lies.

import * as THREE from 'three';

const AXIS_COLORS = { x: 0xff6b6b, y: 0x7fe08a, xy: 0xffd166 };

export class MoveGizmo {
  constructor(scene, camera, renderer, controls, requestRender = () => {}) {
    this.cameraOf = typeof camera === 'function' ? camera : () => camera;
    this.renderer = renderer;
    this.controls = controls;
    this.requestRender = requestRender;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.handles = [];
    this.allowed = true;
    this.onChange = null;    // (x, y) while dragging
    this.onCommit = null;    // (x, y) on release — one undo entry per drag

    this.raycaster = new THREE.Raycaster();
    this.dragPlane = new THREE.Plane();
    this.dragging = null;
    this.startedAt = null;
    this.installDragging();
  }

  /**
   * Put handles on something at (x, y, z).
   * @param scale roughly how big the thing is, so the arrows are readable
   *   against a 400mm billet and do not swamp a 10mm clamp
   */
  show(x, y, z, scale = 20) {
    this.clear();
    const arm = Math.max(6, Math.min(scale * 0.9, 60));
    const thick = Math.max(0.6, arm * 0.06);

    for (const axis of ['x', 'y']) {
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(thick, thick, arm, 12),
        handleMaterial(AXIS_COLORS[axis]),
      );
      // three's cylinder stands on +Y; lay it along the axis it means
      shaft.geometry.translate(0, arm / 2, 0);
      if (axis === 'x') shaft.geometry.rotateZ(-Math.PI / 2);
      const head = new THREE.Mesh(
        new THREE.ConeGeometry(thick * 2.6, thick * 7, 14),
        handleMaterial(AXIS_COLORS[axis]),
      );
      head.geometry.translate(0, arm + thick * 3.5, 0);
      if (axis === 'x') head.geometry.rotateZ(-Math.PI / 2);

      const handle = new THREE.Group();
      handle.add(shaft, head);
      handle.userData = { axis, pickable: [shaft, head] };
      this.group.add(handle);
      this.handles.push(handle);
    }

    // the free handle: a flat pad in the corner between the two arrows
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(arm * 0.34, arm * 0.34),
      handleMaterial(AXIS_COLORS.xy, 0.5),
    );
    pad.geometry.translate(arm * 0.28, arm * 0.28, 0);
    const free = new THREE.Group();
    free.add(pad);
    free.userData = { axis: 'xy', pickable: [pad] };
    this.group.add(free);
    this.handles.push(free);

    this.group.position.set(x, y, z);
    this.applyVisibility();
    this.requestRender();
  }

  installDragging() {
    const canvas = this.renderer.domElement;

    canvas.addEventListener('pointerdown', (event) => {
      if (!this.group.visible) return;
      const hit = this.pick(event);
      if (!hit) return;
      // ahead of OrbitControls, or the camera spins instead of the clamp moving
      event.stopPropagation();
      event.preventDefault();
      this.controls.enabled = false;
      this.dragging = hit.handle;
      canvas.setPointerCapture(event.pointerId);

      // the clamp moves in the plane it is bolted to, so that is the plane the
      // pointer is read off
      this.dragPlane.setFromNormalAndCoplanarPoint(
        new THREE.Vector3(0, 0, 1), this.group.position.clone());
      const point = this.intersect(event);
      this.grab = point
        ? [this.group.position.x - point.x, this.group.position.y - point.y]
        : [0, 0];
      this.startedAt = [this.group.position.x, this.group.position.y];
    }, true);

    canvas.addEventListener('pointermove', (event) => {
      if (!this.dragging) return;
      const point = this.intersect(event);
      if (!point) return;
      const axis = this.dragging.userData.axis;
      const x = axis === 'y' ? this.startedAt[0] : point.x + this.grab[0];
      const y = axis === 'x' ? this.startedAt[1] : point.y + this.grab[1];
      this.group.position.x = x;
      this.group.position.y = y;
      this.onChange?.(x, y);
      this.requestRender();
    });

    const end = (event) => {
      if (!this.dragging) return;
      const from = this.startedAt;
      this.dragging = null;
      this.startedAt = null;
      this.controls.enabled = true;
      try { canvas.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
      const { x, y } = this.group.position;
      // a click that moved nothing is not an edit, and must not become one
      if (!from || (Math.abs(from[0] - x) < 1e-6 && Math.abs(from[1] - y) < 1e-6)) return;
      this.onCommit?.(x, y, from);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  pick(event) {
    this.raycaster.setFromCamera(this.ndc(event), this.cameraOf());
    const targets = this.handles.flatMap((h) => h.userData.pickable);
    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    const handle = this.handles.find((h) => h.userData.pickable.includes(hits[0].object));
    return handle ? { handle, point: hits[0].point } : null;
  }

  intersect(event) {
    this.raycaster.setFromCamera(this.ndc(event), this.cameraOf());
    const point = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.dragPlane, point) ? point : null;
  }

  ndc(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** Move the handles without rebuilding them — for edits made in the panel. */
  sync(x, y, z) {
    if (this.dragging) return;
    if (this.group.position.x === x && this.group.position.y === y
      && this.group.position.z === z) return;
    this.group.position.set(x, y, z);
    this.requestRender();
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

  /** The viewport: may anything be drawn over the part right now? */
  setAllowed(allowed) {
    this.allowed = !!allowed;
    this.applyVisibility();
  }

  applyVisibility() {
    const next = this.allowed && this.handles.length > 0;
    if (next === this.group.visible) return;
    this.group.visible = next;
    this.requestRender();
  }
}

function handleMaterial(color, opacity = 0.95) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    // over the part: a handle behind the thing it moves is a handle you cannot
    // grab, and these are small enough not to hide anything
    depthTest: false,
    side: THREE.DoubleSide,
  });
}
