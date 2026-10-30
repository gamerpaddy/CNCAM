// What a project file is allowed to be, and what happens when it is not.
//
// A .cncam is JSON that anybody can have edited, that an older build wrote, that
// a half-finished save can have cut off, and that an autosave reloads on every
// boot. `JSON.parse` says it is *a* document; nothing said it was *this* one. A
// `setups` that was a string, an operation that was `null`, a tool whose
// diameter was `null` (what `JSON.stringify` makes of a NaN) — each of those
// loaded, or failed with "Cannot read properties of null (reading 'regions')",
// and the ones that loaded took the viewport, the tree or Generate down later,
// on a project the autosave then restored again on the next reload. A file that
// cannot be opened is a message; a file that opens into an app that cannot be
// used is a brick.
//
// So the shape is enforced once, here, as the file comes in: every list is a
// list of objects, every number a number, every id a string and unique. What
// cannot be made sense of is dropped or reset to the default, and each such
// change is written to `notes` — the caller tells the user, because a repaired
// project that says nothing is a project that silently changed.
//
// What is *not* checked is whether the numbers are sensible: a diameter of 1e9
// is a number, and the strategies answer for what they do with it.

import {
  uid, createTool, createOperation, createSetup, TOOL_TYPES, OP_TYPES, createDrawingPlacement,
} from './schema.js';
import { createMachine, MACHINE_KINDS } from './machines.js';
import { createFixture } from '../engine/fixtures.js';
import { boundsOf } from '../io/dxf.js';
import { plural } from '../engine/text.js';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function describe(v) {
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (typeof v === 'string') return `"${v.length > 20 ? `${v.slice(0, 20)}…` : v}"`;
  if (Array.isArray(v)) return 'a list';
  if (typeof v === 'object') return 'an object';
  return String(v);
}

function show(v) {
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  return typeof v === 'string' ? `"${v}"` : String(v);
}

/** Does `value` have the kind of thing `def` is — a number, a string, a trio of numbers. */
function sameKind(def, value) {
  if (def === null || def === undefined) return true;
  if (typeof def === 'number') return Number.isFinite(value);
  if (typeof def === 'string' || typeof def === 'boolean') return typeof value === typeof def;
  if (Array.isArray(def)) {
    return Array.isArray(value) && value.length === def.length
      && value.every((x, i) => sameKind(def[i], x));
  }
  return isObject(value);
}

/**
 * Hold every field `obj` has to the kind its default is. A field that is not
 * there is left alone — the caller merges defaults over it — and so is one whose
 * default is null, which means "anything, or not set".
 */
function typed(obj, defaults, label, notes, skip = []) {
  for (const [key, def] of Object.entries(defaults)) {
    if (skip.includes(key) || obj[key] === undefined) continue;
    if (!sameKind(def, obj[key])) {
      notes.push(`${label}: ${key} was ${describe(obj[key])}, set to ${show(def)}`);
      obj[key] = Array.isArray(def) ? [...def] : def;
    }
  }
}

/** A list of objects: anything else in it goes, and the loss is said. */
function objectsOf(list, label, notes) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    notes.push(`${label}: not a list, dropped`);
    return [];
  }
  const kept = list.filter(isObject);
  if (kept.length < list.length) {
    notes.push(`${label}: ${list.length - kept.length} entries that were not records, dropped`);
  }
  return kept;
}

/** An id that is a non-empty string and has not been used, or a fresh one. */
function uniqueId(item, prefix, seen, label, notes) {
  if (typeof item.id !== 'string' || !item.id || seen.has(item.id)) {
    const was = item.id;
    item.id = uid(prefix);
    if (was !== undefined) notes.push(`${label}: id ${describe(was)} was missing or repeated, given a new one`);
  }
  seen.add(item.id);
}

// Settings that are a number or nothing at all. Their default is null, so the
// generic check cannot tell a number that went wrong from one that is absent.
const NULLABLE_NUMBERS = ['spindleRpm', 'feedCut', 'feedPlunge', 'grooveRadius', 'linkDistance'];

function repairTool(tool, seen, notes) {
  const type = TOOL_TYPES.includes(tool.type) ? tool.type : 'flat';
  if (tool.type !== type) notes.push(`tool ${describe(tool.name)}: type ${describe(tool.type)} is not a cutter type, set to flat`);
  const defaults = createTool(type);
  const out = { ...defaults, ...tool, type };
  uniqueId(out, 'tool', seen, `tool ${describe(out.name)}`, notes);
  const label = `tool ${describe(out.name)}`;
  typed(out, defaults, label, notes, ['shank', 'holder', 'customPoints', 'image']);
  for (const stack of ['shank', 'holder']) {
    const list = out[stack];
    const ok = Array.isArray(list) && list.every((s) => isObject(s)
      && Number.isFinite(s.diameter) && Number.isFinite(s.length));
    if (!ok) {
      notes.push(`${label}: ${stack} was not a list of { diameter, length }, set to the default`);
      out[stack] = defaults[stack];
    }
  }
  const pts = out.customPoints;
  if (pts !== null && !(Array.isArray(pts) && pts.every((p) => Array.isArray(p)
    && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])))) {
    notes.push(`${label}: the hand-drawn insert outline was not a list of points, dropped`);
    out.customPoints = null;
  }
  if (out.image !== null && typeof out.image !== 'string') out.image = null;
  return out;
}

function repairOperation(op, defaults, seen, notes) {
  if (!OP_TYPES.includes(op.type)) {
    notes.push(`operation ${describe(op.name)}: type ${describe(op.type)} is not one this app has, dropped`);
    return null;
  }
  const label = `operation ${describe(op.name)}`;
  const out = { ...op };
  uniqueId(out, 'op', seen, label, notes);
  if (typeof out.name !== 'string') out.name = op.type;
  if (typeof out.enabled !== 'boolean') out.enabled = true;
  if (out.toolId !== null && typeof out.toolId !== 'string') out.toolId = null;
  if (!Array.isArray(out.geometry)) out.geometry = [];
  const regions = isObject(out.regions) ? out.regions : {};
  out.regions = { ...regions };
  for (const mode of ['include', 'avoid']) {
    const list = Array.isArray(regions[mode]) ? regions[mode] : [];
    // a pick is a face or an edge of a model, by number
    out.regions[mode] = list.filter((r) => isObject(r) && typeof r.modelId === 'string'
      && (Number.isInteger(r.faceId) || Number.isInteger(r.edgeId)));
    if (out.regions[mode].length < list.length) {
      notes.push(`${label}: ${list.length - out.regions[mode].length} picked ${mode} regions that named nothing, dropped`);
    }
  }
  const params = isObject(out.params) ? out.params : {};
  out.params = { ...defaults.params, ...params };
  typed(out.params, defaults.params, label, notes);
  for (const key of NULLABLE_NUMBERS) {
    const v = out.params[key];
    if (v !== null && v !== undefined && !Number.isFinite(v)) {
      notes.push(`${label}: ${key} was ${describe(v)}, set to inherit`);
      out.params[key] = null;
    }
  }
  return out;
}

function repairFixture(fixture, seen, notes) {
  const kind = ['box', 'cylinder', 'chuck'].includes(fixture.kind) ? fixture.kind : 'box';
  const defaults = createFixture(kind);
  const out = { ...defaults, ...fixture, kind };
  uniqueId(out, 'fix', seen, `clamp ${describe(out.name)}`, notes);
  typed(out, defaults, `clamp ${describe(out.name)}`, notes);
  return out;
}

function repairBox(box, label, notes) {
  if (box === null || box === undefined) return null;
  const ok = isObject(box) && Array.isArray(box.size) && box.size.length === 3
    && box.size.every(Number.isFinite);
  if (!ok) {
    notes.push(`${label}: the stock box had no usable size, dropped`);
    return null;
  }
  const out = { ...box };
  if (!sameKind([0, 0, 0], out.offset)) out.offset = [0, 0, 0];
  if (typeof out.align !== 'string') out.align = 'center';
  return out;
}

function repairCylinder(cyl, label, notes) {
  if (cyl === null || cyl === undefined) return null;
  if (!isObject(cyl)) {
    notes.push(`${label}: the round stock was not a record, dropped`);
    return null;
  }
  const out = { ...cyl };
  for (const key of ['diameter', 'innerDiameter', 'height']) {
    if (out[key] !== undefined && !Number.isFinite(out[key])) {
      notes.push(`${label}: round stock ${key} was ${describe(out[key])}, dropped`);
      delete out[key];
    }
  }
  if (out.offset !== undefined && !sameKind([0, 0, 0], out.offset)) out.offset = [0, 0, 0];
  if (out.center !== undefined && !sameKind([0, 0], out.center)) delete out.center;
  return out;
}

function repairSetup(setup, ids, notes) {
  const out = { ...setup };
  const label = `setup ${describe(setup.name)}`;
  uniqueId(out, 'setup', ids.setups, label, notes);
  if (typeof out.name !== 'string') out.name = 'Setup';
  if (out.mode !== 'mill' && out.mode !== 'turn') {
    if (out.mode !== undefined) notes.push(`${label}: mode ${describe(out.mode)} is neither mill nor turn, set to mill`);
    out.mode = 'mill';
  }
  const defaults = createSetup(out.name, out.mode);
  if (typeof out.wcs !== 'string') out.wcs = 'G54';
  // stock
  const stock = isObject(out.stock) ? out.stock : {};
  const stockDefaults = defaults.stock;
  out.stock = { ...stockDefaults, ...stock };
  if (!['box-margin', 'box', 'cylinder', 'tube'].includes(out.stock.kind)) {
    notes.push(`${label}: stock kind ${describe(out.stock.kind)} is not one there is, set to ${stockDefaults.kind}`);
    out.stock.kind = stockDefaults.kind;
  }
  typed(out.stock, stockDefaults, `${label} stock`, notes, ['box', 'cylinder']);
  out.stock.box = repairBox(out.stock.box, `${label} stock`, notes);
  out.stock.cylinder = repairCylinder(out.stock.cylinder, `${label} stock`, notes);
  // orientation
  // What a missing part of it means is what it meant before the field existed:
  // the model's own origin, no shift. A setup written by v1 has no orientation
  // at all, and a datum picked for it here would move its part.
  const orientation = isObject(out.orientation) ? out.orientation : {};
  const orientationDefaults = { ...defaults.orientation, origin: 'model' };
  out.orientation = { ...orientationDefaults, ...orientation };
  typed(out.orientation, orientationDefaults, `${label} orientation`, notes);
  // indexing and wrapping are on or off, and carry numbers when on
  for (const key of ['index', 'wrap']) {
    if (out[key] === undefined) continue;
    if (out[key] !== null && !isObject(out[key])) {
      notes.push(`${label}: ${key} was ${describe(out[key])}, switched off`);
      out[key] = null;
    }
  }
  if (out.wrap && out.wrap.diameter !== undefined && !Number.isFinite(out.wrap.diameter)) {
    notes.push(`${label}: wrap diameter was ${describe(out.wrap.diameter)}, wrap switched off`);
    out.wrap = null;
  }
  // models machined: a list of ids, which may name models since removed
  if (!Array.isArray(out.modelIds)) {
    if (out.modelIds !== undefined) notes.push(`${label}: the list of parts was not a list, set to every part`);
    out.modelIds = [];
  } else {
    out.modelIds = out.modelIds.filter((id) => typeof id === 'string');
  }
  out.fixtures = objectsOf(out.fixtures, `${label} clamps`, notes)
    .map((f) => repairFixture(f, ids.fixtures, notes));
  const opDefaults = createOperation();
  out.operations = objectsOf(out.operations, `${label} operations`, notes)
    .map((op) => repairOperation(op, opDefaults, ids.ops, notes))
    .filter(Boolean);
  return out;
}

function repairDrawing(drawing, seen, notes) {
  const out = { ...drawing };
  const label = `drawing ${describe(out.name)}`;
  uniqueId(out, 'drawing', seen, label, notes);
  if (typeof out.name !== 'string') out.name = 'Drawing';
  const paths = objectsOf(out.paths, `${label} paths`, notes).filter((p) => {
    const ok = Array.isArray(p.points) && p.points.length >= 4 && p.points.length % 2 === 0
      && p.points.every(Number.isFinite);
    if (!ok) notes.push(`${label}: a path with no usable points, dropped`);
    return ok;
  }).map((p) => ({ ...p, closed: p.closed === true, layer: typeof p.layer === 'string' ? p.layer : '0' }));
  out.paths = paths;
  // the extent is a fact about the paths, not a field worth trusting
  out.bounds = boundsOf(paths);
  const placement = isObject(out.placement) ? out.placement : {};
  const defaults = createDrawingPlacement();
  out.placement = { ...defaults, ...placement };
  typed(out.placement, defaults, `${label} placement`, notes);
  return out;
}

function repairMachine(machine, seen, notes) {
  const kind = MACHINE_KINDS.includes(machine.kind) ? machine.kind : 'mill';
  const travel = Array.isArray(machine.travel) && machine.travel.length === 3
    && machine.travel.every((v) => Number.isFinite(v) && v > 0) ? machine.travel : undefined;
  const rebuilt = createMachine({
    ...machine, kind, travel, post: typeof machine.post === 'string' ? machine.post : undefined,
    name: typeof machine.name === 'string' ? machine.name : undefined,
  });
  rebuilt.id = typeof machine.id === 'string' && machine.id && !seen.has(machine.id)
    ? machine.id : rebuilt.id;
  seen.add(rebuilt.id);
  return rebuilt;
}

/**
 * What had to be repaired, as the tail of a status line — '' for a clean file.
 *
 * The three places a project comes in (Open, the project drawer, the session
 * restored at boot) say it the same way, so a file that was changed on its way
 * in never loads in silence.
 */
export function describeRepairs(repairs) {
  if (!repairs?.length) return '';
  return ` — ${plural(repairs.length, 'thing')} in it had to be repaired: ${repairs.slice(0, 3).join('; ')}`
    + `${repairs.length > 3 ? '…' : ''}`;
}

/**
 * Hold a parsed project to its own schema, in place.
 *
 * Runs after the version has been checked and before anything else reads the
 * project, so the migrations in `deserializeProject` can assume lists are lists.
 *
 * @param p the parsed JSON, already known to be an object
 * @param notes what had to be changed, as sentences — appended to
 */
export function repairProject(p, notes) {
  if (typeof p.name !== 'string') p.name = 'Untitled';
  if (typeof p.units !== 'string') p.units = 'mm';
  if (p.machine !== 'mill' && p.machine !== 'turn') p.machine = 'mill';
  if (p.post !== undefined && typeof p.post !== 'string') delete p.post;
  if (p.postOptions !== undefined && !isObject(p.postOptions)) delete p.postOptions;
  if (p.simulation !== undefined && !isObject(p.simulation)) delete p.simulation;
  if (p.machineIds !== undefined && !isObject(p.machineIds)) delete p.machineIds;

  const ids = {
    models: new Set(), tools: new Set(), drawings: new Set(), machines: new Set(),
    setups: new Set(), fixtures: new Set(), ops: new Set(),
  };
  p.models = objectsOf(p.models, 'models', notes).map((m) => {
    const out = { ...m };
    uniqueId(out, 'model', ids.models, `model ${describe(out.name)}`, notes);
    if (typeof out.name !== 'string') out.name = 'Model';
    if (typeof out.sourceName !== 'string') out.sourceName = '';
    return out;
  });
  p.drawings = objectsOf(p.drawings, 'drawings', notes).map((d) => repairDrawing(d, ids.drawings, notes));
  p.tools = objectsOf(p.tools, 'tools', notes).map((t) => repairTool(t, ids.tools, notes));
  if (p.machines !== undefined) {
    p.machines = objectsOf(p.machines, 'machines', notes).map((m) => repairMachine(m, ids.machines, notes));
  }
  p.setups = objectsOf(p.setups, 'setups', notes).map((s) => repairSetup(s, ids, notes));
  return p;
}
