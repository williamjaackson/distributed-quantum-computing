import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostOrchestrator } from '../src/host-orchestrator.js';
import { respondTo } from '../src/rpc.js';

// Exercises the orchestration logic (work-splitting, merging, fault
// recovery) with the network and the wasm engine both faked out. The engine
// itself is already covered by engine/tests/*.rs and engine/smoke*.mjs; what
// is new and unproven here is the distribution/merge/recovery logic in
// host-orchestrator.js, so that's what these tests target.

/** Records every call it receives; `behavior(cmd, args)` supplies the reply. */
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

/**
 * Minimal stand-in for PeerMesh: routes sendCtrl(peerId, msg) to that peer's
 * registered handler (itself built from the real `respondTo`, so this test
 * exercises the actual RPC reply-shaping logic, not a re-implementation of
 * it) and dispatches the reply back as a 'ctrl-message' event, exactly as a
 * real mesh would after a round trip.
 */
class FakeMesh extends EventTarget {
  #peers = new Map(); // peerId -> FakeLocalBridge simulating that peer's engine-worker
  sentCtrl = [];

  registerPeer(peerId, fakeBridge) {
    this.#peers.set(peerId, fakeBridge);
  }
  connectedPeerIds() {
    return [...this.#peers.keys()];
  }
  sendCtrl(peerId, msg) {
    this.sentCtrl.push({ peerId, msg });
    const bridge = this.#peers.get(peerId);
    if (!bridge) throw new Error(`FakeMesh: no such peer ${peerId}`);
    queueMicrotask(() => {
      respondTo(
        (reply) => this.dispatchEvent(new CustomEvent('ctrl-message', { detail: { peerId, message: reply } })),
        msg,
        (t, args) => bridge.call(t, args)
      );
    });
  }
}

function selfBridgeReturningAllShotsAtIndexZero() {
  return new FakeLocalBridge((cmd, args) => {
    if (cmd === 'sample') return { flat: [0, args.shots] };
    return {};
  });
}

test('runShotsMode splits shots evenly across host + peers and merges results', async () => {
  const mesh = new FakeMesh();
  const peerA = selfBridgeReturningAllShotsAtIndexZero();
  const peerB = selfBridgeReturningAllShotsAtIndexZero();
  mesh.registerPeer('peerA', peerA);
  mesh.registerPeer('peerB', peerB);
  const localBridge = selfBridgeReturningAllShotsAtIndexZero();

  const host = new HostOrchestrator({ mesh, localWorkerBridge: localBridge, selfId: 'host' });
  const result = await host.runShotsMode({
    circuit: [{ name: 'h', qubits: [0] }],
    nQubits: 3,
    totalShots: 100,
    baseSeed: 42,
  });

  assert.equal(result.totalShots, 100);
  assert.equal(result.participantsUsed, 3);
  assert.equal(result.shotsShortfallRecovered, 0);
  assert.equal(result.histogram.get(0), 100);

  // Every participant actually ran the circuit before sampling.
  for (const bridge of [localBridge, peerA, peerB]) {
    assert.ok(bridge.calls.some((c) => c.cmd === 'init-simulator'));
    assert.ok(bridge.calls.some((c) => c.cmd === 'apply-gate' && c.args.name === 'h'));
    assert.ok(bridge.calls.some((c) => c.cmd === 'sample'));
  }
});

test('runShotsMode gives each participant a distinct seed derived from baseSeed', async () => {
  const mesh = new FakeMesh();
  const seenSeeds = new Set();
  const makeBridge = () =>
    new FakeLocalBridge((cmd, args) => {
      if (cmd === 'init-simulator') seenSeeds.add(args.seed);
      if (cmd === 'sample') return { flat: [0, args.shots] };
      return {};
    });
  const local = makeBridge();
  mesh.registerPeer('peerA', makeBridge());
  mesh.registerPeer('peerB', makeBridge());

  const host = new HostOrchestrator({ mesh, localWorkerBridge: local, selfId: 'host' });
  await host.runShotsMode({ circuit: [], nQubits: 2, totalShots: 30, baseSeed: 1000 });

  assert.equal(seenSeeds.size, 3); // no two participants sampled with the same seed
});

test('runShotsMode recovers a disconnected peer\'s share by re-running it on the host', async () => {
  const mesh = new FakeMesh();
  const good = selfBridgeReturningAllShotsAtIndexZero();
  const flaky = new FakeLocalBridge((cmd, args) => {
    if (cmd === 'sample') throw new Error('peer disconnected mid-run');
    return {};
  });
  mesh.registerPeer('peerGood', good);
  mesh.registerPeer('peerFlaky', flaky);
  const localBridge = selfBridgeReturningAllShotsAtIndexZero();

  const host = new HostOrchestrator({ mesh, localWorkerBridge: localBridge, selfId: 'host' });
  const result = await host.runShotsMode({ circuit: [], nQubits: 2, totalShots: 90, baseSeed: 7 });

  // 90 shots / 3 participants = 30 each; the flaky peer's 30 must be
  // recovered rather than silently lost.
  assert.equal(result.totalShots, 90);
  assert.equal(result.shotsShortfallRecovered, 30);
  assert.equal(result.histogram.get(0), 90);
});

test('runShotsMode throws a clear error when there is nobody to run on', async () => {
  const mesh = new FakeMesh();
  const host = new HostOrchestrator({ mesh, localWorkerBridge: selfBridgeReturningAllShotsAtIndexZero(), selfId: 'host' });
  await assert.rejects(
    host.runShotsMode({ circuit: [], nQubits: 2, totalShots: 10, includeSelf: false }),
    /no compute participants/
  );
});

test('defaultAssignment round-robins across self and connected peers', () => {
  const mesh = new FakeMesh();
  mesh.registerPeer('peerA', selfBridgeReturningAllShotsAtIndexZero());
  mesh.registerPeer('peerB', selfBridgeReturningAllShotsAtIndexZero());
  const host = new HostOrchestrator({ mesh, localWorkerBridge: selfBridgeReturningAllShotsAtIndexZero(), selfId: 'host' });
  const assignment = host.defaultAssignment(4);
  assert.equal(assignment.length, 4);
  assert.deepEqual(assignment[0], { kind: 'self' });
  assert.equal(assignment.filter((a) => a.kind === 'self').length, 2); // wraps around after 3 pool entries
});
