// Projects kept in the browser's own filesystem (OPFS), with a history.
//
// localStorage was where a session used to live, and it is the wrong shelf for
// this. It holds strings, it is measured in a few megabytes across the whole
// origin, and a real STEP import is megabytes of typed array on its own — so
// autosave had a budget, silently dropped the geometry that did not fit, and a
// reload came back with the setups but not the part. The Origin Private File
// System has none of those limits: it is a real directory tree, quota is in the
// hundreds of megabytes to gigabytes, and a project is written as a file rather
// than squeezed into a key.
//
// What that buys, beyond size:
//
//   * More than one project. A shop has a drawer of jobs, not "the last thing I
//     had open", and until now the only way to keep the second one was to
//     export it to disk and remember where.
//   * A history. Every save is a new numbered version and the old ones stay, so
//     "it was right before I changed the stepover" is a click rather than a
//     regret. Nothing here overwrites anything.
//   * Download and upload. The store is in *this* browser and nowhere else —
//     clearing site data takes it with it — so every project can be written out
//     as the same .cncam file the app has always used, and read back in.
//
// The layout on disk:
//
//   projects/<id>/meta.json      what it is called, and the list of versions
//   projects/<id>/v0003.cncam    one version, the whole project with geometry
//   session/current.cncam        the autosave; not a project, just where you were
//
// meta.json is a convenience, not the authority: it is rebuilt from the files
// actually present if it is missing or unreadable, so a half-finished write can
// cost a version but never a project.

const PROJECTS_DIR = 'projects';
const SESSION_DIR = 'session';
const SESSION_FILE = 'current.cncam';
const META = 'meta.json';

/**
 * How many versions of one project are kept.
 *
 * Unbounded history sounds generous until a project with a 40MB mesh has been
 * saved two hundred times and the browser starts refusing writes for the whole
 * origin — including the autosave, which is the one thing that must never fail.
 * The oldest are dropped, and the dialog says so rather than letting a version
 * quietly go missing.
 */
export const MAX_VERSIONS = 30;

/** Whether this browser has an OPFS at all (everything else no-ops without it). */
export function storeAvailable() {
  return typeof navigator !== 'undefined'
    && typeof navigator.storage?.getDirectory === 'function';
}

async function dir(name, { create = true } = {}) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create });
}

async function projectDir(id, { create = false } = {}) {
  const projects = await dir(PROJECTS_DIR, { create });
  return projects.getDirectoryHandle(id, { create });
}

async function readText(handle, name) {
  const file = await (await handle.getFileHandle(name)).getFile();
  return file.text();
}

async function writeText(handle, name, text) {
  const file = await handle.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(text);
  } finally {
    await writable.close();
  }
}

const versionName = (v) => `v${String(v).padStart(4, '0')}.cncam`;
const versionNumber = (name) => {
  const m = /^v(\d+)\.cncam$/.exec(name);
  return m ? Number(m[1]) : null;
};

// --- reading ---------------------------------------------------------------

/**
 * Every project in the store, newest first.
 *
 * @returns [{ id, name, created, updated, versions: [{ v, at, note, bytes }] }]
 */
export async function listProjects() {
  if (!storeAvailable()) return [];
  let projects;
  try {
    projects = await dir(PROJECTS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for await (const [id, handle] of projects.entries()) {
    if (handle.kind !== 'directory') continue;
    const meta = await readMeta(handle, id);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.updated - a.updated);
}

/** One project's record, or null when the id names nothing. */
export async function projectMeta(id) {
  if (!storeAvailable()) return null;
  try {
    return await readMeta(await projectDir(id), id);
  } catch {
    return null;
  }
}

/**
 * The record for a directory, taking the files on disk as the truth.
 *
 * The version list in meta.json can only ever be a description of the files
 * beside it, and the two part company the moment a write is interrupted or a
 * quota error lands between the .cncam and the meta. So the files are listed
 * first and the meta is used to decorate them — a version present on disk but
 * missing from the meta still shows up and still opens.
 */
async function readMeta(handle, id) {
  const found = new Map();
  for await (const [name, entry] of handle.entries()) {
    const v = versionNumber(name);
    if (v == null || entry.kind !== 'file') continue;
    const file = await entry.getFile();
    found.set(v, { v, at: file.lastModified, note: '', bytes: file.size });
  }
  if (found.size === 0) return null;

  let stored = null;
  try {
    stored = JSON.parse(await readText(handle, META));
  } catch {
    stored = null;                     // never written, or written half-way
  }
  for (const entry of stored?.versions ?? []) {
    const known = found.get(entry.v);
    if (known) Object.assign(known, { note: entry.note ?? '', at: entry.at ?? known.at });
  }
  const versions = [...found.values()].sort((a, b) => b.v - a.v);
  return {
    id,
    name: typeof stored?.name === 'string' && stored.name ? stored.name : id,
    created: stored?.created ?? versions[versions.length - 1].at,
    updated: versions[0].at,
    versions,
  };
}

/** One version's JSON, as text. */
export async function readVersion(id, v) {
  const handle = await projectDir(id);
  return readText(handle, versionName(v));
}

/** The newest version's JSON, which is what "open this project" means. */
export async function readLatest(id) {
  const meta = await projectMeta(id);
  if (!meta) throw new Error('no such project in this browser');
  return readVersion(id, meta.versions[0].v);
}

// --- writing ---------------------------------------------------------------

/**
 * Save a project as a new version.
 *
 * Never an overwrite: the point of the store is that the state you had an hour
 * ago is still there. `id` null starts a new project; an id that exists adds to
 * its history.
 *
 * @returns { id, v, dropped } — dropped is how many old versions aged out
 */
export async function saveVersion({ id = null, name, json, note = '' }) {
  if (!storeAvailable()) throw new Error('this browser has no private file system');
  const projectId = id ?? newId(name);
  const handle = await projectDir(projectId, { create: true });
  const meta = await readMeta(handle, projectId);
  const v = (meta?.versions[0]?.v ?? 0) + 1;

  await writeText(handle, versionName(v), json);

  const versions = [
    { v, at: Date.now(), note, bytes: json.length },
    ...(meta?.versions ?? []),
  ];
  // Age out the oldest before the meta is written, so the meta never claims a
  // version whose file has just been removed.
  const dropped = versions.splice(MAX_VERSIONS);
  for (const old of dropped) {
    await handle.removeEntry(versionName(old.v)).catch(() => {});
  }
  await writeText(handle, META, JSON.stringify({
    id: projectId,
    name: name || meta?.name || projectId,
    created: meta?.created ?? Date.now(),
    versions: versions.map(({ v: n, at, note: text }) => ({ v: n, at, note: text })),
  }, null, 2));

  return { id: projectId, v, dropped: dropped.length };
}

/**
 * A directory name for a project.
 *
 * Derived from the project's own name so the OPFS is legible in devtools, with
 * a timestamp suffix because two jobs called "bracket" are two projects. Only
 * characters a directory entry is definitely allowed are kept.
 */
function newId(name) {
  const slug = String(name ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${slug || 'project'}-${Date.now().toString(36)}`;
}

export async function renameProject(id, name) {
  const handle = await projectDir(id);
  const meta = await readMeta(handle, id);
  if (!meta) return false;
  await writeText(handle, META, JSON.stringify({
    id, name, created: meta.created,
    versions: meta.versions.map(({ v, at, note }) => ({ v, at, note })),
  }, null, 2));
  return true;
}

export async function deleteProject(id) {
  const projects = await dir(PROJECTS_DIR);
  await projects.removeEntry(id, { recursive: true });
}

/**
 * Throw one version away.
 *
 * Refused when it is the only one left: a project with no versions is a
 * directory that lists as nothing, which is a project the user cannot see and
 * cannot delete. Deleting the project is the way to do that, and it says so.
 */
export async function deleteVersion(id, v) {
  const handle = await projectDir(id);
  const meta = await readMeta(handle, id);
  if (!meta || meta.versions.length < 2) return false;
  await handle.removeEntry(versionName(v));
  await writeText(handle, META, JSON.stringify({
    id, name: meta.name, created: meta.created,
    versions: meta.versions.filter((e) => e.v !== v)
      .map(({ v: n, at, note }) => ({ v: n, at, note })),
  }, null, 2));
  return true;
}

// --- the session autosave --------------------------------------------------
//
// Not a project and not versioned: one file holding where you were, rewritten
// as you work. It lives in the same store because it has the same problem —
// geometry is too big for anywhere else — and separately from the projects
// because a crash recovery is not a job you filed.

export async function saveSession(json) {
  await writeText(await dir(SESSION_DIR), SESSION_FILE, json);
}

export async function loadSession() {
  try {
    return await readText(await dir(SESSION_DIR, { create: false }), SESSION_FILE);
  } catch {
    return null;                        // nothing saved yet, or no store
  }
}

export async function clearSession() {
  try {
    await (await dir(SESSION_DIR, { create: false })).removeEntry(SESSION_FILE);
  } catch { /* already gone */ }
}

// --- how much room is left -------------------------------------------------

/**
 * What the store holds and what the browser will allow, in bytes.
 *
 * `estimate()` is origin-wide and approximate — browsers deliberately round it
 * — so it answers "am I anywhere near the limit", not "how big is this file".
 * The per-project sizes come from the files themselves.
 */
export async function usage() {
  const projects = await listProjects();
  const stored = projects.reduce(
    (sum, p) => sum + p.versions.reduce((s, v) => s + v.bytes, 0), 0);
  let quota = null;
  try {
    ({ quota = null } = await navigator.storage.estimate());
  } catch { /* not implemented */ }
  return { projects: projects.length, stored, quota };
}
