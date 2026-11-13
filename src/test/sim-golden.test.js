// The vertical-tool simulation is frozen: these hashes were taken before the
// tilted sweep existed. See sim-golden.js.

import { test, assert } from './runner.js';
import { goldenRuns, hashSim } from './sim-golden.js';

const GOLDEN = {
  'mushroom roughing, flat': '586a54b0',
  'mushroom raster finish, ball': 'f8ed20fb',
  // Re-frozen once, from '18d52fbc': the slot now comes in through the top of the
  // billet (toolpath.js ENTERS_AT_STOCK_TOP), so its entry ramp starts 2mm higher.
  // The simulated final surface is the same to the last cell before and after
  // (checked against the previous engine), and no rapid cuts into metal either way.
  'stepped part, facing then slot': '5e2de907',
  'pocket block, bull nose pocket': '7ba80d49',
  'hand-written ramps and a rapid crash': '2af49d0b',
};

test('the simulation of every 3-axis program is byte-identical to before 5-axis', () => {
  for (const { name, sim } of goldenRuns()) {
    assert.eq(hashSim(sim), GOLDEN[name], name);
  }
});
