import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoChunks, ChunkReassembler, CHUNK_HEADER_BYTES } from '../src/chunker.js';

function randomBuffer(n, seed = 1) {
  const buf = new ArrayBuffer(n);
  const view = new Uint8Array(buf);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    view[i] = s & 0xff;
  }
  return buf;
}

test('round-trips a buffer smaller than one chunk', () => {
  const original = randomBuffer(100);
  const chunks = splitIntoChunks(1, original, 64 * 1024);
  assert.equal(chunks.length, 1);
  const reasm = new ChunkReassembler();
  const result = reasm.receive(chunks[0]);
  assert.equal(result.transferId, 1);
  assert.deepEqual(new Uint8Array(result.buffer), new Uint8Array(original));
});

test('round-trips a buffer spanning many chunks, in order', () => {
  const original = randomBuffer(64 * 1024 * 5 + 137);
  const chunks = splitIntoChunks(7, original, 64 * 1024);
  assert.equal(chunks.length, 6);
  const reasm = new ChunkReassembler();
  let result = null;
  for (const c of chunks) {
    const r = reasm.receive(c);
    if (r) result = r;
  }
  assert.ok(result);
  assert.deepEqual(new Uint8Array(result.buffer), new Uint8Array(original));
});

test('round-trips out of order (defensive, even though channels are ordered)', () => {
  const original = randomBuffer(64 * 1024 * 3 + 5);
  const chunks = splitIntoChunks(42, original, 64 * 1024);
  const shuffled = [chunks[2], chunks[0], chunks[3], chunks[1]];
  const reasm = new ChunkReassembler();
  let result = null;
  for (const c of shuffled) {
    const r = reasm.receive(c);
    if (r) result = r;
  }
  assert.ok(result);
  assert.deepEqual(new Uint8Array(result.buffer), new Uint8Array(original));
});

test('two interleaved transfers do not corrupt each other', () => {
  const a = randomBuffer(64 * 1024 * 2 + 10, 11);
  const b = randomBuffer(64 * 1024 * 3 + 3, 22);
  const chunksA = splitIntoChunks(100, a, 64 * 1024);
  const chunksB = splitIntoChunks(200, b, 64 * 1024);
  const reasm = new ChunkReassembler();
  const results = {};
  const interleaved = [chunksA[0], chunksB[0], chunksA[1], chunksB[1], chunksB[2], chunksA[2], chunksB[3]];
  for (const c of interleaved) {
    const r = reasm.receive(c);
    if (r) results[r.transferId] = r.buffer;
  }
  assert.deepEqual(new Uint8Array(results[100]), new Uint8Array(a));
  assert.deepEqual(new Uint8Array(results[200]), new Uint8Array(b));
});

test('rejects a chunk whose declared payload length does not match its actual size', () => {
  const chunk = new ArrayBuffer(CHUNK_HEADER_BYTES + 10);
  new DataView(chunk).setUint32(12, 999, true); // lies about payload length
  const reasm = new ChunkReassembler();
  assert.throws(() => reasm.receive(chunk), RangeError);
});

test('duplicate delivery of the same chunk is idempotent', () => {
  const original = randomBuffer(64 * 1024 + 1);
  const chunks = splitIntoChunks(9, original, 64 * 1024);
  const reasm = new ChunkReassembler();
  reasm.receive(chunks[0]);
  reasm.receive(chunks[0]); // duplicate — must not double-count as received
  const result = reasm.receive(chunks[1]);
  assert.ok(result);
  assert.deepEqual(new Uint8Array(result.buffer), new Uint8Array(original));
});

test('abort drops a partial transfer so it does not linger', () => {
  const original = randomBuffer(64 * 1024 * 2);
  const chunks = splitIntoChunks(5, original, 64 * 1024);
  const reasm = new ChunkReassembler();
  reasm.receive(chunks[0]);
  assert.equal(reasm.hasPending(), true);
  reasm.abort(5);
  assert.equal(reasm.hasPending(), false);
});

test('transferId must fit in a u32', () => {
  assert.throws(() => splitIntoChunks(-1, new ArrayBuffer(4)), RangeError);
  assert.throws(() => splitIntoChunks(2 ** 32, new ArrayBuffer(4)), RangeError);
});
