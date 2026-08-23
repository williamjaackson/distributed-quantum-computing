// Main-thread-side request/response wrapper around a Worker running
// engine-worker.js. Turns `worker.postMessage({cmd, ...})` /
// `worker.onmessage` into `await bridge.call(cmd, args)`, correlating
// requests and responses by an incrementing id so concurrent in-flight calls
// (e.g. kicking off several peers' local steps without waiting for each one)
// never get each other's results crossed.
//
// Takes a `workerLike` object (anything with `postMessage` and an assignable
// `onmessage`) rather than constructing a `Worker` itself, so this class can
// be unit-tested against a plain in-memory fake with no browser present —
// see web/test/worker-bridge.test.mjs.
export class WorkerBridge {
  #worker;
  #nextId = 1;
  #pending = new Map(); // id -> {resolve, reject}

  constructor(workerLike) {
    this.#worker = workerLike;
    workerLike.onmessage = (event) => this.#onMessage(event.data);
  }

  #onMessage({ id, ok, result, error }) {
    const pending = this.#pending.get(id);
    if (!pending) return; // stale reply after e.g. a timeout gave up on it
    this.#pending.delete(id);
    if (ok) pending.resolve(result);
    else pending.reject(new Error(error));
  }

  /** Send `{cmd, ...args}` and resolve with the worker's `result` payload. */
  call(cmd, args = {}, transfer = []) {
    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#worker.postMessage({ id, cmd, ...args }, transfer);
    return promise;
  }

  /** Reject every call still waiting on a reply (e.g. the worker crashed). */
  rejectAllPending(reason) {
    for (const { reject } of this.#pending.values()) reject(reason instanceof Error ? reason : new Error(String(reason)));
    this.#pending.clear();
  }

  terminate() {
    this.rejectAllPending(new Error('worker terminated'));
    this.#worker.terminate?.();
  }
}
