// Where to go, and what to press, when an operation says something is wrong.
//
// An operation that fails says why in a sentence: "shank or holder collision
// after orientation adjustment", "exceeds sample budget; increase stepover or
// tolerance". The sentence is right and it is not enough. It names a cause, in
// the strategy's words, and the settings that answer it are fields with other
// names on one of five tabs — "Never more than (° from vertical)" is on Passes,
// the clearance is on Heights, the cutter's shank is not on the operation at
// all. Reading the message was never the hard part; finding the box was.
//
// So every message the app shows about an operation — a failure, a warning from
// the strategy, a problem seen from the settings before anything ran — is read
// here for two things:
//
//   where    the fields it is about, each as "Tab › Field", to jump to
//   fixes    a change that answers it, made with one press, when there is one
//            that is safe to propose without knowing what the part is for
//
// The fields are found in the message's own words, against the same table the
// panel is built from (op-params.js), so a message that says "Bottom Z" points
// at Bottom Z whichever strategy wrote it and nobody has to keep a second list
// of which strategy has which field. The fixes are written out one by one,
// because a fix is a judgement and a pattern match is not one.

import { OP_PARAM_GROUPS, OP_TABS, paramApplies } from './op-params.js';
import { setSetting } from './settings.js';

/** Where one of an operation's fields is: { key, tab, tabLabel, label }, or null. */
export function placeOf(op, key) {
  for (const group of OP_PARAM_GROUPS) {
    for (const field of group.fields) {
      if (field.key !== key || !paramApplies(field, op)) continue;
      return {
        key,
        tab: group.tab,
        tabLabel: OP_TABS.find((t) => t.key === group.tab)?.label ?? group.tab,
        label: (field.labelFor?.(op) ?? field.label ?? key).replace(/\s*\([^)]*\)\s*$/, ''),
      };
    }
  }
  return null;
}

/**
 * The words a message uses for a field, and the field. Longest first where one
 * phrase contains another, so "plunge feed" is not read as "feed".
 */
const MENTIONS = [
  [/\btop z\b|\bz start\b/i, 'topZ'],
  [/\bbottom z\b|\bz end\b|\bdepth of the slot\b|\bhas no depth\b|deeper than/i, 'bottomZ'],
  [/\bclearance\b/i, 'clearanceHeight'],
  [/\bentry gap\b/i, 'entryGap'],
  [/\bramp angle\b|\bplung(?:es|ing|ed)\b/i, 'rampAngle'],
  [/\bstepover\b|\btoo many passes\b/i, 'stepover'],
  [/\bstepdown\b|\bdepth of cut\b/i, 'stepdown'],
  [/\btolerance\b|\bsample budget\b|\btoo many samples\b/i, 'tolerance'],
  [/\bstock to leave\b|\bto leave\b|\bno stock to leave\b/i, 'stockToLeave'],
  [/\bfinish pass/i, 'finishPasses'],
  [/\btab height\b/i, 'tabHeight'],
  [/\bchamfer width\b/i, 'chamferWidth'],
  [/\bengraving depth\b|\bmark\b.*\bdeep\b|\bslot, not an engraved mark\b/i, 'engraveDepth'],
  [/\bspindle speed\b|\bposts s0\b/i, 'spindleRpm'],
  [/\bplunge feed\b/i, 'feedPlunge'],
  [/\bcutting feed\b|\bno (?:cutting )?feed\b/i, 'feedCut'],
  [/\bpattern centre\b/i, 'patternCenterX'],
  [/\blean|\borientation\b|\bshank or holder\b|\btilt\b/i, 'maxTilt'],
];

/** A place that is not a field of the operation: said, and opened by `run`. */
function elsewhere(label, run) { return { label, run }; }

const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * The fixes that are written out. Each is tried against the message in turn and
 * may add fields to point at and changes to offer.
 *
 * A fix is `{ label, title, patch }` — the operation's params to change — or
 * `{ label, title, run(app) }` for one that is not a param. Only what can be
 * said to be an improvement without knowing the job: lean less, sample more
 * coarsely, lift the clearance over the clamp. Nothing here picks a depth.
 */
const RULES = [
  // --- 5-axis finishing ---------------------------------------------------------
  {
    test: /shank or holder (?:collision|is still in the part)/i,
    advise(op, m, doc) {
      const tilt = op.params.maxTilt ?? 35;
      const fixes = [];
      if (tilt > 10) {
        const less = Math.max(5, Math.round(tilt / 2));
        fixes.push({
          label: `Lean no more than ${less}°`,
          title: `Halve "Never more than" from ${tilt}° to ${less}° — a cutter that leans less keeps its holder further from the part`,
          patch: { maxTilt: less },
        });
      }
      if (tilt > 0) {
        fixes.push({
          label: 'Keep the cutter upright',
          title: 'Set "Never more than" to 0° — the pass runs as a 3-axis finish, which is the furthest the holder can be from the part',
          patch: { maxTilt: 0 },
        });
      }
      const tool = doc.project.tools.find((t) => t.id === op.toolId);
      return {
        keys: ['maxTilt', 'tiltMode'],
        places: tool ? [elsewhere(`Tool › ${tool.name} (a longer cutter, or a slimmer holder)`,
          (app) => (app.actions?.editTool ? app.actions.editTool(tool) : doc.select('tool', tool.id)))] : [],
        fixes,
      };
    },
  },
  {
    test: /unreachable orientation|no rotary travel margin/i,
    advise(op, m, doc, app) {
      const tilt = op.params.maxTilt ?? 35;
      const fixes = [];
      if (tilt > 10) {
        const less = Math.max(5, Math.round(tilt * 0.6));
        fixes.push({
          label: `Lean no more than ${less}°`,
          title: `Lower "Never more than" from ${tilt}° to ${less}°, inside what the machine's tilt axis can reach`,
          patch: { maxTilt: less },
        });
      }
      return {
        keys: ['maxTilt', 'axisTol'],
        places: [elsewhere('Machine › rotary axes (their travel limits)',
          (a) => a.actions?.openMachines?.())],
        fixes,
      };
    },
  },
  {
    test: /sample budget|too many passes|too many samples/i,
    advise(op) {
      const fixes = [];
      const step = op.params.stepover ?? 0.1;
      const tol = op.params.tolerance ?? 0.01;
      if (step < 0.5) {
        const wider = round3(Math.min(0.5, step * 2));
        fixes.push({
          label: `Stepover ${step} → ${wider} ×D`,
          title: 'Double the stepover: half as many passes over the same surface',
          patch: { stepover: wider },
        });
      }
      if (tol < 0.05) {
        const looser = round3(Math.min(0.05, tol * 2));
        fixes.push({
          label: `Tolerance ${tol} → ${looser}mm`,
          title: 'Double the tolerance: the surface is sampled on a coarser grid',
          patch: { tolerance: looser },
        });
      }
      return { keys: ['stepover', 'tolerance'], fixes };
    },
  },
  {
    // a field holding something that is not a number: named by its key, which
    // is nothing the panel calls it
    test: /the setting (\w+) is not a number/,
    advise(op, m) {
      const key = m[1];
      const field = OP_PARAM_GROUPS.flatMap((g) => g.fields).find((f) => f.key === key);
      return {
        keys: [key],
        fixes: field?.nullable ? [{
          label: `Clear it (${field.placeholder ?? 'automatic'})`,
          title: 'Empty the field, so the value is worked out',
          patch: { [key]: null },
        }] : [],
      };
    },
  },
  {
    test: /pattern centre/i,
    advise() {
      return {
        keys: ['patternCenterX', 'patternCenterY'],
        fixes: [{
          label: 'Use the automatic centre',
          title: 'Clear both centre fields: the pattern is centred on the area being machined',
          patch: { patternCenterX: null, patternCenterY: null },
        }],
      };
    },
  },
  {
    test: /outside machining window|nothing left to machine after the region filter/i,
    advise() { return { keys: ['topZ', 'bottomZ'], tabs: ['regions'], fixes: [] }; },
  },
  {
    test: /could not be verified and were omitted/i,
    advise(op) {
      const tilt = op.params.maxTilt ?? 35;
      return {
        keys: ['maxTilt', 'tolerance'],
        fixes: tilt > 10 ? [{
          label: `Lean no more than ${Math.max(5, Math.round(tilt / 2))}°`,
          title: 'The stretches left out are where the leaning cutter could not be shown to clear the part; a smaller lean clears more of it',
          patch: { maxTilt: Math.max(5, Math.round(tilt / 2)) },
        }] : [],
      };
    },
  },

  // --- heights --------------------------------------------------------------------
  {
    test: /Clearance is Z(-?[\d.]+) and .+ stands to Z(-?[\d.]+)/,
    advise(op, m) {
      const over = round3(Number(m[2]) + 5);
      return {
        keys: ['clearanceHeight'],
        fixes: [{
          label: `Raise clearance to Z${over}`,
          title: '5mm over the top of the tallest clamp, so a rapid crosses above it',
          patch: { clearanceHeight: over },
        }],
      };
    },
  },
  {
    test: /Clearance is not above the top of the cut/i,
    advise(op) {
      const over = round3((op.params.topZ ?? 0) + 10);
      return {
        keys: ['clearanceHeight', 'topZ'],
        fixes: [{
          label: `Set clearance to Z${over}`,
          title: '10mm above Top Z',
          patch: { clearanceHeight: over },
        }],
      };
    },
  },
  {
    test: /the tool goes [\d.]+mm into (.+?) \(/,
    advise(op, m, doc) {
      const setup = doc.findSetupOf(op.id);
      const fixture = (setup?.fixtures ?? []).find((f) => f.name === m[1]);
      return {
        keys: ['bottomZ'],
        tabs: ['regions'],
        places: fixture ? [elsewhere(`Fixture › ${fixture.name} (where it stands)`,
          () => doc.select('fixture', fixture.id))] : [],
        fixes: [],
      };
    },
  },

  // --- entry -------------------------------------------------------------------------
  {
    test: /ramp angle is 0|set a ramp angle/i,
    advise() {
      return {
        keys: ['rampAngle'],
        fixes: [{
          label: 'Ramp in at 3°',
          title: 'Set the ramp angle to 3°: the cutter slopes down into the cut instead of plunging',
          patch: { rampAngle: 3 },
        }],
      };
    },
  },
  {
    test: /finish pass(?:es)? asked for with no stock to leave/i,
    advise() {
      return {
        keys: ['finishPasses', 'stockToLeave'],
        fixes: [{
          label: 'Leave 0.2mm for them',
          title: 'Set stock to leave to 0.2mm, so the finish passes have something to take',
          patch: { stockToLeave: 0.2 },
        }, {
          label: 'No finish passes',
          title: 'Set finish passes to 0',
          patch: { finishPasses: 0 },
        }],
      };
    },
  },

  // --- what stops an operation running at all ------------------------------------
  {
    test: /switch the beta on under Options/i,
    advise() {
      return {
        keys: [],
        fixes: [{
          label: 'Switch the 5-axis beta on',
          title: 'Options → Experimental → Simultaneous 5-axis (beta)',
          run: (app) => { setSetting('fiveAxisBeta', true); app.doc.emitChange?.('settings'); },
        }],
        places: [elsewhere('Options › Experimental', (app) => app.actions?.openOptions?.())],
      };
    },
  },
  {
    test: /no tool assigned|its tool was deleted/i,
    advise() { return { keys: [], tool: true, fixes: [] }; },
  },
  {
    test: /re-pick, or clear the picks|picked/i,
    advise() { return { keys: [], tabs: ['regions'], fixes: [] }; },
  },
];

/**
 * What to do about a message shown on an operation.
 *
 * @returns { where, fixes } — `where` is a list of
 *   `{ label, key?, tab?, run? }`: a field to jump to (key + tab), a tab, or a
 *   place outside the operation (`run`). Both lists may be empty: plenty of
 *   messages are simply true and ask for nothing.
 */
export function adviceFor(doc, op, text, app = null) {
  const message = String(text ?? '');
  const keys = [];
  const tabs = [];
  const places = [];
  const fixes = [];
  let tool = false;
  for (const rule of RULES) {
    const m = rule.test.exec(message);
    if (!m) continue;
    const advice = rule.advise(op, m, doc, app) ?? {};
    for (const k of advice.keys ?? []) if (!keys.includes(k)) keys.push(k);
    for (const t of advice.tabs ?? []) if (!tabs.includes(t)) tabs.push(t);
    places.push(...(advice.places ?? []));
    for (const fix of advice.fixes ?? []) {
      if (!fixes.some((f) => f.label === fix.label)) fixes.push(fix);
    }
    tool ||= advice.tool === true;
  }
  for (const [pattern, key] of MENTIONS) {
    if (pattern.test(message) && !keys.includes(key)) keys.push(key);
  }

  const where = [];
  if (tool) where.push({ label: 'Tool (the row above the tabs)', tool: true });
  for (const key of keys) {
    const place = placeOf(op, key);
    if (place) where.push({ label: `${place.tabLabel} › ${place.label}`, key, tab: place.tab });
  }
  for (const tab of tabs) {
    where.push({ label: tab === 'regions' ? 'Regions (what it may cut and must avoid)' : tab, tab });
  }
  where.push(...places);
  // a fix that would change nothing is not offered
  const useful = fixes.filter((f) => !f.patch
    || Object.entries(f.patch).some(([k, v]) => op.params[k] !== v));
  return { where: where.slice(0, 5), fixes: useful.slice(0, 3) };
}

/** Open the tab a field is on and mark the field, so the eye lands on it. */
export function showPlace(app, op, place) {
  if (place.run) { place.run(app); return; }
  if (place.tab) {
    app.opTabs ??= new Map();
    app.opTabs.set(op.id, place.tab);
  }
  // read by the panel as it is rebuilt — see props/op-panel.js
  // eslint-disable-next-line no-param-reassign
  app.flashParam = place.tool ? '__tool' : (place.key ?? null);
  if (place.tab !== 'regions' && app.pickMode) app.setPickMode?.(null);
  else app.rerenderProps?.();
}

/** Make a proposed change, say so, and generate again to see whether it answered it. */
export function applyFix(app, doc, op, fix) {
  if (fix.patch) doc.updateItem(op.params, fix.patch, `fix: ${fix.label}`);
  else fix.run?.(app);
  app.ui?.setStatus?.(`${fix.label} — generating again (Ctrl+Z undoes the change)`);
  // only what is out of date is generated, which is this operation and
  // whatever reads it
  Promise.resolve(app.actions?.generate?.({})).catch(() => {});
}
