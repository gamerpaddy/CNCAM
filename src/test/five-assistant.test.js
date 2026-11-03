// The 5-axis setup assistant: a checklist of what has to be true of the machine,
// the part and the cutter, each item right or wrong for a reason a person can act on.

import { test, assert } from './runner.js';
import { fiveAxisChecks, undercutShare } from '../engine/five/assistant.js';
import { createMachine, rotaryPreset } from '../doc/machines.js';
import { createSetup, createOperation, createTool } from '../doc/schema.js';
import { makeBox, makeRevolved, makeMushroom } from './fixtures.js';

function machineOf(kind, extra = {}) {
  return createMachine({ kind: 'mill', name: `m-${kind}`, rotary: rotaryPreset(kind), ...extra });
}

function ready(extra = {}) {
  const setup = createSetup();
  setup.five = { enabled: true, pivot: [0, 0, -100], signChecked: true };
  return Object.assign(setup, extra);
}

const find = (result, id) => result.items.find((i) => i.id === id);
const of = (level, result) => result.items.filter((i) => i.level === level);

test('a trunnion machine, a pivot and a confirmed direction is a checklist with nothing wrong in it', () => {
  const r = fiveAxisChecks({ setup: ready(), machine: machineOf('AC') });
  assert.eq(r.errors, 0);
  assert.eq(find(r, 'machine').level, 'ok');
  assert.eq(find(r, 'pivot').level, 'ok');
  assert.eq(find(r, 'sign').level, 'ok');
});

test('a machine with no tilting table is an error, with a way to fix it', () => {
  for (const kind of ['none', 'A', 'B']) {
    const r = fiveAxisChecks({ setup: ready(), machine: machineOf(kind) });
    const item = find(r, 'machine');
    assert.eq(item.level, 'error', kind);
    assert.eq(item.fix.id, 'machines');
    assert.ok(r.errors >= 1);
  }
});

test('indexing and wrapping the same setup are errors, each with its own fix', () => {
  const r = fiveAxisChecks({
    setup: ready({ index: { enabled: true }, wrap: { enabled: true, axis: 'A', diameter: 30 } }),
    machine: machineOf('AC'),
  });
  assert.eq(find(r, 'index').level, 'error');
  assert.eq(find(r, 'index').fix.id, 'indexOff');
  assert.eq(find(r, 'wrap').level, 'error');
  assert.eq(find(r, 'wrap').fix.id, 'wrapOff');
});

test('without tool-centre-point the rotary centre is required, and with it, merely useful', () => {
  const noPivot = ready();
  noPivot.five.pivot = null;
  const post = fiveAxisChecks({ setup: noPivot, machine: machineOf('AC', { tcp: 'none' }) });
  assert.eq(find(post, 'pivot').level, 'error');
  const control = fiveAxisChecks({ setup: noPivot, machine: machineOf('AC', { tcp: 'kins' }) });
  assert.eq(find(control, 'pivot').level, 'info');
});

test('the directions of A and C are a warning until somebody says they have jogged them', () => {
  const setup = ready();
  setup.five.signChecked = false;
  const r = fiveAxisChecks({ setup, machine: machineOf('AC') });
  const item = find(r, 'sign');
  assert.eq(item.level, 'warn');
  assert.eq(item.fix.id, 'sign');
  assert.ok(/mirror/.test(item.detail), 'it says what a wrong one costs');
});

test('an operation allowed to lean further than the tilt axis swings is flagged by name', () => {
  const op = createOperation('finish5');
  op.name = 'Finish the dome';
  op.params.maxTilt = 50;
  const tight = machineOf('AC');
  tight.rotary = tight.rotary.map((a) => (a.letter === 'A' ? { ...a, min: -30, max: 30 } : a));
  const r = fiveAxisChecks({
    setup: ready(), machine: tight, ops: [{ op, tool: createTool('ball'), cl: null }],
  });
  const item = r.items.find((i) => i.id.startsWith('limit-'));
  assert.ok(item && item.level === 'warn', JSON.stringify(r.items.map((i) => i.id)));
  assert.ok(/Finish the dome/.test(item.title) && /30/.test(item.detail));
});

test('a cutter with no holder described, and a flat end mill, are each said', () => {
  const op = createOperation('finish5');
  const ball = createTool('ball');
  ball.holder = [];
  const flat = createTool('flat');
  const r = fiveAxisChecks({
    setup: ready(),
    machine: machineOf('AC'),
    ops: [{ op, tool: ball, cl: null }, { op, tool: flat, cl: null }],
  });
  assert.ok(r.items.some((i) => i.id === `holder-${ball.id}` && i.level === 'warn'));
  assert.ok(r.items.some((i) => i.id === `flat-${flat.id}`));
  assert.ok(find(r, 'fixtures'), 'and that no clamps are modelled');
});

test('a part with an overhang is a warning, and a plain block is not', () => {
  const block = fiveAxisChecks({ setup: ready(), machine: machineOf('AC'), mesh: makeBox(20, 20, 10) });
  assert.eq(find(block, 'part').level, 'ok');
  // the mushroom's cap overhangs its post: a large face looking down with metal under it nowhere
  // — it is the cap's underside, which faces down above the base
  const { mesh } = makeMushroom();
  const mush = fiveAxisChecks({ setup: ready(), machine: machineOf('AC'), mesh });
  assert.eq(find(mush, 'part').level, 'warn');
  assert.ok(/undercut/i.test(find(mush, 'part').title));
});

test('the share of a part that faces down above its base is measured, not guessed', () => {
  const { share, area } = undercutShare(makeMushroom().mesh);
  assert.ok(share > 0.1 && area > 100, `${(share * 100).toFixed(1)}% / ${area.toFixed(0)}mm²`);
  const dome = [[0, 0], [10, 0]];
  for (let d = 10; d <= 90; d += 10) dome.push([10 * Math.cos((d * Math.PI) / 180), 10 * Math.sin((d * Math.PI) / 180)]);
  assert.close(undercutShare(makeRevolved(dome, 32)).share, 0, 1e-9, 'a dome has none');
  assert.eq(undercutShare(null).share, 0);
});
