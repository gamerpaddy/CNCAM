// The job report: the figures the sheet beside the machine prints. A sheet that
// prints the tool's own feed for an operation that overrides it is a sheet that
// lies about the program, so the numbers are checked here, not on a page.

import { test, assert } from './runner.js';
import { Document } from '../doc/document.js';
import { createOperation, createSetup, createTool } from '../doc/schema.js';
import { generateToolpath } from '../engine/toolpath.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { makePocketAndHole } from './fixtures.js';
import { buildJobReport, reportToHtml, verifySummary } from '../app/job-report.js';
import { opFingerprint } from '../app/op-status.js';

function jobWithTwoTools() {
  const doc = new Document();
  const mill = Object.assign(createTool('flat'), { number: 1, name: 'EM 6', diameter: 6, spindleRpm: 10000, feedCut: 800, feedPlunge: 300 });
  const drill = Object.assign(createTool('drill'), { number: 2, name: 'Drill 5', diameter: 5, spindleRpm: 6000, feedCut: 300, feedPlunge: 150 });
  doc.addTool(mill);
  doc.addTool(drill);
  const setup = createSetup('Setup 1');
  doc.addSetup(setup);
  const { mesh } = makePocketAndHole({ size: 60, pocketSize: 20, height: 10, depth: 6, holeR: 2.5 });
  const stock = { kind: 'box', min: [0, 0, 0], max: [60, 60, 10] };
  const ops = [];
  for (const [type, tool, over] of [['pocket', mill, { feedCut: 400 }], ['contour2d', mill, {}], ['drill', drill, {}]]) {
    const op = createOperation(type);
    op.toolId = tool.id;
    op.name = `${type} op`;
    Object.assign(op.params, defaultParamsFor(type, { stock, tool }), over);
    doc.addOperation(setup, op);
    const cl = generateToolpath({ type, name: op.name, tool, mesh, stock, params: op.params });
    doc.toolpaths.set(op.id, cl);
    doc.fingerprints.set(op.id, opFingerprint(doc, op, setup));
    ops.push(op);
  }
  return { doc, setup, ops, mill, drill, stock };
}

test('the report prints what the program uses: an operation\'s own feed over its tool\'s', () => {
  const { doc, ops } = jobWithTwoTools();
  const r = buildJobReport(doc);
  const rows = r.setups[0].rows;
  assert.eq(rows[0].feed, 400, 'the pocket overrides the feed');
  assert.ok(rows[0].overrides, 'and says it does');
  assert.eq(rows[1].feed, 800, 'the contour inherits the tool\'s');
  assert.ok(!rows[1].overrides);
  assert.eq(rows[0].rpm, 10000);
  assert.eq(rows[0].plunge, 300);
  assert.eq(rows[2].tool.number, 2);
  assert.eq(rows.length, ops.length);
});

test('tool changes are counted as the post writes them: a repeat of the fitted tool is none', () => {
  const { doc } = jobWithTwoTools();
  const r = buildJobReport(doc);
  // end mill, end mill, drill: two changes — the second pass keeps the first's tool
  assert.eq(r.totals.toolChanges, 2);
  assert.ok(!r.setups[0].rows[1].changesTool, 'the second end-mill pass changes nothing');
  assert.ok(r.setups[0].rows[2].changesTool, 'the drill does');
});

test('the tool list is the tools used, in number order, each with what it is used by', () => {
  const { doc } = jobWithTwoTools();
  const r = buildJobReport(doc);
  assert.eq(JSON.stringify(r.tools.map((t) => t.number)), '[1,2]');
  assert.eq(r.tools[0].operations.length, 2);
  assert.eq(r.tools[1].operations.length, 1);
  assert.ok(r.tools[0].stickOut > 0, 'the stick-out comes from the shank stack');
  // an unused tool is not on the bench list
  doc.addTool(Object.assign(createTool('ball'), { number: 9, name: 'unused' }));
  assert.eq(buildJobReport(doc).tools.length, 2);
});

test('the total is the cutting time plus every tool change at the machine\'s change time', () => {
  const { doc } = jobWithTwoTools();
  const r = buildJobReport(doc);
  const cutting = r.setups[0].rows.reduce((s, row) => s + (row.seconds ?? 0), 0);
  assert.close(r.totals.cuttingSeconds, cutting, 1e-6);
  assert.close(r.totals.seconds, cutting + r.totals.toolChanges * r.totals.toolChangeSeconds, 1e-6);
  assert.ok(r.totals.seconds > 0);
});

test('a disabled or ungenerated operation is said so and adds no time', () => {
  const { doc, ops } = jobWithTwoTools();
  ops[1].enabled = false;
  doc.toolpaths.delete(ops[2].id);
  const rows = buildJobReport(doc).setups[0].rows;
  assert.eq(rows[1].status, 'Disabled');
  assert.eq(rows[2].status, 'Not generated');
  assert.eq(rows[2].timeText, '—');
});

test('an edit after generating reads as out of date', () => {
  const { doc, ops } = jobWithTwoTools();
  ops[0].params.stepover = 0.9;
  assert.ok(buildJobReport(doc).setups[0].rows[0].status.startsWith('Out of date'));
});

test('the check of the finished part is on the sheet only when there was one', () => {
  const { doc } = jobWithTwoTools();
  assert.eq(buildJobReport(doc).verify, null);
  const v = verifySummary({ verify: { worstGouge: 0.02, worstExcess: 0.31, gougeCells: 4, excessCells: 90, tolerance: 0.05 },
    findings: [{ text: 'holder in the wall' }, 'plain text'] });
  assert.eq(JSON.stringify(v.findings), '["holder in the wall","plain text"]');
  assert.ok(v.lines[0].includes('0.020 mm') && v.lines[1].includes('0.310 mm'));
  assert.eq(verifySummary({}), null);
});

test('the saved page escapes what the user typed and needs no script', () => {
  const { doc, ops } = jobWithTwoTools();
  ops[0].name = '<script>alert(1)</script> & "q"';
  const html = reportToHtml(buildJobReport(doc));
  assert.ok(!html.includes('<script>'), 'a name cannot inject markup');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('Programmed values are shown'));
});
