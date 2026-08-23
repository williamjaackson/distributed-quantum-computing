import assert from 'node:assert/strict';
import test from 'node:test';
import { expandCapacity, shotCapacity } from '../src/net/capacity.ts';

test('shot capacity includes the host and divides every requested shot', () => {
  assert.deepEqual(shotCapacity(8192, 1), {
    machines: 2,
    smallestShare: 4096,
    largestShare: 4096,
  });
  assert.deepEqual(shotCapacity(10, 2), {
    machines: 3,
    smallestShare: 3,
    largestShare: 4,
  });
});

test('expand capacity uses the largest power-of-two group', () => {
  assert.deepEqual(expandCapacity(3, 26), {
    machines: 3,
    usableShards: 2,
    maxQubits: 27,
    bytesPerShard: 2 ** 26 * 16,
    totalBytes: 2 ** 27 * 16,
  });
  assert.equal(expandCapacity(4, 26).maxQubits, 28);
});
