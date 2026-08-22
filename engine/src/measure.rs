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

/// One-qubit reduced density matrix elements, as `[r00, re01, im01, r11]`.
///
/// Streams the state vector with two accumulators per element, so it works at
/// any register size — unlike anything that has to materialise a second array.
/// The off-diagonal element is the part that matters: the diagonal is just the
/// marginal, while `r01` carries the phase relationship *and* is the only part
/// entanglement can destroy. That is what makes the Bloch radius meaningful.
pub fn reduced_one(sv: &StateVector, qubit: u32) -> Result<[f64; 4], QsimError> {
    sv.check_qubit(qubit)?;
    let step = 1usize << qubit;
    let mut r00 = 0.0;
    let mut r11 = 0.0;
    let mut re01 = 0.0;
    let mut im01 = 0.0;
    for block in sv.amps().chunks_exact(step << 1) {
        let (lo, hi) = block.split_at(step);
        for (a, b) in lo.iter().zip(hi.iter()) {
            r00 += a.norm_sqr();
            r11 += b.norm_sqr();
            // a * conj(b), accumulated over every setting of the other qubits.
            re01 += a.re * b.re + a.im * b.im;
            im01 += a.im * b.re - a.re * b.im;
        }
    }
    Ok([r00, re01, im01, r11])
}

/// Bloch vector of one qubit: `[<X>, <Y>, <Z>]`.
///
/// Its length is 1 for a qubit in a pure state of its own and 0 for one
/// maximally entangled with the rest of the register — the single number that
/// says "this qubit has no state of its own", which no amount of looking at the
/// state vector makes obvious.
pub fn bloch_vector(sv: &StateVector, qubit: u32) -> Result<[f64; 3], QsimError> {
    let [r00, re01, im01, r11] = reduced_one(sv, qubit)?;
    Ok([2.0 * re01, -2.0 * im01, r00 - r11])
}

/// Two-qubit reduced density matrix, row-major with interleaved `(re, im)`.
///
/// The subsystem index is `bit_a + 2 * bit_b`, so entry `(k, l)` starts at
/// `2 * (4 * k + l)`. Sixteen complex accumulators and one pass — the pairwise
/// version of [`reduced_one`], and the input every correlation measure between
/// two qubits is built from.
///
/// Cost is one pass per *pair*, so a caller wanting all of them pays
/// `O(n^2 * 2^n)`. That is affordable for a register you would want to draw a
/// link diagram of and not much beyond, which is a budgeting decision for the
/// caller rather than something to solve here.
pub fn reduced_two(sv: &StateVector, a: u32, b: u32) -> Result<[f64; 32], QsimError> {
    sv.check_qubit(a)?;
    sv.check_qubit(b)?;
    if a == b {
        return Err(QsimError::DuplicateQubit(a));
    }
    let ba = 1usize << a;
    let bb = 1usize << b;
    let mut rho = [0.0f64; 32];
    let amps = sv.amps();
    for (i, x) in amps.iter().enumerate() {
        if x.re == 0.0 && x.im == 0.0 {
            continue;
        }
        let k = usize::from(i & ba != 0) | (usize::from(i & bb != 0) << 1);
        let rest = i & !ba & !bb;
        for l in 0..4usize {
            let j = rest | if l & 1 != 0 { ba } else { 0 } | if l & 2 != 0 { bb } else { 0 };
            let y = amps[j];
            let at = 2 * (k * 4 + l);
            // rho[k][l] += psi_k * conj(psi_l)
            rho[at] += x.re * y.re + x.im * y.im;
            rho[at + 1] += x.im * y.re - x.re * y.im;
        }
    }
    Ok(rho)
}

/// The `k` most probable basis states, largest first, as `(index, amplitude)`.
///
/// The point is the memory profile: `probabilities` and `amplitudes` allocate a
/// second buffer the size of the state and are refused past
/// [`FULL_ARRAY_QUBIT_LIMIT`], but almost everything that wants the state only
/// wants the part of it that carries any probability. This keeps `k` entries and
/// one pass, so it is available at any register size.
pub fn top_amplitudes(sv: &StateVector, k: usize) -> Vec<(u64, C)> {
    if k == 0 {
        return Vec::new();
    }
    // Insertion into a short descending list. `k` is a display budget — tens,
    // not thousands — so the shift beats a heap and keeps the result sorted
    // without a final pass.
    let mut out: Vec<(u64, C, f64)> = Vec::with_capacity(k + 1);
    let mut floor = 0.0f64;
    for (i, a) in sv.amps().iter().enumerate() {
        let p = a.norm_sqr();
        if p <= 0.0 || (out.len() == k && p <= floor) {
            continue;
        }
        let at = out.partition_point(|e| e.2 > p);
        out.insert(at, (i as u64, *a, p));
        out.truncate(k);
        floor = out[out.len() - 1].2;
    }
    out.into_iter().map(|(i, a, _)| (i, a)).collect()
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
