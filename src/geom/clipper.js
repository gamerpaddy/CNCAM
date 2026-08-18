// ESM wrapper around vendored clipper-lib. All app code goes through this —
// nothing else touches ClipperLib directly, so swapping to a Clipper2 port
// later only changes this file.
//
// Loop format everywhere in CNCAM: flat number array [x0, y0, x1, y1, ...],
// implicitly closed, millimeters.

import '../../vendor/clipper/clipper.js';

const ClipperLib = globalThis.ClipperLib;
const SCALE = 1e5; // 10 nm integer resolution

function toPath(loop) {
  const path = [];
  for (let i = 0; i < loop.length; i += 2) {
    path.push({ X: Math.round(loop[i] * SCALE), Y: Math.round(loop[i + 1] * SCALE) });
  }
  return path;
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
  const co = new ClipperLib.ClipperOffset(2, arcTolerance * SCALE);
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
  const co = new ClipperLib.ClipperOffset(2, arcTolerance * SCALE);
  co.AddPaths(usable, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
  const solution = new ClipperLib.Paths();
  co.Execute(solution, halfWidth * SCALE);
  return unionPaths(solution).map(fromPath);
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
  const co = new ClipperLib.ClipperOffset(2, arcTolerance * SCALE);
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
  clipper.AddPaths(paths.map(toPath).filter((p) => p.length >= 2),
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

/** Just the enclosed voids of a loop set — pockets, in other words. */
export function enclosedVoids(loops) {
  return unionWithHoles(loops).flatMap((region) => region.holes);
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
