/**
 * Full-mesh WebRTC networking: every peer in the room opens a direct
 * RTCPeerConnection to every other peer, introduced by the signaling server
 * but never routing data through it afterwards.
 *
 * Each connection carries two data channels (see protocol.ts's CHANNEL):
 * `ctrl` for small ordered JSON control messages, `bulk` for chunked binary
 * transfers. Both are reliable and ordered (WebRTC data channels default to
 * this) — an unreliable channel would need an app-level retransmission
 * scheme, and correctness matters far more here than shaving a few
 * milliseconds off a control message.
 *
 * Glare avoidance: when both sides of a pair are ready to connect, only one
 * may create the offer. Rather than the general "perfect negotiation" dance,
 * this uses a simple deterministic rule: the peer with the lexicographically
 * smaller id always offers. That is sufficient because renegotiation never
 * happens here — the pair's data channels are fixed at creation and never
 * renegotiated mid-run.
 */
import { Emitter } from './emitter';
import { CHANNEL } from './protocol';
import { splitIntoChunks, ChunkReassembler } from './chunker';
import type { SignalingClient } from './signaling-client';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** Loose shape of anything travelling the ctrl channel. */
export type CtrlMessage = { id?: number; t?: string } & Record<string, unknown>;

export interface MeshEvents extends Record<string, unknown> {
  'peer-connected': { peerId: string };
  'peer-disconnected': { peerId: string; error: Error | null };
  'peer-error': { peerId: string; error: unknown };
  'ctrl-message': { peerId: string; message: CtrlMessage };
  'bulk-message': { peerId: string; transferId: number; buffer: ArrayBuffer };
}

export class PeerMesh extends Emitter<MeshEvents> {
  #signaling: SignalingClient;
  #selfId: string;
  #iceServers: RTCIceServer[];
  #connections = new Map<string, RTCPeerConnection>();
  #ctrlChannels = new Map<string, RTCDataChannel>();
  #bulkChannels = new Map<string, RTCDataChannel>();
  #reassemblers = new Map<string, ChunkReassembler>();
  #transferCounters = new Map<string, number>();
  #readyResolvers = new Map<string, { resolve: () => void; promise: Promise<void> }>();

  /**
   * @param signaling a connected SignalingClient
   * @param selfId this browser's own peer id (from signaling.peerId)
   * @param iceServers defaults to a public STUN server, which is enough on
   *   most home/office networks. Peers behind restrictive NATs (many
   *   corporate networks, some mobile carriers) will need a TURN server added
   *   here — see docs/DISTRIBUTED_ENTANGLEMENT_PLAN.md.
   */
  constructor(signaling: SignalingClient, selfId: string, iceServers = DEFAULT_ICE_SERVERS) {
    super();
    this.#signaling = signaling;
    this.#selfId = selfId;
    this.#iceServers = iceServers;
    signaling.on('signal', (detail) => void this.#onSignal(detail));
  }

  /** Begin connecting to `peerId`. Safe to call from either side of a pair. */
  connectTo(peerId: string): void {
    if (this.#connections.has(peerId)) return;
    const pc = this.#makeConnection(peerId);
    const shouldOffer = this.#selfId < peerId;
    if (shouldOffer) {
      const ctrl = pc.createDataChannel(CHANNEL.CTRL, { ordered: true });
      const bulk = pc.createDataChannel(CHANNEL.BULK, { ordered: true });
      this.#wireChannel(peerId, CHANNEL.CTRL, ctrl);
      this.#wireChannel(peerId, CHANNEL.BULK, bulk);
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => this.#signaling.sendSignal(peerId, { kind: 'sdp', sdp: pc.localDescription }))
        .catch((err: unknown) => this.#fail(peerId, err));
    }
    // If we are not the offerer, we wait for an incoming offer in #onSignal
    // and attach 'datachannel' listeners there instead.
  }

  #makeConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.#iceServers });
    this.#connections.set(peerId, pc);
    this.#transferCounters.set(peerId, 0);
    this.#reassemblers.set(peerId, new ChunkReassembler());
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    this.#readyResolvers.set(peerId, { resolve: resolveReady, promise: readyPromise });

    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) this.#signaling.sendSignal(peerId, { kind: 'ice', candidate: e.candidate });
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.#teardown(peerId, new Error(`connection to ${peerId} ${pc.connectionState}`));
      }
    });
    pc.addEventListener('datachannel', (e) => {
      this.#wireChannel(peerId, e.channel.label, e.channel);
    });
    return pc;
  }

  #wireChannel(peerId: string, label: string, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    if (label === CHANNEL.CTRL) {
      this.#ctrlChannels.set(peerId, channel);
      channel.addEventListener('message', (e) => {
        this.emit('ctrl-message', { peerId, message: JSON.parse(String(e.data)) });
      });
    } else if (label === CHANNEL.BULK) {
      this.#bulkChannels.set(peerId, channel);
      channel.addEventListener('message', (e) => {
        const complete = this.#reassemblers.get(peerId)?.receive(e.data as ArrayBuffer);
        if (complete) {
          this.emit('bulk-message', { peerId, transferId: complete.transferId, buffer: complete.buffer });
        }
      });
    }
    channel.addEventListener('open', () => this.#maybeReady(peerId));
  }

  #maybeReady(peerId: string): void {
    const ctrl = this.#ctrlChannels.get(peerId);
    const bulk = this.#bulkChannels.get(peerId);
    if (ctrl?.readyState === 'open' && bulk?.readyState === 'open') {
      this.#readyResolvers.get(peerId)?.resolve();
      this.emit('peer-connected', { peerId });
    }
  }

  async #onSignal({ from, data }: { from: string; data: unknown }): Promise<void> {
    const signal = data as
      | { kind: 'sdp'; sdp: RTCSessionDescriptionInit }
      | { kind: 'ice'; candidate: RTCIceCandidateInit };
    let pc = this.#connections.get(from);
    if (!pc) pc = this.#makeConnection(from); // incoming connection we didn't initiate

    try {
      if (signal.kind === 'sdp') {
        await pc.setRemoteDescription(signal.sdp);
        if (signal.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.#signaling.sendSignal(from, { kind: 'sdp', sdp: pc.localDescription });
        }
      } else if (signal.kind === 'ice') {
        await pc.addIceCandidate(signal.candidate);
      }
    } catch (err) {
      this.#fail(from, err);
    }
  }

  #fail(peerId: string, error: unknown): void {
    this.emit('peer-error', { peerId, error });
  }

  #teardown(peerId: string, error: Error | null): void {
    this.#connections.get(peerId)?.close();
    this.#connections.delete(peerId);
    this.#ctrlChannels.delete(peerId);
    this.#bulkChannels.delete(peerId);
    this.#reassemblers.delete(peerId);
    this.#readyResolvers.delete(peerId);
    this.emit('peer-disconnected', { peerId, error });
  }

  /** Resolves once both data channels to `peerId` are open. */
  waitUntilReady(peerId: string): Promise<void> {
    const entry = this.#readyResolvers.get(peerId);
    if (!entry) return Promise.reject(new Error(`not connecting to ${peerId}`));
    return entry.promise;
  }

  /** Send a small JSON control message to one peer. */
  sendCtrl(peerId: string, message: CtrlMessage): void {
    const ch = this.#ctrlChannels.get(peerId);
    if (!ch || ch.readyState !== 'open') throw new Error(`no open ctrl channel to ${peerId}`);
    ch.send(JSON.stringify(message));
  }

  /**
   * Send a large binary buffer to `peerId`, chunked (see chunker.ts).
   * Returns the transferId assigned, purely for logging/diagnostics — the
   * receiver does not need it back.
   */
  sendBulk(peerId: string, buffer: ArrayBuffer | ArrayBufferView): number {
    const ch = this.#bulkChannels.get(peerId);
    if (!ch || ch.readyState !== 'open') throw new Error(`no open bulk channel to ${peerId}`);
    const transferId = this.#transferCounters.get(peerId) ?? 0;
    this.#transferCounters.set(peerId, (transferId + 1) & 0xffffffff);
    for (const chunk of splitIntoChunks(transferId, buffer)) ch.send(chunk);
    return transferId;
  }

  connectedPeerIds(): string[] {
    return [...this.#ctrlChannels.keys()].filter(
      (id) => this.#ctrlChannels.get(id)?.readyState === 'open',
    );
  }

  closeAll(): void {
    for (const peerId of [...this.#connections.keys()]) this.#teardown(peerId, null);
  }
}
