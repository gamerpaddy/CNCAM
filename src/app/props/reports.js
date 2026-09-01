// Read-outs: what the settings you just typed come to on the machine, and what
// the operation actually did when it ran.
//
// Both halves exist for the same reason. A panel of numbers tells you what you
// asked for and nothing about what you will get — a 0.5mm chamfer is 0.5mm deep
// with a 90° mill and 1.87mm deep with a 30° V bit — and a generated toolpath
// is invisible unless something counts it. So each group of settings that hides
// arithmetic ends in a report, and every operation ends in a Result.

import { el } from '../layout.js';
import { plural, pluralEs } from '../../engine/text.js';
import { cuttingReport } from '../../engine/cutting.js';
import { isRoundStock } from '../../engine/stock.js';
import { chamferGeometry, maxWidthFor } from '../../engine/strategies/chamfer.js';
import { tipAngleOf } from '../../engine/tool-geometry.js';
import { grooveGeometry } from '../../engine/strategies/engrave.js';
import { laneOffsets } from '../../engine/strategies/slot.js';
import { threadFormDepth, grooveBites } from '../../engine/strategies/turning.js';
import {
  opStatus, opBlockedReason, opPreflight, formatLength,
} from '../op-status.js';

/** A two-column read-out. Every report row in this panel is one of these. */
export function reportRows(lines) {
  return el('div', { class: 'cutting-report' }, lines.map(([k, v]) =>
    el('div', { class: 'cutting-row' }, [el('span', {}, [k]), el('span', {}, [v])])));
}

/**
 * What the tab settings come to on the machine.
 *
 * The two numbers a machinist wants are how much material is holding the part
 * and how far the tool has to lift for it — neither of which is any of the
 * three fields above on its own.
 */
export function tabReportRow(doc, op) {
  const tool = doc.project.tools.find((t) => t.id === op.toolId);
  const p = op.params;
  const count = Math.round(p.tabCount ?? 0);
  const width = p.tabWidth ?? 0;
  const height = p.tabHeight ?? 0;
  if (!tool) return el('div', { class: 'prop-note' }, ['Assign a tool to size the tabs.']);

  const lift = width + tool.diameter;
  const area = count * width * height;
  return el('div', { class: 'cutting-report' }, [
    ['Holding area', `${area.toFixed(0)} mm² (${count} × ${width}×${height})`],
    ['Tool lifts over', `${lift.toFixed(1)} mm each`],
    ['Tab top at Z', `${(p.bottomZ + height).toFixed(2)} mm`],
  ].map(([k, v]) => el('div', { class: 'cutting-row' }, [
    el('span', {}, [k]), el('span', {}, [v]),
  ])));
}

/**
 * What the chamfer settings come to on the machine.
 *
 * Width is what a drawing specifies and depth is what the tool does, and the
 * conversion runs through the cutter's point angle — so a 0.5mm chamfer is
 * 0.5mm deep with a 90° mill and 1.87mm deep with a 30° V bit. Nobody should
 * find that out from the toolpath.
 */
export function chamferReportRow(doc, op) {
  const tool = doc.project.tools.find((t) => t.id === op.toolId);
  if (!tool) return el('div', { class: 'prop-note' }, ['Assign a cutter to size the chamfer.']);

  const p = op.params;
  const g = chamferGeometry(tool, {
    width: p.chamferWidth ?? 0,
    clearance: p.chamferClearance ?? 0,
  });
  if (!g.pointed) {
    return el('div', { class: 'prop-note warn' }, [
      `${tool.name} has no point angle, so there is no cone to lay on the edge. `
      + 'Pick a chamfer mill or a V bit, or set Tip angle on the tool.',
    ]);
  }
  const widest = maxWidthFor(tool, p.chamferClearance ?? 0);
  const rows = reportRows([
    // tipAngleOf, not the raw field — a chamfer mill with the angle left blank
    // cuts at 90° and that is what the cut is computed from; reading the field
    // put "0° included (0° face)" on the line that explains the geometry
    ['Cuts at', `${tipAngleOf(tool)}° included (${(tipAngleOf(tool) / 2).toFixed(0)}° face)`],
    ['Chamfer face', `${g.faceDepth.toFixed(3)} mm tall`],
    ['Tip reaches Z', `${(p.topZ - g.drop).toFixed(3)} mm`],
    ['Widest this cutter does', `${widest.toFixed(2)} mm`],
  ]);
  return el('div', {}, [rows]);
}

/** What a bore works out to for the cutter that is in it. */
export function boreReportRow(doc, op) {
  const tool = doc.project.tools.find((t) => t.id === op.toolId);
  if (!tool) return el('div', { class: 'prop-note' }, ['Assign a cutter to size the bore.']);
  const p = op.params;
  const pitch = Math.max(0.01, p.stepdown ?? 1);
  const wanted = p.boreDiameter ?? 0;
  const lines = [
    ['Cutter', `⌀${tool.diameter} mm`],
    ['Smallest hole it fits', `⌀${(tool.diameter + 0.1).toFixed(2)} mm`],
    ['Descends', `${pitch} mm per turn`],
  ];
  if (wanted > 0) {
    const turns = Math.max(0, (p.topZ - p.bottomZ) / pitch);
    lines.push(['Turns to depth', `${turns.toFixed(1)} at ⌀${wanted}`]);
  }
  return reportRows(lines);
}

/**
 * What the slot works out to: how many lanes wide and how many passes deep.
 *
 * Both are numbers you would otherwise get by generating and counting, and both
 * decide whether the operation is a minute or twenty.
 */
export function slotReportRow(doc, op) {
  const tool = doc.project.tools.find((t) => t.id === op.toolId);
  if (!tool) return el('div', { class: 'prop-note' }, ['Assign a cutter to size the slot.']);
  const p = op.params;
  const width = (p.slotWidth ?? 0) > 0 ? p.slotWidth : tool.diameter;
  if (width < tool.diameter - 1e-6) {
    return el('div', { class: 'prop-note' }, [
      `A ${width}mm slot cannot be cut with the ⌀${tool.diameter} ${tool.name} — `
      + 'a slot is never narrower than the tool that makes it.',
    ]);
  }
  const lanes = laneOffsets((width - tool.diameter) / 2,
    Math.max(0.05, (p.stepover ?? 0.5) * tool.diameter));
  const depth = Math.max(0, (p.topZ ?? 0) - (p.bottomZ ?? 0));
  const passes = p.stepdown > 0 ? Math.max(1, Math.ceil(depth / p.stepdown - 1e-9)) : 1;
  return reportRows([
    ['Finished width', `${width.toFixed(2)} mm`],
    ['Lanes', lanes.length === 1 ? 'one, full width' : `${lanes.length} — middle then each wall`],
    ['Depth', `${depth.toFixed(2)} mm in ${pluralEs(passes, 'pass')} of ${(depth / passes).toFixed(2)}`],
    ['Entry', (p.rampAngle ?? 0) > 0 ? `ramped at ${p.rampAngle}°` : 'PLUNGED — set a ramp angle'],
  ]);
}

/** Depth against line width, so a V bit's arithmetic is on screen not in your head. */
export function engraveReportRow(doc, op) {
  const tool = doc.project.tools.find((t) => t.id === op.toolId);
  if (!tool) return el('div', { class: 'prop-note' }, ['Assign a cutter to size the mark.']);
  const p = op.params;
  const groove = grooveGeometry(tool);
  if (!groove.pointed) {
    return el('div', { class: 'prop-note' }, [
      `${tool.name} cuts a ⌀${tool.diameter}mm line at any depth — the width mode `
      + 'needs a V bit or a chamfer mill.',
    ]);
  }
  const mode = p.engraveMode ?? 'depth';
  const depth = mode === 'width'
    ? groove.depthFor(Math.max(0, p.grooveWidth ?? 0))
    : Math.max(0, p.topZ - p.bottomZ);
  return reportRows([
    ['Cuts at', `${groove.included}° included`],
    ['Depth', `${depth.toFixed(3)} mm`],
    ['Line width', `${groove.widthAt(depth).toFixed(3)} mm`],
    ['Floor of the mark', `Z ${(p.topZ - depth).toFixed(3)} mm`],
  ]);
}

/**
 * Read-out of derived cutting numbers so the user can see if their picks are sane.
 *
 * The work diameter goes in because on a lathe it is the workpiece that spins:
 * the surface speed is set by what is being cut, not by anything about the
 * tool. See `cuttingReport` — taken off the insert instead, every turning
 * operation in the app reported a speed six times slower than the truth.
 */
export function cuttingReportRow(doc, op) {
  const tool = doc.project.tools.find((t) => t.id === op.toolId);
  const setup = doc.findSetupOf(op.id);
  const stock = setup?.stock;
  const workDiameter = isRoundStock(stock) ? (stock.cylinder?.diameter ?? 0) : 0;
  const report = cuttingReport(op, tool, { workDiameter });
  if (!report) return el('div', { class: 'prop-note' }, ['Assign a tool to see cutting speeds.']);

  const fmt = (v, unit, digits = 0) => (v == null ? '—' : `${v.toFixed(digits)} ${unit}`);
  const speed = `${fmt(report.surfaceSpeed, 'm/min', 1)} (${fmt(report.surfaceSpeedSfm, 'sfm', 0)})`;
  const lines = report.lathe
    ? [
      ['Surface speed', report.constantSurfaceSpeed ? `${speed} — held (G96)` : speed],
      // one edge on an insert, and the box it came in is marked in mm/rev
      ['Feed per rev', fmt(report.feedPerRev, 'mm', 3)],
      ['At', report.diameter == null
        // round stock is what a diameter can be read from; without one the
        // speed above is a dash rather than a number nobody can act on
        ? 'no round stock on this setup to take a diameter from'
        : `⌀${report.diameter}mm of work`],
    ]
    : [
      ['Surface speed', speed],
      ['Feed per tooth', fmt(report.feedPerTooth, 'mm', 3)],
      ['At', `⌀${report.diameter}mm · ${report.flutes ?? '?'} flutes`],
    ];
  return reportRows(lines);
}

/**
 * What this operation produced, right under the tool that produced it.
 *
 * The numbers are the evidence: an operation with 0 cutting moves did nothing,
 * one whose cut length is a few millimetres barely touched the part, and one
 * that never got below Top Z is aimed at the wrong depth. The strategy's own
 * warnings sit alongside them, so the "why" arrives with the "what".
 */
export function resultSection(doc, op) {
  // No heading: this is the body of the Result tab now, and a tab whose first
  // line repeats the name of the tab is a line that says nothing.
  const rows = [];
  const blocked = opBlockedReason(doc, op);
  if (blocked) {
    rows.push(el('div', { class: `prop-note${blocked === 'disabled' ? '' : ' warn'}` }, [
      blocked === 'disabled'
        ? 'Disabled — it is skipped when generating, posting and simulating.'
        : `Cannot generate: ${blocked}.`,
    ]));
    return rows;
  }

  // problems visible from the settings alone, shown whether or not it has run
  for (const problem of opPreflight(doc, op)) {
    rows.push(el('div', { class: 'prop-note warn' }, [problem]));
  }

  const status = opStatus(doc, op);
  if (!status) {
    rows.push(el('div', { class: 'prop-note' }, ['Not generated yet — press Generate (Ctrl+G).']));
    return rows;
  }
  if (status.stale) {
    rows.push(el('div', { class: 'prop-note warn' }, [
      'Settings have changed since this was generated. The path in the viewport '
      + 'and the G-code below are the old ones — press Generate (Ctrl+G).',
    ]));
  }

  const lines = [
    ['Cutting moves', String(status.cuts + status.drills)],
    ['Cut distance', status.lengthText],
    ['Rapid distance', formatLength(status.rapidLength)],
    ['Estimated time', status.timeText],
  ];
  if (status.drills > 0) lines.splice(1, 0, ['Holes', String(status.drills)]);
  if (status.deepest != null) lines.push(['Deepest Z', `${status.deepest.toFixed(2)} mm`]);

  rows.push(el('div', { class: 'cutting-report' }, lines.map(([k, v]) =>
    el('div', { class: 'cutting-row' }, [el('span', {}, [k]), el('span', {}, [v])]))));

  if (status.empty) {
    rows.push(el('div', { class: 'prop-note warn' }, [
      'This operation produced no cutting moves.',
    ]));
  }
  for (const note of status.notes) {
    rows.push(el('div', { class: `prop-note${note.level === 'warn' ? ' warn' : ''}` }, [note.text]));
  }
  return rows;
}

/**
 * What a turning pass comes to in the units a lathe operator reads: diameters,
 * not radii.
 *
 * Everything inside CNCAM holds X as a radius because that is the geometry, and
 * every number on a lathe drawing and every word in the G-code is a diameter.
 * Showing one and posting the other without saying so is how a part comes out
 * twice as deep as it was asked for.
 */
export function turnReportRow(doc, op) {
  const tool = doc.project.tools.find((t) => t.id === op.toolId);
  const p = op.params;
  // Parting is the one operation with a single height: the blade goes in at
  // Bottom Z from whatever diameter the bar happens to be, and nothing in the
  // strategy reads Top Z. The panel already knows that and hides the field
  // (see op-params.js) — but this line went on building a span out of it, so a
  // part-off that is one plunge at Z−58 reported "Z0 to Z−58 (58.00 mm)"
  // travelled along the bar. The same fabricated number the hidden field was
  // removed for, printed as a fact one panel over.
  const lines = op.type === 'turnPart'
    ? [['Parts at', `Z${p.bottomZ} — the finished length of the part`]]
    : [['Along the bar', `Z${p.topZ} to Z${p.bottomZ} (${Math.abs(p.topZ - p.bottomZ).toFixed(2)} mm)`]];
  // Not turnFinish: it takes one pass down the profile and has no depth of cut,
  // so the line was reporting the schema's untouched 2mm — as a fact, in
  // diameters, on the one operation whose job is to hold a size. The field went
  // from the panel with it; see op-params.js.
  if (op.type === 'turnRough' || op.type === 'turnBore') {
    lines.push(['Depth of cut', `${p.stepdown} mm on radius = ${(p.stepdown * 2).toFixed(2)} mm on ⌀`]);
  }
  if (op.type === 'turnFinish') lines.push(['Passes', 'one, down the whole profile']);
  if (op.type === 'turnRough' || op.type === 'turnFinish' || op.type === 'turnBore') {
    lines.push(['Leaves', `${p.stockToLeave ?? 0} mm on radius = ${((p.stockToLeave ?? 0) * 2).toFixed(2)} mm on ⌀`]);
  }
  if (op.type === 'turnPart') {
    lines.push(['Parts down to', `⌀${((p.partOffRadius ?? 0) * 2).toFixed(2)}`]);
    if (tool?.bladeWidth > 0) lines.push(['Blade', `${tool.bladeWidth} mm wide`]);
  }
  if (op.type === 'turnGroove') {
    const blade = tool?.bladeWidth || tool?.diameter || 0;
    const width = Math.abs(p.topZ - p.bottomZ);
    lines.push(['Groove width', `${width.toFixed(2)} mm`]);
    // Blank means "a sensible depth into whatever diameter is there" and zero
    // means the centreline, which is the bar cut in half. Reported through
    // `?? 0` they were the same line, and every new grooving operation — which
    // starts blank, deliberately — read as a part-off.
    lines.push(['Floor', p.grooveRadius == null
      ? 'from the diameter it is cut into'
      : `⌀${(p.grooveRadius * 2).toFixed(2)}${p.grooveRadius === 0 ? ' — the centreline' : ''}`]);
    if (blade > 0) {
      // the strategy's own arithmetic, allowance and all — see grooveBites
      const { plunges } = grooveBites(width, blade, Math.max(0, p.stockToLeave ?? 0));
      lines.push(['Blade', `${blade} mm — ${plural(plunges, 'plunge')}`]);
      if (width < blade) {
        lines.push(['Does not fit', `the blade is ${(blade - width).toFixed(2)} mm too wide`]);
      }
    }
  }
  if (op.type === 'turnBore') {
    lines.push(['Bar reaches', p.boreDepthLimit > 0 ? `${p.boreDepthLimit} mm`
      : tool?.maxDepth > 0 ? `${tool.maxDepth} mm (from the tool)` : 'not stated']);
    if (tool?.minBore > 0) lines.push(['Needs a hole of', `⌀${tool.minBore} to get in`]);
  }
  if (op.type === 'turnDrill' && tool) {
    lines.push(['Hole', `⌀${tool.diameter} on the centreline`]);
  }
  if (op.type === 'turnFinish' || op.type === 'turnBore') {
    lines.push(['Nose radius', tool?.noseRadius > 0
      ? `${tool.noseRadius} mm, compensated`
      : 'not set — the profile will be a nose short']);
  }
  lines.push(['G-code X is', 'a diameter (the lathe post doubles it)']);
  return reportRows(lines);
}

/**
 * What a thread comes to: the depth the pitch implies, and the diameter it
 * leaves.
 *
 * A thread is the one turning operation where every number a drawing gives you
 * has to be converted before it is a coordinate — M12×1.75 says nothing about a
 * radius, and the 0.61343 that turns pitch into form depth is not something to
 * keep in your head.
 */
export function threadReportRow(doc, op) {
  const p = op.params;
  const pitch = Math.max(0.01, p.threadPitch ?? 1.5);
  const internal = !!p.threadInternal;
  const depth = p.threadDepth > 0 ? p.threadDepth : threadFormDepth(pitch, internal);
  const major = p.threadStartRadius ?? 0;
  const lines = [
    ['Pitch', `${pitch} mm — ${(25.4 / pitch).toFixed(1)} TPI`],
    ['Form depth', `${depth.toFixed(3)} mm on radius`],
    ['Passes', `${Math.max(1, Math.round(p.threadPasses ?? 6))}, sharing the chip area evenly`],
    ['Length', `${Math.abs(p.topZ - p.bottomZ).toFixed(2)} mm`],
  ];
  if (major > 0) {
    const minor = internal ? major + depth : major - depth;
    lines.push([internal ? 'Bore ⌀ → major ⌀' : 'Major ⌀ → minor ⌀',
      `⌀${(major * 2).toFixed(2)} → ⌀${(minor * 2).toFixed(2)}`]);
  } else {
    lines.push(['Starts at', 'the diameter already on the part there']);
  }
  return el('div', {}, [
    reportRows(lines),
    el('div', { class: 'prop-note warn' }, [
      'The passes are posted as straight moves. The control has to be in a '
      + 'synchronised threading mode for them to cut a thread rather than a spiral '
      + 'scratch — check the post output before you run it.',
    ]),
  ]);
}

export const REPORTS = {
  tabReport: tabReportRow,
  chamferReport: chamferReportRow,
  boreReport: boreReportRow,
  slotReport: slotReportRow,
  engraveReport: engraveReportRow,
  turnReport: turnReportRow,
  threadReport: threadReportRow,
};
