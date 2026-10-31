// The window's look, applied from the preferences.
//
// A colour scheme is a block of CSS variables in styles.css selected by
// `data-theme` on the root element; the accent and the viewport backdrop are
// computed here because each is one colour from which several are derived
// (hover, the soft wash behind a selection, the focus ring). Nothing in this
// file draws anything — it only sets variables — so a scheme cannot be applied
// halfway: the next paint has all of it.

import { getSetting } from './settings.js';

/** The accent, as the one colour the rest are derived from. */
const ACCENTS = {
  steel: '#4a81bb',
  teal: '#3a9a96',
  green: '#4f9a62',
  amber: '#c08a2e',
  violet: '#8a6fc4',
  rose: '#c4607f',
};

/** Backdrop presets: top, middle, bottom of the vertical wash. */
const BACKDROPS = {
  gradient: ['#2a2c30', '#1c1d20', '#141517'],
  flat: ['#1e1f22', '#1e1f22', '#1e1f22'],
  black: ['#000000', '#000000', '#000000'],
  blueprint: ['#2c5a8f', '#1f4673', '#173558'],
  paper: ['#f4f5f7', '#e6e8ec', '#d6d9df'],
};

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

function parse(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb) {
  return `#${rgb.map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}

/** Move a colour toward white (amount > 0) or black (amount < 0). */
function shade(rgb, amount) {
  const target = amount > 0 ? 255 : 0;
  const t = Math.abs(amount);
  return rgb.map((v) => v + (target - v) * t);
}

const rgba = (rgb, a) => `rgba(${rgb.map(clamp).join(', ')}, ${a})`;
const luma = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

/** The accent's variables: text on a dark panel is lighter than the accent, on a light one darker. */
export function accentVariables(hex, light) {
  const base = parse(hex);
  return {
    '--accent': hex,
    '--accent-hover': toHex(shade(base, light ? -0.12 : 0.12)),
    '--accent-text': toHex(shade(base, light ? -0.3 : 0.38)),
    '--accent-soft': rgba(base, light ? 0.12 : 0.14),
    '--accent-mid': rgba(base, light ? 0.22 : 0.26),
    '--ring': `0 0 0 2px ${rgba(base, 0.55)}`,
  };
}

/** The three stops of the viewport's backdrop for a preset name or a custom colour. */
export function backdropStops(name, custom) {
  if (name === 'custom') {
    const base = parse(custom);
    return [toHex(shade(base, 0.12)), custom, toHex(shade(base, -0.28))];
  }
  return BACKDROPS[name] ?? BACKDROPS.gradient;
}

/**
 * Write the appearance preferences onto the document.
 *
 * Idempotent and cheap, so it is simply called with whatever changed — or with
 * nothing, at boot.
 */
export function applyAppearance(root = document.documentElement) {
  const theme = getSetting('uiTheme');
  root.dataset.theme = theme;
  const light = theme === 'light';

  // the high-contrast scheme brings its own accent: yellow on black is the point
  const accent = theme === 'contrast' ? '#ffd23f' : (ACCENTS[getSetting('uiAccent')] ?? ACCENTS.steel);
  for (const [name, value] of Object.entries(accentVariables(accent, light))) {
    root.style.setProperty(name, value);
  }

  root.style.setProperty('--ui-zoom', String((Number(getSetting('uiScale')) || 100) / 100));

  const stops = backdropStops(getSetting('viewBackground'), getSetting('viewBackgroundColor'));
  ['top', 'mid', 'bottom'].forEach((name, i) => root.style.setProperty(`--viewport-${name}`, stops[i]));
  // The floating tiles over the viewport (view buttons, labels) read against
  // the backdrop and not against the panels, so a light backdrop gets light
  // tiles whatever the scheme.
  root.dataset.backdrop = luma(parse(stops[1])) > 150 ? 'light' : 'dark';
}
