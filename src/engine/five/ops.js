// Which operations are the 5-axis beta's.
//
// One list, read by the picker (to hide them), by opBlockedReason (to refuse
// them), by the fingerprint (to know when a pivot edit matters) and by the post
// (to know which programs carry a tilted tool). The engine itself never reads
// the Experimental preference — it runs in a worker with no settings — so the
// switch lives in the app layer and this module only names what it guards.

export const FIVE_AXIS_OPS = new Set(['finish5']);

export function isFiveAxisOp(type) {
  return FIVE_AXIS_OPS.has(type);
}
