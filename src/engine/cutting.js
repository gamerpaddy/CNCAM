// Effective cutting numbers for an operation.
//
// The tool carries a default RPM and feed — call it the cutter's home speed —
// but any given operation may need something different: a heavier chip on a
// rougher, a lighter cut on a finishing pass, a lower spindle for a plunge.
// Rather than force the user to duplicate tools for each case, an operation can
// override any of the three; missing values inherit from the tool.
//
// Derived numbers (surface speed, chip load, feed per tooth) tell you whether
// the settings are sane — high RPM with a slow feed leaves the cutter rubbing,
// low RPM with a fast feed loads it beyond what it can chew. The panel shows
// them so a user can adjust with feedback rather than by guessing.

/**
 * Merge an op's own speeds/feeds with the tool's, op winning where set.
 * @returns { spindleRpm, feedCut, feedPlunge, spindleDir }
 */
export function effectiveCutting(op, tool) {
  const p = op?.params ?? {};
  return {
    spindleRpm: numberOr(p.spindleRpm, tool?.spindleRpm ?? 0),
    feedCut: numberOr(p.feedCut, tool?.feedCut ?? 0),
    feedPlunge: numberOr(p.feedPlunge, tool?.feedPlunge ?? 0),
    spindleDir: tool?.spindleDir ?? 'cw',
  };
}

function numberOr(override, fallback) {
  return typeof override === 'number' && Number.isFinite(override) && override > 0
    ? override : fallback;
}

/**
 * Derived cutting numbers, from the tool geometry and the effective speeds.
 *
 * Surface speed (m/min or sfm) is π·D·rpm, what a machinist compares to a
 * material-specific target. Feed per tooth (mm) is feed / (rpm · flutes), the
 * bite each edge takes, which determines chip load. Reported as null when the
 * inputs are missing, so the UI can show a dash rather than a nonsense zero.
 */
export function cuttingReport(op, tool) {
  if (!tool) return null;
  const { spindleRpm, feedCut, feedPlunge } = effectiveCutting(op, tool);
  const d = tool.diameter;

  const rpm = spindleRpm > 0 ? spindleRpm : null;
  const surfaceMmPerMin = rpm ? Math.PI * d * rpm : null;
  const feedPerTooth = rpm && tool.flutes > 0 && feedCut > 0
    ? feedCut / (rpm * tool.flutes) : null;

  return {
    diameter: d,
    flutes: tool.flutes ?? null,
    spindleRpm: rpm,
    feedCut: feedCut > 0 ? feedCut : null,
    feedPlunge: feedPlunge > 0 ? feedPlunge : null,
    // metric surface speed in m/min
    surfaceSpeed: surfaceMmPerMin != null ? surfaceMmPerMin / 1000 : null,
    // imperial equivalent for shops that read sfm
    surfaceSpeedSfm: surfaceMmPerMin != null ? (surfaceMmPerMin / 304.8) : null,
    feedPerTooth,
  };
}

/**
 * Emit the effective cutting state on a CL builder.
 *
 * Strategies used to call `cl.spindle(tool.spindleRpm)` directly and `event(
 * 'feeds', tool.feedCut)`, which locked every op to its tool. Going through
 * here lets an op override without every strategy learning the fallback rule.
 */
export function applyCutting(cl, op, tool) {
  const c = effectiveCutting(op, tool);
  const p = op?.params ?? {};
  // Constant surface speed: the spindle winds up as the tool works in toward
  // the axis, so the metres per minute stay where the insert wants them. Only
  // a lathe can do it — on a mill the cutter's diameter is fixed and there is
  // nothing to hold constant — and it always carries a maximum rpm, because as
  // the tool reaches the centre the commanded speed goes to infinity.
  const css = p.spindleMode === 'css' && p.surfaceSpeed > 0;
  cl.spindle(c.spindleRpm, c.spindleDir, css
    ? {
      mode: 'css',
      surfaceSpeed: p.surfaceSpeed,
      maxRpm: p.cssMaxRpm > 0 ? p.cssMaxRpm : c.spindleRpm,
    }
    : {});
  // Stated every time, including "off".
  //
  // Only asking for coolant meant an operation could never turn it off: rough
  // with flood, finish with the field set to Off, and the pump ran through the
  // finishing pass with nothing in the file to stop it — the one setting whose
  // own hint says "off for a finishing pass you want to watch". An operation
  // knows what it wants; what it must not do is inherit what the last one
  // wanted. The post drops the restatement when the coolant is already where it
  // is asked to be, exactly as it does for the tool and the spindle.
  cl.coolant(p.coolant ?? 'off');
  cl.event('feeds', { cut: c.feedCut, plunge: c.feedPlunge });
}
