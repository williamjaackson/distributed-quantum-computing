# Quantum Computing Simulation Engine

A quantum circuit state-vector simulator written in Rust, compiled to
WebAssembly, and driven from the browser.

- **[`engine/`](engine/)** — the simulator: gate kernels, measurement, reference
  circuits, WASM bindings. See [engine/README.md](engine/README.md).
- **[`web/`](web/)** — a test bench that measures how many qubits this machine
  can simulate and checks the engine against the physics.
  See [web/README.md](web/README.md).

wasm32's 4 GiB address space puts the ceiling at 27 qubits (2^27 amplitudes ×
16 bytes = 2 GiB); what a given machine actually reaches depends on how much the
browser will hand over. On the development machine the probe reached **26 qubits**
— 1 GiB of amplitudes, 67.1M complex numbers — and stopped cleanly when 2 GiB was
refused.

## Quick start

Requires a Rust toolchain with the `wasm32-unknown-unknown` target, plus
`wasm-pack` and Node.

```sh
npm run test:engine   # Rust correctness suite (29 tests)
npm run build:wasm    # build engine/pkg
npm run smoke         # verify the built artifact under Node
npm run dev           # build the engine, then serve the test bench
```

`engine/pkg` is a build artifact and is not checked in, so `build:wasm` has to
run before the web app will start.
