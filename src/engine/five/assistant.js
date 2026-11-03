// The 5-axis setup assistant: what has to be true before a simultaneous program
// is worth running, as a checklist.
//
// Most of what goes wrong with a 5-axis job is not in the toolpath. It is that
// the machine has no tilt axis the post can drive; that nobody has said where the
// table's axes cross, so the post is carrying the tip round the wrong centre; that
// A counts the other way on this machine and the whole program is mirrored; that
// the part has an undercut the simulation cannot see; that the holder has never
// been described, so every collision check ran against a made-up one. Each of
// those is a thing a person can fix in a minute at the screen and an hour at the
// machine, and none of them announces itself.
//
// So this walks them, in the order a person would check them, and says for each
// whether it is right, what it means if not, and — where there is one — the
// single action that fixes it. The panel draws the answer (props/setup-panel.js);
// the module is pure, takes data rather than the document, and is tested alone.

import { fiveAxisRefusal, trunnionOf } from './kinematics.js';
import { fiveChecks } from './checks.js';
import { fiveFor } from './post-data.js';
import { isIndexed } from '../indexing.js';
import { isFiveAxisOp } from './ops.js';
import { machineWarnings, TCP_MODES } from '../../doc/machines.js';

/** More of the part than this facing down, above its base, is an undercut worth a warning. */
const UNDERCUT_SHARE = 0.03;

/**
 * Down-facing area above the base of the part, as a share of its whole surface.
 *
 * The bottom of a part faces down and is meant to; what matters is a face that
 * faces down with part *under* it, which is the shape a top-down heightmap cannot
 * hold. The base is taken to be the lowest half millimetre.
 */
export function undercutShare(mesh) {
  const p = mesh?.positions;
  const index = mesh?.indices;
  if (!p?.length || !index?.length) return { share: 0, area: 0 };
  let lowest = Infinity;
  for (let i = 2; i < p.length; i += 3) if (p[i] < lowest) lowest = p[i];
  let total = 0;
  let under = 0;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3;
    const b = index[t + 1] * 3;
    const c = index[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue;
    const area = len / 2;
    total += area;
    const height = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    if (nz / len < -0.3 && height > lowest + 0.5) under += area;
  }
  return { share: total > 0 ? under / total : 0, area: under };
}

/**
 * @param input.setup the setup being checked
 * @param input.machine its machine record
 * @param input.ops [{ op, tool, cl }] the setup's enabled operations, with the
 *   toolpath where one has been generated
 * @param input.mesh the part in the setup's own frame, merged, or null
 * @returns {{ items, errors, warnings }} items are
 *   `{ id, level: 'ok'|'info'|'warn'|'error', title, detail, fix? }` with `fix` a
 *   `{ id, label }` the panel knows how to perform
 */
export function fiveAxisChecks({
  setup, machine, ops = [], mesh = null,
}) {
  const items = [];
  const add = (id, level, title, detail, fix = null) => {
    items.push({ id, level, title, detail, ...(fix ? { fix } : {}) });
  };
  const five = setup?.five;
  const tcp = machine?.tcp ?? 'kins';
  const leaning = ops.filter(({ op }) => isFiveAxisOp(op.type));

  // 1 — the machine can do it at all
  const refusal = fiveAxisRefusal(machine);
  if (refusal) {
    add('machine', 'error', 'This machine has no tilting table',
      refusal, { id: 'machines', label: 'Machines…' });
  } else {
    const t = trunnionOf(machine);
    add('machine', 'ok', `${machine.name}: ${t.kind[0]}/${t.kind[1]} trunnion`,
      `${t.tilt.letter} tilts about ${t.tilt.axis[0] ? 'X' : 'Y'} and ${t.turn.letter} turns the part about Z.`);
  }

  // 2 — nothing else is asking the table for the same thing
  if (isIndexed(setup)) {
    add('index', 'error', 'This setup is also indexed',
      'An indexed (3+2) setup holds the table at a fixed tilt under a tilted work plane; a '
      + 'simultaneous program turns it as it cuts. Index it or run it simultaneously, not both.',
      { id: 'indexOff', label: 'Turn indexing off' });
  }
  if (setup?.wrap) {
    add('wrap', 'error', 'This setup is also wrapped',
      'A wrapped program turns a rotary axis to bend a flat pattern round a bar; the table '
      + 'cannot be doing both.', { id: 'wrapOff', label: 'Turn the wrap off' });
  }

  // 3 — who does the pivot arithmetic, and what the control must be set up for
  add('tcp', 'info', `Tool centre point: ${TCP_MODES[tcp]}`,
    tcp === 'kins'
      ? 'The program is written in part coordinates and LinuxCNC\'s trt kinematics module '
        + '(xyzac-trt-kins or xyzbc-trt-kins) does the rest — it has to be the one loaded.'
      : tcp === 'g43.4'
        ? 'The post writes G43.4 H<tool> before the first rotary move and G49 after; the '
          + 'control must have tool-centre-point control (Fanuc, Haas, Okuma style).'
        : 'The post turns the tip into machine axes itself, with a G93 inverse-time feed, '
          + 'so it needs the rotary centre exactly.',
    { id: 'machines', label: 'Change…' });

  // 4 — where the table's axes cross
  const hasPivot = Array.isArray(five?.pivot);
  if (tcp === 'none' && !hasPivot) {
    add('pivot', 'error', 'The rotary centre is not set',
      'Without tool-centre-point the post carries every point round the point where the two '
      + 'table axes cross. Measure it from the work datum and enter it below.');
  } else if (!hasPivot) {
    add('pivot', 'info', 'The rotary centre is not set',
      'The control does not need it, but the travel and collision checks here assume the table '
      + 'turns about the work datum. Entering where the axes really cross makes them honest.');
  } else {
    add('pivot', 'ok', `Rotary centre at X${five.pivot[0]} Y${five.pivot[1]} Z${five.pivot[2]}`,
      'Measured from the work datum, in this setup\'s own frame.');
  }

  // 5 — the lean fits the tilt axis
  const tilt = trunnionOf(machine)?.tilt;
  if (tilt) {
    for (const { op } of leaning) {
      const most = op.params?.maxTilt ?? 35;
      const reach = Math.min(Math.abs(tilt.min ?? -Infinity), Math.abs(tilt.max ?? Infinity));
      if (Number.isFinite(reach) && most > reach + 1e-9) {
        add(`limit-${op.id}`, 'warn', `${op.name} may lean further than ${tilt.letter} can swing`,
          `It is allowed ${most}° from vertical and ${tilt.letter} reaches ${reach}° either way. `
          + 'Lower "Never more than" on the operation, or widen the axis in Machines.',
          { id: 'machines', label: 'Machines…' });
      }
    }
  }

  // 6 — which way is positive
  if (five?.enabled) {
    if (five.signChecked) {
      add('sign', 'ok', 'Axis directions confirmed',
        'You have jogged the rotary axes and they go the way the program assumes.');
    } else {
      add('sign', 'warn', 'Check which way A and C turn',
        'The program assumes a positive A tilts the table the right-hand way about the axis '
        + 'and a positive C turns it counter-clockwise from above. Jog each axis a few degrees '
        + 'on the machine and look. If one goes the other way, reverse it in Machines — a '
        + 'mirrored axis cuts a mirror-image part.', { id: 'sign', label: 'I have checked' });
    }
  }

  // 7 — what the simulation cannot see
  if (mesh) {
    const { share, area } = undercutShare(mesh);
    if (share > UNDERCUT_SHARE) {
      add('part', 'warn', 'The part has undercuts',
        `${area.toFixed(0)}mm² (${(share * 100).toFixed(0)}% of its surface) faces down above `
        + 'the base. The toolpath, the simulation and the verification all see the part from '
        + 'above, so metal under an overhang is not machined and is not shown.');
    } else {
      add('part', 'ok', 'The part is seen whole from above', 'No overhangs to hide from the simulation.');
    }
  }

  // 8 — what the cutters are, to the collision check
  const seen = new Set();
  for (const { tool } of leaning) {
    if (!tool || seen.has(tool.id)) continue;
    seen.add(tool.id);
    const holder = Array.isArray(tool.holder) && tool.holder.length > 0;
    if (!holder) {
      add(`holder-${tool.id}`, 'warn', `${tool.name ?? 'The cutter'} has no holder described`,
        'The collision checks use a stand-in holder, ⌀25 by 45mm above the shank. A leaning '
        + 'spindle is the case where the real one matters: enter it on the tool.');
    }
    if (tool.type === 'flat') {
      add(`flat-${tool.id}`, 'info', `${tool.name ?? 'The cutter'} is a flat end mill`,
        'A flat end leaned to the surface cuts with one edge, and leaves a ridge where a ball '
        + 'or bull nose leaves a scallop. It works; it is not what this strategy is for.');
    }
  }

  // 9 — what the collision check can see
  if ((setup?.fixtures ?? []).length === 0) {
    add('fixtures', 'info', 'No clamps are modelled',
      'The simulation checks the leaning holder against the clamps you have entered. With '
      + 'none, a clamp the holder would hit is not on its list.');
  }

  // 10 — what the generated program asks of this machine
  for (const { op, cl } of leaning) {
    if (!cl?.fiveAxis) continue;
    const data = fiveFor(setup, machine, cl);
    if (!data || data.refused) continue;
    const { findings, extent } = fiveChecks(cl, data);
    for (const f of findings) {
      add(`check-${op.id}-${items.length}`, f.level === 'warn' ? 'warn' : 'info', `${op.name}`, f.text);
    }
    for (const w of machineWarnings(machine, extent, {})) {
      add(`travel-${op.id}-${items.length}`, 'warn', `${op.name}: travel`, `${w.text} (the tip carried round the rotary centre)`);
    }
  }

  const errors = items.filter((i) => i.level === 'error').length;
  const warnings = items.filter((i) => i.level === 'warn').length;
  return { items, errors, warnings };
}
