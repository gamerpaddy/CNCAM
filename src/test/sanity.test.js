// Every strategy, run the way a user would run it, checked for output that is
// absurd rather than merely wrong.
//
// The tests elsewhere check that a strategy does the right thing on a fixture
// chosen to show it doing that thing. This file checks the other side: that
// nothing produces a program which is obviously insane — a cut outside the
// billet, a NaN, a move a metre from the part, a two-line job that takes a day.
//
// It exists because an engraving change shipped that cut 8mm below the stock
// and ran for twenty-one hours on two lines, and every targeted test passed.
// The targeted tests were all asking "is the depth right"; none of them was
// asking "is this program sane at all".

import { test, assert } from './runner.js';
import {
  generateToolpath, MILLING_OPS, TURNING_OPS, estimateSeconds,
} from '../engine/toolpath.js';
import { defaultParamsFor } from '../engine/op-defaults.js';
import { eachMove, OP, FEED } from '../engine/cl.js';
import { makePocketBlock, makeShaft, makeTube } from './fixtures.js';

const TOOLS = {
  flat: { number: 1, type: 'flat', name: '6 flat', diameter: 6, flutes: 2, fluteLength: 30, spindleRpm: 12000, feedCut: 800, feedPlunge: 250 },
  ball: { number: 2, type: 'ball', name: '4 ball', diameter: 4, flutes: 2, fluteLength: 30, spindleRpm: 12000, feedCut: 800, feedPlunge: 250 },
  drill: { number: 3, type: 'drill', name: '5 drill', diameter: 5, flutes: 2, tipAngle: 118, fluteLength: 30, spindleRpm: 3000, feedCut: 200, feedPlunge: 150 },
  vee: { number: 4, type: 'chamfer', name: '6 90', diameter: 6, tipAngle: 90, tipDiameter: 0, flutes: 1, fluteLength: 10, spindleRpm: 10000, feedCut: 600, feedPlunge: 200 },
  turning: { number: 5, type: 'turning', name: 'CCMT', diameter: 6, noseRadius: 0.4, flutes: 1, fluteLength: 12, spindleRpm: 1200, feedCut: 120, feedPlunge: 80 },
  boring: { number: 6, type: 'boring', name: 'bar', diameter: 8, noseRadius: 0.4, minBore: 10, maxDepth: 40, flutes: 1, fluteLength: 12, spindleRpm: 1000, feedCut: 100, feedPlunge: 60 },
  parting: { number: 7, type: 'parting', name: '3 blade', diameter: 3, bladeWidth: 3, flutes: 1, fluteLength: 20, spindleRpm: 700, feedCut: 40, feedPlunge: 40 },
  threading: { number: 8, type: 'threading', name: '16ER', diameter: 6, noseRadius: 0.1, bladeWidth: 1.5, flutes: 1, fluteLength: 12, spindleRpm: 400, feedCut: 100, feedPlunge: 60 },
};

function toolFor(type) {
  if (type === 'drill') return TOOLS.drill;
  if (type === 'chamfer' || type === 'engrave') return TOOLS.vee;
  if (type === 'parallel3d' || type === 'waterline') return TOOLS.ball;
  if (type === 'turnBore') return TOOLS.boring;
  if (type === 'turnPart' || type === 'turnGroove') return TOOLS.parting;
  if (type === 'turnThread') return TOOLS.threading;
  return type.startsWith('turn') ? TOOLS.turning : TOOLS.flat;
}

const block = makePocketBlock({ size: 40, pocketSize: 20, height: 20, depth: 12 });
const tube = makeTube(0, 0, 20, 8, 60);
const shaft = makeShaft();
const MILL_STOCK = { kind: 'box', min: [0, 0, 0], max: [40, 40, 20] };
const BAR = {
  kind: 'cylinder', min: [-20, -20, 0], max: [20, 20, 65],
  cylinder: { diameter: 40, height: 65, center: [0, 0] },
};

function setupFor(type) {
  const turn = TURNING_OPS.includes(type);
  const tool = toolFor(type);
  const mesh = turn ? (type === 'turnBore' ? tube : shaft.mesh) : block.mesh;
  const stock = turn ? BAR : MILL_STOCK;
  const params = {
    ...defaultParamsFor(type, { stock, tool }),
    tolerance: 0.05,
    clearanceHeight: turn ? 50 : 40,
    clearanceX: 0,
  };
  if (turn) { params.topZ = 60; params.bottomZ = 30; } else { params.topZ = 20; params.bottomZ = 8; }
  if (type === 'drill' || type === 'bore') params.bottomZ = 0;
  return { turn, tool, mesh, stock, params };
}

const everyStrategy = (fn) => {
  for (const type of [...MILLING_OPS, ...TURNING_OPS]) {
    const { turn, tool, mesh, stock, params } = setupFor(type);
    fn(type, generateToolpath({ type, name: type, tool, mesh, stock, params, fixtures: [] }),
      { turn, stock, params });
  }
};

test('no strategy produces a move that is not a number', () => {
  everyStrategy((type, cl) => {
    let bad = 0;
    eachMove(cl, (op, x, y, z) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) bad++;
    });
    assert.eq(bad, 0, `${type} emitted ${bad} moves with a NaN or an infinity in them`);
  });
});

test('no strategy cuts outside the billet it was given', () => {
  // The billet is the whole of what there is to cut. A cutting move outside it
  // is not a deep pass, it is a description of something that cannot happen —
  // and on the engraving bug it was eight millimetres below the bottom.
  everyStrategy((type, cl, { turn, stock }) => {
    let worst = null;
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if (op !== OP.LINE || feed === FEED.RAPID) return;
      // a lathe cuts to the axis and its X is a radius, so the floor is zero
      const floor = turn ? 0 : stock.min[2];
      const value = turn ? x : z;
      if (value < floor - 0.01 && (worst === null || value < worst)) worst = value;
    });
    assert.eq(worst, null,
      `${type} cuts to ${worst?.toFixed(2)}, outside a billet that stops at `
      + `${turn ? 0 : stock.min[2]}`);
  });
});

test('no strategy travels a mile to machine a 40mm part', () => {
  // A move longer than the diagonal of the job is the tool going somewhere that
  // does not exist. Clearance is part of the job, so it is in the diagonal.
  everyStrategy((type, cl, { turn, params }) => {
    const span = turn
      ? Math.hypot(65, params.clearanceHeight)
      : Math.hypot(40, 40, params.clearanceHeight);
    let prev = null;
    let longest = 0;
    eachMove(cl, (op, x, y, z) => {
      if (prev) longest = Math.max(longest, Math.hypot(x - prev[0], y - prev[1], z - prev[2]));
      prev = [x, y, z];
    });
    assert.ok(longest <= span + 1,
      `${type} makes a ${longest.toFixed(0)}mm move on a job ${span.toFixed(0)}mm across`);
  });
});

test('no strategy asks for a day of machine time on a 40mm part', () => {
  // The engraving bug ran twenty-one hours on two lines. Nothing on a fixture
  // this size is an hour of work, and that much headroom still catches anything
  // of that shape.
  everyStrategy((type, cl) => {
    const hours = estimateSeconds(cl, 3000) / 3600;
    assert.ok(hours < 1, `${type} wants ${hours.toFixed(1)} hours on a 40mm part`);
  });
});

test('every strategy either cuts or says why not', () => {
  // Silence and an empty program is the failure that looks exactly like an
  // operation nobody has generated yet.
  everyStrategy((type, cl) => {
    let cuts = 0;
    eachMove(cl, (op, x, y, z, i, j, k, feed) => {
      if ((op === OP.LINE && feed !== FEED.RAPID) || op === OP.DRILL) cuts++;
    });
    const said = cl.notes.some((n) => n.level === 'warn');
    assert.ok(cuts > 0 || said, `${type} cut nothing and said nothing about it`);
  });
});
