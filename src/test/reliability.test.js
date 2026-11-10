import { test, assert } from './runner.js';
import { UndoStack } from '../doc/undo.js';
import { WorkerPool } from '../workers/pool.js';
test('approximate comparisons reject nonfinite values', () => {
  assert.throws(() => assert.close(NaN, 1));
  assert.throws(() => assert.close(Infinity, Infinity));
  assert.throws(() => assert.close(1, 1, -1));
});
test('a failed group preserves applied edits in undo history', () => {
  const stack = new UndoStack(); let value = 0;
  assert.throws(() => stack.group('partial edit', () => {
    stack.push({ label: 'edit', do: () => { value = 1; }, undo: () => { value = 0; } });
    throw new Error('later step failed');
  }));
  assert.eq(value, 1); assert.ok(stack.canUndo); stack.undo(); assert.eq(value, 0);
});
test('dispatch failure releases the worker and the next job finishes', async () => {
  const pool = new WorkerPool(1);
  let fail = true;
  const worker = { postMessage(msg) {
    if (fail) { fail = false; throw new Error('clone failure'); }
    queueMicrotask(() => pool.onMessage(worker, { id: msg.id, ok: true, result: 42 }));
  }, terminate() {} };
  pool.all.push(worker); pool.idle.push(worker);
  const first = await pool.run('bad', {}).catch(e => e.message);
  assert.eq(first, 'clone failure'); assert.eq(pool.active.size, 0);
  assert.eq(await pool.run('good', {}), 42); pool.cancelAll();
});
