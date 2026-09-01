// Browser-only tests: the parts of the app that are DOM behaviour rather than
// geometry. Skipped under Node, where there is no document to drive.
//
// These exist because the failures they cover are invisible to every other kind
// of test. A menu that opens, highlights under the cursor and never fires its
// handler is not a logic error — the handler is correct, the wiring is correct,
// and the feature is entirely unusable. Only pressing the button finds it.

import { test, assert } from './runner.js';
import { openContextMenu, closeContextMenu } from '../app/context-menu.js';
import { toolIcon } from '../app/tool-shape.js';
import { parseNumber, formatNumber, numberInput } from '../app/number-input.js';
import { openToolWizard } from '../app/tool-wizard.js';
import { renderGcodePanel } from '../app/gcode-panel.js';
import { attachAutosave, loadSaved } from '../doc/autosave.js';
import { Document } from '../doc/document.js';
import { createModel, createOperation } from '../doc/schema.js';
import { makeBox } from './fixtures.js';
import { buildFaces } from '../geom/faces.js';

const inBrowser = typeof document !== 'undefined';

/** Press and release on an element the way a mouse does. */
function press(target) {
  const r = target.getBoundingClientRect();
  const at = { bubbles: true, clientX: r.x + 2, clientY: r.y + 2 };
  target.dispatchEvent(new PointerEvent('pointerdown', at));
  const stillAttached = document.body.contains(target);
  target.dispatchEvent(new MouseEvent('pointerup', at));
  target.dispatchEvent(new MouseEvent('click', at));
  return stillAttached;
}

/** Let the microtask that installs the dismiss listener actually run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test('a context menu item survives its own press and fires', async () => {
  if (!inBrowser) return;
  let fired = 0;
  openContextMenu({ clientX: 20, clientY: 20 }, [{ label: 'Do it', onclick: () => { fired++; } }]);
  await settle();

  const item = document.querySelector('.context-menu .context-item');
  assert.ok(item, 'the menu rendered');

  // The whole bug in one assertion. The dismiss-on-outside-press listener used
  // to fire for presses *inside* the menu too, removing the button before the
  // browser could deliver its click — so every menu in the app opened and did
  // nothing: add operation, duplicate, reorder, and all the deletes.
  const survived = press(item);
  assert.ok(survived, 'the item was torn out of the DOM by its own press');
  assert.eq(fired, 1, 'the handler did not run');
  assert.ok(!document.querySelector('.context-menu'), 'the menu stayed open afterwards');
});

test('a press outside a context menu dismisses it without firing anything', async () => {
  if (!inBrowser) return;
  let fired = 0;
  openContextMenu({ clientX: 20, clientY: 20 }, [{ label: 'Do it', onclick: () => { fired++; } }]);
  await settle();

  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 500, clientY: 500 }));
  assert.ok(!document.querySelector('.context-menu'), 'the menu should have closed');
  assert.eq(fired, 0, 'nothing should have run');
});

test('Escape closes a context menu', async () => {
  if (!inBrowser) return;
  openContextMenu({ clientX: 20, clientY: 20 }, [{ label: 'x', onclick: () => {} }]);
  await settle();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(!document.querySelector('.context-menu'), 'Escape did not close it');
});

test('opening a second menu replaces the first, leaving no orphans', async () => {
  if (!inBrowser) return;
  openContextMenu({ clientX: 20, clientY: 20 }, [{ label: 'a', onclick: () => {} }]);
  await settle();
  openContextMenu({ clientX: 60, clientY: 60 }, [{ label: 'b', onclick: () => {} }]);
  await settle();
  assert.eq(document.querySelectorAll('.context-menu').length, 1, 'two menus were open at once');
  closeContextMenu();
});

test('a menu near the bottom edge flips above the pointer instead of off-screen', async () => {
  if (!inBrowser) return;
  openContextMenu({ clientX: 10, clientY: window.innerHeight - 4 },
    Array.from({ length: 8 }, (_, i) => ({ label: `item ${i}`, onclick: () => {} })));
  await settle();
  const rect = document.querySelector('.context-menu').getBoundingClientRect();
  assert.ok(rect.bottom <= window.innerHeight + 1, 'the menu ran off the bottom of the window');
  assert.ok(rect.top >= -1, 'and it did not run off the top either');
  closeContextMenu();
});

// --- tool icons have to be legible ---
//
// An icon drawn true to a shared scale puts a Ø3 cutter at a few pixels beside
// a Ø40 face mill: technically honest and completely invisible, which is not a
// picture of anything. The sizes are compressed into a band instead — big still
// reads as bigger, small still reads.

/** Render an icon into the document and measure what actually got drawn. */
function drawn(tool, options) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-9999px;top:0';
  const svg = toolIcon(tool, options);
  host.append(svg);
  document.body.append(host);
  const box = svg.querySelector('path').getBoundingClientRect();
  const size = { w: box.width, h: box.height, boxW: svg.clientWidth };
  host.remove();
  return size;
}

test('the smallest cutter in a list is still big enough to see', () => {
  if (!inBrowser) return;
  const opts = { width: 44, height: 48, scaleTo: 40 };
  const small = drawn({ type: 'flat', diameter: 3, fluteLength: 12 }, opts);
  assert.ok(small.w > opts.width * 0.4,
    `a Ø3 next to a Ø40 drew ${small.w.toFixed(0)}px wide in a ${opts.width}px box`);
  assert.ok(small.h > 12, `and only ${small.h.toFixed(0)}px tall`);
});

test('a bigger cutter still draws bigger than a smaller one', () => {
  if (!inBrowser) return;
  const opts = { width: 44, height: 48, scaleTo: 40 };
  const sizes = [3, 6, 12, 40].map((d) =>
    drawn({ type: 'flat', diameter: d, fluteLength: d * 3 }, opts).w);
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] > sizes[i - 1],
      `the size order broke: ${sizes.map((s) => s.toFixed(0)).join(' < ')}`);
  }
});

test('the largest cutter fills its box without overflowing it', () => {
  if (!inBrowser) return;
  const big = drawn({ type: 'face', diameter: 40, fluteLength: 10 },
    { width: 44, height: 48, scaleTo: 40 });
  assert.ok(big.w <= big.boxW + 1, 'the icon overflowed its box');
  assert.ok(big.w > big.boxW * 0.8, 'the biggest cutter should nearly fill it');
});

// A cutter drawn lying down has to *be* lying down.
//
// The horizontal icons — every one in the project tree and every one in the
// tool library — were rotated the wrong way, which put the whole silhouette at
// negative x and outside a viewBox that starts at 0. What survived was a
// one-pixel sliver of the tip at the left edge, on every cutter in the app,
// while the vertical previews in the properties panel (which are not rotated)
// were perfect. That is the reported "tools are just thin lines in the sidebar".
test('a cutter laid sideways fills its row rather than collapsing to a sliver', () => {
  if (!inBrowser) return;
  const opts = { width: 68, height: 30, scaleTo: 12, orientation: 'horizontal' };
  for (const tool of [
    { type: 'flat', diameter: 6, fluteLength: 20, flutes: 2 },
    { type: 'drill', diameter: 5, tipAngle: 118, fluteLength: 40, flutes: 2 },
    { type: 'chamfer', diameter: 10, tipAngle: 90, fluteLength: 12, flutes: 1 },
    { type: 'ball', diameter: 8, fluteLength: 24, flutes: 2 },
  ]) {
    // the whole drawing, flutes *and* shank: measuring one path measures the
    // cutting section alone, which on a steep V bit is two thirds of it
    const size = drawnAll(tool, opts);
    assert.ok(size.w > opts.width * 0.6,
      `a ${tool.type} drew ${size.w.toFixed(0)}px wide in a ${opts.width}px row`);
    assert.ok(size.h > opts.height * 0.4,
      `a ${tool.type} drew only ${size.h.toFixed(0)}px tall`);
  }
});

/** The union of every part of the icon, as it appears on screen. */
function drawnAll(tool, options) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-9999px;top:0';
  host.append(toolIcon(tool, options));
  document.body.append(host);
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  for (const path of host.querySelectorAll('path')) {
    const b = path.getBoundingClientRect();
    x0 = Math.min(x0, b.left); x1 = Math.max(x1, b.right);
    y0 = Math.min(y0, b.top); y1 = Math.max(y1, b.bottom);
  }
  host.remove();
  return { w: x1 - x0, h: y1 - y0 };
}


// --- typing a number ---------------------------------------------------------
//
// `<input type="number">` parses through the *browser's* locale: on a German
// profile a full stop is rejected and on an English one a comma is, and a
// rejected keystroke leaves `.value` empty — so every caller read an empty
// string, got NaN, and put the old value back. The field refused the number and
// said nothing about why. See app/number-input.js.

test('a number is read the way it is written, comma or full stop', () => {
  assert.eq(parseNumber('0,5'), 0.5, 'a comma is a decimal point');
  assert.eq(parseNumber('0.5'), 0.5, 'and so is a full stop');
  assert.eq(parseNumber(' -12,75 '), -12.75, 'signs and spaces survive');
  assert.eq(parseNumber('118'), 118);
  assert.eq(parseNumber('1e-3'), 0.001);
  // half-typed is not wrong: these arrive on the way to a number, and come back
  // as NaN so a live handler leaves the value alone rather than writing zero
  for (const partial of ['', '-', '.', ',', '+', '--1']) {
    assert.ok(Number.isNaN(parseNumber(partial)), `"${partial}" is not yet a number`);
  }
  // A trailing separator does read as the number before it, so blurring out of
  // "5," commits 5 rather than throwing the entry away. What must not happen is
  // the *text* being tidied back to "5" while the caret is still in the field,
  // and that is the wizard's job — see keepText in app/tool-wizard.js.
  assert.eq(parseNumber('5,'), 5);
  assert.eq(parseNumber('5.'), 5);
  assert.ok(Number.isNaN(parseNumber('abc')), 'and nor is text');
  // shown back with a full stop and without float noise
  assert.eq(formatNumber(0.5), '0.5');
  assert.eq(formatNumber(25.400000000000002), '25.4');
  assert.eq(formatNumber(null), '');
});

test('a number field takes a comma, and the arrows still step it', () => {
  if (!inBrowser) return;
  const input = numberInput({ step: 0.1, min: 0, max: 10 });
  document.body.append(input);
  assert.eq(input.type, 'text', 'not a native number field');
  assert.eq(input.getAttribute('inputmode'), 'decimal', 'but still a numeric keypad');

  input.value = '0,5';
  assert.eq(parseNumber(input.value), 0.5, 'the comma reaches the field intact');

  // Up and Down were the one thing the native control gave that was worth
  // keeping, so they are handled here — from the value that is there, not
  // snapped to a step grid.
  input.value = '6,35';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  assert.eq(input.value, '6.45', 'Up adds one step to what was typed');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
  assert.eq(input.value, '5.45', 'Shift takes ten');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
  assert.eq(input.value, '4.45');
  input.value = '0.05';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.eq(input.value, '0', 'and it stops at the minimum');
  input.remove();
});

// --- the new-tool wizard fits ------------------------------------------------

test('the tool wizard shows all of itself, for every family', () => {
  if (!inBrowser) return;
  const families = ['flat', 'ball', 'bull', 'chamfer', 'drill', 'face',
    'turning', 'boring', 'parting', 'threading'];
  const problems = [];
  for (const machine of ['mill', 'turn']) {
    for (const type of families) {
      const dialog = openToolWizard({ machine, number: 1, onCreate: () => {} });
      dialog.querySelector(`.wiz-family[data-type="${type}"]`)?.click();
      // A dialog defaults to `overflow: auto`, so a wizard taller than the
      // viewport quietly grew scroll bars and cut off the bottom row of fields
      // — and, on the lathe, the Create button with them.
      if (dialog.scrollHeight > dialog.clientHeight + 1) {
        problems.push(`${machine}/${type} needs ${dialog.scrollHeight}px of ${dialog.clientHeight}px`);
      }
      const create = [...dialog.querySelectorAll('button')]
        .find((b) => b.textContent === 'Create tool');
      const cr = create.getBoundingClientRect();
      const dr = dialog.getBoundingClientRect();
      if (cr.bottom > dr.bottom + 1 || cr.top < dr.top) {
        problems.push(`${machine}/${type}: Create tool is outside the dialog`);
      }
      dialog.close();
      dialog.remove();
    }
  }
  assert.eq(problems.join('; '), '', 'every family fits');
});

test('the wizard draws the tool it opens on, before a family is clicked', () => {
  if (!inBrowser) return;
  // It used to open on an empty Sizes column and a blank preview: the initial
  // setup called setFamily on the family the draft already was, which returns
  // early, so the first render never ran until a card was clicked. A new tool
  // has to look like a tool the moment the dialog appears.
  const dialog = openToolWizard({ machine: 'turn', number: 1, onCreate: () => {} });
  assert.ok(dialog.querySelector('.wiz-family.active'), 'a family is highlighted on open');
  assert.ok(dialog.querySelector('.wiz-fields [data-key]'), 'the Sizes column is populated on open');
  assert.ok(dialog.querySelector('.wiz-preview svg'), 'and the tool is drawn on open');
  const keys = [...dialog.querySelectorAll('.wiz-field[data-key]')].map((f) => f.dataset.key);
  assert.ok(keys.includes('leadAngle') && keys.includes('mountAngle'),
    'a turning tool offers its lead and mount angle');
  dialog.close();
  dialog.remove();
});

test('the wizard opened on an existing tool keeps what was decided about it', () => {
  if (!inBrowser) return;
  // Everything on an existing tool has been decided, and a dialog that
  // re-derived the speeds the moment it opened would throw away the one thing
  // in the whole record that somebody measured.
  const tool = {
    id: 't1', number: 3, name: 'my tuned 8mm', type: 'flat', diameter: 8, flutes: 3,
    fluteLength: 25, spindleRpm: 7400, feedCut: 930, feedPlunge: 210,
    shank: [{ diameter: 8, length: 30 }], holder: [], cuttingPoints: [],
  };
  let saved = null;
  const dialog = openToolWizard({
    machine: 'mill', number: 3, tool, onCreate: (t) => { saved = t; },
  });
  const speeds = () => [...[...dialog.querySelectorAll('.wiz-fields')][1]
    .querySelectorAll('input')].map((i) => i.value);
  assert.eq(speeds().join(','), '7400,930,210', 'the speeds are the tool\'s own');
  assert.eq(dialog.querySelector('.wiz-name').value, 'my tuned 8mm');
  assert.eq(dialog.querySelector('.wiz-family.active')?.dataset.type, 'flat');
  // and it is an edit, so there is nothing to file a copy of
  assert.eq(dialog.querySelector('input[type="checkbox"]'), null);

  // A different family *is* a different tool, so its speeds are the new
  // family's — a drill at 7400rpm is the fault the wizard exists to prevent.
  dialog.querySelector('.wiz-family[data-type="drill"]').click();
  assert.ok(Number(speeds()[0]) < 4000, `a drill at ${speeds()[0]}rpm`);

  dialog.querySelector('.wiz-family[data-type="flat"]').click();
  [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Save changes').click();
  assert.ok(saved, 'Save changes hands back a tool');
  assert.eq(saved.name, 'my tuned 8mm', 'and has not renamed it');
  dialog.remove();
});

// --- the G-code listing ------------------------------------------------------

test('the G-code listing draws the window you are looking at, not the whole file', () => {
  if (!inBrowser) return;
  const lines = 40000;
  const text = Array.from({ length: lines }, (_, i) => `N${i} G1 X${i}`).join('\n');
  const program = { text, lineMap: new Map([[10, { op: 0, move: 0 }]]), ops: [{ cl: null }] };
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-9999px;top:0;width:400px;height:170px;'
    + 'display:flex;flex-direction:column;font:12px/1.45 Consolas, monospace';
  document.body.append(host);
  try {
    renderGcodePanel(host, program, { viewport: { setMarker() {} } });
    const view = host.querySelector('.gcode-lines');
    // a panel this tall holds ten rows; a few dozen nodes is the whole listing
    assert.ok(host.querySelectorAll('.gcode-line').length < 60,
      `${host.querySelectorAll('.gcode-line').length} rows in the DOM for ${lines} lines`);
    assert.ok(view.scrollHeight > lines * 10,
      `the scrollbar is the length of the file, got ${view.scrollHeight}px`);
    assert.ok(host.textContent.includes(`${lines} lines`), 'and the bar says how long it is');

    // …and the row you scroll to is the row you asked for, every time
    for (const at of [0, 137, 19999, lines - 1]) {
      view.scrollTop = at * 17;
      view.dispatchEvent(new Event('scroll'));
      const row = view.querySelector(`.gcode-line[data-line="${at}"]`);
      assert.ok(row, `line ${at} is drawn when it is scrolled to`);
      assert.eq(row.textContent.trim().split(/\s+/)[0], String(at + 1),
        `and its number matches its place in the file`);
    }
  } finally {
    host.remove();
  }
});

// --- autosave ----------------------------------------------------------------

test('an autosaved CAD model keeps its B-rep faces', async () => {
  if (!inBrowser) return;
  // Autosave carried its own copy of the base64 codec, and the copy did not know
  // about `faceRanges` — so a STEP import came back from a reload with its face
  // grouping gone and picking fell back to one face per triangle on exactly the
  // models that know what their faces are. It goes through mesh-codec.js now,
  // which is the same encoder a saved .cncam file uses.
  const doc = new Document();
  const model = createModel('cad part');
  const box = makeBox(10, 10, 10);
  const faceRanges = [];
  for (let f = 0; f < 6; f++) faceRanges.push({ first: f * 2, last: f * 2 + 1, faceId: f });
  doc.addModel(model, { ...box, faceRanges });

  // this test writes to the same keys the running session autosaves to
  const kept = ['cncam.project', 'cncam.meshes'].map((k) => [k, localStorage.getItem(k)]);
  const stop = attachAutosave(doc);
  try {
    doc.emitChange('test');
    await new Promise((r) => setTimeout(r, 600));
    stop();
    const back = loadSaved()?.meshes?.get(model.id);
    assert.ok(back, 'the mesh came back');
    assert.eq(back.indices.length, box.indices.length, 'with all its triangles');
    assert.eq(back.faceRanges?.length, 6, 'and its B-rep faces');
    assert.eq(buildFaces(back).faces.length, 6, 'so picking still selects whole faces');
  } finally {
    stop();
    for (const [k, v] of kept) {
      if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    }
  }
});

// A part-off has one height. The blade goes in at Bottom Z from whatever
// diameter the bar happens to be, and nothing in the strategy reads Top Z —
// which is why op-params.js hides the field. The read-out beside it went on
// building a span out of the hidden field anyway, so a part-off that is a
// single plunge at Z-58 reported "Z0 to Z-58 (58.00 mm)" travelled along the
// bar: the same fabricated number the field was removed for, printed as a fact
// one panel over.
test('a part-off reports the one height it actually has', async () => {
  if (!inBrowser) return;
  const { turnReportRow } = await import('../app/props/reports.js');
  const doc = new Document();
  const read = (type, params) => {
    const op = createOperation(type);
    Object.assign(op.params, params);
    return turnReportRow(doc, op).textContent;
  };

  const parting = read('turnPart', { topZ: 0, bottomZ: -58, partOffRadius: 0 });
  assert.ok(/Z-58/.test(parting), `it says where the blade goes in: ${parting}`);
  assert.ok(!/58\.00 mm/.test(parting),
    `and does not claim 58mm of travel along the bar: ${parting}`);
  assert.ok(!/Along the bar/.test(parting),
    `a single plunge does not run along anything: ${parting}`);

  // every other turning pass really does have two, and keeps them
  const rough = read('turnRough', { topZ: 0, bottomZ: -30, stepdown: 1, stockToLeave: 0.3 });
  assert.ok(/Along the bar/.test(rough), `roughing still spans the bar: ${rough}`);
  assert.ok(/30\.00 mm/.test(rough), `and says how far: ${rough}`);
});
