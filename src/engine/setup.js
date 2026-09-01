// Setup orientation: how the part sits on the machine, and where WCS zero is.
//
// A setup owns a rigid transform applied to its models before anything is
// machined. Two independent things live here:
//
//   rotationDeg  — how the part is fixtured. The part as modelled is rarely the
//                  part as clamped; rotating it here is what lets you machine
//                  the "bottom" in a second setup without editing the model.
//   origin       — which corner of the resulting stock the controller calls
//                  (0,0,0). Toolpaths are emitted in that frame, so the G-code
//                  matches what the operator touches off on.
//
// Everything downstream (stock, silhouette, strategies, posts) works on the
// already-transformed mesh, so no other module has to know about orientation.

export const ORIGIN_MODES = [
  'stock-top-center',
  'stock-top-min',
  'stock-top-max',
  'stock-bottom-center',
  'stock-bottom-min',
  'model',
];

export const ORIGIN_LABELS = {
  'stock-top-center': 'Stock top, centre',
  'stock-top-min': 'Stock top, X−Y− corner',
  'stock-top-max': 'Stock top, X+Y+ corner',
  'stock-bottom-center': 'Stock bottom, centre',
  'stock-bottom-min': 'Stock bottom, X−Y− corner',
  model: 'Model origin (no shift)',
};

/** Common fixturing flips, as [rx, ry, rz] in degrees. */
export const ORIENTATION_PRESETS = [
  { name: 'Top up (as modelled)', rotationDeg: [0, 0, 0] },
  { name: 'Flip over X (machine underside)', rotationDeg: [180, 0, 0] },
  { name: 'Flip over Y', rotationDeg: [0, 180, 0] },
  { name: 'On its side (X)', rotationDeg: [90, 0, 0] },
  { name: 'On its side (Y)', rotationDeg: [0, 90, 0] },
  { name: 'Rotate 90° in Z', rotationDeg: [0, 0, 90] },
];

/** Row-major 3x3 rotation for intrinsic X→Y→Z degrees. */
export function rotationMatrix([rx = 0, ry = 0, rz = 0] = []) {
  const d = Math.PI / 180;
  const [sx, cx] = [Math.sin(rx * d), Math.cos(rx * d)];
  const [sy, cy] = [Math.sin(ry * d), Math.cos(ry * d)];
  const [sz, cz] = [Math.sin(rz * d), Math.cos(rz * d)];
  // Rz * Ry * Rx
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

/**
 * `rotationMatrix` read backwards: the XYZ degrees that build this matrix.
 *
 * Needed because the inverse of a fixturing rotation is *not* its angles
 * negated — Rz·Ry·Rx transposed is Rx·Ry·Rz, a different order — so anything
 * that has to state the opposite turn has to decompose it rather than flip
 * three signs. Kept beside `rotationMatrix` so the convention is written down
 * once and read back by the same rules it was written by.
 */
export function eulerFromMatrix(m) {
  const d = 180 / Math.PI;
  const sy = Math.min(1, Math.max(-1, -m[6]));
  const cy = Math.sqrt(Math.max(0, 1 - sy * sy));
  if (cy < 1e-9) {
    // Straight up or straight down in Y: X and Z turn about the same line and
    // only their sum is determined. Give it all to X.
    const rx = sy > 0 ? Math.atan2(m[1], m[4]) : Math.atan2(-m[1], m[4]);
    return [rx * d, Math.asin(sy) * d, 0];
  }
  return [Math.atan2(m[7], m[8]) * d, Math.asin(sy) * d, Math.atan2(m[3], m[0]) * d];
}

/** A rotation matrix's inverse — for a pure rotation, its transpose. */
export function transposeMatrix(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function applyMatrix(m, [x, y, z]) {
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

/** Rotate + translate a mesh into setup space. Normals are rotated, not shifted. */
export function transformMesh(mesh, matrix, offset = [0, 0, 0]) {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = applyMatrix(matrix, [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
    positions[i] = p[0] + offset[0];
    positions[i + 1] = p[1] + offset[1];
    positions[i + 2] = p[2] + offset[2];
  }
  const out = { ...mesh, positions };
  if (mesh.normals) {
    const normals = new Float32Array(mesh.normals.length);
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const n = applyMatrix(matrix, [mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]]);
      normals[i] = n[0]; normals[i + 1] = n[1]; normals[i + 2] = n[2];
    }
    out.normals = normals;
  }
  return out;
}

function originOffset(mode, bounds) {
  if (mode === 'model' || !bounds) return [0, 0, 0];
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  const pick = {
    'stock-top-center': [cx, cy, bounds.max[2]],
    'stock-top-min': [bounds.min[0], bounds.min[1], bounds.max[2]],
    'stock-top-max': [bounds.max[0], bounds.max[1], bounds.max[2]],
    'stock-bottom-center': [cx, cy, bounds.min[2]],
    'stock-bottom-min': [bounds.min[0], bounds.min[1], bounds.min[2]],
  }[mode] ?? [0, 0, 0];
  return [-pick[0], -pick[1], -pick[2]];
}

/**
 * Resolve a setup's orientation against its models.
 *
 * The origin shift depends on where the stock ends up, which depends on the
 * rotation — so this rotates first, measures the rotated stock, then solves the
 * translation that lands the chosen datum on zero.
 *
 * @returns { matrix, offset, meshes, stock } — meshes/stock already in setup space
 */
export function resolveSetup(setup, meshes, computeStockFn) {
  const orientation = setup.orientation ?? {};
  const matrix = rotationMatrix(orientation.rotationDeg ?? [0, 0, 0]);
  const rotated = meshes.map((m) => transformMesh(m, matrix));
  // the mode goes with the stock because a lathe billet is not registered the
  // same way a milling one is — see engine/stock.js computeStock
  const rotatedStock = computeStockFn(rotated, setup.stock, setup.mode ?? 'mill');
  const offset = originOffset(orientation.origin ?? 'model', rotatedStock);

  const placed = offset.every((v) => v === 0)
    ? rotated
    : rotated.map((m) => transformMesh(m, IDENTITY, offset));
  const stock = rotatedStock && {
    ...rotatedStock,
    min: rotatedStock.min.map((v, k) => v + offset[k]),
    max: rotatedStock.max.map((v, k) => v + offset[k]),
  };
  if (stock?.cylinder) {
    stock.cylinder = {
      ...rotatedStock.cylinder,
      center: [
        rotatedStock.cylinder.center[0] + offset[0],
        rotatedStock.cylinder.center[1] + offset[1],
      ],
    };
  }
  return { matrix, offset, meshes: placed, stock };
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
