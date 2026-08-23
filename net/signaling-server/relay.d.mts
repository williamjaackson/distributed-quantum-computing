// Hand-written declarations for relay.mjs, for the one TypeScript consumer
// (web/vite.config.ts). Keep in step with relay.mjs's exports.
import type { WebSocketServer } from 'ws';

export declare const ROOM_IDLE_TIMEOUT_MS: number;
export declare const MAX_MESSAGE_BYTES: number;
export declare const MAX_PEERS_PER_ROOM: number;

export declare function attachRoomRelay(wss: WebSocketServer): {
  readonly roomCount: number;
  close(): void;
};
