# qsim web — distributed shots &amp; qubit-expansion UI

Browser-side orchestration, networking, and Worker glue that runs the
`engine/` simulator across multiple machines. See
`../docs/DISTRIBUTED_ENTANGLEMENT_PLAN.md` for the full architecture, the
wire protocol, and current limitations — this README is just the "how do I
run it" quick reference.

## Run it

1. Build the engine once, if you haven't: `cd ../engine && ./build.sh`.
2. Start the signaling server: `cd ../net/signaling-server && npm install && npm start`.
3. Serve this directory over HTTP (ES modules and Workers both need a real
   origin, not `file://`): `python3 -m http.server` (or any static file
   server) from inside `web/`.
4. Open the page in one tab, click **Create room**; open the share link it
   gives you in another tab (or another machine) to join.

## Test

```sh
npm test
```

Runs every pure-logic and integration test in `test/` under Node — no
browser needed for these (they fake the WebRTC/Worker layers; see
`test/expand-mode-integration.test.mjs`'s header comment for exactly what's
faked and what isn't). Real cross-browser and cross-machine behavior still
needs manual verification — see the plan doc's §6.2.

## Layout

| File | Role |
| --- | --- |
| `index.html`, `src/app.js` | The control page and its wiring |
| `src/signaling-client.js` | WebSocket client for the signaling protocol |
| `src/mesh.js` | Full-mesh WebRTC: connections, data channels, chunked sends |
| `src/chunker.js` | Splits/reassembles large binary transfers |
| `src/rpc.js` | Request/response correlation over a mesh ctrl channel |
| `src/worker-bridge.js` | Same, but over `postMessage` to a local Worker |
| `src/engine-worker.js` | Runs inside the Worker; owns one wasm module instance |
| `src/shard-plan-bridge.js` | Decodes/iterates the plan `engine/src/shard.rs` computes |
| `src/shot-merge.js` | Histogram merging and shot allocation |
| `src/exchange.js` | The cross-machine block-exchange lockstep (mode B) |
| `src/host-orchestrator.js` | Runs on the host tab; drives both modes |
| `src/peer-runtime.js` | Runs on a joined tab; answers the host's requests |
