# qsim — quantum state-vector simulator (Rust → WASM)

A full state-vector simulator for quantum circuits, compiled to WebAssembly.

## How it works

An `n`-qubit register is `2^n` complex amplitudes. A single-qubit gate on qubit
`t` mixes every pair of amplitudes whose indices differ only in bit `t`; those
pairs sit `1 << t` apart, so the state splits into contiguous blocks that each
divide into a "bit clear" and a "bit set" half. Controlled gates apply the same
mixing to the subset of indices where the control bits are 1.

Nothing larger than a 2x2 matrix is ever materialised — no `2^n × 2^n` operators,
no dense linear algebra.

The kernels iterate with `chunks_exact_mut` + `split_at_mut`, which hands the
compiler two disjoint slices of statically-known equal length. That removes the
bounds checks and lets the inner loop vectorise without any `unsafe`.

X, Z, Y, H and the diagonal gates (Z/S/T/RZ/phase) get specialised kernels: a
pure swap, a sign flip, and a scalar multiply respectively, instead of four
complex multiplies per amplitude pair.

## Capacity

Amplitudes are `Complex<f64>` — 16 bytes each — so `n` qubits needs `2^n * 16`
bytes:

| Qubits | Memory |
| ------ | ------ |
| 20 | 16 MiB |
| 24 | 256 MiB |
| 26 | 1 GiB |
| 27 | 2 GiB |
| 28 | 4 GiB (not addressable) |

wasm32 has a 4 GiB address space and a 32-bit `usize`, which caps the simulator
at **27 qubits**; `MAX_QUBITS` reflects this. Reaching 26–27 also depends on the
host actually granting the allocation, so `StateVector::try_new` uses
`try_reserve_exact` and returns an error instead of aborting. That is what makes
the capacity probe possible: it walks `n` upward and catches the real ceiling
rather than crashing the WASM instance.

The build passes `--max-memory=4294967296` (see `.cargo/config.toml`) to raise
the module's memory ceiling from the 2 GiB default to the wasm32 maximum.

## Layout

| File | Contents |
| ---- | -------- |
| `src/complex.rs` | `C` (complex) and `Mat2` |
| `src/state.rs` | `StateVector`, allocation, `QsimError`, `MAX_QUBITS` |
| `src/gates.rs` | gate kernels and the `Gate` set |
| `src/measure.rs` | probabilities, marginals, sampling, collapse |
| `src/circuits.rs` | Bell, GHZ, QFT, Grover, teleportation |
| `src/bench.rs` | the benchmark workload, looped inside WASM |
| `src/rng.rs` | seedable xorshift64* |
| `src/lib.rs` | gate-name dispatch, `Simulator`, WASM bindings |

`Simulator` is plain Rust returning `QsimError`; `JsSimulator` is a logic-free
`wasm-bindgen` wrapper over it. The split matters: a `JsValue` cannot be
constructed off wasm32 (it panics inside an `extern "C"` shim, which aborts
instead of unwinding), so putting logic in the wrapper would make every error
path untestable on the host.

## Gates

`h x y z s sdg t tdg rx ry rz p u3 cx cy cz ch crx cry crz cp ccx ccz swap`

Dispatched by name through `apply_named` / `applyGate`, with controls listed
before the target. Any single-qubit gate can be given controls, so CNOT, CZ,
controlled-phase and Toffoli all reuse one kernel family.

## Build and test

```sh
cargo test          # correctness suite, runs on the host
./build.sh          # wasm-pack build --target web --release -> pkg/
node ../engine/smoke.mjs   # verifies the built artifact
```

`cargo test` checks each optimised kernel against a naive index-arithmetic
reference implemented separately in the test file, then checks the algorithms
against their analytic results: QFT against the DFT closed form, Grover for
amplification and peak position, teleportation by inverting the prepared
rotation on the receiving qubit (which verifies phase, not just amplitude) —
plus a companion test that teleportation *fails* without the classical
corrections, so the check cannot pass vacuously.
