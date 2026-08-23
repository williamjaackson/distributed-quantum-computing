// Full-mesh WebRTC networking: every peer in the room opens a direct
// RTCPeerConnection to every other peer, introduced by the signaling server
// but never routing data through it afterwards.
//
// Full mesh (rather than a star through the host) is the deliberate choice
// for mode B: a global gate's block exchange happens between the two peers
// that own the affected shards, whoever they are — not necessarily the host.
// Routing that through the host would double its bandwidth use and make it
// the bottleneck for every run; direct peer-to-peer keeps each exchange's
// cost on just the two machines actually involved. Mode A does not need the
// mesh at all beyond host<->each peer, but reusing one mesh implementation
// for both modes keeps there being only one piece of networking code to get
// right.
//
// Each connection carries two data channels (see protocol.js's CHANNEL):
// 'ctrl' for small ordered JSON control messages, 'bulk' for chunked binary
// block transfers. Both are reliable and ordered (WebRTC data channels
// default to this) — an unreliable channel would need an app-level
// retransmission scheme for exchange blocks, and correctness matters far
// more here than shaving a few milliseconds off a control message.
//
// Glare avoidance: when both sides of a pair are ready to connect, only one
// may create the offer. Rather than the general "perfect negotiation"
// dance, this uses a simple deterministic rule: the peer with the
// lexicographically smaller id always offers. That is sufficient because
// renegotiation never happens here — the pair's data channels are fixed at
// creation and never renegotiated mid-run.

import { CHANNEL } from './protocol.js';
import { splitIntoChunks, ChunkReassembler } from './chunker.js';

const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export class PeerMesh extends EventTarget {
  #signaling;
  #selfId;
  #iceServers;
  #connections = new Map(); // peerId -> RTCPeerConnection
  #ctrlChannels = new Map(); // peerId -> RTCDataChannel
  #bulkChannels = new Map(); // peerId -> RTCDataChannel
  #reassemblers = new Map(); // peerId -> ChunkReassembler
  #transferCounters = new Map(); // peerId -> number, for outgoing transferId allocation
  #readyResolvers = new Map(); // peerId -> {resolve, promise}

  /**
   * @param signaling a connected SignalingClient
   * @param selfId this browser's own peer id (from signaling.peerId)
   * @param iceServers optional RTCIceServer[]; defaults to a public STUN
   *   server, which is enough on most home/office networks. Peers behind
   *   restrictive NATs (many corporate networks, some mobile carriers) will
   *   need a TURN server added here — see docs/DISTRIBUTED_ENTANGLEMENT_PLAN.md.
   */
  constructor(signaling, selfId, iceServers = DEFAULT_ICE_SERVERS) {
    super();
    this.#signaling = signaling;
    this.#selfId = selfId;
    this.#iceServers = iceServers;
    signaling.addEventListener('signal', (e) => this.#onSignal(e.detail));
  }

  /** Begin connecting to `peerId`. Safe to call from either side of a pair. */
  connectTo(peerId) {
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
        .catch((err) => this.#fail(peerId, err));
    }
    // If we are not the offerer, we wait for an incoming offer in #onSignal
    // and attach 'datachannel' listeners there instead.
  }

  #makeConnection(peerId) {
    const pc = new RTCPeerConnection({ iceServers: this.#iceServers });
    this.#connections.set(peerId, pc);
    this.#transferCounters.set(peerId, 0);
    this.#reassemblers.set(peerId, new ChunkReassembler());
    let resolveReady;
    const readyPromise = new Promise((resolve) => {
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

  #wireChannel(peerId, label, channel) {
    channel.binaryType = 'arraybuffer';
    if (label === CHANNEL.CTRL) {
      this.#ctrlChannels.set(peerId, channel);
      channel.addEventListener('message', (e) => {
        this.dispatchEvent(new CustomEvent('ctrl-message', { detail: { peerId, message: JSON.parse(e.data) } }));
      });
    } else if (label === CHANNEL.BULK) {
      this.#bulkChannels.set(peerId, channel);
      channel.addEventListener('message', (e) => {
        const complete = this.#reassemblers.get(peerId).receive(e.data);
        if (complete) {
          this.dispatchEvent(new CustomEvent('bulk-message', { detail: { peerId, transferId: complete.transferId, buffer: complete.buffer } }));
        }
      });
    }
    channel.addEventListener('open', () => this.#maybeReady(peerId));
  }

  #maybeReady(peerId) {
    const ctrl = this.#ctrlChannels.get(peerId);
    const bulk = this.#bulkChannels.get(peerId);
    if (ctrl?.readyState === 'open' && bulk?.readyState === 'open') {
      this.#readyResolvers.get(peerId)?.resolve();
      this.dispatchEvent(new CustomEvent('peer-connected', { detail: { peerId } }));
    }
  }

  async #onSignal({ from, data }) {
    let pc = this.#connections.get(from);
    if (!pc) pc = this.#makeConnection(from); // incoming connection we didn't initiate

    try {
      if (data.kind === 'sdp') {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.#signaling.sendSignal(from, { kind: 'sdp', sdp: pc.localDescription });
        }
      } else if (data.kind === 'ice') {
        await pc.addIceCandidate(data.candidate);
      }
    } catch (err) {
      this.#fail(from, err);
    }
  }

  #fail(peerId, err) {
    this.dispatchEvent(new CustomEvent('peer-error', { detail: { peerId, error: err } }));
  }

  #teardown(peerId, err) {
    this.#connections.get(peerId)?.close();
    this.#connections.delete(peerId);
    this.#ctrlChannels.delete(peerId);
    this.#bulkChannels.delete(peerId);
    this.#reassemblers.delete(peerId);
    this.#readyResolvers.delete(peerId);
    this.dispatchEvent(new CustomEvent('peer-disconnected', { detail: { peerId, error: err } }));
  }

  /** Resolves once both data channels to `peerId` are open. */
  waitUntilReady(peerId) {
    const entry = this.#readyResolvers.get(peerId);
    if (!entry) return Promise.reject(new Error(`not connecting to ${peerId}`));
    return entry.promise;
  }

  /** Send a small JSON control message to one peer. */
  sendCtrl(peerId, message) {
    const ch = this.#ctrlChannels.get(peerId);
    if (!ch || ch.readyState !== 'open') throw new Error(`no open ctrl channel to ${peerId}`);
    ch.send(JSON.stringify(message));
  }

  /** Broadcast a small JSON control message to every connected peer. */
  broadcastCtrl(message, peerIds = [...this.#ctrlChannels.keys()]) {
    for (const peerId of peerIds) this.sendCtrl(peerId, message);
  }

  /**
   * Send a large binary buffer to `peerId`, chunked (see chunker.js).
   * Returns the transferId assigned, purely for logging/diagnostics — the
   * receiver does not need it back.
   */
  sendBulk(peerId, arrayBufferOrView) {
    const ch = this.#bulkChannels.get(peerId);
    if (!ch || ch.readyState !== 'open') throw new Error(`no open bulk channel to ${peerId}`);
    const transferId = this.#transferCounters.get(peerId);
    this.#transferCounters.set(peerId, (transferId + 1) & 0xffffffff);
    for (const chunk of splitIntoChunks(transferId, arrayBufferOrView)) ch.send(chunk);
    return transferId;
  }

  connectedPeerIds() {
    return [...this.#ctrlChannels.keys()].filter((id) => this.#ctrlChannels.get(id)?.readyState === 'open');
  }

  closeAll() {
    for (const peerId of [...this.#connections.keys()]) this.#teardown(peerId, null);
  }
}
