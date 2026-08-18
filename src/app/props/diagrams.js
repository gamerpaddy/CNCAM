// Little drawings of what a setting means.
//
// Most of the settings in this app are distances on a picture, and the picture
// is the same one every time: a bar with a thread on it, a pocket with a
// stepover across it, a cutter coming down at an angle. The explanations were
// written as prose because prose is what a hint field holds, and several of
// them ran to four lines describing a shape — "the distance from one crest to
// the next" is a sentence about a drawing that would take a second to read as
// a drawing.
//
// So each of these returns an SVG of the thing, with the *one* dimension the
// field controls picked out in the accent colour and everything else greyed.
// Same drawing, different highlight, per field — which is what makes a group of
// settings read as one object with several handles rather than as a list.
//
// They are deliberately schematic. A thread drawn to scale at a 1.5mm pitch on
// a Ø16 bar is a straight line with a texture; what the reader needs is the
// relationship, exaggerated until it is legible.

const NS = 'http://www.w3.org/2000/svg';

function svg(width, height, children) {
  const node = document.createElementNS(NS, 'svg');
  node.setAttribute('viewBox', `0 0 ${width} ${height}`);
  node.setAttribute('width', String(width));
  node.setAttribute('height', String(height));
  node.setAttribute('class', 'field-art');
  for (const child of children) if (child) node.append(child);
  return node;
}

function elem(name, attrs, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

const line = (x1, y1, x2, y2, cls = 'art-line') =>
  elem('line', { x1, y1, x2, y2, class: cls });
const path = (d, cls = 'art-line') => elem('path', { d, class: cls });
const label = (x, y, text, cls = 'art-label') =>
  elem('text', { x, y, class: cls, 'text-anchor': 'middle' }, text);

/** A dimension: a line with ticks at both ends and a caption over it. */
function dim(x1, y1, x2, y2, text, cls = 'art-dim') {
  const group = elem('g', { class: cls });
  group.append(line(x1, y1, x2, y2, 'art-dim-line'));
  const tick = (x, y) => {
    const dx = y2 - y1;
    const dy = x1 - x2;
    const len = Math.hypot(dx, dy) || 1;
    const ux = (dx / len) * 3;
    const uy = (dy / len) * 3;
    return line(x - ux, y - uy, x + ux, y + uy, 'art-dim-line');
  };
  group.append(tick(x1, y1), tick(x2, y2));
  if (text) group.append(label((x1 + x2) / 2, (y1 + y2) / 2 - 4, text, 'art-dim-text'));
  return group;
}

/**
 * The threading drawing: a bar in section with the form on it.
 *
 * Everything a threading operation asks for is on this one picture — the pitch
 * along it, the form depth into it, the diameter it starts from, which end the
 * passes run from and how deep each of them goes. Which is the point: seven
 * fields that each read as an isolated number are one shape with seven
 * dimensions on it.
 *
 * @param highlight which dimension to pick out
 */
export function threadDiagram(highlight) {
  const W = 260;
  const H = 118;
  const axis = 96;             // the centreline
  const crest = 42;            // the major diameter, as a screen y
  const root = 62;             // the minor diameter
  const pitch = 34;            // one pitch, in screen x
  const left = 46;
  const teeth = 4;

  const on = (key) => (highlight === key ? ' art-on' : '');

  // the bar: full diameter before the thread, threaded section, then a shoulder
  const bar = path(
    `M 14 ${crest} L ${left} ${crest} L ${left + teeth * pitch} ${crest} `
    + `L ${W - 14} ${crest} L ${W - 14} ${axis} L 14 ${axis} Z`,
    'art-solid',
  );

  // the thread form, drawn as a run of Vs along the crest line
  let d = `M ${left} ${crest}`;
  for (let i = 0; i < teeth; i++) {
    const x = left + i * pitch;
    d += ` L ${x + pitch * 0.25} ${root} L ${x + pitch * 0.75} ${crest}`;
    d += ` L ${x + pitch} ${crest}`;
  }
  const form = path(d, `art-form${on('threadDepth')}`);

  const children = [
    bar,
    form,
    line(10, axis, W - 10, axis, 'art-axis'),
    label(W / 2, H - 4, 'centreline', 'art-note'),
  ];

  // pitch: crest to crest
  children.push(dim(left + pitch * 0.25, root + 12, left + pitch * 1.25, root + 12,
    'pitch', `art-dim${on('threadPitch')}`));

  // form depth: crest down to root
  children.push(dim(left + pitch * 2.25, crest, left + pitch * 2.25, root,
    'depth', `art-dim${on('threadDepth')}`));

  // the diameter the thread is cut on
  children.push(dim(W - 26, crest, W - 26, axis, '⌀/2',
    `art-dim${on('threadStartRadius') || on('threadFace')}`));

  // which way the passes run
  const arrowY = 26;
  children.push(path(
    `M ${left + teeth * pitch + 10} ${arrowY} L ${left - 4} ${arrowY} `
    + `M ${left + 2} ${arrowY - 4} L ${left - 4} ${arrowY} L ${left + 2} ${arrowY + 4}`,
    `art-arrow${on('threadHand')}`,
  ));
  children.push(label(left + teeth * pitch * 0.55, arrowY - 6,
    'right hand: toward the chuck', 'art-note'));

  // the infeed schedule, as tick marks stacking toward the root
  if (highlight === 'threadPasses' || highlight === 'threadFirstDepth'
    || highlight === 'threadDegression' || highlight === 'threadSpringPasses') {
    const x = left + pitch * 3.25;
    const n = 6;
    for (let i = 1; i <= n; i++) {
      const depth = (root - crest) * Math.sqrt(i / n);
      const first = i === 1;
      // Which tick is lit says which number the field is: the *first* bite for
      // the cap, all of them for the count and the schedule shape.
      const lit = highlight === 'threadFirstDepth' ? first : true;
      children.push(line(x - 7, crest + depth, x + 7, crest + depth,
        lit ? 'art-pass art-on' : 'art-pass'));
    }
    children.push(label(x, crest - 6, 'passes', 'art-note'));
  }

  return svg(W, H, children);
}

/** A stepover/stepdown picture, which is most of the milling settings. */
export function millDiagram(highlight) {
  const W = 260;
  const H = 110;
  const top = 26;
  const floor = 78;
  const left = 30;
  const right = W - 30;
  const on = (key) => (highlight === key ? ' art-on' : '');

  const children = [
    // the stock, with a pocket taken out of it
    path(`M 12 ${top} L ${left} ${top} L ${left} ${floor} L ${right} ${floor} `
      + `L ${right} ${top} L ${W - 12} ${top} L ${W - 12} ${H - 12} L 12 ${H - 12} Z`,
    'art-solid'),
    line(12, top, W - 12, top, 'art-axis'),
  ];

  // depth passes down the wall
  const levels = 3;
  for (let i = 1; i <= levels; i++) {
    const y = top + ((floor - top) * i) / levels;
    children.push(line(left, y, right, y, `art-pass${on('stepdown')}`));
  }
  children.push(dim(left - 12, top, left - 12, top + (floor - top) / levels,
    'stepdown', `art-dim${on('stepdown')}`));

  // stepover across the floor
  const steps = 5;
  for (let i = 1; i < steps; i++) {
    const x = left + ((right - left) * i) / steps;
    children.push(line(x, floor, x, floor - 6, `art-pass${on('stepover')}`));
  }
  children.push(dim(left, floor + 12, left + (right - left) / steps, floor + 12,
    'stepover', `art-dim${on('stepover')}`));

  // what is left standing
  if (highlight === 'stockToLeave') {
    children.push(line(right - 6, top, right - 6, floor, 'art-pass art-on'));
    children.push(label(right - 26, top - 6, 'stock to leave', 'art-note'));
  }
  return svg(W, H, children);
}

/** Clearance, the feed plane, and the two heights — the Heights tab in one go. */
export function heightsDiagram(highlight) {
  const W = 260;
  const H = 118;
  const on = (key) => (highlight === key ? ' art-on' : '');
  const clearance = 20;
  const gap = 40;
  const topZ = 52;
  const bottomZ = 88;

  return svg(W, H, [
    path(`M 40 ${topZ} L 220 ${topZ} L 220 ${H - 8} L 40 ${H - 8} Z`, 'art-solid'),
    line(20, clearance, 240, clearance, `art-plane${on('clearanceHeight')}`),
    label(130, clearance - 4, 'clearance', 'art-note'),
    line(20, gap, 240, gap, `art-plane${on('entryGap')}`),
    dim(60, gap, 60, topZ, 'gap', `art-dim${on('entryGap')}`),
    line(20, topZ, 240, topZ, `art-plane${on('topZ')}`),
    label(30, topZ - 4, 'Top Z', 'art-note'),
    line(20, bottomZ, 240, bottomZ, `art-plane${on('bottomZ')}`),
    label(30, bottomZ + 12, 'Bottom Z', 'art-note'),
    dim(200, topZ, 200, bottomZ, 'depth', `art-dim${on('bottomZ')}`),
  ]);
}

/**
 * Which drawing, if any, explains a field.
 *
 * Keyed by parameter, not by operation: the same picture serves every field on
 * it, and a field that appears on six strategies gets one explanation rather
 * than six.
 */
const ART = {
  threadPitch: threadDiagram,
  threadDepth: threadDiagram,
  threadPasses: threadDiagram,
  threadFirstDepth: threadDiagram,
  threadDegression: threadDiagram,
  threadSpringPasses: threadDiagram,
  threadStartRadius: threadDiagram,
  threadFace: threadDiagram,
  threadHand: threadDiagram,
  stepdown: millDiagram,
  stepover: millDiagram,
  stockToLeave: millDiagram,
  clearanceHeight: heightsDiagram,
  entryGap: heightsDiagram,
  topZ: heightsDiagram,
  bottomZ: heightsDiagram,
};

export function diagramFor(key) {
  const make = ART[key];
  return make ? make(key) : null;
}
