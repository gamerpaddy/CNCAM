// Tiny test runner that works in the browser (test.html) and Node (node-run.js).

const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export const assert = {
  ok(value, msg = 'expected truthy') {
    if (!value) throw new Error(msg);
  },
  eq(actual, expected, msg = '') {
    if (actual !== expected) {
      throw new Error(`${msg} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  close(actual, expected, eps = 1e-6, msg = '') {
    if (Math.abs(actual - expected) > eps) {
      throw new Error(`${msg} expected ~${expected}, got ${actual}`);
    }
  },
  throws(fn, msg = 'expected an error') {
    try { fn(); } catch { return; }
    throw new Error(msg);
  },
};

export async function run(report = console.log) {
  let passed = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      report(`PASS ${t.name}`);
    } catch (err) {
      failures.push({ name: t.name, error: err });
      report(`FAIL ${t.name}: ${err.message}`);
    }
  }
  report(`\n${passed}/${tests.length} passed`);
  return { passed, total: tests.length, failures };
}
