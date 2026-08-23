// Request/response correlation over a PeerMesh 'ctrl' channel, the network
// analogue of worker-bridge.js's id-correlated calls. The host uses this to
// issue owner instructions ("apply this local step", "sample your shard")
// and get a reply once the peer (or the host's own local worker, via the
// same interface — see LocalHandle below) has actually done the work; a
// `call()` is free to take as long as it needs (a block exchange can run for
// seconds) before its promise resolves.
//
// Every RPC message carries `{id, t, ...args}`; the receiving side (see
// peer-runtime.js) replies with `{id, ok, result}` or `{id, ok:false,
// error}`. A message with no `id` — e.g. a fire-and-forget notification — is
// handed to `onNotify` instead of treated as a reply.

export class PeerRpc {
  #mesh;
  #peerId;
  #nextId = 1;
  #pending = new Map();
  onNotify = null;

  constructor(mesh, peerId) {
    this.#mesh = mesh;
    this.#peerId = peerId;
    mesh.addEventListener('ctrl-message', (e) => this.#onCtrlMessage(e));
  }

  #onCtrlMessage(e) {
    if (e.detail.peerId !== this.#peerId) return;
    const { id, ok, result, error, ...rest } = e.detail.message;
    if (id === undefined) {
      this.onNotify?.(e.detail.message);
      return;
    }
    const pending = this.#pending.get(id);
    if (!pending) return; // reply to a call we've stopped waiting on
    this.#pending.delete(id);
    if (ok) pending.resolve(result ?? rest);
    else pending.reject(new Error(error));
  }

  call(t, args = {}) {
    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#mesh.sendCtrl(this.#peerId, { id, t, ...args });
    return promise;
  }

  rejectAllPending(reason) {
    for (const { reject } of this.#pending.values()) reject(reason instanceof Error ? reason : new Error(String(reason)));
    this.#pending.clear();
  }
}

/**
 * Reply to an RPC request received on the *answering* side (peer-runtime.js,
 * or the host answering its own loopback calls). `handler(t, args)` may
 * return a value synchronously or a Promise; whatever it throws becomes an
 * `{ok:false, error}` reply instead of an uncaught rejection.
 */
export async function respondTo(sendReply, message, handler) {
  const { id, t, ...args } = message;
  if (id === undefined) return; // not an RPC call, nothing to reply to
  try {
    const result = await handler(t, args);
    sendReply({ id, ok: true, result: result ?? {} });
  } catch (err) {
    sendReply({ id, ok: false, error: err?.message ?? String(err) });
  }
}

/**
 * A PeerRpc-shaped wrapper around the host's own local WorkerBridge, so the
 * orchestrator can address "the shard I hold myself" with exactly the same
 * `.call(cmd, args)` interface as a remote peer. No network involved — this
 * just forwards to the local worker and wraps its promise.
 */
export class LocalHandle {
  #bridge;
  constructor(workerBridge) {
    this.#bridge = workerBridge;
  }
  call(cmd, args = {}) {
    return this.#bridge.call(cmd, args);
  }
}
