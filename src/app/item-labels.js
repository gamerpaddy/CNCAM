// What each kind of thing in the job is called when it is taken away.
//
// The same deletion was spelled four ways: the tree's menu said "Remove tool",
// the button under the properties said "Delete Tool", the status line after
// either said "Deleted tool", and a chuck on a lathe was offered as "Delete
// clamp" in both places. One table now, read by the menu, the button and the
// status line, so the thing you clicked and the thing you are told happened are
// the same words.

const NOUNS = {
  model: 'model',
  drawing: 'drawing',
  tool: 'tool',
  setup: 'setup',
  op: 'operation',
};

// A fixture is named for what it is: a vice jaw, a toe clamp or a chuck. They
// are one kind in the document and three different things on the table.
const FIXTURE_NOUNS = { box: 'jaw', cylinder: 'clamp', chuck: 'chuck' };

// Models, drawings and tools exist apart from the program — a file you
// imported, a cutter in the rack — and are only being taken out of this job;
// setups, operations and clamps *are* the job, and go.
const REMOVED = new Set(['model', 'drawing', 'tool']);

/** The noun for one item: 'operation', 'tool', 'chuck'… */
export function nounFor(kind, item = null) {
  if (kind === 'fixture') return FIXTURE_NOUNS[item?.kind] ?? 'clamp';
  return NOUNS[kind] ?? 'item';
}

/**
 * How taking this item away is worded.
 *
 * @returns { label: 'Remove tool', done: 'Removed' }
 */
export function removalOf(kind, item = null) {
  const remove = REMOVED.has(kind);
  return {
    label: `${remove ? 'Remove' : 'Delete'} ${nounFor(kind, item)}`,
    done: remove ? 'Removed' : 'Deleted',
  };
}
