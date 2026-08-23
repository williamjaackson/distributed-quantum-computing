import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'server.mjs');

function startServer(port) {
  const child = spawn(process.execPath, [serverPath, '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 5000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('error', reject);
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw.toString('utf8')))));
}

// Ports spread out to dodge collisions between test files/runs in the same environment.
let portCounter = 8900;
function nextPort() {
  return portCounter++;
}

test('create-room then join-room introduces two peers to each other', async (t) => {
  const port = nextPort();
  const server = await startServer(port);
  t.after(() => server.kill());

  const host = await connect(port);
  host.send(JSON.stringify({ t: 'create-room' }));
  const created = await nextMessage(host);
  assert.equal(created.t, 'room-created');
  assert.ok(created.room);
  assert.ok(created.peerId);

  const guest = await connect(port);
  guest.send(JSON.stringify({ t: 'join-room', room: created.room }));

  const [joined, peerJoined] = await Promise.all([nextMessage(guest), nextMessage(host)]);
  assert.equal(joined.t, 'joined');
  assert.deepEqual(joined.peers, [{ peerId: created.peerId }]);
  assert.equal(peerJoined.t, 'peer-joined');
  assert.equal(peerJoined.peerId, joined.peerId);

  host.close();
  guest.close();
});

test('signal messages relay verbatim to the named peer only', async (t) => {
  const port = nextPort();
  const server = await startServer(port);
  t.after(() => server.kill());

  const host = await connect(port);
  host.send(JSON.stringify({ t: 'create-room' }));
  const created = await nextMessage(host);

  const guestA = await connect(port);
  guestA.send(JSON.stringify({ t: 'join-room', room: created.room }));
  const joinedA = await nextMessage(guestA);
  await nextMessage(host); // peer-joined for A

  const guestB = await connect(port);
  guestB.send(JSON.stringify({ t: 'join-room', room: created.room }));
  const joinedB = await nextMessage(guestB);
  await nextMessage(host); // peer-joined for B
  await nextMessage(guestA); // A also sees B join

  // Host signals only guestA; guestB must not receive anything.
  let guestBSawSomething = false;
  guestB.once('message', () => {
    guestBSawSomething = true;
  });

  host.send(JSON.stringify({ t: 'signal', to: joinedA.peerId, data: { sdp: 'fake-offer' } }));
  const received = await nextMessage(guestA);
  assert.equal(received.t, 'signal');
  assert.equal(received.from, created.peerId);
  assert.deepEqual(received.data, { sdp: 'fake-offer' });

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(guestBSawSomething, false);

  host.close();
  guestA.close();
  guestB.close();
});

test('joining a nonexistent room fails cleanly', async (t) => {
  const port = nextPort();
  const server = await startServer(port);
  t.after(() => server.kill());

  const ws = await connect(port);
  ws.send(JSON.stringify({ t: 'join-room', room: 'NOSUCHROOM' }));
  const reply = await nextMessage(ws);
  assert.equal(reply.t, 'join-failed');
  ws.close();
});

test('disconnecting broadcasts peer-left to the remaining room members', async (t) => {
  const port = nextPort();
  const server = await startServer(port);
  t.after(() => server.kill());

  const host = await connect(port);
  host.send(JSON.stringify({ t: 'create-room' }));
  const created = await nextMessage(host);

  const guest = await connect(port);
  guest.send(JSON.stringify({ t: 'join-room', room: created.room }));
  const joined = await nextMessage(guest);
  await nextMessage(host); // peer-joined

  const leftPromise = nextMessage(host);
  guest.close();
  const left = await leftPromise;
  assert.equal(left.t, 'peer-left');
  assert.equal(left.peerId, joined.peerId);

  host.close();
});

test('signaling to an unknown peer id in the same room errors instead of hanging', async (t) => {
  const port = nextPort();
  const server = await startServer(port);
  t.after(() => server.kill());

  const host = await connect(port);
  host.send(JSON.stringify({ t: 'create-room' }));
  await nextMessage(host);

  host.send(JSON.stringify({ t: 'signal', to: 'not-a-real-peer-id', data: {} }));
  const reply = await nextMessage(host);
  assert.equal(reply.t, 'error');

  host.close();
});
