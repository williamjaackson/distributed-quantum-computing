#!/usr/bin/env node
// Standalone entry for the signaling relay: its own process, its own port.
//
// All the actual behaviour lives in relay.mjs, which the visualiser's Vite
// dev/preview server also attaches directly (web/vite.config.ts) — run this
// only when the page is being served by something else.
//
// Run: node server.mjs [--port 8787]

import { WebSocketServer } from 'ws';
import { attachRoomRelay, MAX_MESSAGE_BYTES } from './relay.mjs';

const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : process.env.PORT || 8787);

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_MESSAGE_BYTES });
attachRoomRelay(wss);

console.log(`signaling server listening on ws://localhost:${PORT}`);

process.on('SIGINT', () => {
  wss.close();
  process.exit(0);
});
