// A command: an operation that is nothing but G-code you typed.
//
// Everything else in this folder turns geometry into motion. This one has no
// geometry, no cutter and no motion — it is a block of lines dropped into the
// program at the point in the running order where you put it.
//
// Why that is worth an operation rather than a note to edit the file afterwards:
//
//   * A tool change that is not a T word. A machine with no changer, a shop
//     that swaps a whole head, a quick-change post that indexes on an M-code —
//     the "fit the next cutter" step is a fixed handful of lines, and the post
//     has no way to guess them. Told to write T4 M6 it writes T4 M6, which on
//     that machine is either an alarm or a carousel that is not there.
//   * A pause where the operator has to do something: blow the chips out,
//     measure a bore, move a clamp to the other side of a plate before the pass
//     that would have hit it.
//   * A probe cycle, a subroutine call, a macro — anything the control knows
//     about and this app does not.
//
// It sits between operations because that is when those things happen, and it
// is an operation because that is what makes it survive: it is in the tree, in
// the running order, in the file, in the project, undoable, and it moves when
// you reorder the job. A line typed into an exported .nc is none of that, and
// is gone the next time you press Export.
//
// It emits no moves at all. The simulation shows nothing, the estimate counts
// nothing, and the post writes the lines verbatim where the operation stands.
// See post/core.js, which handles the `raw` event, and post/format.js, which is
// the one place that decides how a hand-written block is written out.

import { CLBuilder } from '../cl.js';

export function generateCommand({ params = {} }) {
  const cl = new CLBuilder();
  const text = String(params.gcode ?? '').trim();
  if (!text) {
    // Said rather than silently posting nothing: an empty command is almost
    // always a box somebody meant to fill in, and an operation that produces no
    // moves and no lines is indistinguishable from one that failed.
    cl.warn('This command has no G-code in it, so it writes nothing.');
    return cl.finish();
  }
  cl.event('raw', { text });
  return cl.finish();
}
