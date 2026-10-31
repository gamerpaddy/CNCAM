// What the engine does with a setting that is nonsense, rather than merely wrong.
//
// A panel keeps a number inside its field's range, and a project file does not.
// Everything here arrives through `generateToolpath` with a value the panel
// would never have let through — NaN, a string, 1e9, 1e-9 — and has to come
// back as either a program or a sentence, promptly. Not a hang, not NaN on
// every line, not a RangeError about an array.

import { test, assert } from './runner.js';
import { generateToolpath, toolpathStats } from '../engine/toolpath.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { eachMove } from '../engine/cl.js';
import { depthPasses, MAX_DEPTH_PASSES } from '../engine/stock.js';
import { paramLimits, clampParams, SETTING_CEILING } from '../engine/param-limits.js';
import { makePocketBlock } from './fixtures.js';
import { effectiveCutting } from '../engine/cutting.js';
import { loadSaved } from '../doc/autosave.js';
import { storeAvailable } from '../doc/project-store.js';
import { describeRepairs } from '../doc/repair.js';
import { deserializeProject } from '../doc/schema.js';
import { encodeMesh, decodeMesh } from '../doc/mesh-codec.js';
import { userCatalogsFor, saveUserTool, removeUserTool, deserializeLibrary } from '../doc/tool-library.js';

const FLAT = {
  number: 1, type: 'flat', name: '6mm flat', diameter: 6, tipAngle: 0, tipDiameter: 0,
  fluteLength: 20, flutes: 2, spindleRpm: 10000, feedCut: 800, feedPlunge: 300,
};
const block = makePocketBlock({ size: 40, pocketSize: 20, height: 20, depth: 12 });
const STOCK = { kind: 'box', min: [-3, -3, 0], max: [43, 43, 20] };   // proud of the block: an outside contour needs stock to cut

function run(type, patch = {}, tool = FLAT) {
  const params = {
    ...defaultParamsFor(type, { stock: STOCK, tool }), tolerance: 0.05, topZ: 20, bottomZ: 8, ...patch,
  };
  const started = Date.now();
  const cl = generateToolpath({ type, name: type, tool, mesh: block.mesh, stock: STOCK, params, fixtures: [] });
  return { cl, ms: Date.now() - started, stats: toolpathStats(cl) };
}

function allFinite(cl) {
  let bad = 0;
  eachMove(cl, (op, x, y, z) => { if (![x, y, z].every(Number.isFinite)) bad++; });
  return bad === 0;
}

test('a setting that is not a number is refused by name, and nothing is generated from it', () => {
  for (const [type, key, value] of [
    ['face', 'stepover', NaN], ['contour2d', 'topZ', NaN], ['pocket', 'clearanceHeight', NaN],
    ['clear2d', 'bottomZ', NaN], ['adaptive', 'stockToLeave', Infinity], ['slot', 'stepdown', 'deep'],
    ['parallel3d', 'stepover', 'x'], ['engrave', 'topZ', 'x'], ['chamfer', 'chamferWidth', {}],
    ['chamfer', 'topZ', null], ['face', 'bottomZ', null], ['drill', 'clearanceHeight', null],
  ]) {
    const { cl, stats } = run(type, { [key]: value });
    assert.eq(cl.count, 0, `${type} ${key}=${String(value)}: no moves`);
    assert.ok(stats.warnings.some((w) => w.text.includes(key)), `${type}: the warning names ${key}`);
  }
  // and a cutter whose number went the same way
  const { cl, stats } = run('face', {}, { ...FLAT, fluteLength: NaN });
  assert.eq(cl.count, 0);
  assert.ok(stats.warnings.some((w) => /fluteLength/.test(w.text)), 'the cutter\'s field is named');
});

test('a value outside the panel\'s range is held to it, and the program says so', () => {
  const table = paramLimits();
  assert.eq(table.finishPasses.max, 20, 'the range is the panel\'s own, not a second copy');
  assert.eq(table.tolerance.min, 0.001);
  const held = clampParams({ finishPasses: 1e9, tolerance: -1, stepover: 0.5, topZ: 1e9 });
  assert.eq(held.params.finishPasses, 20);
  assert.eq(held.params.tolerance, 0.001);
  assert.eq(held.params.stepover, 0.5, 'a value in range is untouched');
  assert.eq(held.params.topZ, SETTING_CEILING, 'and a field with no range is held to the size no setting has');
  assert.eq(clampParams({ topZ: 120 }).params.topZ, 120, 'ordinary heights are not touched');
  assert.eq(clampParams({ stepover: 0.5 }).notes.length, 0);

  // a billion finishing passes was a loop that never ended
  const { cl, ms, stats } = run('clear2d', { finishPasses: 1e9 });
  assert.ok(ms < 10000, `it came back in ${ms}ms`);
  assert.ok(cl.count > 0 && allFinite(cl));
  assert.ok(stats.warnings.some((w) => /finishPasses/.test(w.text)), 'and says what it did');
});

test('a tolerance of nothing is a contour that finishes', () => {
  // a cutter path divided into steps of 0 ran for ever; see geom/clipper.js too
  for (const tolerance of [0, -1, 1e-9]) {
    const { cl, ms } = run('contour2d', { tolerance });
    assert.ok(ms < 10000, `tolerance ${tolerance}: ${ms}ms`);
    assert.ok(cl.count > 0 && allFinite(cl), `tolerance ${tolerance}: a real program`);
  }
});

test('a stepdown that is billions of passes is refused in words, at once', () => {
  assert.throws(() => depthPasses(20, 8, 1e-9), 'depthPasses refuses');
  let message = '';
  const started = Date.now();
  try { depthPasses(20, -1e9, 2); } catch (err) { message = err.message; }
  assert.ok(Date.now() - started < 1000, 'without building the levels first');
  assert.ok(/passes/.test(message) && /Stepdown/.test(message), `a sentence: ${message}`);
  assert.eq(depthPasses(20, 8, 2).length, 6, 'ordinary depths are unchanged');
  assert.eq(depthPasses(60, 10, 0.01, {}).length, 5000, 'the least stepdown the panel allows, down 50mm, is still allowed');
  assert.ok(MAX_DEPTH_PASSES >= 5000);
  for (const type of ['face', 'contour2d', 'pocket', 'clear2d']) {
    let said = '';
    try { run(type, { bottomZ: -1e9 }); } catch (err) { said = err.message; }
    assert.ok(/passes/.test(said), `${type}: a Bottom Z a billion down says why it will not`);
  }
  // a stepdown below the panel's least is raised to it, with a warning, not 12 billion levels
  const { cl, stats } = run('face', { stepdown: 1e-9 });
  assert.ok(cl.count > 0 && stats.warnings.some((w) => /stepdown/.test(w.text)));
});

test('a cut that ends above where it starts has no depth, and says so', () => {
  // the strategies read it as a cut at Bottom Z: a program at a billion mm
  for (const type of ['face', 'contour2d', 'pocket', 'clear2d', 'adaptive', 'slot']) {
    const { cl, stats } = run(type, { bottomZ: 1e9 });
    assert.eq(cl.count, 0, `${type}: nothing generated`);
    assert.ok(stats.warnings.some((w) => /above Top Z/.test(w.text)), `${type}: says Bottom Z is above Top Z`);
  }
});

test('a billet a hundred kilometres long is refused in words, not planned over', () => {
  // a Margin Y typed as 1e9 is stock two billion mm long: facing threw "Invalid
  // array length" and adaptive clearing never came back
  for (const type of ['face', 'adaptive', 'clear2d', 'pocket', 'contour2d']) {
    const huge = { kind: 'box-margin', min: [-21, -1e9, -21], max: [21, 1e9, 0] };
    const params = { ...defaultParamsFor(type, { stock: STOCK, tool: FLAT }), tolerance: 0.05, topZ: 0, bottomZ: -8 };
    const started = Date.now();
    const cl = generateToolpath({ type, name: type, tool: FLAT, mesh: block.mesh, stock: huge, params, fixtures: [] });
    assert.ok(Date.now() - started < 2000, `${type}: refused at once`);
    assert.eq(cl.count, 0, `${type}: nothing generated`);
    assert.ok(toolpathStats(cl).warnings.some((w) => /stock is/.test(w.text) && /Y/.test(w.text)), `${type}: says which side`);
  }
  assert.ok(run('face').cl.count > 0, 'an ordinary billet is planned as before');
});

test('a setting bounded on one side only is still held on the other, so it cannot hang the offsetting', () => {
  // 1e9 of stock to leave was 1e14 clipper units: the contour never came back.
  // A Stock to leave of 100 is the most the panel takes, and 1e9 is held to that.
  for (const [type, key] of [['contour2d', 'stockToLeave'], ['clear2d', 'stockToLeave'], ['parallel3d', 'boundaryExtra']]) {
    const { cl, ms, stats } = run(type, { [key]: 1e9 });
    assert.ok(ms < 10000, `${type} ${key}=1e9 came back in ${ms}ms`);
    // leaving 100mm on a 20mm part may well leave nothing to cut; it then says so
    assert.ok(allFinite(cl) && (cl.count > 0 || stats.warnings.length > 0), `${type}: a program, or the reason there is none`);
    assert.ok(stats.warnings.some((w) => w.text.includes(key)), `${type}: and it says ${key} was held`);
  }
  assert.eq(paramLimits().stockToLeave.max, 100);
});

test('a feed or a speed under one is not one: it inherits, or is reported as missing, never posted as F0 or S0', () => {
  const tool = { feedCut: 800, feedPlunge: 300, spindleRpm: 10000 };
  const inherited = effectiveCutting({ params: { feedCut: 1e-9, feedPlunge: 0.4, spindleRpm: 0.4 } }, tool);
  assert.eq([inherited.feedCut, inherited.feedPlunge, inherited.spindleRpm].join(), '800,300,10000', 'the cutter has its own numbers to stand in');
  const none = effectiveCutting({}, { feedCut: 1e-9, feedPlunge: 0.5, spindleRpm: 0.4 });
  assert.eq([none.feedCut, none.feedPlunge, none.spindleRpm].join(), '0,0,0', 'a tool with none says so rather than rounding to zero in the post');
  const { cl, stats } = run('contour2d', {}, { ...FLAT, feedCut: 1e-9 });
  assert.ok(stats.warnings.some((w) => /no cutting feed/.test(w.text)), 'and the program names it');
  assert.ok(cl.count > 0);
});

test('a saved session that cannot be read is reported, not swallowed', async () => {
  // it used to be deleted and the app started empty, with a line in the console
  if (storeAvailable()) return;          // a browser with a file store reads that instead
  const stub = typeof localStorage === 'undefined';
  const store = new Map();
  if (stub) {
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  }
  const kept = localStorage.getItem('cncam.project');
  try {
    localStorage.setItem('cncam.project', '{"version": 3, "setups": [');
    const bad = await loadSaved();
    assert.ok(bad?.unreadable && /JSON/.test(bad.unreadable), `says why: ${bad?.unreadable}`);
    assert.eq(localStorage.getItem('cncam.project'), null, 'and does not offer the same wreck on the next boot');
    localStorage.setItem('cncam.project', JSON.stringify({ version: 999, setups: [] }));
    const ahead = await loadSaved();
    assert.ok(/reads up to/.test(ahead?.unreadable), 'a session from a newer build is named as such');
    assert.ok(localStorage.getItem('cncam.project'), 'and kept, so going back to that build finds it');
  } finally {
    if (kept == null) localStorage.removeItem('cncam.project'); else localStorage.setItem('cncam.project', kept);
    if (stub) delete globalThis.localStorage;
  }
});

test('what had to be repaired on the way in is said the same way wherever a project comes in', () => {
  const notes = [];
  deserializeProject(JSON.stringify({ version: 5, name: 'x', tools: [{ type: 'flat', diameter: null }], setups: [null, 3] }), notes);
  assert.ok(notes.length >= 2, `repairs were noted: ${notes.length}`);
  const said = describeRepairs(notes);
  assert.ok(/had to be repaired/.test(said) && said.startsWith(' — '), said);
  assert.eq(describeRepairs([]), '', 'a clean file says nothing');
  assert.ok(describeRepairs(['a', 'b', 'c', 'd']).endsWith('…'), 'a long list is cut, and says it was');
});

// --- round 2: what the library and the drawings are allowed to be ---

test('a tool library kept in the browser that has a null in it still opens', () => {
  // a drawer whose list held a null made every read of the library throw — the
  // tool picker with it, on every open
  const stub = typeof localStorage === 'undefined';
  const store = new Map();
  if (stub) {
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  }
  const kept = localStorage.getItem('cncam.toolCatalogs');
  try {
    localStorage.setItem('cncam.toolCatalogs', JSON.stringify({
      catalogs: [{ id: 'mine', tools: [null, 5, { type: 'flat' }, { name: 'ok', type: 'flat', diameter: 6 }] }],
    }));
    const drawers = userCatalogsFor('mill');
    assert.eq(drawers.length, 1);
    assert.eq(drawers[0].tools.map((t) => t.name).join(), 'ok', 'what is not a named tool is left out');
    assert.ok(saveUserTool({ name: 'new', type: 'flat', diameter: 3 }), 'and a tool can still be added');
    assert.ok(removeUserTool('ok'), 'or taken out');
  } finally {
    if (kept == null) localStorage.removeItem('cncam.toolCatalogs'); else localStorage.setItem('cncam.toolCatalogs', kept);
    if (stub) delete globalThis.localStorage;
  }
});

test('a library file with something that is not a tool in it says which entry', () => {
  assert.throws(() => deserializeLibrary('{"tools":[{"name":"a","type":"flat"},null]}'));
  let said = '';
  try { deserializeLibrary('{"tools":[{"name":"a","type":"flat"},null]}'); } catch (err) { said = err.message; }
  assert.ok(/entry 2/.test(said), said);
  assert.eq(deserializeLibrary('[{"name":"a","type":"flat","diameter":6}]').length, 1, 'a bare list is still a library');
});

test('a drawing with a point that is not a number is refused in words, by every strategy that reads one', () => {
  // NaN came out of the slot on every line, an infinity ran an engraving out of
  // memory, and a path with no points was a TypeError three different ways
  const vee = { ...FLAT, type: 'chamfer', name: '90 vee', tipAngle: 90, tipDiameter: 0, flutes: 1 };
  const drill = { ...FLAT, type: 'drill', name: '5 drill', diameter: 5, tipAngle: 118 };
  const bad = [
    [{ points: [5, 5, NaN, 5, 30, 30], closed: true }, /not a number/],
    [{ points: [5, 5, Infinity, 5, 30, 30], closed: true }, /not a number/],
    [{ points: ['5', '5', '30', '5'], closed: false }, /not a number/],
    [{ points: null, closed: true }, /no list of points/],
    [{ points: [5, 5, 30], closed: false }, /missing/],
  ];
  for (const [path, words] of bad) {
    for (const [type, tool] of [['slot', FLAT], ['engrave', vee], ['drill', drill]]) {
      const params = { ...defaultParamsFor(type, { stock: STOCK, tool }), topZ: 20, bottomZ: 15 };
      const cl = generateToolpath({ type, name: type, tool, mesh: block.mesh, stock: STOCK, drawing: [path], params, fixtures: [] });
      const { warnings, empty } = toolpathStats(cl);
      assert.ok(empty && warnings.some((w) => words.test(w.text)), `${type} with ${JSON.stringify(path.points)}: ${warnings[0]?.text}`);
    }
  }
});

test('a project whose saved face ranges are not numbers still picks faces', () => {
  const record = encodeMesh(block.mesh);
  record.faceRanges = [{ first: 0, last: 5 }, null, { first: 'a', last: {} }];
  assert.ok(!decodeMesh(record).faceRanges, 'a set with a hole in it is dropped whole');
  record.faceRanges = [{ first: 0, last: 5 }, { first: 6, last: 11 }];
  assert.eq(decodeMesh(record).faceRanges.length, 2, 'and a good one is kept');
  record.faceRanges = 'abc';
  assert.ok(!decodeMesh(record).faceRanges, 'a string is not a list of ranges');
});

test('a STEP/IGES reader failure says what to do, not a bare number', async () => {
  // The reader is C++ in WebAssembly: a bad file comes back as a pointer ("Import
  // failed: 5263928"), as nothing, or as "could not read the file".
  const { describeCadError } = await import('../io/step.js');
  for (const error of ['5263928', '', undefined, 'occt could not read the file']) {
    const said = describeCadError(error, 'step');
    assert.ok(/STEP reader could not make sense/.test(said) && /Export it again/.test(said),
      `"${error}" came back as: ${said}`);
    assert.ok(!/^\d+$/.test(said), 'not a number');
  }
  assert.ok(/IGES/.test(describeCadError('7', 'iges')), 'the kind is named');
  assert.ok(/too big/.test(describeCadError('RangeError: WebAssembly.Memory(): could not allocate memory')),
    'running out of memory is its own message');
  assert.eq(describeCadError('Unexpected token in line 4'), 'Unexpected token in line 4',
    'the reader\'s own words are kept when it has some');
});
