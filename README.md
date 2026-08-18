# CNCAM

A CAM program that runs in your browser. You load a 3D model, tell it what tools
you have and what cuts you want, and it writes G-code.

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
| Holes | Drill, Helical bore |
| Edges and marking | Chamfer, Engrave |
| 3D finishing | Parallel finish, Waterline finish |

Roughing is stock aware and can rest machine against what an earlier operation
already took off, so the finisher is not cutting air for an hour.

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

Posts included: LinuxCNC, GRBL, and a lathe post.

### Everything else

* Setups with their own orientation and work offset, so you can flip the part
  and machine the other side as a second setup.
* Stock as a box, a cylinder or a tube, sized outright or as a margin around
  the model, with fixtures and clamps as keep-out volumes the toolpaths avoid.
* Material removal simulation you can scrub through, which shows the cut shape
  and reports the load.
* Holding tabs, lead in and lead out, ramped and helical entry, arc fitting on
  the way out to G2/G3.
* Projects save to a file, and autosave to the browser so a reload does not cost
  you an afternoon of setup.
* Export the whole program or one operation at a time.

## What it does not do

Be clear about this before you start: **the output is 3-axis milling and 2-axis
turning.** Nothing else is built.

* No indexed 3+2 and no simultaneous 5-axis. Multiple setups let you machine
  another side of the part, but you re-fixture it yourself. Nothing writes a
  rotary axis.
* No probing, no tool length measurement cycles, no canned cycle library beyond
  what the strategies emit themselves.
* No sender. It writes a file. Getting the file to the machine is your problem.
* No cloud, no account, no telemetry. Nothing leaves your browser.

## Running it

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

> If the page does not load and the port looks fine, check that the port is not
> reserved by your OS. On Windows, Hyper-V takes large ranges of them, and a
> server that appears to start can be unreachable. `netsh interface ipv4 show
> excludedportrange protocol=tcp` lists them.

### Tests

There are around 550 of them.

```bash
node src/test/node-run.js
```

The ones that need a browser live at `/test.html` on the running server.

## Licensing

The vendored libraries under `vendor/` carry their own licences, and one of them
(the OpenCASCADE WebAssembly build used for STEP and IGES import) is LGPL. See
[vendor/README.md](vendor/README.md) before you ship anything commercial built on
this.

No licence has been chosen for the CNCAM code itself yet, which means the default
applies and you do not have permission to redistribute it. That will change.

## More detail

* [docs/internals.md](docs/internals.md) covers how it works inside, and why
  various parts are built the way they are instead of the obvious way.
* [PLAN.md](PLAN.md) is the original development plan.
