// ESM wrapper around vendored clipper-lib. All app code goes through this —
// nothing else touches ClipperLib directly, so swapping to a Clipper2 port
// later only changes this file.
//
// Loop format everywhere in CNCAM: flat number array [x0, y0, x1, y1, ...],
// implicitly closed, millimeters.

import '../../vendor/clipper/clipper.js';

const ClipperLib = globalThis.ClipperLib;
const SCALE = 1e5; // 10 nm integer resolution

/**
 * The arc tolerance Clipper is given, scaled, with a floor.
 *
 * A round join is divided into steps of π / acos(1 − tolerance / delta), so the
 * count grows without bound as the tolerance goes to nothing: a tolerance of 0
 * (or 1e-9, or a negative one) made one offset of a 3mm tool radius a hundred
 * thousand steps per corner, and a contour pass that never finished. A tenth of
 * a micron is below what any machine or any grid here can tell from none, and
 * keeps the worst join to a few hundred steps.
 */
const MIN_ARC_TOLERANCE = 1e-4;
const arcStepOf = (tolerance) => Math.max(Number.isFinite(tolerance) ? tolerance : 0, MIN_ARC_TOLERANCE) * SCALE;

/**
 * Two sorted linked lists in the JavaScript port of Clipper, made into a sort
 * and a heap — with exactly the order the lists produced.
 *
 * Clipper keeps its local minima and its scanbeams (the Y values the sweep
 * stops at) in singly linked lists kept in order by walking from the head on
 * every insert. The C++ original uses a priority queue for the scanbeams; the
 * port does not, and a union of N triangles — which is what a silhouette is,
 * one loop per triangle in the band — costs N² list steps. Measured on an
 * 82,000-triangle terrain: 78% of a 23s clearing pass was `InsertLocalMinima`,
 * and doubling the mesh quadrupled the wait. A 180,000-triangle STL left
 * adaptive clearing running for minutes, with nothing on screen but a spinner.
 *
 * Nothing about *what* Clipper computes changes, and it must not: the order
 * the lists hold decides the order paths come back in and where each starts,
 * and every toolpath downstream is built on that. So the minima are collected
 * and sorted once into precisely the list the inserts would have built —
 * highest Y first and, among equal Ys, the most recently added first — and the
 * scanbeams, which are a set of Ys popped highest first, become a binary heap.
 */
function patchClipper(proto) {
  proto.InsertLocalMinima = function (lm) {
    (this.pendingMinima ??= []).push(lm);
  };
  const reset = proto.Reset;
  proto.Reset = function () {
    this.scanbeams = [];
    flushMinima(this);
    return reset.call(this);
  };
  const dispose = proto.DisposeLocalMinimaList;
  proto.DisposeLocalMinimaList = function () {
    this.pendingMinima = null;
    return dispose.call(this);
  };
  proto.InsertScanbeam = function (y) {
    heapPush(this.scanbeams ??= [], y);
  };
  proto.PopScanbeam = function (out) {
    const heap = this.scanbeams;
    if (!heap || heap.length === 0) {
      out.v = 0;
      return false;
    }
    const y = heapPop(heap);
    // the list never held a Y twice; the heap may, so the copies go together
    while (heap.length && heap[0] === y) heapPop(heap);
    out.v = y;
    return true;
  };
}

/** Merge the minima added since the last sweep into the list, as the inserts would have. */
function flushMinima(clipper) {
  const pending = clipper.pendingMinima;
  if (!pending?.length) return;
  clipper.pendingMinima = null;
  const order = pending.map((lm, i) => ({ lm, i }));
  order.sort((a, b) => (b.lm.Y - a.lm.Y) || (b.i - a.i));
  let head = null;
  let tail = null;
  const append = (lm) => {
    lm.Next = null;
    if (tail) tail.Next = lm; else head = lm;
    tail = lm;
  };
  let old = clipper.m_MinimaList;
  let k = 0;
  while (k < order.length || old) {
    // on a tie the newer minimum goes first — every pending one is newer
    if (k < order.length && (!old || order[k].lm.Y >= old.Y)) {
      append(order[k++].lm);
    } else {
      const next = old.Next;
      append(old);
      old = next;
    }
  }
  clipper.m_MinimaList = head;
}

function heapPush(heap, y) {
  let i = heap.length;
  heap.push(y);
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent] >= y) break;
    heap[i] = heap[parent];
    i = parent;
  }
  heap[i] = y;
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length === 0) return top;
  let i = 0;
  const n = heap.length;
  for (;;) {
    let child = i * 2 + 1;
    if (child >= n) break;
    if (child + 1 < n && heap[child + 1] > heap[child]) child++;
    if (heap[child] <= last) break;
    heap[i] = heap[child];
    i = child;
  }
  heap[i] = last;
  return top;
}

// The port copies the base class's methods onto Clipper when it loads, so both
// prototypes carry their own copy and both are patched.
if (!ClipperLib.Clipper.prototype.pendingMinimaPatched) {
  patchClipper(ClipperLib.ClipperBase.prototype);
  patchClipper(ClipperLib.Clipper.prototype);
  ClipperLib.Clipper.prototype.pendingMinimaPatched = true;
}

function toPath(loop) {
  const path = [];
  for (let i = 0; i < loop.length; i += 2) {
    path.push({ X: Math.round(loop[i] * SCALE), Y: Math.round(loop[i + 1] * SCALE) });
  }
  return path;
}

/**
 * An open path with no point repeated back to back.
 *
 * The port's open-path AddPath does not survive one: a lead-out written as the
 * pass's last point followed by an arc whose first point is that same point
 * sent it round its local-minima loop until the array holding them could grow
 * no more — "Invalid array length", from inside a clearing pass. Two equal
 * points in a row say nothing a single one does not.
 */
function withoutRepeats(path) {
  const out = [];
  for (const p of path) {
    const last = out[out.length - 1];
    if (!last || last.X !== p.X || last.Y !== p.Y) out.push(p);
  }
  return out;
}

function fromPath(path) {
  const loop = new Array(path.length * 2);
  for (let i = 0; i < path.length; i++) {
    loop[i * 2] = path[i].X / SCALE;
    loop[i * 2 + 1] = path[i].Y / SCALE;
  }
  return loop;
}

function unionPaths(paths) {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const out = new ClipperLib.Paths();
  clipper.Execute(
    ClipperLib.ClipType.ctUnion, out,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero,
  );
  return out;
}

/**
 * Union raw loops (non-zero fill) into properly oriented polygons:
 * outers CCW, holes CW. Slicer output goes through this first.
 */
export function unionLoops(loops) {
  const paths = loops.map(toPath).filter((p) => p.length >= 3);
  return unionPaths(paths).map(fromPath);
}

/**
 * Offset closed loops by `delta` (mm, positive = away from material) with
 * round joins. Input is unioned/normalized first.
 */
export function offsetLoops(loops, delta, arcTolerance = 0.005) {
  const paths = loops.map(toPath).filter((p) => p.length >= 3);
  const normalized = unionPaths(paths);
  const co = new ClipperLib.ClipperOffset(2, arcStepOf(arcTolerance));
  co.AddPaths(normalized, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const solution = new ClipperLib.Paths();
  co.Execute(solution, delta * SCALE);
  return solution.map(fromPath);
}

/**
 * Inflate open polylines into closed loops `halfWidth` either side of them.
 *
 * A picked edge is a line, and every region in the app is an area — so the line
 * has to become one somewhere, and doing it here means the region system does
 * not have to learn a second kind of shape. Round ends, because the band is a
 * tolerance around a curve rather than a rectangle anybody measured.
 *
 * @param paths flat [x, y, x, y, …] polylines, open
 */
export function bufferOpenPaths(paths, halfWidth, arcTolerance = 0.005) {
  const usable = paths.map(toPath).filter((p) => p.length >= 2);
  if (usable.length === 0 || !(halfWidth > 0)) return [];
  // A long polyline is inflated a stretch at a time and the stretches unioned.
  //
  // The offsetter resolves a path's own overlaps as it goes, and a toolpath
  // overlaps itself everywhere — every ring of a clearing pass lies inside the
  // band of the ring before it. Given one whole level of a roughing pass, 3200
  // points in 16 chains, it took 2.0s; the same chains in stretches of 64
  // points took 0.08s and came to the same area within 0.04mm² in 2987. Rest
  // machining asks this once per depth, on the thread the window runs on, so
  // the difference was nine seconds of a frozen screen on a small part.
  //
  // A stretch shares its last point with the next, and the round cap that ends
  // one is the round join that would have been there — the same disc — so the
  // union is the same shape.
  const solution = new ClipperLib.Paths();
  for (const path of usable) {
    for (let start = 0; start < path.length - 1; start += BUFFER_STRETCH - 1) {
      const stretch = start === 0 && path.length <= BUFFER_STRETCH
        ? path : path.slice(start, start + BUFFER_STRETCH);
      const co = new ClipperLib.ClipperOffset(2, arcStepOf(arcTolerance));
      co.AddPath(stretch, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
      const part = new ClipperLib.Paths();
      co.Execute(part, halfWidth * SCALE);
      for (const loop of part) solution.push(loop);
    }
  }
  return unionPaths(solution).map(fromPath);
}

/** The most points of a polyline inflated in one go — see bufferOpenPaths. */
const BUFFER_STRETCH = 64;

/**
 * Close hairline gaps in a set of loops: grown by `width` and shrunk back, which
 * fuses anything nearer than twice that and leaves everything else where it was.
 *
 * For regions built out of many pieces that were meant to touch. Two pieces
 * whose shared edge is written with different vertices — a T-junction — meet
 * only as closely as their coordinates were rounded, and Clipper's integer
 * grid is 10nm: rotate a mesh and its vertices are rounded independently, the
 * gap between the pieces comes out a grid step wide, and the union keeps them
 * apart. One loop that touches itself along a crack is the same thing.
 *
 * Growing and shrinking a polygon gives the same polygon to within a grid step
 * but not the same vertices, so a caller that only wants the cracks closed
 * should look at what changed before it takes the result — see
 * SilhouetteStack.
 */
export function closeLoops(loops, width) {
  if (!(width > 0) || loops.length < 1) return loops;
  const grown = offsetNormalized(loops, width, width / 4);
  return offsetNormalized(grown, -width, width / 4);
}

/** Boolean difference: subject minus clip (both sets of closed loops). */
export function diffLoops(subjectLoops, clipLoops) {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subjectLoops.map(toPath).filter((p) => p.length >= 3),
    ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(clipLoops.map(toPath).filter((p) => p.length >= 3),
    ClipperLib.PolyType.ptClip, true);
  const out = new ClipperLib.Paths();
  clipper.Execute(
    ClipperLib.ClipType.ctDifference, out,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero,
  );
  return out.map(fromPath);
}

/**
 * Offset already-normalized loops without re-unioning them (used for repeated
 * inward offsets of a clearing region, where re-union would be wasted work).
 */
export function offsetNormalized(loops, delta, arcTolerance = 0.005) {
  const co = new ClipperLib.ClipperOffset(2, arcStepOf(arcTolerance));
  co.AddPaths(loops.map(toPath).filter((p) => p.length >= 3),
    ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const solution = new ClipperLib.Paths();
  co.Execute(solution, delta * SCALE);
  return solution.map(fromPath);
}

/** Boolean intersection of two sets of closed loops. */
export function intersectLoops(subjectLoops, clipLoops) {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subjectLoops.map(toPath).filter((p) => p.length >= 3),
    ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(clipLoops.map(toPath).filter((p) => p.length >= 3),
    ClipperLib.PolyType.ptClip, true);
  const out = new ClipperLib.Paths();
  clipper.Execute(
    ClipperLib.ClipType.ctIntersection, out,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero,
  );
  return out.map(fromPath);
}

/**
 * Clip open polylines (not areas) against closed regions.
 *
 * Contour passes are paths, not filled shapes: restricting one to a region has
 * to cut the line into surviving spans, which is a different operation from the
 * polygon booleans above and needs Clipper's open-subject mode.
 *
 * @param paths open polylines, flat [x0,y0,...]
 * @param clipLoops closed regions
 * @param mode 'intersect' to keep what is inside, 'difference' to keep outside
 * @returns open polylines
 */
export function clipOpenPaths(paths, clipLoops, mode = 'intersect') {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(paths.map((p) => withoutRepeats(toPath(p))).filter((p) => p.length >= 2),
    ClipperLib.PolyType.ptSubject, false);
  clipper.AddPaths(clipLoops.map(toPath).filter((p) => p.length >= 3),
    ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  clipper.Execute(
    mode === 'difference' ? ClipperLib.ClipType.ctDifference : ClipperLib.ClipType.ctIntersection,
    tree,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero,
  );
  const open = ClipperLib.Clipper.OpenPathsFromPolyTree(tree);
  return open.map(fromPath).filter((p) => p.length >= 4);
}

/** Close a loop into an open polyline by repeating its first point. */
export function loopToOpenPath(loop) {
  return [...loop, loop[0], loop[1]];
}

/**
 * Union loops and return their nesting explicitly: outers with their holes.
 *
 * Union a set of polygons that tile a ring — the shape a pocket's top face
 * makes — and Clipper hands back a single self-touching "keyhole" path. Its net
 * area is right, but it has no separate hole, so anything looking for enclosed
 * voids by loop orientation finds nothing. Feeding that result through a second
 * union resolves the pinch into a proper outer with a child hole, which is why
 * this normalizes before reading the tree.
 *
 * @returns [{ outer: loop, holes: loop[] }]
 */
export function unionWithHoles(loops) {
  const normalized = unionPaths(loops.map(toPath).filter((p) => p.length >= 3));
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(normalized, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  clipper.Execute(
    ClipperLib.ClipType.ctUnion, tree,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero,
  );

  const out = [];
  const visit = (node) => {
    for (const child of node.Childs()) {
      if (!child.IsHole()) {
        out.push({
          outer: fromPath(child.Contour()),
          holes: child.Childs().filter((h) => h.IsHole()).map((h) => fromPath(h.Contour())),
        });
      }
      visit(child);   // islands inside holes are outers in their own right
    }
  };
  visit(tree);
  return out;
}

/** A flat loop [x0, y0, x1, y1, …] run the other way round, as a new array. */
function reverseLoop(loop) {
  const out = new Array(loop.length);
  const n = loop.length / 2;
  for (let i = 0; i < n; i++) {
    out[i * 2] = loop[(n - 1 - i) * 2];
    out[i * 2 + 1] = loop[(n - 1 - i) * 2 + 1];
  }
  return out;
}

/** Just the enclosed voids of a loop set — pockets, in other words. */
export function enclosedVoids(loops) {
  const regions = unionWithHoles(loops);
  return regions.flatMap((region) => region.holes.flatMap((hole) => {
    // A void with metal standing in it is not the whole hole. A pocket with an
    // island in it — a boss left in the middle for a bearing, a post for a
    // screw — has a hole in the part's shadow that the island sits inside as an
    // outer of its own, and handing back the hole alone made the pocket cut the
    // island down to the floor: measured, a 20x16 boss 8mm tall taken off to the
    // pocket floor by a pocketing pass, which clearing and adaptive leave alone.
    // What is *inside* is told by area, not by a vertex, so an island that
    // touches the wall at a point is still inside it.
    const holeArea = Math.abs(loopArea(hole));
    const islands = regions.filter((other) => {
      if (other.outer === region.outer) return false;
      const size = Math.abs(loopArea(other.outer));
      if (!(size < holeArea)) return false;
      const shared = intersectLoops([other.outer], [hole])
        .reduce((sum, loop) => sum + Math.abs(loopArea(loop)), 0);
      return shared > size * (1 - 1e-6);
    });
    if (islands.length === 0) return [hole];
    // the hole's own winding is clockwise and its islands counter-clockwise, so
    // the pocket keeps the convention the plain hole has
    return diffLoops([hole], islands.map((other) => other.outer)).map(reverseLoop);
  }));
}

/**
 * Rebuild a loop set with holes as real holes and no self-touching bridges,
 * outers CCW and holes CW.
 *
 * A keyhole polygon measures correctly and fills correctly, so it looks
 * harmless — until you offset it. The zero-width bridge joining the outer
 * boundary to the hole becomes a finite slot, and a toolpath following that
 * boundary drives all the way in along one side of the bridge and back out
 * along the other. On screen that is a contour with a long line shooting out of
 * it; on the machine it is a gouge straight through the part.
 */
export function normalizedLoops(loops) {
  const out = [];
  for (const { outer, holes } of unionWithHoles(loops)) {
    out.push(loopArea(outer) > 0 ? outer : reversedLoop(outer));
    for (const hole of holes) {
      out.push(loopArea(hole) < 0 ? hole : reversedLoop(hole));
    }
  }
  return out;
}

function reversedLoop(loop) {
  const n = loop.length / 2;
  const out = new Array(loop.length);
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i;
    out[i * 2] = loop[j * 2];
    out[i * 2 + 1] = loop[j * 2 + 1];
  }
  return out;
}

/**
 * Collapse hairline detail: merge vertices closer together than `distance` mm
 * and drop the degenerate loops that fall out.
 *
 * Needed wherever many small polygons get unioned repeatedly. Near-coincident
 * edges leave slivers a few nanometres wide which survive as separate loops,
 * and anything that walks them afterwards — offsetting with round joins, above
 * all — pays for every one.
 */
export function cleanLoops(loops, distance = 0.002) {
  const paths = loops.map(toPath).filter((p) => p.length >= 3);
  const cleaned = ClipperLib.Clipper.CleanPolygons(paths, distance * SCALE);
  return cleaned.map(fromPath).filter((loop) => loop.length >= 6);
}

/** Signed area of a loop (positive = CCW). */
export function loopArea(loop) {
  let area = 0;
  const n = loop.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += loop[i * 2] * loop[j * 2 + 1] - loop[j * 2] * loop[i * 2 + 1];
  }
  return area / 2;
}

/** Bounds of loops: { min: [x,y], max: [x,y] }. */
export function loopsBounds(loops) {
  const min = [Infinity, Infinity];
  const max = [-Infinity, -Infinity];
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i += 2) {
      min[0] = Math.min(min[0], loop[i]); max[0] = Math.max(max[0], loop[i]);
      min[1] = Math.min(min[1], loop[i + 1]); max[1] = Math.max(max[1], loop[i + 1]);
    }
  }
  return { min, max };
}
