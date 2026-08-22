//! Probabilities, sampling, and projective measurement.

use crate::complex::C;
use crate::rng::Rng;
use crate::state::{QsimError, StateVector};

/// Above this qubit count, returning a full probability or amplitude array would
/// allocate a second buffer comparable to the state vector itself — enough to
/// push a near-capacity run over the WASM memory ceiling. The UI only inspects
/// full distributions for small registers, so refuse rather than risk the OOM.
pub const FULL_ARRAY_QUBIT_LIMIT: u32 = 22;

fn guard_full_array(sv: &StateVector) -> Result<(), QsimError> {
    if sv.n_qubits() > FULL_ARRAY_QUBIT_LIMIT {
        return Err(QsimError::TooLargeForOperation {
            n_qubits: sv.n_qubits(),
            limit: FULL_ARRAY_QUBIT_LIMIT,
        });
    }
    Ok(())
}

/// Probability of every basis state, indexed by the integer the bit string forms.
pub fn probabilities(sv: &StateVector) -> Result<Vec<f64>, QsimError> {
    guard_full_array(sv)?;
    let mut out: Vec<f64> = Vec::new();
    out.try_reserve_exact(sv.len())
        .map_err(|_| QsimError::OutOfMemory {
            requested: sv.n_qubits(),
            bytes: (sv.len() as u64) * 8,
        })?;
    out.extend(sv.amps().iter().map(|a| a.norm_sqr()));
    Ok(out)
}

/// Amplitudes flattened to `[re0, im0, re1, im1, ...]` for transfer to JS.
pub fn amplitudes_flat(sv: &StateVector) -> Result<Vec<f64>, QsimError> {
    guard_full_array(sv)?;
    let mut out: Vec<f64> = Vec::new();
    out.try_reserve_exact(sv.len() * 2)
        .map_err(|_| QsimError::OutOfMemory {
            requested: sv.n_qubits(),
            bytes: (sv.len() as u64) * 16,
        })?;
    for a in sv.amps() {
        out.push(a.re);
        out.push(a.im);
    }
    Ok(out)
}

/// Marginal probability of finding `qubit` in |1>. Streams the state vector, so
/// this works at any qubit count.
pub fn probability_of_one(sv: &StateVector, qubit: u32) -> Result<f64, QsimError> {
    sv.check_qubit(qubit)?;
    let step = 1usize << qubit;
    let mut p = 0.0;
    for block in sv.amps().chunks_exact(step << 1) {
        for y in &block[step..] {
            p += y.norm_sqr();
        }
    }
    Ok(p)
}

/// Pauli-Z expectation value on one qubit: `P(0) - P(1)`.
pub fn expectation_z(sv: &StateVector, qubit: u32) -> Result<f64, QsimError> {
    Ok(1.0 - 2.0 * probability_of_one(sv, qubit)?)
}

/// Measure `qubit`, collapse the state onto the observed outcome, renormalise.
pub fn measure(sv: &mut StateVector, qubit: u32, rng: &mut Rng) -> Result<u8, QsimError> {
    let p1 = probability_of_one(sv, qubit)?;
    let outcome: u8 = if rng.next_f64() < p1 { 1 } else { 0 };

    // Guard against dividing by a vanishing norm when the observed branch holds
    // essentially no probability.
    let p = if outcome == 1 { p1 } else { 1.0 - p1 };
    if p <= 0.0 {
        return Ok(outcome);
    }
    let scale = 1.0 / p.sqrt();

    let step = 1usize << qubit;
    for block in sv.amps_mut().chunks_exact_mut(step << 1) {
        let (lo, hi) = block.split_at_mut(step);
        // Keep the observed branch (rescaled); zero the one that was not seen.
        let (kept, killed) = if outcome == 1 { (hi, lo) } else { (lo, hi) };
        for x in kept.iter_mut() {
            *x = x.scale(scale);
        }
        killed.fill(C::ZERO);
    }
    Ok(outcome)
}

/// Draw `shots` samples from the distribution without disturbing the state.
///
/// Rather than build a 2^n cumulative table, this draws all the uniforms up
/// front, sorts them, and walks the state vector once — O(2^n + shots log shots)
/// time with no buffer proportional to the state, so it works at any qubit count.
/// Returns `(basis_state_index, count)` pairs for the states that were hit.
pub fn sample(sv: &StateVector, shots: u32, seed: u64) -> Vec<(u64, u32)> {
    sample_unnormalised(sv.amps(), shots, seed)
}

/// Sample amplitudes whose squared magnitudes need not sum to 1.
///
/// A shard holds only part of the global state, so its slice carries less than
/// unit probability. Drawing uniforms in `[0, mass)` rather than `[0, 1)` makes
/// the draw exact within the slice, which is what lets the orchestrator sample a
/// sharded state by first choosing a shard in proportion to its mass.
pub fn sample_unnormalised(amps: &[C], shots: u32, seed: u64) -> Vec<(u64, u32)> {
    if shots == 0 || amps.is_empty() {
        return Vec::new();
    }
    let mass: f64 = amps.iter().map(|a| a.norm_sqr()).sum();
    if mass <= 0.0 {
        return Vec::new();
    }
    let mut rng = Rng::new(seed);
    let mut draws: Vec<f64> = (0..shots).map(|_| rng.next_f64() * mass).collect();
    draws.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let mut out: Vec<(u64, u32)> = Vec::new();
    let mut acc = 0.0f64;
    let mut d = 0usize;
    let mut last_hit = 0u64;

    for (i, a) in amps.iter().enumerate() {
        if d >= draws.len() {
            break;
        }
        let p = a.norm_sqr();
        if p == 0.0 {
            continue;
        }
        acc += p;
        let start = d;
        while d < draws.len() && draws[d] < acc {
            d += 1;
        }
        if d > start {
            out.push((i as u64, (d - start) as u32));
        }
        last_hit = i as u64;
    }

    // Rounding can leave the final accumulator a hair below 1.0; park any
    // stragglers on the last state that actually had support.
    if d < draws.len() {
        let leftover = (draws.len() - d) as u32;
        match out.last_mut() {
            Some(e) if e.0 == last_hit => e.1 += leftover,
            _ => out.push((last_hit, leftover)),
        }
    }
    out
}
