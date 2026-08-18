# CNCAM

Browser-based CAM: import 3D models (STEP/IGES/STL/OBJ), define tools and
operations, generate G-code for 3-axis, 3+2, lathe, and simultaneous 5-axis.
Static site — no backend, no build step. See [PLAN.md](PLAN.md) for the full
development plan.

## Current status

Working pipeline (Phase 0 + Phase 1):

**Import** STEP/IGES (occt WASM worker, B-rep face grouping kept), STL, OBJ —
and DXF, which is not a solid and does not pretend to be one. A DXF comes in as
a *drawing*: polylines with their bulge arcs, circles, arcs, ellipses and real
B-splines (evaluated, not approximated by their control polygon), placed on the
billet by an origin, an offset, a rotation, a scale and a mirror. An engraving
pass drives straight down it, which is the only way to cut a logo, a part number
or a fold line — none of them are features of the part.

**A machine, not a post.** A post says how a move is *spelled*; a machine says
how far the table goes, how fast a rapid really is, what the spindle will turn
and how long a tool change takes. All four change what the app tells you: the
cycle-time estimate is measured with the machine's own rapid rate and its
tool-change time, and a program that will not fit the envelope, or that asks for
more rpm than the spindle has, says so in the setup panel before it is posted
rather than as a soft-limit alarm halfway through. Machines are editable records
in the project, with the posts as presets to build one from.

**Mill or lathe**, as a tab at the top of the window. Not a G-code flavour: a
lathe has its own operations, its own coordinates and a part that is a profile
rather than a solid, so the whole app switches with it — the strategies on
offer, the setups listed, the cutters in the library, the program that gets
posted. A project may hold both, because a shaft that is turned and then has a
flat milled on it is one part and two jobs, and switching machines hides
nothing: the other machine's work is there when you switch back.

**Tool library** — presets by cutter family (flat / ball / bull / drill /
chamfer & V bit / face mill / turning insert / boring bar / parting & grooving
blade / threading tool) with starting feeds and speeds, multi-select add, search,
and JSON import/export. Cutters you build or keep are saved in the browser under
**My tools** and can be deleted again. The library is a grid of cards rather than
a list of rows, because a tool is found by its shape and a row gives the shape
the least room on screen.

Every cutter is **drawn** — to scale, from its own numbers. A milling cutter gets
its shank, a gradient across the diameter because a cylinder has a lit side, and
flutes, because that is the difference between a tool and a rod.

A lathe tool is **not** drawn that way, because it is not that kind of object: it
does not spin, it has no flutes, and it is not a solid of revolution. Turning
tools are drawn from their real ISO insert geometry — the shape letter, the
inscribed circle and the nose radius, which are the three parts of a designation
like `TNMG160408` that are geometry. A T, a W and a C come out as a triangle, a
trigon and an 80° rhombus, which is how they are told apart on the shelf. Typing
the code fills the fields in. See `src/engine/insert.js`.

**Tools come from a wizard**, not from a blank form — and go back into it. Pick
the shape first: it decides which of the remaining questions exist, so a turning
insert is never asked how many flutes it has and a boring bar is asked the
smallest hole it fits down. Speeds and feeds are computed from the family and the
diameter as you type, calibrated against the hand-tuned presets, because a Ø1
cutter and a Ø20 cutter want spindle speeds two orders of magnitude apart.
**Edit in the builder…** on an existing cutter opens the same dialog on it, with
everything already decided about it left alone — a speed somebody measured is
worth more than any formula, so only a change of *family* re-derives one.

Alongside the fields, the two numbers the speeds are actually judged by:
**surface speed and chip load**. RPM and mm/min are what the control wants and
neither says whether the cut is sane — 10000rpm is fast for a Ø20 and slow for a
Ø1 — while `188 m/min, 0.03mm per tooth` has the cutter's size in it already.
The same panel names what will not work: a corner radius bigger than the cutter,
a bar that cannot enter its own minimum bore, a plunge feed above the cutting
feed. Those checks live with the tool rather than with the dialog, so the
properties panel makes them too; a test asserts that none of the presets trips
one, because a warning that fires on sane tools is a warning nobody reads.

**Setup** — raw stock as an auto box with margins, an explicit box, round bar, or
**hollow bar**, which is what most turned parts over about 40mm actually come out
of; plus **orientation**: how the part is fixtured (rotation, with presets for
the usual flips) and which corner of the stock the controller calls zero.
Everything downstream works in that frame, so the viewport, the toolpaths and
the G-code all agree, and the setup's work offset (G54…G59) is posted.

A lathe setup arrives holding **bar**, sized to the part it will be cut from:
the swung diameter plus a millimetre, a millimetre proud of the free end so
there is something to face, and a chucking allowance behind it so there is
something to hold. Nobody cuts a part out of a bar its own length, and a setup
that starts that way is five operations all warning that the chuck is in the
way. **Fit to part** buttons under the diameter offer the exact size, a light
skim, and the next standard bar size up.

**Operations** — nineteen strategies, grouped by the stage of the job they
belong to. Milling: facing; **Z-level** and **adaptive** roughing; 2D **contour** and
**pocketing**; **drilling** with automatic circular-hole recognition and
**helical boring**; **chamfering** and **engraving**; **3D parallel finishing**
(drop-cutter over a rasterised heightmap, so ball and bull noses ride real
curved surfaces) and **waterline finishing** (level contours, the complement of
a raster: best where a raster is worst). Settings cover ramp entries,
**lead-in/out** (arc or tangent), climb vs conventional, raster pattern and
angle, finish passes, **holding tabs** for contour, and stock to leave.

Turning, in the order a turned part is actually made: **face the end**; **centre
drill** down the axis; **bore** an existing hole out to the inside profile;
**rough** at a constant depth of cut; **finish** in one pass down the profile
with the insert's nose radius compensated for; **groove** to a width and a
floor diameter; **thread**, single-point, with the depth shared out so every
pass removes the same area of metal rather than the same depth; and **part off**
with pecks.

**Workholding on a lathe is a chuck**, not a clamp with a round footprint. What
a chuck takes away is not a patch of the table but everything past a Z — the
tool comes in from the side, so material in front of the jaws is reachable at
any radius and material behind them at none. Turning passes stop at the jaws and
say so, rather than being generated as asked and found out at the machine.
Gripping a bore instead of an outside diameter inverts that: the outside is
clear and the bore is blocked.

Heights can be typed or **snapped**: the top of the part, the bottom of the
billet, and the two in between are all numbers the app already knows, and
finding them by hand meant reading them off a summary or generating twice to
see whether the pass reached the floor.

**Picking a strategy is a decision, not a dropdown.** A list of names in a select
box is no help with the choice that every other setting hangs off — `clear2d`
and `adaptive` both read as roughing, `parallel3d` and `waterline` both read as
finishing, and the difference in each pair is the whole point. "+ Add operation"
opens a card per strategy, grouped by stage, each with a schematic of the cut it
makes, what it does, when to reach for it and the cutter it expects. The same
picker changes an existing operation's strategy, and the operation panel shows
the current one as a card rather than as an entry in a list. The tree draws the
schematic on every operation row, so a job reads as a sequence of *cuts* rather
than of names somebody typed.

**A new operation arrives able to do its job.** It used to be given whichever
tool was first in the list, which is right once and wrong for everything after
it: a chamfer holding a flat end mill cannot cut at all, and a 3D finishing pass
holding one comes out visibly stepped and says nothing. Each strategy now states
the cutter families it wants, and the first suitable one in the rack is
assigned — biggest for roughing and facing, smallest for finishing and
engraving, never a drill for anything that mills. See `src/engine/tool-match.js`.

**Chamfering.** The pass nobody models and everybody cuts. You give the width of
the flat you want on the edge; the depth falls out of the cutter's point angle,
which is where the arithmetic actually lives — a 0.5mm chamfer is 0.5mm deep
with a 90° mill and 1.87mm deep with a 30° V bit. The tip is held a settable
clearance below the bottom of the chamfer so the flat on the end of the cutter
never rubs the wall underneath, and the axis steps out to match, both of which
fall straight out of the cone geometry (`src/engine/strategies/chamfer.js`).
Which side of a boundary the tool runs is not asked, because it is not a choice:
the outline is chamfered from outside it and a hole from inside it. Top Z is the
*edge being broken*, so one operation breaks one edge plane; a stepped part
wants one per step. Wide chamfers can be taken in several passes, each cutting a
slightly wider chamfer than the last.

**Boring.** Drilling gets you a hole the size of the drill. Everything else —
a hole bigger than any drill in the rack, or one that has to be round and on
size rather than roughly where the drill wandered — is milled, and a milled
round hole is a spiral. The cutter never plunges: it enters on the helix, at
whatever pitch you allow, and the path that gets it to depth is the path that
cuts. Holes come from the same recognition drilling uses, so an operation can be
pointed at "every hole this cutter fits inside". Boring from solid steps out
from a first pass that sweeps the centre; tell it what has already been drilled
and it only opens the wall out.

**Engraving.** Every other milling strategy offsets the path by the cutter's
radius, because every other strategy is cutting a surface the part keeps.
Engraving is not — the line *is* the feature, and any compensation puts the mark
in the wrong place. With a V bit the depth is also the width, and machinists
think in the width they want to see, so the operation takes either: a depth, or
a line width it converts through the cutter's own point angle.

**Lathe turning.** A setup is milled or turned, and a turned one machines a
*profile* rather than a solid: the largest radius at each point along the
spindle axis, taken as the envelope of the part so a hex bar or a part with a
flat on it still turns to the shape that contains it. Four operations — face the
end, rough down to the profile at a constant depth of cut, one finishing pass
offset by the insert's nose radius, and part off with pecks. The **Lathe post**
writes `G18 G7`: X words are **diameters**.

That last point is the whole design. Everything inside CNCAM holds X as a
radius, because that is what the geometry is; exactly one function doubles it,
in `src/post/lathe.js`, and a test asserts that every X word in a lathe program
is twice a radius the toolpath actually visits and that the milling posts are
untouched. Get that boundary wrong in either direction and the part comes out at
half or twice its size with no other symptom.

Nose compensation is the other one worth naming: an insert touches the work on
its nose, not at the point the drawing calls the tip, so a finishing pass driven
straight down the profile cuts every face a nose radius short and every diameter
a nose radius deep. The profile is offset along its own normal before the pass
is emitted, and the operation says which of the two it did.

Material simulation is not the milling one with different words either: a Z-up
height grid cannot describe a spinning bar. A turned part is a *radius for every
Z*, because every angle sees the same tool, so it gets its own model — an outer
radius and a bore, in the same event log and the same timeline.

**Which outline a contour follows.** The silhouette at a depth is the shadow of
everything *above* it, so on any part whose footprint is not constant the
outline changes every level — on the sample clamp the top pass is a 29×29 loop
and the bottom one 78×80. Following those has the cutter carving a groove
through the middle of the billet for the first passes and only reaching the
outside at the bottom: a clearing pass wearing a contour's name, and it reads
exactly like "it wants to machine everything". So the outline is a choice, and
the default is the one people mean — **one outline, the shadow of the whole
part**, cut at every level, which is a slot down the outside that never enters
the part's footprint at any depth. Per-depth profiles are still there for a
stepped prismatic part, where each level really is a different outline.

**Cutting a part out.** Contour also asks which profiles it should follow and
which side of them to run: by default the *outer* profile only, which is what
"cut this part out" means. Following every profile is still there, but it is a
choice — it used to be the only behaviour, so a cut-out also sent the cutter
down every bore on the part. Tool side (outside / inside / on) decides whether
the pass leaves the profile standing, opens it up, or drives straight down it.

**Holding tabs.** Tab width is the width of the bridge left standing in the
part. The cutter lifts over that plus its own diameter, because a round cutter
removes material for a radius either side of its centre — lifting over exactly
the tab width leaves `width − diameter` of material, and nothing at all for any
tab narrower than the tool. A 3mm tab with a 6mm cutter was 3mm in the settings
and 0mm in the part.

Each tab is a flat-topped bridge: the tool steps vertically up at the near edge,
runs level across, and steps down at the far edge. Emitting one point per
boundary instead made the tool climb diagonally across the whole tab, leaving a
wedge that reached full height at a single point. Tabs are placed between entry
points rather than on them, are left standing by every pass that would cut
through them (so a tab taller than one stepdown still holds), and their top is
one plane above the profile floor rather than a height above whichever pass is
running. The Tabs panel reports the holding area and how far the tool lifts.

**The stepdown holds all the way down.** A depth pass only removes what the
level above it left, so the tool rapids to just above that level — the *entry
gap* — and feeds one stepdown. Entering from a fixed plane turned the last pass
of a 30mm profile into a single 32mm plunge: the stepdown honoured by the
cutting levels and thrown away by the entry.

A new operation is created *for its strategy*: "+ Add operation" asks which one,
and the parameters that arrive with it suit that cut. Heights come from the
stock and the model — a facing pass reaches the top of the part, not the bottom
of it — and the stepping comes from what the strategy is for and how big the
cutter is: a roughing stepdown is a fraction of the diameter, adaptive takes a
deep pass with a light radial bite, and a finishing stepover is a cusp height
rather than a fraction of the tool. Changing the strategy afterwards brings the
new strategy's stepping with it and leaves the heights, tool and feeds alone.
Operations can be duplicated and reordered (order is machining order).

**Clamps and jaws.** A setup carries keep-out areas — rectangular jaws, round
clamps — that every operation in it machines around. Machining regions are
picked off faces of the *model*, which cannot express the commonest keep-out
there is: a clamp is not in the CAD file at all. Clamps are drawn in the
viewport in the same colour as their tree rows, positioned in setup
coordinates, and can be toggled off to see what the program would be without
them. See `src/engine/fixtures.js`.

**Raw stock is a size, not a coordinate pair.** A billet is width × depth ×
height plus where the part sits inside it. It used to be two absolute corners,
which is how the code wants it and the worst way to ask a person: a part
authored at (-250, -540) gave you fields reading "X min -250.4, X max -171.2".
The panel says what the billet works out to and warns when the part sticks out
of it.

**Stale results.** A toolpath is computed once and drawn until something
replaces it, so the moment you change a stepdown the picture on screen is the
*old* path and nothing said so. Every operation now carries a fingerprint of
what it was generated from; when the settings move past it the row shows ↻ and
the panel says the viewport and the G-code are out of date. A **Program**
summary on the setup lists the operations in machining order with their tools
and times, so a job reads as a sequence rather than as a pile of settings.

**Problems before the wait.** Checks that can be made from the settings alone —
a stepdown deeper than the cutter's flute, tabs that would run into each other,
a drill operation holding an end mill, a flat cutter on a 3D finishing pass — are shown
while the settings are on screen, instead of after a generate that produces
nothing.

**Results, not silence.** Every strategy can say why it produced nothing —
"pocket found no enclosed region", "no hole matches ⌀6±0.5 — this part has ⌀4.50
×3, ⌀30.13". Those diagnoses used to be G-code comments, which is the one place
a user staring at an empty viewport will never look. They now ride on the
generated program (`cl.notes`) and appear on the operation: a badge in the tree
showing cycle time, or a "!" when the pass cut nothing, and a **Result** section
in the properties panel with move count, cut distance, deepest Z, estimated time
and the warnings themselves. Generation reports the same thing in the status bar
by name.

**Speeds & feeds** — a tool carries its home RPM and feeds; an operation may
override any of them and inherits the rest. The panel shows derived numbers
(surface speed in m/min *and* sfm, feed per tooth) so a machinist can tell
whether the settings are sane rather than guessing.

Parallel finishing offers a **follow-slope** pattern: instead of straight passes
at a fixed angle, it runs evenly-spaced streamlines of the surface's steepest
descent, so the tool goes *down* a slope rather than across it. Spacing uses
Jobard–Lefer seeding — each accepted streamline offers seeds one stepover off
its flanks — because seeding on a lattice leaves gaps far wider than the
stepover, which in a finishing pass means uncut material.

**Simulation** — see below.

**Project persistence** — tools, setups, operations and their parameters
autosave to localStorage and come back on reload, along with the meshes when
they fit. A **Clear** button discards everything and starts over.

**A new model is usually a new part.** Importing one into a project that already
has a job in it offers to clear the setups and operations first, because they do
not come with it: the stock was measured off geometry that has gone, the datum
is a corner of that stock, and every operation's heights and picked faces were
chosen on a part that is no longer in front of you. None of that announces
itself — it generates, it posts, and it is wrong. Offered rather than done: an
assembly is a real thing, Cancel leaves the project exactly as it was, and
clearing is one Ctrl+Z. A project restored *without* its geometry is never
asked — that import is the repair, and the setups are what survived.

**Height gizmos** — the selected operation's top, bottom and clearance planes
are draggable in the viewport, so depths are set by putting them where they go
rather than by typing numbers. Typed or dragged, the four heights are kept in a
machinable order (clearance above the feed plane, above the top of the cut,
above the bottom): raising the top lifts the planes above it out of the way, and
an edit that cannot be honoured is refused with the reason rather than clamped
to a cut a micron deep. See `src/engine/heights.js`.

**Getting around** — `?` (or the toolbar's `?`) lists every key the app answers
to and the order a job goes together in. Both come out of one table
(`src/app/shortcuts.js`), so a key that is bound is documented and a key that is
documented is bound. `F` frames everything; `Ctrl+G` generates; `S` simulates;
`A` adds an operation; `H` hides the selected operation's path; `Ctrl+D`
duplicates it; `Delete` removes it, asking first when the deletion reaches
further than the row you clicked — a setup takes its operations with it, and a
deleted tool leaves every operation that used it unable to generate. Undo and
Redo grey out when there is nothing to do and name the edit they will act on.

**Getting to a program is a checklist.** Import a model, pull a cutter, check
the stock, add operations, generate — ticked off as each is done, with the step
you are on as the button that does it. It stands down once there is a program,
and it can be folded away before that.

It sits at the top of the project tree, not over the viewport. A panel that
explains the app by covering the thing you are working on is a bad trade after
the first thirty seconds, and the one thing a new user needs to see after
importing a model is the model.

**Which way is which.** The axes are drawn as labelled arrows, sized to the job,
and a triad in the corner of the viewport holds the orientation when the part
fills the screen and the origin is off it — three coloured lines meeting at a
point are a convention you have to already know, and a convention you have to
already know is not a label. Named views (Top, Front, Right, Iso…) are one
button each, because orbiting to "square on from the front" by hand is a game of
degrees and getting it *nearly* square is worse than useless.

**A lathe is not a mill seen from another angle.** On the lathe tab the grid
stands down — there is no table to put one on — the spindle axis is drawn
instead, and the viewport opens looking at the plane the tool actually works in:
Z running left to right along the bar, X up the cross-slide, which is how every
turned drawing in the world is laid out. The named views change with it: a lathe
is offered the three that mean something rather than six faces of a box it does
not have.

**Seeing one path at a time.** A finished job is eleven overlapping paths in one
colour, and the only way to check one of them is to look at it on its own. Every
generated operation carries a visibility toggle in the tree (Alt-click to show
only that one, `Shift+H` to bring them all back). Hiding is a *view* filter, not
an edit: the operation is still generated, posted and simulated, it does not
land on the undo stack, and it does not read as disabled. Operations are dragged
to reorder, because machining order is program order and doing that through a
context menu two clicks at a time is how orders stay wrong.

**Machining regions** — click faces in the viewport to mark them *machine only
here* or *never machine here*; regions are grown by the tool radius so the
cutter stays off them, and the picks are shown as coloured overlays.

**Drilling** scans a depth range rather than a single slice under the top face,
so a hole that starts in the floor of a pocket or on a step is found — and the
scan measures how deep each one goes, so blind holes of different depths are
each drilled to their own floor instead of all to one Bottom Z. When nothing
matches the drill, the operation reports the diameters the part *does* have.

**Speed.** Generating a ten-operation program took nineteen seconds, of which
about one was arithmetic: the worker pool spawned a worker per job and they
fought each other to compile the same engine module graph. Measured, a *trivial*
job on a cold worker takes 2.1 seconds and 5 milliseconds on a warm one. The
pool is now capped well below the core count and warmed at boot, so the
compiling happens while you are importing a model. **19.0s → 1.8s.**

Simulation went **3.0s → 0.34s** on the same program, from two things in the
innermost loop — it runs once per grid cell per move, tens of millions of times.
The current feeds were found by re-scanning every event on every move, which is
quadratic in the length of the program; and each cell allocated a three-element
array to iterate its sample points. A cursor, an unrolled loop, squared distance
comparisons, and an early-out for cells already below anything the move can
reach. Scrubbing 21 full-range seeks over 3.3M events costs 129ms.

**Output** — generation in Web Workers → viewport backplot + time estimate →
**LinuxCNC post** (T/M6, G43, G81/G82/G83 canned cycles, G80), GRBL (drills
expanded long-hand, dwells as G4) or **Lathe** (G18 G7, X in diameter, T0101,
G97) → G-code preview panel with click↔viewport
cross-highlighting → export `.ngc`. Undo/redo throughout; project save/load with
v1→v2→v3 migration.

**Arcs, including the ones that descend.** CL data is linear — every curve
reaches a post as a polyline, because that is what keeps the strategies, the
simulator and the verifier honest about one geometry — so the post looks back
over each run and asks whether it lies on a circle, within tolerance both of the
fitted radius *and* of the bulge each chord would gain. Runs may also descend: a
`G2/G3` with a Z endpoint is helical interpolation, which is what a bore or a
ramped boss actually is. Fitting only flat arcs left the case where this matters
most untouched — a bore posted as thousands of `G1` blocks on a path that is a
handful of instructions. A ⌀30 bore now goes from 593 motion blocks to 36. The
extra condition is that Z advances in proportion to the swept angle, so a pass
whose Z rises and falls over a form stays as lines rather than having the
controller run the Z straight through it.

Next: pencil finishing, thread milling, and 3+2.

### Simulation

Watch the stock get cut away, with a timeline you can scrub both ways, play at
0.25×–50×, and step move by move. The stock is drawn as a solid billet — a top
height grid skirted down to the stock bottom and capped — with raw and machined
surfaces coloured differently and the cutter shown at the playhead. Shaded
from averaged normals, so a machined face reads as a face rather than as a
field of triangles — the step between two passes is a step in the *geometry*
and survives it, while the grid's own facets do not. (Facet shading is still
one switch away in Options, for anybody who wants to see the cells.)

The cutter's position comes from the wall-clock time on the playhead, not the
current step's end position — so a rapid moves at a real (settable) speed
across the screen instead of teleporting to its arrival point. Cells that get
cut down to the stock bottom drop just below the base cap, which reads as a
through-hole rather than z-fighting with the base.

**And what the cut asked of the cutter.** A shape cannot show that: a pass that
takes a tenth of a millimetre and one that takes the whole diameter leave the
same floor behind, and only one of them arrives at the machine in one piece. The
same sweep that carves the billet counts, per step, how wide a bite was taken and
how deep — so the transport says `1.00×D at 2.9mm deep`, names the operation it
happens in, says how far of the whole program is cut at more than three quarters
of the cutter's width, and takes you to the moment when clicked. Entries are not
counted: a plunge, a ramp and the circle a seeded peel bores are full width by
nature and the ramp angle governs them, so counting them would report every
program in the app at 1.00×D and say nothing about any of them. On a lathe there
is no radial width to hold anything to — the tool is a corner, not a disc — so it
reports the depth of cut instead.

Detail and the rapid rate come from two different places, on purpose. How
finely the stock is gridded is a *preference* — how good do you want it to
look, how long will you wait — so it is in Options with the rest of them. How
fast a rapid actually travels is a *fact about the machine*, so it is on the
machine record and travels with the file.

Cutting a height grid in place only ever runs forwards — scrubbing back would
mean replaying from the start every frame. So `src/engine/simulate.js` records
an event log instead: every cell drop stores its new *and* previous height, in
step order. Seeking anywhere is applying or undoing the events in between, so
reverse is exact and costs the same as forward.

**What one cell gets is solved, not sampled.** For a given cell and a given
move, the question is the lowest the tool's surface ever gets directly above it,
which is a one-dimensional minimum along the move. Both terms of it are convex,
so the answer is at one of three places: where the cell comes under the cutter,
where it leaves, or one turning point between them — and the first two are the
roots of a quadratic, so all three are arithmetic rather than search.

Sampling instead is a trap worth naming, because it looks right. Taking the two
*ends of the move* plus the closest approach gives the exact answer on a level
cut, which is most of a program, so roughing came out perfect and nothing looked
wrong. On a ramp those are not the same three points at all: a cell is deepest
at the last instant it is still under the descending cutter, and that instant is
in the middle of the move, where nothing was looking. A 15° ramp entry simulated
0.8mm shallow and a plunging ball nose 2.4mm — always in the same direction,
always showing material standing that the cutter had taken off, and shaped like
a ridge down the middle of the cut.

Measured against a brute-force sweep of the same toolpath, across every strategy
and cutter shape, the surface now agrees to within 0.016mm — and the exact
version is *faster* than the sampled one, because the discriminant that gives
the two contacts also says which cells are not touched at all, and that throws
out the corners of every bounding box before any work is done on them. See
`bench/` for the harness and the numbers.

The playhead is held in **seconds**, and the step is derived from it. Never the
other way round: steps are coarse in time (one plunge can run for seconds), so
re-deriving the clock from the current step snaps it back to that step's start
every frame and playback freezes. `PlaybackClock` exists to keep that honest and
is covered by a test that runs 12 simulated seconds of frames.

**Turning simulates too**, and it is the same machinery one dimension down. A
milled part is a height for every (x, y); a turned one is a pair of radii for
every z — the outside and the bore — because the work is spinning and every
angle sees the same tool. So the surface is two lines, the cells are Z samples,
and the event log, the playback cursor and the timeline are unchanged. Cutting
pulls a ring inward; boring and drilling push one outward, which is the same
event with the sign the other way and is why a drill leaves a visible hole
rather than nothing at all.

Three things about it are worth stating, because each was wrong once and each
looked like a different bug:

- **The metal comes off where the tool is.** A turning pass is *one* CL move
  sixty millimetres long, so recording one event step for it made the whole
  length of bar vanish on a single frame — a picture of a diameter changing, not
  of turning. The simulator walks each move in pieces and records a step for
  each, while the program keeps the single move that belongs in it. Emitting
  sixty G1s where one is correct would have been the wrong place to fix it.
- **The work spins.** A smooth cylinder rotating about its own axis is
  indistinguishable from one standing still, so the metal carries a faint
  circumferential shading with a witness line in it, and the rotation is a
  function of the playback clock — scrubbing back and forth lands the same way
  every time.
- **The tool is on the right side of the cut.** The holder used to be drawn
  toward −Z, which is the direction a right-hand tool *travels*, so it was
  permanently buried in metal the tool had not reached yet. A right-hand tool
  trails toward +Z, through metal it has already removed. And an insert is a
  flat plate lying with its rake face up: its outline is in Z and Y, and the only
  thing it occupies radially is its own thickness. Standing that outline up in
  the ZX plane — which is the tempting reading of "the plane the tool moves in" —
  gives an insert twenty millimetres tall in the one direction it has five, so
  half of it is inside the bar at all times. A parting blade is the other way
  round, and gets the other placement, because its depth genuinely is radial.

This is also the end-to-end check on turning. `turning.test.js` runs whole
programs through the simulator and measures the finished bar against the model,
which is how the nose-radius convention got settled: two strategies can each be
internally consistent, agree with every assertion about their own toolpath, and
still disagree with each other by 0.4mm.

### Threading, and what a lathe feed is

Threading passes are marked as **spindle-synchronised** and the lathe post
writes them as `G33` with the pitch as `K`. That is not a formatting
preference: the carriage has to be locked to the spindle encoder, because a
thread fed at a rate that works out about right starts every pass a little
further round the bar and destroys the form. A post with no synchronised motion
refuses to pretend — it writes a warning into the file instead of a `G1`.

A lathe feed is **per revolution** (`G95`), which is what keeps the chip the
same thickness at every diameter and what the figure on the insert box means.
CNCAM holds mm/min throughout and the post divides by the spindle speed, in one
place. And the spindle can hold a **surface speed** (`G96`) rather than an rpm,
with the maximum-rpm clamp that is not optional — as a facing cut reaches the
centre the commanded speed goes to infinity.

### Reachability

Toolpaths are planned against the part's **downward silhouette** — the union of
its cross-sections at and above the current depth — not against the bare slice
at that depth. A vertical cutter is blocked by everything above its tip, so
under an overhang the slice is small while the real obstruction is large;
planning from the slice alone puts cuts where the tool can never reach. See
`src/geom/silhouette.js`. The 3D strategies enforce the same thing through the
drop-cutter in `src/geom/heightmap.js`, whose heightmap is deliberately
conservative (dilated by one cell) so rasterisation can never invite the cutter
into the part.

## Run

Serve the folder with any static server (workers/WASM don't load from `file://`):

```
python -m http.server 8123
# or: npx serve
```

Then open http://localhost:8123 — and http://localhost:8123/test.html for the
unit tests. Headless tests: `node src/test/node-run.js`.

## Layout

```
index.html          app entry (import map for vendored three.js)
test.html           in-browser unit test runner
vendor/             pinned static dependencies (three.js, occt WASM) — see vendor/README.md
src/
  app/    UI shell: layout, project tree, main wiring, keyboard table,
          strategy catalogue + picker, and props/ (the properties panel, split
          into the shared field renderer, the read-outs, the setup panel and
          the operation panel) and actions/ (setup space, program, files,
          editing)
  view/   three.js viewport (Z-up scene, model display, framing), labelled axes
          and the corner orientation triad, named views (plain data, so the
          toolbar can offer them without pulling three.js in), height gizmos,
          removal simulation display
  io/     file pickers, STL/OBJ parsers, DXF parser (2D drawings: polylines,
          arcs, bulges, ellipses and real B-splines), STEP/IGES via occt worker
  doc/    project schema, document model, undo stack, machines (travel, rapids,
          spindle range and dialect — the thing the program actually runs on)
  geom/   vector math, mesh utilities, slicing, clipper wrapper, silhouette
          (reachability), heightmap + drop cutter, coverage raster, crease
          shading (display normals + edges), face grouping — UI-independent
  engine/ CL data (canonical toolpath format), collinear merging, tool geometry
          (one silhouette, drawn in 2D and revolved in 3D), turning inserts
          (ISO shapes, drawn and extruded — a lathe tool is not a solid of
          revolution), lathe profiles inside and out, setup orientation, stock,
          clearance/entry heights, per-strategy operation defaults, fixtures
          (clamp keep-outs), leads/linking + pass ordering, machining regions,
          drawing placement (where an imported DXF sits on the billet), removal
          simulation, and strategies/
  workers/ worker pool + job worker, occt import worker
  post/   G-code post engine (Phase 1)
  test/   unit tests (browser + node; ui.test.js runs in the browser only)
```

## Conventions

- Internal units are **millimeters**, coordinates are **Z-up**; conversion only at UI/post boundaries.
- **Mill and lathe are two machines, not two posts.** `doc.machine` scopes what
  the app is looking at and `doc.setups()` is the only way to reach the setups
  of the one in front of you; everything downstream — generate, backplot, post,
  simulate — goes through it, so a lathe program can never end up in a milling
  file.
- A turning CL point is the **centre of the insert's nose radius**, exactly as a
  milling CL point is the centre of the cutter rather than a point on its edge.
  Every turning strategy compensates in Z *and* in X and the simulator rolls a
  circle of that radius along the path. Roughing once compensated the Z and not
  the X while finishing did both: the program read correctly and every diameter
  came out a nose radius oversize.
- The **display** normals of a model are not its mesh normals. `geom/shading.js`
  averages faces together only where the angle between them is gentle enough to
  be one surface, and draws the rest as lines. Averaging unconditionally — which
  is what `computeNormals` does, correctly, for the geometry pipeline — shades a
  machined block and a beach ball identically.
- Resampled paths are for the **computation**, not for the machine.
  `cl.simplify(mergeTolerance(tolerance))` merges collinear runs on the way into
  the CL data; half the tolerance is spent there so the post's arc fitter still
  has budget to put a circle back together.
- The compute core (`geom/`, `engine/`, `io/` parsers) never imports three.js or touches the DOM — it must run headless in workers and Node.
- All document mutations go through undoable commands on `Document`.
- Every strategy emits **CL data** (`src/engine/cl.js`) — position + tool-axis vector; posts and the simulator consume only that.
- New test files: add to `src/test/all.js`.
- A tool has **one** description of its shape. For a milling cutter that is
  `engine/tool-geometry.js`, a silhouette of sections from the tip up: the icons
  mirror it, the viewport revolves it, the reach checks evaluate it. Three
  descriptions is how the viewport ended up drawing a plain cylinder for every
  cutter in the rack.
- **A lathe tool is not a milling cutter and does not go through that path.**
  It does not spin, it has no flutes, and it is not a solid of revolution, so
  revolving a silhouette gives a grey cone for every insert in the drawer.
  `engine/insert.js` describes it the way ISO does — a shape letter, an
  inscribed circle, a nose radius — and the icon, the panel preview and the
  solid in the simulation are all that one polygon at three sizes. Nothing
  fabricates a collet shank or a spindle holder for it either; it has neither.
- On a lathe, X inside CNCAM is a **radius** and X in the G-code is a
  **diameter**. `post/lathe.js` is the only place that converts, and
  `turning.test.js` asserts it — in both directions, because a second doubling
  is as wrong as none.
- **Inside and outside are opposite in every direction.** An external tool
  retreats to a large radius and a boring bar to a small one; roughing works
  inward on the outside and outward on the inside; a chuck blocks the OD and
  leaves the bore alone when it is gripping that bore. Every helper in
  `strategies/turning.js` takes the side as an argument rather than assuming
  external — assuming external is how a boring bar retracts through the wall it
  has just cut.
- Lengths a user can edit are held to a **micron** (`roundMicron`, in
  `app/props/fields.js`). A micron is the resolution of the machines this writes
  for, and anything past it is float noise wearing the clothes of a measurement:
  a diameter derived from a bounding box comes back as `25.400000000000002`,
  which reads as a number somebody chose.
- A new strategy is not done when it generates. It needs an entry in
  `OP_TYPES`, a label, a catalogue card (`src/app/op-catalog.js`: what it does,
  when to reach for it, the cutter it expects, an icon), defaults in
  `op-defaults.js`, a preferred cutter family in `tool-match.js`, and its
  parameters in `op-params.js`. `workflow.test.js` fails on any of those being
  missing, because a strategy the picker cannot describe is one nobody will
  choose.
- Anything that is only true when a real pointer presses a real element belongs
  in `ui.test.js`, which no-ops under Node. A menu whose handler is correct and
  whose button is removed before the click lands is not a logic error and no
  amount of unit testing finds it — `test.html` loads the app stylesheet for the
  same reason, since an element's geometry is its CSS.
- A strategy is reachability-correct or it is not shippable. When adding one,
  test it against `makeMushroom()` (an overhanging cap) — the fixture exists
  because a bare slice passes every flat-part test and still cuts air under an
  overhang.
- Also run it against `samples/clamp1.stl` via `real-model.test.js`. Synthetic
  fixtures are clean in ways real exports never are: exactly vertical walls,
  exactly meeting vertices, unions that collapse neatly. Anything that unions
  polygons repeatedly needs sliver control (`cleanLoops` + a minimum area), and
  only a real mesh will show you that.
