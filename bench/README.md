# bench

Measuring the material-removal simulation, rather than reading it.

The simulation's job is to say what shape the cutter leaves behind, and there is
an answer to that which owes nothing to how the sweep is written: take each
move, walk it in a few thousand pieces, and drop the tool at every one. That is
far too slow to simulate with and exactly right, which makes it the thing to
measure against. Everything here is that idea in one form or another.

None of it runs in the test suite — it is too slow, and the parts of it worth
running every time are in `src/test/simulate.test.js` instead.

| | |
|---|---|
| `ref.js` | The brute-force envelope for milling, in the same terms `engine/simulate.js` uses. |
| `sim-bench.js` | Hand-written cases — ramps, helices, plunges — where the sweep is hardest. Reports error and time per case. |
| `all-strategies.js` | Every milling strategy × cutter × part, run through the real generators, against the same envelope. Slow (minutes). |
| `turn-bench.js` | The same for turning: the insert nose rolled along the path in the (radius, Z) plane. |
| `sim-perf.js` | Timing only, on three real jobs at three of the grid sizes the app offers (medium, high, ultra). |
| `audit/harness.js` | Run in the page, against the real app: reads the CL an operation produced, sweeps its own cutter over its own grid, and compares what is left with the sample part as a formula. Shares no code with the simulator. |
| `audit/readback.js` | A second G-code interpreter, written without `post/parse.js`, to compare a posted file with the CL it was printed from. |
| `audit/sweep.js` | One table per strategy x cutter x real sample part: generation time, cutting and rapid minutes, the share of cutting that removes nothing (`air`), the radial width and chip area of the load (`w95`, `wMax`, `area99/max`), rapids driving the tool into standing stock (`crash`), and lifts. Finishing passes are run on the material an adaptive rough left and told about that rough, as the app does. `--air`, `--heavy`, `--set=key=value` and `--part=` narrow it. Plain `node`; nothing from the test suite. |
| `audit/draw.mjs` | Draws one Z window of one operation to a PNG, coloured by what each move removed (`ONLYAIR=1`, `TIME=1`, `AFTER_ROUGH=1`). The shape of a waste is visible where its count is not. |
| `audit/retract.mjs` | What an operation's rapids are made of: how many retract-cross-plunge sequences, how high each lifts above its own ends. |
| `audit/profile.mjs` | One generation, timed; run it under `node --cpu-prof` to see where the time goes. |
| `audit/rest-check.mjs` | A rough then a rest pass with a smaller cutter on one billet: what the pair removes (volume and a surface hash) and how long the rest pass is. Compare before and after a change to rest machining — equal hash, shorter program. `DRAW=out.png ZW=lo,hi` draws it, `BYZ=1` lists air by level. |

## Tangency

Every one of these has to deal with the same nuisance. A path running exactly
one cutter radius from a cell is *tangent* to the sweep — it removes a contact
of zero width — and toolpaths produce these deliberately and constantly, since a
contour is offset by exactly the radius and a facing pass is a row of parallel
lines on an axis-aligned grid. Whether such a cell counts as cut is decided by
the sign of a quantity that is exactly zero, so floating point answers it
differently from one cell to the next.

So the references answer twice, with a cutter a micron under and a micron over,
and only score the cells the two agree about. Without that, a finished wall
reads as a wall the simulation never touched, and the numbers are noise.

The simulator's own answer to the same problem is in `engine/simulate.js`: it
widens the cutter by a nanometre so that every tangency is decided the same way.
`sim-bench.js` reports how many cells were set aside for this, so it is visible
when it starts to be most of them.

## Where it stood

Taken on the sweep as it is now, at the `medium` grid:

```
worst disagreement with the swept envelope   0.016 mm   (61 strategy/cutter/part combinations)
mean disagreement                          < 0.001 mm
```

Before the sweep was solved rather than sampled, the same measurement read
2.4 mm worst and 0.007 mm mean — the error was all on ramps and plunges, and all
in the same direction: material left standing that the cutter had removed.
