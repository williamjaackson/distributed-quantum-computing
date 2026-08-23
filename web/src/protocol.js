// Shared message vocabulary. There are two distinct layers here, and it's
// worth being precise about which one a given message belongs to:
//
// 1. Signaling (SIG below) — plain JSON over the one WebSocket each browser
//    holds open to net/signaling-server. Only ever used to introduce peers
//    to each other (relay SDP/ICE); see net/signaling-server/server.mjs.
//
// 2. Mesh RPC — once two peers have a direct WebRTC connection, the host
//    talks to whichever machine holds a shot-worker or shard role using
//    id-correlated request/response calls (rpc.js's PeerRpc / respondTo),
//    exactly mirroring worker-bridge.js's call shape but over the network
//    instead of postMessage. There is no separate closed vocabulary for
//    these calls: the `t` field is one of engine-worker.js's own command
//    names (`init-simulator`, `apply-gate`, `sample`, `init-shard`,
//    `apply-local-base`, `probability-mass`, `sample-local`, ...) — see
//    peer-runtime.js, which forwards any recognised command straight to its
//    local WorkerBridge — plus exactly one orchestration-level command that
//    engine-worker.js does *not* know about: `start-exchange` (see
//    exchange.js), because running a block exchange means driving *two*
//    things at once (the local worker and the mesh connection to a named
//    partner), not a single wasm call.
//
// Keeping the mesh RPC vocabulary open like this (rather than a second
// enum that has to be kept in sync with engine-worker.js's handlers by
// hand) means a new engine-worker.js command is automatically callable on a
// remote peer for free, and there is exactly one place — engine-worker.js's
// `handlers` object — that defines what commands exist at all.

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

// Mesh data channels. 'ctrl' carries small ordered JSON (signaling handshake
// aside, this is where every RPC call and reply travels); 'bulk' carries
// chunked binary block transfers (see chunker.js). Splitting them keeps a
// multi-megabyte block transfer from ever delaying a control message behind
// it — SCTP multiplexes data channels on one connection independently.
export const CHANNEL = Object.freeze({ CTRL: 'ctrl', BULK: 'bulk' });

// The one mesh-RPC command that is not a plain engine-worker.js pass-through
// — named here (rather than left as a bare string in host-orchestrator.js,
// exchange.js, and peer-runtime.js) so the three files agree by construction.
export const START_EXCHANGE = 'start-exchange';
