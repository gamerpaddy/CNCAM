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
