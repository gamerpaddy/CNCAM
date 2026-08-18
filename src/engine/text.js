// Wording for the messages the app writes about its own work.
//
// "4 hole(s)" is what a count gets written as when nobody wants to write the
// branch, and it was everywhere. It reads badly in the notes list, and in the
// posted file it is wrong: a G-code comment cannot carry brackets inside
// brackets, so `LineWriter.comment` strips them — and "1 hole(s)" reaches the
// operator as **"1 holes at ⌀8.00"**. The count is right there in the string.
// This is the branch.

/**
 * `n` and its noun, agreeing.
 *
 * @param one the noun phrase for a single one — "hole", "roughing pass"
 * @param many its plural, where adding an s does not make it
 */
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The same, for a noun whose plural is -es: pass → passes. */
export function pluralEs(n, one) {
  return plural(n, one, `${one}es`);
}

/**
 * The verb that agrees with `n` — `verb(1, 'is', 'are')` is "is".
 *
 * The other half of the same problem: `plural` fixed the noun and left the
 * sentence around it, so the notes read "1 bore go deeper than the cutter's
 * flute" and "all 1 matching hole are under a clamp". A count of one is the
 * commonest count there is on a part.
 */
export function verb(n, one, many) {
  return n === 1 ? one : many;
}

/**
 * "the only bore" / "all 4 bores" — a count that stands for every one of them.
 *
 * `all ${plural(n, 'bore')}` is the natural way to write it and comes out as
 * "all 1 bore", which is why this exists rather than a bare template.
 */
export function allOf(n, one, many = `${one}s`) {
  return n === 1 ? `the only ${one}` : `all ${n} ${many}`;
}
