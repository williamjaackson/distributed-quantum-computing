#!/usr/bin/env node
// Minimal WebRTC signaling relay.
//
// This server never touches simulation data, circuit definitions, or block
// exchanges — none of that is meaningful to it. Its only job is introducing
// browsers to each other: relaying SDP offers/answers and ICE candidates by
// opaque peer id inside a room, so the browsers can open direct WebRTC data
// channels and do the rest themselves. Once every peer pair has connected,
// this server could go offline and a run in progress would keep working —
// though a peer that joins *after* that point would have no way to be
// introduced to the room. Losing the signaling server never corrupts a
// simulation in progress; it only prevents new peers from joining.
//
// Run: node server.mjs [--port 8787]
//
// Protocol (JSON frames over one WebSocket per browser) — see
// web/src/protocol.js's SIG constants for the shared vocabulary:
//   -> {t:'create-room'}
//   <- {t:'room-created', room, peerId}
//   -> {t:'join-room', room}
//   <- {t:'joined', peerId, peers:[{peerId}, ...]}   (existing peers in the room)
//   <- {t:'peer-joined', peerId}                      (sent to everyone already in the room)
//   -> {t:'signal', to, data}                         (data is opaque: an SDP blob or ICE candidate)
//   <- {t:'signal', from, data}                       (relayed verbatim to the named peer)
//   <- {t:'peer-left', peerId}                        (sent when a peer disconnects)
//
// Room codes are short and unambiguous (no 0/O/1/I/l), so they're easy to
// read aloud or type in by hand when sharing a room with someone else's
// machine.

import { WebSocketServer } from 'ws';
import { randomBytes, randomUUID } from 'node:crypto';

const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : process.env.PORT || 8787);
const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const ROOM_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // rooms with no traffic this long are dropped
const MAX_MESSAGE_BYTES = 64 * 1024; // signaling payloads (SDP/ICE) are small; this is generous headroom
const MAX_PEERS_PER_ROOM = 256; // matches shard.rs's realistic ceiling with headroom, not a hard protocol limit

function makeRoomCode() {
  const bytes = randomBytes(6);
  let code = '';
  for (const b of bytes) code += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
  return code;
}

/** @type {Map<string, { peers: Map<string, import('ws').WebSocket>, lastActivity: number }>} */
const rooms = new Map();

function touch(room) {
  room.lastActivity = Date.now();
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcastToRoom(room, message, exceptPeerId = null) {
  for (const [peerId, ws] of room.peers) {
    if (peerId !== exceptPeerId) send(ws, message);
  }
}

function removePeerFromRoom(roomCode, peerId) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.peers.delete(peerId);
  if (room.peers.size === 0) {
    rooms.delete(roomCode);
  } else {
    touch(room);
    broadcastToRoom(room, { t: 'peer-left', peerId });
  }
}

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws) => {
  let joinedRoom = null; // room code this socket has joined, if any
  let peerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return send(ws, { t: 'error', message: 'malformed JSON' });
    }

    switch (msg.t) {
      case 'create-room': {
        let code;
        do {
          code = makeRoomCode();
        } while (rooms.has(code));
        peerId = randomUUID();
        rooms.set(code, { peers: new Map([[peerId, ws]]), lastActivity: Date.now() });
        joinedRoom = code;
        send(ws, { t: 'room-created', room: code, peerId });
        break;
      }

      case 'join-room': {
        const room = rooms.get(msg.room);
        if (!room) {
          send(ws, { t: 'join-failed', reason: 'no such room' });
          return;
        }
        if (room.peers.size >= MAX_PEERS_PER_ROOM) {
          send(ws, { t: 'join-failed', reason: 'room is full' });
          return;
        }
        peerId = randomUUID();
        const existingPeers = [...room.peers.keys()].map((id) => ({ peerId: id }));
        room.peers.set(peerId, ws);
        joinedRoom = msg.room;
        touch(room);
        send(ws, { t: 'joined', peerId, peers: existingPeers });
        broadcastToRoom(room, { t: 'peer-joined', peerId }, peerId);
        break;
      }

      case 'signal': {
        if (!joinedRoom || !peerId) {
          send(ws, { t: 'error', message: 'join a room before signaling' });
          return;
        }
        const room = rooms.get(joinedRoom);
        const target = room?.peers.get(msg.to);
        if (!target) {
          send(ws, { t: 'error', message: `peer ${msg.to} is not in this room` });
          return;
        }
        touch(room);
        send(target, { t: 'signal', from: peerId, data: msg.data });
        break;
      }

      default:
        send(ws, { t: 'error', message: `unknown message type '${msg.t}'` });
    }
  });

  ws.on('close', () => {
    if (joinedRoom && peerId) removePeerFromRoom(joinedRoom, peerId);
  });

  ws.on('error', () => {
    if (joinedRoom && peerId) removePeerFromRoom(joinedRoom, peerId);
  });
});

// Sweep idle rooms periodically so an abandoned room (e.g. every peer's tab
// crashed instead of closing cleanly) doesn't sit in memory forever.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_IDLE_TIMEOUT_MS) {
      broadcastToRoom(room, { t: 'error', message: 'room expired from inactivity' });
      for (const ws of room.peers.values()) ws.close();
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);
sweep.unref();

console.log(`signaling server listening on ws://localhost:${PORT}`);

process.on('SIGINT', () => {
  wss.close();
  process.exit(0);
});
