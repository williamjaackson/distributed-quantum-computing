// Chunking round-trips, adapted from the distributed-entanglement branch's
// suite. Run via `npm run test:net` (node --import ./tsresolve.mjs strips the
// types from the .ts sources under test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitIntoChunks,
  ChunkReassembler,
  CHUNK_HEADER_BYTES,
  CHUNK_PAYLOAD_BYTES,
} from '../src/net/chunker.ts';

function bytes(n, offset = 0) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i + offset) & 0xff;
  return out;
}

test('a small buffer round-trips in one chunk', () => {
  const data = bytes(100);
  const chunks = splitIntoChunks(7, data);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].byteLength, CHUNK_HEADER_BYTES + 100);
  const done = new ChunkReassembler().receive(chunks[0]);
  assert.equal(done.transferId, 7);
  assert.deepEqual(new Uint8Array(done.buffer), data);
});

test('a multi-chunk buffer round-trips exactly', () => {
  const data = bytes(CHUNK_PAYLOAD_BYTES * 2 + 31);
  const chunks = splitIntoChunks(1, data);
  assert.equal(chunks.length, 3);
  const r = new ChunkReassembler();
  assert.equal(r.receive(chunks[0]), null);
  assert.equal(r.receive(chunks[1]), null);
  const done = r.receive(chunks[2]);
  assert.deepEqual(new Uint8Array(done.buffer), data);
  assert.equal(r.hasPending(), false);
});

test('an empty buffer still produces one chunk and comes back empty', () => {
  const chunks = splitIntoChunks(0, new Uint8Array(0));
  assert.equal(chunks.length, 1);
  const done = new ChunkReassembler().receive(chunks[0]);
  assert.equal(done.buffer.byteLength, 0);
});

test('chunks arriving out of order still reassemble', () => {
  const data = bytes(CHUNK_PAYLOAD_BYTES + 500);
  const [a, b] = splitIntoChunks(3, data);
  const r = new ChunkReassembler();
  assert.equal(r.receive(b), null);
  const done = r.receive(a);
  assert.deepEqual(new Uint8Array(done.buffer), data);
});

test('two transfers interleaved on one channel do not corrupt each other', () => {
  const first = bytes(CHUNK_PAYLOAD_BYTES + 10, 0);
  const second = bytes(CHUNK_PAYLOAD_BYTES + 20, 100);
  const chunksA = splitIntoChunks(1, first);
  const chunksB = splitIntoChunks(2, second);
  const r = new ChunkReassembler();
  assert.equal(r.receive(chunksA[0]), null);
  assert.equal(r.receive(chunksB[0]), null);
  const doneB = r.receive(chunksB[1]);
  const doneA = r.receive(chunksA[1]);
  assert.equal(doneA.transferId, 1);
  assert.equal(doneB.transferId, 2);
  assert.deepEqual(new Uint8Array(doneA.buffer), first);
  assert.deepEqual(new Uint8Array(doneB.buffer), second);
});

test('a duplicated chunk is ignored rather than double-counted', () => {
  const data = bytes(CHUNK_PAYLOAD_BYTES + 5);
  const [a, b] = splitIntoChunks(9, data);
  const r = new ChunkReassembler();
  assert.equal(r.receive(a), null);
  assert.equal(r.receive(a), null);
  const done = r.receive(b);
  assert.deepEqual(new Uint8Array(done.buffer), data);
});

test('a view over a larger buffer chunks only the viewed bytes', () => {
  const backing = bytes(64);
  const view = new Uint8Array(backing.buffer, 8, 16);
  const done = new ChunkReassembler().receive(splitIntoChunks(4, view)[0]);
  assert.deepEqual(new Uint8Array(done.buffer), backing.subarray(8, 24));
});

test('a chunk whose length contradicts its header throws', () => {
  const [chunk] = splitIntoChunks(1, bytes(10));
  const truncated = chunk.slice(0, chunk.byteLength - 1);
  assert.throws(() => new ChunkReassembler().receive(truncated), RangeError);
});

test('a transferId outside u32 range is rejected up front', () => {
  assert.throws(() => splitIntoChunks(-1, bytes(1)), RangeError);
  assert.throws(() => splitIntoChunks(2 ** 32, bytes(1)), RangeError);
});

test('aborting a partial transfer forgets it', () => {
  const chunks = splitIntoChunks(5, bytes(CHUNK_PAYLOAD_BYTES + 1));
  const r = new ChunkReassembler();
  r.receive(chunks[0]);
  assert.equal(r.hasPending(), true);
  r.abort(5);
  assert.equal(r.hasPending(), false);
});
