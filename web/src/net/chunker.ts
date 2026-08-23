/**
 * Chunking for large binary transfers over a WebRTC data channel.
 *
 * Browsers cap a single data-channel message well below what a large buffer
 * needs — the safe, portable ceiling across Chrome/Firefox/Safari is far
 * smaller than the ~256 KiB some engines advertise — so every transfer gets
 * split into fixed chunks with a small binary header and reassembled on the
 * other end.
 *
 * A header (not just channel ordering) is load-bearing here: a peer may have
 * several logical transfers in flight on the same `bulk` channel at once, so
 * chunks need enough identity to be reassembled correctly even if two
 * transfers interleave.
 */

/** Safe payload size per chunk. Well under every major browser's limit. */
export const CHUNK_PAYLOAD_BYTES = 64 * 1024;

/** Bytes in the header prefixed to every chunk: transferId, seq, total, len. */
export const CHUNK_HEADER_BYTES = 16;

/**
 * Split `buffer` (an ArrayBuffer or a view over one) into chunks, each with a
 * 16-byte header: [transferId u32][seq u32][total u32][payloadLen u32], all
 * little-endian, followed by up to CHUNK_PAYLOAD_BYTES bytes of payload.
 *
 * `transferId` must uniquely identify this transfer to the *receiver* for as
 * long as the transfer is in flight — the caller picks it (a per-peer
 * monotonically increasing counter is enough; it does not need to be globally
 * unique, only unique per sender-receiver pair at any one time).
 *
 * Returns an array of ArrayBuffers ready to hand to `RTCDataChannel.send`.
 */
export function splitIntoChunks(
  transferId: number,
  buffer: ArrayBuffer | ArrayBufferView,
  chunkPayloadBytes = CHUNK_PAYLOAD_BYTES,
): ArrayBuffer[] {
  if (!Number.isInteger(transferId) || transferId < 0 || transferId > 0xffffffff) {
    throw new RangeError(`transferId must fit in a u32, got ${transferId}`);
  }
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const total = Math.max(1, Math.ceil(bytes.byteLength / chunkPayloadBytes));
  const chunks = new Array<ArrayBuffer>(total);
  for (let seq = 0; seq < total; seq++) {
    const start = seq * chunkPayloadBytes;
    const end = Math.min(start + chunkPayloadBytes, bytes.byteLength);
    const payloadLen = end - start;
    const out = new ArrayBuffer(CHUNK_HEADER_BYTES + payloadLen);
    const view = new DataView(out);
    view.setUint32(0, transferId, true);
    view.setUint32(4, seq, true);
    view.setUint32(8, total, true);
    view.setUint32(12, payloadLen, true);
    new Uint8Array(out, CHUNK_HEADER_BYTES).set(bytes.subarray(start, end));
    chunks[seq] = out;
  }
  return chunks;
}

interface PendingTransfer {
  total: number;
  received: number;
  parts: Array<Uint8Array | undefined>;
}

/**
 * Reassembles chunks produced by `splitIntoChunks`, keyed by `transferId`, so
 * multiple transfers can interleave on one channel without corrupting each
 * other. Chunks may arrive out of order; a reliable-ordered data channel
 * guarantees they won't in practice, but the reassembler does not depend on
 * that — it is cheap to be correct either way, and it makes the class usable
 * in a plain unit test with no channel underneath it at all.
 */
export class ChunkReassembler {
  #pending = new Map<number, PendingTransfer>();

  /**
   * Feed one chunk (an ArrayBuffer as received from the data channel).
   * Returns `{ transferId, buffer }` when this chunk completes its transfer,
   * otherwise `null`.
   */
  receive(chunkArrayBuffer: ArrayBuffer): { transferId: number; buffer: ArrayBuffer } | null {
    const view = new DataView(chunkArrayBuffer);
    const transferId = view.getUint32(0, true);
    const seq = view.getUint32(4, true);
    const total = view.getUint32(8, true);
    const payloadLen = view.getUint32(12, true);
    if (chunkArrayBuffer.byteLength !== CHUNK_HEADER_BYTES + payloadLen) {
      throw new RangeError(
        `chunk ${seq}/${total} of transfer ${transferId}: header says ${payloadLen} payload bytes, got ${chunkArrayBuffer.byteLength - CHUNK_HEADER_BYTES}`,
      );
    }
    let entry = this.#pending.get(transferId);
    if (!entry) {
      entry = { total, received: 0, parts: new Array(total) };
      this.#pending.set(transferId, entry);
    }
    if (entry.total !== total) {
      throw new RangeError(`transfer ${transferId}: inconsistent total (${entry.total} then ${total})`);
    }
    if (entry.parts[seq] === undefined) {
      entry.parts[seq] = new Uint8Array(chunkArrayBuffer, CHUNK_HEADER_BYTES, payloadLen);
      entry.received++;
    }
    if (entry.received < entry.total) return null;

    this.#pending.delete(transferId);
    const parts = entry.parts as Uint8Array[];
    const totalBytes = parts.reduce((sum, p) => sum + p.byteLength, 0);
    const out = new ArrayBuffer(totalBytes);
    const outView = new Uint8Array(out);
    let offset = 0;
    for (const part of parts) {
      outView.set(part, offset);
      offset += part.byteLength;
    }
    return { transferId, buffer: out };
  }

  /** True if any transfer is only partially received (for diagnostics/timeouts). */
  hasPending(): boolean {
    return this.#pending.size > 0;
  }

  /** Drop a transfer that will never complete (e.g. its peer disconnected). */
  abort(transferId: number): void {
    this.#pending.delete(transferId);
  }
}
