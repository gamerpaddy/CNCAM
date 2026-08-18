// Machines: the thing the program is actually going to run on.
//
// This used to be one dropdown holding a G-code dialect, which is the smallest
// part of what a machine is. A post says how to *spell* a move; it says nothing
// about how far the table goes, how fast a rapid really is, how fast the
// spindle will turn, or how long a tool change takes — and every one of those
// is a number the user needs before the program is worth trusting:
//
//   * Travel is the difference between a program and a program that stops
//     halfway through with a soft limit alarm.
//   * The rapid rate is most of the cycle time on a job with a lot of
//     retracts, and assuming 3000 mm/min on a machine that does 15000 makes a
//     ten minute estimate out of a four minute job.
//   * The spindle range decides whether "18000 rpm" is a speed or a wish.
//
// So a machine is a record you can edit and keep, and the posts become presets
// for making one. The dialect is still in there — it is a property of the
// machine, which is where it belonged all along.

import { uid } from './schema.js';

export const MACHINE_KINDS = ['mill', 'turn'];

/**
 * The machines the app knows about out of the box, one per post plus the sizes
 * that go with the class of machine each post is usually found on.
 *
 * Presets, not truth: every one of these numbers is a starting point to
 * correct against the machine in front of you, which is exactly why they are
 * editable and why a project keeps its own copies.
 */
export const MACHINE_PRESETS = [
  {
    name: 'LinuxCNC 3-axis mill',
    kind: 'mill',
    post: 'linuxcnc',
    travel: [400, 250, 180],
    rapidFeed: 6000,
    rapidFeedZ: 4000,
    maxFeed: 5000,
    spindleMin: 100,
    spindleMax: 8000,
    toolChanger: 'auto',
    toolChangeSeconds: 8,
    coolant: true,
    notes: 'A knee or bed mill under LinuxCNC: canned drill cycles, G43 tool '
      + 'length compensation, arcs.',
  },
  {
    name: 'GRBL router',
    kind: 'mill',
    post: 'grbl',
    travel: [750, 750, 100],
    rapidFeed: 4000,
    rapidFeedZ: 2000,
    maxFeed: 3000,
    spindleMin: 6000,
    spindleMax: 24000,
    toolChanger: 'manual',
    toolChangeSeconds: 60,
    coolant: false,
    notes: 'A hobby router on GRBL: no tool changer, no canned cycles, and a '
      + 'trim-router spindle that will not run slowly.',
  },
  {
    name: 'Benchtop CNC mill',
    kind: 'mill',
    post: 'linuxcnc',
    travel: [230, 130, 250],
    rapidFeed: 2500,
    rapidFeedZ: 1800,
    maxFeed: 1500,
    spindleMin: 200,
    spindleMax: 5000,
    toolChanger: 'manual',
    toolChangeSeconds: 45,
    coolant: false,
    notes: 'A converted benchtop mill: small envelope, modest rapids, and a '
      + 'tool change that means walking over to it.',
  },
  {
    name: 'LinuxCNC lathe',
    kind: 'turn',
    post: 'lathe',
    // X is a *radius* here, as everywhere else inside the app; the post doubles
    // it. So "swing" is 2 × the X travel.
    travel: [110, 0, 500],
    rapidFeed: 5000,
    rapidFeedZ: 5000,
    maxFeed: 2000,
    spindleMin: 50,
    spindleMax: 2500,
    toolChanger: 'auto',
    toolChangeSeconds: 4,
    coolant: true,
    notes: 'A CNC lathe with a turret: X is programmed as a diameter, Z runs '
      + 'along the bar.',
  },
  {
    name: 'Small toolroom lathe',
    kind: 'turn',
    post: 'lathe',
    travel: [60, 0, 250],
    rapidFeed: 2000,
    rapidFeedZ: 2000,
    maxFeed: 600,
    spindleMin: 60,
    spindleMax: 2000,
    toolChanger: 'manual',
    toolChangeSeconds: 30,
    coolant: false,
    notes: 'A converted toolroom lathe: one tool at a time, gently.',
  },
];

/** A full machine record from a preset or a partial one. */
export function createMachine(preset = {}) {
  const base = MACHINE_PRESETS.find((m) => m.kind === (preset.kind ?? 'mill'))
    ?? MACHINE_PRESETS[0];
  const merged = { ...base, ...preset };
  return {
    id: uid('machine'),
    name: merged.name ?? 'New machine',
    kind: MACHINE_KINDS.includes(merged.kind) ? merged.kind : 'mill',
    post: merged.post ?? base.post,
    travel: [...(merged.travel ?? base.travel)],
    rapidFeed: num(merged.rapidFeed, base.rapidFeed),
    rapidFeedZ: num(merged.rapidFeedZ, merged.rapidFeed ?? base.rapidFeedZ),
    maxFeed: num(merged.maxFeed, base.maxFeed),
    spindleMin: num(merged.spindleMin, base.spindleMin),
    spindleMax: num(merged.spindleMax, base.spindleMax),
    toolChanger: merged.toolChanger === 'manual' ? 'manual' : 'auto',
    toolChangeSeconds: num(merged.toolChangeSeconds, base.toolChangeSeconds),
    coolant: merged.coolant !== false,
    // How a feed is written. A lathe's natural unit is mm per *revolution* —
    // that is what makes the chip the same thickness at every diameter, and it
    // is the figure quoted on an insert box. A mill has no such thing.
    feedMode: merged.feedMode === 'perMinute' || merged.kind === 'mill'
      ? 'perMinute'
      : (merged.feedMode ?? (merged.kind === 'turn' ? 'perRev' : 'perMinute')),
    notes: merged.notes ?? '',
  };
}

function num(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** The starting rack: one machine per preset, so there is always one to pick. */
export function defaultMachines() {
  return MACHINE_PRESETS.map((preset) => createMachine(preset));
}

/** Every machine of a kind, in list order. */
export function machinesFor(project, kind) {
  return (project.machines ?? []).filter((m) => m.kind === kind);
}

/**
 * The machine a program for this kind will be posted for.
 *
 * Falls back to the first of its kind rather than to nothing: a project with a
 * dangling machine id is a project that would otherwise silently lose its
 * travel limits and its rapid rate, and the point of those numbers is that they
 * are always applied.
 */
export function activeMachine(project, kind) {
  const pool = machinesFor(project, kind);
  if (pool.length === 0) return null;
  const chosen = pool.find((m) => m.id === project.machineIds?.[kind]);
  return chosen ?? pool[0];
}

/**
 * The travel envelope as a pair of corners, centred on the work zero.
 *
 * Travel is quoted as a size because that is how a machine is sold and how the
 * tape measure reads. Where the work zero sits inside it is a setup decision
 * nothing here can know, so the check below is deliberately about *span* rather
 * than about absolute position: a program 500mm wide will not fit a 400mm table
 * however it is placed, and that is the failure worth catching before the
 * spindle finds it.
 */
export function travelSpan(machine, axis) {
  const index = { x: 0, y: 1, z: 2 }[axis] ?? 0;
  const value = machine?.travel?.[index];
  return Number.isFinite(value) && value > 0 ? value : Infinity;
}

/**
 * Does a program fit this machine, and does it ask for speeds it cannot reach?
 *
 * @param extent { min: [x,y,z], max: [x,y,z] } of every move in the program
 * @param speeds { maxRpm, minRpm, maxFeed } the program asks for, each with the
 *   operation that asks for it in `speeds.at` — "an operation asks for 12000
 *   rpm" in a twelve-operation program means opening twelve Speeds tabs to find
 *   which one, and the app already knows
 * @returns [{ level, text }] — empty when everything fits
 */
export function machineWarnings(machine, extent, speeds = {}) {
  const who = (key) => (speeds.at?.[key] ? `${speeds.at[key]} asks` : 'an operation asks');
  const out = [];
  if (!machine) return out;
  const axes = machine.kind === 'turn' ? ['x', 'z'] : ['x', 'y', 'z'];
  const index = { x: 0, y: 1, z: 2 };

  if (extent) {
    for (const axis of axes) {
      const span = travelSpan(machine, axis);
      if (!Number.isFinite(span)) continue;
      const used = extent.max[index[axis]] - extent.min[index[axis]];
      if (!(used > span + 1e-6)) continue;
      // X on a lathe is a radius in here and a diameter on the machine, and
      // travel is quoted the same way the axis is programmed
      const shown = machine.kind === 'turn' && axis === 'x' ? used * 2 : used;
      const limit = machine.kind === 'turn' && axis === 'x' ? span * 2 : span;
      out.push({
        level: 'warn',
        text: `the program needs ${shown.toFixed(1)}mm of ${axis.toUpperCase()} and `
          + `${machine.name} has ${limit.toFixed(0)}mm`,
      });
    }
  }

  if (speeds.maxRpm > 0 && machine.spindleMax > 0 && speeds.maxRpm > machine.spindleMax) {
    out.push({
      level: 'warn',
      text: `${who('maxRpm')} for ${Math.round(speeds.maxRpm)} rpm and the spindle `
        + `tops out at ${machine.spindleMax}`,
    });
  }
  if (speeds.minRpm > 0 && machine.spindleMin > 0 && speeds.minRpm < machine.spindleMin) {
    out.push({
      level: 'warn',
      text: `${who('minRpm')} for ${Math.round(speeds.minRpm)} rpm and the spindle `
        + `will not turn below ${machine.spindleMin}`,
    });
  }
  if (speeds.maxFeed > 0 && machine.maxFeed > 0 && speeds.maxFeed > machine.maxFeed) {
    out.push({
      level: 'warn',
      text: `${speeds.at?.maxFeed ? `${speeds.at.maxFeed} feeds at` : 'a feed of'} `
        + `${Math.round(speeds.maxFeed)} mm/min, above the machine's ${machine.maxFeed}`,
    });
  }
  return out;
}

/** One line describing a machine, for a dropdown or a tooltip. */
export function describeMachine(machine) {
  if (!machine) return 'no machine';
  const travel = machine.kind === 'turn'
    ? `⌀${(machine.travel[0] * 2).toFixed(0)} × ${machine.travel[2].toFixed(0)}mm`
    : machine.travel.map((v) => v.toFixed(0)).join(' × ');
  return `${travel} · ${machine.spindleMin}–${machine.spindleMax} rpm · `
    + `G0 ${machine.rapidFeed} mm/min · ${machine.post}`;
}
