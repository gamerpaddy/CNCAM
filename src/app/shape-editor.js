// Drawing a custom insert, corner by corner.
//
// The wizard can already describe every catalogue insert by its letter, and the
// custom shape 'X' by a single corner angle — a rhombus of whatever angle you
// grind. But a real off-catalogue insert is not always a rhombus: a form tool, a
// button with a flat, a hand-ground profiler. This is where you draw one.
//
// The rules are the ones engine/insert.js already lives by, so what you draw is
// what gets placed, filleted, drawn on the holder, engaged against the work and
// cut in the simulation — one shape, not two. Vertex 0 is the cutting corner (it
// is the one that touches the metal, so it is marked and it leads); the polygon
// is scaled to the inscribed circle downstream, so only its *shape* matters
// here, not its size.

import { el } from './layout.js';
import { toolAssembly } from './tool-shape.js';
import { polygonCornerAngle, isPolygon } from '../engine/insert.js';

const NS = 'http://www.w3.org/2000/svg';

/** A sensible starting insert: a rhombus of `angle°`, cutting corner first. */
export function rhombusPoints(angle = 80) {
  const half = (Math.max(20, Math.min(160, angle)) * Math.PI) / 360;
  const p = Math.cos(half);
  const q = Math.sin(half);
  // corner at −Y (drawn pointing down, into the work), body above it
  return [[0, -p], [q, 0], [0, p], [-q, 0]];
}

/**
 * Open the shape editor on a copy of `points`, calling `onApply(points)` with
 * the drawn polygon when the user keeps it.
 *
 * @param points the current custom polygon, or null to start from a rhombus
 * @param angle the fallback rhombus angle when there are no points yet
 * @param noseRadius the nose radius, only so the live preview looks right
 */
export function openShapeEditor({ points, angle = 80, noseRadius = 0.4, onApply }) {
  let pts = isPolygon(points) ? points.map(([x, y]) => [x, y]) : rhombusPoints(angle);
  let selected = 0;

  const canvas = document.createElementNS(NS, 'svg');
  canvas.setAttribute('class', 'shape-canvas');
  canvas.setAttribute('viewBox', '-1.6 -1.6 3.2 3.2');
  canvas.setAttribute('width', '320');
  canvas.setAttribute('height', '320');

  const preview = el('div', { class: 'shape-preview' });
  const readout = el('div', { class: 'prop-note' });
  const hint = el('div', { class: 'prop-note' }, [
    'Drag a corner to move it. Double-click an edge to add a corner. '
    + 'The marked corner is the one that cuts — it leads into the work.',
  ]);

  // data (math, +Y up) → SVG (y down). Kept in one place so the click maths and
  // the drawing cannot drift.
  const toSvg = ([x, y]) => [x, -y];
  const fromSvg = (sx, sy) => [sx, -sy];

  function svgPoint(evt) {
    const m = canvas.getScreenCTM();
    if (!m) return [0, 0];
    const x = (evt.clientX - m.e) / m.a;
    const y = (evt.clientY - m.f) / m.d;
    return fromSvg(x, y);
  }

  function normalise() {
    // keep the shape roughly unit-sized so the viewBox stays framed as corners
    // are dragged out — the real scaling to the inscribed circle is downstream
    let max = 0;
    for (const [x, y] of pts) max = Math.max(max, Math.hypot(x, y));
    if (max > 1e-6) pts = pts.map(([x, y]) => [x / max, y / max]);
  }

  function render() {
    canvas.replaceChildren();
    // grid + axes, so the shape has something to sit against
    for (const g of [-1, -0.5, 0.5, 1]) {
      canvas.append(line(g, -1.5, g, 1.5, 'shape-grid'));
      canvas.append(line(-1.5, g, 1.5, g, 'shape-grid'));
    }
    canvas.append(line(-1.5, 0, 1.5, 0, 'shape-axis'));
    canvas.append(line(0, -1.5, 0, 1.5, 'shape-axis'));

    // the polygon itself
    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute('points', pts.map((p) => toSvg(p).join(',')).join(' '));
    poly.setAttribute('class', 'shape-poly');
    canvas.append(poly);

    // a double-click target on each edge midpoint to add a corner there
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      const mid = toSvg([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', String(mid[0]));
      dot.setAttribute('cy', String(mid[1]));
      dot.setAttribute('r', '0.05');
      dot.setAttribute('class', 'shape-mid');
      dot.addEventListener('dblclick', () => {
        pts.splice(i + 1, 0, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
        selected = i + 1;
        render();
      });
      canvas.append(dot);
    });

    // the corners
    pts.forEach((p, i) => {
      const [sx, sy] = toSvg(p);
      const handle = document.createElementNS(NS, 'circle');
      handle.setAttribute('cx', String(sx));
      handle.setAttribute('cy', String(sy));
      handle.setAttribute('r', i === 0 ? '0.11' : '0.08');
      handle.setAttribute('class',
        `shape-handle${i === 0 ? ' cutting' : ''}${i === selected ? ' selected' : ''}`);
      handle.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        selected = i;
        // Capture so the drag survives the pointer leaving the small canvas.
        // Guarded because it throws when there is no live pointer for the id
        // (a stray or synthetic event), and that must not abort selecting the
        // corner or wiring up the move below.
        try { canvas.setPointerCapture(evt.pointerId); } catch { /* no capture */ }
        const move = (e) => { pts[i] = svgPoint(e); redraw(); };
        const up = () => {
          try { canvas.releasePointerCapture(evt.pointerId); } catch { /* wasn't held */ }
          canvas.removeEventListener('pointermove', move);
          canvas.removeEventListener('pointerup', up);
          normalise();
          render();
        };
        canvas.addEventListener('pointermove', move);
        canvas.addEventListener('pointerup', up);
        render();
      });
      canvas.append(handle);
    });

    updateReadout();
    updatePreview();
  }

  // A light redraw during a drag: move the one handle and the polygon without
  // rebuilding every node, so dragging stays smooth.
  function redraw() {
    const poly = canvas.querySelector('.shape-poly');
    if (poly) poly.setAttribute('points', pts.map((p) => toSvg(p).join(',')).join(' '));
    const handles = canvas.querySelectorAll('.shape-handle');
    const h = handles[selected];
    if (h) { const [sx, sy] = toSvg(pts[selected]); h.setAttribute('cx', sx); h.setAttribute('cy', sy); }
    updateReadout();
  }

  function toolFromPts() {
    return {
      type: 'turning', insert: 'X', insertIc: 12, noseRadius,
      hand: 'R', leadAngle: 95, customPoints: pts.map(([x, y]) => [x, y]),
    };
  }

  function updatePreview() {
    preview.replaceChildren(toolAssembly(toolFromPts(), { width: 210, height: 120 }));
  }

  function updateReadout() {
    const angle = isPolygon(pts) ? polygonCornerAngle(pts) : 0;
    readout.textContent = `${pts.length} corners · cutting corner ${angle.toFixed(0)}°`;
  }

  const dialog = el('dialog', { class: 'lib-dialog shape-dialog' });

  const makeCorner = el('button', {}, ['Make cutting corner']);
  makeCorner.addEventListener('click', () => {
    if (selected > 0) { pts = [...pts.slice(selected), ...pts.slice(0, selected)]; selected = 0; render(); }
  });
  const removeCorner = el('button', {}, ['Delete corner']);
  removeCorner.addEventListener('click', () => {
    if (pts.length > 3) {
      pts.splice(selected, 1);
      selected = Math.min(selected, pts.length - 1);
      normalise();
      render();
    }
  });
  const reset = el('button', {}, ['Reset to rhombus']);
  reset.addEventListener('click', () => { pts = rhombusPoints(angle); selected = 0; render(); });

  const apply = el('button', { class: 'primary' }, ['Use this shape']);
  apply.addEventListener('click', () => {
    dialog.close();
    onApply?.(pts.map(([x, y]) => [x, y]));
  });

  dialog.append(
    el('h2', {}, ['Custom insert shape']),
    el('div', { class: 'shape-body' }, [
      el('div', { class: 'shape-canvas-wrap' }, [canvas]),
      el('div', { class: 'shape-side' }, [
        hint,
        el('div', { class: 'shape-tools' }, [makeCorner, removeCorner, reset]),
        el('h3', {}, ['On a holder']),
        preview,
        readout,
      ]),
    ]),
    el('div', { class: 'lib-actions' }, [
      el('span', { class: 'spacer' }),
      el('button', { onclick: () => dialog.close() }, ['Cancel']),
      apply,
    ]),
  );
  dialog.addEventListener('close', () => dialog.remove());

  normalise();
  render();
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

function line(x1, y1, x2, y2, cls) {
  const l = document.createElementNS(NS, 'line');
  l.setAttribute('x1', String(x1));
  l.setAttribute('y1', String(y1));
  l.setAttribute('x2', String(x2));
  l.setAttribute('y2', String(y2));
  l.setAttribute('class', cls);
  return l;
}
