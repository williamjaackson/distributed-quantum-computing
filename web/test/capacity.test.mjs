import assert from 'node:assert/strict';
import test from 'node:test';
import { shotCapacity } from '../src/net/capacity.ts';

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
