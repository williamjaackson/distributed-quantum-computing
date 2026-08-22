# Quantum Computing Simulation Engine

A quantum circuit state-vector simulator written in Rust, compiled to
WebAssembly, and driven from the browser.

- **[`engine/`](engine/)** — the simulator: gate kernels, measurement, reference
  circuits, and the WASM bindings. See [engine/README.md](engine/README.md).

wasm32's 4 GiB address space puts the ceiling at 27 qubits (2^27 amplitudes ×
16 bytes = 2 GiB); what a given machine actually reaches depends on how much
the host will hand over.

## Quick start

```sh
cd engine
cargo test        # correctness suite
./build.sh        # build pkg/ for the web
node smoke.mjs    # check the built artifact
```
