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
 * @returns { tool, created, note } — `tool` is the one to use; when `created` it
 *   is new and has to be added to the project
 */
export function toolForSpec(spec, tools, { material } = {}) {
  const milling = tools.filter((t) => ['flat', 'bull', 'face', 'ball', 'drill', 'spot', 'tap', 'chamfer', 'threadmill'].includes(t.type));
  const pick = (list, by) => list.sort(by)[0] ?? null;

  if (spec.family === 'drill') {
    const have = milling.find((t) => t.type === 'drill' && !(t.tipAngle > 0 && t.tipAngle <= 100)
      && Math.abs(t.diameter - spec.diameter) <= DIAMETER_MATCH);
    if (have) return { tool: have, created: false, note: 'in the rack' };
    return { tool: build('drill', { diameter: spec.diameter }, tools, material), created: true, note: 'new' };
  }
  if (spec.family === 'tap') {
    const have = milling.find((t) => t.type === 'tap' && Math.abs(t.diameter - spec.nominal) <= 0.1
      && Math.abs((t.pitch ?? 0) - spec.pitch) <= 0.01);
    if (have) return { tool: have, created: false, note: 'in the rack' };
    return { tool: build('tap', { diameter: spec.nominal, pitch: spec.pitch }, tools, material), created: true, note: 'new' };
  }
  if (spec.family === 'spot') {
    const have = pick(milling.filter((t) => t.type === 'spot'), (a, b) => b.diameter - a.diameter);
    if (have) return { tool: have, created: false, note: 'in the rack' };
    return { tool: build('spot', { diameter: 6, tipAngle: 90 }, tools, material), created: true, note: 'new' };
  }
  if (spec.family === 'face') {
    const mill = pick(milling.filter((t) => t.type === 'face'), (a, b) => b.diameter - a.diameter)
      ?? pick(milling.filter((t) => t.type === 'flat' || t.type === 'bull'), (a, b) => b.diameter - a.diameter);
    if (mill) return { tool: mill, created: false, note: 'in the rack' };
    return { tool: build('flat', { diameter: 12 }, tools, material), created: true, note: 'new' };
  }
  // an end mill, no wider than the feature allows
  const limit = spec.maxDiameter > 0 ? spec.maxDiameter : Infinity;
  const ends = milling.filter((t) => (t.type === 'flat' || t.type === 'bull') && t.diameter <= limit + 1e-9);
  const have = pick(ends, (a, b) => b.diameter - a.diameter);
  if (have) return { tool: have, created: false, note: 'in the rack' };
  return {
    tool: build('flat', { diameter: millSizeFor(limit === Infinity ? 12 : limit) }, tools, material),
    created: true,
    note: 'new',
  };
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
