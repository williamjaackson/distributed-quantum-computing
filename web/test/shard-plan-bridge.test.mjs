import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodePlan,
  participantShards,
  exchangePairs,
  localStepControlsAndTarget,
} from '../src/shard-plan-bridge.js';

// Base gate table matching engine/src/dispatch.rs's BASE_GATES, for building
// synthetic encoded plans in tests without needing the real wasm module.
const BASE = ['h', 'x', 'y', 'z', 's', 'sdg', 't', 'tdg', 'rx', 'ry', 'rz', 'p', 'u3'];

function encodeLocalStep({ base, globalCmask = 0, params = [], qubits }) {
  return [BASE.indexOf(base), 0, globalCmask, -1, 0, params.length, ...params, qubits.length, ...qubits];
}

function encodePairStep({ base, globalCmask = 0, targetBit, localCmask = 0, params = [] }) {
  return [BASE.indexOf(base), 1, globalCmask, targetBit, localCmask, params.length, ...params, 0];
}

test('decodePlan reads a single local step', () => {
  const encoded = [1, ...encodeLocalStep({ base: 'h', qubits: [3] })];
  const steps = decodePlan(new Float64Array(encoded), BASE);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0], {
    base: 'h', kind: 'local', globalCmask: 0, targetBit: -1, localCmask: 0, params: [], qubits: [3],
  });
});

test('decodePlan reads a local step with controls and a parameterised gate', () => {
  const encoded = [1, ...encodeLocalStep({ base: 'rz', params: [1.25], qubits: [0, 1, 2] })];
  const steps = decodePlan(new Float64Array(encoded), BASE);
  const { controls, target } = localStepControlsAndTarget(steps[0]);
  assert.deepEqual(controls, [0, 1]);
  assert.equal(target, 2);
  assert.deepEqual(steps[0].params, [1.25]);
});

test('decodePlan reads a pair step and multiple steps in sequence', () => {
  const encoded = [
    2,
    ...encodeLocalStep({ base: 'x', qubits: [0] }),
    ...encodePairStep({ base: 'h', targetBit: 1, localCmask: 0b10 }),
  ];
  const steps = decodePlan(new Float64Array(encoded), BASE);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].kind, 'local');
  assert.equal(steps[1].kind, 'pair');
  assert.equal(steps[1].targetBit, 1);
  assert.equal(steps[1].localCmask, 0b10);
});

test('localStepControlsAndTarget rejects a pair step', () => {
  const step = { kind: 'pair' };
  assert.throws(() => localStepControlsAndTarget(step), TypeError);
});

// --- participantShards / exchangePairs: hand-verified against the bit-math
// documented in engine/src/shard.rs (global = shard_id << local | local;
// Step::shards / Step::pairs). These are the same semantics
// engine/smoke-sharded.mjs exercises end to end against the whole-state
// Simulator — here we just check the JS-side arithmetic matches by hand for
// small, enumerable cases.

test('participantShards with no control mask includes every shard', () => {
  const step = { globalCmask: 0 };
  assert.deepEqual(participantShards(step, 8), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('participantShards with a control mask keeps only shards with those bits set', () => {
  // globalCmask = 0b010 (bit 1 of the shard id must be 1): shards 2,3,6,7 of 8.
  const step = { globalCmask: 0b010 };
  assert.deepEqual(participantShards(step, 8), [2, 3, 6, 7]);
});

test('exchangePairs on target bit 0 pairs adjacent shards', () => {
  const step = { kind: 'pair', globalCmask: 0, targetBit: 0 };
  assert.deepEqual(exchangePairs(step, 4), [[0, 1], [2, 3]]);
});

test('exchangePairs on target bit 1 pairs shards two apart', () => {
  const step = { kind: 'pair', globalCmask: 0, targetBit: 1 };
  assert.deepEqual(exchangePairs(step, 4), [[0, 2], [1, 3]]);
});

test('exchangePairs restricted by a global control mask only pairs qualifying shards', () => {
  // 3 global qubits (8 shards): target bit 0, control on bit 2 (mask 0b100).
  // Only shards with bit 2 set participate: 4,5,6,7 -> pairs (4,5) and (6,7).
  const step = { kind: 'pair', globalCmask: 0b100, targetBit: 0 };
  assert.deepEqual(exchangePairs(step, 8), [[4, 5], [6, 7]]);
});

test('exchangePairs throws on a local step', () => {
  assert.throws(() => exchangePairs({ kind: 'local' }, 4), TypeError);
});
