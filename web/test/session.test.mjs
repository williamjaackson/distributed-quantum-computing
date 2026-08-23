// The host↔viewer conversation, end to end over an in-memory fabric: room
// creation, joining, state/playhead/result mirroring (including replay to a
// late joiner), work requests and their failure modes. Everything the real
// stack does except WebSockets and RTCPeerConnections, which the fabric fakes
// with the same event vocabulary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../src/net/emitter.ts';
import { Session } from '../src/net/session.ts';

/** Flush the microtask relays a few times over. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function makeHub() {
  const hub = {
    meshes: new Map(), // peerId -> FakeMesh
    rooms: new Map(), // code -> Map<peerId, FakeSignaling>
    wanted: [], // [a, b] pairs asked to connect
    connected: new Set(), // 'a|b' with a < b
    n: 0,
    link(a, b) {
      hub.wanted.push([a, b]);
      hub.flush();
    },
    flush() {
      for (const [a, b] of hub.wanted) {
        const key = [a, b].sort().join('|');
        if (hub.connected.has(key)) continue;
        const ma = hub.meshes.get(a);
        const mb = hub.meshes.get(b);
        if (!ma || !mb) continue;
        hub.connected.add(key);
        queueMicrotask(() => {
          ma.emit('peer-connected', { peerId: b });
          mb.emit('peer-connected', { peerId: a });
        });
      }
    },
    disconnect(a, b) {
      hub.connected.delete([a, b].sort().join('|'));
      hub.wanted = hub.wanted.filter(([x, y]) => !(x === a && y === b) && !(x === b && y === a));
      queueMicrotask(() => {
        hub.meshes.get(a)?.emit('peer-disconnected', { peerId: b, error: null });
        hub.meshes.get(b)?.emit('peer-disconnected', { peerId: a, error: null });
      });
    },
  };
  return hub;
}

class FakeSignaling extends Emitter {
  constructor(hub) {
    super();
    this.hub = hub;
    this.peerId = null;
    this.room = null;
  }
  async connect() {}
  createRoom() {
    this.peerId = `peer-${String(++this.hub.n).padStart(3, '0')}`;
    this.room = `ROOM${this.hub.n}`;
    this.hub.rooms.set(this.room, new Map([[this.peerId, this]]));
    queueMicrotask(() => this.emit('room-created', { room: this.room, peerId: this.peerId }));
  }
  joinRoom(room) {
    const members = this.hub.rooms.get(room);
    if (!members) {
      queueMicrotask(() => this.emit('join-failed', { reason: 'no such room' }));
      return;
    }
    this.peerId = `peer-${String(++this.hub.n).padStart(3, '0')}`;
    this.room = room;
    const existing = [...members.keys()].map((peerId) => ({ peerId }));
    members.set(this.peerId, this);
    queueMicrotask(() => {
      this.emit('joined', { peerId: this.peerId, peers: existing });
      for (const [id, sig] of members) {
        if (id !== this.peerId) sig.emit('peer-joined', { peerId: this.peerId });
      }
    });
  }
  sendSignal() {}
}

class FakeMesh extends Emitter {
  constructor(hub, selfId) {
    super();
    this.hub = hub;
    this.selfId = selfId;
    hub.meshes.set(selfId, this);
    hub.flush();
  }
  connectTo(peerId) {
    this.hub.link(this.selfId, peerId);
  }
  sendCtrl(peerId, message) {
    const key = [this.selfId, peerId].sort().join('|');
    if (!this.hub.connected.has(key)) throw new Error(`no open ctrl channel to ${peerId}`);
    const other = this.hub.meshes.get(peerId);
    // Serialise like the real channel would, so nothing non-JSON sneaks by.
    const copy = JSON.parse(JSON.stringify(message));
    queueMicrotask(() => other.emit('ctrl-message', { peerId: this.selfId, message: copy }));
  }
}

function pair(hub) {
  return {
    transport: {
      signaling: () => new FakeSignaling(hub),
      mesh: (_signaling, selfId) => new FakeMesh(hub, selfId),
    },
    signalUrl: 'fake:',
  };
}

const STATE = { programId: 'ghz', values: { qubits: 5 }, shots: 8192, seed: 42, measureAtEnd: false };

async function hostAndViewer(hub) {
  const host = new Session(pair(hub));
  await host.share();
  const viewer = new Session(pair(hub));
  await viewer.join(host.room);
  await settle();
  return { host, viewer };
}

test('sharing creates a room and a ?j= link', async () => {
  const host = new Session(pair(makeHub()));
  await host.share();
  assert.equal(host.role, 'host');
  assert.ok(host.room);
  assert.ok(host.link.includes(`?j=${host.room}`));
});

test('a viewer mirrors state, view and playhead — including what predates its join', async () => {
  const hub = makeHub();
  const host = new Session(pair(hub));
  await host.share();
  // Broadcast *before* anyone is connected: a late joiner must still get it.
  const key = host.broadcastState(STATE);
  host.broadcastView('state');
  host.broadcastPlayhead(3);

  const viewer = new Session(pair(hub));
  await viewer.join(host.room);
  await settle();

  assert.equal(viewer.role, 'viewer');
  assert.deepEqual(viewer.shared, STATE);
  assert.equal(viewer.sharedKey, key);
  assert.equal(viewer.view, 'state');
  assert.equal(viewer.playhead, 3);
  assert.equal(host.workers(), 1);

  host.broadcastPlayhead(7);
  await settle();
  assert.equal(viewer.playhead, 7);
});

test('a work request runs on the viewer and its histogram comes back', async () => {
  const { host, viewer } = await hostAndViewer(makeHub());
  const seen = [];
  viewer.setWorker(async (req, work) => {
    seen.push(req);
    work.onStep(3);
    work.onShot(10, req.shots);
    assert.equal(work.cancelled(), false);
    return { flat: [0, req.shots - 1, 3, 1], taken: req.shots };
  });

  const reply = await host.runShots(0, { programId: 'ghz', values: {}, shots: 100, seed: 7 });
  assert.deepEqual(reply, { flat: [0, 99, 3, 1], taken: 100 });
  assert.deepEqual(seen, [{ programId: 'ghz', values: {}, shots: 100, seed: 7 }]);
  assert.equal(viewer.contributed, 100);
  assert.equal(viewer.working, null); // cleared once done
});

test('a worker that throws rejects the host call with its message', async () => {
  const { host, viewer } = await hostAndViewer(makeHub());
  viewer.setWorker(async () => {
    throw new Error('no engine ready');
  });
  await assert.rejects(
    host.runShots(0, { programId: 'x', values: {}, shots: 10, seed: 1 }),
    /no engine ready/,
  );
});

test('a broadcast result reaches the viewer keyed to its run', async () => {
  const { host, viewer } = await hostAndViewer(makeHub());
  const key = host.broadcastState(STATE);
  host.broadcastResult(
    key,
    [
      { index: 2, count: 5 },
      { index: 0, count: 3 },
    ],
    { requested: 8, taken: 8, method: 'sampled' },
    { index: 2, score: 0, count: 5, rank: 1 },
  );
  await settle();
  assert.equal(viewer.result.key, key);
  assert.deepEqual(viewer.result.flat, [2, 5, 0, 3]);
  assert.deepEqual(viewer.result.bestShot, { index: 2, score: 0, count: 5, rank: 1 });
});

test('a newer work request supersedes the one still running', async () => {
  const { host, viewer } = await hostAndViewer(makeHub());
  let firstCancelled = null;
  viewer.setWorker(async (req, work) => {
    if (req.seed === 1) {
      await settle(); // stay "running" while the second request lands
      firstCancelled = work.cancelled();
      return { flat: [], taken: 0 };
    }
    return { flat: [0, req.shots], taken: req.shots };
  });
  const first = host.runShots(0, { programId: 'x', values: {}, shots: 10, seed: 1 });
  const second = host.runShots(0, { programId: 'x', values: {}, shots: 20, seed: 2 });
  await Promise.all([first, second]);
  assert.equal(firstCancelled, true);
});

test('a disconnect rejects in-flight work and drops the helper count', async () => {
  const hub = makeHub();
  const { host, viewer } = await hostAndViewer(hub);
  viewer.setWorker(() => new Promise(() => {})); // never finishes
  const inFlight = host.runShots(0, { programId: 'x', values: {}, shots: 10, seed: 1 });
  const [hostMeshId, viewerMeshId] = [...hub.meshes.keys()];
  hub.disconnect(hostMeshId, viewerMeshId);
  await assert.rejects(inFlight, /disconnected/);
  assert.equal(host.workers(), 0);
  await settle();
  assert.equal(viewer.hostLost, true);
});

test('joining a room that does not exist reports the failure', async () => {
  const viewer = new Session(pair(makeHub()));
  await viewer.join('NOPE');
  assert.match(viewer.error, /no such room/);
});
