// The range every operation setting is allowed to take, held at the engine's door.
//
// The properties panel clamps a number to its field's `min` and `max` the moment
// it is typed, so nothing typed can be outside them — and nothing else says the
// range exists. A project file edited by hand, an autosave from a build with a
// wider panel, or a script that fills `params` directly is not typed, and what
// it carried straight through was the number itself: 1e9 finish passes is a loop
// that does not end, a tolerance of 0 is a cutter path divided into steps of
// nothing, and a stepdown of 1e-9 is twelve billion levels.
//
// The ranges are not written out again here. They are the panel's own — the
// `min` and `max` on each field in app/op-params.js, which is data and pulls in
// nothing — so there is one description of how big a setting may be, and a field
// whose range is widened in the panel is widened here in the same edit. A key
// described in more than one place is limited by the loosest of them: a field
// that one operation bounds and another leaves open is open.

import { OP_PARAM_GROUPS } from '../app/op-params.js';

/**
 * The size no setting has, whatever its field says: a hundred metres.
 *
 * Most fields are bounded on one side only (a stock to leave of at least 0, a
 * Top Z of anything) and a typed or edited value on the open side went through
 * unchecked — 1e9 of stock to leave is an offset the polygon clipper overflows
 * on and never comes back from, 1e9 of overrun is a raster fifteen seconds
 * long, a pitch of 1e9 a thread that was never cut. Nothing the panel allows
 * is anywhere near this, and a machine does not travel it.
 */
export const SETTING_CEILING = 100000;

const limitsByType = new Map();

/**
 * { key: { min, max } } — each bound is a number or null for none.
 *
 * Given an operation type, only the fields that operation shows count: a setting
 * its panel has no field for is one it does not read, and a warning that it was
 * held to a range would be about nothing (a spot drill carries a stepover it
 * never uses, and a 1.1 of it is no one's mistake).
 */
export function paramLimits(type = null) {
  if (limitsByType.has(type)) return limitsByType.get(type);
  const found = new Map();
  for (const group of OP_PARAM_GROUPS) {
    for (const field of group.fields ?? []) {
      if (!field.key || field.type) continue;       // selects, ticks and reports have no range
      if (type && field.ops && !field.ops.includes(type)) continue;
      const entry = found.get(field.key) ?? { mins: [], maxs: [] };
      entry.mins.push(field.min ?? null);
      entry.maxs.push(field.max ?? null);
      found.set(field.key, entry);
    }
  }
  const limits = {};
  for (const [key, { mins, maxs }] of found) {
    limits[key] = {
      min: mins.every((v) => v !== null) ? Math.min(...mins) : null,
      max: maxs.every((v) => v !== null) ? Math.max(...maxs) : null,
    };
  }
  limitsByType.set(type, limits);
  return limits;
}

/**
 * Hold `params` to the panel's ranges.
 *
 * @param type the operation's type, so that only the settings it shows are held
 * @returns { params, notes } — params is the same object when nothing was out of
 *   range, a corrected copy otherwise; notes say what moved and to where
 */
export function clampParams(params, type = null) {
  const table = paramLimits(type);
  let out = params;
  const notes = [];
  for (const [key, { min, max }] of Object.entries(table)) {
    const value = params?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    let held = value;
    const lowest = min ?? -SETTING_CEILING;
    const highest = max ?? SETTING_CEILING;
    if (held < lowest) held = lowest;
    if (held > highest) held = highest;
    if (held === value) continue;
    if (out === params) out = { ...params };
    out[key] = held;
    notes.push(`${key} was ${value}, outside the ${lowest} to ${highest} range it can take — used ${held}`);
  }
  return { params: out, notes };
}

/** The range-bound keys whose value is not a number at all (a string, an object). */
export function nonNumeric(params, type = null) {
  const table = paramLimits(type);
  for (const key of Object.keys(table)) {
    const value = params?.[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number') return key;
  }
  return null;
}
