# Five-axis pattern audit and implementation checklist

Working checklist from the 2026-11-10 round; open items are not yet verified.
Parent items remain open until every acceptance criterion is met.

- [ ] 1. Final tilted cutter respects depth, regions, protected geometry and complete cutting envelope.
  - [x] Recheck final tilted tip depth and region probe; retain rejected samples as path breaks.
  - [x] Recheck stay-down link tip depths. Four-pattern Bottom Z regression passes.
  - [ ] Validate complete tilted cutting envelope against protected regions; define boundary semantics in UI.
- [ ] 2. Independently validate complete swept cutting motion and simplified segments.
  - [x] Bounded spatial/angular between-point checks on cutting samples and stay-down links.
  - [x] Local subdivision raises intermediate cutter-interference points to the sampled surface, with depth and sample budgets.
  - [x] Simplification must pass between-point checks; rejected depth sections simplify independently without bridging breaks.
  - [x] Unit regressions cover mid-segment obstacles, stationary rotation and exhausted verification budgets.
  - [ ] Independent geometric reference and continuous conservative error bound. Current checks use the heightmap/kernel representation; suspected quantization collisions are rechecked with the interpolated axis.
- [ ] 3. Make unresolved body collisions invalidate paths; check all motion.
  - [x] Unresolved sampled shank/holder collisions throw a coordinate-specific generation error.
  - [x] Stay-down link samples receive body collision checks.
  - [x] Regression: tool blocked by pocket walls is refused.
  - [ ] Sweep bodies through entries, retracts and orientation changes; bounded orientation search.
- [ ] 4. Remaining-stock engagement control and finishing allowance.
- [ ] 5. Surface-aware spacing, scallop target, coverage cleanup and unsupported-surface overlay.
- [ ] 6. Efficient radial machining.
  - [x] Cover centre once, start subsequent spokes outside central patch, alternate inward/outward.
  - [x] Remove unconditional spoke retract; use checked stay-down links.
  - [x] Pattern direction, finite motion, inner dome simulation and depth tests pass.
  - [x] Explicit inward/outward one-way spoke options, with retracts between one-way passes; direction tests pass.
  - [ ] Boundary-derived spoke count and whole-surface coverage verification.
- [ ] 7. Periodic closed-ring smoothing, seams, direction options and verified ring links.
  - [x] Smooth across the closed seam, share endpoint orientations and independently verify seam equality on complete laps.
  - [x] Add clockwise/counterclockwise/alternating ring controls with cutting-direction regressions.
  - [ ] Optimize seam placement and ring connections for each machine.
- [ ] 8. Geometry-derived extents, selectable centre, islands and spiral cleanup.
  - [x] Expose nullable X/Y pattern centre in setup coordinates; shifted-centre generation and browser edit tests pass.
  - [x] Radius covers the farthest machining-box corner when a custom centre is used.
  - [ ] Geometry-derived radial extents, island planning and spiral cleanup.
- [ ] 9. Rotary planning and verified unwinds.
  - [x] A later run limit no longer rejects a valid entry link prematurely.
  - [x] Reject unreachable orientations and zero-margin run starts explicitly.
  - [ ] Verify complete retract/unwind/return and narrow-limit regressions.
- [ ] 10. Distance-based orientation smoothing, tolerance-based quantization, rotary dynamics.
  - [x] Turn limiting uses actual 3D sample distances; azimuth limiting uses each individual segment distance.
  - [x] Gaussian lean smoothing uses cumulative 3D sample distance, including periodic distance for rings.
  - [x] Replace quadratic scans of contiguous near-vertical/free sections with a linear interval fill.
  - [ ] Quantization error bounds and machine dynamics.
- [ ] 11. Whole-surface independent regression and user-visible diagnostics.
  - [x] Added four depth-window regressions and blocked-holder regression.
  - [ ] Complete-surface residual/gouge/engagement tests and UI diagnostics.

## Measured comparison

Same diameter-16 dome, diameter-6 ball, stepover 1.2, tolerance .04, lead zero.
Rapid counts / rapid travel in mm, before -> current:
- Concentric: 48 / 487.46 -> 36 / 395.22.
- Spiral: 17 / 129.85 -> 25 / 233.10.
- Radial: 300 / 2917.42 -> 70 / 669.46.

Spiral has a measured efficiency regression under the stricter checks; do not mark it optimized.
These are path metrics, not machine cycle times or whole-surface certification.

## Further implementation pass

Added spatial/angular sampled cutting and link checks, bounded local cutter-interference refinement, and validation of simplification candidates. A quantized-kernel interference finding is rechecked with the interpolated axis before rejection/refinement. These checks share the generator heightmap and are not an independent mesh/continuous swept-volume proof.

Removed a spiral performance bug: one invalid depth sample no longer disables simplification for the entire run. Each valid section is simplified separately, keeping mandatory breaks.

Browser pattern generation was verified with no page errors. Exact outcome of the latest broader regressions is recorded in five-motion-finish-results.txt; do not infer whole checklist completion from local passing tests.

Latest reproducible measurements: run `node src/test/five-pattern-benchmark.js` (results in five-motion-benchmark.txt).
With sampled motion verification enabled, rapid counts are raster 60, concentric 36, spiral 29, radial 70. Generation took approximately 3.5s, 2.2s, 2.8s, 6.3s respectively on this run. These changes prioritize verified sampled links over retaining the earlier rapid counts. Raster and spiral linking efficiency remain open; do not claim all patterns improved.

Fractional-angle suspect checks use direct cutter-kernel construction with a bounded 256-entry cache, avoiding growth of the degree-keyed interpolation tables for arbitrary floating-point angles.

The stepped-part regression exposed unresolved intervals at the heightmap/kernel discretization boundary. Refinement is bounded; intervals still reporting cutter interference are omitted with mandatory path breaks and an explicit incomplete-finish warning. Body collisions and verification-budget failures remain generation errors. This can leave stock requiring cleanup and is not whole-surface completion.

Browser app sweep also completed (see five-motion-app-sweep.txt). Whole-checklist parent items remain unchecked.

## Pattern controls and distance smoothing

Added ring and spoke directions plus optional setup-coordinate pattern centres. Circular controls are hidden for raster. One-way radial modes retract between spokes. Direction labels and centre edits passed the live browser check, with no page errors. New engine checks exercise both ring directions, both one-way spoke directions, shifted spiral centre and closed-lap seam orientation.

The earlier complete five-axis UI sweep finished with 24 passed / 0 failed (five-motion-ui-results.txt). The first full-app sweep had five downstream failures during development; it is not a clean full-app verification of the final code.

Latest control verification: five-controls-results.txt has 19/19 passing checks (including save/reload). Five-controls-browser-results.txt confirms real direction-label and centre-field edits for all three circular patterns with no page errors. Five-distance-results.txt has 24/24 passing focused checks before the additional save/reload regression. The broader pre-distance-smoothing run passed 40/40 (five-ring-all-results.txt); final distance-smoothing surface/rotary regression is separate (five-distance-finish-results.txt).

Final distance-smoothing surface/rotary regressions: 16/16 passed. Combined with focused pattern/control/motion checks, the current changes have 41 relevant passing tests.
