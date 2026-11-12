// Is this cut sane for this material, and can the spindle do it?
//
// `cuttingReport` says what the numbers are (surface speed, chip load); this says
// what they mean once the material and the machine are known. The tool library's
// own `toolWarnings` has to keep its bands wide — it sees a cutter with no
// material — so the check that can be narrow lives here, on an operation, where
// the stock it will cut is a fact.
//
// Everything is a sentence or a number the panel can print; nothing here
// changes a toolpath.

import { effectiveCutting } from './cutting.js';
import { isLatheTool } from './insert.js';
import { suggestCutting } from '../doc/tool-library.js';
import { chipThinningFactor, cuttingPowerKw, materialOf, removalRate } from '../doc/materials.js';

/**
 * The radial and axial width of the cut this operation takes, in mm, where the
 * strategy states them — and null where it does not, so no power is guessed.
 *
 * A pocket or a facing pass is `stepover × D` wide; adaptive holds a stated
 * bite. A slot is the whole cutter. Contours, finishing and the rest take
 * whatever the part shape leaves, which a setting cannot say.
 */
export function cutWidths(op, tool) {
  const p = op?.params ?? {};
  const d = tool?.diameter ?? 0;
  if (!(d > 0)) return { ae: null, ap: null };
  let ae = null;
  if (op.type === 'adaptive' && p.engagement > 0) ae = p.engagement * d;
  else if (['pocket', 'clear2d', 'face', 'bore'].includes(op.type) && p.stepover > 0) ae = p.stepover * d;
  else if (op.type === 'slot') ae = d;
  const ap = p.stepdown > 0 ? p.stepdown : null;
  return { ae, ap };
}

/**
 * @param op the operation
 * @param tool its tool
 * @param materialId the setup's material
 * @param machine the machine record, or null
 * @returns null for a lathe tool or no tool, else
 *   { vc, expectedVc, chip, expectedChip, ae, ap, mrr, powerKw, spindleKw, warnings }
 */
export function cutCheck(op, tool, materialId, machine = null) {
  if (!tool || isLatheTool(tool.type) || !(tool.diameter > 0)) return null;
  const c = effectiveCutting(op, tool);
  const { ae, ap } = cutWidths(op, tool);
  const material = materialOf(materialId);
  // what the table would have for this cutter in this material, at this bite
  const want = suggestCutting({
    type: tool.type, diameter: tool.diameter, flutes: tool.flutes, tipAngle: tool.tipAngle,
    pitch: tool.pitch, material: material.id, radialEngagement: ae ? ae / tool.diameter : undefined,
  });
  const teeth = Math.max(1, tool.flutes ?? 1);
  const vc = c.spindleRpm > 0 ? (Math.PI * tool.diameter * c.spindleRpm) / 1000 : null;
  const expectedVc = (Math.PI * tool.diameter * want.spindleRpm) / 1000;
  const chip = c.spindleRpm > 0 && c.feedCut > 0 ? c.feedCut / (c.spindleRpm * teeth) : null;
  const expectedChip = want.spindleRpm > 0 ? want.feedCut / (want.spindleRpm * teeth) : null;
  const thinning = ae ? chipThinningFactor(ae / tool.diameter) : 1;

  const warnings = [];
  const family = tool.type;
  // A tap's feed is its pitch and a drill never does anything but plunge, so a
  // chip load against a milling table says nothing about them.
  const milling = !['tap', 'drill', 'spot'].includes(family);
  if (vc && milling && vc > expectedVc * 2.2) {
    warnings.push(`${vc.toFixed(0)} m/min is more than twice the ${expectedVc.toFixed(0)} m/min `
      + `usual for this cutter in ${material.name} — it will burn the edge.`);
  } else if (vc && milling && vc < expectedVc * 0.3) {
    warnings.push(`${vc.toFixed(0)} m/min is under a third of the ${expectedVc.toFixed(0)} m/min `
      + `usual in ${material.name} — it will rub rather than cut.`);
  }
  if (chip && expectedChip && milling) {
    if (chip > expectedChip * 2.2) {
      warnings.push(`${chip.toFixed(3)} mm per tooth is more than twice the ${expectedChip.toFixed(3)} mm `
        + `usual in ${material.name}${ae ? ` at this width of cut` : ''}.`);
    } else if (chip < expectedChip * 0.3) {
      warnings.push(`${chip.toFixed(3)} mm per tooth is under a third of the ${expectedChip.toFixed(3)} mm `
        + `usual in ${material.name}${thinning > 1.05 ? ' (a light cut thins the chip, so it wants more)' : ''}.`);
    }
  }

  let powerKw = 0;
  let mrr = 0;
  const spindleKw = machine?.spindlePower > 0 ? machine.spindlePower : null;
  if (ae && ap && c.feedCut > 0) {
    mrr = removalRate({ ae, ap, feed: c.feedCut });
    powerKw = cuttingPowerKw({ ae, ap, feed: c.feedCut, material: material.id });
    if (spindleKw && powerKw > spindleKw) {
      warnings.push(`This cut takes about ${powerKw.toFixed(1)} kW in ${material.name} and the spindle has `
        + `${spindleKw} kW: it will stall. Take less depth or width, or slow the feed.`);
    }
  }
  return { vc, expectedVc, chip, expectedChip, ae, ap, mrr, powerKw, spindleKw, warnings, material };
}
