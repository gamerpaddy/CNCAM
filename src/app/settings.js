// Preferences: the choices that belong to the person rather than to the job.
//
// The distinction matters and it is why these do not live in the project. How
// finely the simulation is gridded, whether rapids are drawn, whether the grid
// is on — none of that changes the part, travels with the file, or belongs in
// anybody's undo stack. It is how *you* like to look at a job, so it is kept in
// this browser and applied to whatever is open.
//
// The counter-example is in the project on purpose: the machine's rapid rate is
// a fact about the machine, so it lives on the machine record (doc/machines.js)
// and travels with the file.
//
// Every setting here has to *do* something. A preferences dialog full of
// switches that are read once at boot and never again is a dialog that lies, so
// each one names the thing it changes and `applySettings` in main.js is the one
// place that pushes them into the viewport.

const KEY = 'cncam.settings';

/**
 * @typedef {{ key, label, type, group, hint, options?, labels?, min?, max?, step? }} Setting
 */
export const SETTING_GROUPS = ['Viewport', 'Simulation', 'Editing'];

export const SETTINGS = [
  // --- viewport ---
  {
    key: 'projection',
    label: 'Projection',
    group: 'Viewport',
    type: 'select',
    options: ['auto', 'perspective', 'orthographic'],
    labels: {
      auto: 'Automatic — square-on views are orthographic',
      perspective: 'Perspective',
      orthographic: 'Orthographic',
    },
    default: 'auto',
    hint: 'Orthographic keeps parallel edges parallel, so two diameters at '
      + 'opposite ends of a bar are the same size on screen and can be compared. '
      + 'It is the projection to check a profile in. Automatic switches to it '
      + 'for Front, Top and the other square-on views and back on the first '
      + 'orbit — and says which one you are in, rather than switching the camera '
      + 'behind the setting.',
  },
  {
    key: 'showGrid',
    label: 'Table grid',
    group: 'Viewport',
    type: 'checkbox',
    default: true,
    hint: 'Squares in round millimetres, so counting three of them to judge a '
      + 'clearance means something. A lathe never shows one — there is no table.',
  },
  {
    key: 'showAxes',
    label: 'Axis arrows at zero',
    group: 'Viewport',
    type: 'checkbox',
    default: true,
  },
  {
    key: 'showTriad',
    label: 'Orientation triad in the corner',
    group: 'Viewport',
    type: 'checkbox',
    default: true,
    hint: 'The world axes sit at the machine origin, which is usually under the '
      + 'part and often off screen. This one always is not.',
  },
  {
    key: 'showRapids',
    label: 'Draw rapid moves',
    group: 'Viewport',
    type: 'checkbox',
    default: true,
    hint: 'The orange lines. Turning them off leaves only metal being cut, '
      + 'which is what you want when checking a path and not its linking.',
  },
  {
    key: 'pathBrightness',
    label: 'Toolpath brightness',
    group: 'Viewport',
    type: 'select',
    options: ['dim', 'normal', 'bright'],
    labels: { dim: 'Dim', normal: 'Normal', bright: 'Bright' },
    default: 'normal',
    hint: 'Eleven overlapping paths in one colour is the normal state of a '
      + 'finished job. Dim lets the part show through them.',
  },

  // --- simulation ---
  {
    key: 'simQuality',
    label: 'Milling detail',
    group: 'Simulation',
    type: 'select',
    options: ['low', 'medium', 'high', 'ultra', 'extreme'],
    labels: {
      low: 'Low — fastest',
      medium: 'Medium',
      high: 'High',
      ultra: 'Ultra — slow on long programs',
      extreme: 'Extreme — 4× Ultra, needs the memory',
    },
    default: 'high',
    hint: 'How finely the stock is gridded, and the only thing that decides how '
      + 'sharp an edge can look. The depth of every cell is worked out exactly — '
      + 'a faced floor comes out dead flat at any setting — so what more cells '
      + 'buy is *across* the part, not down it: a wall lands between two samples '
      + 'and is drawn one cell thick, and that step is what reads as roughness. '
      + 'Halving it costs four times the memory, which is why Extreme is not the '
      + 'default. Nothing here can show an undercut: a grid of heights has one '
      + 'surface per place, and that is a property of the method rather than of '
      + 'the setting.',
  },
  {
    key: 'turnSamples',
    label: 'Turning detail',
    group: 'Simulation',
    type: 'select',
    options: ['400', '800', '1600', '3200'],
    labels: {
      400: 'Low — fastest', 800: 'Medium', 1600: 'High', 3200: 'Ultra',
    },
    default: '1600',
    hint: 'Samples along the bar. A groove narrower than one sample is a groove '
      + 'the simulation cannot show you.',
  },
  {
    key: 'simRecord',
    label: 'Recording limit',
    group: 'Simulation',
    type: 'select',
    options: ['1', '2', '4', '8'],
    labels: {
      1: 'Standard', 2: 'Large — 2×', 4: 'Very large — 4×', 8: 'Huge — 8×',
    },
    default: '1',
    hint: 'How much of the program the simulation can remember. Every surface '
      + 'change is written down so the timeline can scrub backwards, and a long '
      + 'program runs out — which is what "the program outran the record" '
      + 'means. Each step doubles the memory the run may use; raise it rather '
      + 'than coarsening the detail, which changes the picture instead.',
  },
  {
    key: 'simSmooth',
    label: 'Smooth the cut surface',
    group: 'Simulation',
    type: 'checkbox',
    default: true,
    hint: 'Shades the stock from averaged normals rather than facet normals. '
      + 'Machined faces read as faces instead of as a field of triangles; the '
      + 'step between two passes is still there, because it is real.',
  },
  {
    key: 'simSurfaceStyle',
    label: 'Surface style',
    group: 'Simulation',
    type: 'select',
    options: ['solid', 'splat', 'smooth'],
    labels: {
      solid: 'Solid — the triangle mesh',
      splat: 'Splat — soft round points',
      smooth: 'Smooth — merged splats',
    },
    default: 'solid',
    hint: 'How the cut stock is drawn, which is a different question from how '
      + 'finely it is gridded. A height grid terraces a dome and staircases a '
      + 'slope one cell at a time, and raising the detail to cure that just makes '
      + 'the run slow. These draw the *same* grid with overlapping round splats '
      + 'instead of square facets: Splat reads as a point cloud and shows where '
      + 'the samples are, Smooth spreads them until they merge into a continuous '
      + 'surface. Neither changes the simulation or its speed — only the picture.',
  },
  {
    key: 'showHolder',
    label: 'Draw the shank and holder',
    group: 'Simulation',
    type: 'checkbox',
    default: true,
    hint: 'A 40mm holder coming down into a 30mm pocket is a crash. It can only '
      + 'be seen if the holder is drawn.',
  },
  {
    key: 'ghostTool',
    label: 'See through the shank and holder',
    group: 'Simulation',
    type: 'checkbox',
    default: false,
    hint: 'The holder is the part most likely to be between you and the cut. '
      + 'Off, the tool is drawn solid — which is what it is, and what makes it '
      + 'obvious when the holder is inside the work rather than in front of it.',
  },
  {
    key: 'showCutMarker',
    label: 'Mark where the metal is coming off',
    group: 'Simulation',
    type: 'checkbox',
    default: true,
    hint: 'A dot on the surface the cutter is actually removing this instant. '
      + 'The cutter is drawn from its own silhouette and the stock from the '
      + 'swept height grid, and the only way to see that those two agree is to '
      + 'mark the place they touch — if the dot is not under the corner of the '
      + 'tool, one of them is wrong.',
  },
  {
    key: 'spinWork',
    label: 'Spin the work on the lathe',
    group: 'Simulation',
    type: 'checkbox',
    default: true,
  },

  // --- editing ---
  {
    key: 'hintStyle',
    label: 'Explain each setting',
    group: 'Editing',
    type: 'select',
    options: ['bubble', 'inline', 'off'],
    labels: {
      bubble: 'On hover, in a bubble',
      inline: 'Always, under the field',
      off: 'Not at all',
    },
    default: 'bubble',
    hint: 'Most of these settings are a distance on a picture, so the bubble '
      + 'carries the picture with the dimension it controls picked out. Printed '
      + 'under every field instead, the same text is most of the height of the '
      + 'panel and pushes the fields it explains apart.',
  },
  {
    key: 'confirmDelete',
    label: 'Ask before a deletion that reaches further than one row',
    group: 'Editing',
    type: 'checkbox',
    default: true,
    hint: 'Deleting a setup takes its operations with it, and deleting a tool '
      + 'stops every operation that used it. Both are undoable either way.',
  },
  {
    key: 'autosave',
    label: 'Keep the session in this browser',
    group: 'Editing',
    type: 'checkbox',
    default: true,
    hint: 'Restores what you had open after a reload. Geometry is stored too, '
      + 'when it fits. Takes effect on the next reload.',
  },
];

const DEFAULTS = Object.fromEntries(SETTINGS.map((s) => [s.key, s.default]));

let cache = null;

function readAll() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    stored = {};   // private mode, or something else wrote to the key
  }
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

/** Every setting, defaults filled in. */
export function allSettings() {
  return { ...readAll() };
}

export function getSetting(key) {
  const value = readAll()[key];
  return value === undefined ? DEFAULTS[key] : value;
}

export function setSetting(key, value) {
  const next = { ...readAll(), [key]: value };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* private mode: the setting still applies to this session */ }
  return next;
}

export function resetSettings() {
  cache = { ...DEFAULTS };
  try { localStorage.removeItem(KEY); } catch { /* nothing to remove */ }
  return cache;
}

/** Grid cells for the milling simulation, by quality name. */
export const SIM_CELLS = {
  low: 15_000,
  medium: 40_000,
  high: 120_000,
  ultra: 400_000,
  // Cell size goes as 1/√cells, so this is Ultra's edges halved — 0.033mm on an
  // 80mm billet. The event budget scales with the grid (see eventBudget), so
  // raising this does not quietly truncate the run the way a fixed budget did.
  extreme: 1_600_000,
};
