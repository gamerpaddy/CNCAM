// three.js viewport. Z-up (machine convention), XY grid at Z=0.
// Owns the scene graph for models; the rest of the app talks in mesh ids.

import * as THREE from 'three';
import { creaseNormals, creaseEdges } from '../geom/shading.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildToolpathObject, buildStockObject } from './toolpath.js';
import { SimulationView } from './simulation.js';
import { HeightGizmos } from './height-gizmo.js';
import { MoveGizmo } from './move-gizmo.js';
import { buildAxes, OrientationTriad } from './axes.js';
import { installEnvironment, installHeadlight } from './lighting.js';
import { spinAngle } from '../engine/simulate.js';
import {
  VIEW_PRESETS, defaultViewFor, orbitUpOf, AXES_OF, SQUARE_ON_VIEWS,
} from './views.js';

const FOV = 45;

export class Viewport {
  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    // the corner triad is drawn as a second pass into the same buffer, which
    // means the buffer has to survive the first one
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1c1e22);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 10000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(120, -120, 90);

    // The other projection, kept alongside rather than rebuilt on every switch:
    // OrbitControls holds a reference to whichever one is live, and swapping the
    // object under it is one assignment where tearing the controls down and
    // rebuilding them would drop every listener hanging off them.
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
    this.orthoCamera.up.set(0, 0, 1);
    this.projection = 'perspective';
    // The preference; `projection` is what is on screen because of it and the
    // view the camera is in. One of them is chosen and the other is derived —
    // never both stored and allowed to disagree.
    this.projectionMode = 'auto';
    this.viewName = null;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.requestRender());
    this.orbitUp = [0, 0, 1];

    this.machine = 'mill';
    this.buildEnvironment();
    this.triad = new OrientationTriad(this.renderer);

    // Models hang off a group carrying the active setup's orientation, so the
    // viewport shows the part as it will actually be fixtured — same frame the
    // toolpaths and G-code are in.
    this.modelGroup = new THREE.Group();
    this.modelGroup.matrixAutoUpdate = false;
    this.scene.add(this.modelGroup);
    this.modelObjects = new Map();   // modelId -> THREE.Mesh
    this.stockObject = null;
    this.fixtureObjects = [];
    this.toolpathObject = null;
    this.markerObject = null;

    this.simulation = new SimulationView(this.scene);
    this.simulation.setVisible(false);

    // The gizmos have to be able to ask for a frame. Without that, showing or
    // hiding them changed the scene graph and nothing redrew it — so the
    // handles appeared the next time the camera moved and disappeared the time
    // after, which read as a gizmo that only works if you orbit first.
    // a getter, not the camera: the projection toggle swaps which one is live,
    // and a gizmo holding the other one raycasts against a camera nothing is
    // being drawn through
    this.heights = new HeightGizmos(this.scene, () => this.activeCamera(),
      this.renderer, this.controls, () => this.requestRender());
    // Clamps are placed by typing two numbers and then looking at the picture.
    // The correction belongs where the mistake was spotted.
    this.moveGizmo = new MoveGizmo(this.scene, () => this.activeCamera(),
      this.renderer, this.controls, () => this.requestRender());

    this.raycaster = new THREE.Raycaster();
    this.pickHandler = null;
    this.regionOverlays = new Map();  // key -> THREE.Mesh
    this.installPicking();

    this.renderPending = false;
    // The canvas is a fixed-size buffer and everything about the view depends
    // on it matching the element: get it wrong and the part is drawn stretched
    // and picking lands somewhere the user did not click.
    //
    // Two ways of hearing about it, on purpose. The observer catches a panel
    // being dragged, which the window never hears about; the window listener
    // catches the window itself, and does not depend on the observer surviving
    // — it is held in a field rather than constructed inline for the same
    // reason, since an observer nothing references is one garbage collection
    // away from silence.
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.onWindowResize = () => this.resize();
    window.addEventListener('resize', this.onWindowResize);
    this.resize();
  }

  /** Let go of everything the browser is holding on our behalf. */
  dispose() {
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.triad?.dispose();
    this.disposeEnvironment?.();
    this.renderer.dispose();
  }

  /**
   * Report clicks on model geometry as { modelId, triangleIndex, point }.
   * Orbiting also ends in a pointerup, so a drag past a few pixels is ignored —
   * otherwise every camera move would select something.
   */
  installPicking() {
    const canvas = this.renderer.domElement;
    let down = null;
    let rotating = false;
    canvas.addEventListener('pointerdown', (e) => {
      down = [e.clientX, e.clientY];
      // Which drag this is going to be, decided by the same rule OrbitControls
      // uses: left button orbits, right and middle pan and dolly, and a
      // modifier turns the left button into a pan too.
      rotating = e.button === 0 && !(e.ctrlKey || e.metaKey || e.shiftKey);
    });
    // *Orbiting* is the signal that ends a temporary orthographic view — it is
    // the only drag that stops the camera being square on. Panning and zooming
    // keep the view direction, so Front stays Front and stays parallel; kicking
    // them back to perspective threw away the measuring view mid-measurement,
    // which is the reported bug. A *click* is not a camera move either: picking
    // a face square on is exactly what a face view is for.
    canvas.addEventListener('pointermove', (e) => {
      if (!down || !rotating) return;
      if (Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) this.leaveNamedView();
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || !this.pickHandler) { down = null; return; }
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved > 4) return;

      const hit = this.pick(e);
      if (hit) this.pickHandler(hit);
    });
  }

  pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.scene.updateMatrixWorld(true);
    this.raycaster.setFromCamera(ndc, this.activeCamera());
    // the surfaces only: the crease-edge overlay is not something to click on
    const targets = [...this.modelObjects.values()].map((o) => o.userData.surface);
    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    return {
      modelId: hit.object.userData.modelId,
      triangleIndex: hit.faceIndex,
      point: hit.point.toArray(),
      // The same place in the model's own coordinates. Anything that compares
      // the hit against mesh.positions — picking an edge, say — has to, because
      // the model group carries the setup's orientation and the mesh does not
      // know about it. Reading world coordinates against model geometry finds
      // whatever crease happens to be nearest the origin instead.
      localPoint: hit.object.worldToLocal(hit.point.clone()).toArray(),
    };
  }

  setPickHandler(handler) {
    this.pickHandler = handler;
    this.renderer.domElement.style.cursor = handler ? 'crosshair' : '';
  }

  /**
   * Draw a picked face set over the model. `triangles` are triangle indices
   * into the model's mesh; geometry is parented to modelGroup so overlays
   * follow the setup orientation with everything else.
   */
  setRegionOverlay(key, modelId, mesh, triangles, color) {
    const existing = this.regionOverlays.get(key);
    if (existing) {
      this.modelGroup.remove(existing);
      existing.geometry.dispose();
      existing.material.dispose();
      this.regionOverlays.delete(key);
    }
    if (!mesh || !triangles || triangles.length === 0) return this.requestRender();

    const positions = new Float32Array(triangles.length * 9);
    for (let n = 0; n < triangles.length; n++) {
      const t = triangles[n];
      for (let e = 0; e < 3; e++) {
        const v = mesh.indices[t * 3 + e] * 3;
        positions[n * 9 + e * 3] = mesh.positions[v];
        positions[n * 9 + e * 3 + 1] = mesh.positions[v + 1];
        positions[n * 9 + e * 3 + 2] = mesh.positions[v + 2];
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const overlay = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.45, depthTest: true,
      polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide,
    }));
    overlay.userData.modelId = modelId;
    this.modelGroup.add(overlay);
    this.regionOverlays.set(key, overlay);
    this.requestRender();
  }

  /**
   * The same, for a picked *edge*: a line rather than a patch of surface.
   *
   * Drawn thick and with depth testing off, because an edge overlay sits
   * exactly on the geometry it marks and a line that z-fights with the part it
   * is drawn on is a line you cannot see — which reads as a pick that did not
   * register.
   *
   * @param points flat [x, y, z, …], two per segment
   */
  setEdgeOverlay(key, modelId, points, color) {
    const existing = this.regionOverlays.get(key);
    if (existing) {
      this.modelGroup.remove(existing);
      existing.geometry.dispose();
      existing.material.dispose();
      this.regionOverlays.delete(key);
    }
    if (!points || points.length < 6) return this.requestRender();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(points), 3));
    const overlay = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color, depthTest: false, transparent: true, opacity: 0.95,
    }));
    overlay.renderOrder = 3;
    overlay.userData.modelId = modelId;
    this.modelGroup.add(overlay);
    this.regionOverlays.set(key, overlay);
    this.requestRender();
  }

  clearRegionOverlays() {
    for (const key of [...this.regionOverlays.keys()]) {
      const overlay = this.regionOverlays.get(key);
      if (overlay?.isLineSegments) this.setEdgeOverlay(key, null, null, 0);
      else this.setRegionOverlay(key, null, null, null, 0);
    }
  }

  /**
   * The table grid, as one XY plane just below Z0.
   *
   * *Just* below, and not on it, because Z0 is where the top of the stock is
   * set on nearly every job — that is what setting the tool on the work means.
   * Two coplanar surfaces cannot be depth-sorted at any precision, so the grid
   * and the billet took it in turns per pixel and the whole top face came out
   * criss-crossed with table lines. The drop is a couple of thousandths of the
   * scene: far enough that the depth buffer can tell them apart, near enough
   * that nothing about where the grid *is* has changed.
   *
   * It also never writes depth. A reference plane that hides the part is not a
   * reference for anything, and this way the work always wins.
   */
  makeGrid(size, divisions) {
    const grid = new THREE.GridHelper(size, divisions, 0x3a3e46, 0x2a2d33);
    grid.rotation.x = Math.PI / 2;   // GridHelper is XZ by default; we want XY
    grid.position.z = -Math.max(0.02, size * 0.001);
    grid.material.depthWrite = false;
    grid.renderOrder = -1;
    return grid;
  }

  buildEnvironment() {
    this.grid = this.makeGrid(200, 20);
    this.scene.add(this.grid);

    // A lathe has no table to put a grid on. What it has is a spindle axis, and
    // that is the line every Z on the screen is measured along — so the grid
    // stands down and the axis is drawn instead.
    this.spindleAxis = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, -500), new THREE.Vector3(0, 0, 500),
      ]),
      new THREE.LineDashedMaterial({
        color: 0x5aa9ff, dashSize: 6, gapSize: 4, transparent: true, opacity: 0.7,
      }),
    );
    this.spindleAxis.computeLineDistances();
    this.spindleAxis.visible = false;
    this.scene.add(this.spindleAxis);

    this.axes = buildAxes(20, this.axesForMachine());
    this.scene.add(this.axes);

    // The environment is what metal reflects, and without it every metallic
    // surface in the scene renders black — see view/lighting.js. The lights
    // below shape it; they were never going to light it on their own.
    this.disposeEnvironment = installEnvironment(this.scene, this.renderer);
    this.scene.environmentIntensity = 0.9;

    // A hemisphere light's "sky" is whichever way its position points, and the
    // default is +Y. This scene is Z-up, so the default put the sky out to one
    // side of the table and the ground colour on the other: the −Y face of
    // every part — the one the mill's default view looks straight at — was lit
    // as if it were underneath. Up is +Z here, as it is everywhere else.
    const sky = new THREE.HemisphereLight(0xffffff, 0x333944, 0.55);
    sky.position.set(0, 0, 1);
    this.scene.add(sky);
    // Lit from both sides of the table, because the two machines are looked at
    // from opposite ones: a mill from −Y, a lathe from +Y (the chuck has to be
    // on the left). One key light meant whichever machine was not the one it
    // was aimed at showed the part in silhouette.
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(100, -60, 150);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8);
    fill.position.set(-60, 100, 120);
    this.scene.add(fill);
    // …and a dim one from wherever the camera is, so that nothing vertical is
    // invisible. See installHeadlight.
    this.aimHeadlight = installHeadlight(this.scene);
  }

  /**
   * Point the viewport at a machine.
   *
   * A lathe is not a mill seen from a different angle. The part spins about Z,
   * the tool works in one plane, and the grid on the XY table means nothing —
   * so what is drawn changes with the machine, and so does the view it opens on.
   */
  setMachine(machine) {
    if (machine === this.machine) return;
    this.machine = machine;
    const turning = machine === 'turn';
    this.spindleAxis.visible = turning;
    // A lathe has two axes. Drawing a Y arrow on one is drawing an axis that
    // does not exist, cannot be programmed and is refused by the post on the
    // way out — so it stands down with the table grid.
    this.rebuildAxes(this.envSize
      ? Math.max(8, Math.min(this.envSize * 0.35, 250)) : 20);
    this.setView(defaultViewFor(machine));
  }

  /** Which axes this machine actually has. */
  axesForMachine() {
    return AXES_OF[this.machine] ?? AXES_OF.mill;
  }

  rebuildAxes(length) {
    this.scene.remove(this.axes);
    this.axes.userData.dispose?.();
    this.axes = buildAxes(length, this.axesForMachine());
    this.scene.add(this.axes);
    this.triad?.setAxes(this.axesForMachine());
    this.applyEnvironmentVisibility();
  }

  /**
   * Whether the grid and the axis arrows are drawn.
   *
   * Held here rather than written onto the objects, because both are rebuilt —
   * the grid whenever the job changes scale, the axes whenever the machine
   * changes — and a flag written onto the object that got thrown away is a
   * preference that silently stops working the first time you import
   * something.
   */
  setEnvironmentVisible({ grid, axes }) {
    if (grid !== undefined) this.wantGrid = grid;
    if (axes !== undefined) this.wantAxes = axes;
    this.applyEnvironmentVisibility();
    this.requestRender();
  }

  applyEnvironmentVisibility() {
    // a lathe never shows a table grid whatever the setting says: there is no
    // table, and the spindle axis is drawn in its place
    this.grid.visible = (this.wantGrid ?? true) && this.machine !== 'turn';
    this.axes.visible = this.wantAxes ?? true;
  }

  /**
   * Snap the camera to a named view, keeping what it was looking at.
   *
   * The distance is preserved rather than reset: switching from Front to Right
   * to see the other side of a feature you are zoomed in on should not throw
   * away the zoom, which is the thing that made the feature visible.
   */
  setView(name, { distance: want = null } = {}) {
    const preset = VIEW_PRESETS[name] ?? VIEW_PRESETS.iso;
    this.viewName = VIEW_PRESETS[name] ? name : 'iso';
    const target = this.controls.target.clone();
    // From what is on screen, not from where the perspective camera happens to
    // be sitting: in an orthographic view that camera has not moved since the
    // projection was switched, so reading a distance off it threw away every
    // zoom the user had made since — the one thing this is careful not to do.
    const distance = want ?? (this.viewSpan() / (2 * Math.tan((FOV * Math.PI) / 360)));
    const dir = new THREE.Vector3(...preset.dir).normalize().multiplyScalar(distance);
    this.camera.up.set(...preset.up);
    this.orthoCamera.up.set(...preset.up);
    this.camera.position.copy(target).add(dir);
    this.orthoCamera.position.copy(this.camera.position);
    this.camera.lookAt(target);
    this.orthoCamera.lookAt(target);
    this.setOrbitAxis(orbitUpOf(preset));
    this.controls.update();
    this.applyAutoProjection();
    this.requestRender();
    this.onViewChange?.(this.viewName, this.projection);
    return preset;
  }

  /**
   * A square-on view is a measuring view, so it is drawn square on.
   *
   * Asking for Front or Side means wanting to compare things — two diameters at
   * opposite ends of a bar, a shoulder against a shoulder — and perspective
   * makes the far one smaller, which is the one property that ruins the
   * comparison. So a face view is drawn orthographic, and orbiting away from it
   * goes back to perspective, because an isometric with parallel projection
   * reads as a drawing rather than as a part.
   *
   * This is *derived*, not toggled, and that is the whole of the fix to the
   * reported bug. It used to be a second piece of state — `autoOrtho` — that
   * switched the live camera behind the setting's back, so the control said
   * Perspective while the screen was orthographic, and picking Orthographic
   * while the auto one was already on did nothing except leave a flag armed to
   * undo the choice at the next orbit. There is one description now: the
   * setting, which is three-valued, and a view name. See `resolveProjection`.
   */
  applyAutoProjection() {
    this.setProjection(this.resolveProjection());
  }

  /** What `projectionMode` means for the view the camera is actually in. */
  resolveProjection() {
    if (this.projectionMode === 'perspective') return 'perspective';
    if (this.projectionMode === 'orthographic') return 'orthographic';
    return SQUARE_ON_VIEWS.has(this.viewName) ? 'orthographic' : 'perspective';
  }

  /**
   * The preference: 'auto', 'perspective' or 'orthographic'.
   *
   * Auto is the default and is what most people mean — square-on to measure,
   * perspective to look at — but it has to be a value the control can *show*,
   * or the control is lying every time auto disagrees with it.
   */
  setProjectionMode(mode) {
    this.projectionMode = ['perspective', 'orthographic'].includes(mode) ? mode : 'auto';
    return this.setProjection(this.resolveProjection());
  }

  /**
   * Orbiting leaves the named view, so on auto it also leaves its projection.
   * Nothing else here knows the camera is still pointing where it was: the view
   * name is what "square on" means, and a drag is what stops it being true.
   */
  leaveNamedView() {
    if (this.viewName === null) return;
    this.viewName = null;
    if (this.projectionMode === 'auto') this.setProjection('perspective');
    this.onViewChange?.(this.viewName, this.projection);
  }

  /**
   * Which axis the orbit swings about.
   *
   * OrbitControls derives its orbit frame from `object.up` **once, in its
   * constructor**, and never looks at it again. Everything after that — every
   * named view that sets a different up, and in particular every lathe view,
   * which stands X on end so the bar lies down — orbited about world Z while
   * the camera was held up by X. The result is the reported bug exactly:
   * dragging sideways rolled the bar about its own axis and dragging up and
   * down swung it end-on, which is both of them doing the other one's job.
   *
   * The frame is a private field with no setter, so it is recomputed here. The
   * axis is *not* simply the camera's up: on a lathe the bar is drawn lying
   * down (up is X, the cross-slide) and the thing you want to walk around is
   * the bar, so the pole is Z. See `orbitUp` in view/views.js.
   */
  setOrbitAxis(axis) {
    const next = new THREE.Vector3(...axis).normalize();
    if (next.lengthSq() < 1e-9) return;
    this.orbitUp = next.toArray();
    const controls = this.controls;
    // `_quat` is r169's name for it; older builds called it `quat`. Both are
    // written, so a vendor bump does not silently reinstate the bug.
    const quat = new THREE.Quaternion().setFromUnitVectors(next, new THREE.Vector3(0, 1, 0));
    const inverse = quat.clone().invert();
    if (controls._quat) { controls._quat.copy(quat); controls._quatInverse.copy(inverse); }
    if (controls.quat) { controls.quat.copy(quat); controls.quatInverse.copy(inverse); }
  }

  /**
   * Perspective or orthographic.
   *
   * A perspective view is what the part looks like; an orthographic one is what
   * it *is*. Parallel edges stay parallel, so a shoulder at the far end of a bar
   * and one at the near end are drawn the same size and can be compared — which
   * is the whole reason for looking square-on at anything.
   *
   * The two cameras share a position, a target and an up, so switching is not a
   * camera move: whatever you were looking at, you go on looking at.
   */
  setProjection(mode) {
    const next = mode === 'orthographic' ? 'orthographic' : 'perspective';
    if (next === this.projection) return this.projection;
    const from = this.activeCamera();
    const target = this.controls.target;
    const distance = Math.max(1e-3, from.position.distanceTo(target));

    this.projection = next;
    const to = this.activeCamera();
    to.position.copy(from.position);
    to.up.copy(from.up);
    to.lookAt(target);
    if (next === 'orthographic') {
      // the frustum that shows exactly what the perspective camera showed at
      // the distance it was at, so the swap is not also a zoom
      this.orthoHeight = 2 * distance * Math.tan((FOV * Math.PI) / 360);
      this.orthoCamera.zoom = 1;
    } else {
      // and back the other way: the distance that frames the ortho frustum
      const height = this.orthoHeight / (this.orthoCamera.zoom || 1);
      const back = height / (2 * Math.tan((FOV * Math.PI) / 360));
      const dir = new THREE.Vector3().subVectors(from.position, target).normalize();
      this.camera.position.copy(target).add(dir.multiplyScalar(back));
    }
    this.controls.object = to;
    this.setOrbitAxis(this.orbitUp);
    this.resize();
    this.controls.update();
    this.requestRender();
    this.onViewChange?.(this.viewName, this.projection);
    return this.projection;
  }

  /** The camera currently doing the drawing. */
  activeCamera() {
    return this.projection === 'orthographic' ? this.orthoCamera : this.camera;
  }

  /** Roughly how big the scene is, for framing and for near/far planes. */
  sceneSize() {
    const box = new THREE.Box3().setFromObject(this.modelGroup);
    if (this.stockObject) box.expandByObject(this.stockObject);
    return box.isEmpty() ? 100 : (box.getSize(new THREE.Vector3()).length() || 100);
  }

  /**
   * Scale the axis arrows and the grid to the job.
   *
   * A 20mm axis triad on a 400mm billet is invisible and on a 5mm part it fills
   * the screen. Both were the same three lines, which is why neither looked
   * like a reference for anything.
   */
  scaleEnvironment() {
    const size = this.sceneSize();
    // Rebuilding the axes and the grid means disposing and re-uploading
    // geometry, and this is reachable from every document change. A part that
    // grew by a millimetre does not need new axes, so only a real change in
    // scale counts as one.
    if (this.envSize && size > this.envSize * 0.8 && size < this.envSize * 1.25) return;
    this.envSize = size;
    const axisLength = Math.max(8, Math.min(size * 0.35, 250));
    this.rebuildAxes(axisLength);

    // grid squares in a round number of millimetres, so counting them means
    // something: 1, 2, 5, 10, 20, 50 …
    const step = niceStep(size / 16);
    const divisions = Math.max(8, Math.min(60, Math.round((size * 1.6) / step)));
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    this.grid = this.makeGrid(step * divisions, divisions);
    this.scene.add(this.grid);
    this.applyEnvironmentVisibility();
    this.requestRender();
  }

  /** mesh: { positions, indices, normals? } (plain typed arrays from geom/mesh.js) */
  /**
   * Put a model in the scene, shaded so its edges are visible.
   *
   * The mesh arrives with smoothed normals — every face averaged into every
   * other at each shared vertex — which is right for a curved surface and turns
   * a machined part into a glassy blob with no corners anywhere. So the display
   * geometry gets crease normals instead, and the hard edges are drawn as lines
   * on top of the shading. See geom/shading.js.
   */
  addModel(modelId, mesh) {
    const object = new THREE.Group();
    const shaded = creaseNormals(mesh);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(shaded.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(shaded.normals, 3));

    const material = new THREE.MeshStandardMaterial({
      color: 0x9fb4c7, metalness: 0.1, roughness: 0.65,
      polygonOffset: true, polygonOffsetFactor: 1,
    });
    // The pickable surface. Face picking indexes into the original triangle
    // list, and the display geometry is the same triangles in the same order,
    // so a hit's faceIndex still means what regions-ui.js thinks it means.
    const surface = new THREE.Mesh(geometry, material);
    surface.userData.modelId = modelId;
    object.add(surface);

    const edges = creaseEdges(mesh);
    if (edges.length > 0) {
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.BufferAttribute(edges, 3));
      const lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({
        color: 0x2b3440, transparent: true, opacity: 0.75, depthWrite: false,
      }));
      lines.userData.isEdges = true;
      // never pickable: clicking a corner should select the face behind it
      lines.raycast = () => {};
      object.add(lines);
    }

    object.userData.modelId = modelId;
    object.userData.surface = surface;
    this.modelGroup.add(object);
    this.modelObjects.set(modelId, object);
    this.requestRender();
    return object;
  }

  removeModel(modelId) {
    const object = this.modelObjects.get(modelId);
    if (!object) return;
    this.modelGroup.remove(object);
    object.traverse((node) => {
      node.geometry?.dispose();
      node.material?.dispose();
    });
    this.modelObjects.delete(modelId);
    this.requestRender();
  }

  /**
   * Place models in setup space. `matrix` is the row-major 3x3 rotation and
   * `offset` the datum shift, both from engine/setup.js resolveSetup().
   *
   * Changing the datum moves the part in world space — adding a setup can shift
   * it by half its own size — so the camera is carried along by the same delta.
   * Without that the part slides out of frame and reads as having vanished.
   */
  setSetupTransform(matrix, offset = [0, 0, 0]) {
    const m = matrix ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const next = new THREE.Matrix4().set(
      m[0], m[1], m[2], offset[0],
      m[3], m[4], m[5], offset[1],
      m[6], m[7], m[8], offset[2],
      0, 0, 0, 1,
    );
    if (next.equals(this.modelGroup.matrix)) return;

    const anchor = this.modelAnchor();
    const before = anchor?.clone().applyMatrix4(this.modelGroup.matrix);

    this.modelGroup.matrix.copy(next);
    this.modelGroup.matrixWorldNeedsUpdate = true;

    if (anchor && before) {
      const after = anchor.clone().applyMatrix4(next);
      const delta = after.sub(before);
      this.controls.target.add(delta);
      this.camera.position.add(delta);
      this.orthoCamera.position.add(delta);
      this.controls.update();
    }
    this.requestRender();
  }

  /** Centre of the models in group-local space, or null when there are none. */
  modelAnchor() {
    const box = new THREE.Box3();
    for (const object of this.modelObjects.values()) {
      const geometry = object.userData.surface.geometry;
      geometry.computeBoundingBox();
      box.union(geometry.boundingBox);
    }
    return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
  }

  /** stock: { min, max, kind?, cylinder? } or null to hide. */
  setStock(stock) {
    if (this.stockObject) {
      this.scene.remove(this.stockObject);
      // a tube is two wireframes, so this walks rather than assuming one mesh
      this.stockObject.traverse((node) => {
        node.geometry?.dispose();
        node.material?.dispose();
      });
      this.stockObject = null;
    }
    if (stock) {
      this.stockObject = buildStockObject(stock);
      this.scene.add(this.stockObject);
    }
    // the billet is usually the biggest thing in the scene, so it is what the
    // grid squares and the axis arrows should be sized against
    this.scaleEnvironment();
    this.requestRender();
  }

  /**
   * Draw the setup's clamps.
   *
   * A keep-out you cannot see is a keep-out you will get wrong — the numbers
   * are measured off a real machine and typed into a box, and the only way to
   * know they landed where you meant is to look at them next to the part.
   * Drawn in a warning colour and slightly transparent, so a clamp overlapping
   * something it should not is obvious at a glance.
   */
  setFixtures(fixtures) {
    for (const object of this.fixtureObjects) {
      this.scene.remove(object);
      object.traverse((node) => {
        node.geometry?.dispose();
        node.material?.dispose();
      });
    }
    this.fixtureObjects = [];

    for (const fixture of fixtures ?? []) {
      if (fixture.enabled === false) continue;
      if (fixture.kind === 'chuck') {
        const chuck = buildChuck(fixture);
        // A chuck is bolted to the spindle, so it turns with the work. Leaving
        // it standing still while the bar spun inside it was a picture of a bar
        // slipping in the jaws.
        chuck.userData.spins = true;
        this.scene.add(chuck);
        this.fixtureObjects.push(chuck);
        continue;
      }
      const height = Math.max(0.5, fixture.height ?? 20);
      const geometry = fixture.kind === 'cylinder'
        ? new THREE.CylinderGeometry(
          Math.max(0.1, (fixture.diameter ?? 20) / 2),
          Math.max(0.1, (fixture.diameter ?? 20) / 2), height, 32,
        )
        : new THREE.BoxGeometry(
          Math.max(0.1, fixture.size?.[0] ?? 40),
          Math.max(0.1, fixture.size?.[1] ?? 20),
          height,
        );
      // CylinderGeometry stands on +Y; the scene is Z-up
      if (fixture.kind === 'cylinder') geometry.rotateX(Math.PI / 2);

      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: 0xff5566,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        roughness: 0.8,
      }));
      const [cx, cy] = fixture.center ?? [0, 0];
      mesh.position.set(cx, cy, (fixture.baseZ ?? 0) + height / 2);
      if (fixture.kind !== 'cylinder') {
        mesh.rotation.z = ((fixture.rotationDeg ?? 0) * Math.PI) / 180;
      }
      mesh.renderOrder = 3;
      this.scene.add(mesh);
      this.fixtureObjects.push(mesh);
    }
    this.requestRender();
  }

  /**
   * Turn the spindle: the work and everything bolted to it.
   *
   * One angle for both, from `spinAngle` — the chuck and the bar it is gripping
   * cannot be given two answers about where the spindle is pointing without one
   * of them appearing to slip.
   */
  spinWork(seconds, rpm) {
    const angle = spinAngle(seconds, rpm);
    this.simulation.setSpin(angle);
    for (const object of this.fixtureObjects) {
      if (object.userData.spins) object.rotation.z = angle;
    }
  }

  /**
   * How the backplot is drawn: whether rapids are in it, and how loud it is.
   *
   * Rapids are the orange half of a backplot and on a job with a lot of
   * retracts they are most of the lines on screen. Being able to drop them
   * leaves only metal being cut, which is what you want when checking a path
   * rather than its linking.
   */
  setToolpathStyle(style) {
    this.toolpathStyle = { ...(this.toolpathStyle ?? {}), ...style };
    if (this.lastToolpaths) this.setToolpaths(this.lastToolpaths);
  }

  /** clPrograms: array of finished CL programs, or null to hide. */
  setToolpaths(clPrograms) {
    if (this.toolpathObject) {
      this.scene.remove(this.toolpathObject);
      this.toolpathObject.geometry.dispose();
      this.toolpathObject.material.dispose();
      this.toolpathObject = null;
    }
    this.lastToolpaths = clPrograms;
    if (clPrograms && clPrograms.length) {
      this.toolpathObject = buildToolpathObject(clPrograms, this.toolpathStyle);
      this.toolpathObject.visible = this.showToolpaths !== false;
      this.scene.add(this.toolpathObject);
    }
    this.requestRender();
  }

  /**
   * Hide the backplot without throwing it away.
   *
   * A finished job is eleven overlapping paths drawn over the part, and the
   * question they are in the way of — "does the surface look right" — is asked
   * far more often than the question they answer. Held as a flag on the
   * viewport rather than on the object, because the object is rebuilt every
   * time the program changes and a `visible` written onto the old one is a
   * setting that silently stops working.
   */
  setToolpathsVisible(on) {
    this.showToolpaths = on !== false;
    if (this.toolpathObject) this.toolpathObject.visible = this.showToolpaths;
    this.requestRender();
    return this.showToolpaths;
  }

  toolpathsVisible() {
    return this.showToolpaths !== false;
  }

  /**
   * Draw imported DXF drawings on the top of the stock.
   *
   * A drawing you cannot see is a drawing you cannot place. Two numbers and a
   * scale factor say nothing about whether the logo lands on the part or half
   * off the side of it, and lifting it a hair above the surface keeps it from
   * z-fighting the face it is drawn on.
   *
   * @param drawings [{ paths, z, selected }]
   */
  setDrawings(drawings) {
    for (const object of this.drawingObjects ?? []) {
      this.scene.remove(object);
      object.geometry.dispose();
      object.material.dispose();
    }
    this.drawingObjects = [];

    for (const { paths, z, selected } of drawings ?? []) {
      const positions = [];
      for (const { points, closed } of paths) {
        const n = points.length / 2;
        for (let i = 1; i < n; i++) {
          positions.push(points[i * 2 - 2], points[i * 2 - 1], z,
            points[i * 2], points[i * 2 + 1], z);
        }
        if (closed && n > 2) {
          positions.push(points[(n - 1) * 2], points[(n - 1) * 2 + 1], z,
            points[0], points[1], z);
        }
      }
      if (positions.length === 0) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
        color: selected ? 0x7fe08a : 0x4a9eff,
        transparent: true,
        opacity: selected ? 1 : 0.75,
        depthTest: false,
      }));
      lines.renderOrder = 4;
      this.scene.add(lines);
      this.drawingObjects.push(lines);
    }
    this.requestRender();
  }

  /** Highlight a point on the toolpath (G-code line click). null hides. */
  /**
   * How much of the world the view spans from top to bottom, in millimetres.
   *
   * The one honest answer to "how big is a thing on screen", and the only one
   * that works in both projections: a perspective camera says it by how far
   * back it is, an orthographic one by its frustum and its zoom, and asking the
   * perspective camera while the orthographic one is live gets a number that
   * stopped being true the moment anybody scrolled.
   */
  viewSpan() {
    if (this.projection === 'orthographic') {
      return (this.orthoHeight ?? this.sceneSize() * 1.25) / (this.orthoCamera.zoom || 1);
    }
    const distance = this.camera.position.distanceTo(this.controls.target)
      || this.sceneSize() * 1.2;
    return 2 * distance * Math.tan((FOV * Math.PI) / 360);
  }

  /**
   * A dot on a point of interest, sized to the view rather than to the part.
   *
   * Sized here, because sizing it needs to know which camera is live and how
   * far zoomed in it is, and the panel that asks for a marker has no business
   * knowing either — it used to reach for `viewport.camera` directly and got
   * the wrong one whenever the view was orthographic.
   */
  setMarker(position, radius = this.viewSpan() / 90) {
    if (this.markerObject) {
      this.scene.remove(this.markerObject);
      this.markerObject.geometry.dispose();
      this.markerObject.material.dispose();
      this.markerObject = null;
    }
    if (position) {
      this.markerObject = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xff4477 }),
      );
      this.markerObject.position.set(...position);
      this.scene.add(this.markerObject);
    }
    this.requestRender();
  }

  /**
   * Simulation mode swaps the model for the cut stock. Showing both would just
   * be z-fighting — the simulated surface *is* the part once it is finished.
   */
  setSimulationMode(active) {
    this.simulation.setVisible(active);
    // Not setVisible: that is the panel's answer about which tab is open, and
    // overwriting it here left the gizmos hidden after a simulation closed even
    // though the Heights tab was still in front of the user.
    this.heights.setAllowed(!active);
    this.moveGizmo.setAllowed(!active);
    this.modelGroup.visible = !active;
    if (this.stockObject) this.stockObject.visible = !active;
    if (this.toolpathObject) {
      this.toolpathObject.visible = !active && this.showToolpaths !== false;
    }
    for (const object of this.drawingObjects ?? []) object.visible = !active;
    this.requestRender();
  }

  setHighlight(modelId) {
    for (const [id, object] of this.modelObjects) {
      object.userData.surface.material.emissive.setHex(id === modelId ? 0x1a3a5c : 0x000000);
    }
    this.requestRender();
  }

  /**
   * Put the camera where it can see everything.
   *
   * Framed on the models *plus the stock*, in world space — the setup transform
   * moves the part from wherever the CAD authored it to the machining datum, so
   * framing the raw geometry aims at a place nothing is. The world matrix is
   * refreshed first because the transform is applied by hand
   * (matrixAutoUpdate is off) and may not have been flushed yet this frame.
   */
  frameAll() {
    this.modelGroup.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.modelGroup);
    if (this.stockObject) box.expandByObject(this.stockObject);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() || 100;
    this.controls.target.copy(center);
    for (const camera of [this.camera, this.orthoCamera]) {
      // A near plane scaled to the part is what keeps a 5mm job from z-fighting
      // itself; an orthographic camera also has to see *behind* itself, because
      // its position carries no depth information at all.
      camera.near = camera.isOrthographicCamera ? -size * 10 : size / 1000;
      camera.far = size * 100;
    }
    this.orthoHeight = size * 1.25;
    this.orthoCamera.zoom = 1;
    // Aiming is setView's job, and only setView's. Repeating the direction, the
    // up vector and the orbit pole here left out the *fourth* thing setView
    // does — switching a square-on view to orthographic — so framing the job
    // landed the lathe on its Plan view in perspective, which is the one
    // projection that makes a ZX profile not worth looking at. The machine
    // still decides which way "a good look at it" is; it says so in one place.
    this.setView(defaultViewFor(this.machine), { distance: size * 1.2 });
    this.resize();
    this.scaleEnvironment();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    // The orthographic frustum is a size in world units, not an angle, so it is
    // the *aspect* that has to be applied to it by hand.
    const height = this.orthoHeight ?? this.sceneSize() * 1.25;
    const halfH = Math.max(1e-3, height / 2);
    const halfW = halfH * (w / h);
    Object.assign(this.orthoCamera, {
      left: -halfW, right: halfW, top: halfH, bottom: -halfH,
    });
    this.orthoCamera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      const camera = this.activeCamera();
      this.aimHeadlight?.(camera);
      // a splat surface sizes its points in pixels, so it needs the camera kind
      // and the drawing-buffer height afresh each frame
      this.simulation?.syncSplat?.(camera, this.renderer.domElement.height);
      this.renderer.clear();
      this.renderer.render(this.scene, camera);
      // over the top, in its own corner: the one thing on screen that always
      // says which way you are looking
      this.triad.render(camera);
    });
  }
}

/**
 * A chuck, drawn as one: a body on the spindle axis with jaws standing out of
 * its face, gripping at the diameter it was told to grip at.
 *
 * Worth drawing properly rather than as another red box. The two questions it
 * answers are the two that get turned parts wrong — how much of the bar is
 * buried in the jaws, and how far along it the tool can still reach — and both
 * are things you read off a picture in a second and cannot read off three
 * numbers at all. Jaws gripping a bore are drawn pointing outward, because that
 * is the opposite keep-out and it should not look the same.
 */
function buildChuck(fixture) {
  const group = new THREE.Group();
  const faceZ = fixture.faceZ ?? 0;
  const bodyD = Math.max(1, fixture.bodyDiameter ?? 125);
  const bodyL = Math.max(1, fixture.bodyLength ?? 60);
  const jawL = Math.max(0, fixture.jawLength ?? 20);
  const jawW = Math.max(0.5, fixture.jawWidth ?? 18);
  const grip = Math.max(0.5, fixture.clampDiameter ?? 30) / 2;
  const inside = (fixture.chuckMode ?? 'outside') === 'inside';
  const [cx, cy] = fixture.center ?? [0, 0];

  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0x8892a4, metalness: 0.5, roughness: 0.55,
    transparent: true, opacity: 0.55, depthWrite: false,
  });
  const jawMaterial = new THREE.MeshStandardMaterial({
    color: 0xff5566, metalness: 0.3, roughness: 0.6,
    transparent: true, opacity: 0.55, depthWrite: false,
  });

  // the body sits behind the face, i.e. at smaller Z — away from the tailstock
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(bodyD / 2, bodyD / 2, bodyL, 48), bodyMaterial);
  body.geometry.rotateX(Math.PI / 2);
  body.position.set(cx, cy, faceZ - bodyL / 2);
  group.add(body);

  const count = Math.max(2, Math.min(8, Math.round(fixture.jaws ?? 3)));
  if (jawL > 0) {
    // a jaw reaches from the grip diameter out to the body, or in to the axis
    const reach = inside ? Math.max(2, grip) : Math.max(2, bodyD / 2 - grip);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const jaw = new THREE.Mesh(new THREE.BoxGeometry(reach, jawW, jawL), jawMaterial);
      const mid = inside ? grip / 2 : grip + reach / 2;
      jaw.position.set(cx + mid * Math.cos(angle), cy + mid * Math.sin(angle),
        faceZ + jawL / 2);
      jaw.rotation.z = angle;
      group.add(jaw);
    }
  }

  // the plane the tool must not pass: the front of the jaws
  const limit = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.1, grip), bodyD / 2, 48),
    new THREE.MeshBasicMaterial({
      color: 0xff5566, transparent: true, opacity: 0.18,
      side: THREE.DoubleSide, depthWrite: false,
    }),
  );
  limit.position.set(cx, cy, faceZ + jawL);
  group.add(limit);

  for (const node of group.children) node.renderOrder = 3;
  return group;
}

/**
 * A grid square in a number a person would choose: 1, 2, 5, 10, 20, 50, …
 *
 * A grid whose squares are 13.7mm across is a texture. One whose squares are
 * 10mm is a ruler, and counting three of them to judge a clearance is the thing
 * a grid is actually for.
 */
function niceStep(rough) {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(0.001, rough)));
  const scaled = rough / magnitude;
  const step = scaled <= 1.5 ? 1 : scaled <= 3.5 ? 2 : scaled <= 7.5 ? 5 : 10;
  return step * magnitude;
}
