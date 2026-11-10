# Reliability, workflow and 5-axis pattern round (2026-11-10)

Changes made in a separate working copy against commit 171997b (1,034 tests) and merged back; the suite is now 1,066 tests.

## Run and compare

To compare a build before this round with one after it, check out the commit before the merge in a second folder and run `python serve.py 8510` there and `python serve.py 8511` here. Different ports keep browser autosaves and tool libraries separate. Import the same project file into both.

## Changes

- Worker dispatch failures release pool capacity; queued work can continue. Replacement-worker construction failures reject waiting work instead of hanging.
- Failed grouped edits retain their applied changes as an undoable entry.
- Numerical approximate assertions reject NaN, infinity, and invalid tolerances. Three new regression tests cover these bugs.
- The DXF command-palette action opens a picker, treats cancellation as cancellation, and reports parse errors.
- Project replacement clears pending-operation state, rebuilds viewport models even when IDs are reused, and rejects toolpath results belonging to the previous project.
- File writes abort after errors rather than committing partial data. Version saves use Web Locks where available and a per-project promise queue otherwise.
- Malformed version metadata is ignored while actual version files remain discoverable. New project-store IDs include a random suffix.
- Unreadable OPFS autosaves are retained for recovery. Blocked localStorage no longer prevents clearing an OPFS session.
- Autosave no longer serializes geometry for selection, viewport visibility, or toolpath-result notifications. Generate avoids merging geometry for setups whose operations are all reused.
- Save status distinguishes changes, saving, saved, disabled, and failed states. Browser autosave is explicitly separate from saving a project file.
- Read-back check status is visible in the G-code panel, including checks skipped due to program size and checks that could not run.
- Operation presets are available beneath the operation tool selector: save, preview, apply, rename, delete, import, export. Presets retain scalar parameters; tool references and geometry selections are excluded. Apply is undoable. Review heights and stepping after applying to another job.
- Export and File menus, plus the command palette, provide a printable setup/tool sheet with stock, fixtures, WCS, operations, tools, programmed values, path status, and time estimates.
- Keyboard focus is more visible; status updates are announced; panels leave more viewport space at laptop widths.

## Validation and comparison

Baseline: 1,034/1,034 tests. Updated suite: 1,037 tests, including three new regressions. The existing browser interaction sweep passed 338 checks. Dedicated browser checks exercise preset save/apply, setup-sheet output, PDF printing, and desktop/laptop layouts without page errors.

Simulation microbenchmarks (best of five, milliseconds):

| Workload | Before medium/high/ultra | After medium/high/ultra |
| --- | --- | --- |
| Mushroom | 24 / 52 / 164 | 21 / 50 / 153 |
| Deep pocket | 6 / 17 / 53 | 5 / 14 / 47 |
| Adaptive | 7 / 19 / 56 | 6 / 18 / 54 |

The simulation kernel was unchanged. Timing differences are normal run-to-run variation, not evidence of a simulation optimization. One browser job measured 322.5 ms before / 44.4 ms after for first generation and 3.5 / 3.2 ms for cached generation; warm-up makes the first-generation comparison unsuitable as a speedup claim.

Comparison screenshots and the one-off browser check scripts were made during the round and are not kept in the repository (`shots/` is ignored).

## Limits of this pass

Browser checks used headless Microsoft Edge at 1440x1000 and 1000x720. Firefox/Safari, physical machine execution, large industrial STEP files, and full keyboard/screen-reader audits were not validated. This does not establish machine safety. Worker mesh-sharing architecture and geometry-encoding caching were left unchanged because their invalidation and memory tradeoffs require larger representative projects. Existing simulator geometry limitations remain documented in README.

## Five-axis finish patterns

Enable Options → Experimental → 5-axis beta, then Add operation → 3D finishing → **5-axis finish**. Its **Passes → Pattern** field offers Zig-zag, One-way, Concentric, Spiral and Radial. Concentric makes circular laps; Spiral winds inward; Radial cuts centre-out spokes. The spacing field changes to Spiral pitch or Outer spacing where appropriate. All operate on top-accessible surfaces in setup XY, around the machining bounds' centre.

Projects and presets saved with the briefly separate concentric/spiral/radial operation types migrate to five-axis finish with the corresponding pattern. Custom operation names and other settings are preserved.
