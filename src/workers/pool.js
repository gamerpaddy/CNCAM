// Worker pool for toolpath/simulation jobs. Jobs run in job-worker.js.
// const pool = new WorkerPool(); pool.run('ping', {value: 1}, {onProgress})
//
// Starting a worker is expensive and the cost is invisible, which is a bad
// combination. Each one loads and compiles the whole engine module graph on its
// own: measured here, a *trivial* job on a cold worker takes 2.1 seconds and 5
// milliseconds on a warm one. Generating a ten-operation program therefore
// spent nineteen seconds, of which about one was arithmetic — the pool spawned
// ten workers at once and they fought each other to compile the same code.
//
// Two things follow. The pool is capped well below the core count, because past
// a handful of workers each extra one costs a full compile and buys a slice of
// a job that runs in milliseconds. And it is warmed at boot, so the compiling
// happens while the user is importing a model instead of while they are waiting
// for a toolpath.

/**
 * More than this many workers has never paid for itself: a program is five to
 * fifteen operations, most of them milliseconds of work, and each extra worker
 * is another full compile of the engine.
 */
const MAX_WORKERS = 6;

export class WorkerPool {
  constructor(size = defaultSize()) {
    this.size = size;
    this.idle = [];
    this.all = [];
    this.queue = [];
    this.active = new Map();   // id -> { resolve, reject, onProgress, worker }
    this.nextId = 1;
    this.warming = null;
  }

  spawn() {
    const worker = new Worker(new URL('./job-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => this.onMessage(worker, e.data);
    worker.onerror = (e) => this.onWorkerError(worker, e);
    this.all.push(worker);
    return worker;
  }

  /**
   * Start the workers and make them compile their modules, now, in the
   * background. Idempotent, and safe to ignore — the returned promise is only
   * there for anything that wants to wait for a warm pool.
   */
  warm() {
    this.warming ??= Promise.all(
      Array.from({ length: this.size }, () => this.run('ping', { value: 0 })),
    ).then(() => true, () => false);
    return this.warming;
  }

  run(job, args, { transfer = [], onProgress = null } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const task = { id, job, args, transfer, resolve, reject, onProgress };
      const worker = this.idle.pop() ?? (this.all.length < this.size ? this.spawn() : null);
      if (worker) this.dispatch(worker, task);
      else this.queue.push(task);
    });
  }

  dispatch(worker, task) {
    this.active.set(task.id, { ...task, worker });
    worker.postMessage({ id: task.id, job: task.job, args: task.args }, task.transfer);
  }

  onMessage(worker, msg) {
    const entry = this.active.get(msg.id);
    if (!entry) return;
    if (msg.progress !== undefined) {
      entry.onProgress?.(msg.progress);
      return;
    }
    this.active.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error));
    const next = this.queue.shift();
    if (next) this.dispatch(worker, next);
    else this.idle.push(worker);
  }

  onWorkerError(worker, e) {
    for (const [id, entry] of this.active) {
      if (entry.worker === worker) {
        entry.reject(new Error(e.message || 'worker crashed'));
        this.active.delete(id);
      }
    }
    const i = this.idle.indexOf(worker);
    if (i >= 0) this.idle.splice(i, 1);
    const j = this.all.indexOf(worker);
    if (j >= 0) this.all.splice(j, 1);
    worker.terminate();
  }

  /** Cooperative cancel: worker checks between slices. */
  cancel(id) {
    const entry = this.active.get(id);
    entry?.worker.postMessage({ cancel: id });
  }

  terminate() {
    for (const w of this.all) w.terminate();
    this.all.length = 0;
    this.idle.length = 0;
    this.warming = null;
  }
}

function defaultSize() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}
