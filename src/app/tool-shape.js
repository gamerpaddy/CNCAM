// Drawing a cutter, so you can see which one it is.
//
// A tool library that reads "6mm bull r1" asks you to hold a shape in your head
// and match it against a name. Every machinist already recognises these
// silhouettes on sight — a ball nose, a chamfer, a drill point — and a picture
// says the one thing the name does not: what the bottom of the cutter will
// leave behind in the part.
//
// Everything here is drawn from `engine/tool-geometry.js`, which is also what
// the 3D cutter is revolved from and what the reach check evaluates. There used
// to be a second, hand-written path builder in this file, and it disagreed: it
// drew the flutes at a fixed stubby length and then put the cone's shoulder at
// its true height, so a 3.175mm 30° V bit — whose cone is 5.9mm tall — came out
// as a self-crossing bowtie of triangles pointing the wrong way. A shape
// described twice is a shape described wrongly.
//
// Three things make a cutter look like metal rather than like a grey box:
// a gradient across the diameter, because a cylinder has a lit side and a dark
// side; flutes on the cutting section, because that is the difference between a
// tool and a rod; and the shank above it, because a cutter without one looks
// like it was cut off.

import {
  toolSections, toolLength, toolMaxRadius, fluteLengthOf, cuttingPoints, tipAngleOf,
  cuttingRadiusOf,
} from '../engine/tool-geometry.js';
import {
  isLatheTool, latheToolOutline, latheToolBounds, insertIcOf, INSERT_SHAPES,
  effectiveLead, cornerAngleOf, insertEngagement, recommendedDepthOfCut,
} from '../engine/insert.js';
import { isPhoto, photoElement } from './tool-photo.js';

const NS = 'http://www.w3.org/2000/svg';

// How every drawing here is painted: 'shaded', 'flat' or 'outline'. Held in the
// module and pushed in by applySettings (main.js) rather than read from the
// preferences here — this file is drawn from node by the tests, and the
// preferences pull in the viewport.
let previewStyle = 'shaded';
let calloutsOn = true;
export function setToolDrawing({ style, callouts }) {
  previewStyle = ['shaded', 'flat', 'outline'].includes(style) ? style : 'shaded';
  calloutsOn = callouts !== false;
}
/** Whether the large previews carry dimension lines (the toolCallouts preference). */
export function toolCalloutsEnabled() { return calloutsOn; }

let uid = 0;

/**
 * Colour by material, not by family.
 *
 * These were a hue per family — a cyan ball nose, a green bull nose, a pink
 * chamfer mill, a violet face mill — so the list scanned by colour. It also
 * read like a box of crayons, on the one panel whose drawings are supposed to
 * be the real thing: a family is told apart by the shape of its end, which is
 * what these drawings exist to show, and the shape does not need help from a
 * colour to do it. What a cutter is made of is the difference a machinist sees
 * on the bench: ground carbide, HSS and cobalt drills and taps with their
 * warmer grey, and the dark coated grey of an insert. Bright enough to read
 * against the dark panel; not so different that the list becomes a legend.
 */
const CARBIDE = '#bcc4cd';
const HSS = '#c7c0b1';
const INSERT = '#a3abb5';
export const TYPE_COLORS = {
  flat: CARBIDE,
  ball: CARBIDE,
  bull: CARBIDE,
  chamfer: CARBIDE,
  face: '#b3bbc4',
  threadmill: CARBIDE,
  drill: HSS,
  spot: HSS,
  tap: HSS,
  turning: INSERT,
  boring: INSERT,
  parting: INSERT,
  threading: INSERT,
};

/**
 * What a cutter is made of, as a colour and a name.
 *
 * 'auto' is the family's usual grind (TYPE_COLORS above) and is what every tool
 * made before this field existed reads as, so nothing changes colour until
 * somebody says what theirs is. The others are the finishes a machinist can see
 * on the bench: bare carbide and HSS, the violet-grey of TiAlN, the near-black
 * of DLC and the pale shimmer of a diamond coating. It is a label — it moves no
 * path, which is why it is left out of the operation fingerprint.
 */
export const COATINGS = {
  auto: { label: 'Standard', color: null, note: 'The usual grind for this kind of tool' },
  hss: { label: 'HSS', color: '#c7c0b1', note: 'High-speed steel: drills, taps, budget end mills' },
  carbide: { label: 'Carbide', color: '#bcc4cd', note: 'Uncoated solid carbide' },
  tialn: { label: 'TiAlN', color: '#9a7fa8', note: 'Violet-grey coating for steel and hot cuts' },
  dlc: { label: 'DLC', color: '#6b7380', note: 'Diamond-like carbon, near black: aluminium, plastics' },
  diamond: { label: 'Diamond', color: '#c4e8ee', note: 'Diamond coated: graphite, composites' },
};
const LEGEND_ORDER = ['hss', 'carbide', 'tialn', 'dlc', 'diamond'];

/** The coating key a tool answers to — unknown strings read as 'auto'. */
export function coatingOf(tool) {
  return COATINGS[tool?.coating] ? tool.coating : 'auto';
}

/** The body colour of a tool: its coating if it names one, else its family's. */
export function toolColor(tool) {
  return COATINGS[coatingOf(tool)].color ?? TYPE_COLORS[tool?.type] ?? TYPE_COLORS.flat;
}

/**
 * The key to the colours: a swatch and a name per finish, the tool's own lit.
 * Built from the table above, so the legend cannot list a finish the drawing
 * does not know how to paint.
 */
export function coatingLegend(tool = null) {
  const active = tool ? coatingOf(tool) : null;
  const box = document.createElement('div');
  box.className = 'coating-legend';
  for (const key of LEGEND_ORDER) {
    const item = document.createElement('span');
    item.className = `coating-legend-item${key === active ? ' active' : ''}`;
    item.title = COATINGS[key].note;
    const chip = document.createElement('i');
    chip.style.background = COATINGS[key].color;
    item.append(chip, COATINGS[key].label);
    box.append(item);
  }
  return box;
}

const SHANK_COLOR = '#7f8691';
const HOLDER_COLOR = '#4c525c';

/**
 * The cutting end as an SVG path, in tool coordinates: X across the diameter
 * with 0 on the axis, Y *down* from the tip.
 *
 * Kept as a named export because it is the shape the tests check and the one
 * thing about a cutter that a single `d` attribute can honestly express.
 */
export function toolProfilePath(tool) {
  return mirroredPath(cuttingPoints(tool));
}

/**
 * As much of the tool as is worth drawing in an icon.
 *
 * Not the whole thing: a 45mm drill drawn to scale beside its own 5mm width is
 * a hairline, and what identifies a cutter is the shape of its *end*. So the
 * length is capped at a few diameters — enough that a cone, a ball or a corner
 * radius reads at full size, plus a stub of shank so the tool does not look
 * snapped off. The cap is never allowed to cut into the shaped end itself,
 * which is what a 30° V bit needs: its cone is nearly two diameters tall.
 */
function drawableSections(tool, budget) {
  const sections = toolSections(tool);
  const points = sections[0].points;
  const fluteTop = points[points.length - 1][1];
  const diameter = Math.max(0.1, 2 * Math.max(...points.map(([r]) => r)));
  // where the shaped end stops and the plain cylinder begins
  const shapedTop = points.length > 1 ? points[points.length - 2][1] : 0;

  // The whole budget is spent, however long the tool really is — a quarter of
  // it on shank, the rest on flutes. Fixing the drawn length as a multiple of
  // the diameter instead made *every* cutter the same shape, which quietly
  // cancelled the size band above: a Ø3 and a Ø40 came out the same width in
  // pixels because both were drawn exactly two diameters long.
  const stub = Math.min(diameter * 0.55, budget * 0.25);
  // Never cut into the shaped end. A 30° V bit's cone is nearly two diameters
  // tall, and a cone with its point missing is not a picture of a V bit — so if
  // it does not fit, the drawing gets longer and the tool gets thinner.
  const floor = Math.max(shapedTop * 1.05, diameter * 0.35);
  const fluteDrawn = Math.min(fluteTop, Math.max(floor, budget - stub));
  const limit = fluteDrawn + stub;

  const out = [{ kind: 'cutting', points: clipToHeight(points, fluteDrawn) }];
  // A stub of shank at the shank's own diameter, drawn from where the flutes
  // were cut off. Built rather than clipped out of the real one: the real shank
  // starts at the *top* of the full-length flutes, which is above everything an
  // icon draws, so clipping it produced nothing at all.
  const shankR = sections[1]?.points[1]?.[0] ?? diameter / 2;
  if (stub > 1e-6) {
    out.push({ kind: 'shank', points: [[shankR, fluteDrawn], [shankR, limit]] });
  }
  return { sections: out, fluteTop: fluteDrawn, drawnTop: limit };
}

/** A right-half profile cut off at `maxZ`, keeping the silhouette closed. */
function clipToHeight(points, maxZ) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const [r, z] = points[i];
    if (z <= maxZ) { out.push([r, z]); continue; }
    const prev = points[i - 1];
    if (prev && prev[1] < maxZ) {
      const f = (maxZ - prev[1]) / (z - prev[1]);
      out.push([prev[0] + (r - prev[0]) * f, maxZ]);
    }
    break;
  }
  return out;
}

/**
 * An <svg> of the cutter, scaled to fit a box of `width` × `height` px.
 *
 * `scaleTo` fixes the millimetres-per-pixel across a whole list, so tools drawn
 * side by side are comparable. Left null, each tool fills its own box, which is
 * what you want for a single large preview.
 *
 * `orientation: 'horizontal'` lays the tool down with its tip to the left,
 * which is what fits a list row: a row is wide and short, and a cutter stood on
 * end in one is a sliver.
 */
export function toolIcon(tool, {
  width = 34, height = 40, scaleTo = null, color = null, orientation = 'vertical',
} = {}) {
  // A tool that has been photographed shows its photograph. The icon is the
  // "which one is this" drawing — in the picker, the tree, the operation panel
  // — and a picture of the actual cutter answers that better than any
  // silhouette can. The *assembly* below is not overridden: that one is about
  // stickout and reach, which no photo measures. See app/tool-photo.js.
  if (isPhoto(tool?.image)) {
    return photoElement(tool.image, {
      width, height, className: `tool-icon tool-icon-${orientation}`,
    });
  }
  // A lathe tool is a shape in a plane, not a silhouette to revolve. Sending it
  // through the code below produced a grey cone for every insert in the drawer:
  // a CNMG, a WNMG and a parting blade came out identical, and the insert shape
  // — which is the first thing written on the box and the first thing a
  // machinist reads — appeared nowhere in the app at all.
  if (isLatheTool(tool?.type)) {
    return latheIcon(tool, { width, height, scaleTo, color, orientation });
  }
  const horizontal = orientation === 'horizontal';
  // how many diameters long the box is, which is what the drawing should be
  const aspect = horizontal ? width / height : height / width;
  const diameter = Math.max(0.1, tool?.diameter ?? 6);

  // A shared scale keeps a Ø3 next to a Ø12 honest, but a Ø3 drawn true to a
  // Ø40 scale is a few pixels wide and invisible — and an icon you cannot see
  // is not a picture of anything. So relative size is compressed into a band:
  // the biggest cutter fills its box, the smallest still fills most of it, and
  // everything between reads in the right order.
  const MIN_FILL = 0.55;
  const relative = scaleTo ? (diameter / scaleTo) ** 0.45 : 1;
  const fill = MIN_FILL + (1 - MIN_FILL) * Math.min(1, Math.max(0, relative));

  // The box comes first and the drawing is fitted into it: the short dimension
  // is the diameter at whatever size the band above earned it, and the long one
  // follows from the element's own shape. The shank is drawn out to fill it.
  const across = (diameter / fill) * 1.12;
  const { sections, fluteTop, drawnTop } = drawableSections(tool, across * aspect * 0.94);
  const maxR = Math.max(0.05, sectionsMaxRadius(sections));

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('class', `tool-icon tool-icon-${orientation}`);
  svg.setAttribute('aria-hidden', 'true');

  // A tool too long for its box — a steep V bit, whose cone alone is two
  // diameters — pushes the box out and is drawn thinner. That is what it is.
  const along = drawnTop * 1.06;
  const acrossFinal = Math.max(across, (maxR * 2) * 1.12, along / aspect);
  const vbWFinal = horizontal ? Math.max(along, acrossFinal * aspect) : acrossFinal;
  const vbHFinal = horizontal ? acrossFinal : Math.max(along, acrossFinal * aspect);

  if (horizontal) {
    // tip at the left edge, axis through the middle
    svg.setAttribute('viewBox', `0 ${-vbHFinal / 2} ${vbWFinal} ${vbHFinal}`);
    svg.setAttribute('preserveAspectRatio', 'xMinYMid meet');
  } else {
    svg.setAttribute('viewBox', `${-vbWFinal / 2} ${-vbHFinal} ${vbWFinal} ${vbHFinal}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMax meet');
  }

  const cutting = color ?? toolColor(tool);
  const scale = Math.max(vbWFinal, vbHFinal);
  drawSections(svg, sections, {
    cutting, horizontal, stroke: scale * 0.012, fluteTop, tool,
  });
  return svg;
}

/**
 * A lathe tool, drawn in the plane it works in.
 *
 * The frame is the machine's ZX plane exactly as it is always drawn: Z to the
 * right, radius up, and the cutting point at the origin. So the tip is at the
 * left of a wide row, the shank runs back to the right, and the insert is a
 * real polygon of the right shape and the right nose radius — which is the one
 * thing that tells a T from a W from a C at a glance.
 *
 * Drawn from `engine/insert.js`, which is also what the simulation extrudes, so
 * the icon in the list and the tool cutting the bar cannot disagree.
 */
function latheIcon(tool, {
  width, height, scaleTo, color, orientation, full = false,
  showEngagement = false, engageDepth = null,
}) {
  const horizontal = orientation === 'horizontal';
  const ic = insertIcOf(tool);
  // one scale across a list, banded the same way the milling icons are: a small
  // boring bar next to a big rougher should read smaller without vanishing
  const MIN_FILL = 0.6;
  const relative = scaleTo ? (ic / Math.max(1, scaleTo)) ** 0.45 : 1;
  const fill = MIN_FILL + (1 - MIN_FILL) * Math.min(1, Math.max(0, relative));

  // Enough holder to say which way the tool faces, and enough of it that the
  // drawing is about as wide as the row it goes in.
  //
  // An insert on a stub of shank is roughly square, and `meet` in a box three
  // times wider than it is tall then draws it at a third of the width it was
  // given — the tool came out as a 25px smudge in a 68px row. A couple of
  // inserts' worth of shank makes the drawing the shape of its box, so it fills
  // it. A parting blade is capped the other way for the same reason: a 3mm
  // blade reaching 25mm is a hairline unless the drawing stops at the tip.
  const sections = full
    ? latheToolOutline(tool)
    : latheToolOutline(tool, {
      holderLength: Math.max(ic * 2.2, 10),
      bladeDepth: Math.max(ic, (tool?.bladeWidth || tool?.diameter || 3) * 2.5),
    });
  // Where the insert meets the work, at the deepest cut it should take. Drawn so
  // the panel answers the two questions a machinist asks of a lathe tool — which
  // edge cuts, and how deep before it breaks — rather than leaving both to be
  // read off the numbers. Only turning and boring inserts cut on a nose like
  // this; a blade goes straight in and has no such geometry.
  const engaging = showEngagement && (tool?.type === 'turning' || tool?.type === 'boring');
  const engagement = engaging
    ? insertEngagement(tool, engageDepth != null ? engageDepth : recommendedDepthOfCut(tool))
    : null;

  const b = latheToolBounds(sections);
  if (engagement) {
    // the removed band can stand outside the insert; keep it in frame
    for (const [z, x] of engagement.band) {
      if (z < b.minZ) b.minZ = z;
      if (z > b.maxZ) b.maxZ = z;
      if (x < b.minX) b.minX = x;
      if (x > b.maxX) b.maxX = x;
    }
  }
  const spanZ = Math.max(0.001, b.maxZ - b.minZ);
  const spanX = Math.max(0.001, b.maxX - b.minX);
  const pad = Math.max(spanZ, spanX) * 0.08;

  // The element is only as wide as the drawing needs.
  //
  // A lathe tool is roughly square — an insert with a shank running away from
  // it at 45° grows in both directions at once — and a list row is twice as
  // wide as it is tall. Stretching the viewBox to the row's shape spends the
  // difference on empty margin either side, so the *box* is narrowed to the
  // drawing instead and the tool gets the full height of the row.
  const drawnWidth = Math.min(width, Math.max(28,
    Math.round(height * ((spanZ + pad * 2) / (spanX + pad * 2)))));

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(drawnWidth));
  svg.setAttribute('height', String(height));
  svg.setAttribute('class', `tool-icon tool-icon-lathe tool-icon-${orientation}`);
  svg.setAttribute('aria-hidden', 'true');

  // the drawing is in (Z, radius); SVG's Y grows downward, so radius is negated
  //
  // The viewBox is then stretched to the *box's* proportions rather than the
  // drawing's. Left at the drawing's own, `meet` letterboxes it — a tool that is
  // as tall as it is wide, in a row three times wider than it is tall, was drawn
  // at a third of the width it had been given and the insert came out eight
  // pixels across. Padding the short axis instead spends the whole box.
  let vbW = (spanZ + pad * 2) / fill;
  let vbH = (spanX + pad * 2) / fill;
  const boxAspect = Math.max(0.05, drawnWidth / Math.max(1, height));
  if (vbW / vbH > boxAspect) vbH = vbW / boxAspect; else vbW = vbH * boxAspect;
  const cz = (b.minZ + b.maxZ) / 2;
  const cx = (b.minX + b.maxX) / 2;
  svg.setAttribute('viewBox',
    `${cz - vbW / 2} ${-cx - vbH / 2} ${vbW} ${vbH}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const id = `lt${++uid}`;
  const defs = document.createElementNS(NS, 'defs');
  const group = document.createElementNS(NS, 'g');
  const insertColor = color ?? toolColor(tool);
  const stroke = Math.max(vbW, vbH) * 0.012;

  // The bite goes on *under* the tool, so the insert paints over it and the
  // engaged edge (drawn last) sits on top of the insert's own edge.
  if (engagement) group.append(engagementBite(engagement, stroke, 'under'));

  sections.forEach((section, i) => {
    const base = section.kind === 'insert' ? insertColor : HOLDER_COLOR;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', closedPath(section.points));
    paintPart(path, defs, `${id}-${i}`, base, stroke);
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('class', `tool-part tool-part-${section.kind}`);
    group.append(path);
  });

  if (engagement) group.append(engagementBite(engagement, stroke, 'over'));

  svg.append(defs, group);
  return svg;
}

/**
 * The engagement overlay: the band of stock the cut removes, and the length of
 * cutting edge in the metal.
 *
 * Two passes over the same geometry so the layering reads right — the `under`
 * pass is the translucent bite the insert then paints over, the `over` pass is
 * the bright engaged edge and the uncut surface line, on top of everything. The
 * edge turns red when the depth is past what the insert should take, which is
 * the "and may break it" the drawing exists to show.
 */
function engagementBite(engagement, stroke, layer) {
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'tool-engagement');
  const [nose, end] = engagement.edge;
  const hot = engagement.overloaded ? '#d9605a' : '#6fbf88';

  if (layer === 'under') {
    // the removed material, as the wedge between the finished surface and the
    // uncut one — a translucent chip so the insert reads through it
    const band = document.createElementNS(NS, 'path');
    band.setAttribute('d', `${closedPath(engagement.band)}`);
    band.setAttribute('fill', engagement.overloaded ? 'rgba(255,90,82,0.22)' : 'rgba(57,217,138,0.2)');
    band.setAttribute('stroke', 'none');
    g.append(band);
    return g;
  }

  // the uncut stock surface, a dashed line the cut is working down from
  const surface = document.createElementNS(NS, 'path');
  surface.setAttribute('d', `M ${round(end[0])} ${round(-end[1])} L ${round(end[0] - (end[0] - nose[0]) - stroke * 60)} ${round(-end[1])}`);
  surface.setAttribute('stroke', 'rgba(255,255,255,0.35)');
  surface.setAttribute('stroke-width', String(stroke * 1.1));
  surface.setAttribute('stroke-dasharray', `${stroke * 4} ${stroke * 3}`);
  surface.setAttribute('fill', 'none');
  g.append(surface);

  // the engaged cutting edge itself
  const edge = document.createElementNS(NS, 'path');
  edge.setAttribute('d', `M ${round(nose[0])} ${round(-nose[1])} L ${round(end[0])} ${round(-end[1])}`);
  edge.setAttribute('stroke', hot);
  edge.setAttribute('stroke-width', String(stroke * 3.2));
  edge.setAttribute('stroke-linecap', 'round');
  edge.setAttribute('fill', 'none');
  g.append(edge);

  // a dot at the nose contact point, where the cut actually starts
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('cx', String(round(nose[0])));
  dot.setAttribute('cy', String(round(-nose[1])));
  dot.setAttribute('r', String(stroke * 2.4));
  dot.setAttribute('fill', hot);
  g.append(dot);
  return g;
}

/** A closed SVG path from [z, radius] points, with radius drawn upward. */
function closedPath(points) {
  return `M ${points.map(([z, x]) => `${round(z)} ${round(-x)}`).join(' L ')} Z`;
}

/**
 * The whole tool, to scale: flutes, shank and holder.
 *
 * The icon above is the business end, which is what identifies a cutter in a
 * list. This is the other question — how far it sticks out, how much of that is
 * cutting edge, and how close the holder is to the work — and it cannot be
 * answered by a drawing that stops at the top of the flutes. Drawn to one
 * scale, because the whole point is the proportion between the three.
 */
export function toolAssembly(tool, { width = 150, height = 190, callouts = false } = {}) {
  // For a lathe tool the "whole assembly" question is how far the bar sticks
  // out and which way the insert faces, and both are already the drawing above
  // — just with the real shank length rather than a stub of it.
  if (isLatheTool(tool?.type)) {
    const svg = latheIcon(tool, {
      width, height, scaleTo: null, color: null, orientation: 'horizontal', full: true,
      showEngagement: true,
    });
    svg.setAttribute('class', 'tool-assembly tool-assembly-lathe');
    return svg;
  }
  const sections = toolSections(tool);
  const length = toolLength(tool);
  const maxR = toolMaxRadius(tool);

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('class', 'tool-assembly');
  svg.setAttribute('aria-hidden', 'true');
  // a margin in tool units, so the outline is never clipped by its own stroke
  const pad = Math.max(length, maxR * 2) * 0.06;
  // Room for the dimension lines, in units of the text they carry: one for the
  // overall length on the left, two columns on the right, and the diameter
  // under the tip. Sized from the tool so the lettering is the same fraction of
  // the drawing whether the cutter is a 3mm ball or a 100mm face mill.
  const fs = callouts ? Math.max(length, maxR * 2.4) * 0.05 : 0;
  const room = callouts
    ? { left: fs * 3.4, right: fs * 6.2, bottom: fs * 4.6 }
    : { left: 0, right: 0, bottom: 0 };
  const contentW = maxR * 2 + pad * 2 + room.left + room.right;
  const contentH = length + pad * 2 + room.bottom;
  const vbW = Math.max(contentW, contentH * (width / height));
  const vbH = Math.max(contentH, vbW * (height / width));
  const x0 = -(maxR + pad + room.left) - (vbW - contentW) / 2;
  svg.setAttribute('viewBox', `${x0} ${-vbH + pad + room.bottom} ${vbW} ${vbH}`);
  svg.setAttribute('preserveAspectRatio', callouts ? 'xMidYMid meet' : 'xMidYMax meet');

  drawSections(svg, sections, {
    cutting: toolColor(tool),
    horizontal: false,
    stroke: vbW * 0.006,
    fluteTop: fluteLengthOf(tool),
    tool,
  });
  if (callouts) svg.append(dimensionLayer(tool, fs, vbW * 0.004));
  return svg;
}

/**
 * The numbers a machinist reads off a cutter, as measured from its geometry.
 *
 * Every figure comes from `engine/tool-geometry.js` — the same sections the 3D
 * cutter is revolved from and the reach check evaluates — so the callouts on
 * the drawing cannot disagree with the tool that cuts. `stickout` is tip to
 * the face of the holder, which is the number that decides how deep a pocket
 * can go before the holder meets the wall.
 */
export function toolDimensions(tool) {
  const sections = toolSections(tool);
  const shank = sections.find((sec) => sec.kind === 'shank');
  const holder = sections.find((sec) => sec.kind === 'holder');
  const topOf = (sec) => sec.points[sec.points.length - 1][1];
  const shankR = shank ? Math.max(...shank.points.map(([r]) => r)) : null;
  return {
    diameter: 2 * cuttingRadiusOf(tool),
    flute: fluteLengthOf(tool),
    shankDiameter: shankR ? 2 * shankR : null,
    // the holder starts where the shank ends; no holder means the shank is all there is
    stickout: holder ? topOf(shank ?? sections[0]) : null,
    overall: toolLength(tool),
    cornerRadius: tool?.type === 'bull' && tool.cornerRadius > 0 ? tool.cornerRadius : null,
    tipAngle: ['drill', 'chamfer', 'spot'].includes(tool?.type) ? tipAngleOf(tool) : null,
    holderDiameter: holder ? 2 * Math.max(...holder.points.map(([r]) => r)) : null,
  };
}

/** Trim a millimetre figure to what is worth reading: 6, 6.35, 12.7. */
function mm(v) { return String(Math.round(v * 100) / 100); }

/**
 * Dimension lines over the assembly drawing: diameter under the tip, flute and
 * stickout on the right, overall length on the left, with the corner radius and
 * point angle in the line under the diameter. Drawn in the drawing's own
 * coordinates (X across, Y down from the tip), so they sit exactly where the
 * metal ends.
 */
function dimensionLayer(tool, fs, stroke) {
  const d = toolDimensions(tool);
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'tool-callouts');
  g.setAttribute('fill', 'none');
  g.setAttribute('stroke', 'currentColor');
  g.setAttribute('stroke-width', String(stroke));
  g.setAttribute('font-size', String(fs));

  const line = (x1, y1, x2, y2, dashed = false) => {
    const el = document.createElementNS(NS, 'path');
    el.setAttribute('d', `M ${round(x1)} ${round(y1)} L ${round(x2)} ${round(y2)}`);
    if (dashed) el.setAttribute('stroke-dasharray', `${fs * 0.3} ${fs * 0.3}`);
    g.append(el);
  };
  // a dimension line with a tick at each end — ticks, not arrows, so a short
  // dimension on a small cutter does not vanish under its own arrowheads
  const dim = (x1, y1, x2, y2) => {
    line(x1, y1, x2, y2);
    const horizontal = y1 === y2;
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      if (horizontal) line(x, y - fs * 0.35, x, y + fs * 0.35);
      else line(x - fs * 0.35, y, x + fs * 0.35, y);
    }
  };
  const text = (label, x, y, { rotate = false } = {}) => {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', String(round(x)));
    t.setAttribute('y', String(round(y)));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('fill', 'currentColor');
    t.setAttribute('stroke', 'none');
    if (rotate) t.setAttribute('transform', `rotate(-90 ${round(x)} ${round(y)})`);
    t.textContent = label;
    g.append(t);
  };

  const cutR = d.diameter / 2;
  const holderR = (d.holderDiameter ?? d.diameter) / 2;
  const widest = Math.max(holderR, d.shankDiameter ? d.shankDiameter / 2 : 0, cutR);

  // diameter, under the tip
  const yDia = fs * 1.5;
  line(-cutR, 0, -cutR, yDia + fs * 0.4, true);
  line(cutR, 0, cutR, yDia + fs * 0.4, true);
  dim(-cutR, yDia, cutR, yDia);
  text(`⌀${mm(d.diameter)}`, 0, yDia + fs * 1.3);
  const extra = [];
  if (d.cornerRadius) extra.push(`R${mm(d.cornerRadius)}`);
  if (d.tipAngle) extra.push(`${mm(d.tipAngle)}°`);
  if (extra.length) text(extra.join('  '), 0, yDia + fs * 2.5);

  // flute length, just off the flutes on the right
  const xFlute = cutR + fs * 1.6;
  line(cutR, -d.flute, xFlute + fs * 0.4, -d.flute, true);
  dim(xFlute, 0, xFlute, -d.flute);
  text(`${mm(d.flute)}`, xFlute + fs * 1.1, -d.flute / 2, { rotate: true });

  // stickout, clear of the holder
  if (d.stickout) {
    const xStick = widest + fs * 1.8;
    line(d.shankDiameter ? d.shankDiameter / 2 : cutR, -d.stickout, xStick + fs * 0.4, -d.stickout, true);
    dim(xStick, 0, xStick, -d.stickout);
    text(`stickout ${mm(d.stickout)}`, xStick + fs * 1.1, -d.stickout / 2, { rotate: true });
  }

  // overall length, on the far side
  const xAll = -(widest + fs * 1.8);
  line(-holderR, -d.overall, xAll - fs * 0.4, -d.overall, true);
  line(-cutR, 0, xAll - fs * 0.4, 0, true);
  dim(xAll, 0, xAll, -d.overall);
  text(`overall ${mm(d.overall)}`, xAll - fs * 0.5, -d.overall / 2, { rotate: true });

  return g;
}

/** Paint a silhouette: one shaded body per section, then the flutes on top. */
function drawSections(svg, sections, { cutting, horizontal, stroke, fluteTop, tool }) {
  const id = `tg${++uid}`;
  const defs = document.createElementNS(NS, 'defs');
  const group = document.createElementNS(NS, 'g');
  // Lying down, tip to the left. The silhouette is drawn at (r, −z), so the
  // cutter runs *up* the page from the origin; the rotation that lays it to the
  // right is +90° (x' = −y), and −90° put the whole drawing at negative x —
  // outside a viewBox that starts at 0. That is the reported "tools are just
  // thin lines in the sidebar": every horizontal icon in the app was a one-pixel
  // sliver of the tip at the left edge, while the vertical previews in the
  // properties panel, which are not rotated at all, were correct.
  if (horizontal) group.setAttribute('transform', 'rotate(90)');

  const FILLS = { cutting, shank: SHANK_COLOR, holder: HOLDER_COLOR };
  sections.forEach((section, i) => {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', mirroredPath(section.points));
    paintPart(path, defs, `${id}-${i}`, FILLS[section.kind] ?? cutting, stroke);
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('class', `tool-part tool-part-${section.kind}`);
    group.append(path);
  });

  const flutes = fluteMarks(sections[0], fluteTop, tool, stroke);
  if (flutes) group.append(flutes);

  svg.append(defs, group);
}

/**
 * Paint one part of a drawing in the style the person chose.
 *
 * One place, because every drawing — milling, lathe, icon, assembly — has to
 * agree on what "shaded", "flat" and "outline" mean. A light edge in the first
 * two, not a dark one: these sit on a dark panel, where a black outline merges
 * into the background and eats the shape. Outline drops the fill to a wash of
 * the body colour and draws the edge in it, which is how a drawing looks on a
 * setup sheet.
 */
function paintPart(path, defs, id, base, stroke) {
  const style = previewStyle;
  if (style === 'outline') {
    path.setAttribute('fill', base);
    path.setAttribute('fill-opacity', '0.1');
    path.setAttribute('stroke', base);
    path.setAttribute('stroke-width', String(stroke * 1.5));
    return;
  }
  if (style === 'flat') {
    path.setAttribute('fill', base);
    path.setAttribute('stroke', 'rgba(255,255,255,0.35)');
  } else {
    defs.append(cylinderGradient(id, base));
    path.setAttribute('fill', `url(#${id})`);
    path.setAttribute('stroke', 'rgba(255,255,255,0.5)');
  }
  path.setAttribute('stroke-width', String(stroke));
}

/**
 * A cylinder is lit on one side and dark on the other, and a rectangle filled
 * with one flat colour is the reason every end mill in the list looked like the
 * same grey box. Three stops: shadow at the far edge, a highlight just off
 * centre, and a softer shadow at the near edge.
 */
function cylinderGradient(id, base) {
  const gradient = document.createElementNS(NS, 'linearGradient');
  gradient.setAttribute('id', id);
  gradient.setAttribute('x1', '0');
  gradient.setAttribute('y1', '0');
  gradient.setAttribute('x2', '1');
  gradient.setAttribute('y2', '0');
  const stops = [
    [0, shade(base, -0.42)],
    [0.32, shade(base, 0.22)],
    [0.55, base],
    [1, shade(base, -0.3)],
  ];
  for (const [offset, color] of stops) {
    const stop = document.createElementNS(NS, 'stop');
    stop.setAttribute('offset', String(offset));
    stop.setAttribute('stop-color', color);
    gradient.append(stop);
  }
  return gradient;
}

/**
 * The flutes, as the helix edges you actually see side on.
 *
 * Without them a flat end mill is a rectangle and a drill is a rectangle with a
 * point, which is the complaint. The count comes from the tool, so a 2-flute
 * and a 4-flute look different; inserted cutters and lathe tools get none,
 * because they have none.
 */
function fluteMarks(cuttingSection, fluteTop, tool, stroke) {
  const type = tool?.type ?? 'flat';
  if (isLatheTool(type) || type === 'face') return null;
  const count = Math.max(0, Math.min(6, Math.round(tool?.flutes ?? 2)));
  if (count === 0 || !(fluteTop > 0)) return null;

  const radius = Math.max(...cuttingSection.points.map(([r]) => r));
  if (!(radius > 0)) return null;
  // start above the shaped end so the marks never cross the point or the ball
  const shaped = cuttingSection.points.reduce(
    (top, [, z], i, all) => (i < all.length - 1 ? Math.max(top, z) : top), 0);
  const from = shaped + radius * 0.25;
  if (!(fluteTop > from + radius * 0.2)) return null;

  const group = document.createElementNS(NS, 'g');
  group.setAttribute('class', 'tool-flutes');
  group.setAttribute('stroke', 'rgba(0,0,0,0.34)');
  group.setAttribute('stroke-width', String(stroke * 1.6));
  group.setAttribute('stroke-linecap', 'round');
  group.setAttribute('fill', 'none');

  // one lap of the helix per this much length, which is what a 30° helix does
  const lead = Math.max(radius * 2.6, (fluteTop - from) / 2.2);
  const marks = Math.max(2, Math.ceil((fluteTop - from) / (lead / count)));
  for (let i = 0; i < marks; i++) {
    const z0 = from + ((fluteTop - from) * i) / marks;
    const z1 = Math.min(fluteTop, z0 + lead * 0.5);
    const line = document.createElementNS(NS, 'path');
    // drawn across the visible face only, so it reads as wrapping round the back
    line.setAttribute('d', `M ${-radius * 0.72} ${-z0} L ${radius * 0.72} ${-z1}`);
    group.append(line);
  }
  return group;
}

/**
 * A closed silhouette from a right-half profile: up one side, down the other.
 * `-y` is up, matching the icon's coordinates and the viewBox above.
 */
function mirroredPath(points) {
  const right = points.map(([r, z]) => `${round(r)} ${round(-z)}`);
  const left = [...points].reverse().map(([r, z]) => `${round(-r)} ${round(-z)}`);
  return `M ${right.join(' L ')} L ${left.join(' L ')} Z`;
}

function sectionsMaxRadius(sections) {
  let max = 0;
  for (const { points } of sections) for (const [r] of points) if (r > max) max = r;
  return max;
}

/** Lighten (positive) or darken (negative) a #rrggbb by a fraction. */
function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (channel) => {
    const v = amount >= 0 ? channel + (255 - channel) * amount : channel * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function round(v) { return Math.round(v * 1000) / 1000; }

/**
 * One line of what a tool is, for a tooltip or a caption.
 *
 * A lathe tool and a milling cutter are described by different facts, so they
 * get different lines. "⌀9.525mm · 1FL · 19mm flute" is three true statements
 * about a CNMG insert and not one useful one.
 */
export function describeTool(tool) {
  if (isLatheTool(tool?.type)) return describeLatheTool(tool);
  const bits = [`⌀${tool.diameter}mm`];
  if (tool.type === 'bull' && tool.cornerRadius > 0) bits.push(`r${tool.cornerRadius}`);
  // tipAngleOf rather than the field: a drill with the angle left blank is a
  // 118° one everywhere else in the app, and the line describing it said
  // nothing at all
  if (tool.type === 'drill' || tool.type === 'chamfer' || tool.type === 'spot') {
    const point = tipAngleOf(tool);
    if (point > 0) bits.push(`${point}° point`);
  }
  // The pitch is not a detail of a tap or a thread mill, it is which tool it
  // is: an M6×1 and an M6×0.75 are two taps for two different holes, and the
  // line describing them read the same. It is also the feed, on a tap.
  if (tool.type === 'tap' || tool.type === 'threadmill') {
    bits.push(tool.pitch > 0 ? `${tool.pitch}mm pitch` : 'no pitch set');
  }
  if (tool.type === 'tap' && tool.leadThreads > 0) {
    bits.push(`${tool.leadThreads}-thread lead`);
  }
  if (tool.flutes) bits.push(`${tool.flutes}FL`);
  if (tool.fluteLength) bits.push(`${tool.fluteLength}mm flute`);
  return bits.join(' · ');
}

function describeLatheTool(tool) {
  const bits = [];
  if (tool.type === 'parting') {
    bits.push(`${tool.bladeWidth || tool.diameter}mm blade`);
    if (tool.maxDepth > 0) bits.push(`${tool.maxDepth}mm deep`);
  } else if (tool.type === 'threading') {
    bits.push(`${tool.tipAngle > 0 ? tool.tipAngle : 60}° form`);
    if (tool.bladeWidth > 0) bits.push(`${tool.bladeWidth}mm wide`);
  } else {
    const shape = tool.insert === 'X'
      ? `${round(cornerAngleOf(tool))}° custom`
      : INSERT_SHAPES[tool.insert]?.label ?? 'insert';
    bits.push(tool.insertCode ? String(tool.insertCode).toUpperCase() : shape);
    bits.push(`IC ${round(insertIcOf(tool))}`);
    if (tool.noseRadius > 0) bits.push(`r${tool.noseRadius} nose`);
    // The lead the tool actually cuts at, and the ground lead when a mount has
    // moved it — the one number the mount angle exists to change.
    const eff = round(effectiveLead(tool));
    const mount = round(tool.mountAngle ?? 0);
    bits.push(mount ? `${eff}° lead (${round(tool.leadAngle ?? 95)}° ground, ${mount > 0 ? '+' : ''}${mount}° mount)`
      : `${eff}° lead`);
    // The deepest cut the insert should take in one pass — the number the
    // engagement drawing above is showing, in words.
    bits.push(`max cut ~${(Math.round(recommendedDepthOfCut(tool) * 10) / 10).toFixed(1)}mm ap`);
  }
  if (tool.type === 'boring') {
    bits.push(`⌀${tool.diameter} bar`);
    if (tool.minBore > 0) bits.push(`min bore ⌀${tool.minBore}`);
    if (tool.maxDepth > 0) bits.push(`reaches ${tool.maxDepth}mm`);
  }
  if (tool.hand && tool.hand !== 'R' && tool.type !== 'parting') {
    bits.push(tool.hand === 'L' ? 'left hand' : 'neutral');
  }
  return bits.join(' · ');
}
