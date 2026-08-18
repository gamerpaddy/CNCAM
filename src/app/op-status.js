// What happened when an operation was generated, in a form the UI can show.
//
// The engine has always known when a strategy produced nothing, and why — it
// said so in a G-code comment, which is the one place a user looking at an
// empty viewport will never look. This turns that into something the tree and
// the properties panel can put in front of them.

import { toolpathStats } from '../engine/toolpath.js';
import { chamferGeometry, maxWidthFor } from '../engine/strategies/chamfer.js';
import { grooveGeometry } from '../engine/strategies/engrave.js';
import { reachCheck, latheReachOf, tipAngleOf } from '../engine/tool-geometry.js';
import { isLatheTool } from '../engine/insert.js';
import { chuckLimit, fixtureTop } from '../engine/fixtures.js';
import { setupModelIds } from './actions/setup-space.js';

/** Strategies whose depth does not come from a stepdown. */
const NO_STEPDOWN = new Set([
  'drill', 'parallel3d', 'chamfer',
  // On a lathe a groove is a width, a thread is a pitch, a hole is a peck,
  // parting is one plunge and finishing is one pass down the profile. None of
  // them steps down, and warning that they have not is a warning about a field
  // they do not have.
  'turnGroove', 'turnThread', 'turnDrill', 'turnPart', 'turnFinish',
]);

/** Strategies with one height rather than two — see op-params.js `topZ`. */
const NO_TOP_Z = new Set(['turnPart']);

/**
 * Strategies that put the tool down into a slot no wider than itself, where
 * anything above the flutes has to clear the wall. A facing pass or a 3D
 * finishing pass is in open air, and drilling makes its own clearance.
 */
const REACHES_DOWN = new Set(['contour2d', 'pocket', 'clear2d', 'adaptive', 'bore', 'engrave']);

/**
 * The turning mistakes that are visible from the settings alone.
 *
 * The strategies warn about these too, but only once they have run — and the
 * whole point of a preflight is to catch a mistake while its settings are still
 * on screen, rather than after a generate that produces an empty viewport. All
 * of these are things a picture of the job would tell you and a panel of fields
 * will not.
 */
function lathePreflight(op, tool, setup, p) {
  if (!op.type.startsWith('turn')) return [];
  const notes = [];
  const chuck = chuckLimit(setup?.fixtures);

  // The commonest way to set up a turning job wrong: aim it past the jaws. The
  // Z numbers all look reasonable, and the chuck is the one thing in the scene
  // that is not part of the part.
  if (chuck && chuck.mode !== 'inside' && p.bottomZ < chuck.z - 1e-6) {
    notes.push(`This reaches Z${round3(p.bottomZ)} and ${chuck.name} starts at `
      + `Z${round3(chuck.z)} — the pass will be stopped at the jaws.`);
  }

  if (op.type === 'turnGroove' && tool) {
    const blade = tool.bladeWidth || tool.diameter || 0;
    const width = Math.abs(p.topZ - p.bottomZ);
    if (blade > 0 && width < blade - 1e-6) {
      notes.push(`The groove is ${width.toFixed(2)}mm wide and T${tool.number} is a `
        + `${blade}mm blade — it cannot fit.`);
    }
    // No check on the floor radius. There used to be one — "The groove has no
    // floor radius set" — and it could not fire: the schema stores a blank as
    // `null`, and `null >= 0` is true in JavaScript, so the only value it
    // caught was `undefined`, which the field never holds. It should not fire
    // either: blank is the documented default and means "a sensible depth into
    // whatever diameter is there" (see generateTurnGroove).
  }

  if (op.type === 'turnThread') {
    if (!(p.threadPitch > 0)) notes.push('A thread needs a pitch.');
    if (!(p.threadPasses >= 1)) notes.push('A thread needs at least one pass.');
  }

  // G96 with nothing to hold. The mode is a two-part setting — hold *what*? —
  // and the surface speed starts at zero, so choosing it and pressing Generate
  // posts an ordinary G97 program with nothing anywhere saying the choice was
  // dropped. See engine/cutting.js applyCutting.
  if (p.spindleMode === 'css' && !(p.surfaceSpeed > 0)) {
    notes.push('The spindle is set to hold a surface speed and none is set, so this '
      + 'posts a fixed RPM (G97) as though the setting were not there.');
  }

  if (op.type === 'turnBore' && tool) {
    const reach = p.boreDepthLimit > 0 ? p.boreDepthLimit : latheReachOf(tool);
    const depth = Math.abs(p.topZ - p.bottomZ);
    if (Number.isFinite(reach) && depth > reach + 1e-6) {
      notes.push(`The bore is ${depth.toFixed(1)}mm deep and T${tool.number} reaches `
        + `${reach}mm — it will stop short.`);
    }
    if (tool.minBore > 0 && p.boreStartRadius > 0 && p.boreStartRadius * 2 < tool.minBore) {
      notes.push(`T${tool.number} needs a ⌀${tool.minBore} hole to fit in and the pilot `
        + `is ⌀${(p.boreStartRadius * 2).toFixed(2)}.`);
    }
  }

  // An insert with no nose radius is not an error, it is a finishing pass that
  // is quietly a nose radius short on every face.
  if ((op.type === 'turnFinish' || op.type === 'turnBore') && tool && !(tool.noseRadius > 0)) {
    notes.push(`T${tool.number} has no nose radius, so the profile cannot be compensated `
      + 'and every face will come out short.');
  }
  return notes;
}

function round3(v) { return Math.round(v * 1000) / 1000; }

/**
 * A fingerprint of everything that decides what an operation cuts.
 *
 * Toolpaths are computed once and then drawn until something replaces them,
 * which means the moment you change a stepdown the picture on screen is a lie —
 * it is the *old* toolpath, and nothing says so. You find out when you generate
 * again and the path jumps, or worse, when you do not and post the stale one.
 *
 * Comparing this against the fingerprint taken at generation time is what lets
 * the UI say "this is out of date" instead of quietly showing the wrong thing.
 */
export function opFingerprint(doc, op, setup = null) {
  const tool = doc.project.tools.find((t) => t.id === op.toolId);
  // The drawing the pass follows, if it follows one. A DXF is placed on the
  // billet — shifted, rotated, scaled, mirrored — and every one of those is a
  // field in the drawing panel that moves the cut. None of it lives on the
  // operation, so an allowlist of `op.params` cannot see it: rotating a
  // drawing 30° and scaling it ×2 took the engraved path from 80mm to 143mm
  // while the operation went on reporting itself up to date, which meant
  // Simulate showed the old path and Export posted it.
  const drawing = (doc.project.drawings ?? []).find((d) => d.id === op.params?.drawingId);
  return JSON.stringify([
    op.type,
    op.params,
    op.regions,
    // Everything about the cutter except who it is. Listing the fields that
    // matter is the same mistake as listing the fields that do not: the list
    // held the milling ones, so changing a turning insert's nose radius moved
    // the finishing profile (67.57mm → 67.24mm, 16 moves → 19) with nothing
    // saying so — and the next tool field to be added would have been missed
    // in the same way. A name and an id cannot change a path; assume the rest
    // can, and a needless regenerate is the worst this can cost.
    tool && Object.fromEntries(
      Object.entries(tool).filter(([k]) => k !== 'id' && k !== 'name')),
    drawing && [drawing.paths, drawing.placement],
    // The models this setup machines, resolved — not the raw `modelIds`, which
    // is empty on every setup the app makes and so never changes. Importing or
    // removing a model moves the stock and every path in the setup with it, and
    // that has to read as out of date. See actions/setup-space.js.
    setup && [setup.stock, setup.orientation, setup.fixtures,
      setupModelIds(setup, doc.project)],
  ]);
}

/**
 * @returns null when the operation has not been generated, otherwise the stats
 *   from engine/toolpath.js plus the display strings the panels want
 */
export function opStatus(doc, op) {
  const cl = doc.toolpaths.get(op.id);
  if (!cl) return null;
  // the chosen machine's rapid rate — a "10 minute" program becomes 30 if the
  // rapids are assumed five times slower than they are
  const stats = toolpathStats(cl, doc.rapidFeed());
  const setup = doc.findSetupOf(op.id);
  const stale = doc.fingerprints.get(op.id) !== opFingerprint(doc, op, setup);
  return {
    ...stats,
    stale,
    // an operation that emitted nothing is a problem whether or not the
    // strategy thought to say so
    level: stats.empty || stats.warnings.length ? 'warn' : stale ? 'stale' : 'ok',
    timeText: formatTime(stats.seconds),
    lengthText: formatLength(stats.cutLength),
  };
}

/**
 * Problems worth knowing about *before* generating.
 *
 * Waiting for the result to say "this cut nothing" is a slow way to learn that
 * the cutter is bigger than the pocket. These are the checks that can be made
 * from the settings alone, so they can be shown while the settings are being
 * edited — which is when they can still be acted on.
 */
export function opPreflight(doc, op) {
  const notes = [];
  const p = op.params ?? {};
  const tool = doc.project.tools.find((t) => t.id === op.toolId);
  const setup = doc.findSetupOf(op.id);

  // A chamfer is the exception to both of the checks below: its Bottom Z is a
  // limit rather than a floor, and its depth comes from the cone, not a
  // stepdown. Everything else takes the pair as the top and bottom of a cut.
  if (op.type !== 'chamfer') {
    if (p.bottomZ >= p.topZ && !NO_TOP_Z.has(op.type)) {
      notes.push('Bottom Z is not below Top Z, so there is no depth to cut.');
    }
    if (!(p.stepdown > 0) && !NO_STEPDOWN.has(op.type)) {
      notes.push('Stepdown is zero — the whole depth would be taken in one pass.');
    }
  }
  // On a bore the "stepdown" is a helix pitch, which has nothing to do with how
  // much flute is in the cut; on a lathe it is a *radial* depth of cut and the
  // tool has no flute at all, so the whole comparison is between two numbers
  // that are not about the same thing.
  if (tool && op.type !== 'bore' && !isLatheTool(tool.type) && p.stepdown > tool.fluteLength) {
    notes.push(`Stepdown ${p.stepdown}mm is deeper than the cutter's ${tool.fluteLength}mm `
      + 'flute — it would cut with the shank.');
  }
  notes.push(...lathePreflight(op, tool, setup, p));
  // The other reach limit, and the one nothing used to mention: what is above
  // the flutes has to stay above the work, because the slot is only as wide as
  // the cutter. A V bit on a 4mm collet shank runs out after 8mm however much
  // flute it has. See engine/tool-geometry.js.
  if (tool && REACHES_DOWN.has(op.type) && p.topZ > p.bottomZ) {
    const depth = p.topZ - p.bottomZ;
    const { ok, maxDepth, kind } = reachCheck(tool, depth);
    if (!ok) {
      notes.push(`This cut is ${depth.toFixed(1)}mm deep and the ${kind} is wider than the `
        + `cutter from ${maxDepth.toFixed(1)}mm up — it would rub the wall.`);
    }
  }
  if (op.type === 'contour2d' && p.tabCount > 0) {
    if (!(p.tabHeight > 0)) notes.push('Tab height is zero, so the tabs hold nothing.');
    if (!(p.tabWidth > 0)) notes.push('Tab width is zero, so the tabs hold nothing.');
    if (p.tabHeight > 0 && p.topZ - p.bottomZ > 0 && p.tabHeight >= p.topZ - p.bottomZ) {
      notes.push('Tabs are as tall as the whole cut, so the profile never breaks through.');
    }
    // the tool lifts over the tab plus its own diameter, so a small part can
    // run out of perimeter before it runs out of tabs
    if (tool && p.tabCount > 0) {
      const perTab = p.tabWidth + tool.diameter;
      notes.push(...(perTab * p.tabCount > estimatedPerimeter(doc, op) * 0.8
        ? [`${p.tabCount} tabs of ${p.tabWidth}mm need `
          + `${(perTab * p.tabCount).toFixed(0)}mm of the profile with a ⌀${tool.diameter}mm `
          + 'cutter — they will run into each other.']
        : []));
    }
  }
  if (op.type === 'drill' && tool && tool.type !== 'drill') {
    notes.push(`T${tool.number} is a ${tool.type}, not a drill.`);
  }
  // The cutter this operation asks for is not the only one that answers to its
  // number, so the machine may well fit the other one. See toolNumberClashes.
  if (tool) {
    const sharing = toolNumberClashes(doc.project).get(tool.number);
    if (sharing) {
      notes.push(`T${tool.number} is ${sharing.length} different cutters `
        + `(${sharing.map((t) => t.name).join(', ')}) — the program has no way to tell them `
        + 'apart, so give each one its own number.');
    }
  }
  // How deep a drill goes is the one thing it is for, and it was the one
  // operation with no reach check at all — bore, chamfer and every stepdown had
  // one. A drill has no shoulder for `reachCheck` to catch, so the limit is its
  // flute: past that the flutes are no longer in the hole, the chips have
  // nowhere to go and the shank is rubbing the wall. The case that bites is a
  // spot drill, which is short on purpose: 12mm of flute, sent 36mm down a bar.
  if ((op.type === 'drill' || op.type === 'turnDrill') && tool?.fluteLength > 0
    && p.topZ > p.bottomZ && p.topZ - p.bottomZ > tool.fluteLength) {
    notes.push(`This hole is ${(p.topZ - p.bottomZ).toFixed(1)}mm deep and T${tool.number} has `
      + `${tool.fluteLength}mm of flute — it cannot clear chips past that.`);
  }
  if (op.type === 'chamfer' && tool) {
    const g = chamferGeometry(tool, { width: p.chamferWidth ?? 0, clearance: p.chamferClearance ?? 0 });
    if (!g.pointed) {
      notes.push(`T${tool.number} is a ${tool.type} with no point angle — a chamfer needs a `
        + 'chamfer mill, a spot drill or a V bit.');
    } else if (g.engagedRadius > tool.diameter / 2) {
      notes.push(`A ${p.chamferWidth}mm chamfer is wider than a ⌀${tool.diameter} `
        + `${tipAngleOf(tool)}° cutter reaches — ${maxWidthFor(tool, p.chamferClearance ?? 0).toFixed(2)}mm is its limit.`);
    } else if (g.drop > tool.fluteLength) {
      notes.push(`The chamfer reaches ${g.drop.toFixed(2)}mm below the edge and the cutter has `
        + `${tool.fluteLength}mm of flute.`);
    }
  }
  if (op.type === 'bore' && tool) {
    if (p.preDrilled > 0 && p.preDrilled < tool.diameter) {
      notes.push(`A ⌀${p.preDrilled} pre-drilled hole is smaller than the ⌀${tool.diameter} `
        + 'cutter, so the helix would start in solid material.');
    }
    if (p.boreDiameter > 0 && p.boreDiameter <= tool.diameter) {
      notes.push(`⌀${p.boreDiameter} is not bigger than the ⌀${tool.diameter} cutter — `
        + 'there is no room for it to move inside the hole.');
    }
  }
  if (op.type === 'engrave') {
    if ((p.engraveMode ?? 'depth') === 'width' && tool && !grooveGeometry(tool).pointed) {
      notes.push(`T${tool.number} cuts a ⌀${tool.diameter} line at any depth — the width `
        + 'mode needs a V bit or a chamfer mill.');
    }
    if ((p.side ?? 'on') !== 'on') {
      notes.push('The cutter is offset from the line, so the mark will not land on it.');
    }
  }
  if ((op.type === 'parallel3d' || op.type === 'waterline') && tool?.type === 'flat') {
    notes.push('A flat cutter leaves steps on curved surfaces — a ball or bull nose '
      + 'follows the form.');
  }
  if (setup) {
    const stock = setup.stock;
    // Milling only. Clearance Z is a milling idea — on a lathe Z runs along the
    // bar and what a rapid clears is a radius — and no turning strategy reads
    // it, so the panel does not offer it there (see app/op-params.js). Saying
    // it anyway would be telling somebody to fix a field that is not on screen.
    const milling = (setup.mode ?? 'mill') !== 'turn';
    if (milling && stock && p.topZ != null && p.bottomZ != null
      && p.clearanceHeight <= p.topZ) {
      notes.push('Clearance is not above the top of the cut.');
    }
    // …and above the clamps, which is the half nothing checked. Clearance is
    // where the tool goes when nothing is known about what is between here and
    // there, and a clamp is the one thing in the setup that is not part of the
    // job. Every cut move already keeps out of its footprint — which is exactly
    // what hides this, because the traverses that do not are the ones drawn as
    // safe. See engine/fixtures.js fixtureTop.
    const clamp = milling ? fixtureTop(setup.fixtures) : null;
    if (clamp && p.clearanceHeight != null && p.clearanceHeight < clamp.z) {
      notes.push(`Clearance is Z${round3(p.clearanceHeight)} and ${clamp.name} stands to `
        + `Z${round3(clamp.z)} — a rapid at clearance goes through it.`);
    }
    // "Skip what earlier passes cleared" with no earlier pass to skip. It is
    // not an error — the operation is generated as though the box were clear,
    // which is the safe direction — but it is a switch that is on and doing
    // nothing, and the only evidence was that the pass took exactly as long as
    // it would have anyway. Only the *permanent* case is worth saying: an
    // earlier operation that simply has not been generated yet is the normal
    // state a second before Generate runs them in order (see regions-ui.js).
    if (p.restMachining && !earlierEnabledOp(setup, op)) {
      notes.push('Nothing runs before this operation, so there is no cleared ground '
        + 'to skip — rest machining has nothing to do here.');
    }
  }
  return notes;
}

/**
 * Cutters in the rack that answer to the same T number.
 *
 * A T word is the *only* thing the program says about which cutter to fit, and
 * the post states one per operation and skips the ones already in the spindle
 * — correctly, because six operations sharing an end mill should not write six
 * carousel cycles. Give two different cutters the same number and that
 * reasoning turns against you: the second operation's `T1 M6` is dropped as a
 * restatement, the ⌀6 end mill stays in the spindle, and the program cuts the
 * ⌀12 operation with it. Nothing in the file, the panel or the tree said a
 * word. The numbers are typed by hand in the tool panel and an imported
 * library brings its own, so the collision costs one keystroke to make.
 *
 * @returns Map of number → tools sharing it (only the numbers that clash)
 */
export function toolNumberClashes(project) {
  const byNumber = new Map();
  for (const tool of project.tools ?? []) {
    const sharing = byNumber.get(tool.number);
    if (sharing) sharing.push(tool);
    else byNumber.set(tool.number, [tool]);
  }
  return new Map([...byNumber].filter(([, tools]) => tools.length > 1));
}

/** Whether any enabled operation in this setup runs before `op`. */
function earlierEnabledOp(setup, op) {
  for (const previous of setup.operations ?? []) {
    if (previous.id === op.id) return false;
    if (previous.enabled) return true;
  }
  return false;
}

/**
 * Roughly how long the profile is, for sanity checks that need a length.
 *
 * Taken from the generated path when there is one and from the stock footprint
 * otherwise — this only ever decides whether to show a warning, so an estimate
 * that is right to within a factor is enough.
 */
function estimatedPerimeter(doc, op) {
  const cl = doc.toolpaths.get(op.id);
  if (cl) {
    const stats = toolpathStats(cl);
    if (stats.cutLength > 0) return stats.cutLength;
  }
  const setup = doc.findSetupOf(op.id);
  const stock = setup?.stock;
  const size = stock?.box?.size ?? [100, 100];
  return 2 * (size[0] + size[1]);
}

/** Why an operation cannot be generated at all, or null if it can. */
export function opBlockedReason(doc, op) {
  if (!op.enabled) return 'disabled';
  if (!op.toolId) return 'no tool assigned';
  if (!doc.project.tools.some((t) => t.id === op.toolId)) return 'its tool was deleted';
  if (doc.project.models.length === 0) return 'no model imported';
  return null;
}

export function formatTime(seconds) {
  if (!(seconds > 0)) return '0s';
  // Rounded to whole seconds *before* it is split up. Rounding each field on its
  // own lets the remainder round up to a full minute and still be printed as a
  // seconds field: 359.8s came out as "5m 60s", and 3599.7s as "59m 60s".
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function formatLength(mm) {
  return mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${mm.toFixed(0)} mm`;
}
