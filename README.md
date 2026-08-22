# Quantum Computing Simulation Engine

A quantum circuit state-vector simulator written in Rust, compiled to
WebAssembly, and driven from the browser.

- **[`engine/`](engine/)** — the simulator: gate kernels, measurement, reference
  circuits, WASM bindings. See [engine/README.md](engine/README.md).
- **[`web/`](web/)** — a test bench that measures how many qubits this machine
  can simulate and checks the engine against the physics.
  See [web/README.md](web/README.md).

## How large a register fits

Two software limits bind before RAM does:

| Limit | Value | Consequence |
| ----- | ----- | ----------- |
| Single Rust allocation (`isize::MAX`, 32-bit) | 2 GiB | one `Vec` holds <= **26 qubits** |
| One wasm32 module's address space | 4 GiB | one module holds <= 27 qubits |

27 qubits needs exactly 2^31 bytes — one byte over `isize::MAX` — so it is
refused instantly, without the heap even growing. A JS `ArrayBuffer` tops out at
the same ~2 GiB, so no JS-side buffer escapes it either.

Sharding does. Separate WASM module instances get separate address spaces, so K
workers hold K times as much and capacity becomes bounded only by RAM. On the
development machine (16 GiB, M4):

| Approach | Reached | Memory |
| -------- | ------- | ------ |
| One module | 26 qubits | 1 GiB |
| 8 workers, 1 GiB slices | **29 qubits** | 8 GiB |

30 qubits needs 16 GiB and kills the tab, so 29 is the practical ceiling here.
Past ~27 the binding constraint stops being memory and becomes DRAM bandwidth:
each added qubit doubles the work per gate, and at 29 a single gate takes about a
second.

## Quick start

Requires a Rust toolchain with the `wasm32-unknown-unknown` target, plus
`wasm-pack` and Node.

```sh
npm run test:engine   # Rust correctness suite (43 tests)
npm run build:wasm    # build engine/pkg
npm run smoke         # verify the built artifacts under Node
npm run dev           # build the engine, then serve the test bench
```

`engine/pkg` is a build artifact and is not checked in, so `build:wasm` has to
run before the web app will start.
