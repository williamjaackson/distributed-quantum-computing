import assert from 'node:assert/strict';
import test from 'node:test';
import { maxDistributedQubits, planDistributedShards } from '../src/net/expand-plan.ts';

test('one machine can own several shards beyond one GiB', () => {
  const plan = planDistributedShards(27, [{ id: 'host', memoryGiB: 4 }]);
  assert.equal(plan.shards, 4);
  assert.equal(plan.localQubits, 25);
  assert.equal(plan.bytesPerShard, 512 * 1024 ** 2);
  assert.deepEqual(plan.slotsByParticipant, { host: 4 });
  assert.equal(plan.totalBytes, 2 * 1024 ** 3);
});

test('shards are spread across machines with multiple slots each', () => {
  const plan = planDistributedShards(29, [
    { id: 'host', memoryGiB: 4 },
    { id: 'viewer-a', memoryGiB: 2 },
    { id: 'viewer-b', memoryGiB: 2 },
  ]);
  assert.equal(plan.shards, 8);
  assert.equal(plan.bytesPerShard, 1024 ** 3);
  assert.deepEqual(plan.slotsByParticipant, { host: 4, 'viewer-a': 2, 'viewer-b': 2 });
  assert.deepEqual(plan.assignments.slice(0, 5).map((x) => x.participantId), [
    'host',
    'viewer-a',
    'viewer-b',
    'host',
    'viewer-a',
  ]);
});

test('planner adds shard bits when a participant cannot fit a larger slice', () => {
  const plan = planDistributedShards(26, [
    { id: 'host', memoryGiB: 0.5 },
    { id: 'viewer', memoryGiB: 0.5 },
  ]);
  assert.equal(plan.localQubits, 24);
  assert.equal(plan.shards, 4);
  assert.equal(plan.bytesPerShard, 256 * 1024 ** 2);
  assert.deepEqual(plan.slotsByParticipant, { host: 2, viewer: 2 });
});

test('insufficient contributed memory fails with required and available capacity', () => {
  assert.throws(
    () => planDistributedShards(30, [{ id: 'host', memoryGiB: 2 }]),
    /30 qubits need 16\.0 GiB.*contributes 2\.0 GiB/,
  );
});

test('every participating machine owns at least two local shards', () => {
  const plan = planDistributedShards(28, [
    { id: 'host', memoryGiB: 4 },
    { id: 'a', memoryGiB: 4 },
    { id: 'b', memoryGiB: 4 },
  ]);
  assert.ok(Object.values(plan.slotsByParticipant).every((count) => count >= 2));
});

test('room capacity includes several shards per machine', () => {
  assert.equal(maxDistributedQubits([{ id: 'host', memoryGiB: 4 }]), 28);
  assert.equal(maxDistributedQubits([
    { id: 'host', memoryGiB: 4 },
    { id: 'viewer', memoryGiB: 4 },
  ]), 29);
});
