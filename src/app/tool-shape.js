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
} from '../engine/tool-geometry.js';
import {
  isLatheTool, latheToolOutline, latheToolBounds, insertIcOf, INSERT_SHAPES,
  effectiveLead, cornerAngleOf, insertEngagement, recommendedDepthOfCut,
} from '../engine/insert.js';
import { isPhoto, photoElement } from './tool-photo.js';

const NS = 'http://www.w3.org/2000/svg';

let uid = 0;

/**
 * Colour by family, so a list scans by shape *and* by hue. Bright enough to
 * read against the dark panel — the first pass at these was muted so as not to
 * compete with the status colours, and muted on a dark background is invisible.
 */
export const TYPE_COLORS = {
  flat: '#c3d4e4',
  turning: '#e9c46a',
  boring: '#f2b56b',
  parting: '#f4a261',
  threading: '#ef8f6b',
  ball: '#7fd4ec',
  bull: '#9fd89f',
  drill: '#e8bd76',
  spot: '#f0d08a',
  chamfer: '#e2a8d6',
  face: '#b8b3ee',
  tap: '#8fc9b3',
  threadmill: '#6fbfa0',
};

const SHANK_COLOR = '#8d949f';
const HOLDER_COLOR = '#5b6270';

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

  const cutting = color ?? TYPE_COLORS[tool.type] ?? TYPE_COLORS.flat;
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
  const insertColor = color ?? TYPE_COLORS[tool.type] ?? TYPE_COLORS.turning;
  const stroke = Math.max(vbW, vbH) * 0.012;

  // The bite goes on *under* the tool, so the insert paints over it and the
  // engaged edge (drawn last) sits on top of the insert's own edge.
  if (engagement) group.append(engagementBite(engagement, stroke, 'under'));

  sections.forEach((section, i) => {
    const base = section.kind === 'insert' ? insertColor : HOLDER_COLOR;
    const gradient = cylinderGradient(`${id}-${i}`, base);
    defs.append(gradient);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', closedPath(section.points));
    path.setAttribute('fill', `url(#${id}-${i})`);
    path.setAttribute('stroke', 'rgba(255,255,255,0.5)');
    path.setAttribute('stroke-width', String(stroke));
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
  const hot = engagement.overloaded ? '#ff5a52' : '#39d98a';

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
export function toolAssembly(tool, { width = 150, height = 190 } = {}) {
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
  const vbW = Math.max(maxR * 2 + pad * 2, (length + pad * 2) * (width / height));
  const vbH = Math.max(length + pad * 2, vbW * (height / width));
  svg.setAttribute('viewBox', `${-vbW / 2} ${-vbH + pad} ${vbW} ${vbH}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMax meet');

  drawSections(svg, sections, {
    cutting: TYPE_COLORS[tool.type] ?? TYPE_COLORS.flat,
    horizontal: false,
    stroke: vbW * 0.006,
    fluteTop: fluteLengthOf(tool),
    tool,
  });
  return svg;
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
    const gradient = cylinderGradient(`${id}-${i}`, FILLS[section.kind] ?? cutting);
    defs.append(gradient);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', mirroredPath(section.points));
    path.setAttribute('fill', `url(#${id}-${i})`);
    // a light edge, not a dark one: these sit on a dark panel, where a black
    // outline merges into the background and eats the shape
    path.setAttribute('stroke', 'rgba(255,255,255,0.5)');
    path.setAttribute('stroke-width', String(stroke));
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('class', `tool-part tool-part-${section.kind}`);
    group.append(path);
  });

  const flutes = fluteMarks(sections[0], fluteTop, tool, stroke);
  if (flutes) group.append(flutes);

  svg.append(defs, group);
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
