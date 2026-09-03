// A photograph of the actual cutter, in place of the drawing.
//
// The generated silhouette answers "what shape is this and what will it leave
// behind", which is the right question in a catalogue of shapes. It cannot
// answer the question you have in front of the machine: *which of these three*
// is it. Two 6mm 3-flute end mills from different makers are one drawing and
// two very different tools — one is worn, one has a coating, one is the
// expensive one you keep for the finish pass — and the only thing that tells
// them apart is what they look like.
//
// So a tool may carry a picture, taken with the webcam over the bench or
// dropped in from a file, and everywhere the app draws a cutter it shows that
// instead. No picture means the drawing, which is what every tool has today and
// what every preset keeps.
//
// The picture is stored on the tool record as a data URL, which means it
// travels everywhere the tool already travels: into the catalogue in this
// browser, into an exported .json library, and into the .cncam project. That is
// only affordable because of `normalisePhoto` below — a phone camera frame is
// three megabytes and a tool thumbnail needs about twenty kilobytes, and
// storing the former would blow the catalogue out of localStorage on the fourth
// tool.

/** The longest edge a stored photo is allowed, in pixels. */
const MAX_EDGE = 384;
/** JPEG quality. Above ~0.85 the file doubles and nothing looks different. */
const QUALITY = 0.82;

/**
 * A file, blob or webcam frame reduced to something worth storing.
 *
 * Downscaled to fit MAX_EDGE, re-encoded as JPEG, and centre-cropped to a
 * square — every place the app shows a tool picture is a box of a fixed shape,
 * and a photo that has to be letterboxed into it wastes most of the room it is
 * given. Cropping here rather than in CSS means the stored bytes are the pixels
 * that get shown.
 *
 * @param source a File, Blob, or anything createImageBitmap takes
 * @returns a data: URL
 */
export async function normalisePhoto(source) {
  const bitmap = await createImageBitmap(source);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const out = Math.min(MAX_EDGE, side);
    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
      0, 0, out, out,
    );
    return canvas.toDataURL('image/jpeg', QUALITY);
  } finally {
    bitmap.close?.();
  }
}

/** Whether a value is a picture this app stored, rather than something else. */
export function isPhoto(image) {
  return typeof image === 'string' && image.startsWith('data:image/');
}

/**
 * The photo as an element, sized like the drawing it replaces.
 *
 * Same signature as `toolIcon`'s box so the two are interchangeable at every
 * call site — which is the whole reason a photo needs no special handling in
 * the picker, the tree, the properties panel or the wizard.
 */
export function photoElement(image, { width, height, className = 'tool-icon' } = {}) {
  const img = document.createElement('img');
  img.src = image;
  img.className = `${className} tool-photo`;
  img.width = width;
  img.height = height;
  img.alt = '';
  img.decoding = 'async';
  return img;
}

/**
 * Read whatever a drop or a file input produced, if it is an image.
 *
 * A drag from a photo app carries several types at once — a file, a URL, some
 * HTML — and the file is the only one that can be read without asking the
 * network for something. So the file is taken and everything else is declined
 * out loud, rather than silently doing nothing.
 *
 * @returns a data URL, or null with the reason in `onError`
 */
export async function photoFromTransfer(dataTransfer, { onError } = {}) {
  const item = [...(dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (!item) {
    onError?.(dataTransfer?.files?.length
      ? 'That file is not an image'
      : 'Drop an image file — a picture dragged from a web page is a link, not a file');
    return null;
  }
  try {
    return await normalisePhoto(item);
  } catch (err) {
    onError?.(`Could not read that image: ${err.message}`);
    return null;
  }
}

/** Ask for one image file from disk. */
export async function pickPhotoFile({ onError } = {}) {
  const file = await new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => resolve(input.files[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
  if (!file) return null;
  try {
    return await normalisePhoto(file);
  } catch (err) {
    onError?.(`Could not read that image: ${err.message}`);
    return null;
  }
}

/**
 * The webcam, as a small modal that returns one frame.
 *
 * Deliberately a live preview with one button rather than a silent grab: a
 * cutter has to be held up to the lens and squared on, and a photo taken
 * blind is a photo of the ceiling. The stream is stopped on every exit path —
 * a camera light left on after the dialog closed is the kind of thing that
 * makes people distrust an app permanently.
 *
 * @returns a data URL, or null if cancelled or unavailable
 */
export async function capturePhoto({ onError } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    onError?.('This browser will not give a page the camera (needs https or localhost)');
    return null;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
      audio: false,
    });
  } catch (err) {
    onError?.(err.name === 'NotAllowedError'
      ? 'The camera was refused — allow it for this site, or use a file instead'
      : `No camera available: ${err.message}`);
    return null;
  }

  const video = document.createElement('video');
  video.className = 'cam-view';
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;

  const dialog = document.createElement('dialog');
  dialog.className = 'lib-dialog cam-dialog';

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
      resolve(value);
      dialog.close();
    };

    const shoot = button('Take the photo', 'primary', async () => {
      // Straight off the live element: whatever is on screen is what is stored,
      // which is the only version of this that is not surprising.
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      canvas.getContext('2d').drawImage(video, 0, 0);
      try {
        finish(await normalisePhoto(canvas));
      } catch (err) {
        onError?.(`Could not take the photo: ${err.message}`);
        finish(null);
      }
    });

    dialog.append(
      heading('Photograph the cutter'),
      video,
      note('Hold it against something plain and fill the frame — the picture is '
        + 'cropped square and stored at 384px, so detail past that is thrown away.'),
      row(button('Cancel', '', () => finish(null)), spacer(), shoot),
    );
    dialog.addEventListener('close', () => { finish(null); dialog.remove(); });
    document.body.append(dialog);
    dialog.showModal();
  });
}

// Small DOM helpers, local so this module can be used from anywhere without
// dragging the layout module in behind it.

function heading(text) {
  const h = document.createElement('h2');
  h.textContent = text;
  return h;
}

function note(text) {
  const p = document.createElement('div');
  p.className = 'prop-note';
  p.textContent = text;
  return p;
}

function row(...children) {
  const div = document.createElement('div');
  div.className = 'lib-actions';
  div.append(...children);
  return div;
}

function spacer() {
  const s = document.createElement('span');
  s.className = 'spacer';
  return s;
}

function button(text, className, onclick) {
  const b = document.createElement('button');
  b.textContent = text;
  if (className) b.className = className;
  b.addEventListener('click', onclick);
  return b;
}
