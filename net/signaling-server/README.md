# qsim signaling server

Introduces browsers to each other so they can open direct WebRTC
connections; relays nothing else. See
`../../docs/DISTRIBUTED_ENTANGLEMENT_PLAN.md` §2.1 for why this exists and
what it does and doesn't see, and `server.mjs`'s header comment for the
exact message protocol.

```sh
npm install
npm start            # ws://localhost:8787 by default
npm start -- --port 9000
npm test             # spins up real server processes + real WebSocket clients
```
