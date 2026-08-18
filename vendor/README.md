# Vendored dependencies

All dependencies are pinned, committed, and loaded as static files — no CDN at
runtime, no build step. To update, replace the files and update this table.

Only what the app actually imports is vendored. three.js ships dozens of
addons; the loaders are not among them, because STL, OBJ and DXF are parsed
in-house (`src/io/`) and STEP/IGES go through the occt worker.

| Package | Version | Files | License |
|---|---|---|---|
| three.js | 0.169.0 | `three/three.module.js`, `three/addons/controls/OrbitControls.js` | MIT |
| occt-import-js | 0.0.23 | `occt/occt-import-js.js`, `occt/occt-import-js.wasm` | LGPL-2.1 |
| Clipper | 6.4.2 | `clipper/clipper.js` | BSL-1.0 |

Sources (jsdelivr, pinned):

```
https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js
https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/controls/OrbitControls.js
https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/occt-import-js.js
https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/occt-import-js.wasm
http://www.angusj.com/delphi/clipper.php
```

Import mapping lives in `index.html` (`"three"` and `"three/addons/"`).
The occt worker (`src/workers/occt-worker.js`) loads its files by relative path.
Clipper is a classic script that assigns a `ClipperLib` global; `src/geom/clipper.js`
side-effect-imports it and wraps it, and is the only file that touches it directly.

That relative path is the reason the LGPL sits comfortably here. The occt build
is never bundled into CNCAM: the worker pulls `occt-import-js.js` at runtime and
that file fetches its own `.wasm` beside itself, so replacing both with a
different build needs no rebuild of anything else. That is the replaceability
LGPL-2.1 asks for, and it is why the rest of CNCAM can be WTFPL. See `LICENSE`.
Keep the two files together and keep them swappable.
