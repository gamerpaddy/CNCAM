// What the stock is made of — the one description of how it cuts.
//
// The tool library's starting speeds are for aluminium, because that is what a
// first job on a hobby machine is. Anything harder wants a fraction of them, and
// the fraction is a property of the *material*, not of the tool: so it lives
// here, once, and the wizard, the "use these speeds" button, the cutting report
// and the power check all read it. (How the billet *looks* in the simulation is
// the `look` field; the visual setting used to be a second list of the same
// names and had nothing to do with how it cuts.)
//
// Every number is a starting point to edit, in the same spirit as the tables in
// tool-library.js — conservative, for carbide on a rigid machine. None of it
// is a promise about the cut.

/**
 * @property speed   surface-speed multipliers against the library's baseline
 *   (aluminium = 1), by kind of cutting: a mill, a drill or tap, a lathe tool.
 *   A drill is kept separate because the library's baseline for it is already a
 *   steel-ish figure, and a lathe's is for free-cutting steel.
 * @property chip    multiplier on the chip load (feed per tooth)
 * @property kc      specific cutting force, N/mm² — what it takes to shear a
 *   square millimetre of chip; with the metal removal rate it gives the power
 * @property look    which of the simulation's looks draws it
 */
export const MATERIALS = [
  { id: 'aluminium', name: 'Aluminium (6061)', speed: { mill: 1, drill: 1, turn: 2.6 }, chip: 1, kc: 700, look: 'aluminium' },
  { id: 'brass', name: 'Brass', speed: { mill: 0.8, drill: 1.6, turn: 2.2 }, chip: 1, kc: 800, look: 'brass' },
  { id: 'plastic', name: 'Plastic (acetal, nylon)', speed: { mill: 1.2, drill: 1.6, turn: 2.4 }, chip: 1.4, kc: 250, look: 'plastic' },
  { id: 'wood', name: 'Wood / MDF', speed: { mill: 1.4, drill: 1.5, turn: 2.4 }, chip: 2, kc: 60, look: 'wood' },
  { id: 'mild-steel', name: 'Mild steel', speed: { mill: 0.3, drill: 0.8, turn: 1 }, chip: 0.8, kc: 1900, look: 'steel' },
  { id: 'stainless', name: 'Stainless steel', speed: { mill: 0.18, drill: 0.5, turn: 0.6 }, chip: 0.7, kc: 2400, look: 'steel' },
  { id: 'titanium', name: 'Titanium', speed: { mill: 0.12, drill: 0.35, turn: 0.4 }, chip: 0.6, kc: 1400, look: 'steel' },
];

export const DEFAULT_MATERIAL = 'aluminium';

/** The material with this id; the default for an id this build does not know. */
export function materialOf(id) {
  return MATERIALS.find((m) => m.id === id) ?? MATERIALS.find((m) => m.id === DEFAULT_MATERIAL);
}

export function isMaterialId(id) {
  return MATERIALS.some((m) => m.id === id);
}

/** Which of the three speed multipliers a cutter family takes. */
export function speedKindOf(family) {
  if (family === 'drill' || family === 'spot' || family === 'tap') return 'drill';
  if (['turning', 'boring', 'parting', 'threading'].includes(family)) return 'turn';
  return 'mill';
}

/**
 * Chip thinning: with a light radial cut the chip is thinner than the feed per
 * tooth says it is, so the cutter is rubbing unless the feed is raised to keep
 * the chip as thick as the table intends.
 *
 * `ae` is the radial engagement as a fraction of the cutter's diameter. Past
 * half the diameter there is no thinning (a slot is the full chip) and below it
 * the multiplier is 1/sqrt(1 − (1 − 2·ae)²), the textbook figure. It is capped:
 * at ae = 1% it is 5×, and no end mill wants a feed five times its table.
 */
export function chipThinningFactor(ae) {
  if (!(ae > 0) || ae >= 0.5) return 1;
  const k = 1 - (1 - 2 * ae) ** 2;
  return Math.min(2.5, 1 / Math.sqrt(k));
}

/**
 * Spindle power the cut takes, in kW at the spindle: metal removal rate times
 * the specific cutting force, over an efficiency (the drive and the belts).
 *
 * @param ae radial width of cut, mm
 * @param ap axial depth of cut, mm
 * @param feed mm/min
 */
export function cuttingPowerKw({ ae, ap, feed, material, efficiency = 0.8 }) {
  if (!(ae > 0 && ap > 0 && feed > 0)) return 0;
  const mrr = ae * ap * feed;                  // mm³/min
  const kc = materialOf(material)?.kc ?? 0;
  return (mrr * kc) / (60 * 1e6 * efficiency);
}

/** The metal removal rate in cm³/min, the figure a shop quotes. */
export function removalRate({ ae, ap, feed }) {
  return ae > 0 && ap > 0 && feed > 0 ? (ae * ap * feed) / 1000 : 0;
}
