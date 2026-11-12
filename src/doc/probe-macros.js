// Touch-off blocks for a Command operation: the G-code that finds the work.
//
// This writes text and nothing else. It does not talk to a machine, it cannot
// run a probe, and it never will — see docs/internals.md, "Never controls the
// machine". The result is a block for the operator to read, put in a Command
// operation and run from the machine's own screen, so everything it needs to
// get right it must get right on the page: the arithmetic, the order of the
// moves, and the state it leaves the control in.
//
// What it leaves behind, deliberately:
//   - the spindle is OFF before the first probe move. A probe is a delicate
//     part and a spinning cutter is not a thing to push one with. GRBL's M0 is a
//     feed hold that leaves the spindle running, so the pause (where there is
//     one) is only ever written after the M5.
//   - G90 again at the end. Every move here is incremental, because a probe is
//     "toward" something and not "to" it, and a G91 left on is the program after
//     it running at the wrong place by the length of the part.
//   - the work offset set to the number the macro says, by G10 L20, which both
//     LinuxCNC and GRBL read as "make where the tool is now be this value".
//
// G38.2 is used, never G38.3 (which does not stop on a miss): a probe that finds
// nothing must alarm and stop the program, not carry on to cut air.

import { asciiComment } from '../post/format.js';

/** What each macro is, for the picker and the field list. */
export const PROBE_KINDS = [
  { id: 'z', label: 'Z — top surface or tool setter' },
  { id: 'edge', label: 'X or Y — one edge' },
  { id: 'corner', label: 'X and Y — outside corner' },
  { id: 'bore', label: 'X and Y — centre of a bore (LinuxCNC)' },
];

export const PROBE_DEFAULTS = {
  feed: 100,         // mm/min onto the work
  travel: 25,        // how far to look before giving up
  retract: 3,        // mm backed off after a touch
  radius: 1.5,       // the probe tip's radius, mm (half of a 3mm ball)
  thickness: 0,      // a touch plate or tool setter's height above the work, mm
  wcs: 'G54',
  axis: 'X',         // edge: X or Y
  direction: 1,      // edge: +1 moves toward +, −1 toward −
  gap: 5,            // corner: how far outside the part the start is
  inset: 10,         // corner: how far along the faces the start is
  diameter: 20,      // bore: roughly how wide it is, mm
  pause: true,       // stop for the operator to fit the probe first
};

const WCS = { G54: 1, G55: 2, G56: 3, G57: 4, G58: 5, G59: 6 };

/** A number the way a control reads it: no exponent, no trailing zeros. */
const n = (v) => {
  const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
};

/** A comment safe for GRBL: ASCII, no parentheses inside, bounded. */
const note = (text) => `(${asciiComment(text).replace(/[()]/g, '')})`;

/**
 * @param spec.kind  one of PROBE_KINDS
 * @param spec.post  'linuxcnc' or 'grbl' — the lathe post has no use for these
 * @returns { name, gcode } or { error } — never throws, never writes a block
 *   from numbers it could not use
 */
export function probeMacro(spec = {}) {
  const p = { ...PROBE_DEFAULTS, ...spec };
  const post = spec.post ?? 'linuxcnc';
  if (post !== 'linuxcnc' && post !== 'grbl') {
    return { error: 'Probing blocks are written for a milling post (LinuxCNC or GRBL).' };
  }
  const positive = (key, label) => (Number.isFinite(p[key]) && p[key] > 0 ? null : `${label} must be more than zero.`);
  const nonNegative = (key, label) => (Number.isFinite(p[key]) && p[key] >= 0 ? null : `${label} cannot be negative.`);
  const problem = positive('feed', 'The probe feed') || positive('travel', 'The search distance')
    || nonNegative('retract', 'The back-off') || nonNegative('radius', 'The probe radius')
    || (Number.isFinite(p.thickness) ? null : 'The plate height is not a number.')
    || (WCS[p.wcs] ? null : `${p.wcs} is not a work offset (G54 to G59).`);
  if (problem) return { error: problem };
  if (p.feed > 500) return { error: 'A probe feed over 500 mm/min is how a probe is broken. Use a slower one.' };
  if (p.travel > 200) return { error: 'A search distance over 200 mm is longer than any sensible touch-off.' };
  const P = WCS[p.wcs];
  const set = (axes) => `G10 L20 P${P} ${axes}`;

  const lines = [];
  const head = (title) => {
    lines.push(note(title));
    lines.push('M5');
    if (p.pause) lines.push('M0 (fit the probe, then Cycle Start)');
    lines.push('G91');
  };
  const probe = (axis, distance) => lines.push(`G38.2 ${axis}${n(distance)} F${n(p.feed)}`);
  const move = (axes) => lines.push(`G0 ${axes}`);
  const tail = () => lines.push('G90');

  if (p.kind === 'z') {
    head(`Probe Z on ${p.wcs}: the tool tip finds the surface`);
    probe('Z', -p.travel);
    // the tool is on the surface; the plate it sits on is `thickness` above the
    // work, so that is the value Z is told to be
    lines.push(set(`Z${n(p.thickness)}`));
    move(`Z${n(Math.max(p.retract, 0) + 2)}`);
    tail();
    return { name: `Probe Z ${p.wcs}`, gcode: lines.join('\n') };
  }

  if (p.kind === 'edge') {
    const axis = String(p.axis).toUpperCase();
    if (axis !== 'X' && axis !== 'Y') return { error: 'An edge is probed in X or Y.' };
    const dir = p.direction < 0 ? -1 : 1;
    head(`Probe ${axis} edge on ${p.wcs}: moving ${dir > 0 ? 'positive' : 'negative'}`);
    probe(axis, dir * p.travel);
    // Touching the face, the probe's centre is one radius short of it: on the
    // near side of the face, which is the minus side when moving plus.
    lines.push(set(`${axis}${n(-dir * p.radius)}`));
    move(`${axis}${n(-dir * p.retract)}`);
    tail();
    return { name: `Probe ${axis}${dir > 0 ? '+' : '-'} ${p.wcs}`, gcode: lines.join('\n') };
  }

  if (p.kind === 'corner') {
    // The start is outside the lower-left corner: `gap` to the left of the left
    // face and `inset` above the front face, on the part's side of it.
    head(`Probe the lower-left corner on ${p.wcs}: start ${n(p.gap)} left of the part and ${n(p.inset)} up from its front face`);
    probe('X', p.travel);
    lines.push(set(`X${n(-p.radius)}`));
    move(`X${n(-p.gap)}`);
    move(`Y${n(-(p.inset + p.gap))}`);
    move(`X${n(p.inset + p.gap)}`);
    probe('Y', p.travel);
    lines.push(set(`Y${n(-p.radius)}`));
    move(`Y${n(-p.retract)}`);
    tail();
    return { name: `Probe corner ${p.wcs}`, gcode: lines.join('\n') };
  }

  if (p.kind === 'bore') {
    if (post !== 'linuxcnc') {
      return { error: 'Finding the centre of a bore needs the control to do arithmetic on what it probed. '
        + 'GRBL has no parameters to hold it, so this block is for LinuxCNC only.' };
    }
    if (!(p.diameter > 0 && p.diameter <= 500)) return { error: 'Give the bore’s rough diameter (up to 500 mm).' };
    // Far enough to reach the wall from anywhere inside it; on the way out the
    // second probe has to cross the whole bore.
    const reach = p.diameter / 2 + p.travel;
    const across = p.diameter + 2 * p.travel;
    head(`Probe the centre of a bore on ${p.wcs}: start near the middle, about ${n(p.diameter)} wide`);
    for (const axis of ['X', 'Y', 'X']) {
      const plus = `#<${axis.toLowerCase()}p>`;
      const minus = `#<${axis.toLowerCase()}m>`;
      const read = axis === 'X' ? '#5061' : '#5062';
      probe(axis, reach);
      lines.push(`${plus} = ${read}`);
      move(`${axis}${n(-p.retract)}`);
      probe(axis, -across);
      lines.push(`${minus} = ${read}`);
      move(`${axis}${n(p.retract)}`);
      // The probe's radius is on both walls, so it cancels out of the middle.
      lines.push('G90');
      lines.push(`G0 ${axis}[[${plus} + ${minus}] / 2]`);
      lines.push('G91');
    }
    lines.push(set('X0 Y0'));
    lines.push(`#<bore_diameter> = [#<xp> - #<xm> - ${n(2 * p.radius)}]`);
    lines.push(`(DEBUG, bore diameter %f mm: #<bore_diameter>)`);
    tail();
    return { name: `Probe bore centre ${p.wcs}`, gcode: lines.join('\n') };
  }

  return { error: `Unknown probing block: ${p.kind}` };
}
