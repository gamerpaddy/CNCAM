// Where an imported drawing sits on the job.
//
// A DXF arrives in whatever frame the person who drew it happened to use — an
// origin in the corner, or in the middle, or three metres away because the
// sheet had a title block on it. None of that is where the part is. So a
// drawing carries a *placement*: where its own origin lands in setup space,
// how big it is, and which way round.
//
// Kept apart from io/dxf.js on purpose. That file's job is to read a format;
// this one's is to answer "where does that line go on this billet", which is a
// machining question and is asked again every time the stock changes.

/** How a drawing's own origin is tied to the job. */
export const DRAWING_ORIGINS = ['stock-center', 'stock-corner', 'as-drawn'];

export const DRAWING_ORIGIN_LABELS = {
  'stock-center': 'Centred on the stock',
  'stock-corner': 'From the stock\'s minimum corner',
  'as-drawn': 'Where the file puts it',
};

export const DRAWING_ORIGIN_HINTS = {
  'stock-center': 'The drawing\'s own middle lands on the middle of the billet — '
    + 'what you want for a logo or a plate of text.',
  'stock-corner': 'The drawing\'s bottom-left lands on the billet\'s, so the '
    + 'coordinates in the file are the coordinates on the part.',
  'as-drawn': 'The file\'s own coordinates, used as they are. Right when the '
    + 'drawing was made in the part\'s frame in the first place.',
};

export function createPlacement() {
  return {
    origin: 'stock-center',
    offset: [0, 0],
    rotationDeg: 0,
    scale: 1,
    // Mirroring is not vanity: engraving a stamp, a mould half or the underside
    // of a plate all want the drawing the other way round, and doing it in the
    // CAD and re-exporting is a round trip nobody should have to make.
    mirrorX: false,
  };
}

/**
 * The drawing's paths in setup coordinates.
 *
 * @param drawing { paths, placement, bounds }
 * @param stock resolved stock, or null — with no stock the only honest answer
 *   is the drawing's own coordinates, whatever the origin mode says
 * @returns [{ points: [x, y, …], closed }]
 */
export function placedPaths(drawing, stock) {
  const paths = drawing?.paths ?? [];
  if (paths.length === 0) return [];
  const p = { ...createPlacement(), ...(drawing.placement ?? {}) };
  const bounds = drawing.bounds ?? boundsOfPaths(paths);
  if (!bounds) return [];

  const scale = Number.isFinite(p.scale) && p.scale > 0 ? p.scale : 1;
  const angle = ((p.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const mirror = p.mirrorX ? -1 : 1;

  // The point of the drawing that gets pinned, and where it gets pinned to.
  const [ax, ay] = anchorOf(p.origin, bounds);
  const [tx, ty] = targetOf(p.origin, stock, bounds, scale);

  // Turn everything about the anchor first, and only then decide where it goes.
  const turned = paths.map(({ points, closed }) => {
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i += 2) {
      // about the anchor: mirror, scale, rotate
      const dx = (points[i] - ax) * scale * mirror;
      const dy = (points[i + 1] - ay) * scale;
      out[i] = dx * cos - dy * sin;
      out[i + 1] = dx * sin + dy * cos;
    }
    return { points: out, closed: !!closed };
  });

  // Where the *turned* drawing is held.
  //
  // It used to be where the un-turned one was held, and that is only the same
  // point while the transform leaves it alone. Centring survives a mirror, a
  // rotation and a scale, so 'stock-center' was always right; a corner does
  // not. Mirroring a corner-pinned drawing reflected it about its own left
  // edge, putting all of it to the *left* of the billet's corner — a 20mm
  // drawing landing at −20…0 with "runs 20.00mm off the billet" underneath it,
  // for a gesture that should not have moved it at all. A quarter turn did the
  // same. The corner that gets pinned has to be the corner it ends up with.
  const [rx, ry] = refOf(p.origin, boundsOfPaths(turned));
  const ox = tx - rx + (p.offset?.[0] ?? 0);
  const oy = ty - ry + (p.offset?.[1] ?? 0);
  for (const { points } of turned) {
    for (let i = 0; i < points.length; i += 2) {
      points[i] += ox;
      points[i + 1] += oy;
    }
  }
  return turned;
}

/** Which point of the drawing is held. */
function anchorOf(origin, bounds) {
  if (origin === 'as-drawn') return [0, 0];
  if (origin === 'stock-corner') return [bounds.min[0], bounds.min[1]];
  return [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2];
}

/**
 * The same choice of point, asked of the drawing after it has been turned.
 *
 * 'as-drawn' is the one mode with no reference point of its own: the file's
 * coordinates are used as they are, so the origin it turns about is the origin
 * it keeps, whatever the transform did to its extents.
 */
function refOf(origin, bounds) {
  if (origin === 'as-drawn' || !bounds) return [0, 0];
  if (origin === 'stock-corner') return [bounds.min[0], bounds.min[1]];
  return [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2];
}

/** And where on the job it is held. */
function targetOf(origin, stock, bounds, scale) {
  if (origin === 'as-drawn' || !stock) return [0, 0];
  if (origin === 'stock-corner') return [stock.min[0], stock.min[1]];
  return [(stock.min[0] + stock.max[0]) / 2, (stock.min[1] + stock.max[1]) / 2];
}

export function boundsOfPaths(paths) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { points } of paths) {
    for (let i = 0; i < points.length; i += 2) {
      if (points[i] < minX) minX = points[i];
      if (points[i] > maxX) maxX = points[i];
      if (points[i + 1] < minY) minY = points[i + 1];
      if (points[i + 1] > maxY) maxY = points[i + 1];
    }
  }
  return Number.isFinite(minX) ? { min: [minX, minY], max: [maxX, maxY] } : null;
}

/**
 * Does the placed drawing fit on the stock?
 *
 * A logo scaled 10× is still a valid drawing and still engraves — off the side
 * of the billet, into the vice. The check is cheap and the failure is not.
 *
 * @returns null when it fits, otherwise a sentence saying how it does not
 */
export function overhangOf(placed, stock) {
  if (!stock) return null;
  const bounds = boundsOfPaths(placed);
  if (!bounds) return null;
  const over = [
    stock.min[0] - bounds.min[0], bounds.max[0] - stock.max[0],
    stock.min[1] - bounds.min[1], bounds.max[1] - stock.max[1],
  ];
  const worst = Math.max(...over);
  if (!(worst > 0.005)) return null;
  const axis = over.indexOf(worst) < 2 ? 'X' : 'Y';
  return `the drawing runs ${worst.toFixed(2)}mm off the billet in ${axis}`;
}
