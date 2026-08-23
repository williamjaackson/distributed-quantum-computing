//! Standard reference circuits.
//!
//! These live in the engine rather than in the test file or the UI so that the
//! native `cargo test` suite and the in-browser test panel exercise byte-for-byte
//! the same code — a browser "pass" then means something about the shipped WASM.

use crate::complex::C;
use crate::gates::{apply, apply_controlled, apply_swap, Gate};
use crate::rng::Rng;
use crate::state::{RockError, StateVector};

/// Hadamard on every qubit: the uniform superposition over all 2^n states.
pub fn uniform(sv: &mut StateVector) -> Result<(), RockError> {
    for q in 0..sv.n_qubits() {
        apply(sv, Gate::H, q)?;
    }
    Ok(())
}

/// Bell pair on qubits 0 and 1: (|00> + |11>)/sqrt(2).
pub fn bell(sv: &mut StateVector) -> Result<(), RockError> {
    apply(sv, Gate::H, 0)?;
    apply_controlled(sv, Gate::X, &[0], 1)?;
    Ok(())
}

/// GHZ state across all qubits: (|00...0> + |11...1>)/sqrt(2).
pub fn ghz(sv: &mut StateVector) -> Result<(), RockError> {
    apply(sv, Gate::H, 0)?;
    for q in 1..sv.n_qubits() {
        apply_controlled(sv, Gate::X, &[q - 1], q)?;
    }
    Ok(())
}

/// Quantum Fourier transform over all qubits.
///
/// Hadamard on the top qubit, then controlled phase rotations of decreasing
/// angle from each lower qubit, working downward; a final layer of swaps undoes
/// the bit reversal the recursion leaves behind.
pub fn qft(sv: &mut StateVector) -> Result<(), RockError> {
    let n = sv.n_qubits();
    for j in (0..n).rev() {
        apply(sv, Gate::H, j)?;
        for k in (0..j).rev() {
            let angle = std::f64::consts::PI / ((1u64 << (j - k)) as f64);
            apply_controlled(sv, Gate::P(angle), &[k], j)?;
        }
    }
    for i in 0..n / 2 {
        apply_swap(sv, i, n - 1 - i)?;
    }
    Ok(())
}

/// Phase-flip oracle marking one basis state.
///
/// Applied directly to the amplitude array: an oracle is a black box by
/// definition, and decomposing it into gates would only add cost without
/// exercising anything the gate kernels do not already cover.
pub fn phase_oracle(sv: &mut StateVector, marked: usize) -> Result<(), RockError> {
    let len = sv.len();
    if marked >= len {
        return Err(RockError::InvalidQubit {
            qubit: marked as u32,
            n_qubits: sv.n_qubits(),
        });
    }
    let a = sv.amps()[marked];
    sv.amps_mut()[marked] = C::new(-a.re, -a.im);
    Ok(())
}

/// The optimal number of Grover iterations for one marked item in 2^n.
pub fn grover_iterations(n_qubits: u32) -> u32 {
    let n = (1u64 << n_qubits) as f64;
    let r = (std::f64::consts::FRAC_PI_4 * n.sqrt()).floor();
    r.max(1.0) as u32
}

/// Grover search for a single marked state.
///
/// Each iteration is oracle + diffusion, where diffusion is
/// `H^n (2|0><0| - I) H^n`. The `(2|0><0| - I)` reflection is implemented as a
/// sign flip on every state except |0...0>.
pub fn grover(sv: &mut StateVector, marked: usize, iterations: u32) -> Result<(), RockError> {
    uniform(sv)?;
    for _ in 0..iterations {
        phase_oracle(sv, marked)?;
        uniform(sv)?;
        for a in sv.amps_mut()[1..].iter_mut() {
            *a = C::new(-a.re, -a.im);
        }
        uniform(sv)?;
    }
    Ok(())
}

/// Teleport the state `U3(theta, phi, 0)|0>` from qubit 0 to qubit 2.
///
/// Requires a 3-qubit register. Measures qubits 0 and 1 and applies the
/// classically-conditioned corrections, so it exercises mid-circuit measurement
/// and collapse rather than just unitary evolution. Returns the two measured bits.
pub fn teleport(
    sv: &mut StateVector,
    theta: f64,
    phi: f64,
    rng: &mut Rng,
) -> Result<(u8, u8), RockError> {
    if sv.n_qubits() < 3 {
        return Err(RockError::WrongArity {
            gate: "teleport".into(),
            expected: 3,
            got: sv.n_qubits() as usize,
        });
    }
    // Payload to send, on qubit 0.
    apply(sv, Gate::U3(theta, phi, 0.0), 0)?;
    // Entangled pair shared between the sender (1) and receiver (2).
    apply(sv, Gate::H, 1)?;
    apply_controlled(sv, Gate::X, &[1], 2)?;
    // Sender's joint measurement in the Bell basis.
    apply_controlled(sv, Gate::X, &[0], 1)?;
    apply(sv, Gate::H, 0)?;
    let m0 = crate::measure::measure(sv, 0, rng)?;
    let m1 = crate::measure::measure(sv, 1, rng)?;
    // Receiver's corrections, conditioned on the two classical bits.
    if m1 == 1 {
        apply(sv, Gate::X, 2)?;
    }
    if m0 == 1 {
        apply(sv, Gate::Z, 2)?;
    }
    Ok((m0, m1))
}
