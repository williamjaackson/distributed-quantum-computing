// The block-exchange protocol for one shard pair in mode B, run identically
// whether "this side" is a joined peer (peer-runtime.js) or the host itself
// (when the host contributes a shard of its own). Both sides of a pair run
// this same function concurrently, each with `isLow` set to their own role
// (see `Step::pairs` in engine/src/shard.rs — the low shard has the target
// bit clear and owns the first output row).
//
// Constraint this depends on (see docs/DISTRIBUTED_ENTANGLEMENT_PLAN.md,
// "one shard per machine"): a single worker never holds more than one shard,
// so at any moment a machine has at most one active exchange with a given
// partner, and this function's `block` counter is never ambiguous about
// which logical exchange it belongs to.
//
// Both sides run the identical lockstep: send my block b, wait for yours,
// apply the pair kernel for block b, then move to b+1. Neither side can get
// more than one block ahead of the other, which is what keeps peak memory at
// one slice plus one block on each machine — the same bound
// engine/src/shard.rs's in-module blocked exchange holds, now also holding
// across the network.
export function runExchange({ localBridge, mesh, partnerId, base, params, localCmask, isLow, numBlocks }) {
  return new Promise((resolve, reject) => {
    let block = 0;
    let settled = false;

    const onBulk = (e) => {
      if (e.detail.peerId !== partnerId || settled) return;
      handlePartnerBlock(e.detail.buffer).catch(fail);
    };
    const onDisconnect = (e) => {
      if (e.detail.peerId === partnerId) fail(new Error(`partner ${partnerId} disconnected mid-exchange`));
    };
    mesh.addEventListener('bulk-message', onBulk);
    mesh.addEventListener('peer-disconnected', onDisconnect);

    function cleanup() {
      mesh.removeEventListener('bulk-message', onBulk);
      mesh.removeEventListener('peer-disconnected', onDisconnect);
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    function succeed() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    async function sendOwnBlock(b) {
      // read-own-block copies the (still unmutated) slice before this side
      // has applied the pair kernel for block b on its own data — see the
      // ordering note in engine-worker.js's handler.
      const { buffer } = await localBridge.call('read-own-block', { block: b });
      mesh.sendBulk(partnerId, buffer);
    }

    async function handlePartnerBlock(buffer) {
      await localBridge.call('stage-partner-block', { buffer }, [buffer]);
      await localBridge.call('apply-pair', { base, params, block, isLow, localCmask });
      block++;
      if (block >= numBlocks) {
        succeed();
      } else {
        await sendOwnBlock(block);
      }
    }

    sendOwnBlock(0).catch(fail);
  });
}
