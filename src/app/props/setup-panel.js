// The setup panel: the program as a sequence, how the part is held, and what
// it is being cut out of.
//
// These are the decisions that apply to every operation under the setup, which
// is why they live on the setup rather than being repeated on each of them.

import { el } from '../layout.js';
import { plural } from '../../engine/text.js';
import {
  STOCK_KINDS, STOCK_KIND_LABELS, STOCK_ALIGNMENTS, STOCK_ALIGN_LABELS,
  computeStock, isRoundStock, chuckingAllowanceFor,
} from '../../engine/stock.js';
import {
  ORIGIN_MODES, ORIGIN_LABELS, ORIENTATION_PRESETS, resolveSetup,
} from '../../engine/setup.js';
import { setupModelIds } from '../actions/setup-space.js';
import { boreProfile } from '../../engine/lathe.js';
import { computeBounds, mergeMeshes } from '../../geom/mesh.js';
import { opStatus, formatTime } from '../op-status.js';
import { machineWarnings } from '../../doc/machines.js';
import { effectiveCutting } from '../../engine/cutting.js';
import { MOVE_STRIDE, OP } from '../../engine/cl.js';
import { fieldRow, roundMicron, propRow } from './fields.js';

const ORIENTATION_FIELDS = [
  {
    path: 'orientation.origin', label: 'Zero point', type: 'select',
    options: ORIGIN_MODES, labels: ORIGIN_LABELS,
    onChange: (app, setup, mode) => setZeroPoint(app, setup, mode),
  },
  // These rotate the *model* into setup space, so they survive on the lathe:
  // a shaft modelled with its axis along Y has to be stood up on the spindle
  // axis before anything else is true about it.
  { path: 'orientation.rotationDeg.0', label: 'Rotate X (°)', type: 'number' },
  { path: 'orientation.rotationDeg.1', label: 'Rotate Y (°)', type: 'number' },
  { path: 'orientation.rotationDeg.2', label: 'Rotate Z (°)', type: 'number' },
];

/** A lathe moves in X and Z. Nothing is ever positioned across the bar. */
function isTurning(setup) { return (setup.mode ?? 'mill') === 'turn'; }

/** Fields that only mean something on a machine with a table under the part. */
function milling(setup) { return !isTurning(setup); }

const STOCK_FIELDS = [
  {
    path: 'stock.kind', label: 'Stock', type: 'select',
    options: STOCK_KINDS, labels: STOCK_KIND_LABELS,
  },
  { path: 'stock.margin.0', label: 'Margin X (mm)', type: 'number', when: isMargin },
  { path: 'stock.margin.1', label: 'Margin Y (mm)', type: 'number', when: isMargin },
  { path: 'stock.margin.2', label: 'Margin top (mm)', type: 'number', when: isMargin },
  { path: 'stock.marginBottom', label: 'Margin under (mm)', type: 'number', when: isMargin },

  // A billet is a size you can measure with a rule, not a pair of absolute
  // corners in whatever frame the CAD happened to author the part in.
  { path: 'stock.box.size.0', label: 'Width X (mm)', type: 'number', min: 0.1, when: isBox },
  { path: 'stock.box.size.1', label: 'Depth Y (mm)', type: 'number', min: 0.1, when: isBox },
  { path: 'stock.box.size.2', label: 'Height Z (mm)', type: 'number', min: 0.1, when: isBox },
  {
    path: 'stock.box.align', label: 'Part sits', type: 'select',
    options: STOCK_ALIGNMENTS, labels: STOCK_ALIGN_LABELS, when: isBox,
  },
  { path: 'stock.box.offset.0', label: 'Shift X (mm)', type: 'number', when: isBox },
  { path: 'stock.box.offset.1', label: 'Shift Y (mm)', type: 'number', when: isBox },
  { path: 'stock.box.offset.2', label: 'Shift Z (mm)', type: 'number', when: isBox },

  {
    path: 'stock.cylinder.diameter', label: 'Diameter (mm)', type: 'number', min: 0.1,
    when: isRound,
    hint: 'The bar you are putting in the chuck, measured across',
  },
  {
    path: 'stock.cylinder.innerDiameter', label: 'Bore ⌀ (mm)', type: 'number', min: 0,
    when: isTube,
    hint: 'The hole down the middle. Nothing inside it is material, so roughing '
      + 'stops there instead of cutting air.',
  },
  { path: 'stock.cylinder.height', label: 'Length Z (mm)', type: 'number', min: 0.1, when: isRound },
  // Bar goes in a chuck, and a chuck holds it on the spindle axis. Offering to
  // shift it sideways offers a bar that is not concentric with the thing turning
  // it, which is not a setup — it is a mistake with two fields to type it into.
  // "Part sits" is the same mistake in one field: the alignments are XY ones
  // ("Part at the X−Y− corner"), and taking either of them puts the part off
  // centre by half the difference in diameter. So it is a milling question too.
  {
    path: 'stock.cylinder.align', label: 'Part sits', type: 'select',
    options: STOCK_ALIGNMENTS, labels: STOCK_ALIGN_LABELS,
    when: (s) => isRound(s) && milling(s),
  },
  {
    path: 'stock.cylinder.offset.0', label: 'Shift X (mm)', type: 'number',
    when: (s) => isRound(s) && milling(s),
  },
  {
    path: 'stock.cylinder.offset.1', label: 'Shift Y (mm)', type: 'number',
    when: (s) => isRound(s) && milling(s),
  },
  { path: 'stock.cylinder.offset.2', label: 'Shift Z (mm)', type: 'number', when: isRound },
];

function isMargin(setup) { return setup.stock.kind === 'box-margin'; }

function isBox(setup) { return setup.stock.kind === 'box'; }

function isTube(setup) { return setup.stock.kind === 'tube'; }

function isRound(setup) { return isRoundStock(setup.stock); }

/**
 * The program, as the person running it would read it.
 *
 * Everything else in this app is one operation at a time. A job is a sequence:
 * which cutter goes in when, in what order, for how long. That is the view you
 * need to sanity-check a setup — three tool changes when two would do, a finish
 * pass before the roughing that feeds it — and there was nowhere to see it.
 */
function jobSummarySection(doc, setup) {
  const rows = [el('h2', {}, ['Program'])];
  const ops = setup.operations.filter((op) => op.enabled);
  if (ops.length === 0) {
    rows.push(el('div', { class: 'prop-note' }, ['No enabled operations in this setup.']));
    return rows;
  }

  let seconds = 0;
  let generated = 0;
  let stale = 0;
  let lastToolId = null;
  let toolChanges = 0;
  const lines = [];

  for (const op of ops) {
    const tool = doc.project.tools.find((t) => t.id === op.toolId);
    if (tool && tool.id !== lastToolId) { toolChanges++; lastToolId = tool.id; }
    const status = opStatus(doc, op);
    if (status) { seconds += status.seconds; generated++; if (status.stale) stale++; }
    lines.push(el('div', { class: 'job-row' }, [
      el('span', { class: 'job-tool' }, [tool ? `T${tool.number}` : '—']),
      el('span', { class: 'job-name' }, [op.name]),
      el('span', { class: 'job-time' }, [status ? status.timeText : '·']),
    ]));
  }

  rows.push(el('div', { class: 'job-list' }, lines));
  // Tool changes are part of the cycle time and a large part of it on a machine
  // without a changer: four seconds on a turret and a minute by hand is the
  // difference between two programs that look identical in every other way.
  const machine = doc.machineRecord();
  const changeSeconds = toolChanges * (machine?.toolChangeSeconds ?? 0);
  const summary = [
    `${plural(ops.length, 'operation')}`,
    `${plural(toolChanges, 'tool change')}`
      + (changeSeconds > 0 ? ` (${formatTime(changeSeconds)})` : ''),
  ];
  if (generated === ops.length && stale === 0) {
    summary.push(`≈ ${formatTime(seconds + changeSeconds)}`);
  }
  rows.push(el('div', { class: 'prop-note' }, [summary.join(' · ')]));

  if (generated < ops.length) {
    rows.push(el('div', { class: 'prop-note' }, [
      `${ops.length - generated} not generated yet, so the total is incomplete.`,
    ]));
  } else if (stale > 0) {
    rows.push(el('div', { class: 'prop-note warn' }, [
      `${plural(stale, 'operation')} ${stale === 1 ? 'has' : 'have'} changed since generation.`,
    ]));
  }
  rows.push(...machineFitRows(doc, setup));
  return rows;
}

/**
 * Whether the generated program fits the machine it is for.
 *
 * A soft-limit alarm halfway through a program is an hour of setup thrown away
 * for something that was knowable before the file was written, and a spindle
 * asked for 24000 rpm when it tops out at 8000 simply runs at 8000 and takes
 * the surface speed the cutter was chosen for away with it. Neither says
 * anything at the machine until it is too late to be useful.
 *
 * Shown here rather than only in the status bar, because a status line is gone
 * by the time you have finished reading the panel.
 */
function machineFitRows(doc, setup) {
  const machine = doc.machineRecord();
  if (!machine) return [];
  const programs = [];
  for (const op of setup.operations) {
    const cl = doc.toolpaths.get(op.id);
    if (op.enabled && cl) programs.push(cl);
  }
  if (programs.length === 0) return [];

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const cl of programs) {
    const d = cl.moves;
    for (let n = 0; n < cl.count; n++) {
      const o = n * MOVE_STRIDE;
      for (let k = 0; k < 3; k++) {
        if (d[o + 1 + k] < min[k]) min[k] = d[o + 1 + k];
        if (d[o + 1 + k] > max[k]) max[k] = d[o + 1 + k];
      }
      if (d[o] === OP.DRILL && d[o + 4] > max[2]) max[2] = d[o + 4];
    }
  }
  if (!Number.isFinite(min[0])) return [];

  let maxRpm = 0;
  let minRpm = Infinity;
  let maxFeed = 0;
  // which operation asks for each, so the note names it rather than sending you
  // through every Speeds tab in the setup to find out — see doc/machines.js
  const at = {};
  for (const op of setup.operations) {
    const tool = doc.project.tools.find((t) => t.id === op.toolId);
    // and only the ones that put something in the file, which is the same
    // program the extent above is measured from
    if (!op.enabled || !tool || !(doc.toolpaths.get(op.id)?.count > 0)) continue;
    const c = effectiveCutting(op, tool);
    if (c.spindleRpm > 0) {
      if (c.spindleRpm > maxRpm) { maxRpm = c.spindleRpm; at.maxRpm = op.name; }
      if (c.spindleRpm < minRpm) { minRpm = c.spindleRpm; at.minRpm = op.name; }
    }
    const fastest = Math.max(c.feedCut, c.feedPlunge);
    if (fastest > maxFeed) { maxFeed = fastest; at.maxFeed = op.name; }
  }

  const warnings = machineWarnings(machine, { min, max }, {
    maxRpm, minRpm: Number.isFinite(minRpm) ? minRpm : 0, maxFeed, at,
  });
  if (warnings.length === 0) {
    return [el('div', { class: 'prop-note' }, [
      `Fits ${machine.name}: `
      + `${(max[0] - min[0]).toFixed(0)} × ${(max[1] - min[1]).toFixed(0)} × `
      + `${(max[2] - min[2]).toFixed(0)} mm of travel used.`,
    ])];
  }
  return warnings.map((w) => el('div', { class: 'prop-note warn' }, [`${machine.name}: ${w.text}.`]));
}

export function setupSections(doc, setup, app) {
  // Which machine this setup is for is decided by the Mill/Lathe tab and shown
  // rather than edited: retyping it under an operation list would leave every
  // one of those operations belonging to a machine that cannot run it.
  const rows = [el('div', { class: 'prop-note' }, [
    (setup.mode ?? 'mill') === 'turn'
      ? 'Lathe setup. The part spins about Z, stock is a bar, and the profile is '
        + 'the largest radius at each point along it. X in the G-code is a diameter.'
      : 'Mill setup. The part is held still and the cutter moves in X, Y and Z.',
  ])];
  rows.push(...jobSummarySection(doc, setup), el('h2', {}, ['Orientation']));
  rows.push(orientationPresetRow(doc, setup));
  for (const f of ORIENTATION_FIELDS) rows.push(fieldRow(doc, setup, f, null, null, app));

  rows.push(el('h2', {}, ['Raw stock']));
  const seed = () => ensureStockShape(doc, setup);
  for (const f of STOCK_FIELDS) {
    if (f.when && !f.when(setup)) continue;
    rows.push(f.path === 'stock.kind'
      ? fieldRow(doc, setup, f, null, seed, app)
      : fieldRow(doc, setup, f, seed, null, app));
    if (f.path === 'stock.cylinder.diameter') rows.push(snapDiameterRow(doc, setup));
    if (f.path === 'stock.cylinder.innerDiameter') rows.push(snapBoreRow(doc, setup));
  }
  rows.push(stockSummaryRow(doc, setup));
  return rows;
}

/**
 * "Make the bar the size of the part" — the one number you should never have to
 * look up.
 *
 * The part's largest diameter is already known to the app: it is what the
 * turning profile is built from and what every roughing pass is measured
 * against. Asking the user to find it means reading it off a drawing, or off
 * the stock summary two rows down, or guessing and generating twice to see
 * whether the first pass cut air. Both offered sizes are honest about which
 * they are — the exact size, for a part already turned to diameter, and the
 * next bar up with something on for cleaning.
 */
function snapDiameterRow(doc, setup) {
  const { meshes } = placed(doc, setup);
  if (meshes.length === 0) return el('span', {});
  const exact = roundMicron(partDiameter(meshes));
  if (!(exact > 0)) return el('span', {});

  const current = setup.stock.cylinder?.diameter ?? 0;
  const options = [
    { label: `⌀${trim(exact)}`, value: exact, hint: 'Exactly the part\'s largest diameter — nothing to clean up' },
    {
      label: `⌀${trim(roundMicron(exact + 2))}`,
      value: roundMicron(exact + 2),
      hint: '1mm of material all round, which is a light skim',
    },
    {
      label: `⌀${nextBarSize(exact)}`,
      value: nextBarSize(exact),
      hint: 'The next standard bar size up — what you would actually buy',
    },
  ];
  // the same number twice is one button, not two that look like a mistake
  const unique = options.filter((o, i) => options.findIndex((x) => x.value === o.value) === i);

  return el('div', { class: 'prop-snaps' }, [
    el('span', { class: 'prop-snaps-label' }, ['fit to part']),
    ...unique.map((option) => el('button', {
      class: `prop-snap${Math.abs(current - option.value) < 0.0005 ? ' at' : ''}`,
      title: option.hint,
      onclick: () => {
        ensureStockShape(doc, setup);
        doc.updateItem(setup.stock.cylinder, { diameter: option.value }, 'snap stock diameter');
      },
    }, [option.label])),
  ]);
}

/** The same for the bore: the hole the part already has down the middle. */
function snapBoreRow(doc, setup) {
  const { meshes } = placed(doc, setup);
  if (meshes.length === 0) return el('span', {});
  const bore = boreProfile(mergeMeshes(meshes));
  let smallest = Infinity;
  for (let i = 0; i < bore.samples; i++) {
    if (bore.r[i] > 0 && bore.r[i] < smallest) smallest = bore.r[i];
  }
  if (!Number.isFinite(smallest)) {
    return el('div', { class: 'prop-note' }, [
      'The part has no bore, so the tube\'s hole is whatever the material came with.',
    ]);
  }
  const value = roundMicron(smallest * 2);
  const current = setup.stock.cylinder?.innerDiameter ?? 0;
  return el('div', { class: 'prop-snaps' }, [
    el('span', { class: 'prop-snaps-label' }, ['fit to part']),
    el('button', {
      class: `prop-snap${Math.abs(current - value) < 0.0005 ? ' at' : ''}`,
      title: 'The smallest hole in the part — tube that size needs no boring at all',
      onclick: () => {
        ensureStockShape(doc, setup);
        doc.updateItem(setup.stock.cylinder, { innerDiameter: value }, 'snap stock bore');
      },
    }, [`⌀${trim(value)}`]),
  ]);
}

/** The largest diameter anywhere on the part, about the Z axis. */
function partDiameter(meshes) {
  let max = 0;
  for (const mesh of meshes) {
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const r = Math.hypot(p[i], p[i + 1]);
      if (r > max) max = r;
    }
  }
  return max * 2;
}

/** The next size up out of the bar sizes a stockist actually keeps. */
function nextBarSize(diameter) {
  const sizes = [6, 8, 10, 12, 16, 20, 25, 30, 32, 35, 40, 45, 50, 60, 70, 80, 90, 100,
    110, 120, 130, 140, 150, 160, 180, 200, 250, 300];
  for (const size of sizes) if (size >= diameter + 0.5) return size;
  return Math.ceil(diameter / 10) * 10 + 10;
}

/**
 * The part as it is fixtured, and the billet around it — the same resolve the
 * generator, the viewport and the G-code all go through.
 *
 * This panel used to measure the raw CAD geometry: the meshes as modelled, and
 * `computeStock` without the setup's rotation and without its mode. So every
 * number on the setup panel described a part that is not the one being cut. A
 * setup rotated 90° reported its billet as 88 × 90 × 31 while the billet drawn
 * beside it, machined, and posted was 88 × 39 × 82 — and "fit to part ⌀" swung
 * the part about the *model's* Z, which is the exact mistake the rotation
 * fields exist to correct ("a shaft modelled with its axis along Y has to be
 * stood up on the spindle axis before anything else is true about it").
 *
 * One resolve, and the panel and the picture are the same statement again.
 * See engine/setup.js and app/actions/setup-space.js.
 */
function placed(doc, setup) {
  const raw = setupModelIds(setup, doc.project)
    .map((id) => doc.meshes.get(id)).filter(Boolean);
  return resolveSetup(setup, raw, computeStock);
}

function trim(v) { return String(Math.round(v * 1000) / 1000); }

/**
 * The strategy, shown as what it is rather than as an entry in a dropdown.
 *
 * A name in a select box is the least informative way to present the single
 * decision the rest of the panel depends on. This says what the operation does,
 * and opens the same card picker the tree uses to change it.
 */

/**
 * Move the datum, and leave the clamps where they physically are.
 *
 * The zero point is the one control in the app that changes *nothing* about the
 * job: it says which corner of the billet the operator will touch off on, and
 * every coordinate in the setup shifts by the same amount as a consequence. The
 * part shifts, because it is derived (engine/setup.js resolves the models into
 * the datum's frame). A clamp does not, because its position is stored in that
 * frame and stored numbers do not move — so switching from "stock top, centre"
 * to "stock top, X−Y− corner" slid every clamp half a billet across the part.
 * Measured on a 88 × 90 billet with a jaw across one end: the contour it was
 * holding down went from 2411mm of cut to 3575mm, because the jaw had left the
 * part altogether and stopped masking anything. Nothing said a word.
 *
 * So the shift is applied to the clamps too, in the same undo entry as the
 * datum change — one gesture, one edit, and the clamp is still on the same
 * piece of metal afterwards.
 *
 * Rotation is deliberately not treated this way: `rotationDeg` is how the part
 * is *fixtured*, so it means the part really has been taken out and put back
 * another way round, and where the clamps go then is a decision only the person
 * holding them can make.
 */
function setZeroPoint(app, setup, mode) {
  const { doc } = app;
  const previous = setup.orientation?.origin;
  if (mode === previous) return;

  const before = placed(doc, setup).offset;
  setup.orientation.origin = mode;
  const after = placed(doc, setup).offset;
  setup.orientation.origin = previous;
  const shift = after.map((v, k) => v - before[k]);

  const fixtures = (setup.fixtures ?? []).filter(() => shift.some((v) => Math.abs(v) > 1e-9));
  const held = fixtures.map((f) => ({
    center: f.center, baseZ: f.baseZ, faceZ: f.faceZ,
  }));
  const move = () => fixtures.forEach((f) => {
    f.center = [roundMicron((f.center?.[0] ?? 0) + shift[0]),
      roundMicron((f.center?.[1] ?? 0) + shift[1])];
    f.baseZ = roundMicron((f.baseZ ?? 0) + shift[2]);
    f.faceZ = roundMicron((f.faceZ ?? 0) + shift[2]);
  });
  const restore = () => fixtures.forEach((f, i) => Object.assign(f, held[i]));

  doc.apply('set zero point',
    () => { setup.orientation.origin = mode; move(); },
    () => { setup.orientation.origin = previous; restore(); });
  if (fixtures.length) {
    app.ui?.setStatus?.(`Zero is now ${ORIGIN_LABELS[mode] ?? mode} — `
      + `${plural(fixtures.length, 'clamp')} moved with it, so they still hold the same place`);
  }
}

function orientationPresetRow(doc, setup) {
  const current = (setup.orientation?.rotationDeg ?? [0, 0, 0]).join(',');
  const select = el('select', {}, [
    el('option', { value: '' }, ['— custom —']),
    ...ORIENTATION_PRESETS.map((p) =>
      el('option', { value: p.rotationDeg.join(',') }, [p.name])),
  ]);
  select.value = ORIENTATION_PRESETS.some((p) => p.rotationDeg.join(',') === current)
    ? current : '';
  select.addEventListener('change', () => {
    if (!select.value) return;
    const rotationDeg = select.value.split(',').map(Number);
    doc.updateItem(setup.orientation, { rotationDeg }, 'set orientation');
  });
  return propRow('Fixturing', select);
}

/**
 * Fill in a stock shape the first time it is chosen, sized to the part.
 *
 * Switching to "explicit box" should hand you the billet you would have cut
 * this part from, not a set of zeroes to work out for yourself.
 */
function ensureStockShape(doc, setup) {
  const { stock } = setup;
  if (stock.kind === 'box' && stock.box) return;
  if (isRoundStock(stock) && stock.cylinder) return;

  // rotated into the fixturing first: the size of the billet you would cut this
  // from is a size of the part *as held*, not as authored
  const { meshes } = placed(doc, setup);
  const auto = computeStock(meshes, { kind: 'box-margin', margin: [1, 1, 1] });
  if (!auto) return;
  const size = [0, 1, 2].map((k) => round2(auto.max[k] - auto.min[k]));

  if (stock.kind === 'box') {
    doc.updateItem(stock, {
      box: { size, align: 'center', offset: [0, 0, 0] },
    }, 'init stock box');
  } else if (isRoundStock(stock)) {
    // Round stock is registered about the spindle axis, not about a bounding
    // box: a shaft modelled on the axis is a ⌀30 bar, and the box around it is
    // 30 × 30 only by coincidence. Reading the true swung diameter means the
    // first bar you are offered is the bar you would buy — and it is longer
    // than the part at both ends, so there is something to face and something
    // to hold. See engine/stock.js.
    const swung = round2(partDiameter(meshes));
    const diameter = Math.max(swung || 0, size[0], size[1]);
    const chucking = chuckingAllowanceFor(diameter);
    doc.updateItem(stock, {
      cylinder: {
        diameter,
        // a tube arrives solid; you say how big the hole is, and until then it
        // is a bar, which is the safe assumption
        innerDiameter: 0,
        height: round2(size[2] + chucking),
        align: 'center',
        offset: [0, 0, 0],
      },
    }, `init stock ${stock.kind}`);
  }
}

function round2(v) { return Math.round(v * 100) / 100; }

/**
 * What the billet actually works out to, and whether the part fits in it.
 *
 * The size fields say what you asked for; this says what you got, including the
 * case that matters — a part sticking out of its own stock, which generates
 * toolpaths that cut air on one side and crash into the vice on the other.
 */
function stockSummaryRow(doc, setup) {
  const { meshes, stock } = placed(doc, setup);
  if (!stock) return el('div', { class: 'prop-note' }, ['No models to size stock from.']);

  const round = isRoundStock(stock);
  const size = [0, 1, 2].map((k) => fmt(stock.max[k] - stock.min[k]));
  const rows = [el('div', { class: 'prop-note' }, [round
    ? `Bar ⌀${fmt(stock.cylinder.diameter)}`
      + (stock.cylinder.innerDiameter > 0 ? ` × ⌀${fmt(stock.cylinder.innerDiameter)} bore` : '')
      + ` × ${fmt(stock.cylinder.height)} long`
    : `Billet ${size.join(' × ')} mm`])];

  // A tube whose wall is thinner than the part needs is not a warning you want
  // to meet at the machine.
  if (round && stock.cylinder.innerDiameter > 0) {
    const wall = (stock.cylinder.diameter - stock.cylinder.innerDiameter) / 2;
    rows.push(el('div', { class: 'prop-note' }, [`Wall ${fmt(wall)} mm thick`]));
    const partR = partDiameter(meshes) / 2;
    if (partR > 0 && stock.cylinder.innerDiameter / 2 > partR - 0.005) {
      rows.push(el('div', { class: 'prop-note warn' }, [
        `The bore is ⌀${fmt(stock.cylinder.innerDiameter)} and the part only reaches `
        + `⌀${fmt(partR * 2)} — there is no material where the part is.`,
      ]));
    }
  }

  const b = modelBoundsOf(meshes);
  if (b) {
    const axes = ['X', 'Y', 'Z'];
    const outside = [];
    for (let k = 0; k < 3; k++) {
      const over = Math.max(stock.min[k] - b.min[k], b.max[k] - stock.max[k]);
      if (over > 0.005) outside.push(`${axes[k]} by ${fmt(over)}mm`);
    }
    rows.push(outside.length
      ? el('div', { class: 'prop-note warn' }, [
        `The part sticks out of the stock in ${outside.join(', ')} — `
        + 'anything outside the billet cannot be machined.',
      ])
      : el('div', { class: 'prop-note' }, [
        `Material around the part: ${[0, 1, 2].map((k) => `${axes[k]} ${fmt(
          Math.min(b.min[k] - stock.min[k], stock.max[k] - b.max[k]),
        )}`).join(', ')} mm`,
      ]));
  }
  return el('div', {}, rows);
}

function modelBoundsOf(meshes) {
  if (meshes.length === 0) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    const b = computeBounds(mesh.positions);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  }
  return { min, max };
}

function fmt(v) { return (Math.round(v * 100) / 100).toString(); }

/**
 * Project-wide simulation settings.
 *
 * Shown when nothing is selected — that panel would otherwise sit empty, and
 * this is a small enough box of knobs that hiding it behind a modal would be
 * worse than parking it here.
 */
