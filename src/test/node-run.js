// Headless test run for CI:  node src/test/node-run.js
import { run } from './all.js';

const { failures } = await run();
process.exit(failures.length > 0 ? 1 : 0);
