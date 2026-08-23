// Splitting shots and merging histograms — the arithmetic distributed
// measurement rests on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evenSplit,
  countsFromFlat,
  flatFromOutcomes,
  outcomesFromFlat,
} from '../src/net/shots.ts';

test('evenSplit always sums to the total and never differs by more than one', () => {
  for (const [total, n] of [
    [10, 3],
    [8192, 5],
    [65536, 7],
    [3, 5],
    [0, 4],
  ]) {
    const parts = evenSplit(total, n);
    assert.equal(parts.length, n);
    assert.equal(
      parts.reduce((a, b) => a + b, 0),
      total,
    );
    assert.ok(Math.max(...parts) - Math.min(...parts) <= 1);
  }
});

test('flat encoding round-trips preserving order', () => {
  const outcomes = [
    { index: 5, count: 100 },
    { index: 0, count: 40 },
    { index: 1023, count: 1 },
  ];
  const flat = flatFromOutcomes(outcomes);
  assert.deepEqual(flat, [5, 100, 0, 40, 1023, 1]);
  assert.deepEqual(outcomesFromFlat(flat), outcomes);
});

test('flatFromOutcomes keeps at most the cap, from the front', () => {
  const outcomes = [
    { index: 1, count: 9 },
    { index: 2, count: 5 },
    { index: 3, count: 1 },
  ];
  assert.deepEqual(flatFromOutcomes(outcomes, 2), [1, 9, 2, 5]);
});

test('countsFromFlat sums repeated indices', () => {
  const counts = countsFromFlat([4, 10, 2, 3, 4, 7]);
  assert.equal(counts.get(4), 17);
  assert.equal(counts.get(2), 3);
  assert.equal(counts.size, 2);
});
