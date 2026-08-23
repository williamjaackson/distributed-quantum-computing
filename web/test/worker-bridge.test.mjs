import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerBridge } from '../src/worker-bridge.js';

// A fake Worker: records what was posted to it, and lets the test script its
// replies (including out-of-order ones) without any real Worker/browser.
class FakeWorker {
  posted = [];
  onmessage = null;
  postMessage(data) {
    this.posted.push(data);
  }
  reply(msg) {
    this.onmessage({ data: msg });
  }
}

test('call() resolves with the matching response by id', async () => {
  const fake = new FakeWorker();
  const bridge = new WorkerBridge(fake);
  const promise = bridge.call('probability-mass', {});
  assert.equal(fake.posted.length, 1);
  assert.equal(fake.posted[0].cmd, 'probability-mass');
  fake.reply({ id: fake.posted[0].id, ok: true, result: { mass: 0.5 } });
  assert.deepEqual(await promise, { mass: 0.5 });
});

test('call() rejects when the worker reports an error', async () => {
  const fake = new FakeWorker();
  const bridge = new WorkerBridge(fake);
  const promise = bridge.call('apply-gate', { name: 'bogus' });
  fake.reply({ id: fake.posted[0].id, ok: false, error: "unknown gate 'bogus'" });
  await assert.rejects(promise, /unknown gate/);
});

test('concurrent calls resolve to their own results, not each other\'s', async () => {
  const fake = new FakeWorker();
  const bridge = new WorkerBridge(fake);
  const p1 = bridge.call('sample-local', { shots: 10 });
  const p2 = bridge.call('sample-local', { shots: 20 });
  // Reply out of order — id correlation must still route correctly.
  fake.reply({ id: fake.posted[1].id, ok: true, result: { flat: [0, 20] } });
  fake.reply({ id: fake.posted[0].id, ok: true, result: { flat: [0, 10] } });
  assert.deepEqual(await p1, { flat: [0, 10] });
  assert.deepEqual(await p2, { flat: [0, 20] });
});

test('a stale reply for an id that already resolved (or never existed) is ignored, not thrown', () => {
  const fake = new FakeWorker();
  const bridge = new WorkerBridge(fake);
  assert.doesNotThrow(() => fake.reply({ id: 999, ok: true, result: {} }));
});

test('rejectAllPending fails every outstanding call, e.g. after a worker crash', async () => {
  const fake = new FakeWorker();
  const bridge = new WorkerBridge(fake);
  const p1 = bridge.call('apply-gate', {});
  const p2 = bridge.call('apply-gate', {});
  bridge.rejectAllPending(new Error('worker crashed'));
  await assert.rejects(p1, /worker crashed/);
  await assert.rejects(p2, /worker crashed/);
});

test('a call made after rejectAllPending still gets its own promise (bridge stays usable)', async () => {
  const fake = new FakeWorker();
  const bridge = new WorkerBridge(fake);
  bridge.rejectAllPending(new Error('reset'));
  const p = bridge.call('norm', {});
  fake.reply({ id: fake.posted.at(-1).id, ok: true, result: { norm: 1 } });
  assert.deepEqual(await p, { norm: 1 });
});
