// Post registry. buildGcode() is the one entry point the app uses.

import { buildProgram } from './core.js';
import { linuxcnc } from './linuxcnc.js';
import { grbl } from './grbl.js';
import { lathe } from './lathe.js';

export const POSTS = { linuxcnc, grbl, lathe };

/**
 * The posts that make sense for a machine.
 *
 * A lathe post is not a flavour of the milling post — it writes diameters on a
 * different pair of axes for a program made of different operations. Offering
 * it beside GRBL in one list invited the obvious mistake, which was to pick it
 * for a milling job and get a file with no Y axis in it.
 */
export function postsFor(machine) {
  return Object.entries(POSTS)
    .filter(([, dialect]) => (dialect.lathe === true) === (machine === 'turn'))
    .map(([id]) => id);
}

/** The post to fall back to when the machine changes under the current one. */
export function defaultPostFor(machine) {
  return postsFor(machine)[0];
}

/**
 * @param postId key in POSTS
 * @param ops array of { name, cl } in machining order
 * @returns { text, lineMap } — lineMap: G-code line index -> { op, move }
 */
export function buildGcode(postId, ops, options = {}) {
  const dialect = POSTS[postId];
  if (!dialect) throw new Error(`unknown post: ${postId}`);
  return buildProgram(dialect, ops, options);
}

/**
 * The line map, packed for the trip between threads: which operation and which
 * move each line of the file came from, as two typed arrays rather than a Map
 * of thirty thousand small objects. -1 is a line no move wrote.
 */
export function packLineMap(lineMap) {
  let lines = 0;
  for (const line of lineMap.keys()) if (line + 1 > lines) lines = line + 1;
  const op = new Int32Array(lines).fill(-1);
  const move = new Int32Array(lines);
  for (const [line, ref] of lineMap) {
    op[line] = ref.op;
    move[line] = ref.move;
  }
  return { op, move };
}

/** The packed map, read the way the Map it came from was: `get(line)`. */
export class PackedLineMap {
  constructor({ op, move }) {
    this.op = op;
    this.move = move;
    let size = 0;
    for (let i = 0; i < op.length; i++) if (op[i] >= 0) size++;
    this.size = size;
  }

  get(line) {
    const op = this.op[line];
    return op >= 0 ? { op, move: this.move[line] } : undefined;
  }

  has(line) { return this.op[line] >= 0; }

  * entries() {
    for (let i = 0; i < this.op.length; i++) {
      if (this.op[i] >= 0) yield [i, { op: this.op[i], move: this.move[i] }];
    }
  }

  [Symbol.iterator]() { return this.entries(); }
}
