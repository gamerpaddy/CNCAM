// The app's icons: one line-drawing style, drawn here, as inline SVG.
//
// The toolbar used to be words and whatever the font made of ⚙, ▾ and ⤢ — three
// glyphs from three different fonts at three different weights, and a "|◀" that
// wrapped onto two lines the moment its button was a pixel too narrow. These are
// all on one 24-unit grid, stroked in the text colour, so an icon is the colour
// and the size of the label beside it and changes with it on hover.

const SVG = 'http://www.w3.org/2000/svg';

/** The drawings, as the markup inside a 24×24 viewBox. */
const PATHS = {
  cube: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  cutter: '<path d="M9 3h6v5H9z"/><path d="M9.5 8h5v8.5L12 21l-2.5-4.5z"/><path d="m9.5 11 5-2M9.5 14.5l5-2"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  code: '<path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/><path d="m13.5 5-3 14"/>',
  machine: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/>'
    + '<path d="M12 2.5V5M12 19v2.5M21.5 12H19M5 12H2.5M18.7 5.3 17 7M7 17l-1.7 1.7M18.7 18.7 17 17M7 7 5.3 5.3"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4"/><path d="M12 17.2v.1"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  save: '<path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M8 4v5h7V4"/><path d="M8 20v-6h8v6"/>',
  folder: '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  layers: '<path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 12.5a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9L18 7"/><path d="M9 7V4.5h6V7"/>',
  bolt: '<path d="M13 3 5.5 13H11l-1 8 7.5-10H12z"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  pause: '<rect x="6.5" y="5.5" width="3.5" height="13" rx="1" fill="currentColor"/>'
    + '<rect x="14" y="5.5" width="3.5" height="13" rx="1" fill="currentColor"/>',
  'step-back': '<path d="M6.5 5.5v13"/><path d="M18 6v12l-8.5-6z" fill="currentColor"/>',
  'step-forward': '<path d="M17.5 5.5v13"/><path d="M6 6v12l8.5-6z" fill="currentColor"/>',
  'skip-back': '<path d="M5 5.5v13"/><path d="M12.5 6v12L6.5 12z" fill="currentColor"/><path d="M19.5 6v12l-6-6z" fill="currentColor"/>',
  'skip-forward': '<path d="M19 5.5v13"/><path d="M11.5 6v12l6-6z" fill="currentColor"/><path d="M4.5 6v12l6-6z" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  fit: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
  paths: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h7.5a3 3 0 0 0 0-6h-7a3 3 0 0 1 0-6H16"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};

/**
 * One icon, sized in pixels, drawn in the colour of the text around it.
 * Decorative: the button it sits in carries the name, so it is hidden from
 * assistive technology rather than read out as "image".
 */
export function icon(name, size = 16) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = PATHS[name] ?? '';
  return svg;
}

/** The names there are drawings for — for a test that no button asks for a blank. */
export const ICON_NAMES = Object.keys(PATHS);
