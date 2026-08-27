# CNCAM

A CAM program that runs in your browser. You load a 3D model, tell it what tools
you have and what cuts you want, and it writes G-code.

### ▶ Try it now: **[gamerpaddy.github.io/CNCAM](https://gamerpaddy.github.io/CNCAM/)**

No install, no sign up, nothing sent anywhere. That link is the current `main`
branch running in your own browser, and it is the whole application rather than
a cut down demo. Load a model from [samples/](samples/), or one of your own.
The test suite runs there too, at
[/test.html](https://gamerpaddy.github.io/CNCAM/test.html).

**Read the warning below before you point any of the output at a machine.**

---

# ⚠️ THIS IS AN EXPERIMENT. IT IS NOT FINISHED.

## **DO NOT RUN THE OUTPUT OF THIS PROGRAM ON A REAL MACHINE WITHOUT CHECKING EVERY LINE OF IT FIRST.**

**This is a hobby project and a work in progress. It has never been validated
against a real machine tool by anyone. It may not work at all. It may look like
it works and be wrong in ways you will not notice until the spindle is already
moving.**

**G-code from an untested CAM program is dangerous. It can drive the tool into
your fixture, your vise, your table or your workholding. It can break cutters,
throw parts, wreck a spindle and injure you. The simulation in this app is a
drawing, not a promise: if it is wrong about the geometry then it is wrong in
the picture too, and it will happily show you a clean cut that is not one.**

**Before anything touches metal: read the file, backplot it in your controller,
dry run it above the work with the Z offset raised, and keep a hand on the feed
hold. If you do not know how to do those things, this program is not for you
yet.**

**There is no warranty of any kind. If you use this and it destroys your
machine, ruins your part, sets fire to your workshop or burns down your house,
that is on you.**

You have been warned. With that out of the way:

---

## Contents

* [What it does](#what-it-does)
  * [Getting a part in](#getting-a-part-in)
  * [Milling operations](#milling-operations)
  * [Turning operations](#turning-operations)
  * [Tools](#tools)
  * [Machines](#machines)
  * [Everything else](#everything-else)
* [What it does not do](#what-it-does-not-do)
* [Running it locally](#running-it-locally)
  * [Tests](#tests)
* [Licence](#licence)
* [More detail](#more-detail)

## What it does

CNCAM covers the middle of the CAM workflow: model in, program out. It does not
model parts and it does not talk to machines.

**Milling and turning are separate machines in the app**, not two spellings of
the same program. A lathe has its own operations, its own coordinates and a part
that is a profile rather than a solid, so switching machine switches the whole
app with it. One project can hold both, because a shaft that gets turned and
then has a flat milled on it is one part and two jobs.

### Getting a part in

STEP and IGES (through a WebAssembly build of OpenCASCADE, with the B-rep faces
kept separate so you can pick a real face instead of a triangle), plus STL and
OBJ.

DXF comes in as a *drawing* rather than a solid: polylines with their bulge arcs,
circles, arcs, ellipses and B-splines, which you then place on the billet and
engrave. That is how you cut a logo, a part number or a fold line, none of which
are features of the part.

### Milling operations

| Group | Operations |
|---|---|
| Prepare the stock | Face |
| Roughing | Adaptive rough, Z-level rough |
| Profiles | Contour, Pocket, Slot |
| Holes | Spot drill, Drill, Tap, Thread mill, Helical bore |
| Edges and marking | Chamfer, Engrave |
| 3D finishing | Parallel finish, Waterline finish |

Roughing is stock aware and can rest machine against what an earlier operation
already took off, so the finisher is not cutting air for an hour.

A hole is finished, not just made: spot the centres so the drill starts where it
was told, drill them, and then either **tap** them — rigid tapping, spindle
locked to the feed, and it looks for the *tapping drill* because an M6 goes in a
⌀5 hole — or **thread mill** them, which needs no rigid tapping and no tapping
head, does every diameter of one pitch with one cutter, and comes back out of
the hole when it breaks. The spot depth is not typed: it is a cone of the
cutter's own point angle, sunk until it is as wide as you asked.

### Turning operations

Face the end, rough turn, finish turn, groove, thread, centre drill, bore, and
part off. Turning tools are described the way ISO describes them, by shape
letter, inscribed circle and nose radius, so typing `TNMG160408` fills in the
geometry and the app draws the actual insert rather than a generic cone.

### Tools

A library of cutters organised by family (flat, ball, bull nose, drill, chamfer
and V bit, face mill, turning insert, boring bar, parting and grooving blade,
threading tool), each with starting feeds and speeds. New tools come from a
wizard that asks only the questions that apply to the shape you picked. Every
cutter is drawn to scale from its own numbers. Your own tools are saved in the
browser, and the whole library imports and exports as JSON.

### Machines

A machine is a record you can edit, not just a G-code flavour: travel limits,
rapid rates, spindle range and tool change time. Those numbers do work. The
cycle time estimate uses the machine's real rapid rate and its real tool change
time, and a program that will not fit in the envelope, or that asks for more rpm
than the spindle has, tells you in the setup panel instead of as an alarm
halfway through the job.

A milling machine can also carry **rotary axes**, and they do two different
jobs. Set a setup to **Wrapped** and give it a bar diameter, and the program you
write flat — against the cylinder's surface unrolled, a sheet π×⌀ wide — is bent
round the rotary axis on the way out: Y millimetres along the sheet become A
degrees round the bar. That is how a spline, a scale round a dial or a name down
a tube gets cut, none of which lie flat at any angle. It posts as lines with
inverse-time feed, because F is millimetres a minute on a linear move and
degrees a minute on a rotary one and no control can tell which a block meant.

Or, for indexed 3+1 / 3+2 work, pick a configuration under *Machines → Rotary
axes* (a 4-axis A, or a 5-axis A/C or B/C trunnion), set a setup to **Indexed**
and rotate it to the face you want: the machine swings the rotary axes to that
orientation, locks, and cuts it three-axis, without you re-fixturing. LinuxCNC
drives that with a G68.2 tilted work plane; the setup panel tells you whether
the machine can reach the face.

Posts included: LinuxCNC, GRBL, and a lathe post.

### Everything else

* Setups with their own orientation and work offset, so you can flip the part
  and machine the other side as a second setup — and the second setup starts
  from what the first one left, hole for hole, rather than from a fresh block.
* Stock as a box, a cylinder or a tube, sized outright or as a margin around
  the model, with fixtures and clamps as keep-out volumes the toolpaths avoid.
* Material removal simulation you can scrub through, which shows the cut shape
  and reports the load.
* **A check on the finished part.** The surface the program leaves is measured
  against the model it was made from, and the stock is coloured by the
  difference: green is the part, blue is metal still standing on it, red is
  metal cut out of it. The worst of each is named with the operation that did
  it, and clicking takes you to that move. It is the one question nothing else
  here answers — every other check compares a stage with the stage before it.
* Holding tabs, lead in and lead out, ramped and helical entry, arc fitting on
  the way out to G2/G3.
* **Reading a program back in.** *Export… → Check a file* opens any `.nc` —
  ours, another CAM system's, or one somebody typed — draws it, simulates it
  against the billet, measures what it leaves against the model, and checks it
  for travels, clamps and rapids that take metal. Inch programs, incremental
  programs, R-format arcs and canned cycles all come in; anything it cannot read
  it names rather than skipping.
* And it checks its own posts the same way. Every time a program is written the
  file is read straight back and compared with the path it was printed from, so
  a flipped G2/G3 or a lost modal word is a warning rather than a scrapped part.
* Projects save to a file, and autosave to the browser so a reload does not cost
  you an afternoon of setup.
* Export the whole program or one operation at a time.

## What it does not do

Be clear about this before you start: **the output is 3-axis milling — with
indexed 3+1 / 3+2 positioning — and 2-axis turning.** Nothing else is built.

* No *simultaneous* 5-axis. The rotary axes index a face under the spindle and
  lock; the cutting is still three-axis in that tilted frame (a G68.2 tilted
  work plane on LinuxCNC). Nothing moves all five at once.
* No probing, no tool length measurement cycles, no canned cycle library beyond
  what the strategies emit themselves.
* No cloud, no account, no telemetry. Nothing leaves your browser.

**And no sender — not now and not later.** This program writes a file. It does
not open a serial port, it does not talk to a controller, it does not jog an
axis, and it never will. That is a design rule rather than a missing feature,
and it is the reason the warning at the top of this page is survivable: nothing
here can move your machine, so every mistake it makes is a mistake you get to
find by reading the file, backplotting it and dry-running it. A CAM program that
could press cycle start would put its own bugs one click away from your
spindle. Getting the file to the machine is your problem, and keeping it that
way is the point.

## Running it locally

You need a **modern browser** and a **way to serve a folder over HTTP**. It will
not run from a `file://` URL, because the WebAssembly importer and the background
workers refuse to load that way. Everything else is included in the download,
including the libraries, so there is nothing to install and nothing to build.

Chrome or Edge give you the best version of this, because they support the File
System Access API and you get real open and save dialogs. Firefox and Safari
work, but saving falls back to the downloads folder.

Download it:

```bash
git clone https://github.com/gamerpaddy/CNCAM.git
```

Then start a server in that folder. If you have Python:

```bash
python serve.py 8500
```

That one is worth preferring during development because it disables caching, so
edited files actually reload. Any static server does the job though:

```bash
npx serve
```

Open the address the server prints, for example `http://localhost:8500`. That is
the whole install.

The build stamp in the bottom-right corner tells you which build you are looking
at. On the deployed site a service worker (`sw.js`) fetches every module fresh
from the network, so a push shows up on the next reload without a Ctrl-F5. If you
develop against this repo, enable the hook that stamps the build on each commit:

```bash
git config core.hooksPath .githooks
```

> If the page does not load and the port looks fine, check that the port is not
> reserved by your OS. On Windows, Hyper-V takes large ranges of them, and a
> server that appears to start can be unreachable. `netsh interface ipv4 show
> excludedportrange protocol=tcp` lists them.

### Tests

There are around 580 of them.

```bash
node src/test/node-run.js
```

The ones that need a browser live at `/test.html` on the running server.

## Licence

CNCAM is released under the [WTFPL](LICENSE). Do whatever you want with it. Use
it, change it, sell it, fork it, strip my name off it, I genuinely do not care.
There is no attribution requirement and nothing to ask permission for.

Two footnotes live in [NOTICE](NOTICE), neither of which restricts you.

The first is a plain no-warranty disclaimer. The WTFPL grants permission and
says nothing about liability, and this program writes G-code for machines that
can hurt people, so it is worth stating that nothing here is guaranteed.

The second is the vendored libraries. Those are other people's work and keep
their own licences, so those apply if you redistribute them. three.js is MIT and
Clipper is BSL-1.0, which ask for little beyond leaving the notices alone. The
OpenCASCADE build behind STEP and IGES import is LGPL-2.1, which asks that people
be able to replace it. They can: it loads at runtime from `vendor/occt/` over a
relative path, so swapping those two files needs no rebuild of anything else.

## More detail

* [docs/internals.md](docs/internals.md) covers how it works inside, and why
  various parts are built the way they are instead of the obvious way.
* [PLAN.md](PLAN.md) is the original development plan.
