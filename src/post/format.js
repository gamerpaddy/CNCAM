// Post formatting toolkit: number formatting and modal word tracking.
// Dialect posts (grbl.js, ...) build on this.

export function num(value, decimals = 3) {
  // fixed decimals, then strip trailing zeros (GRBL/Fanuc-friendly)
  let s = value.toFixed(decimals);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * Which way the spindle is being asked to turn, as the word that says so.
 *
 * `dir` is carried on every spindle event and was read by nobody: both milling
 * dialects wrote M3 whatever it said, so a left-hand cutter — or a lathe tool
 * working on the far side of the axis — ran backwards. Stated once, because
 * three dialects were about to state it three times.
 */
export function spindleWord(dir) {
  return dir === 'ccw' || dir === 'reverse' || dir === -1 ? 'M4' : 'M3';
}

/** Tracks modal state; word() returns the formatted word only when it changed. */
export class Modal {
  constructor() { this.state = new Map(); }

  word(letter, value, decimals = 3) {
    const text = typeof value === 'number' ? num(value, decimals) : String(value);
    if (this.state.get(letter) === text) return null;
    this.state.set(letter, text);
    return letter + text;
  }

  force(letter) { this.state.delete(letter); }
  reset() { this.state.clear(); }
}

export class LineWriter {
  constructor() { this.lines = []; }

  /** Joins non-null words with spaces; skips the line if nothing remains. */
  line(...words) {
    const text = words.filter((w) => w != null && w !== '').join(' ');
    if (text) this.lines.push(text);
  }

  comment(text) { this.lines.push(`(${text.replace(/[()]/g, '')})`); }
  raw(text) { this.lines.push(text); }
  toString() { return this.lines.join('\n') + '\n'; }
}
