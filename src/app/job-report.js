// The job report: what an operator needs on the bench beside the machine.
//
// The setup sheet used to print `tool.spindleRpm` and `tool.feedCut` straight
// off the tool, so an operation that overrides either — a gentler finishing
// feed, a slower plunge spindle — was printed with a number the program does
// not use. This is the one place that works the numbers out, from the same
// `effectiveCutting` the post and the panel read, and it returns data rather
// than elements so a test can check the figures without a page. The renderer in
// workflow-tools.js only lays it out.

import { effectiveCutting } from '../engine/cutting.js';
import { estimateSeconds } from '../engine/toolpath.js';
import { opFingerprint, formatTime, toolChangesIn } from './op-status.js';

const TOOL_NAMES = {
  flat: 'End mill', ball: 'Ball nose', bull: 'Bull nose', drill: 'Drill', spot: 'Spot drill',
  tap: 'Tap', threadmill: 'Thread mill', chamfer: 'Chamfer / V bit', face: 'Face mill',
  turning: 'Turning tool', boring: 'Boring bar', parting: 'Parting blade', threading: 'Threading tool',
};

/** One operation's status as a sentence the sheet can print. */
function statusOf(doc, op, setup) {
  if (!op.enabled) return 'Disabled';
  const failure = doc.failures.get(op.id);
  if (failure) return String(failure);
  if (!doc.toolpaths.has(op.id)) return 'Not generated';
  return doc.fingerprints.get(op.id) === opFingerprint(doc, op, setup)
    ? 'Generated' : 'Out of date — generate again';
}

/** The stock's size as text, or `not resolved` when no model gave it a size. */
export function stockSizeText(stock) {
  if (!stock?.min || !stock?.max) return 'not resolved';
  return `${stock.max.map((v, i) => (v - stock.min[i]).toFixed(2)).join(' × ')} mm`;
}

/**
 * @param doc the document
 * @param options.stockFor (setup) => resolved stock `{min, max}` or null
 * @param options.sim the simulation result for the active setup, when one is
 *   showing — its verify figures are put on the sheet, and only if present
 * @param options.now a Date, so a test is not at the mercy of the clock
 */
export function buildJobReport(doc, { stockFor = null, sim = null, now = new Date() } = {}) {
  const machine = doc.machineRecord();
  const rapid = doc.rapidFeed();
  const changeSeconds = machine?.toolChangeSeconds ?? 0;
  const tools = doc.project.tools;

  const usage = new Map();         // tool id -> { operations: [names], rpm: [...], feed: [...] }
  const setups = [];
  let totalSeconds = 0;
  let totalChanges = 0;
  let totalOps = 0;
  let fitted = null;

  for (const setup of doc.setups()) {
    const stock = stockFor?.(setup) ?? null;
    const rows = [];
    let seconds = 0;
    for (const op of setup.operations) {
      const tool = tools.find((t) => t.id === op.toolId) ?? null;
      const cl = doc.toolpaths.get(op.id) ?? null;
      const c = effectiveCutting(op, tool);
      const opSeconds = cl ? estimateSeconds(cl, rapid) : 0;
      // A command writes G-code and moves nothing, so it has no tool to speak of
      const isCommand = op.type === 'command';
      const cuts = op.enabled && !isCommand;
      const changesHere = cuts ? toolChangesIn(doc, [op], fitted).changes : 0;
      if (cuts && tool) {
        if (!(cl && cl.count === 0)) fitted = tool.number;
        totalOps++;
        if (!usage.has(tool.id)) usage.set(tool.id, { operations: [], seconds: 0 });
        const u = usage.get(tool.id);
        u.operations.push(op.name || op.type);
        u.seconds += opSeconds;
      }
      if (cuts) seconds += opSeconds;
      totalChanges += changesHere;
      rows.push({
        id: op.id,
        name: op.name || op.type,
        type: op.type,
        enabled: !!op.enabled,
        command: isCommand,
        tool: tool && !isCommand ? { number: tool.number, name: tool.name, diameter: tool.diameter } : null,
        // what the program actually uses: the operation's own number where it
        // has one, the tool's where it does not
        rpm: isCommand || !tool ? null : c.spindleRpm || null,
        feed: isCommand || !tool ? null : c.feedCut || null,
        plunge: isCommand || !tool ? null : c.feedPlunge || null,
        overrides: !!op.params && [op.params.spindleRpm, op.params.feedCut, op.params.feedPlunge]
          .some((v) => typeof v === 'number' && v >= 1),
        seconds: cl ? opSeconds : null,
        timeText: cl ? formatTime(opSeconds) : '—',
        changesTool: changesHere > 0,
        status: statusOf(doc, op, setup),
        notes: cl?.notes?.length ? cl.notes.length : 0,
      });
    }
    totalSeconds += seconds;
    setups.push({
      id: setup.id,
      name: setup.name,
      mode: setup.mode,
      wcs: setup.wcs ?? null,
      stock: setup.stock,
      stockSize: stockSizeText(stock),
      fixtures: (setup.fixtures ?? []).map((f) => f.name || f.kind),
      rows,
      seconds,
      timeText: formatTime(seconds),
    });
  }

  const toolRows = tools
    .filter((t) => usage.has(t.id))
    .sort((a, b) => a.number - b.number)
    .map((t) => {
      const shank = t.shank?.[0] ?? null;
      const stickOut = (t.shank ?? []).reduce((sum, s) => sum + (s.length ?? 0), 0);
      return {
        id: t.id,
        number: t.number,
        name: t.name,
        kind: TOOL_NAMES[t.type] ?? t.type,
        diameter: t.diameter,
        flutes: t.flutes ?? null,
        fluteLength: t.fluteLength ?? null,
        shankDiameter: shank?.diameter ?? null,
        // How far the cutter must stand out of the holder: the shank stack the
        // tool describes, which is the figure the operator sets with a gauge.
        stickOut: stickOut > 0 ? stickOut : null,
        operations: usage.get(t.id).operations,
        image: t.image ?? null,
      };
    });

  const totalWithChanges = totalSeconds + totalChanges * changeSeconds;
  return {
    project: doc.project.name,
    generatedAt: now.toLocaleString(),
    machine: machine?.name || doc.machine || '',
    post: doc.postId(),
    setups,
    tools: toolRows,
    totals: {
      operations: totalOps,
      toolChanges: totalChanges,
      toolChangeSeconds: changeSeconds,
      cuttingSeconds: totalSeconds,
      seconds: totalWithChanges,
      timeText: formatTime(totalWithChanges),
    },
    verify: verifySummary(sim),
  };
}

/** The check of the finished part, in the words the sheet prints; null without one. */
export function verifySummary(sim) {
  const v = sim?.verify;
  if (!v) return null;
  const mm = (x) => (Number.isFinite(x) ? `${x.toFixed(3)} mm` : '—');
  return {
    tolerance: v.tolerance ?? null,
    worstGouge: Number.isFinite(v.worstGouge) ? v.worstGouge : null,
    worstExcess: Number.isFinite(v.worstExcess) ? v.worstExcess : null,
    gougeCells: v.gougeCells ?? 0,
    excessCells: v.excessCells ?? 0,
    lines: [
      `Worst cut into the part: ${mm(v.worstGouge)}${v.gougeCells ? ` (${v.gougeCells} cells)` : ''}`,
      `Worst metal left on the part: ${mm(v.worstExcess)}${v.excessCells ? ` (${v.excessCells} cells)` : ''}`,
    ],
    findings: (sim.findings ?? []).map((f) => (typeof f === 'string' ? f : f?.text ?? '')).filter(Boolean),
  };
}

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The report as one self-contained page: no script, no external file, its own
 * print style — so it opens anywhere, prints, and is still the same sheet when
 * it is emailed to the shop floor a month later.
 */
export function reportToHtml(report) {
  const e = escapeHtml;
  const cell = (value) => `<td>${e(value ?? '—')}</td>`;
  const parts = [];
  parts.push(`<h1>${e(report.project)}</h1>`);
  parts.push(`<p>Setup and tool sheet · ${e(report.generatedAt)} · Machine: ${e(report.machine)} · Post: ${e(report.post)}</p>`);
  parts.push(`<p><strong>Total ${e(report.totals.timeText)}</strong> — ${report.totals.operations} operations, `
    + `${report.totals.toolChanges} tool change${report.totals.toolChanges === 1 ? '' : 's'}</p>`);
  if (report.tools.length) {
    parts.push('<h2>Tools</h2><table><thead><tr>'
      + ['T', 'Tool', 'Type', 'Ø mm', 'Flutes', 'Stick-out mm', 'Used by'].map((h) => `<th>${h}</th>`).join('')
      + '</tr></thead><tbody>'
      + report.tools.map((t) => `<tr>${[`T${t.number}`, t.name, t.kind, t.diameter, t.flutes, t.stickOut, t.operations.join(', ')]
        .map(cell).join('')}</tr>`).join('')
      + '</tbody></table>');
  }
  for (const s of report.setups) {
    parts.push(`<h2>${e(s.name)}</h2><p>Work offset: ${e(s.wcs ?? 'not specified')} · Stock: ${e(s.stockSize)}`
      + ` · Fixtures: ${e(s.fixtures.join(', ') || 'none')} · Time: ${e(s.timeText)}</p>`);
    parts.push('<table><thead><tr>'
      + ['Operation', 'Tool', 'RPM', 'Cut feed (mm/min)', 'Plunge', 'Time', 'Status'].map((h) => `<th>${h}</th>`).join('')
      + '</tr></thead><tbody>'
      + s.rows.map((r) => `<tr>${[
        r.name + (r.changesTool ? ' (tool change)' : ''),
        r.tool ? `T${r.tool.number} ${r.tool.name}` : (r.command ? 'G-code block' : 'No tool'),
        r.rpm, r.feed, r.plunge, r.timeText, r.status,
      ].map(cell).join('')}</tr>`).join('')
      + '</tbody></table>');
  }
  if (report.verify) {
    parts.push('<h2>Check of the finished part</h2>'
      + `<ul>${report.verify.lines.map((l) => `<li>${e(l)}</li>`).join('')}</ul>`
      + (report.verify.findings.length ? `<ul>${report.verify.findings.map((l) => `<li>${e(l)}</li>`).join('')}</ul>` : ''));
  }
  parts.push('<p><em>Programmed values are shown. Verify tool assignments, stock, offsets and the simulation before machining. '
    + 'The output of this program must be checked line by line before it is run.</em></p>');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + `<title>${e(report.project)} — setup sheet</title>`
    + '<style>body{font:14px system-ui,sans-serif;margin:24px;color:#111}table{width:100%;border-collapse:collapse;margin-bottom:16px}'
    + 'th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #ccc}tr{break-inside:avoid}</style>'
    + `</head><body>${parts.join('')}</body></html>`;
}
