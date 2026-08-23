import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  globalIndex,
  mergeHistograms,
  totalShots,
  evenSplit,
  stratifiedShotAllocation,
} from '../src/shot-merge.js';

test('globalIndex matches the shard.rs split: global = (shard_id << local_qubits) | local', () => {
  assert.equal(globalIndex(0, 5, 3), 5);
  assert.equal(globalIndex(1, 5, 3), 8 + 5); // shard 1, 3 local qubits -> shift by 8
  assert.equal(globalIndex(3, 0, 4), 3 * 16);
});

test('mergeHistograms sums counts for the same index across sources', () => {
  const sources = [
    { flat: [0, 3, 1, 2] },
    { flat: [0, 1, 2, 4] },
  ];
  const merged = mergeHistograms(sources);
  assert.equal(merged.get(0), 4);
  assert.equal(merged.get(1), 2);
  assert.equal(merged.get(2), 4);
});

test('mergeHistograms remaps local shard indices to global ones via toGlobal', () => {
  const sources = [
    { flat: [0, 10], meta: { shardId: 0, localQubits: 2 } }, // global 0
    { flat: [1, 5], meta: { shardId: 1, localQubits: 2 } }, // global 4+1=5
  ];
  const merged = mergeHistograms(sources, (idx, meta) => globalIndex(meta.shardId, idx, meta.localQubits));
  assert.equal(merged.get(0), 10);
  assert.equal(merged.get(5), 5);
  assert.equal(merged.size, 2);
});

test('totalShots sums every count in a flat histogram', () => {
  assert.equal(totalShots([0, 3, 5, 7, 9, 1]), 11);
  assert.equal(totalShots([]), 0);
});

test('evenSplit distributes the remainder to the first workers', () => {
  assert.deepEqual(evenSplit(10, 3), [4, 3, 3]);
  assert.deepEqual(evenSplit(9, 3), [3, 3, 3]);
  assert.deepEqual(evenSplit(1, 4), [1, 0, 0, 0]);
  assert.equal(evenSplit(1000, 7).reduce((a, b) => a + b, 0), 1000);
});

test('stratifiedShotAllocation sums to exactly the requested total', () => {
  const masses = [0.5, 0.3, 0.2];
  const alloc = stratifiedShotAllocation(masses, 1000);
  assert.equal(alloc.reduce((a, b) => a + b, 0), 1000);
  // Roughly proportional — allow slack for the largest-remainder rounding.
  assert.ok(Math.abs(alloc[0] - 500) <= 1);
  assert.ok(Math.abs(alloc[1] - 300) <= 1);
  assert.ok(Math.abs(alloc[2] - 200) <= 1);
});

test('stratifiedShotAllocation handles masses that do not sum to exactly 1 (float drift)', () => {
  const masses = [0.49999999, 0.50000002]; // realistic post-many-gates drift
  const alloc = stratifiedShotAllocation(masses, 777);
  assert.equal(alloc.reduce((a, b) => a + b, 0), 777);
});

test('stratifiedShotAllocation with all-zero mass allocates nothing rather than dividing by zero', () => {
  const alloc = stratifiedShotAllocation([0, 0, 0], 100);
  assert.deepEqual(alloc, [0, 0, 0]);
});

test('stratifiedShotAllocation is exact for a shard holding the entire distribution', () => {
  const alloc = stratifiedShotAllocation([0, 1, 0], 500);
  assert.deepEqual(alloc, [0, 500, 0]);
});
