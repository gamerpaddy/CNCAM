# CNCAM — Development Plan (Browser-based, static, no backend)

A CAM application that runs entirely in the browser as a **static site** — HTML + JavaScript, no server-side code, no accounts, works offline once loaded. A small set of client-side libraries is allowed where they genuinely buy robustness (rendering, geometry kernel); everything is **vendored locally** (copied into the repo, loaded as ES modules/WASM from the same folder) so the app runs from any static host — GitHub Pages, a USB stick with a one-line local server, or as an installable PWA. No build step required.

It imports 3D models, lets the user define tools and machining operations, and generates G-code for:

- **3-axis milling** (2.5D and full 3D surfacing)
- **3+2 axis** (positional / indexed 5-axis)
- **Lathe** (2-axis turning, threading, grooving)
- **Simultaneous 5-axis** (swarf, multi-axis surfacing)

---

## 1. Dependency policy & the chosen set

Rule: a dependency must run 100% client-side, be vendorable as static files, and replace something that would take months to hand-roll robustly. Everything else is written in-house. No frameworks, no bundler, no npm-at-runtime.

| Dependency | What it buys | Notes |
|---|---|---|
| **three.js** | WebGL renderer: shaded models, toolpath lines, stock display, machine sim, camera controls, GPU picking | Single vendored module + `OrbitControls`, `STLLoader`, `OBJLoader`, `3MFLoader` from examples. The whole viewport layer. |
| **occt-import-js** (OpenCASCADE compiled to WASM) | **STEP/IGES import** — B-rep tessellation to meshes with per-face grouping | This is the difference between a hobby STL tool and real CAM input. WASM loads from static files; runs in a worker. |
| **Clipper2 (JS/WASM port)** | Robust 2D polygon offsetting & booleans — the heart of all 2.5D strategies | The classic "graveyard" component; do not hand-roll. |
| *(optional, later)* **manifold-3d** (WASM) | Watertight mesh booleans if stock-from-model-offset or fixture subtraction needs them | Deferred until a phase actually needs it. |

Written in-house (deliberately): STL/OBJ/DXF parsing beyond what loaders give, BVH + drop-cutter, SDF fields, all toolpath strategies, linking, tri-dexel simulation, kinematics, post engine, UI (vanilla DOM), project persistence, worker pool. This is the actual product; the dependencies are commodity substrate.

**Distribution:** open `index.html` from any static host. PWA manifest + service worker → installable, fully offline. `file://` is not a target (WASM/worker restrictions); "no server" means *no backend*, and a static folder satisfies that.

---

## 2. Architecture

```
index.html                     (PWA: manifest + service worker)
vendor/    three.js, occt-import-js (.js+.wasm), clipper2 — vendored, pinned
src/
  app/     UI shell, setup/op tree, parameter panels, dialogs (vanilla DOM)
  view/    three.js scene: model, toolpath lines (chunked+LOD), stock,
           tool/holder ghost, machine sim, picking, ZX lathe view
  io/      STEP/IGES (occt worker), STL/OBJ/3MF/DXF, project JSON,
           File System Access + IndexedDB autosave
  geom/    vec/mat helpers, BVH, Z-slicer, chain stitching, SDF fields,
           arc/biarc fitting, spin-profile extraction, hole recognition
  engine/  toolpath strategies → CL data (run in Workers)
  link/    ordering, leads, ramps, retracts, stay-down links, feed classes
  sim/     tri-dexel stock, removal playback, gouge/excess verify, collision
  machine/ machine definition JSON, FK/IK kinematics, limits, singularity
  post/    CL → G-code; dialect toolkit + user-editable JS posts (in-app editor)
  workers/ worker pool, job protocol (progress + cancellation), transferables
test.html  in-browser unit suite (also runs under `node --test` for CI)
```

**Data flow:** *Geometry + Tool + Op params → Strategy (worker) → CL data → Verification (worker) → Post → G-code.*

**CL data** is the load-bearing contract: a flat typed-array event stream — moves as `(x, y, z, i, j, k, feedClass)` with a state-event side table (tool change, spindle, coolant, WCS, cycles). The tool-axis vector `(i,j,k)` exists from day one (constant `(0,0,1)` for 3-axis), which is exactly what makes 3+2 and simultaneous 5-axis *extensions of the same pipeline* rather than new programs. Spec'd early, versioned, zero-copy transferable between workers.

**Threading model:** main thread renders and edits; all toolpath generation and simulation runs in a `hardwareConcurrency`-sized worker pool on transferable buffers (SharedArrayBuffer where cross-origin isolation allows). The UI never blocks; stale toolpaths render hatched until background regeneration completes.

---

## 3. Core subsystems

### 3.1 Import & geometry core

- **STEP/IGES** via occt-import-js in a worker → triangle meshes with **per-B-rep-face grouping** preserved (critical: face-level selection for op geometry, hole recognition from cylindrical faces, slope analysis per face). User-controlled tessellation tolerance (default ≤ ⅒ of machining tolerance).
- **STL/OBJ/3MF** via three.js loaders + in-house cleanup: vertex welding (hash grid), normal generation, degenerate removal. **DXF subset** (LINE/ARC/CIRCLE/LWPOLYLINE) parsed in-house for lathe profiles and 2.5D chains.
- **BVH** over triangles (in-house, SAH split) — powers drop-cutter, ray picking, and collision queries.
- **Z-slicer:** mesh × plane → stitched closed loops; feeds roughing, waterline, silhouettes, and lathe spin profiles.
- **2D engine:** Clipper2 for offsets/booleans; in-house **SDF grid fields** (erosion, engagement queries, stock-safe-region tests — numerically bulletproof complement to exact offsets); polyline simplification; **biarc fitting** for compact, smooth G-code arcs.
- **Feature helpers:** hole detection (cylindrical faces from STEP; circular slice-loops for meshes), outer silhouette, **spin profile** (max radius per Z, OD + ID chains) for lathe.
- Units: mm internal; inch at UI/post boundaries only.

### 3.2 Tool library

- Mill: flat/ball/bull end mills, face mill, drill, spot, chamfer, tap, thread mill — each = cutter profile + shank + **holder** (cone/cylinder stack; required for collision checking).
- Lathe: inserts (nose radius, included/approach angle, hand), grooving/parting blades, threading inserts, drills.
- Cutting data per material → feeds/speeds defaults. JSON storage: per-project + persistent IndexedDB library with file import/export.

### 3.3 Operations framework

- **Setup** = stock (box/cylinder/from-model-offset/DXF revolve) + WCS + machine. **Operation** = strategy + tool + geometry selection + parameters + optional work plane.
- Shared parameter blocks: stock-to-leave (radial/axial), tolerance, stepover/stepdown, entry (helix/ramp/plunge with flute-length limits), leads, clearance/retract, spindle/coolant.
- **Dependency graph:** rest machining depends on prior stock state; edits dirty downstream ops; regeneration queued to workers with progress/cancel. Op templates saved to library.

### 3.4 Toolpath strategies

**2.5D:** facing; 2D contour (multi-depth, tabs, climb/conventional, G41/G42 or computer comp); 2D pocket — offset clearing **and adaptive clearing** (constant engagement via Clipper offset sequences + SDF engagement tracking, trochoidal inserts at spikes); drilling (hole recognition → G81/G83/G73/G84/G85); slots, chamfering, helical thread milling.

**3-axis 3D:** **drop cutter** (flat/ball/bull, analytic vertex/edge/facet contact) against BVH, with height-field cache for dense meshes; adaptive Z-sliced roughing (stock-aware); waterline finishing (steep) + raster with scallop-height stepover (shallow) with automatic steep/shallow split; pencil/corner cleanup; rest machining vs stock snapshots or reference tool.

**3+2:** work-plane object (from face normal / two edges / angles); any strategy runs in plane-local coordinates on a rotated mesh copy; reachability + holder collision at orientation; retract-before-rotate linking. Post output: **G68.2 / CYCLE800 / PLANE SPATIAL** tilted-work-plane with TCP, or IK-computed rotary angles + rotated WCS for machines without TWP.

**Lathe:** spin profile from solid or DXF; bar/tube/profile stock; roughing (computed passes or G71/G72), finishing with **nose-radius comp**, grooving (peck + flank), parting, centerline drilling, threading (metric/UN tables, multi-start, radial/flank/alternating infeed → **G76** or G92/G32 long-hand); **G96 CSS + G50 clamp**; insert back-angle collision check against profile. Later: C-axis live tooling, Y-axis.

**Simultaneous 5-axis** (in implementation order): **swarf** (ruled strips between picked edge chains); curve-driven with surface projection; flow-line surfacing. Tool-axis control: lead/lean vs normal, through-point/curve, vector interpolation, plus an **axis-smoothing pass** (clamp angular velocity/accel in CL data). Gouge check drops the *actual cutter* (not just contact point) against the BVH; holder/shank clearance; collision resolution by tilt-away, else trim + report. Strategies emit unit axis vectors only — kinematics stay in the machine layer.

### 3.5 Linking & motion (shared)

Pass ordering to minimize air time; stay-down links inside stock-safe regions (SDF query); clearance transitions; tangent/arc leads; ramp/helix entry limits; feed classes (cut/lead/ramp/rapid) with corner slowdown; biarc fitting to shrink output.

### 3.6 Stock simulation & verification

- **Tri-dexel stock** (three orthogonal dexel fields in typed arrays); analytic subtraction of swept tool per CL segment; snapshot ring for scrubbing playback; surface extraction to a three.js mesh, progressively updated. Lathe uses a 2D half-profile stock until live tooling.
- **Verification:** final field vs target → **gouge** (under-target) and **excess** (rest material) heat maps, each hit back-referenced to op + G-code line.
- **Collision:** tool/shank/holder vs in-process stock and fixtures (capsule-vs-dexel + capsule-vs-BVH); for 5-axis, **full machine simulation** — kinematic chain with per-axis meshes animated in three.js, broadphase sphere trees + triangle narrowphase, rotary-limit and singularity-proximity warnings.
- Policy: 5-axis output requires a clean sim run before posting; 3-axis strongly nudged.

### 3.7 Machines, kinematics, posts

- **Machine definition = JSON:** axes (type, travel, max feed), kinematic chain (table-table A/C, head-head, head-table…), TWP/TCP capability (G43.4/TRAORI/M128), dialect, arc support, canned cycles, rotary winding, block rate; optional component meshes for sim.
- **Kinematics library** (shared by posts + simulator): FK/IK for standard 5-axis configs, solution selection (shortest path, limit avoidance), **linearization** (re-sample so rotary interpolation error ≤ tolerance without TCP), **inverse-time feed (G93)** computation, singularity handling (C-flip storms near vertical → re-solve/slow/warn).
- **Post engine:** posts are **plain JS the user edits in-app** (sandboxed execution over the CL event stream) with a formatting toolkit — word building, modality tracking, number formats (Fanuc decimal traps), sequence numbers, program skeletons. User-hackable posts are a feature, not a compromise.
- **Initial posts:** GRBL, LinuxCNC, Fanuc mill (+TWP/TCP), Haas mill/UMC, Fanuc/Haas lathe. Few and exemplary; the JS layer covers the long tail.
- Extras: printable HTML setup sheets, tool lists, time estimates, per-op or combined NC files.

### 3.8 UI

Vanilla DOM. Left: setup/op tree (drag-reorder). Right: parameter panel (tabs: geometry/heights/passes/linking). Bottom: simulation timeline scrubber. Collapsible G-code panel with **line ↔ toolpath cross-highlighting**. three.js viewport: face/edge/chain picking (GPU ID buffer), feature-edge chain detection (dihedral angle), slope flood-select for steep/shallow, toolpath color by feed class with LOD chunking, tool+holder ghost at scrub position, section view, ZX lathe mode with diameter readout. Command palette (Ctrl+K). Undo/redo across the document. Design rule: any op usable with defaults in 3 clicks (geometry, tool, OK).

---

## 4. G-code specifics per mode

| Concern | 3-axis | 3+2 | Lathe | 5-axis simultaneous |
|---|---|---|---|---|
| Coordinates | XYZ, G54+ | TWP (G68.2/CYCLE800) or angles+rotated WCS | X diameter, Z; G18 | XYZ+rotaries, TCP (G43.4) preferred |
| Comp | G41/42 or computer | computer recommended | nose-radius G41/42 | computer only |
| Cycles | G81/83/73/84/85 | same, in TWP | G71/G72/G70/G76/G92, G96/G50 | none (long-hand) |
| Feed | G94 mm/min | G94 | G95 mm/rev + CSS | G94 with TCP, else G93 inverse-time |
| Arcs | G2/3 IJK/R, G17/18/19 | in TWP plane | ZX plane | usually linearized |

Post-owned correctness details (all under golden-file tests): modality and word order per dialect, decimal formats, retract-before-rotate sequencing, TWP cancel before tool change, thread-cycle sync (no feed override), safe start/end blocks, rotary unwind, homing idioms.

---

## 5. Phased roadmap

Each phase exits as a releasable static build.

### Phase 0 — Foundation
Static scaffold (ES modules, vendored deps, PWA shell); three.js viewport (shaded mesh, orbit, GPU picking); STEP/IGES via occt worker + STL/OBJ/3MF/DXF; mesh cleanup + BVH; document model + undo + project JSON (File System Access, IndexedDB autosave + crash recovery); tool library CRUD; setup/WCS/stock; worker pool with cancellation; in-browser test runner + `node --test` CI.
**Exit:** load a STEP file offline in a browser tab, orient it, define stock and tools, save/reload the project.

### Phase 1 — 2.5D milling MVP
Clipper2 + SDF 2D engine; contour, pocket (offset clearing), facing, drilling with hole recognition; linking/leads/ramps; **CL data v1 frozen**; post engine + in-app JS post editor + GRBL/LinuxCNC/Fanuc-mill posts; backplot with G-code cross-highlight; time estimates.
**Exit:** a real bracket-class part (contour + pocket + drill) cut on a machine from CNCAM G-code.

### Phase 2 — Adaptive + 3D surfacing
Drop-cutter engine + height-field cache; adaptive clearing (2D + Z-sliced 3D roughing); waterline + raster finishing with steep/shallow split; pencil; rest machining; **tri-dexel simulation** with playback, gouge/excess verification; dependency-graph background regen.
**Exit:** rough + finish a freeform part; verifier catches a deliberately introduced gouge.

### Phase 3 — Machine awareness & 3+2
Machine-definition JSON + kinematics library (FK/IK, limits, solution choice); work planes running all existing ops; holder collision at orientation; TWP posts + angles-only fallback; retract-before-rotate linking; machine-sim view (animated chain + collision).
**Exit:** 5-sided part programmed and simulated on a trunnion machine; clean posts both TWP and angles-only.

### Phase 4 — Lathe *(independent of 3/5 — can be pulled earlier)*
Spin-profile extraction; bar/tube/profile stock; rough/finish/groove/part/drill/thread; nose-radius comp; G96/G50; insert back-angle check; 2D removal sim; Fanuc/Haas lathe posts; ZX view UI.
**Exit:** shaft with shoulder, groove, and gauging thread turned from CNCAM code.

### Phase 5 — Simultaneous 5-axis
Swarf → curve-driven → flow-line (gated in that order); lead/lean and through-point/curve axis control; axis smoothing; full-cutter gouge check + tilt-away avoidance; TCP output, linearization + G93 fallback, singularity handling; machine sim required before post.
**Exit:** impeller blade (flow-line) + swarf wedge, clean in sim and in metal.

### Phase 6 — Polish (ongoing)
Feeds/speeds advisor + material DB; templates; setup sheets; probing cycles (Renishaw/Blum); pattern/instance ops; 4-axis rotary wrap; lathe live tooling (C/Y); manifold-3d for stock booleans if needed; WebGPU compute fast path (drop-cutter grids, dexel subtraction); performance passes.

---

## 6. Browser-specific engineering notes

- **Memory:** typed arrays throughout; SharedArrayBuffer where COOP/COEP headers allow (GitHub Pages needs a service-worker header shim — implement it), transferables otherwise; dexel resolution adapts to part size within ~2–4 GB heap reality.
- **Persistence:** explicit file save (`.cncam` JSON; meshes embedded compressed or re-referenced) is primary; IndexedDB is autosave/recovery cache; request persistent-storage permission.
- **Vendoring discipline:** pinned versions committed under `vendor/`; no CDN at runtime; license files kept (three.js MIT, Clipper2 BSL, OCCT LGPL-2.1-with-exception — WASM-module usage is compliant, audit before any commercial release).
- **Performance targets:** adaptive roughing of a 500k-triangle model ≤ 60 s on 8 cores; 0.1 mm-stepover finishing ≤ 30 s; dexel sim interactive at 0.05 mm on a 300 mm part; 60 fps viewport with millions of toolpath segments (LOD).
- **Compatibility:** Chrome/Edge first-class; Firefox/Safari functional via download-blob fallback where File System Access is missing.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| JS/WASM performance ceiling vs native CAM | Workers + typed arrays get within ~2–4× native for this workload; algorithm choices (SDF, height fields, dexels) are brute-force-friendly; WebGPU later. |
| occt-import-js coverage gaps (huge STEPs, exotic entities) | Corpus fuzz-testing with real CAD files; mesh formats as universal fallback; tessellation-tolerance guidance in docs. |
| Machine crashes from bad output → user harm | Sim-before-post gate (hard for 5-axis), gouge/collision checks, conservative defaults, safety skeletons per post, disclaimer, "cut foam first" docs. |
| Browser storage eviction | File save primary, IndexedDB secondary, persistent-storage permission. |
| 5-axis scope explosion | CL data carries axis vectors from day one; swarf before general surfacing; each drive method gated on the last. |
| Post/controller combinatorics | Few exemplary scriptable posts + docs + golden tests; community posts via the in-app editor. |
| Dependency rot | Everything vendored + pinned; three of them, all mature; no build chain to break. |

---

## 8. Testing & validation

1. **Unit suite** (in-browser `test.html`, mirrored under `node --test`): math, parsers, offset edge cases, drop-cutter analytic cases, slicing on known solids, FK↔IK round-trips.
2. **Property-based toolpath tests:** random parameter draws → no gouge beyond tolerance (independent dexel check), scallop ≤ bound, entries within flute length, stay-down links never exit stock-safe region.
3. **Golden-file regression:** strategies × benchmark parts → committed CL dumps + G-code, diffed like code.
4. **Post conformance:** LinuxCNC sim / NCViewer runs; plus an internal **parse-back tool** — re-parse emitted G-code into motion and diff against source CL data (catches post bugs; doubles as a G-code backplot feature).
5. **Simulation cross-check:** removed volume + final-shape deviation vs target on benchmarks.
6. **Physical test parts:** circle-diamond-square (3-axis), 5-sided tombstone (3+2), threaded shaft with groove (lathe), impeller blade + swarf wedge (5-axis) — measured, archived per release.

---

## 9. Immediate next steps

1. Scaffold `index.html`, `src/` layout, `vendor/` with pinned three.js + occt-import-js + Clipper2, `test.html`, one-line static-server note (`npx serve` / `python -m http.server`), GitHub Pages deploy.
2. **Spike A:** STEP → occt worker → three.js shaded viewport with face picking. (Validates the import/render foundation — the riskiest dependency.)
3. **Spike B:** end-to-end miniature — rectangle pocket → Clipper offset clearing → linking → Fanuc post → verify in LinuxCNC sim/NCViewer. (Validates the whole pipeline; informs the CL data spec.)
4. Freeze CL data v1; execute Phase 0.
