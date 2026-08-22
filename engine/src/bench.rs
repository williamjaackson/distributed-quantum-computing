//! Benchmark workloads, driven from inside WASM.
//!
//! The loop stays in Rust so the measurement reflects kernel throughput rather
//! than per-gate JS<->WASM call overhead, which would dominate at small qubit
//! counts and flatten the 2^n curve the capacity probe is trying to show.

use crate::gates::{apply, apply_controlled, Gate};
use crate::state::StateVector;

/// One layer: Hadamard on every qubit, a ring of CNOTs, then T on every qubit.
///
/// Chosen to be representative rather than best-case — it mixes the swap-only
/// kernel, the arithmetic-heavy Hadamard, a diagonal gate, and a two-qubit gate
/// whose stride varies across the register, so no single fast path dominates.
/// Returns the number of gates applied.
pub fn bench_layers(sv: &mut StateVector, layers: u32) -> u64 {
    let n = sv.n_qubits();
    let mut gates = 0u64;
    for _ in 0..layers {
        for q in 0..n {
            let _ = apply(sv, Gate::H, q);
            gates += 1;
        }
        // A 1-qubit register has no distinct neighbour to entangle with.
        if n >= 2 {
            for q in 0..n {
                let _ = apply_controlled(sv, Gate::X, &[q], (q + 1) % n);
                gates += 1;
            }
        }
        for q in 0..n {
            let _ = apply(sv, Gate::T, q);
            gates += 1;
        }
    }
    gates
}

/// Gates per layer for a given register size — lets the UI predict the cost of a
/// run before committing to it.
pub fn gates_per_layer(n_qubits: u32) -> u64 {
    let n = n_qubits as u64;
    if n >= 2 {
        3 * n
    } else {
        2 * n
    }
}
