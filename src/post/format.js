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

/**
 * A block of hand-written G-code, dropped into the program as it was typed.
 *
 * Blank lines go, because a text box collects them and a program does not want
 * them; nothing else is touched. In particular nothing here validates: the
 * whole value of a custom block is that it can say things this post has never
 * heard of — a probe macro, an M-code that opens a guard, a subroutine call —
 * and a post that "helpfully" dropped what it did not recognise would be
 * useless for precisely the cases it exists for.
 *
 * The comment above it is not decoration. When a file misbehaves at the machine
 * the first question is which lines came from the CAM, and a labelled block
 * answers it without anybody having to remember what was in a settings box.
 *
 * @returns whether anything was written
 */
export function customBlock(w, text, label) {
  const lines = String(text ?? '').split(/\r?\n/)
    .map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  w.comment(label);
  for (const line of lines) w.raw(line);
  return true;
}

/**
 * The characters a comment may not carry to the machine, and what stands in.
 *
 * A comment is not inert on its way to a control. GRBL 1.1 picks its realtime
 * commands out of the serial stream the moment each byte arrives — before any
 * parsing, and so inside a comment as much as outside one — and every one of
 * them is a byte from 0x80 up. UTF-8 is made of such bytes: the em dash in
 * `(fit tool T2 — press cycle start)` is E2 80 94, and 0x94 is *feed override
 * −1%*. A GRBL program from this post turned the feed down a percent at every
 * dash in it, and the `×` in a slot's summary (C3 97) is *rapid override 25%*.
 * An `à` toggles the flood coolant, and an `Ä` in an operation's name is the
 * safety door. Older controls simply alarm on a byte they do not know.
 *
 * So a comment is written in ASCII, whatever it was written in: the symbols
 * this app uses in its own sentences get their shop-floor spelling, accented
 * letters lose the accent (German's pairs are written out, the way German is
 * written without them), and anything left is a `?` — seen, and harmless.
 */
const ASCII = {
  '—': '-', '–': '-', '‒': '-', '−': '-', '‐': '-', '‑': '-',
  '⌀': 'D', 'Ø': 'D', 'ø': 'D',
  '×': 'x', '°': 'deg', 'µ': 'u', 'μ': 'u', '±': '+/-',
  '≤': '<=', '≥': '>=', '≈': '~', '→': '->', '←': '<-', '…': '...',
  '·': '.', '•': '*', '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"',
  '′': "'", '″': '"', '½': '1/2', '¼': '1/4', '¾': '3/4', '²': '2', '³': '3',
  'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss',
  'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D',
};

export function asciiComment(text) {
  return String(text ?? '')
    // composed first, so an ä typed as a + ¨ still finds its spelling below
    .normalize('NFC')
    .replace(/[^\x20-\x7e]/g, (c) => ASCII[c] ?? c)
    // what is left is either an accented letter, which decomposes into its
    // letter and an accent that can be dropped, or something with no ASCII
    // spelling at all
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // a line break would end the comment and run the rest of it as G-code
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?');
}

export class LineWriter {
  constructor() { this.lines = []; }

  /** Joins non-null words with spaces; skips the line if nothing remains. */
  line(...words) {
    const text = words.filter((w) => w != null && w !== '').join(' ');
    if (text) this.lines.push(text);
  }

  comment(text) { this.lines.push(`(${asciiComment(text).replace(/[()]/g, '')})`); }
  raw(text) { this.lines.push(text); }
  toString() { return this.lines.join('\n') + '\n'; }
}
