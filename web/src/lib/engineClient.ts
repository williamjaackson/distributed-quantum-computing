import type { Progress, Request, RequestBody, Response } from './protocol';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: Progress) => void;
};

/**
 * Promise-based RPC over the simulation worker.
 *
 * The worker processes messages serially, so a running probe blocks anything
 * queued behind it — deliberate, since concurrent multi-gigabyte allocations
 * would fight each other for the same WASM heap.
 */
export class EngineClient {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL('../worker/qsim.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.addEventListener('message', (e: MessageEvent<Response>) => {
      const msg = e.data;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      if (msg.type === 'progress') {
        entry.onProgress?.(msg.progress);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === 'ok') entry.resolve(msg.data);
      else entry.reject(new Error(msg.error));
    });
    this.worker.addEventListener('error', (e) => {
      // A worker-level failure (module load, OOM abort) never resolves the
      // in-flight request, so fail everything rather than hang the UI.
      const err = new Error(e.message || 'simulation worker failed');
      for (const [, entry] of this.pending) entry.reject(err);
      this.pending.clear();
    });
  }

  private send<T>(req: RequestBody, onProgress?: (p: Progress) => void): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage({ ...req, id } as Request);
    });
  }

  call<T>(req: RequestBody, onProgress?: (p: Progress) => void): Promise<T> {
    return this.send<T>(req, onProgress);
  }

  terminate() {
    this.worker.terminate();
  }
}
