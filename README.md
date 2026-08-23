# Quantum Computing Simulation Engine

A quantum circuit state-vector simulator written in Rust, compiled to
WebAssembly, and driven from the browser.

- **[`engine/`](engine/)** — the simulator: gate kernels, measurement, reference
  circuits, sharded execution, and the WASM bindings. See
  [engine/README.md](engine/README.md).
- **[`web/`](web/)** — a step-through visualiser: pick a program, feed it
  inputs, and watch the register from six different angles, one gate at a time.
  See [web/README.md](web/README.md).

wasm32's 4 GiB address space puts the ceiling at 27 qubits (2^27 amplitudes ×
16 bytes = 2 GiB), and a single Rust allocation is capped at 2 GiB, so one
module holds 26; sharding across worker-owned modules makes the limit the
machine's memory instead.

## Quick start

```sh
npm run dev     # build the WASM package, then serve the visualiser
npm test        # engine suite, built-artifact smoke tests, typecheck, programs
```

## Shared sessions

Choose **Share this session** in the visualiser and send the generated `?j=CODE`
link to another browser. Viewers follow the host's program, view and playhead in
read-only mode. When the host measures, the shot count is divided across the
host and connected viewers; their histograms are merged and the same result is
shown everywhere.

The Vite development and preview servers include the WebSocket signaling relay
at `/ws`, so normal local and LAN sharing needs only the one web-server process.
Vite listens on the LAN; open the generated link on another machine connected
to the same network. WebRTC carries session and shot data directly between
browsers. A standalone relay remains available with `npm run signal` for other
hosting arrangements.

Room codes are capabilities: anyone with a code can join and receive shot work.
The current implementation uses STUN without TURN, so restrictive networks may
prevent peers from connecting even when the web page itself is reachable.

Or the engine on its own:

```sh
cd engine
cargo test        # correctness suite
./build.sh        # build pkg/ for the web
node smoke.mjs    # check the built artifact
```
