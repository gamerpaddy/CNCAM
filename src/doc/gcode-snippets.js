// Saved blocks of G-code, kept in this browser rather than in a project.
//
// The blocks a shop uses are the shop's, not the job's. "Stop and let me change
// the head", "blow the chips out", "open the guard", "run the probe macro" —
// each is a handful of lines that never change, and each one is retyped from
// memory every time a project needs it. Retyped from memory is the problem:
// these are lines that go straight to the control unchecked, and the one time
// the M-code is wrong is the time it is wrong at the machine.
//
// So they are saved globally, by design. A preset that lived in the project
// would be gone the moment you started the next one, which is exactly when you
// want it — and the whole point of a preset is that it survives the job it was
// first typed for.
//
// A preset is either for one machine or for all of them. Both are real: a hard
// stop for a tool change is the same three lines everywhere, and the M-code
// that opens the guard on the router means something else on the mill. So the
// list you see is "mine, plus everybody's", and a preset saved against a
// machine never appears on a different one — which is the only way this can be
// safe, since the failure mode is a line that does nothing on one control and
// something unwanted on another.

const KEY = 'cncam.gcodeSnippets';

/**
 * Everything saved, newest first.
 * @returns [{ id, name, gcode, machineId, machineName, at }]
 */
export function loadSnippets() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!Array.isArray(parsed?.snippets)) return [];
    return parsed.snippets.filter((s) => s && typeof s.gcode === 'string');
  } catch {
    return [];                          // private mode, or something else wrote it
  }
}

/**
 * The ones offered on a machine: those saved for every machine, and those saved
 * for this one. Never another machine's, whatever it is called.
 */
export function snippetsFor(machine) {
  const id = machine?.id ?? null;
  return loadSnippets().filter((s) => !s.machineId || s.machineId === id);
}

function write(snippets) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: 1, snippets }));
    return true;
  } catch {
    return false;                       // storage full or unavailable
  }
}

/**
 * Save a block under a name, replacing any of the same name with the same
 * scope. Same name, different scope, is two presets — "tool change" for all
 * machines and "tool change" for the router are a general rule and the
 * exception to it, and losing one to the other would be silent.
 *
 * @param machine the machine to tie it to, or null for every machine
 * @returns the saved preset, or null when storage would not take it
 */
export function saveSnippet(name, gcode, machine = null) {
  const clean = String(name ?? '').trim();
  if (!clean) return null;
  const machineId = machine?.id ?? null;
  const snippet = {
    id: `snip_${Date.now().toString(36)}`,
    name: clean,
    gcode: String(gcode ?? ''),
    machineId,
    // Kept so a preset can say which machine it belongs to after that machine
    // has been renamed, deleted, or is in a project that never had it. The id
    // is the authority on *whether* it applies; this is only ever a label.
    machineName: machine?.name ?? '',
    at: Date.now(),
  };
  const rest = loadSnippets().filter(
    (s) => !(s.name === clean && (s.machineId ?? null) === machineId));
  return write([snippet, ...rest]) ? snippet : null;
}

export function deleteSnippet(id) {
  return write(loadSnippets().filter((s) => s.id !== id));
}
