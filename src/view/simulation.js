// Rendering for the removal simulation: the cut stock surface and the cutter.
//
// The stock is one grid mesh whose vertex heights come straight from the
// playback surface. Scrubbing only touches the cells that changed, so seeking
// updates a handful of vertices rather than rebuilding geometry.
//
// Vertex colours separate raw stock from machined surface, which is the whole
// point of watching it: you can see at a glance what has been reached and what
// is still full-depth.

import * as THREE from 'three';
import {
  toolSections, radiusAt, fluteLengthOf, tipLengthOf,
} from '../engine/tool-geometry.js';
import { latheToolOutline, insertIcOf, isLatheTool } from '../engine/insert.js';
import { shadeWithCreases } from './crease-material.js';

const RAW = new THREE.Color(0xb08a5a);        // uncut billet
const MACHINED = new THREE.Color(0x9fb4c7);   // freshly exposed surface
const CONTACT = new THREE.Color(0xff4d2e);    // where metal is coming off now

/**
 * The rim of the stock: which cells are on it, which way each of them faces
 * out, and which pairs of them are joined.
 *
 * One walk answering all three, because "is this cell on the boundary" was
 * being decided twice by two copies of the same expression — and the two are
 * only ever used together, to build one skirt.
 *
 * `out` is the direction the side wall faces at each rim cell: the sum of the
 * steps to the neighbours that are not stock, normalised. On a straight side
 * that is a single axis; at a corner it is the diagonal, which is what makes
 * the corner of a billet read as a corner rather than as two walls meeting in
 * a seam.
 */
function stockRim(mask, width, height) {
  const inside = (i, j) => i >= 0 && j >= 0 && i < width && j < height && mask[j * width + i];
  const isBorder = (i, j) => inside(i, j) && (
    i === 0 || j === 0 || i === width - 1 || j === height - 1
    || !inside(i - 1, j) || !inside(i + 1, j) || !inside(i, j - 1) || !inside(i, j + 1));

  const cells = [];
  const out = [];
  const edges = [];
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      if (!isBorder(i, j)) continue;
      cells.push(j * width + i);
      let ox = 0;
      let oy = 0;
      if (!inside(i - 1, j)) ox -= 1;
      if (!inside(i + 1, j)) ox += 1;
      if (!inside(i, j - 1)) oy -= 1;
      if (!inside(i, j + 1)) oy += 1;
      const len = Math.hypot(ox, oy) || 1;
      out.push([ox / len, oy / len]);
      // The wall between two rim cells faces ±Y along an X step and ±X along a
      // Y step; `flip` says which, so the quad is wound facing out of the metal
      // rather than into it.
      if (isBorder(i + 1, j)) {
        edges.push([j * width + i, j * width + i + 1, !inside(i, j + 1) ? 0 : 1]);
      }
      if (isBorder(i, j + 1)) {
        edges.push([j * width + i, (j + 1) * width + i, !inside(i - 1, j) ? 0 : 1]);
      }
    }
  }
  return { cells, out, edges };
}

/** 0…n−1, for the passes that touch every cell rather than the changed ones. */
function* range(n) {
  for (let i = 0; i < n; i++) yield i;
}

/** How near the stock bottom counts as "the metal here is gone". */
const THROUGH_EPS = 1e-4;

/**
 * How many cells either side the wall bearing is measured over.
 *
 * One cell only knows four directions, which is the grid's own staircase said
 * again; three knows enough of them that a fillet in the corner of a pocket
 * shades as a curve. It is also how far a changed cell reaches, so it is the
 * price of every update — a cross rather than a block, and a handful of taps.
 */
const WALL_REACH = 3;

/**
 * How polished a machined surface is.
 *
 * It was 0.42, which is a tight enough specular lobe that each of the two key
 * lights put a distinct bright blob on any flat face — a faced floor came out
 * with a soft white glow across the middle of it, reading as a studio lamp on
 * wet plastic rather than as a flat surface. A cut face is not polished: it is
 * covered in tool marks, which is a broad lobe. At 0.55 the highlight spreads
 * out over the whole face and stops being a feature of the picture, and a
 * curved surface still has enough of one to read as curved.
 */
const SURFACE_ROUGHNESS = 0.55;

/**
 * Where quad `q` of the grid is, and whether it should be drawn.
 *
 * Every quad keeps a fixed six-index slot whether it is drawn or not, so a cell
 * being opened or closed during playback is six writes at a known offset rather
 * than a rebuilt index buffer. A quad that is not drawn is *degenerated* — all
 * six indices point at the same vertex — which the GPU discards as zero-area.
 *
 * `up` is which way the quad faces. The top of the billet faces the sky and the
 * bottom cap faces the floor, and getting that wrong is not cosmetic here: a
 * renderer flips the shading normal on a back face, so a surface whose winding
 * says "down" while its normal says "up" is lit as though it were a ceiling.
 * That is exactly what a machined floor looked like — black — because
 * `updateGridNormals` computes the exact height-grid normal, which points *up*,
 * onto a grid that was wound facing down.
 */
function writeQuad(index, q, mask, width, hole, up) {
  const i = q % (width - 1);
  const j = (q - i) / (width - 1);
  const a = j * width + i;
  const b = a + 1;
  const c = a + width;
  const d = c + 1;
  const o = q * 6;
  if (hole || !mask[a] || !mask[b] || !mask[c] || !mask[d]) {
    index.fill(a, o, o + 6);
    return;
  }
  if (up) {
    index[o] = a; index[o + 1] = b; index[o + 2] = c;
    index[o + 3] = b; index[o + 4] = d; index[o + 5] = c;
  } else {
    index[o] = a; index[o + 1] = c; index[o + 2] = b;
    index[o + 3] = b; index[o + 4] = c; index[o + 5] = d;
  }
}

/**
 * The bottom of the billet — as the *same grid* the top is, not as one plane.
 *
 * A plane is what it used to be, and it is why a through cut looked like it had
 * not gone through. The slot really was machined to the stock bottom, and then
 * a solid full-footprint cap was drawn across the whole billet at exactly that
 * height: looking down the slot you saw raw material at the bottom of it. No
 * setting could fix that, because the cap was not made of anything the
 * simulation cut — which is why dropping Bottom Z further changed nothing.
 *
 * Sharing the top's grid and its mask means the cap has the same cells the
 * stock does, so a cell whose metal is gone can be taken out of both and the
 * hole goes right through. It also removes the round/rectangular special case:
 * the mask is already a disc on round stock.
 */
function buildBase(sim) {
  const { origin, cellSize, width, height, mask, stockBottom } = sim;
  const count = width * height;
  const positions = new Float32Array(count * 3);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      positions[k * 3] = origin[0] + i * cellSize;
      positions[k * 3 + 1] = origin[1] + j * cellSize;
      positions[k * 3 + 2] = stockBottom;
    }
  }
  const quads = (width - 1) * (height - 1);
  const index = new Uint32Array(quads * 6);
  for (let q = 0; q < quads; q++) writeQuad(index, q, mask, width, false, false);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, shadeWithCreases(new THREE.MeshStandardMaterial({
    color: RAW, metalness: 0.15, roughness: 0.8, side: THREE.DoubleSide,
  })));
}

// What the three parts of a cutter are made of. Carbide at the business end,
// ground steel above it, a dark holder — the difference is what makes it
// readable at a glance which part of the assembly is level with the work.
//
// Metalness is held well below 1 on purpose. A physically-correct metal has no
// diffuse response at all: everything you see on it is a reflection, and what
// this scene has to reflect is a dim grey room (view/lighting.js). At 0.95 the
// cutter came out **black** — correctly, and uselessly, because the one object
// whose silhouette you are watching against the work was the darkest thing on
// the screen. Keeping some diffuse in it is the difference between a tool and
// a hole in the picture.
const TOOL_LOOK = {
  cutting: { color: 0xe4e8ef, metalness: 0.5, roughness: 0.26 },
  shank: { color: 0xaeb6c4, metalness: 0.45, roughness: 0.4 },
  holder: { color: 0x646d7c, metalness: 0.35, roughness: 0.55 },
  flute: { color: 0x2f333b, metalness: 0.45, roughness: 0.5 },
};

function toolMaterial(kind, ghost) {
  const look = TOOL_LOOK[kind] ?? TOOL_LOOK.cutting;
  return shadeWithCreases(new THREE.MeshStandardMaterial({
    ...look,
    transparent: !!ghost,
    opacity: ghost ? 0.45 : 1,
    depthWrite: !ghost,
    side: THREE.DoubleSide,
  }));
}

/**
 * The flutes, as helical grooves lying in the surface of the cutting end.
 *
 * Each is a thin dark tube whose centreline runs along the cutter's own radius
 * at that height, so half of it is buried in the body and what shows is the
 * gash. Following `radiusAt` rather than a fixed radius is what makes them wrap
 * a ball nose's sphere and run down into a drill's point instead of hanging in
 * the air beside it.
 *
 * A 30° helix is the ordinary one, and the direction is right-hand, which is
 * what a right-hand cutter turning clockwise seen from above has.
 */
function fluteGrooves(tool) {
  const type = tool?.type ?? 'flat';
  if (type === 'face' || isLatheTool(type)) return [];   // inserts, not flutes
  const diameter = Math.max(0.2, tool?.diameter ?? 6);
  const top = fluteLengthOf(tool);
  const tip = tipLengthOf(tool);
  if (!(top > 0)) return [];
  const count = Math.min(6, Math.max(2, Math.round(tool?.flutes ?? 2)));
  const lead = (Math.PI * diameter) / Math.tan(Math.PI / 6);   // 30° helix
  const grooveR = Math.max(0.02, diameter * 0.055);
  const material = toolMaterial('flute', false);
  const steps = 48;

  const meshes = [];
  for (let f = 0; f < count; f++) {
    const phase = (f / count) * Math.PI * 2;
    const points = [];
    for (let i = 0; i <= steps; i++) {
      // start just above the very point, where there is no radius to sit on
      const z = tip * 0.15 + (top - tip * 0.15) * (i / steps);
      const r = Math.max(grooveR * 0.5, radiusAt(tool, z));
      const a = phase + (z / lead) * Math.PI * 2;
      points.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), z));
    }
    const curve = new THREE.CatmullRomCurve3(points);
    meshes.push(new THREE.Mesh(
      new THREE.TubeGeometry(curve, steps, grooveR, 10, false), material));
  }
  return meshes;
}

/**
 * The inserts round the face of a face mill.
 *
 * A face mill has no flutes, so `fluteGrooves` leaves it alone and it came out
 * as a plain grey cylinder — indistinguishable from a shank, with nothing to
 * say which end of it cuts or how big a bite it takes. What a face mill has is
 * a ring of carbide tips clamped into the rim of its body, standing a hair
 * proud of it at the bottom and at the periphery, and that is exactly the pair
 * of surfaces the simulation is removing metal with.
 *
 * Drawn in the cutting look against a body drawn in the shank one, so the
 * carbide is the bright part and the steel behind it is not — the same
 * separation the lathe insert and its holder already have.
 */
function faceInserts(tool) {
  if ((tool?.type ?? 'flat') !== 'face') return [];
  const radius = Math.max(0.5, (tool.diameter ?? 25) / 2);
  const count = Math.min(12, Math.max(3, Math.round(tool.flutes ?? 4)));
  const size = Math.min(radius * 0.55, Math.max(1.5, radius * 0.34));
  const thickness = size * 0.55;
  const proud = size * 0.05;   // the tip does the cutting, not the body
  const material = toolMaterial('cutting', false);
  const meshes = [];
  for (let n = 0; n < count; n++) {
    const angle = (n / count) * Math.PI * 2;
    // radial × tangential × axial, then swung round to sit on the rim
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(size, thickness, size * 0.8), material);
    box.position.set(
      (radius + proud - size / 2) * Math.cos(angle),
      (radius + proud - size / 2) * Math.sin(angle),
      size * 0.4 - proud);
    box.rotation.z = angle;
    meshes.push(box);
  }
  return meshes;
}

/**
 * The cut surface as a field of soft round splats rather than a triangle mesh.
 *
 * This is the answer to "the stock is pixelated and rough, and turning the
 * detail up just makes it slow". Roughness on a height grid is the grid itself:
 * a wall or a curve lands between two samples and is drawn one cell thick, so a
 * dome terraces and a slope staircases. More cells cure it and cost time — but
 * the *drawing* can cure it for free, because a splat is round and overlaps its
 * neighbours. A ring of square facets becomes a wash of overlapping discs, and
 * the staircase reads as the curve it stands for.
 *
 * It draws the very same buffers the mesh does — the shared position, colour and
 * normal attributes the playback path already writes — so a splat surface costs
 * nothing per frame that the mesh did not, and scrubbing updates it by the same
 * writes. Only the *representation* changes; the simulation does not.
 *
 * Two looks come out of one shader: `splat` is a tight disc a little larger than
 * a cell, which reads as a point cloud and shows where the samples are; `smooth`
 * is a broad soft disc that swallows its neighbours whole, which reconstructs a
 * continuous surface. Both are lit in world space against the same bright-room-
 * over-two-key-lights the scene has (view/lighting.js), approximated rather than
 * shared because a point cannot carry the standard material's fragment.
 */
const SPLAT_VERTEX = `
  attribute vec3 color;
  attribute vec2 aWall;        // which way, and how steeply, the surface falls away here
  varying vec3 vColor;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  uniform float uRadius;       // splat radius in world units
  uniform float uViewportH;    // drawing-buffer height in pixels
  uniform float uPerspective;  // 1 for a perspective camera, 0 for orthographic
  uniform float uMinZ;         // hide any vertex at or below this height (holes, skirt feet)
  uniform float uMaxSize;      // clamp, so a splat seen up close cannot fill the screen
  void main() {
    vColor = color;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    if (position.z <= uMinZ) { gl_PointSize = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    // projectionMatrix[1][1] is 1/tan(fov/2) on a perspective camera and
    // 2/(top-bottom) on an orthographic one; the pixel size of a world radius is
    // that, times half the viewport, divided by the view depth when there is
    // perspective and not when there is not.
    float denom = mix(1.0, -mv.z, uPerspective);
    float size = uRadius * projectionMatrix[1][1] * uViewportH * 0.5 / max(denom, 1e-3);
    // A fat disc is right in the middle of a floor or a gentle curve — that is
    // what swallows the facets — but at the edge of a cut it overhangs the drop
    // and hangs out over whatever is below (the pocket the tool is working in, or
    // the tool itself). aWall is zero on floors and gentle slopes and climbs
    // toward 1 at a wall, so shrink the splat there: no overhang means the cut
    // stays a clean opening the tool shows through, and the mesh (crisp at an
    // edge anyway) draws it. Squared so only real edges shrink, curves keep size.
    float edge = clamp(length(aWall), 0.0, 1.0);
    size *= 1.0 - edge * edge;
    gl_PointSize = clamp(size, 0.0, uMaxSize);
    // The splats sit exactly on the mesh they overlay, so nudge them a hair
    // toward the camera — otherwise they z-fight the solid top and flicker.
    gl_Position.z -= 0.0002 * gl_Position.w;
  }
`;

const SPLAT_FRAGMENT = `
  precision mediump float;
  varying vec3 vColor;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  uniform float uHardness;   // how quickly the disc fades to its rim
  void main() {
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(d, d);
    if (r2 > 1.0) discard;             // round, not square
    vec3 N = normalize(vWorldNormal);
    if (!gl_FrontFacing) N = -N;
    // The scene is a bright grey room with two overhead keys and a headlight
    // (view/lighting.js). Approximated here: a strong ambient for the room, one
    // key from above and toward the viewer, and a fill from the camera so a wall
    // is never black.
    vec3 key = normalize(vec3(0.35, -0.35, 1.0));
    vec3 toEye = normalize(cameraPosition - vWorldPos);
    float lambert = max(dot(N, key), 0.0);
    float head = max(dot(N, toEye), 0.0);
    // tuned to sit near the standard material's brightness: a generous room
    // ambient, a key from above, and a headlight fill so no face is black
    float shade = 0.72 + 0.5 * lambert + 0.25 * head;
    // a soft specular sharpens the highlight the metal would carry
    vec3 h = normalize(key + toEye);
    float spec = pow(max(dot(N, h), 0.0), 24.0) * 0.28;
    vec3 color = vColor * shade + spec;
    // a gentle darkening toward the rim gives each splat a little roundness of
    // its own, so an oblique surface does not read as flat tiles
    color *= 1.0 - uHardness * r2 * 0.22;
    gl_FragColor = vec4(color, 1.0);
  }
`;

/** How much larger than a cell each style draws its splats, and how soft. */
const SPLAT_LOOKS = {
  splat: { scale: 1.35, hardness: 0.7 },
  smooth: { scale: 2.4, hardness: 1.0 },
};

// Render order. The surface mesh writes the real depth (0); the splats recolour
// it (1) without writing depth of their own; the cutter draws just after them (2)
// so it wins a colour tie on a coincident floor, while still being depth-tested
// against the mesh so it is buried where it is inside solid stock. It must stay
// *below* the toolpath overlay (3–4), which draws with the depth test off — the
// cutter used to sit above that overlay, and because the overlay writes depth,
// the current cut-move bar then ate the tool's base. See applySurfaceStyle and
// the cutter builders.
const SPLAT_RENDER_ORDER = 1;
const CUTTER_RENDER_ORDER = 2;

/** A lid on the top of the assembly, so it is a tool and not a length of pipe. */
function capOfAssembly(tool, withHolder) {
  const sections = toolSections(tool);
  const shown = withHolder ? sections : sections.filter((s) => s.kind === 'cutting');
  const last = shown[shown.length - 1]?.points;
  if (!last) return null;
  const [r, z] = last[last.length - 1];
  if (!(r > 0)) return null;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 64),
    toolMaterial(shown[shown.length - 1].kind, false));
  disc.position.z = z;
  return disc;
}

export class SimulationView {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.surface = null;
    // The splat overlay: a THREE.Points drawn from the surface's own buffers.
    // Which of it and the mesh is shown is `surfaceStyle`; both read the same
    // geometry, so a scrub updates whichever is on the screen for free.
    this.splat = null;
    this.surfaceStyle = 'solid';
    // How wide a cell is in world units, for sizing the splats — the mill's cell
    // pitch or the bar's Z spacing, whichever this simulation is.
    this.splatPitch = 1;
    // Below this height a surface vertex is metal that is gone (a through hole)
    // or the foot of the side wall; the splat of it is hidden so a hole does not
    // read as floored. −∞ on the lathe, which has no such plane.
    this.splatFloor = -Infinity;
    this.base = null;
    this.cutter = null;
    this.cutterKey = null;   // what the drawn cutter is, so a seek can reuse it
    this.cutterState = null; // and where it is, so a setting can redraw it
    this.sim = null;
    this.skirtOf = null;   // top cell -> skirt vertex, -1 when not on the edge
    // Smooth shading by default. Facet normals make every grid cell a visible
    // triangle, which reads as a rough casting rather than as a machined
    // surface — the steps between passes are real and survive smoothing, and
    // the quarter-millimetre facets of the grid are not and do not.
    this.smooth = true;
    this.showHolder = true;
    // Draw the tool solid. See setCutter for why a see-through tool reads as a
    // rendering fault rather than as a tool.
    this.ghostTool = false;
    this.showCutMarker = true;
    this.cutMarker = null;
  }

  /**
   * Shade the cut stock from averaged normals rather than from facet normals.
   *
   * This is the single biggest thing between "the simulated model looks very
   * rough" and a surface. A height grid is a lattice of quads, and flat-shading
   * it draws every one of them: a face that is dead flat in the data comes out
   * as a field of triangles catching the light at slightly different angles.
   * Averaging the normals leaves the geometry exactly where it is — a step
   * between two passes is a step in the *positions* and stays visible — and
   * stops the tessellation being part of the picture.
   */
  setSmooth(on) {
    this.smooth = on !== false;
    if (this.surface) {
      this.surface.material.flatShading = !this.smooth;
      this.surface.material.needsUpdate = true;
      this.refreshNormals();
    }
  }

  /**
   * How the cut surface is drawn: as the triangle mesh, or with a splat overlay.
   *
   * `solid` is the mesh alone. `splat` and `smooth` keep the mesh — so the
   * billet stays a solid with proper sides and a floor — and lay a field of
   * round splats over the *top*, which is where the grid shows as terracing and
   * staircasing. The mesh underneath fills between them and holds the silhouette;
   * the splats hide the facets. See buildSplatMaterial and SPLAT_LOOKS.
   *
   * Nothing about the simulation changes — same cells, same event log, same
   * speed. This is the answer to "raising the detail to smooth it just makes it
   * slow": the smoothing is in the drawing, not in the grid.
   */
  setSurfaceStyle(style) {
    this.surfaceStyle = SPLAT_LOOKS[style] ? style : 'solid';
    this.applySurfaceStyle();
  }

  /** A ShaderMaterial that draws one surface vertex as a lit, round splat. */
  buildSplatMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uRadius: { value: this.splatPitch },
        uViewportH: { value: 800 },
        uPerspective: { value: 1 },
        uMinZ: { value: this.splatFloor },
        uMaxSize: { value: 128 },
        uHardness: { value: 0.7 },
      },
      vertexShader: SPLAT_VERTEX,
      fragmentShader: SPLAT_FRAGMENT,
      // Two things have to be true at once, and they need both switches below.
      //
      // depthWrite off: a splat is a re-skin of a surface the mesh already drew,
      // so it must not write depth of its own. A splat sits a hair proud of the
      // mesh (the z bias in the shader, to beat z-fighting) and grows on screen
      // as you zoom in — so if it wrote depth it would write *in front of* the
      // cutter wherever the two are near the same surface, and eat the tool, more
      // the closer you zoom. Writing no depth, the cutter is tested only against
      // the real mesh: it shows wherever it is genuinely out of the metal, at any
      // zoom. (The mesh underneath still occludes both, so nothing leaks through
      // a solid.)
      //
      // edge-shrink in the vertex shader (aWall): without depth of its own a
      // splat that overhangs a cut edge would stipple over whatever is below and
      // veil the cut. Shrinking splats to nothing at a wall means they never
      // overhang, so there is nothing to veil with. Neither switch alone is
      // enough — depthWrite off veils, edge-shrink alone lets a zoomed-in splat
      // still bury the tool.
      depthWrite: false,
    });
  }

  /**
   * Build or drop the splat overlay to match `surfaceStyle`, and size it.
   *
   * The overlay shares the surface's geometry, so it is one object with no
   * buffers of its own — the playback path that moves the mesh moves it too. It
   * lives in the same node the surface does (the spinning work group on a lathe),
   * so it turns with the bar.
   */
  applySurfaceStyle() {
    if (!this.surface) return;
    const useSplat = this.surfaceStyle !== 'solid';
    if (useSplat && !this.splat) {
      this.splat = new THREE.Points(this.surface.geometry, this.buildSplatMaterial());
      this.splat.frustumCulled = false;
      // over the mesh (which drew the real depth), under the cutter, so the tool
      // in a cut is never painted over by a splat overhanging the cut's edge
      this.splat.renderOrder = SPLAT_RENDER_ORDER;
      (this.surface.parent ?? this.group).add(this.splat);
    }
    if (this.splat) {
      const look = SPLAT_LOOKS[this.surfaceStyle] ?? SPLAT_LOOKS.splat;
      const u = this.splat.material.uniforms;
      u.uRadius.value = this.splatPitch * look.scale;
      u.uHardness.value = look.hardness;
      u.uMinZ.value = this.splatFloor;
      this.splat.visible = useSplat;
    }
    // The mesh stays on under the splats: it is the solid the splats sit on, and
    // without it a splat billet would be see-through at the sides and hollow.
  }

  /**
   * Keep the splat point size right as the camera and canvas change.
   *
   * A splat is sized in pixels from a world radius, which depends on the view
   * depth under perspective and on nothing under an orthographic camera, and on
   * how tall the drawing buffer is. The viewport calls this before each render so
   * a splat is the same size on the metal however the camera is set.
   */
  syncSplat(camera, viewportHeight) {
    if (!this.splat || !this.splat.visible) return;
    const u = this.splat.material.uniforms;
    u.uViewportH.value = viewportHeight || u.uViewportH.value;
    u.uPerspective.value = camera?.isPerspectiveCamera ? 1 : 0;
  }

  /** Draw the shank and holder above the flutes, or just the cutting end. */
  setShowHolder(on) {
    this.showHolder = on !== false;
    this.redrawCutter();
  }

  /** See through the shank and holder rather than having them hide the cut. */
  setGhostTool(on) {
    this.ghostTool = !!on;
    this.redrawCutter();
  }

  /**
   * Draw the cutter again with whatever it is now supposed to look like.
   *
   * The cutter is only ever built while seeking, so a switch that changes what
   * it looks like changed nothing until the playhead moved — turning the holder
   * off on a paused simulation left the holder on screen, which reads as a
   * setting that does not work. What the tool is drawn *at* is remembered here
   * for exactly that reason.
   */
  redrawCutter() {
    if (!this.cutterState) return;
    this.cutterKey = null;      // whatever is drawn is not what is wanted
    this.setCutter(this.cutterState);
  }

  /** Show the contact marker, or take it off the scene entirely. */
  setShowCutMarker(on) {
    this.showCutMarker = on !== false;
    if (!this.showCutMarker && this.cutMarker) this.cutMarker.visible = false;
  }

  /**
   * Put a dot on the metal that is coming off right now.
   *
   * The cutter is drawn by revolving its own silhouette and the stock is a
   * height grid swept by a kernel built from that same silhouette — two
   * descriptions of one shape, and the classic way for them to drift apart
   * (see the clearanceProfile duplicate that made a chamfer mill simulate as a
   * flat cutter of its full diameter). Nothing in the picture showed the
   * disagreement: the tool looked right and the stock looked right, and the
   * corner of one simply was not where the other was cutting.
   *
   * So the dot is placed from the *event log* rather than from the tool: it
   * sits on the cell the simulation actually lowered, at the height it lowered
   * it to. If it is not under the cutting corner of the tool, the two do not
   * agree — which is the thing that could not be seen before.
   *
   * Of the cells a step changed, the one nearest the tool is the one the dot
   * goes on. A single move can lower a whole swathe, and the near edge of that
   * swathe is where the cutting corner is.
   */
  setCutMarker(cutter, changed, playback) {
    // `changed` is a Set (see SimulationPlayback.seek), so it is `.size` that
    // says whether anything moved — `.length` is undefined on one, which reads
    // as "nothing changed" at every step and hides the marker for ever.
    const any = changed ? (changed.size ?? changed.length) : 0;
    if (!this.showCutMarker || !this.sim || !cutter || !any) {
      if (this.cutMarker) this.cutMarker.visible = false;
      return;
    }
    const point = this.sim.kind === 'turn'
      ? this.turnedContact(cutter, changed, playback)
      : this.milledContact(cutter, changed, playback);
    if (!point) {
      if (this.cutMarker) this.cutMarker.visible = false;
      return;
    }
    if (!this.cutMarker) {
      // Sized off the grid, not fixed: a dot big enough to see on an 80mm
      // billet covers the whole cut on a 6mm one. Emissive so it reads as a
      // marker rather than as a bead of metal the lighting can hide.
      const r = this.markerRadius();
      this.cutMarker = new THREE.Mesh(
        new THREE.SphereGeometry(r, 16, 12),
        new THREE.MeshStandardMaterial({
          color: CONTACT, emissive: CONTACT, emissiveIntensity: 0.9,
          roughness: 0.4, depthTest: false,
        }),
      );
      this.cutMarker.renderOrder = 10;   // never buried in the surface it marks
      this.group.add(this.cutMarker);
    }
    this.cutMarker.position.set(...point);
    this.cutMarker.visible = true;
  }

  markerRadius() {
    if (this.sim?.kind === 'turn') return Math.max(0.15, this.sim.dz * 2);
    return Math.max(0.15, this.sim.cellSize * 1.2);
  }

  /** The changed cell nearest the cutter, as a world point on the new surface. */
  milledContact(cutter, changed, playback) {
    const { width, origin, cellSize } = this.sim;
    const [tx, ty] = cutter.position;
    const topCount = width * this.sim.height;
    let best = null;
    let bestDistance = Infinity;
    for (const cell of changed) {
      if (cell >= topCount) continue;
      const i = cell % width;
      const j = (cell - i) / width;
      const x = origin[0] + i * cellSize;
      const y = origin[1] + j * cellSize;
      const d = (x - tx) * (x - tx) + (y - ty) * (y - ty);
      if (d < bestDistance) { bestDistance = d; best = [x, y, playback.current[cell]]; }
    }
    return best;
  }

  /**
   * The same on a bar, where a "cell" is a radius at one Z.
   *
   * The contact is on the operator's side of the work — X out of the screen —
   * because that is the plane the tool is drawn in and the only place the dot
   * could be compared with it. The bar is spinning, so every angle is the same
   * angle; there is no other information to lose by choosing one.
   */
  turnedContact(cutter, changed, playback) {
    const { count, zMin, dz } = this.sim;
    const tz = cutter.position[2];
    let best = null;
    let bestDistance = Infinity;
    for (const cell of changed) {
      const i = cell % count;
      const z = zMin + i * dz;
      const d = Math.abs(z - tz);
      if (d < bestDistance) { bestDistance = d; best = [playback.current[cell], 0, z]; }
    }
    return best;
  }

  /**
   * Recompute every shading normal on the stock, from scratch.
   *
   * `computeVertexNormals` walks every triangle in the mesh, and on a turned
   * bar that is two hundred thousand vertices — so calling it once per frame,
   * which is what playback used to do, cost more than everything else in the
   * simulation put together and is why the lathe ran at a few frames a second.
   * It is now used where it belongs: once, when the mesh is built or the
   * shading mode changes. Playback uses the incremental paths below, which
   * touch only the vertices that moved.
   *
   * On a milling grid it is not used at all: the surface *is* a height field
   * and has an exact normal everywhere, so averaging triangles would be a
   * slower way of getting a worse answer. The skirt's normals are written once
   * when it is built and never change — a vertical wall stays vertical.
   */
  refreshNormals() {
    if (!this.surface) return;
    if (this.sim?.kind === 'turn') {
      const { count } = this.sim;
      const rings = this.rings;
      const position = this.surface.geometry.attributes.position.array;
      // ring a = 0 is at angle 0, so its x *is* the radius there
      const radii = new Float32Array(count * 2);
      for (let i = 0; i < count * 2; i++) radii[i] = position[i * rings * 3];
      this.updateTurnedNormals(range(count * 2), radii);
      this.updateTurnedCaps(radii);
      return;
    }
    const { width, height } = this.sim;
    this.writeGridNormals(range(width * height));
  }

  /**
   * Keep the two end faces on the rings they are copied from.
   *
   * They are separate vertices only so that they can carry their own normal —
   * ±Z, square to the spindle — so their positions have to be pushed across
   * whenever the ring they belong to moves. Facing the end of a bar and boring
   * it both change the annulus, and one of the four rings is enough to make it
   * wrong on its own.
   */
  updateTurnedCaps(radii) {
    if (!this.capOf) return;
    const { count, zMin, dz } = this.sim;
    const rings = this.rings;
    const attrs = this.surface.geometry.attributes;
    const position = attrs.position.array;
    const normal = attrs.normal.array;
    const color = attrs.color.array;
    this.capOf.forEach((cell, n) => {
      const from = cell * rings;
      const to = (this.capBase + n) * rings;
      const z = zMin + (cell % count) * dz;
      const facing = n < 2 ? -1 : 1;    // the first two rings are the near end
      for (let a = 0; a < rings; a++) {
        const v = (to + a) * 3;
        position[v] = radii[cell] * this.ringCos[a];
        position[v + 1] = radii[cell] * this.ringSin[a];
        position[v + 2] = z;
        normal[v] = 0;
        normal[v + 1] = 0;
        normal[v + 2] = facing;
        const src = (from + a) * 3;
        color[v] = color[src];
        color[v + 1] = color[src + 1];
        color[v + 2] = color[src + 2];
      }
    });
    attrs.position.needsUpdate = true;
    attrs.normal.needsUpdate = true;
    attrs.color.needsUpdate = true;
  }

  /**
   * Shading normals for the cells a milling move just lowered.
   *
   * A height grid has an exact normal — (−∂h/∂x, −∂h/∂y, 1) — so there is
   * nothing to average and nothing to gain from walking the triangles. A cell
   * that moves changes its own normal and its four neighbours', because they
   * are the slopes it appears in, and nothing else in the mesh.
   */
  updateGridNormals(changed) {
    const { width, height } = this.sim;
    const topCount = width * height;
    const touched = new Set();
    for (const cell of changed) {
      if (cell >= topCount) continue;
      const i = cell % width;
      const j = (cell - i) / width;
      // The normal reaches one cell; the wall bearing reaches WALL_REACH, and
      // both are written by the same pass, so the neighbourhood is the wider
      // of the two. It is a cross rather than a block because the bearing is
      // measured along the two axes separately.
      for (let d = -WALL_REACH; d <= WALL_REACH; d++) {
        if (i + d >= 0 && i + d < width) touched.add(cell + d);
        if (j + d >= 0 && j + d < height) touched.add(cell + d * width);
      }
    }
    this.writeGridNormals(touched);
  }

  /**
   * The height-grid normal at each of `cells`, written into the mesh.
   *
   * The slope is taken across the *gentler* of the two neighbours in each
   * direction rather than across both. A central difference straddling the top
   * of a wall is not a slope at all — it is a cliff — and averaging it in gave
   * the flat cell beside the wall the wall's own near-horizontal normal. Since
   * the wall wanders from grid column to grid column as it curves, so did that
   * dark band, and the perimeter of every machined feature came out as vertical
   * striping. This is the same rule geom/shading.js applies to a model: do not
   * blend two faces across an edge.
   */
  writeGridNormals(cells) {
    const { width, height, cellSize, mask } = this.sim;
    const normal = this.surface.geometry.attributes.normal;
    const wall = this.surface.geometry.attributes.aWall;
    const heights = this.surface.geometry.attributes.position.array;
    const zAt = (k) => heights[k * 3 + 2];
    // The bearing the wall runs on, measured over WALL_REACH cells each way so
    // that a staircase round a fillet reads as the curve it stands for rather
    // than as the grid lines it is made of. Weighted 1/d, which is a smoothed
    // derivative: near cells say where the wall is, far ones say which way it
    // is going. See view/crease-material.js for what is done with it.
    const bearing = (cell, i, j) => {
      let gx = 0;
      let gy = 0;
      const here = zAt(cell);
      for (let d = 1; d <= WALL_REACH; d++) {
        const w = 1 / d;
        if (i - d >= 0) gx -= w * (zAt(cell - d) - here);
        if (i + d < width) gx += w * (zAt(cell + d) - here);
        if (j - d >= 0) gy -= w * (zAt(cell - d * width) - here);
        if (j + d < height) gy += w * (zAt(cell + d * width) - here);
      }
      // outward is downhill, and a slope gentler than a cell per cell is a
      // floor rather than a wall
      const drop = Math.hypot(gx, gy);
      if (!(drop > cellSize)) return [0, 0];
      const strength = Math.min(1, drop / (WALL_REACH * cellSize));
      return [(-gx / drop) * strength, (-gy / drop) * strength];
    };
    // the gentler of two one-sided slopes, which on a plain slope is the slope
    // and at a cliff is whichever side the cell actually lies on
    const slope = (back, here, front, hasBack, hasFront) => {
      const a = hasBack ? (here - back) / cellSize : null;
      const b = hasFront ? (front - here) / cellSize : null;
      if (a === null) return b ?? 0;
      if (b === null) return a;
      return Math.abs(a) <= Math.abs(b) ? a : b;
    };
    for (const cell of cells) {
      if (mask[cell] === 0) continue;
      const i = cell % width;
      const j = (cell - i) / width;
      const row = j * width;
      const dx = slope(zAt(row + i - 1), zAt(cell), zAt(row + i + 1), i > 0, i < width - 1);
      const dy = slope(zAt(cell - width), zAt(cell), zAt(cell + width),
        j > 0, j < height - 1);
      const len = Math.hypot(dx, dy, 1);
      normal.array[cell * 3] = -dx / len;
      normal.array[cell * 3 + 1] = -dy / len;
      normal.array[cell * 3 + 2] = 1 / len;
      const [wx, wy] = bearing(cell, i, j);
      wall.array[cell * 2] = wx;
      wall.array[cell * 2 + 1] = wy;
    }
    normal.needsUpdate = true;
    wall.needsUpdate = true;
  }

  /**
   * The same, for the bar: a surface of revolution has an exact normal too.
   *
   * At radius r(z) it is (cos θ, sin θ, −r′) normalised, pointing out of the
   * metal — so the bore's is the negative of it, because the bore's metal is on
   * the other side. Only the rings that moved and their two neighbours change,
   * since r′ is what a neighbour contributes.
   */
  updateTurnedNormals(changed, radii) {
    const { count, dz } = this.sim;
    const rings = this.rings;
    const normal = this.surface.geometry.attributes.normal;
    const touched = new Set();
    for (const cell of changed) {
      const base = cell < count ? 0 : count;
      const i = cell - base;
      touched.add(cell);
      if (i > 0) touched.add(cell - 1);
      if (i < count - 1) touched.add(cell + 1);
    }
    for (const cell of touched) {
      const base = cell < count ? 0 : count;
      const i = cell - base;
      const lo = Math.max(0, i - 1);
      const hi = Math.min(count - 1, i + 1);
      const slope = (radii[base + hi] - radii[base + lo]) / Math.max(1e-9, (hi - lo) * dz);
      const scale = (base === 0 ? 1 : -1) / Math.hypot(1, slope);
      for (let a = 0; a < rings; a++) {
        const v = (cell * rings + a) * 3;
        normal.array[v] = this.ringCos[a] * scale;
        normal.array[v + 1] = this.ringSin[a] * scale;
        normal.array[v + 2] = -slope * scale;
      }
    }
    normal.needsUpdate = true;
  }

  /**
   * Build the stock mesh for a simulation record.
   *
   * The top is a height grid, but a grid on its own reads as a flat sheet
   * hanging in space. Real stock is a solid, so the boundary cells are skirted
   * down to the stock bottom and capped — giving a billet whose sides drop away
   * properly as the top surface is cut into.
   */
  setSimulation(sim) {
    this.clear();
    if (!sim) return;
    this.sim = sim;
    if (sim.kind === 'turn') return this.setTurnedSimulation(sim);

    const { width, height, cellSize, origin, mask, initial, stockBottom } = sim;
    const topCount = width * height;
    const rim = stockRim(mask, width, height);

    // Vertex layout: [0, topCount) is the height grid, then *two* vertices per
    // rim cell — the top of the side wall and its foot at the stock bottom.
    //
    // Two, and not one shared with the grid, because the top of a side wall is
    // a hard edge: the grid vertex there has to carry the floor's normal and
    // the wall vertex has to carry the wall's, and one vertex cannot hold both.
    // Sharing it made the outside of the billet shade as a continuation of the
    // top face, which is what turned a square corner into a soft roll.
    const total = topCount + rim.cells.length * 2;
    const positions = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    // Which way the surface falls away here, and how steeply — read by the
    // shader to give a staircase wall the bearing of the curve it stands for
    // rather than the bearing of the grid line it happens to lie on. See
    // view/crease-material.js. Zero everywhere until something is cut, because
    // a flat billet has no walls.
    const walls = new Float32Array(total * 2);

    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const k = j * width + i;
        positions[k * 3] = origin[0] + i * cellSize;
        positions[k * 3 + 1] = origin[1] + j * cellSize;
        positions[k * 3 + 2] = initial[k];
        RAW.toArray(colors, k * 3);
      }
    }

    this.skirtOf = new Int32Array(topCount).fill(-1);
    rim.cells.forEach((cell, n) => {
      const top = topCount + n * 2;
      this.skirtOf[cell] = top;
      const [ox, oy] = rim.out[n];
      for (const [v, z] of [[top, initial[cell]], [top + 1, stockBottom]]) {
        positions[v * 3] = positions[cell * 3];
        positions[v * 3 + 1] = positions[cell * 3 + 1];
        positions[v * 3 + 2] = z;
        // A side wall is vertical and faces straight out of the billet — it is
        // not a slope and has no slope to average, so its normal is written
        // rather than derived.
        normals[v * 3] = ox;
        normals[v * 3 + 1] = oy;
        RAW.toArray(colors, v * 3);
      }
    });

    // Top surface first, one fixed six-index slot per cell whether it is drawn
    // or not, so opening a hole during playback is a write at a known offset.
    // The skirt follows, and nothing after `quadCount * 6` is ever touched again.
    this.quadCount = (width - 1) * (height - 1);
    const skirt = [];
    for (const [p, q, flip] of rim.edges) {
      const pt = this.skirtOf[p];
      const qt = this.skirtOf[q];
      if (pt < 0 || qt < 0) continue;
      if (flip) skirt.push(pt, qt + 1, qt, pt, pt + 1, qt + 1);
      else skirt.push(pt, qt, qt + 1, pt, qt + 1, pt + 1);
    }
    const indices = new Uint32Array(this.quadCount * 6 + skirt.length);
    for (let q = 0; q < this.quadCount; q++) writeQuad(indices, q, mask, width, false, true);
    indices.set(skirt, this.quadCount * 6);
    // no metal has gone yet, so nothing is a hole
    this.through = new Uint8Array(topCount);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('aWall', new THREE.BufferAttribute(walls, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    // A machined surface, not a casting. Exact height-grid normals leave every
    // position where the simulation put it — the step between two passes is a
    // step in the geometry and survives — while the grid's own facets stop
    // being part of the picture. See setSmooth.
    this.surface = new THREE.Mesh(geometry, shadeWithCreases(new THREE.MeshStandardMaterial({
      vertexColors: true, metalness: 0.35, roughness: SURFACE_ROUGHNESS, side: THREE.DoubleSide,
      flatShading: !this.smooth,
    }), undefined, true));
    this.refreshNormals();
    this.group.add(this.surface);

    // sizing and the hole/skirt cutoff for the splat overlay: a cell is one grid
    // pitch wide, and anything at the stock bottom is metal that is gone
    this.splatPitch = cellSize;
    this.splatFloor = stockBottom + THROUGH_EPS;
    this.applySurfaceStyle();

    // a flat base so the billet is closed when seen from below
    this.base = buildBase(sim);
    if (this.base) this.group.add(this.base);
  }

  /**
   * The bar, as a surface of revolution.
   *
   * A turned part is a radius for every position along the spindle axis, so the
   * mesh is that profile swept round: one ring of vertices per Z sample. Cutting
   * pulls a ring inward, which is the whole animation — and it is the same
   * event log and the same playback cursor the milling simulation uses, because
   * the two are the same thing in different numbers of dimensions.
   */
  setTurnedSimulation(sim) {
    const { count, zMin, dz, initial } = sim;
    const RINGS = 64;
    // Two surfaces of revolution, packed into one mesh: the outside of the bar
    // in the first half of the vertex buffer and the bore in the second, laid
    // out to match the simulation's own two halves. Cell i is vertex ring i and
    // cell count+i is ring count+i, so the update path is one index add.
    //
    // Then four more rings on the end of the buffer: a copy of each of the two
    // rings the front face is made from, and of the two the back face is made
    // from. The end of a bar is square to the axis and the side of it is
    // radial, and a vertex cannot hold both normals — sharing them shaded the
    // faced end with the *side's* radial normal, which points along the face
    // rather than out of it, and both ends of the part came out black.
    const total = count * 2;
    const capBase = total;
    const capCells = [0, count, count - 1, 2 * count - 1];
    const vertexRings = total + capCells.length;
    const positions = new Float32Array(vertexRings * RINGS * 3);
    const colors = new Float32Array(vertexRings * RINGS * 3);
    const normals = new Float32Array(vertexRings * RINGS * 3);
    this.capOf = capCells;
    this.capBase = capBase;
    this.ringCos = new Float32Array(RINGS);
    this.ringSin = new Float32Array(RINGS);
    // A smooth cylinder spinning about its own axis looks exactly like a
    // cylinder standing still — there is nothing on it to move. So the metal
    // carries a faint circumferential shading with one brighter witness line in
    // it, which is what turns "a bar" into "a bar that is turning".
    this.ringShade = new Float32Array(RINGS);
    for (let a = 0; a < RINGS; a++) {
      const angle = (a / RINGS) * Math.PI * 2;
      this.ringCos[a] = Math.cos(angle);
      this.ringSin[a] = Math.sin(angle);
      const stripe = Math.exp(-((a / RINGS) ** 2) * 260);
      this.ringShade[a] = 0.9 + 0.08 * Math.cos(angle * 3) + 0.35 * stripe;
    }
    this.rings = RINGS;

    for (let i = 0; i < total; i++) {
      for (let a = 0; a < RINGS; a++) {
        const v = (i * RINGS + a) * 3;
        positions[v] = initial[i] * this.ringCos[a];
        positions[v + 1] = initial[i] * this.ringSin[a];
        positions[v + 2] = zMin + (i % count) * dz;
        this.paint(colors, v, RAW, a);
      }
    }

    const indices = [];
    // The outside, wound so it faces out; the bore, wound so it faces in.
    //
    // These two were the wrong way round, and it is the whole of "the lathe
    // view is dark". Every triangle of the bar was wound facing *into* the
    // metal while `updateTurnedNormals` gave it a normal facing out, so from
    // outside you were looking at a back face — and a renderer flips the
    // shading normal on a back face, which lit the entire part from the far
    // side. A cylinder shaded that way has no gradient across it at all, which
    // is what made a turned bar read as a flat grey rectangle; and a shoulder
    // or a parted-off end, whose normal is square to the axis, came out black.
    for (const [base, outward] of [[0, true], [count, false]]) {
      for (let i = 0; i < count - 1; i++) {
        for (let a = 0; a < RINGS; a++) {
          const b = (a + 1) % RINGS;
          const p = (base + i) * RINGS + a;
          const q = (base + i) * RINGS + b;
          const r = (base + i + 1) * RINGS + a;
          const t = (base + i + 1) * RINGS + b;
          if (outward) indices.push(p, q, r, q, t, r);
          else indices.push(p, r, q, q, r, t);
        }
      }
    }
    // The end faces, as annuli between the bore ring and the outside ring, off
    // the copied rings. On solid bar the inner ring sits on the axis and the
    // annulus closes into a disc, which is the same triangles doing the same
    // job — so there is one case here rather than two.
    for (const [outerCap, innerCap, outward] of [[0, 1, false], [2, 3, true]]) {
      for (let a = 0; a < RINGS; a++) {
        const b = (a + 1) % RINGS;
        const o0 = (capBase + outerCap) * RINGS + a;
        const o1 = (capBase + outerCap) * RINGS + b;
        const i0 = (capBase + innerCap) * RINGS + a;
        const i1 = (capBase + innerCap) * RINGS + b;
        if (outward) indices.push(i0, o0, o1, i0, o1, i1);
        else indices.push(i0, o1, o0, i0, i1, o1);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(indices);

    this.surface = new THREE.Mesh(geometry, shadeWithCreases(new THREE.MeshStandardMaterial({
      vertexColors: true, metalness: 0.35, roughness: SURFACE_ROUGHNESS, side: THREE.DoubleSide,
      flatShading: !this.smooth,
    })));
    this.updateTurnedCaps(initial);
    this.updateTurnedNormals(range(total), initial);
    // The work is what spins, so it gets its own node to spin. The tool is a
    // sibling of it and stays where the program put it, which is the whole
    // relationship a lathe has.
    this.workGroup = new THREE.Group();
    this.workGroup.add(this.surface);
    this.group.add(this.workGroup);
    // the splat overlay spins with the bar because it lives in the work group,
    // and a Z sample is one `dz` apart along the axis
    this.splatPitch = dz;
    this.splatFloor = -Infinity;
    this.applySurfaceStyle();
    return undefined;
  }

  /** Vertex colour with the circumferential shading that makes rotation visible. */
  paint(array, offset, color, ring) {
    const k = this.ringShade ? this.ringShade[ring] : 1;
    array[offset] = Math.min(1, color.r * k);
    array[offset + 1] = Math.min(1, color.g * k);
    array[offset + 2] = Math.min(1, color.b * k);
  }

  /**
   * Point the work where the spindle is pointing.
   *
   * The angle is worked out once, from the program's own rpm — see
   * `spinAngle` in engine/simulate.js — and handed to the work and to the chuck
   * together, because they are bolted to each other. Being a function of the
   * playback clock rather than of wall time means scrubbing back and forth
   * lands the same way every time.
   */
  setSpin(angle) {
    if (this.workGroup) this.workGroup.rotation.z = angle;
  }

  /**
   * Push a playback state onto the mesh.
   * @param changed cells whose height moved, from SimulationPlayback.seek
   */
  update(playback, changed) {
    if (!this.surface) return;
    if (this.sim.kind === 'turn') return this.updateTurned(playback, changed);
    const position = this.surface.geometry.attributes.position;
    const color = this.surface.geometry.attributes.color;
    const { initial, stockBottom } = this.sim;

    for (const cell of changed) {
      // Never below the bottom of the billet: there is no stock down there to
      // draw. A cell taken to the bottom is not a very deep floor, it is a hole
      // — see updateHoles, which takes it out of the mesh entirely.
      const z = playback.current[cell];
      const top = z < stockBottom ? stockBottom : z;
      position.array[cell * 3 + 2] = top;
      const cut = z < initial[cell] - 1e-6;
      (cut ? MACHINED : RAW).toArray(color.array, cell * 3);
      // A cell on the rim carries the top of the billet's side wall with it, so
      // facing the stock lowers the outside of it too. Without that the wall
      // stayed at its original height and the cut looked like a lid taken off
      // a box whose sides had not moved.
      const skirt = this.skirtOf?.[cell] ?? -1;
      if (skirt >= 0) {
        position.array[skirt * 3 + 2] = top;
        // Both ends of the wall, not just the top one. A side wall is either
        // the sawn face of the billet or a face the cutter made; it is never
        // one shading into the other down its height, and colouring only the
        // top vertex drew exactly that — a thirty-millimetre gradient from
        // machined to raw on a wall nothing had touched below the first cell.
        (cut ? MACHINED : RAW).toArray(color.array, skirt * 3);
        (cut ? MACHINED : RAW).toArray(color.array, (skirt + 1) * 3);
      }
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
    this.updateHoles(playback, changed);
    // the normals are derived from the positions that just moved — and only
    // from those, which is what keeps playback interactive
    this.updateGridNormals(changed);
    return undefined;
  }

  /**
   * Open a hole wherever the metal has gone all the way to the bottom.
   *
   * A height grid has no way to say "there is nothing here" — the lowest it can
   * go is the bottom of the billet, which draws as a floor. So a through cut
   * came out as a slot with a floor in it at exactly the depth asked for, over a
   * cap that was a floor as well, and the operation looked as though it had not
   * cut through however far Bottom Z was dropped. It had; there was simply
   * nothing in the picture that could show it.
   *
   * A cell whose height reaches the stock bottom is metal that is gone, so its
   * quads come out of the top *and* out of the cap and the hole goes right
   * through. A quad is only dropped once all four of its corners are through:
   * that leaves the partly-cut ones standing as the wall of the hole, so the
   * opening is the size the cutter made rather than a cell wider all round.
   *
   * Reversible, because the index slot is fixed and the quad is rewritten from
   * the current state — scrubbing backwards fills the hole in again.
   */
  updateHoles(playback, changed) {
    const { width, height, mask, stockBottom } = this.sim;
    if (!this.through) return;
    const topCount = width * height;
    const quadsWide = width - 1;
    const dirty = new Set();

    for (const cell of changed) {
      if (cell >= topCount) continue;
      const gone = playback.current[cell] <= stockBottom + THROUGH_EPS ? 1 : 0;
      if (this.through[cell] === gone) continue;
      this.through[cell] = gone;
      const i = cell % width;
      const j = (cell - i) / width;
      // the four quads this cell is a corner of
      for (const [di, dj] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
        const qi = i + di;
        const qj = j + dj;
        if (qi < 0 || qj < 0 || qi >= quadsWide || qj >= height - 1) continue;
        dirty.add(qj * quadsWide + qi);
      }
    }
    if (dirty.size === 0) return;

    const topIndex = this.surface.geometry.index;
    const baseIndex = this.base?.geometry.index;
    for (const q of dirty) {
      const i = q % quadsWide;
      const j = (q - i) / quadsWide;
      const a = j * width + i;
      const hole = this.through[a] && this.through[a + 1]
        && this.through[a + width] && this.through[a + width + 1];
      writeQuad(topIndex.array, q, mask, width, hole, true);
      if (baseIndex) writeQuad(baseIndex.array, q, mask, width, hole, false);
    }
    topIndex.needsUpdate = true;
    if (baseIndex) baseIndex.needsUpdate = true;
  }

  /**
   * One Z sample changing pulls its whole ring in — or pushes it out, when the
   * sample is a bore.
   *
   * Because the work is spinning, every angle sees the same tool, so a change
   * at one point along the bar is a change all the way round it. That is the
   * property that makes a turning simulation a line rather than a surface, and
   * it is also why the ring moves as one.
   */
  updateTurned(playback, changed) {
    const position = this.surface.geometry.attributes.position;
    const color = this.surface.geometry.attributes.color;
    const { initial, count } = this.sim;
    const rings = this.rings;
    for (const cell of changed) {
      const r = playback.current[cell];
      // the outside is cut when it shrinks; a bore is cut when it grows
      const cut = cell < count
        ? r < initial[cell] - 1e-6
        : r > initial[cell] + 1e-6;
      for (let a = 0; a < rings; a++) {
        const v = (cell * rings + a) * 3;
        position.array[v] = r * this.ringCos[a];
        position.array[v + 1] = r * this.ringSin[a];
        this.paint(color.array, v, cut ? MACHINED : RAW, a);
      }
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
    this.updateTurnedNormals(changed, playback.current);
    // the ends are copies of four of those rings and have to follow them
    if (this.capOf?.some((cell) => changed.has?.(cell) ?? false)) {
      this.updateTurnedCaps(playback.current);
    }
    return undefined;
  }

  /**
   * Draw the cutter at the playhead. `null` hides it.
   *
   * The real tool, revolved from the same silhouette the icons are drawn from
   * (engine/tool-geometry.js) — flutes, shank and holder, each its own colour.
   * It used to be a plain cylinder of the flute length, which made every cutter
   * in the rack look identical while cutting and, worse, drew nothing at all
   * above the flutes: a 40mm holder coming down into a 30mm pocket was a crash
   * the simulation was in no position to show.
   */
  setCutter(state) {
    // Every scrub tick asks for the cutter, and the cutter almost never
    // changes: one program uses a handful of tools and a seek moves the one it
    // is holding. Rebuilding a revolved body, its flutes and its cap sixty
    // times a second to move it a millimetre is most of what a scrub used to
    // cost. So the assembly is kept until the *tool* changes, and a seek is one
    // assignment to `position`.
    this.cutterState = state;
    const key = state?.tool
      ? `${this.sim?.kind}|${this.showHolder}|${this.ghostTool}|${JSON.stringify(state.tool)}`
      : null;
    if (this.cutter && key && key === this.cutterKey) {
      const [x, y, z] = state.position;
      // a lathe tool works in the plane the bar is drawn in; it has no Y
      this.cutter.position.set(x, this.sim?.kind === 'turn' ? 0 : y, z);
      this.cutter.visible = true;
      return undefined;
    }
    if (this.cutter) {
      this.group.remove(this.cutter);
      this.cutter.traverse((node) => {
        node.geometry?.dispose();
        node.material?.dispose();
      });
      this.cutter = null;
      this.cutterKey = null;
    }
    if (!state) return undefined;
    this.cutterKey = key;

    const { position, tool } = state;
    // A lathe tool does not spin, so revolving its silhouette would be a lie —
    // and the wrong lie, because what you need to see is the insert sitting in
    // the ZX plane against a bar that *is* spinning.
    if (this.sim?.kind === 'turn') return this.setTurningTool(state);
    const group = new THREE.Group();
    for (const { kind, points } of toolSections(tool)) {
      // The shank and the holder are what turn "the cutter reaches" into "the
      // cutter reaches and the holder does not". Hiding them is a choice, not
      // the default — see app/settings.js.
      if (!this.showHolder && kind !== 'cutting') continue;
      const profile = points.map(([r, z]) => new THREE.Vector2(Math.max(r, 1e-4), z));
      // 64 rather than 32 segments: this is one object on the screen and the
      // one whose silhouette is being compared with a wall, and at 32 a ⌀12
      // cutter is visibly a dodecagon.
      const geometry = new THREE.LatheGeometry(profile, 64);
      geometry.rotateX(Math.PI / 2);          // three's lathe is Y-up, the scene is Z-up
      // Solid, unless asked otherwise. Everything used to be drawn
      // semi-transparent so the holder would not hide the cut — but a tool you
      // can see through does not read as a tool: it reads as a rendering fault,
      // the part shows through the flutes, and there is no longer any way to
      // tell whether the holder is in front of the work or inside it, which is
      // the one thing the holder is drawn for. See `seeThroughTool` in
      // app/settings.js for the old behaviour, kept as a choice.
      const ghost = this.ghostTool && kind !== 'cutting';
      // A face mill's body is steel and its cutting edges are the inserts
      // bolted round the rim of it, so the body is drawn as what it is and the
      // carbide is left to stand out against it. See faceInserts.
      const look = kind === 'cutting' && (tool?.type ?? '') === 'face' ? 'holder' : kind;
      group.add(new THREE.Mesh(geometry, toolMaterial(look, ghost)));
    }
    // A revolved silhouette is a smooth body of revolution, and an end mill is
    // not one: what tells you at a glance which way up a cutter is, and that it
    // is a cutter at all, is the flutes. They are drawn as the gashes they are —
    // helical grooves wrapping whatever the cutting end's own profile is, so a
    // ball nose's run round its nose and a drill's run into its point.
    for (const flute of fluteGrooves(tool)) group.add(flute);
    for (const insert of faceInserts(tool)) group.add(insert);
    // The holder is a tube and the top of it was open, so from anywhere above
    // the work you looked straight down the bore of the tool.
    const cap = capOfAssembly(tool, this.showHolder);
    if (cap) group.add(cap);
    group.position.set(...position);
    // Draw the tool after the splat overlay (it still depth-tests against the
    // surface mesh, so it is hidden where it is buried in solid stock, but a
    // splat that overhangs a cut can no longer paint over the tool sitting in it).
    group.traverse((n) => { n.renderOrder = CUTTER_RENDER_ORDER; });
    this.cutter = group;
    this.group.add(group);
    return undefined;
  }

  /**
   * The insert and the holder it is bolted to.
   *
   * Three things this has to get right, and the box it used to draw got all
   * three wrong.
   *
   * The shape: a box. Every lathe tool in the rack therefore looked identical
   * while cutting, and the insert shape — the first thing written on the box,
   * and the difference between a tool that can reach into a shoulder and one
   * that cannot — appeared nowhere. It is now the real polygon, extruded from
   * `engine/insert.js`: the same geometry the icon in the list is drawn from.
   *
   * The side: the body was drawn toward −Z, which is the direction a right-hand
   * tool *travels*. So the holder was always buried in the material the tool had
   * not reached yet — it appeared to cut with its trailing edge and sink into
   * the model, which is exactly what it looked like, because that is what it
   * was. A right-hand tool trails toward +Z, through metal it has already
   * removed.
   *
   * The plane: the outline lives in the ZX plane — along the bar, and out from
   * the spindle axis — which is the plane the tool moves in and the plane every
   * lathe drawing in the world is made in. It is also the plane the icon in the
   * tool list is drawn in, and having the two disagree is how you end up
   * checking a tool against a picture of a different tool. Extruded
   * tangentially and straddling Y = 0, so the tool is a solid seen properly
   * from the front, from an isometric and from the end.
   *
   * Two families put the outline there differently and both come out of
   * `engine/insert.js` already correct: an indexable insert seats its cutting
   * corner on the origin with its body trailing outboard and behind the cut, a
   * parting blade is as wide along Z as the groove it makes and as deep
   * radially as it plunges. Neither ever occupies the space the tool has not
   * cut yet, which is the property the old placement did not have.
   */
  setTurningTool(state) {
    const { position, tool } = state;
    if (!tool) return undefined;
    const [x, , z] = position;
    const type = tool.type ?? 'turning';
    const group = new THREE.Group();

    const ic = insertIcOf(tool);
    const insertThickness = Math.max(1.5, ic * 0.35);
    const bladeThickness = Math.max(0.5, tool.bladeWidth || tool.diameter || 3);
    const sections = latheToolOutline(tool, { holderLength: Math.max(35, ic * 4) });
    // The same three looks the milling cutter is made of, for the same reason:
    // what has to be readable at a glance is which part of the assembly is
    // against the work. An insert is carbide and its holder is not, and both
    // were drawn in near-identical dark grey. See TOOL_LOOK.
    const MATERIALS = {
      insert: toolMaterial('cutting', false),
      // solid unless asked otherwise, for the same reason as the mill's — see
      // setCutter above
      holder: toolMaterial('holder', this.ghostTool),
    };

    // ExtrudeGeometry builds the outline in its own XY and pushes it along its
    // own Z, so the axes arrive as (along the bar, radius, thickness) and are
    // permuted into the scene's (radius, tangential, along the bar).
    const toScene = new THREE.Matrix4().set(
      0, 1, 0, 0,
      0, 0, 1, 0,
      1, 0, 0, 0,
      0, 0, 0, 1,
    );

    // Only a parting blade is a blade. A threading tool is a pointed insert on
    // an ordinary shank, and extruding it to the blade's thickness made it as
    // thin as the groove it cuts — see engine/insert.js.
    const blade = type === 'parting';
    for (const { kind, points } of sections) {
      const shape = new THREE.Shape(points.map(([a, b]) => new THREE.Vector2(a, b)));
      // A blade is exactly as thick as the groove it cuts; that is what a blade
      // is. An insert is a plate, and its holder is thicker than the plate.
      const depth = blade
        ? (kind === 'insert' ? bladeThickness : bladeThickness * 2.2)
        : (kind === 'insert' ? insertThickness : insertThickness * 1.6);
      const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
      // The rake face sits ON the cutting plane (Y = 0) and the body extrudes
      // away from it, rather than straddling it. Straddling put the front face
      // half a thickness *ahead* of where the metal actually comes off — the
      // simulation removes stock in the ZX plane and the contact marker sits
      // there too — so the cut read as happening inside the tool's mid-thickness
      // rather than on its edge. ExtrudeGeometry builds the shape at z = 0 and
      // pushes it to +z, which `toScene` sends to +Y; the default view looks
      // along −Y, so the rake face (the z = 0 cap, facing −Y) is the one you see,
      // its cutting edge on the plane, and the body trails behind it out of shot.
      geometry.applyMatrix4(toScene);
      group.add(new THREE.Mesh(geometry, MATERIALS[kind] ?? MATERIALS.insert));
    }

    group.position.set(x, 0, z);
    // after the splat overlay, so a splat overhanging the cut cannot hide the
    // insert working in it (see setCutter and the render orders)
    group.traverse((n) => { n.renderOrder = CUTTER_RENDER_ORDER; });
    this.cutter = group;
    this.group.add(group);
    return undefined;
  }

  setVisible(visible) {
    this.group.visible = visible;
  }

  clear() {
    this.setCutter(null);
    // The splat overlay shares the surface's geometry, so only its material is
    // its own to dispose; the geometry goes when the surface does, below. Nulled
    // so the next simulation builds a fresh overlay on its own grid.
    if (this.splat) {
      this.splat.parent?.remove(this.splat);
      this.splat.material.dispose();
      this.splat = null;
    }
    // rebuilt rather than reused: its size comes from the grid, and the next
    // simulation is a different grid
    for (const key of ['surface', 'base', 'cutMarker']) {
      const object = this[key];
      if (!object) continue;
      object.parent?.remove(object);
      object.geometry.dispose();
      object.material.dispose();
      this[key] = null;
    }
    if (this.workGroup) {
      this.group.remove(this.workGroup);
      this.workGroup = null;
    }
    this.sim = null;
    this.skirtOf = null;
    this.through = null;
    this.quadCount = 0;
    this.rings = 0;
    this.ringShade = null;
    this.capOf = null;
  }
}
