// Runs in a joined (non-host) browser tab. Owns exactly one engine-worker.js
// Worker and answers whatever the host asks of it: mode A treats it as a
// full independent Simulator, mode B treats it as the holder of one shard.
// See protocol.js for why there is no separate closed message vocabulary —
// every incoming command except `start-exchange` is forwarded verbatim to
// the local WorkerBridge, which is exactly the set of things
// engine-worker.js already knows how to do.
import { respondTo } from './rpc.js';
import { runExchange } from './exchange.js';
import { START_EXCHANGE } from './protocol.js';

export class PeerRuntime {
  #mesh;
  #localBridge;

  constructor({ mesh, localWorkerBridge }) {
    this.#mesh = mesh;
    this.#localBridge = localWorkerBridge;
    mesh.addEventListener('ctrl-message', (e) => this.#onCtrl(e.detail.peerId, e.detail.message));
  }

  #onCtrl(fromPeerId, message) {
    respondTo(
      (reply) => this.#mesh.sendCtrl(fromPeerId, reply),
      message,
      async (t, args) => {
        if (t === START_EXCHANGE) {
          await runExchange({
            localBridge: this.#localBridge,
            mesh: this.#mesh,
            partnerId: args.partnerId,
            base: args.base,
            params: args.params,
            localCmask: args.localCmask,
            isLow: args.isLow,
            numBlocks: args.numBlocks,
          });
          return {};
        }
        return this.#localBridge.call(t, args);
      }
    );
  }
}
