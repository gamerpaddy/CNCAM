// Raster material tracking for engagement-controlled clearing.
//
// Roughing a level asks the same question thousands of times: how much uncut
// material is under the cutter right now, and may the cutter centre even be
// here? Polygon booleans answer both exactly and far too slowly to ask once per
// millimetre of path, so the level is rasterised once into two bitmaps — what is
// still material, and where the centre may go — and every later query is a
// stencil over the cells the tool covers.
//
// Both bitmaps are deliberately biased safe. Material is dilated by a cell, so
// a sliver of stock is never mistaken for air and engagement is never
// under-reported; the allowed region is eroded by a cell, so a centre the raster
// calls legal is legal for the real polygon too.

const MAX_CELLS = 4_000_000;

/**
 * A grid covering `bounds` (padded), with the cell size coarsened if the naive
 * one would need more cells than we are willing to hold.
 * Cell (i, j) is sampled at min + (i, j) * cellSize.
 */
export function makeGrid({ min, max }, cellSize, pad = 0) {
  const lo = [min[0] - pad, min[1] - pad];
  const hi = [max[0] + pad, max[1] + pad];
  const dims = (cs) => [
    Math.max(1, Math.ceil((hi[0] - lo[0]) / cs) + 1),
    Math.max(1, Math.ceil((hi[1] - lo[1]) / cs) + 1),
  ];
  let cs = Math.max(cellSize, 1e-4);
  let [width, height] = dims(cs);
  if (width * height > MAX_CELLS) {
    cs *= Math.sqrt((width * height) / MAX_CELLS);
    [width, height] = dims(cs);
  }
  return { min: lo, width, height, cellSize: cs };
}

/**
 * Fill a grid mask from closed loops (outers CCW, holes CW — the CNCAM
 * convention). Scanline parity, which handles holes without needing to know
 * which loop is which, exactly as `pointInLoops` does.
 */
export function rasterizeLoops(loops, grid) {
  const { min, width, height, cellSize } = grid;
  const mask = new Uint8Array(width * height);
  const xs = [];
  for (let j = 0; j < height; j++) {
    const y = min[1] + j * cellSize;
    xs.length = 0;
    for (const loop of loops) {
      const n = loop.length / 2;
      for (let i = 0, k = n - 1; i < n; k = i++) {
        const yi = loop[i * 2 + 1];
        const yk = loop[k * 2 + 1];
        if ((yi > y) === (yk > y)) continue;
        const xi = loop[i * 2];
        const xk = loop[k * 2];
        xs.push(xi + ((y - yi) / (yk - yi)) * (xk - xi));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const row = j * width;
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil((xs[s] - min[0]) / cellSize));
      const i1 = Math.min(width - 1, Math.floor((xs[s + 1] - min[0]) / cellSize));
      for (let i = i0; i <= i1; i++) mask[row + i] = 1;
    }
  }
  return mask;
}

/** 3x3 max filter — grows a mask by one cell. */
export function dilateMask(mask, { width, height }) {
  return filter3x3(mask, width, height, Math.max, 0);
}

/** 3x3 min filter — shrinks a mask by one cell. */
export function erodeMask(mask, { width, height }) {
  return filter3x3(mask, width, height, Math.min, 1);
}

function filter3x3(mask, width, height, pick, edge) {
  const tmp = new Uint8Array(mask.length);
  for (let j = 0; j < height; j++) {
    const row = j * width;
    for (let i = 0; i < width; i++) {
      const l = i > 0 ? mask[row + i - 1] : edge;
      const rgt = i + 1 < width ? mask[row + i + 1] : edge;
      tmp[row + i] = pick(mask[row + i], l, rgt);
    }
  }
  const out = new Uint8Array(mask.length);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const up = j > 0 ? tmp[(j - 1) * width + i] : edge;
      const dn = j + 1 < height ? tmp[(j + 1) * width + i] : edge;
      out[j * width + i] = pick(tmp[j * width + i], up, dn);
    }
  }
  return out;
}

/**
 * The fraction of a cutter's disc that is buried when it takes a cut `width` mm
 * wide against a straight wall of material — a circular segment over the disc.
 *
 * This is the bridge between the number a machinist sets (radial width of cut,
 * "how deep a bite") and the number the raster can measure (how much of the disc
 * is over uncut material). It is exact for a straight boundary and generous
 * where the boundary curves around the tool, which is precisely the inside
 * corner we want flagged.
 */
export function engagementFraction(radius, width) {
  const w = Math.max(0, Math.min(width, 2 * radius));
  const s = radius - w;                      // signed distance to the chord
  const area = radius * radius * Math.acos(s / radius) - s * Math.sqrt(Math.max(0, radius * radius - s * s));
  return area / (Math.PI * radius * radius);
}

/** `engagementFraction` read backwards: the bite a measured fraction implies. */
export function widthFromFraction(radius, fraction) {
  if (!(fraction > 0)) return 0;
  if (fraction >= 1) return 2 * radius;
  let lo = 0;
  let hi = 2 * radius;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (engagementFraction(radius, mid) < fraction) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * A level's material, tracked as it is cut away.
 *
 * @param material closed loops of stock that is still there (part excluded)
 * @param allowed  closed loops the tool *centre* may occupy
 * @param radius   cutter radius
 */
export class ClearingMap {
  constructor({ material, allowed, radius, cellSize, bounds }) {
    this.radius = radius;
    this.grid = makeGrid(bounds, cellSize, radius + 4 * cellSize);
    this.uncut = dilateMask(rasterizeLoops(material, this.grid), this.grid);
    // Two readings of the same region, biased opposite ways, because two
    // different questions are asked of it.
    //
    // `allowed` is eroded: "yes" means yes for the real polygon too, which is
    // what you want before putting a cutter down.
    //
    // `region` is dilated, and that is the reading a *travel* move needs. Every
    // span the clipper produces ends exactly on the region boundary, and a
    // raster only lights a cell whose centre is inside — so the endpoint of
    // every span reads as out of bounds, and a link asked to set off from there
    // was refused before it began. That cost 119 of 125 retracts on the sample
    // part. One cell of slack cannot reach the work: the region already has the
    // whole cutter radius and the finishing allowance built into it.
    const raster = rasterizeLoops(allowed, this.grid);
    this.region = dilateMask(raster, this.grid);
    this.allowed = erodeMask(raster, this.grid);
    this.cellArea = this.grid.cellSize * this.grid.cellSize;
    this.initialCells = count(this.uncut);
    this.disc = discKernel(radius, this.grid.cellSize);
  }

  index(x, y) {
    const { min, cellSize, width, height } = this.grid;
    const i = Math.round((x - min[0]) / cellSize);
    const j = Math.round((y - min[1]) / cellSize);
    if (i < 0 || j < 0 || i >= width || j >= height) return -1;
    return j * width + i;
  }

  /** May the tool centre sit here? Anything off the grid is a no. */
  allowedAt(x, y) {
    const k = this.index(x, y);
    return k >= 0 && this.allowed[k] === 1;
  }

  /**
   * Is this inside the region at all — the question a travel move asks.
   *
   * Biased the other way from `allowedAt`, so that the boundary itself counts
   * as inside. See the constructor for why that is the safe direction here.
   */
  insideAt(x, y) {
    const k = this.index(x, y);
    return k >= 0 && this.region[k] === 1;
  }

  /** Fraction of the cutter disc over uncut material with the tip at (x, y). */
  engagementAt(x, y) {
    const { min, cellSize, width, height } = this.grid;
    const ci = Math.round((x - min[0]) / cellSize);
    const cj = Math.round((y - min[1]) / cellSize);
    const k = this.disc;
    let hits = 0;
    for (let n = 0; n < k.length; n += 2) {
      const i = ci + k[n];
      const j = cj + k[n + 1];
      if (i < 0 || j < 0 || i >= width || j >= height) continue;
      hits += this.uncut[j * width + i];
    }
    return hits / (k.length / 2);
  }

  /**
   * The radial width of cut, in mm, for a tool at (x, y) travelling along
   * (ux, uy) — the number the strategy's whole promise is stated in.
   *
   * `engagementAt` is not that number and cannot be turned into it. It answers
   * how much of the disc is over uncut material, which is the same thing only
   * while the cleared space is *beside* the cutter. Where the cleared space is
   * *behind* it — a pass driving into a patch the peel left standing, material
   * to its left, right and front — a third of the disc reads as cleared because
   * the tool has just come through there, and a full-width slot reports as a
   * comfortable half-width bite. Measured on the sloped test part: 0.53 read
   * against 1.00 taken, which is how a 6mm cut 10.3mm deep passed a limit set
   * at 0.15xD.
   *
   * What a move actually removes per millimetre travelled is decided at its
   * *leading edge*, so that is what is asked: across the disc, how much of the
   * front of it is over material. Nothing behind the centre is counted, which
   * is also what makes the answer stable — the trailing half is the tool's own
   * wake, and it is not evidence about the cut ahead.
   */
  widthAt(x, y, ux, uy) {
    const along = Math.hypot(ux, uy);
    if (!(along > 0)) return 0;
    const ax = ux / along;
    const ay = uy / along;
    const r = this.radius;
    const cell = this.grid.cellSize;
    const steps = Math.max(4, Math.ceil((2 * r) / cell));
    const dv = (2 * r) / steps;
    let width = 0;
    for (let s = 0; s < steps; s++) {
      const v = -r + (s + 0.5) * dv;
      // half a cell inside the rim: a path running exactly one radius from a
      // cell is tangent to the sweep, and reading the rim itself is reading a
      // quantity that is exactly zero
      const ahead = Math.sqrt(Math.max(0, r * r - v * v)) - 0.5 * cell;
      if (ahead < 0) continue;
      const k = this.index(x - ay * v + ax * ahead, y + ax * v + ay * ahead);
      if (k >= 0 && this.uncut[k] === 1) width += dv;
    }
    return width;
  }

  /**
   * Remove the material a cut from (x0,y0) to (x1,y1) sweeps away.
   * @returns the area removed, mm² — which divided by the length of the move is
   *   the radial width of cut, the number a machinist calls the bite.
   */
  sweep(x0, y0, x1, y1) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    // long segments make a wastefully loose bounding box, so they are chopped
    // into pieces about as long as the cutter is wide
    const pieces = Math.max(1, Math.ceil(len / (2 * this.radius)));
    let cells = 0;
    for (let p = 0; p < pieces; p++) {
      const t0 = p / pieces;
      const t1 = (p + 1) / pieces;
      cells += this.sweepSegment(
        x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0,
        x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1,
      );
    }
    return cells * this.cellArea;
  }

  /** @returns how many cells this segment took out. */
  sweepSegment(x0, y0, x1, y1) {
    const { min, cellSize, width, height } = this.grid;
    const r = this.radius;
    const i0 = Math.max(0, Math.floor((Math.min(x0, x1) - r - min[0]) / cellSize));
    const i1 = Math.min(width - 1, Math.ceil((Math.max(x0, x1) + r - min[0]) / cellSize));
    const j0 = Math.max(0, Math.floor((Math.min(y0, y1) - r - min[1]) / cellSize));
    const j1 = Math.min(height - 1, Math.ceil((Math.max(y0, y1) + r - min[1]) / cellSize));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lenSq = dx * dx + dy * dy;
    const r2 = r * r;
    let removed = 0;
    for (let j = j0; j <= j1; j++) {
      const py = min[1] + j * cellSize;
      const row = j * width;
      for (let i = i0; i <= i1; i++) {
        if (this.uncut[row + i] === 0) continue;
        const px = min[0] + i * cellSize;
        let t = lenSq > 0 ? ((px - x0) * dx + (py - y0) * dy) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - (x0 + dx * t);
        const ey = py - (y0 + dy * t);
        if (ex * ex + ey * ey <= r2) { this.uncut[row + i] = 0; removed++; }
      }
    }
    return removed;
  }

  /**
   * Distance (mm) from every allowed cell to the nearest place the centre may
   * not go — a two-pass chamfer transform, which is plenty accurate for
   * choosing where to put the tool down.
   */
  distanceToEdge() {
    if (this.dt) return this.dt;
    const { width, height, cellSize } = this.grid;
    const near = cellSize;                 // orthogonal step
    const diag = cellSize * Math.SQRT2;
    const dt = new Float32Array(width * height);
    for (let i = 0; i < dt.length; i++) dt[i] = this.allowed[i] ? Infinity : 0;

    const relax = (k, from, cost) => {
      const v = dt[from] + cost;
      if (v < dt[k]) dt[k] = v;
    };
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const k = j * width + i;
        if (dt[k] === 0) continue;
        if (i > 0) relax(k, k - 1, near);
        if (j > 0) relax(k, k - width, near);
        if (j > 0 && i > 0) relax(k, k - width - 1, diag);
        if (j > 0 && i + 1 < width) relax(k, k - width + 1, diag);
      }
    }
    for (let j = height - 1; j >= 0; j--) {
      for (let i = width - 1; i >= 0; i--) {
        const k = j * width + i;
        if (dt[k] === 0) continue;
        if (i + 1 < width) relax(k, k + 1, near);
        if (j + 1 < height) relax(k, k + width, near);
        if (j + 1 < height && i + 1 < width) relax(k, k + width + 1, diag);
        if (j + 1 < height && i > 0) relax(k, k + width - 1, diag);
      }
    }
    this.dt = dt;
    return dt;
  }

  /**
   * The most sheltered spot that still has material under it — where to put the
   * tool down when a region has to be opened from the inside.
   *
   * Furthest from the walls is the safest place to bore, and it is also the spot
   * with the most room for the first rings to grow before they meet anything.
   *
   * @returns [x, y] or null when nothing reachable is left standing
   */
  findSeed() {
    const dt = this.distanceToEdge();
    const { min, width, cellSize } = this.grid;
    let best = -1;
    let bestDist = 0;
    for (let k = 0; k < dt.length; k++) {
      if (this.uncut[k] === 0 || this.allowed[k] === 0) continue;
      if (dt[k] > bestDist) { bestDist = dt[k]; best = k; }
    }
    if (best < 0) return null;
    return [
      min[0] + (best % width) * cellSize,
      min[1] + Math.floor(best / width) * cellSize,
    ];
  }

  /**
   * How far the tool centre may move away from (x, y) before it reaches
   * somewhere it may not be — the inradius of the region around that point.
   *
   * The same distance transform `findSeed` chooses by, asked at one place
   * instead of everywhere. A seed is only useful with a number to go with it:
   * whatever is drawn around it has to *fit*, and a walled-off region is
   * routinely narrower than the circle a peel would like to open it with.
   * Never zero — an allowed cell is at least one cell from a disallowed one.
   */
  roomAt(x, y) {
    const k = this.index(x, y);
    return k < 0 ? 0 : this.distanceToEdge()[k];
  }

  /** Area of material still standing, mm². */
  remainingArea() { return count(this.uncut) * this.cellArea; }

  /** Fraction of the level's material still standing. */
  remainingFraction() {
    return this.initialCells === 0 ? 0 : count(this.uncut) / this.initialCells;
  }
}

/** Grid offsets covering a disc of `radius`, as [di, dj, …]. */
function discKernel(radius, cellSize) {
  const reach = Math.max(1, Math.ceil(radius / cellSize));
  const out = [];
  for (let dj = -reach; dj <= reach; dj++) {
    for (let di = -reach; di <= reach; di++) {
      if (Math.hypot(di * cellSize, dj * cellSize) > radius + 1e-9) continue;
      out.push(di, dj);
    }
  }
  return Int32Array.from(out);
}

function count(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n;
}
