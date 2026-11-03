// The vertical-tool simulation is frozen: these hashes were taken before the
// tilted sweep existed. See sim-golden.js.

import { test, assert } from './runner.js';
import { goldenRuns, hashSim } from './sim-golden.js';

const GOLDEN = {
  'mushroom roughing, flat': '586a54b0',
  'mushroom raster finish, ball': 'f8ed20fb',
  'stepped part, facing then slot': '18d52fbc',
  'pocket block, bull nose pocket': '7ba80d49',
  'hand-written ramps and a rapid crash': '2af49d0b',
};

test('the simulation of every 3-axis program is byte-identical to before 5-axis', () => {
  for (const { name, sim } of goldenRuns()) {
    assert.eq(hashSim(sim), GOLDEN[name], name);
  }
});
