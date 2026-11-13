// The cutter for a proposed operation: one from the rack when the rack has it,
// a new one, built the way the wizard would build it, when it does not.
//
// A proposal says what it needs (`toolSpec`) and not which tool, because which
// tool depends on what the user already owns. A 6mm drill in the rack is the
// 6mm drill; a missing one is made, with speeds for the stock it will cut,
// numbered after the highest number in use so it clashes with nothing.

import { createTool } from './schema.js';
import { defaultsForType, suggestCutting, suggestName } from './tool-library.js';
import { MILL_SIZES } from '../engine/features.js';

const DIAMETER_MATCH = 0.05;

/** The largest standard end mill size not over `limit`, or the smallest there is. */
export function millSizeFor(limit) {
  const fits = MILL_SIZES.filter((d) => d <= limit + 1e-9);
  return fits.length ? fits[fits.length - 1] : MILL_SIZES[0];
}

/**
 * @param spec a proposal's toolSpec
 * @param tools the project's tools
 * @param options.material the setup's material id, for the new tool's speeds
 * @param options.rackOnly use only what is in `tools`. Defaults to whether the
 *   project has any tools at all: somebody who has set up their own drawer owns
 *   those cutters and no others, so a proposal is never allowed to invent one —
 *   it says what it is missing. A project with an empty rack is one that has not
 *   chosen yet, and gets cutters built the way the wizard would build them.
 * @returns { tool, created, note, missing } — `tool` is the one to use; when
 *   `created` it is new and has to be added to the project; when it is null
 *   nothing in the rack does the job and `missing` says what would
 */
export function toolForSpec(spec, tools, { material, rackOnly = tools.length > 0 } = {}) {
  const milling = tools.filter((t) => ['flat', 'bull', 'face', 'ball', 'drill', 'spot', 'tap', 'chamfer', 'threadmill'].includes(t.type));
  const pick = (list, by) => list.sort(by)[0] ?? null;
  const found = (tool) => ({ tool, created: false, note: 'in the rack' });
  const made = (type, over) => ({ tool: build(type, over, tools, material), created: true, note: 'new' });
  const none = (what) => ({ tool: null, created: false, note: 'not in your tools', missing: what });

  if (spec.family === 'drill') {
    const have = milling.find((t) => t.type === 'drill' && !(t.tipAngle > 0 && t.tipAngle <= 100)
      && Math.abs(t.diameter - spec.diameter) <= DIAMETER_MATCH);
    if (have) return found(have);
    return rackOnly ? none(`a ⌀${spec.diameter} drill`) : made('drill', { diameter: spec.diameter });
  }
  if (spec.family === 'tap') {
    const have = milling.find((t) => t.type === 'tap' && Math.abs(t.diameter - spec.nominal) <= 0.1
      && Math.abs((t.pitch ?? 0) - spec.pitch) <= 0.01);
    if (have) return found(have);
    return rackOnly ? none(`an M${spec.nominal}×${spec.pitch} tap`) : made('tap', { diameter: spec.nominal, pitch: spec.pitch });
  }
  if (spec.family === 'spot') {
    // no wider than the way down to the holes allows, when that is limited — a
    // hole at the bottom of a narrow pocket is not spotted by a cutter that will
    // not go into the pocket
    const limit = spec.maxDiameter ?? Infinity;
    const have = pick(milling.filter((t) => t.type === 'spot' && t.diameter <= limit + 1e-9), (a, b) => b.diameter - a.diameter);
    if (have) return found(have);
    if (rackOnly) return none(limit === Infinity ? 'a spot drill' : `a spot drill of ⌀${Math.round(limit * 10) / 10} or under`);
    return made('spot', { diameter: limit === Infinity ? 6 : Math.min(6, millSizeFor(limit)), tipAngle: 90 });
  }
  if (spec.family === 'face') {
    const mill = pick(milling.filter((t) => t.type === 'face'), (a, b) => b.diameter - a.diameter)
      ?? pick(milling.filter((t) => t.type === 'flat' || t.type === 'bull'), (a, b) => b.diameter - a.diameter);
    if (mill) return found(mill);
    return rackOnly ? none('a face mill or an end mill') : made('flat', { diameter: 12 });
  }
  // A ball nose: the largest that is no bigger than the size asked for, because a
  // slope is not narrower than any cutter, and the smallest there is when the
  // rack has only larger ones — a ball cuts a slope at any size, only slower.
  if (spec.family === 'ball') {
    const limit = spec.maxDiameter > 0 ? spec.maxDiameter : Infinity;
    const balls = milling.filter((t) => t.type === 'ball');
    const have = pick(balls.filter((t) => t.diameter <= limit + 1e-9), (a, b) => b.diameter - a.diameter)
      ?? pick(balls, (a, b) => a.diameter - b.diameter);
    if (have) return found(have);
    return rackOnly ? none('a ball nose end mill') : made('ball', { diameter: millSizeFor(limit === Infinity ? 6 : limit) });
  }
  // an end mill, no wider than the feature allows. `soft` is a size preferred
  // and not a size required (the outline and the roughing are not narrower than
  // anything): a rack with only wider ones gets the narrowest of them.
  const limit = spec.maxDiameter > 0 ? spec.maxDiameter : Infinity;
  const mills = milling.filter((t) => t.type === 'flat' || t.type === 'bull');
  const have = pick(mills.filter((t) => t.diameter <= limit + 1e-9), (a, b) => b.diameter - a.diameter)
    ?? (spec.soft ? pick(mills, (a, b) => a.diameter - b.diameter) : null);
  if (have) return found(have);
  if (rackOnly) return none(limit === Infinity ? 'an end mill' : `an end mill of ⌀${Math.round(limit * 10) / 10} or under`);
  return made('flat', { diameter: millSizeFor(limit === Infinity ? 12 : limit) });
}

/** A tool of this family and size with speeds for the material, numbered clear of the rack. */
function build(type, over, tools, material) {
  const tool = createTool(type);
  Object.assign(tool, defaultsForType(type, over), over);
  const cut = suggestCutting({
    type, diameter: tool.diameter, tipAngle: tool.tipAngle, pitch: tool.pitch, material,
  });
  Object.assign(tool, cut);
  tool.number = tools.reduce((n, t) => Math.max(n, t.number ?? 0), 0) + 1;
  tool.name = suggestName(tool);
  return tool;
}
