//! Standard reference circuits.
//!
//! These live in the engine rather than in the test file or the UI so that the
//! native `cargo test` suite and the in-browser test panel exercise byte-for-byte
//! the same code — a browser "pass" then means something about the shipped WASM.

use crate::complex::C;
use crate::gates::{apply, apply_controlled, apply_swap, Gate};
use crate::rng::Rng;
use crate::state::{QsimError, StateVector};

/// Hadamard on every qubit: the uniform superposition over all 2^n states.
pub fn uniform(sv: &mut StateVector) -> Result<(), QsimError> {
    for q in 0..sv.n_qubits() {
        apply(sv, Gate::H, q)?;
    }
    Ok(())
}

/// Bell pair on qubits 0 and 1: (|00> + |11>)/sqrt(2).
pub fn bell(sv: &mut StateVector) -> Result<(), QsimError> {
    apply(sv, Gate::H, 0)?;
    apply_controlled(sv, Gate::X, &[0], 1)?;
    Ok(())
}

/// GHZ state across all qubits: (|00...0> + |11...1>)/sqrt(2).
pub fn ghz(sv: &mut StateVector) -> Result<(), QsimError> {
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
pub fn qft(sv: &mut StateVector) -> Result<(), QsimError> {
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
pub fn phase_oracle(sv: &mut StateVector, marked: usize) -> Result<(), QsimError> {
    let len = sv.len();
    if marked >= len {
        return Err(QsimError::InvalidQubit {
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
pub fn grover(sv: &mut StateVector, marked: usize, iterations: u32) -> Result<(), QsimError> {
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
) -> Result<(u8, u8), QsimError> {
    if sv.n_qubits() < 3 {
        return Err(QsimError::WrongArity {
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

/// Greatest common divisor, for oracle validation and period post-processing.
pub fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let t = b;
        b = a % b;
        a = t;
    }
    a
}

/// Modular exponentiation, by square-and-multiply.
pub fn mod_pow(mut base: u64, mut exp: u64, modulus: u64) -> u64 {
    if modulus == 1 {
        return 0;
    }
    let mut acc: u64 = 1;
    base %= modulus;
    while exp > 0 {
        if exp & 1 == 1 {
            acc = acc * base % modulus;
        }
        base = base * base % modulus;
        exp >>= 1;
    }
    acc
}

/// Modular exponentiation oracle: |x>|y> -> |x>|y * a^x mod N>.
///
/// The work register occupies the low `work_qubits` index bits and the counting
/// register sits above it, so a global index splits as
/// `(x << work_qubits) | y`. Starting from |y = 1> this leaves
/// |x>|a^x mod N>, whose period in x is the order of `a` — the quantity Shor's
/// algorithm extracts.
///
/// Applied straight to the amplitude array rather than decomposed into gates.
/// A gate-level modular multiplier costs a few thousand Toffolis plus its own
/// ancilla registers, which would dominate the qubit budget and the runtime
/// while teaching nothing about period finding — the part that is actually
/// quantum. Grover's oracle is handled the same way, for the same reason.
///
/// Reversible because `y -> y * a^x mod N` is a bijection on `0..N` whenever
/// `gcd(a, N) = 1`; values at or above `N` are untouched fixed points, since the
/// work register is wider than the modulus in general.
///
/// One pass over the state: `a^x` advances by a single multiply per block rather
/// than a fresh exponentiation.
pub fn modexp_oracle(
    sv: &mut StateVector,
    a: u64,
    modulus: u64,
    work_qubits: u32,
) -> Result<(), QsimError> {
    modexp_oracle_from(sv, a, modulus, work_qubits, 1)
}

/// [`modexp_oracle`], but starting from an arbitrary power of `a`.
///
/// This is what makes the oracle shard-local. The counting register occupies the
/// high index bits, so a shard id *is* the top of `x`, and
/// `a^x = a^(offset) * a^(x_low)` splits cleanly: each shard needs only the power
/// of `a` at its first `x`, which is classical arithmetic. No shard ever needs
/// another shard's amplitudes, so the whole oracle costs zero communication.
pub fn modexp_oracle_from(
    sv: &mut StateVector,
    a: u64,
    modulus: u64,
    work_qubits: u32,
    start_power: u64,
) -> Result<(), QsimError> {
    if modulus < 2 {
        return Err(QsimError::InvalidOracle(format!("modulus {modulus} must be at least 2")));
    }
    if work_qubits > sv.n_qubits() {
        return Err(QsimError::InvalidOracle(format!(
            "work register of {work_qubits} exceeds the {}-qubit state",
            sv.n_qubits()
        )));
    }
    let block = 1usize << work_qubits;
    if (block as u64) < modulus {
        return Err(QsimError::InvalidOracle(format!(
            "work register of {work_qubits} qubits cannot hold values mod {modulus}"
        )));
    }
    if gcd(a % modulus, modulus) != 1 {
        return Err(QsimError::InvalidOracle(format!(
            "a = {a} shares a factor with {modulus}, so the map is not reversible"
        )));
    }

    let len = sv.len();
    let blocks = len / block;
    let m = (modulus as usize).min(block);

    let mut scratch: Vec<C> = Vec::new();
    scratch
        .try_reserve_exact(m)
        .map_err(|_| QsimError::OutOfMemory { requested: work_qubits, bytes: (m as u64) * 16 })?;
    scratch.resize(m, C::ZERO);

    // c tracks a^x mod N incrementally across blocks, seeded at this slice's
    // first x rather than always at x = 0.
    let mut c: u64 = start_power % modulus;
    let a_mod = a % modulus;
    for x in 0..blocks {
        let base = x * block;
        scratch.copy_from_slice(&sv.amps()[base..base + m]);
        for y in 0..m {
            let ny = ((y as u64) * c % modulus) as usize;
            sv.amps_mut()[base + ny] = scratch[y];
        }
        let _ = x;
        c = c * a_mod % modulus;
    }
    Ok(())
}

/// The multiplicative order of `a` modulo `N` — the period the algorithm is
/// looking for. Classical, and only for checking the quantum answer.
pub fn multiplicative_order(a: u64, modulus: u64) -> Option<u64> {
    if modulus < 2 || gcd(a % modulus, modulus) != 1 {
        return None;
    }
    let mut c = a % modulus;
    for r in 1..=modulus {
        if c == 1 {
            return Some(r);
        }
        c = c * (a % modulus) % modulus;
    }
    None
}
