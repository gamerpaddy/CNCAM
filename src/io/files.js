// File open/save. Uses the File System Access API where available (Chrome/Edge),
// falls back to <input type=file> / download-blob elsewhere.

const hasFS = 'showOpenFilePicker' in window;

/** Open one file, returns { name, buffer } or null if cancelled. */
export async function openFile(accept) {
  if (hasFS) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: accept.description, accept: accept.mime }],
      });
      const file = await handle.getFile();
      return { name: file.name, buffer: await file.arrayBuffer(), handle };
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept.extensions.join(',');
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      resolve({ name: file.name, buffer: await file.arrayBuffer(), handle: null });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Save text/blob to disk. Returns a handle when possible (for re-save). */
export async function saveFile(suggestedName, content, accept) {
  const blob = content instanceof Blob ? content : new Blob([content]);
  if (hasFS) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: accept.description, accept: accept.mime }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return handle;
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
  return null;
}

/**
 * Write several files at once, into a folder the user picks.
 *
 * One save dialog per file is not a feature, it is a punishment: a program with
 * a dozen operations is a dozen modal pickers to click through, and getting one
 * of them wrong means starting again. Where the browser can ask for a directory
 * it asks once and writes all of them into it.
 *
 * The fallback is the download path, which cannot ask anything — the files land
 * wherever downloads land. That is worse but it is not a dead end, and a browser
 * without the directory picker has no better answer to offer.
 *
 * @param files [{ name, content }]
 * @returns { written, folder } — folder is null on the download path
 */
export async function saveFiles(files) {
  if (files.length === 0) return { written: 0, folder: null };
  if ('showDirectoryPicker' in window) {
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (err) {
      if (err.name === 'AbortError') return { written: 0, folder: null };
      throw err;
    }
    for (const { name, content } of files) {
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(content instanceof Blob ? content : new Blob([content]));
      await writable.close();
    }
    return { written: files.length, folder: dir.name };
  }
  for (const { name, content } of files) {
    const url = URL.createObjectURL(
      content instanceof Blob ? content : new Blob([content]));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
  return { written: files.length, folder: null };
}

/**
 * A filename that survives being written to a real filesystem.
 *
 * Operation names are free text and routinely contain slashes ("rough 1/2
 * depth") and colons — both of which are path syntax, not characters. Without
 * this, "Face ⌀12" writes fine and "rough 1/2" silently creates a folder or
 * throws, depending on the platform.
 */
export function safeFileName(name, fallback = 'operation') {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return cleaned || fallback;
}

export const ACCEPT = {
  // One "Open Model" that takes both, because from the user's side they are
  // the same intention — get the shape into the app. A DXF is not a solid and
  // becomes a drawing rather than a model; see actions/files.js.
  model: {
    description: 'Models and drawings',
    extensions: ['.stl', '.obj', '.step', '.stp', '.iges', '.igs', '.dxf'],
    mime: {
      'application/octet-stream': ['.stl', '.obj', '.step', '.stp', '.iges', '.igs'],
      'image/vnd.dxf': ['.dxf'],
    },
  },
  project: {
    description: 'CNCAM project',
    extensions: ['.cncam'],
    mime: { 'application/json': ['.cncam'] },
  },
  toolLibrary: {
    description: 'CNCAM tool library',
    extensions: ['.json'],
    mime: { 'application/json': ['.json'] },
  },
  gcode: {
    description: 'G-code',
    extensions: ['.nc', '.gcode', '.tap'],
    mime: { 'text/plain': ['.nc', '.gcode', '.tap'] },
  },
};
