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

Two separate limits apply, and the tighter one is easy to miss:

| Limit | Value | Consequence |
| ----- | ----- | ----------- |
| Single Rust allocation (`isize::MAX`, 32-bit) | 2 GiB | one `Vec` holds <= **26 qubits** |
| One wasm32 module's address space | 4 GiB | one module holds <= 27 qubits |

27 qubits needs exactly 2^31 bytes, one byte over `isize::MAX`, so it is refused
instantly without the heap even growing. Measured in Chrome: a fresh module
refuses a 2 GiB `Vec`, yet happily holds three 1 GiB slices at once — the cap is
per allocation, not on the total. (A JS `ArrayBuffer` tops out at the same
~2 GiB, so this is not a Rust quirk.)

`StateVector::try_new` uses `try_reserve_exact` and returns an error rather than
aborting, which is what makes a capacity probe possible: it walks `n` upward and
catches the real ceiling instead of killing the WASM instance.

The build passes `--max-memory=4294967296` (see `.cargo/config.toml`) to raise
the module's memory ceiling from the 2 GiB default to the wasm32 maximum.

## Going past one module: sharding

Separate module instances get separate address spaces, so K of them hold K times
as much, and total capacity is bounded only by RAM. `shard.rs` implements this.

A global amplitude index splits into a shard id (the top `shard_bits`) and a
local index, which makes every qubit one of two kinds:

- **Local** — the gate acts entirely within each shard's own indices. Every
  shard runs the ordinary kernel on its own slice, in parallel, with *no
  communication at all*.
- **Global** — the partner amplitude for local index `L` in shard `w` is local
  index `L` in shard `w ^ (1 << bit)`. The gate becomes an *elementwise* 2x2
  between two whole slices: no strides, perfectly sequential.

Controls split the same way. A control on a global qubit is a condition on the
shard id, so it is resolved by *choosing which shards take part* — the shard
itself only ever sees local controls. SWAP has no 2x2 form, so it decomposes
into three CNOTs.

Exchanges run in fixed-size 64 MiB blocks. A second buffer as large as the slice
would double peak memory, which is the whole thing being avoided; blocking keeps
peak at one slice plus one block regardless of slice size.

`plan_gate` does the classification and returns steps; `encode_plan` flattens
them for the orchestrator. The planning logic lives in Rust — and is covered by
`tests/sharding.rs` — so the browser side only executes, never decides.

## Layout

| File | Contents |
| ---- | -------- |
| `src/complex.rs` | `C` (complex) and `Mat2` |
| `src/dispatch.rs` | gate-name parsing, shared by both execution paths |
| `src/shard.rs` | shard slices, pair kernel, gate planning |
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
cargo test               # correctness suite, runs on the host
./build.sh               # wasm-pack build --target web --release -> pkg/
node smoke.mjs           # verifies the built artifact
node smoke-sharded.mjs   # verifies the sharded bindings end to end
```

`cargo test` checks each optimised kernel against a naive index-arithmetic
reference implemented separately in the test file, then checks the algorithms
against their analytic results: QFT against the DFT closed form, Grover for
amplification and peak position, teleportation by inverting the prepared
rotation on the receiving qubit (which verifies phase, not just amplitude) —
plus a companion test that teleportation *fails* without the classical
corrections, so the check cannot pass vacuously.

The sharding suite compares a fully orchestrated sharded run against
`Simulator` on the same circuit — every gate at every qubit position across
every shard layout, plus 300-gate random circuits. That one equivalence covers
the index split, control classification, low/high row assignment and blocked
exchange all at once: if sharded output matches whole-state output bit for bit,
they are all correct together.
