// G-code preview panel: shows the posted program, clicking a line drops a
// marker in the viewport at that move (via the post's lineMap).

import { MOVE_STRIDE, OP } from '../engine/cl.js';
import { plural } from '../engine/text.js';
import { el } from './layout.js';

/**
 * The height of one listing row, in pixels. Must match `.gcode-line` in
 * styles.css: the listing is drawn from the scroll position by arithmetic, and
 * arithmetic and CSS disagreeing is a listing that drifts as you scroll.
 */
const LINE_HEIGHT = 17;

/** Rows drawn above and below the visible ones, so a flick does not show gaps. */
const OVERSCAN = 8;

/**
 * The colour each kind of word is shown in: motion and modes, machine
 * functions, where the tool goes, how fast, which tool — and comments, which
 * step back. Read the way a program is read, by scanning a column of G words
 * for the one that changes, so that is the one that is brightest.
 */
const WORD_CLASS = {
  G: 'gc-g', M: 'gc-m',
  X: 'gc-ax', Y: 'gc-ax', Z: 'gc-ax', A: 'gc-ax', B: 'gc-ax', C: 'gc-ax', U: 'gc-ax', W: 'gc-ax',
  I: 'gc-arc', J: 'gc-arc', K: 'gc-arc', R: 'gc-arc',
  F: 'gc-f', S: 'gc-f',
  T: 'gc-t', H: 'gc-t', D: 'gc-t',
  N: 'gc-n',
  P: 'gc-p', Q: 'gc-p', L: 'gc-p', E: 'gc-p',
};
const NUMBER_CHAR = /[-+0-9.]/;

/**
 * One line of G-code as coloured words. Only the rows on screen are ever drawn,
 * so this runs a few dozen times a scroll, never over the whole program.
 */
function highlighted(line) {
  const out = [];
  let plain = '';
  const flush = () => { if (plain) { out.push(plain); plain = ''; } };
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '(') {
      const close = line.indexOf(')', i);
      const stop = close < 0 ? line.length : close + 1;
      flush();
      out.push(el('span', { class: 'gc-c' }, [line.slice(i, stop)]));
      i = stop;
    } else if (ch === ';') {
      flush();
      out.push(el('span', { class: 'gc-c' }, [line.slice(i)]));
      break;
    } else {
      const kind = WORD_CLASS[ch.toUpperCase()];
      let j = i + 1;
      if (kind) while (j < line.length && NUMBER_CHAR.test(line[j])) j++;
      if (kind && j > i + 1) {
        flush();
        out.push(el('span', { class: kind }, [line.slice(i, j)]));
        i = j;
      } else {
        plain += ch;
        i++;
      }
    }
  }
  flush();
  return out;
}

/**
 * Show the posted program.
 *
 * Only the rows you can see are in the DOM. A program is tens of thousands of
 * lines and the panel is a couple of hundred pixels tall, so building a div per
 * line was twenty thousand nodes to show eight of them: 170ms of layout every
 * time the panel opened, on the main thread, immediately after every generate
 * — and a listing truncated at twenty thousand lines because that was as many
 * as it could afford. Drawing the window instead costs about forty nodes, and
 * the whole file is there to scroll through.
 */
export function renderGcodePanel(container, program, ctx) {
  if (!program) {
    container.replaceChildren(
      el('div', { class: 'gcode-empty' }, ['Generate toolpaths to preview G-code']),
    );
    return;
  }

  const lines = program.text.split('\n');
  const view = el('div', { class: 'gcode-lines' });
  const spacer = el('div', { class: 'gcode-scroll' });
  const window_ = el('div', { class: 'gcode-window' });
  spacer.style.height = `${lines.length * LINE_HEIGHT}px`;
  spacer.append(window_);
  view.append(spacer);

  let selected = -1;
  let drawnFrom = -1;
  let drawnTo = -1;

  const draw = (force = false) => {
    const first = Math.max(0, Math.floor(view.scrollTop / LINE_HEIGHT) - OVERSCAN);
    const visible = Math.ceil((view.clientHeight || 0) / LINE_HEIGHT) + OVERSCAN * 2;
    const last = Math.min(lines.length, first + visible);
    if (!force && first === drawnFrom && last === drawnTo) return;
    drawnFrom = first;
    drawnTo = last;
    const rows = [];
    for (let i = first; i < last; i++) {
      rows.push(el('div', {
        class: i === selected ? 'gcode-line selected' : 'gcode-line',
        'data-line': String(i),
      }, [el('span', { class: 'gc-ln' }, [String(i + 1).padStart(5)]), '  ', ...highlighted(lines[i])]));
    }
    window_.style.transform = `translateY(${first * LINE_HEIGHT}px)`;
    window_.replaceChildren(...rows);
  };

  view.addEventListener('scroll', () => draw());
  // The panel starts collapsed and is opened later, and the splitter resizes
  // it: both change how many rows fit, and neither is a scroll.
  new ResizeObserver(() => draw(true)).observe(view);

  // One listener on the list, not one closure per line — and the row carries
  // its own line number, because with only the visible rows in the DOM its
  // position among them is not its position in the program.
  view.addEventListener('click', (event) => {
    const row = event.target.closest('.gcode-line');
    if (!row || !window_.contains(row)) return;
    selected = Number(row.dataset.line);
    for (const other of window_.querySelectorAll('.gcode-line.selected')) {
      other.classList.remove('selected');
    }
    row.classList.add('selected');
    markMove(selected, program, ctx);
  });

  container.replaceChildren(gcodeBar(program, lines.length, ctx), view);
  draw(true);
}

/**
 * The header over the listing: what the program is, and a way to take it away.
 *
 * Copy is not a nicety. Half the time a program goes to the machine through a
 * text editor, a chat window or a control's own MDI paste buffer rather than as
 * a file, and selecting twenty thousand lines out of a scrolling div by hand is
 * not a way to do that. The button always copies the *whole* program, including
 * the lines the panel truncates.
 */
function gcodeBar(program, lineCount, ctx) {
  const copy = el('button', {
    class: 'gcode-copy',
    type: 'button',
    title: `Copy all ${lineCount} lines to the clipboard`,
  }, ['Copy']);

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(program.text);
      copy.textContent = 'Copied';
      copy.classList.add('done');
      ctx?.ui?.setStatus(`Copied ${lineCount} lines of G-code to the clipboard`);
    } catch (err) {
      // A clipboard write is refused without a secure context or a user gesture
      // the browser believes in. Saying so beats a button that does nothing.
      copy.textContent = 'Blocked';
      ctx?.ui?.setStatus(`The browser refused the clipboard (${err.name}) — use Export instead`, true);
    }
    setTimeout(() => {
      copy.textContent = 'Copy';
      copy.classList.remove('done');
    }, 1600);
  });

  return el('div', { class: 'gcode-bar' }, [
    el('span', { class: 'gcode-count' }, [program.imported
      // somebody's file being checked, not this project's program — said, so
      // the two cannot be mistaken for each other
      ? `${program.imported} — a file being checked, not this project · ${lineCount} lines`
      : `${lineCount} lines · ${plural(program.ops.length, 'operation')}`]),
    el('span', { class: 'spacer' }),
    copy,
  ]);
}

/** Drop a marker in the viewport at the move this G-code line came from. */
function markMove(lineIndex, program, ctx) {
  const ref = program.lineMap.get(lineIndex);
  if (!ref) return ctx.viewport.setMarker(null);

  const cl = program.ops[ref.op]?.cl;
  if (!cl) return;
  // The viewport draws one setup at a time, in that setup's frame, and a move
  // is in the frame of the setup it belongs to. A line from another setup is
  // shown on that setup's part: its operation is selected first, which turns
  // the scene round to it, and only then is the marker placed — otherwise it
  // landed at the other setup's coordinates on this one's part.
  const doc = ctx?.doc;
  if (doc && !program.imported) {
    for (const [opId, path] of doc.toolpaths) {
      if (path !== cl) continue;
      const owner = doc.findSetupOf(opId);
      if (owner && owner !== doc.activeSetup()) doc.select('op', opId);
      break;
    }
  }
  const o = ref.move * MOVE_STRIDE;
  const d = cl.moves;
  // for drill moves, mark the hole top rather than the bottom
  const z = d[o] === OP.DRILL ? d[o + 4] : d[o + 3];
  // sized by the viewport, which is the only thing that knows which camera is
  // live and how far it is zoomed in — see Viewport.setMarker
  ctx.viewport.setMarker([d[o + 1], d[o + 2], z]);
}
