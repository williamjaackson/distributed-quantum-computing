// Runs on the host tab. Drives both modes over a PeerMesh + the host's own
// local WorkerBridge, treating "a shard/shot-worker I hold myself" and "one
// held by a connected peer" through the same `.call(cmd, args)` interface
// (LocalHandle / PeerRpc from rpc.js) wherever the underlying operation is
// something engine-worker.js understands directly. The one operation that
// is *not* a plain pass-through is `start-exchange`, because on the local
// side it means "run exchange.js in this tab" and on a remote side it means
// "ask that peer to run exchange.js in theirs" — see #startExchange.
//
// Mode B correctness note: every step barriers (waits for every participant
// to finish) before the next step starts. That gives up some pipelining
// (steps touching disjoint shard subsets could in principle overlap) in
// exchange for a synchronization story simple enough to reason about
// completely — see docs/DISTRIBUTED_ENTANGLEMENT_PLAN.md for the trade-off
// and what a pipelined version would need.
//
// Mode B fault tolerance note: unlike mode A, a shard's amplitude data lives
// on exactly one machine with no replica. If a shard-holding peer drops
// mid-circuit, that portion of the state is gone and the run cannot be
// repaired — it must be reported as failed and restarted. This class does
// not attempt to paper over that; `runExpandMode` rejects if any owner
// disconnects during the circuit.

import { LocalHandle, PeerRpc } from './rpc.js';
import { runExchange } from './exchange.js';
import { decodePlan, participantShards, exchangePairs, localStepControlsAndTarget } from './shard-plan-bridge.js';
import { evenSplit, stratifiedShotAllocation, mergeHistograms, globalIndex } from './shot-merge.js';
import { START_EXCHANGE } from './protocol.js';

export class HostOrchestrator {
  #mesh;
  #localBridge;
  #localHandle;
  #selfId;
  #rpcByPeer = new Map();
  #shardMeta = new Map(); // shard index -> init-shard result

  constructor({ mesh, localWorkerBridge, selfId }) {
    this.#mesh = mesh;
    this.#localBridge = localWorkerBridge;
    this.#localHandle = new LocalHandle(localWorkerBridge);
    this.#selfId = selfId;
  }

  #rpcFor(peerId) {
    let rpc = this.#rpcByPeer.get(peerId);
    if (!rpc) {
      rpc = new PeerRpc(this.#mesh, peerId);
      this.#rpcByPeer.set(peerId, rpc);
    }
    return rpc;
  }

  #ownerRef(assignment, index) {
    const isSelf = assignment.kind === 'self';
    return {
      isSelf,
      index,
      peerId: isSelf ? this.#selfId : assignment.peerId,
      handle: isSelf ? this.#localHandle : this.#rpcFor(assignment.peerId),
    };
  }

  /** Round-robin assignment across the host (optionally) and every connected peer. */
  defaultAssignment(count, { includeSelf = true } = {}) {
    const pool = [...(includeSelf ? [{ kind: 'self' }] : []), ...this.#mesh.connectedPeerIds().map((peerId) => ({ kind: 'peer', peerId }))];
    if (pool.length === 0) throw new Error('no compute participants available: connect at least one peer or include yourself');
    return Array.from({ length: count }, (_, i) => pool[i % pool.length]);
  }

  // -------------------------------------------------------------------------
  // Mode A: shots
  // -------------------------------------------------------------------------

  /**
   * Run `circuit` (an array of `{name, qubits, params}`) on an `nQubits`
   * register, splitting `totalShots` across every connected peer (and the
   * host itself, unless `includeSelf: false`). Every participant builds the
   * *same* state independently — no data crosses the network except the
   * circuit description going out and each histogram coming back — so this
   * is embarrassingly parallel and needs no shard layout at all.
   */
  async runShotsMode({ circuit, nQubits, totalShots, baseSeed = Date.now(), includeSelf = true }) {
    const participants = [
      ...(includeSelf ? [{ kind: 'self' }] : []),
      ...this.#mesh.connectedPeerIds().map((peerId) => ({ kind: 'peer', peerId })),
    ];
    if (participants.length === 0) {
      throw new Error('no compute participants: connect at least one peer or set includeSelf: true');
    }
    const shares = evenSplit(totalShots, participants.length);

    const runOne = async (assignment, shots, seed) => {
      const handle = assignment.kind === 'self' ? this.#localHandle : this.#rpcFor(assignment.peerId);
      await handle.call('init-simulator', { nQubits, seed });
      for (const gate of circuit) await handle.call('apply-gate', gate);
      const { flat } = await handle.call('sample', { shots, seed });
      return flat;
    };

    const jobs = participants.map((p, i) => ({ assignment: p, shots: shares[i], seed: baseSeed + i }));
    const outcomes = await Promise.all(
      jobs.map(async (job) => {
        if (job.shots === 0) return { ok: true, flat: [] };
        try {
          return { ok: true, flat: await runOne(job.assignment, job.shots, job.seed) };
        } catch (err) {
          return { ok: false, job, err };
        }
      })
    );

    const sources = [];
    let shotsShortfallRecovered = 0;
    for (const o of outcomes) {
      if (o.ok) sources.push({ flat: o.flat });
      else shotsShortfallRecovered += o.job.shots;
    }
    if (shotsShortfallRecovered > 0) {
      // Whoever dropped is gone; the host is always available, so the
      // simplest correct recovery is redoing the lost share itself rather
      // than a more elaborate reassignment scheme (a documented future
      // optimization — see docs/DISTRIBUTED_ENTANGLEMENT_PLAN.md).
      const flat = await runOne({ kind: 'self' }, shotsShortfallRecovered, baseSeed ^ 0x9e3779b9);
      sources.push({ flat });
    }

    const histogram = mergeHistograms(sources);
    return {
      histogram,
      totalShots: [...histogram.values()].reduce((a, b) => a + b, 0),
      participantsUsed: participants.length,
      shotsShortfallRecovered,
    };
  }

  // -------------------------------------------------------------------------
  // Mode B: qubit expansion
  // -------------------------------------------------------------------------

  /**
   * Run `circuit` sharded across `assignments.length` machines (one shard
   * each — see the file-level "one shard per machine" note), covering
   * `globalQubits` total. `assignments[i]` is `{kind:'self'}` or
   * `{kind:'peer', peerId}` for shard index `i`; use `defaultAssignment` for
   * a round-robin default. Afterward draws `totalShotsToSample` samples,
   * stratified across shards by probability mass (see
   * `stratifiedShotAllocation` in shot-merge.js) so no shard's full local
   * distribution ever needs to be gathered to the host.
   */
  async runExpandMode({ circuit, globalQubits, maxShardQubits, assignments, totalShotsToSample, baseSeed = Date.now() }) {
    const { plan } = await this.#localHandle.call('plan-shards', { globalQubits, maxShardQubits, minShardBits: 0 });
    const [shardBits, localQubits, shards] = plan;
    if (assignments.length !== shards) {
      throw new Error(
        `${globalQubits} qubits at max ${maxShardQubits} per shard needs exactly ${shards} shard-holding machines; got ${assignments.length} assignments`
      );
    }
    const owners = assignments.map((a, i) => this.#ownerRef(a, i));

    const disconnected = new Set();
    const onDisconnect = (e) => disconnected.add(e.detail.peerId);
    this.#mesh.addEventListener('peer-disconnected', onDisconnect);
    const assertAllConnected = () => {
      for (const o of owners) {
        if (!o.isSelf && disconnected.has(o.peerId)) {
          throw new Error(
            `shard ${o.index}'s holder (${o.peerId}) disconnected mid-run; its amplitude data is unrecoverable — the run must be restarted from scratch`
          );
        }
      }
    };

    try {
      const initResults = await Promise.all(owners.map((o) => o.handle.call('init-shard', { localQubits, shardBits, index: o.index })));
      initResults.forEach((r, i) => this.#shardMeta.set(i, r));
      assertAllConnected();

      const { baseGates } = await this.#localHandle.call('base-gates', {});

      for (const gate of circuit) {
        const { encoded } = await this.#localHandle.call('plan-gate', {
          name: gate.name,
          qubits: gate.qubits,
          params: gate.params ?? [],
          localQubits,
          shardBits,
        });
        const steps = decodePlan(Float64Array.from(encoded), baseGates);

        for (const step of steps) {
          assertAllConnected();
          if (step.kind === 'local') {
            const { controls, target } = localStepControlsAndTarget(step);
            const participants = participantShards(step, shards);
            await Promise.all(
              participants.map((w) => owners[w].handle.call('apply-local-base', { base: step.base, params: step.params, controls, target }))
            );
          } else {
            const pairs = exchangePairs(step, shards);
            await Promise.all(
              pairs.flatMap(([low, high]) => [
                this.#startExchange(owners[low], { partnerId: owners[high].peerId, base: step.base, params: step.params, localCmask: step.localCmask, isLow: true }),
                this.#startExchange(owners[high], { partnerId: owners[low].peerId, base: step.base, params: step.params, localCmask: step.localCmask, isLow: false }),
              ])
            );
          }
          assertAllConnected();
        }
      }

      const masses = await Promise.all(owners.map((o) => o.handle.call('probability-mass', {}).then((r) => r.mass)));
      const allocation = stratifiedShotAllocation(masses, totalShotsToSample);
      const sources = await Promise.all(
        owners.map(async (o, i) => {
          if (allocation[i] === 0) return { flat: [], meta: { shardId: i, localQubits } };
          const { flat } = await o.handle.call('sample-local', { shots: allocation[i], seed: baseSeed + i });
          return { flat, meta: { shardId: i, localQubits } };
        })
      );
      const histogram = mergeHistograms(sources, (idx, meta) => globalIndex(meta.shardId, idx, meta.localQubits));

      return { histogram, shardBits, localQubits, shards, masses };
    } finally {
      this.#mesh.removeEventListener('peer-disconnected', onDisconnect);
    }
  }

  #startExchange(owner, args) {
    const meta = this.#shardMeta.get(owner.index);
    if (owner.isSelf) {
      return runExchange({ localBridge: this.#localBridge, mesh: this.#mesh, numBlocks: meta.numBlocks, ...args });
    }
    return owner.handle.call(START_EXCHANGE, { ...args, numBlocks: meta.numBlocks });
  }
}
