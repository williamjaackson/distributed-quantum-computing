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

Or the engine on its own:

```sh
cd engine
cargo test        # correctness suite
./build.sh        # build pkg/ for the web
node smoke.mjs    # check the built artifact
```
