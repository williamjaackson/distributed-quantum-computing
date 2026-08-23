/**
 * Thin wrapper over the signaling WebSocket. Talks the SIG protocol from
 * protocol.ts; knows nothing about WebRTC, gates, or shots — its only job is
 * getting create-room/join-room/signal/peer-joined/peer-left messages on and
 * off the wire, as plain events.
 */
import { Emitter } from './emitter';
import { SIG } from './protocol';

export interface SignalingEvents extends Record<string, unknown> {
  'room-created': { room: string; peerId: string };
  joined: { peerId: string; peers: { peerId: string }[] };
  'join-failed': { reason: string };
  'peer-joined': { peerId: string };
  'peer-left': { peerId: string };
  signal: { from: string; data: unknown };
  'server-error': { message: string };
  disconnected: Record<string, never>;
}

export class SignalingClient extends Emitter<SignalingEvents> {
  #ws: WebSocket | null = null;
  #url: string;
  peerId: string | null = null;
  room: string | null = null;

  constructor(url: string) {
    super();
    this.#url = url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.#url);
      this.#ws = ws;
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener(
        'error',
        () => reject(new Error(`could not reach the signaling server at ${this.#url}`)),
        { once: true },
      );
      ws.addEventListener('message', (event) => this.#onMessage(event));
      ws.addEventListener('close', () => this.emit('disconnected', {}));
    });
  }

  #send(msg: Record<string, unknown>): void {
    this.#ws?.send(JSON.stringify(msg));
  }

  #onMessage(event: MessageEvent): void {
    const msg = JSON.parse(String(event.data));
    switch (msg.t) {
      case SIG.ROOM_CREATED:
        this.peerId = msg.peerId;
        this.room = msg.room;
        this.emit('room-created', msg);
        break;
      case SIG.JOINED:
        this.peerId = msg.peerId;
        this.emit('joined', msg);
        break;
      case SIG.JOIN_FAILED:
        this.emit('join-failed', msg);
        break;
      case SIG.PEER_JOINED:
        this.emit('peer-joined', msg);
        break;
      case SIG.PEER_LEFT:
        this.emit('peer-left', msg);
        break;
      case SIG.SIGNAL:
        this.emit('signal', msg);
        break;
      case SIG.ERROR:
        this.emit('server-error', msg);
        break;
      default:
        console.warn('signaling: unknown message type', msg.t);
    }
  }

  createRoom(room?: string): void {
    this.#send({ t: SIG.CREATE_ROOM, ...(room ? { room } : {}) });
  }

  joinRoom(room: string): void {
    this.room = room;
    this.#send({ t: SIG.JOIN_ROOM, room });
  }

  /** Forward an opaque WebRTC signal (SDP or ICE candidate) to peer `to`. */
  sendSignal(to: string, data: unknown): void {
    this.#send({ t: SIG.SIGNAL, to, data });
  }
}
