/**
 * The message vocabulary for shared sessions, in its three distinct layers:
 *
 * 1. **Signaling** (`SIG`) — plain JSON over the one WebSocket each browser
 *    holds open to the room relay (net/signaling-server/relay.mjs, which the
 *    Vite dev/preview server also serves at `/ws`). Only ever used to
 *    introduce peers to each other by relaying SDP offers and ICE candidates;
 *    it never carries circuit or shot data.
 *
 * 2. **Mesh RPC** — once two peers hold a direct WebRTC connection, the host
 *    issues id-correlated request/response calls over the `ctrl` channel
 *    (rpc.ts). There is exactly one request in the vocabulary, `WORK_SHOTS`:
 *    "take this many shots of this program and send back the histogram".
 *
 * 3. **Session notifies** — fire-and-forget host→viewer messages (no `id`)
 *    that mirror the host's UI state: what is running (`state`), where the
 *    playhead is (`playhead`), which view is up (`view`), and what the merged
 *    measurement came to (`result`). A viewer needs nothing else: the engine
 *    is deterministic, so from `SharedState` alone it reproduces the host's
 *    entire timeline locally, frames and all.
 */
import type { InputValues, Measurement } from '../lib/types';

export const SIG = Object.freeze({
  CREATE_ROOM: 'create-room', // client -> server: {t}
  ROOM_CREATED: 'room-created', // server -> client: {t, room, peerId}
  JOIN_ROOM: 'join-room', // client -> server: {t, room}
  JOINED: 'joined', // server -> client: {t, peerId, peers: [{peerId}]}
  JOIN_FAILED: 'join-failed', // server -> client: {t, reason}
  PEER_JOINED: 'peer-joined', // server -> existing clients: {t, peerId}
  PEER_LEFT: 'peer-left', // server -> remaining clients: {t, peerId}
  SIGNAL: 'signal', // client -> server -> the named peer: {t, to, from, data}
  ERROR: 'error', // server -> client: {t, message}
});

/**
 * Mesh data channels. `ctrl` carries small ordered JSON — every RPC call,
 * reply, and session notify. `bulk` carries chunked binary (chunker.ts);
 * nothing uses it yet, but the mesh keeps it open so a future state-sharding
 * mode can move amplitude blocks without renegotiating connections.
 */
export const CHANNEL = Object.freeze({ CTRL: 'ctrl', BULK: 'bulk' });

/** The one mesh-RPC request: take shots on the host's behalf. */
export const WORK_SHOTS = 'shots';

/** Everything a run is a pure function of. Sending this *is* sending the run. */
export interface SharedState {
  programId: string;
  values: InputValues;
  shots: number;
  seed: number;
  measureAtEnd: boolean;
}

export type BestShot = { index: number; score: number; count: number; rank: number } | null;

/**
 * The host's merged measurement, broadcast after a run completes.
 *
 * A viewer reproduces the circuit exactly but cannot reproduce a histogram
 * several machines took together, so the host shares the merged outcome —
 * keyed by `runKey` so a result is only ever applied to the run it came from.
 * Outcomes travel as a flat `[index, count, ...]` array, largest count first.
 */
export interface SharedResult {
  key: string;
  flat: number[];
  measurement: Measurement;
  bestShot: BestShot;
}

/** What `WORK_SHOTS` asks of a helping machine. */
export interface WorkRequest {
  programId: string;
  values: InputValues;
  shots: number;
  seed: number;
}

/** What a helping machine sends back: a flat histogram and the honest count. */
export interface WorkReply {
  flat: number[];
  taken: number;
}

/**
 * Identity of one run, for pairing a `SharedResult` with the `SharedState`
 * that produced it. Key order in `values` is not guaranteed anywhere, so the
 * keys are sorted rather than trusting `JSON.stringify`.
 */
export function runKey(s: SharedState): string {
  const values = Object.keys(s.values)
    .sort()
    .map((k) => `${k}=${String(s.values[k])}`)
    .join(',');
  return `${s.programId}|${values}|${s.shots}|${s.seed}|${s.measureAtEnd ? 1 : 0}`;
}
