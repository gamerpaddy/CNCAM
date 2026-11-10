# Five-axis implementation checklist

Tick only after implementation and verification of the complete item.

- [ ] 1. Block unreachable production output and provide actionable findings.
- [ ] 2. Enforce configurable non-TCP interpolation tolerance, including quarter-point checks and bounded failure.
- [ ] 3. Verify complete retract, unwind, and return motion.
- [ ] 4. Replace coarse fixture collision sampling.
- [ ] 5. Bind verification to exact exported inputs.
- [ ] 6. Calculate motion limits independently per axis.
- [ ] 7. Derive angular resolution from accuracy requirements.
- [ ] 8. Add look-ahead singularity and branch planning.
- [ ] 9. Highlight unsupported geometry and coverage.
- [ ] 10. Search and explain alternative holder-safe orientations.
- [ ] 11. Add machine-coordinate setup preview.
- [ ] 12. Add navigable five-axis findings and viewport overlays.
- [ ] 13. Profile and optimize representative workloads.
- [ ] 14. Add finishing-path choices with regression coverage.
- [ ] 15. Build independent five-axis regression pack.

## Verified implementation progress

### Item 1
- [x] Reject unreachable endpoints and intermediate orientations in the post.
- [x] Include operation, source move, requested orientation and solved angles in the failure.
- [x] Catch failures in whole-job, per-operation and single-operation exports before writing files.
- [x] Clear obsolete preview output and display posting failures.
- [ ] Highlight offending segments and offer contextual corrections in the UI.

### Item 2
- [x] Check quarter, midpoint and three-quarter points of non-TCP cutting blocks.
- [x] Enforce positive finite interpolation tolerance supplied through setup.five.tipTolerance (default 0.01 mm).
- [x] Reject cutting paths that remain outside tolerance after bounded refinement.
- [x] Retain a regression for the existing dome path that previously exported despite unresolved interpolation error.
- [ ] Add a user-facing tolerance control, local adaptive subdivision, and a navigable deviation finding.
- [ ] Verify rapid/reposition motion under item 3; cutting-path interpolation checks do not establish rapid clearance.

Validation: 21/21 five-axis post tests passed. The valid non-TCP test reconstructs machine-coordinate output and compares it with its source path. Three additional tests cover unreachable output, unresolved tolerance, and a valid round trip. The original normal-following dome remains in the rejection regression; TCP round-trip tests still use it.

### Item 14: circular finishing substep
- [x] Add selectable Concentric pattern for round parts in setup XY.
- [x] Follow circular tangents for lead/side tilt, retain shared region/holder/rotary handling, and hide irrelevant raster angle.
- [x] Verify tangential motion and centre coverage, independent dome removal simulation, UI selection, and existing browser sweep.
- [ ] Other planned boundary/scallop/curve strategies remain pending.

Concentric passes do not guarantee shorter cycle time. Rotary travel limits and discontinuous supported regions can require additional retracts; compare the generated path on the actual job.

### Additional operation choices
- [x] Concentric finish: dedicated operation with outside-in circular laps.
- [x] Spiral finish: inward Archimedean spiral with tangent-based tool lead.
- [x] Radial finish: centre-out spokes with outer-radius spacing and retracts between spokes.
- [x] Integrate all three with beta gating, milling picker cards, defaults, tool matching, parameters, fingerprints, worker generation and project persistence.
- [x] Verify six operation tests (metadata/persistence and independent dome simulation), plus browser picker and real worker generation of all three with no page errors.

These strategies operate on top-accessible surfaces in setup XY using the existing heightmap model. They do not add sidewall swarf or undercut machining. Spiral and concentric passes may split at boundaries, holes, holder-clearance changes or rotary travel constraints.

Additional-operation validation completed: full suite 1,049/1,049 passed; browser sweep 338/338 passed; final radial-heading adjustment rechecked with all six operation tests and worker/UI checks for all three operations.

### Finish-pattern consolidation (supersedes separate operation choices above)
- [x] Keep a single five-axis finish operation in the picker.
- [x] Offer Concentric, Spiral and Radial under its Pattern field alongside Zig-zag and One-way.
- [x] Migrate previously saved separate operations and presets to the corresponding finish pattern.
- [x] Verify migration and all three path shapes with 29 focused tests; verify picker, controls and worker generation in the browser with no page errors.
