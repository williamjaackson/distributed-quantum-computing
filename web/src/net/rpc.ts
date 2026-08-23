/**
 * Request/response correlation over a mesh `ctrl` channel.
 *
 * The host uses this to issue work ("take this share of the shots") and get a
 * reply once the peer has actually done it; a `call()` is free to take as
 * long as it needs before its promise resolves — there are no timeouts here,
 * only rejection when the peer is known to be gone (`rejectAllPending`, wired
 * to the mesh's `peer-disconnected` by the session layer).
 *
 * Every RPC message carries `{id, t, ...args}`; the answering side replies
 * with `{id, ok:true, result}` or `{id, ok:false, error}`. A message with no
 * `id` is a fire-and-forget notify and is not this class's business — the
 * session layer reads those straight off the mesh.
 */
import type { CtrlMessage, PeerMesh } from './mesh';

/** The mesh surface PeerRpc actually needs — narrow, so tests can fake it. */
export interface RpcTransport {
  on(type: 'ctrl-message', fn: (detail: { peerId: string; message: CtrlMessage }) => void): () => void;
  sendCtrl(peerId: string, message: CtrlMessage): void;
}

export class PeerRpc {
  #transport: RpcTransport;
  #peerId: string;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(transport: RpcTransport | PeerMesh, peerId: string) {
    this.#transport = transport;
    this.#peerId = peerId;
    this.#transport.on('ctrl-message', (detail) => this.#onCtrlMessage(detail));
  }

  #onCtrlMessage({ peerId, message }: { peerId: string; message: CtrlMessage }): void {
    if (peerId !== this.#peerId) return;
    const { id, ok, result, error } = message as {
      id?: number;
      ok?: boolean;
      result?: unknown;
      error?: string;
    };
    if (id === undefined || ok === undefined) return; // a notify or a request, not a reply
    const pending = this.#pending.get(id);
    if (!pending) return; // reply to a call we've stopped waiting on
    this.#pending.delete(id);
    if (ok) pending.resolve(result);
    else pending.reject(new Error(error));
  }

  call<T>(t: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = this.#nextId++;
    const promise = new Promise<T>((resolve, reject) =>
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject }),
    );
    this.#transport.sendCtrl(this.#peerId, { id, t, ...args });
    return promise;
  }

  rejectAllPending(reason: unknown): void {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }
}

/**
 * Reply to an RPC request received on the *answering* side. `handler(t,
 * args)` may return a value synchronously or a Promise; whatever it throws
 * becomes an `{ok:false, error}` reply instead of an uncaught rejection.
 */
export async function respondTo(
  sendReply: (reply: CtrlMessage) => void,
  message: CtrlMessage,
  handler: (t: string, args: Record<string, unknown>) => unknown,
): Promise<void> {
  const { id, t, ...args } = message;
  if (id === undefined || t === undefined) return; // not an RPC call, nothing to reply to
  try {
    const result = await handler(t, args);
    sendReply({ id, ok: true, result: result ?? {} });
  } catch (err) {
    sendReply({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
