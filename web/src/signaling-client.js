// Thin wrapper over the signaling WebSocket. Talks the SIG protocol from
// protocol.js; knows nothing about WebRTC, gates, or shards — its only job is
// getting create-room/join-room/signal/peer-joined/peer-left messages on and
// off the wire, as plain events.

import { SIG } from './protocol.js';

export class SignalingClient extends EventTarget {
  #ws;
  #url;
  peerId = null;
  room = null;

  constructor(url) {
    super();
    this.#url = url;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(this.#url);
      this.#ws.addEventListener('open', () => resolve(), { once: true });
      this.#ws.addEventListener('error', () => reject(new Error(`could not reach signaling server at ${this.#url}`)), { once: true });
      this.#ws.addEventListener('message', (event) => this.#onMessage(event));
      this.#ws.addEventListener('close', () => this.dispatchEvent(new CustomEvent('disconnected')));
    });
  }

  #send(msg) {
    this.#ws.send(JSON.stringify(msg));
  }

  #onMessage(event) {
    const msg = JSON.parse(event.data);
    switch (msg.t) {
      case SIG.ROOM_CREATED:
        this.peerId = msg.peerId;
        this.room = msg.room;
        this.dispatchEvent(new CustomEvent('room-created', { detail: msg }));
        break;
      case SIG.JOINED:
        this.peerId = msg.peerId;
        this.dispatchEvent(new CustomEvent('joined', { detail: msg }));
        break;
      case SIG.JOIN_FAILED:
        this.dispatchEvent(new CustomEvent('join-failed', { detail: msg }));
        break;
      case SIG.PEER_JOINED:
        this.dispatchEvent(new CustomEvent('peer-joined', { detail: msg }));
        break;
      case SIG.PEER_LEFT:
        this.dispatchEvent(new CustomEvent('peer-left', { detail: msg }));
        break;
      case SIG.SIGNAL:
        this.dispatchEvent(new CustomEvent('signal', { detail: msg }));
        break;
      case SIG.ERROR:
        this.dispatchEvent(new CustomEvent('server-error', { detail: msg }));
        break;
      default:
        console.warn('signaling: unknown message type', msg.t);
    }
  }

  createRoom() {
    this.#send({ t: SIG.CREATE_ROOM });
  }

  joinRoom(room) {
    this.room = room;
    this.#send({ t: SIG.JOIN_ROOM, room });
  }

  /** Forward an opaque WebRTC signal (SDP or ICE candidate) to peer `to`. */
  sendSignal(to, data) {
    this.#send({ t: SIG.SIGNAL, to, data });
  }
}
