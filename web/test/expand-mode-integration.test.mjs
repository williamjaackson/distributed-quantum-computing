import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostOrchestrator } from '../src/host-orchestrator.js';
import { PeerRuntime } from '../src/peer-runtime.js';

// End-to-end integration test for mode B (qubit expansion) across two
// "machines" — the host, holding shard 0 itself, and one peer, holding
// shard 1 — using the *real* host-orchestrator.js, peer-runtime.js,
// exchange.js and rpc.js. Only two things are faked: the wasm engine (each
// side's FakeLocalBridge stands in for engine-worker.js) and the transport
// (NetworkFabric below delivers ctrl/bulk messages between two independent
// mesh objects, modelling what two separate PeerMesh instances in two
// separate browsers would do). Everything in between — planning dispatch,
// step decoding, exchange pairing, the block-exchange lockstep, sampling and
// merge — is the real, unmodified production code path.
//
// The circuit is deliberately the smallest case that forces a real
// cross-machine exchange: 1 global qubit, 0 local qubits per shard (so each
// shard's slice is a single amplitude), giving exactly one Pair step and no
// Local steps at all.

class FakeLocalBridge {
  calls = [];
  constructor(behavior) {
    this.behavior = behavior;
  }
  async call(cmd, args = {}) {
    this.calls.push({ cmd, args });
    return this.behavior(cmd, args);
  }
}

/** Delivers ctrl/bulk traffic between independent FakeNodeMesh instances, modelling separate browsers' PeerMesh objects. */
class NetworkFabric {
  #nodes = new Map();
  register(nodeId, mesh) {
    this.#nodes.set(nodeId, mesh);
  }
  deliverCtrl(toId, fromId, message) {
    queueMicrotask(() => this.#nodes.get(toId)?._receiveCtrl(fromId, message));
  }
  deliverBulk(toId, fromId, buffer) {
    queueMicrotask(() => this.#nodes.get(toId)?._receiveBulk(fromId, buffer));
  }
}

class FakeNodeMesh extends EventTarget {
  #peers = new Set();
  constructor(selfId, fabric) {
    super();
    this.selfId = selfId;
    this.fabric = fabric;
    fabric.register(selfId, this);
  }
  markConnected(peerId) {
    this.#peers.add(peerId);
  }
  connectedPeerIds() {
    return [...this.#peers];
  }
  sendCtrl(peerId, message) {
    this.fabric.deliverCtrl(peerId, this.selfId, message);
  }
  sendBulk(peerId, buffer) {
    this.fabric.deliverBulk(peerId, this.selfId, buffer);
  }
  _receiveCtrl(fromId, message) {
    this.dispatchEvent(new CustomEvent('ctrl-message', { detail: { peerId: fromId, message } }));
  }
  _receiveBulk(fromId, buffer) {
    this.dispatchEvent(new CustomEvent('bulk-message', { detail: { peerId: fromId, buffer } }));
  }
}

// Hand-derived encoding for `h` on global qubit 0 with localQubits=0,
// shardBits=1 (so qubit 0 is entirely a shard-id bit): base 'h' is index 0
// in dispatch::BASE_GATES, kind=1 (pair), globalCmask=0, targetBit=0,
// localCmask=0, no params, no local qubits — matching encode_plan's layout
// in engine/src/shard.rs exactly as shard-plan-bridge.test.mjs's helpers do.
const ENCODED_H_ON_GLOBAL_QUBIT_0 = [1, /*base*/ 0, /*kind*/ 1, /*globalCmask*/ 0, /*targetBit*/ 0, /*localCmask*/ 0, /*nParams*/ 0, /*nQubits*/ 0];
const BASE_GATES = ['h', 'x', 'y', 'z', 's', 'sdg', 't', 'tdg', 'rx', 'ry', 'rz', 'p', 'u3'];

function makeShardBehavior({ ownValue, isPlanner = false }) {
  return (cmd, args) => {
    switch (cmd) {
      case 'plan-shards':
        return { plan: [1, 0, 2, 16, 32] }; // shardBits=1, localQubits=0, shards=2
      case 'base-gates':
        return { baseGates: BASE_GATES };
      case 'plan-gate':
        return { encoded: ENCODED_H_ON_GLOBAL_QUBIT_0 };
      case 'init-shard':
        return { localQubits: 0, globalQubits: 1, sliceAmplitudes: 1, blockAmplitudes: 1, numBlocks: 1 };
      case 'read-own-block': {
        const buffer = new Float64Array([ownValue, 0]).buffer;
        return { buffer, transfer: [buffer] };
      }
      case 'apply-pair':
      case 'stage-partner-block':
        return {};
      case 'probability-mass':
        return { mass: 0.5 };
      case 'sample-local':
        return { flat: [0, args.shots] };
      default:
        if (isPlanner) throw new Error(`unexpected planner call ${cmd}`);
        return {};
    }
  };
}

test('runExpandMode exchanges real data between the host\'s own shard and a peer\'s shard', async () => {
  const fabric = new NetworkFabric();
  const hostMesh = new FakeNodeMesh('host', fabric);
  const peerMesh = new FakeNodeMesh('peerA', fabric);
  hostMesh.markConnected('peerA');
  peerMesh.markConnected('host');

  const hostBridge = new FakeLocalBridge(makeShardBehavior({ ownValue: 111, isPlanner: true }));
  const peerBridge = new FakeLocalBridge(makeShardBehavior({ ownValue: 222 }));

  const host = new HostOrchestrator({ mesh: hostMesh, localWorkerBridge: hostBridge, selfId: 'host' });
  new PeerRuntime({ mesh: peerMesh, localWorkerBridge: peerBridge }); // wires itself to peerMesh's events

  const result = await host.runExpandMode({
    circuit: [{ name: 'h', qubits: [0] }],
    globalQubits: 1,
    maxShardQubits: 0,
    assignments: [{ kind: 'self' }, { kind: 'peer', peerId: 'peerA' }],
    totalShotsToSample: 100,
    baseSeed: 5,
  });

  assert.equal(result.shardBits, 1);
  assert.equal(result.shards, 2);
  // Shard 0 (host) -> global index 0, shard 1 (peer) -> global index 1
  // (globalIndex = shardId << localQubits | local, localQubits = 0 here).
  assert.equal(result.histogram.get(0), 50);
  assert.equal(result.histogram.get(1), 50);

  // The whole point of the exchange: each side must have received the
  // *other* side's original value, not its own, and not garbage.
  const hostStaged = hostBridge.calls.find((c) => c.cmd === 'stage-partner-block');
  const peerStaged = peerBridge.calls.find((c) => c.cmd === 'stage-partner-block');
  assert.equal(new Float64Array(hostStaged.args.buffer)[0], 222);
  assert.equal(new Float64Array(peerStaged.args.buffer)[0], 111);

  // Both sides ran apply-pair with the roles Step::pairs assigns: shard 0 is
  // "low" (target bit clear), shard 1 is "high".
  const hostPair = hostBridge.calls.find((c) => c.cmd === 'apply-pair');
  const peerPair = peerBridge.calls.find((c) => c.cmd === 'apply-pair');
  assert.equal(hostPair.args.isLow, true);
  assert.equal(peerPair.args.isLow, false);

  // No local steps existed in this circuit (both qubit roles were global).
  assert.ok(!hostBridge.calls.some((c) => c.cmd === 'apply-local-base'));
  assert.ok(!peerBridge.calls.some((c) => c.cmd === 'apply-local-base'));
});

test('runExpandMode rejects a mismatched assignment count with a clear error', async () => {
  const fabric = new NetworkFabric();
  const hostMesh = new FakeNodeMesh('host', fabric);
  const host = new HostOrchestrator({
    mesh: hostMesh,
    localWorkerBridge: new FakeLocalBridge(makeShardBehavior({ ownValue: 1, isPlanner: true })),
    selfId: 'host',
  });
  await assert.rejects(
    host.runExpandMode({
      circuit: [],
      globalQubits: 1,
      maxShardQubits: 0,
      assignments: [{ kind: 'self' }], // needs 2 for a 1-global-qubit / 0-max-shard-qubit layout
      totalShotsToSample: 10,
    }),
    /needs exactly 2 shard-holding machines/
  );
});
