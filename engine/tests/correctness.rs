//! Correctness suite for the simulator core.
//!
//! Two kinds of check:
//!   1. Kernel equivalence — every optimised kernel is compared against a naive,
//!      index-arithmetic reference written independently in this file. A shared
//!      helper would let the same bug pass both, so the reference deliberately
//!      does not reuse the chunked iteration the real kernels use.
//!   2. Algorithm-level checks — Bell, GHZ, QFT, Grover and teleportation, whose
//!      expected outputs come from the physics rather than from this codebase.

use qsim::circuits;
use qsim::complex::{Mat2, C};
use qsim::gates::{apply, apply_controlled, apply_swap, Gate};
use qsim::measure;
use qsim::rng::Rng;
use qsim::state::{QsimError, StateVector, MAX_QUBITS};
use qsim::Simulator;

const TOL: f64 = 1e-12;

fn assert_close(a: f64, b: f64, what: &str) {
    assert!(
        (a - b).abs() < 1e-9,
        "{what}: expected {b}, got {a} (diff {})",
        (a - b).abs()
    );
}

fn assert_states_close(got: &[C], want: &[C], what: &str) {
    assert_eq!(got.len(), want.len(), "{what}: length mismatch");
    for (i, (g, w)) in got.iter().zip(want.iter()).enumerate() {
        assert!(
            (g.re - w.re).abs() < TOL && (g.im - w.im).abs() < TOL,
            "{what}: amplitude {i} expected ({}, {}), got ({}, {})",
            w.re,
            w.im,
            g.re,
            g.im
        );
    }
}

/// A deterministic normalised state with no zero amplitudes, so every term of
/// every kernel contributes and a dropped index cannot hide.
fn random_state(n_qubits: u32, seed: u64) -> Vec<C> {
    let mut rng = Rng::new(seed);
    let len = 1usize << n_qubits;
    let mut v: Vec<C> = (0..len)
        .map(|_| C::new(rng.next_f64() - 0.5, rng.next_f64() - 0.5))
        .collect();
    let norm: f64 = v.iter().map(|a| a.norm_sqr()).sum::<f64>().sqrt();
    for a in v.iter_mut() {
        *a = a.scale(1.0 / norm);
    }
    v
}

// -- naive reference implementations ---------------------------------------

fn naive_1q(amps: &[C], m: Mat2, target: u32) -> Vec<C> {
    let step = 1usize << target;
    let mut out = amps.to_vec();
    for i in 0..amps.len() {
        if i & step == 0 {
            let j = i | step;
            out[i] = m.a * amps[i] + m.b * amps[j];
            out[j] = m.c * amps[i] + m.d * amps[j];
        }
    }
    out
}

fn naive_controlled(amps: &[C], m: Mat2, controls: &[u32], target: u32) -> Vec<C> {
    let step = 1usize << target;
    let cmask = controls.iter().fold(0usize, |acc, &c| acc | (1usize << c));
    let mut out = amps.to_vec();
    for i in 0..amps.len() {
        if i & step == 0 && i & cmask == cmask {
            let j = i | step;
            out[i] = m.a * amps[i] + m.b * amps[j];
            out[j] = m.c * amps[i] + m.d * amps[j];
        }
    }
    out
}

fn all_gates() -> Vec<(&'static str, Gate)> {
    vec![
        ("H", Gate::H),
        ("X", Gate::X),
        ("Y", Gate::Y),
        ("Z", Gate::Z),
        ("S", Gate::S),
        ("Sdg", Gate::Sdg),
        ("T", Gate::T),
        ("Tdg", Gate::Tdg),
        ("RX", Gate::RX(0.7)),
        ("RY", Gate::RY(-1.3)),
        ("RZ", Gate::RZ(2.1)),
        ("P", Gate::P(0.45)),
        ("U3", Gate::U3(0.6, 1.1, -0.3)),
    ]
}

fn state_from(n: u32, amps: &[C]) -> StateVector {
    let mut sv = StateVector::try_new(n).unwrap();
    sv.amps_mut().copy_from_slice(amps);
    sv
}

// -- 1. kernel equivalence -------------------------------------------------

#[test]
fn single_qubit_kernels_match_naive_reference() {
    let n = 5;
    let start = random_state(n, 11);
    for (name, gate) in all_gates() {
        for target in 0..n {
            let mut sv = state_from(n, &start);
            apply(&mut sv, gate, target).unwrap();
            let want = naive_1q(&start, gate.matrix(), target);
            assert_states_close(sv.amps(), &want, &format!("{name} on q{target}"));
        }
    }
}

#[test]
fn controlled_kernels_match_naive_reference() {
    let n = 5;
    let start = random_state(n, 22);
    for (name, gate) in all_gates() {
        // Controls both below and above the target, and a two-control case, so
        // the per-element mask test is exercised in every relative position.
        let cases: Vec<(Vec<u32>, u32)> = vec![
            (vec![0], 3),
            (vec![4], 1),
            (vec![2], 3),
            (vec![0, 4], 2),
            (vec![1, 2], 0),
        ];
        for (controls, target) in cases {
            let mut sv = state_from(n, &start);
            apply_controlled(&mut sv, gate, &controls, target).unwrap();
            let want = naive_controlled(&start, gate.matrix(), &controls, target);
            assert_states_close(
                sv.amps(),
                &want,
                &format!("c{name} controls={controls:?} target={target}"),
            );
        }
    }
}

#[test]
fn gate_matrices_act_correctly_on_basis_states() {
    for (name, gate) in all_gates() {
        let m = gate.matrix();
        // Column 0 is the image of |0>, column 1 the image of |1>.
        let mut sv = StateVector::try_new(1).unwrap();
        apply(&mut sv, gate, 0).unwrap();
        assert_states_close(sv.amps(), &[m.a, m.c], &format!("{name}|0>"));

        let mut sv = StateVector::try_new(1).unwrap();
        apply(&mut sv, Gate::X, 0).unwrap();
        apply(&mut sv, gate, 0).unwrap();
        assert_states_close(sv.amps(), &[m.b, m.d], &format!("{name}|1>"));
    }
}

#[test]
fn every_gate_preserves_the_norm() {
    let n = 4;
    for (name, gate) in all_gates() {
        let mut sv = state_from(n, &random_state(n, 33));
        for target in 0..n {
            apply(&mut sv, gate, target).unwrap();
            apply_controlled(&mut sv, gate, &[(target + 1) % n], target).unwrap();
        }
        assert_close(sv.norm(), 1.0, &format!("norm after {name} sweep"));
    }
}

#[test]
fn cnot_truth_table() {
    // control=0, target=1: |c t> maps 00->00, 01->01, 10->11, 11->10.
    // Index bit 0 is qubit 0, so |q1 q0> as an integer is q0 + 2*q1.
    for (input, expected) in [(0usize, 0usize), (1, 3), (2, 2), (3, 1)] {
        let mut sim = Simulator::new(2).unwrap();
        sim.set_basis_state(input).unwrap();
        sim.apply_named("cx", &[0, 1], &[]).unwrap();
        let p = sim.probabilities().unwrap();
        assert_close(p[expected], 1.0, &format!("cnot {input} -> {expected}"));
    }
}

#[test]
fn toffoli_truth_table() {
    // Flips qubit 2 only when qubits 0 and 1 are both 1 (index 3).
    for input in 0usize..8 {
        let mut sim = Simulator::new(3).unwrap();
        sim.set_basis_state(input).unwrap();
        sim.apply_named("ccx", &[0, 1, 2], &[]).unwrap();
        let expected = if input & 0b011 == 0b011 { input ^ 0b100 } else { input };
        let p = sim.probabilities().unwrap();
        assert_close(p[expected], 1.0, &format!("ccx {input} -> {expected}"));
    }
}

#[test]
fn swap_exchanges_qubits() {
    let n = 4;
    let start = random_state(n, 44);
    let mut sv = state_from(n, &start);
    apply_swap(&mut sv, 1, 3).unwrap();
    // Swapping qubits permutes basis states by exchanging the two index bits.
    let (m1, m3) = (1usize << 1, 1usize << 3);
    let mut want = start.clone();
    for i in 0..start.len() {
        let bit1 = (i & m1 != 0) as usize;
        let bit3 = (i & m3 != 0) as usize;
        let mut j = i & !(m1 | m3);
        if bit3 == 1 {
            j |= m1;
        }
        if bit1 == 1 {
            j |= m3;
        }
        want[j] = start[i];
    }
    assert_states_close(sv.amps(), &want, "swap(1,3)");
}

#[test]
fn double_application_is_identity_for_self_inverse_gates() {
    let n = 4;
    let start = random_state(n, 55);
    for (name, gate) in [("H", Gate::H), ("X", Gate::X), ("Y", Gate::Y), ("Z", Gate::Z)] {
        for target in 0..n {
            let mut sv = state_from(n, &start);
            apply(&mut sv, gate, target).unwrap();
            apply(&mut sv, gate, target).unwrap();
            assert_states_close(sv.amps(), &start, &format!("{name}^2 on q{target}"));
        }
    }
}

#[test]
fn dagger_gates_invert_their_partners() {
    let n = 3;
    let start = random_state(n, 66);
    for (name, g, gdg) in [("S", Gate::S, Gate::Sdg), ("T", Gate::T, Gate::Tdg)] {
        let mut sv = state_from(n, &start);
        apply(&mut sv, g, 1).unwrap();
        apply(&mut sv, gdg, 1).unwrap();
        assert_states_close(sv.amps(), &start, &format!("{name} then {name}dg"));
    }
    // U3(theta,phi,lam)^dagger == U3(-theta,-lam,-phi).
    let (th, ph, la) = (0.83, -1.7, 0.4);
    let mut sv = state_from(n, &start);
    apply(&mut sv, Gate::U3(th, ph, la), 2).unwrap();
    apply(&mut sv, Gate::U3(-th, -la, -ph), 2).unwrap();
    assert_states_close(sv.amps(), &start, "U3 then U3 dagger");
}

// -- 2. algorithm-level checks --------------------------------------------

#[test]
fn bell_state_is_maximally_correlated() {
    let mut sim = Simulator::new(2).unwrap();
    sim.prepare_bell().unwrap();
    let p = sim.probabilities().unwrap();
    assert_close(p[0b00], 0.5, "P(00)");
    assert_close(p[0b11], 0.5, "P(11)");
    assert_close(p[0b01], 0.0, "P(01)");
    assert_close(p[0b10], 0.0, "P(10)");
    assert_close(sim.norm(), 1.0, "norm");
}

#[test]
fn ghz_state_for_several_sizes() {
    for n in 2..=10u32 {
        let mut sim = Simulator::new(n).unwrap();
        sim.prepare_ghz().unwrap();
        let p = sim.probabilities().unwrap();
        let last = (1usize << n) - 1;
        assert_close(p[0], 0.5, &format!("GHZ({n}) P(all zero)"));
        assert_close(p[last], 0.5, &format!("GHZ({n}) P(all one)"));
        let rest: f64 = p
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != 0 && *i != last)
            .map(|(_, v)| *v)
            .sum();
        assert_close(rest, 0.0, &format!("GHZ({n}) leakage"));
        // Every qubit is individually unbiased despite the global correlation.
        for q in 0..n {
            assert_close(
                sim.probability_of_one(q).unwrap(),
                0.5,
                &format!("GHZ({n}) marginal q{q}"),
            );
        }
    }
}

#[test]
fn qft_matches_the_analytic_dft() {
    // QFT|x> = (1/sqrt(N)) * sum_k exp(2*pi*i*x*k/N) |k>
    for n in 1..=6u32 {
        let len = 1usize << n;
        let scale = 1.0 / (len as f64).sqrt();
        for x in [0usize, 1, 3, len - 1].into_iter().filter(|x| *x < len) {
            let mut sim = Simulator::new(n).unwrap();
            sim.set_basis_state(x).unwrap();
            sim.apply_qft().unwrap();
            let want: Vec<C> = (0..len)
                .map(|k| {
                    let angle =
                        2.0 * std::f64::consts::PI * (x as f64) * (k as f64) / (len as f64);
                    C::from_phase(angle).scale(scale)
                })
                .collect();
            assert_states_close(sim.state().amps(), &want, &format!("QFT n={n} x={x}"));
        }
    }
}

#[test]
fn inverse_qft_recovers_the_input() {
    // Running QFT then conjugating the state and running QFT again returns the
    // original basis state, since conj(QFT(conj(QFT|x>))) == |x>.
    let n = 5;
    let x = 19usize;
    let mut sim = Simulator::new(n).unwrap();
    sim.set_basis_state(x).unwrap();
    sim.apply_qft().unwrap();
    for a in sim.state_mut().amps_mut() {
        *a = a.conj();
    }
    sim.apply_qft().unwrap();
    for a in sim.state_mut().amps_mut() {
        *a = a.conj();
    }
    let p = sim.probabilities().unwrap();
    assert_close(p[x], 1.0, "QFT then inverse QFT");
}

#[test]
fn grover_amplifies_the_marked_state() {
    for n in 3..=10u32 {
        let marked = ((1usize << n) * 2 / 3).min((1usize << n) - 1);
        let mut sim = Simulator::new(n).unwrap();
        let iters = sim.run_grover(marked, -1).unwrap();
        let p = sim.probabilities().unwrap();

        let uniform = 1.0 / (1usize << n) as f64;
        assert!(
            p[marked] > 0.5,
            "Grover n={n} ({iters} iters): marked probability {} should exceed 0.5",
            p[marked]
        );
        assert!(
            p[marked] > uniform * 4.0,
            "Grover n={n}: {} is not a meaningful amplification of {uniform}",
            p[marked]
        );
        assert_close(sim.norm(), 1.0, &format!("Grover n={n} norm"));
        // The marked state must be the single most likely outcome.
        let best = p
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap()
            .0;
        assert_eq!(best, marked, "Grover n={n}: peak at wrong state");
    }
}

#[test]
fn grover_iteration_count_follows_sqrt_scaling() {
    // ~pi/4 * sqrt(N); the point is that it is sub-linear in N.
    assert_eq!(circuits::grover_iterations(4), 3);
    assert_eq!(circuits::grover_iterations(10), 25);
    assert!(circuits::grover_iterations(20) < (1 << 20));
}

#[test]
fn teleportation_transfers_an_arbitrary_state() {
    let (theta, phi) = (0.9, 2.4);
    // Every seed lands on one of the four correction branches; all must work.
    for seed in 0..12u64 {
        let mut sim = Simulator::new(3).unwrap();
        sim.set_seed(seed);
        sim.teleport(theta, phi).unwrap();

        // Undo the prepared rotation on the receiving qubit. If teleportation
        // preserved amplitude *and* phase, qubit 2 is now exactly |0>.
        sim.apply_named("u3", &[2], &[-theta, 0.0, -phi]).unwrap();
        assert_close(
            sim.probability_of_one(2).unwrap(),
            0.0,
            &format!("teleport seed={seed}: residual after inverse rotation"),
        );
        assert_close(sim.norm(), 1.0, &format!("teleport seed={seed} norm"));
    }
}

#[test]
fn teleportation_without_corrections_generally_fails() {
    // Guards against a vacuous version of the test above: the corrections must
    // actually matter, so skipping them has to break at least one branch.
    let (theta, phi) = (0.9, 2.4);
    let mut any_wrong = false;
    for seed in 0..12u64 {
        let mut sim = Simulator::new(3).unwrap();
        sim.set_seed(seed);
        // Same circuit as circuits::teleport, minus the conditional corrections.
        sim.apply_named("u3", &[0], &[theta, phi, 0.0]).unwrap();
        sim.apply_named("h", &[1], &[]).unwrap();
        sim.apply_named("cx", &[1, 2], &[]).unwrap();
        sim.apply_named("cx", &[0, 1], &[]).unwrap();
        sim.apply_named("h", &[0], &[]).unwrap();
        sim.measure(0).unwrap();
        sim.measure(1).unwrap();
        sim.apply_named("u3", &[2], &[-theta, 0.0, -phi]).unwrap();
        if sim.probability_of_one(2).unwrap() > 1e-6 {
            any_wrong = true;
        }
    }
    assert!(any_wrong, "corrections appear to be unnecessary — test is vacuous");
}

// -- measurement and sampling ---------------------------------------------

#[test]
fn measurement_collapses_and_renormalises() {
    let mut sim = Simulator::new(3).unwrap();
    sim.prepare_ghz().unwrap();
    let bit = sim.measure(0).unwrap();
    assert_close(sim.norm(), 1.0, "norm after collapse");
    // GHZ is perfectly correlated: the other qubits must agree with the first.
    for q in 1..3 {
        assert_close(
            sim.probability_of_one(q).unwrap(),
            bit as f64,
            &format!("q{q} agrees with collapsed q0"),
        );
    }
    // Repeated measurement is stable.
    assert_eq!(sim.measure(0).unwrap(), bit, "re-measurement changed outcome");
}

#[test]
fn sampling_is_deterministic_for_a_fixed_seed() {
    let mut sim = Simulator::new(4).unwrap();
    sim.prepare_uniform().unwrap();
    let a = sim.sample_flat(500, 123);
    let b = sim.sample_flat(500, 123);
    let c = sim.sample_flat(500, 124);
    assert_eq!(a, b, "same seed produced different samples");
    assert_ne!(a, c, "different seeds produced identical samples");
}

#[test]
fn sampling_conserves_shots_and_tracks_the_distribution() {
    let shots = 40_000u32;
    let mut sim = Simulator::new(2).unwrap();
    sim.prepare_bell().unwrap();
    let flat = sim.sample_flat(shots, 7);

    let mut total = 0u32;
    for pair in flat.chunks(2) {
        let (state, count) = (pair[0] as usize, pair[1] as u32);
        total += count;
        // A Bell pair can only ever yield 00 or 11.
        assert!(state == 0 || state == 3, "impossible outcome {state}");
    }
    assert_eq!(total, shots, "shot count not conserved");

    // Both outcomes should land near half, well inside sampling noise.
    let counts: Vec<u32> = flat.chunks(2).map(|p| p[1] as u32).collect();
    for c in counts {
        let frac = c as f64 / shots as f64;
        assert!((frac - 0.5).abs() < 0.02, "Bell outcome fraction {frac} off 0.5");
    }
}

#[test]
fn sampling_never_returns_zero_probability_states() {
    let mut sim = Simulator::new(5).unwrap();
    sim.prepare_ghz().unwrap();
    let flat = sim.sample_flat(2000, 99);
    let last = (1usize << 5) - 1;
    for pair in flat.chunks(2) {
        let state = pair[0] as usize;
        assert!(state == 0 || state == last, "GHZ sampled impossible state {state}");
    }
}

#[test]
fn expectation_z_matches_probabilities() {
    let mut sim = Simulator::new(3).unwrap();
    sim.apply_named("ry", &[0], &[0.7]).unwrap();
    sim.apply_named("x", &[1], &[]).unwrap();
    for q in 0..3 {
        let p1 = sim.probability_of_one(q).unwrap();
        assert_close(sim.expectation_z(q).unwrap(), 1.0 - 2.0 * p1, "expectation_z");
    }
}

// -- allocation and error handling ----------------------------------------

#[test]
fn memory_requirement_matches_the_16_bytes_per_amplitude_model() {
    assert_eq!(qsim::state::memory_bytes_required(0), 16);
    assert_eq!(qsim::state::memory_bytes_required(10), 16 * 1024);
    assert_eq!(qsim::state::memory_bytes_required(20), 16 * 1024 * 1024);
    // 27 qubits is 2 GiB — the practical wasm32 ceiling.
    assert_eq!(qsim::state::memory_bytes_required(27), 2 * 1024 * 1024 * 1024);
}

/// `isize::MAX` on a 32-bit target — the largest single allocation Rust permits.
const WASM32_ISIZE_MAX: u64 = (1u64 << 31) - 1;

#[test]
fn max_qubits_is_set_by_the_single_allocation_limit_not_the_address_space() {
    // Documented so the constant cannot drift back to 27. The binding limit on
    // wasm32 is isize::MAX, not the 4 GiB address space: 27 qubits needs exactly
    // 2^31 bytes, one byte too many, and is refused instantly without the heap
    // even growing. 26 qubits (1 GiB) is the largest single Vec that fits.
    assert!(qsim::state::memory_bytes_required(26) <= WASM32_ISIZE_MAX);
    assert!(qsim::state::memory_bytes_required(27) > WASM32_ISIZE_MAX);
    assert_eq!(qsim::state::memory_bytes_required(27), 1 << 31);
    // The cap is per allocation, not on the total: sharding is what gets past it.
    assert_eq!(qsim::shard::plan(29, 26, 0).shards, 8);
    assert!(qsim::shard::plan(29, 26, 0).bytes_per_shard <= WASM32_ISIZE_MAX);
}

#[test]
fn oversized_allocation_errors_rather_than_panicking() {
    let err = StateVector::try_new(MAX_QUBITS + 1).unwrap_err();
    assert!(
        matches!(err, QsimError::TooManyQubits { .. }),
        "expected TooManyQubits, got {err:?}"
    );
}

#[test]
fn full_state_arrays_are_refused_past_the_limit() {
    let n = measure::FULL_ARRAY_QUBIT_LIMIT + 1;
    // Skip if this host cannot hold the state vector in the first place.
    if let Ok(sv) = StateVector::try_new(n) {
        let err = measure::probabilities(&sv).unwrap_err();
        assert!(
            matches!(err, QsimError::TooLargeForOperation { .. }),
            "expected TooLargeForOperation, got {err:?}"
        );
        // The streaming marginal still works at this size.
        assert!(measure::probability_of_one(&sv, 0).is_ok());
    }
}

#[test]
fn invalid_gate_requests_are_rejected() {
    let mut sim = Simulator::new(3).unwrap();
    assert!(matches!(
        sim.apply_named("h", &[9], &[]),
        Err(QsimError::InvalidQubit { .. })
    ));
    assert!(matches!(
        sim.apply_named("cx", &[1, 1], &[]),
        Err(QsimError::DuplicateQubit(1))
    ));
    assert!(matches!(
        sim.apply_named("cx", &[0], &[]),
        Err(QsimError::WrongArity { .. })
    ));
    assert!(matches!(
        sim.apply_named("nope", &[0], &[]),
        Err(QsimError::UnknownGate(_))
    ));
    assert!(matches!(
        sim.apply_named("rx", &[0], &[]),
        Err(QsimError::MissingParams { .. })
    ));
    assert!(matches!(
        sim.apply_named("swap", &[0], &[]),
        Err(QsimError::WrongArity { .. })
    ));
    // A rejected gate must leave the state untouched.
    assert_close(sim.norm(), 1.0, "norm after rejected gates");
    assert_close(sim.probabilities().unwrap()[0], 1.0, "state after rejected gates");
}

#[test]
fn every_advertised_gate_name_is_applicable() {
    // Keeps GATE_NAMES honest, so a UI palette built from it cannot offer a
    // gate the dispatcher rejects.
    for name in qsim::GATE_NAMES {
        let mut sim = Simulator::new(3).unwrap();
        let params = [0.3, 0.4, 0.5];
        // Try each arity until one is accepted.
        let mut ok = false;
        for qubits in [vec![0u32], vec![0, 1], vec![0, 1, 2]] {
            if sim.apply_named(name, &qubits, &params).is_ok() {
                ok = true;
                break;
            }
        }
        assert!(ok, "advertised gate '{name}' could not be applied");
        assert_close(sim.norm(), 1.0, &format!("norm after {name}"));
    }
}

#[test]
fn reset_returns_to_the_ground_state() {
    let mut sim = Simulator::new(4).unwrap();
    sim.prepare_uniform().unwrap();
    sim.reset();
    let p = sim.probabilities().unwrap();
    assert_close(p[0], 1.0, "P(0) after reset");
    assert_close(sim.norm(), 1.0, "norm after reset");
}

#[test]
fn benchmark_workload_is_unitary_and_reports_its_gate_count() {
    for n in 1..=8u32 {
        let mut sim = Simulator::new(n).unwrap();
        let gates = sim.bench_layers(3);
        assert_eq!(
            gates as u64,
            qsim::bench::gates_per_layer(n) * 3,
            "gate count for n={n}"
        );
        assert_close(sim.norm(), 1.0, &format!("norm after benchmark n={n}"));
    }
}

// ---------------------------------------------------------------------------
// Streaming summaries
//
// These are what makes a large register visualisable: they answer "what is this
// qubit doing" and "which states carry the probability" in one pass, with no
// buffer proportional to the state. Both are checked against the full
// amplitude array, which is the thing they exist to avoid needing.
// ---------------------------------------------------------------------------

/// Bloch vector computed the obvious way, from the whole amplitude array.
fn naive_bloch(amps: &[C], qubit: u32) -> [f64; 3] {
    let bit = 1usize << qubit;
    let (mut r00, mut r11, mut re01, mut im01) = (0.0, 0.0, 0.0, 0.0);
    for (i, a) in amps.iter().enumerate() {
        if i & bit == 0 {
            let b = amps[i | bit];
            r00 += a.norm_sqr();
            re01 += a.re * b.re + a.im * b.im;
            im01 += a.im * b.re - a.re * b.im;
        } else {
            r11 += a.norm_sqr();
        }
    }
    [2.0 * re01, -2.0 * im01, r00 - r11]
}

#[test]
fn bloch_vector_matches_naive_reference() {
    for n in 1..=5u32 {
        let amps = random_state(n, 0xB10C + n as u64);
        let sv = state_from(n, &amps);
        for q in 0..n {
            let got = qsim::measure::bloch_vector(&sv, q).unwrap();
            let want = naive_bloch(&amps, q);
            for (axis, (g, w)) in got.iter().zip(want.iter()).enumerate() {
                assert_close(*g, *w, &format!("bloch axis {axis} of qubit {q}, n={n}"));
            }
        }
    }
}

#[test]
fn bloch_vector_is_a_unit_arrow_for_an_unentangled_qubit() {
    // |+> on qubit 0, |0> elsewhere: qubit 0 points along +X at full length, and
    // every other qubit points at the north pole.
    let mut sim = Simulator::new(3).unwrap();
    sim.apply_named("h", &[0], &[]).unwrap();
    let [x, y, z] = sim.bloch_vector(0).unwrap();
    assert_close(x, 1.0, "<X> of |+>");
    assert_close(y, 0.0, "<Y> of |+>");
    assert_close(z, 0.0, "<Z> of |+>");
    for q in 1..3 {
        let [_, _, z] = sim.bloch_vector(q).unwrap();
        assert_close(z, 1.0, &format!("<Z> of untouched qubit {q}"));
    }
}

#[test]
fn bloch_vector_collapses_to_the_origin_under_entanglement() {
    // Both halves of a Bell pair have no state of their own: the arrow has zero
    // length even though the register as a whole is perfectly pure.
    let mut sim = Simulator::new(2).unwrap();
    sim.prepare_bell().unwrap();
    assert_close(sim.norm(), 1.0, "norm of a Bell pair");
    for q in 0..2 {
        let [x, y, z] = sim.bloch_vector(q).unwrap();
        let r = (x * x + y * y + z * z).sqrt();
        assert_close(r, 0.0, &format!("bloch radius of Bell qubit {q}"));
    }
}

#[test]
fn bloch_vector_tracks_a_rotation_about_y() {
    // RY(theta)|0> sits at angle theta from the north pole in the XZ plane.
    for k in 0..8 {
        let theta = std::f64::consts::PI * k as f64 / 4.0;
        let mut sim = Simulator::new(1).unwrap();
        sim.apply_named("ry", &[0], &[theta]).unwrap();
        let [x, y, z] = sim.bloch_vector(0).unwrap();
        assert_close(x, theta.sin(), &format!("<X> at theta={theta}"));
        assert_close(y, 0.0, &format!("<Y> at theta={theta}"));
        assert_close(z, theta.cos(), &format!("<Z> at theta={theta}"));
    }
}

#[test]
fn bloch_vector_rejects_a_qubit_out_of_range() {
    let sim = Simulator::new(2).unwrap();
    assert!(sim.bloch_vector(2).is_err(), "qubit 2 of a 2-qubit register");
}

#[test]
fn top_amplitudes_matches_a_full_sort() {
    for n in 1..=6u32 {
        let amps = random_state(n, 0x7013 + n as u64);
        let sv = state_from(n, &amps);
        // The reference: sort everything, which is exactly what the streaming
        // version must never do.
        let mut all: Vec<(usize, f64)> =
            amps.iter().enumerate().map(|(i, a)| (i, a.norm_sqr())).collect();
        all.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap().then(a.0.cmp(&b.0)));

        for k in [1usize, 3, 8, 1 << n, (1 << n) + 5] {
            let got = qsim::measure::top_amplitudes(&sv, k);
            let want = k.min(1 << n);
            assert_eq!(got.len(), want, "top_amplitudes({k}) length for n={n}");
            // Compare probabilities rather than indices: equal probabilities may
            // legitimately come back in either order.
            for (rank, (_, a)) in got.iter().enumerate() {
                assert_close(
                    a.norm_sqr(),
                    all[rank].1,
                    &format!("probability at rank {rank} of top {k}, n={n}"),
                );
            }
            // Every returned index must carry the amplitude it claims.
            for (i, a) in &got {
                assert_states_close(
                    &[*a],
                    &[amps[*i as usize]],
                    &format!("amplitude reported for index {i}, n={n}"),
                );
            }
        }
    }
}

#[test]
fn top_amplitudes_skips_states_with_no_amplitude() {
    // A GHZ state occupies exactly two of its 2^n basis states, so asking for
    // more than two must not pad the list with zeros.
    let mut sim = Simulator::new(5).unwrap();
    sim.prepare_ghz().unwrap();
    let top = sim.top_amplitudes(8);
    assert_eq!(top.len(), 2, "occupied states in a 5-qubit GHZ state");
    let mut indices: Vec<u64> = top.iter().map(|(i, _)| *i).collect();
    indices.sort_unstable();
    assert_eq!(indices, vec![0, 31], "GHZ occupies |00000> and |11111>");
    assert!(qsim::measure::top_amplitudes(&StateVector::try_new(3).unwrap(), 0).is_empty());
}

#[test]
fn top_amplitudes_finds_the_marked_state_after_grover() {
    let mut sim = Simulator::new(6).unwrap();
    let marked = 41usize;
    sim.run_grover(marked, -1).unwrap();
    let top = sim.top_amplitudes(1);
    assert_eq!(top[0].0, marked as u64, "peak after Grover");
}

/// Two-qubit reduced density matrix, built the obvious way.
fn naive_reduced_two(amps: &[C], a: u32, b: u32) -> [f64; 32] {
    let ba = 1usize << a;
    let bb = 1usize << b;
    let mut rho = [0.0f64; 32];
    for (i, x) in amps.iter().enumerate() {
        let k = usize::from(i & ba != 0) | (usize::from(i & bb != 0) << 1);
        for (j, y) in amps.iter().enumerate() {
            // Only pairs that agree on every *other* qubit contribute.
            if (i & !ba & !bb) != (j & !ba & !bb) {
                continue;
            }
            let l = usize::from(j & ba != 0) | (usize::from(j & bb != 0) << 1);
            let at = 2 * (k * 4 + l);
            rho[at] += x.re * y.re + x.im * y.im;
            rho[at + 1] += x.im * y.re - x.re * y.im;
        }
    }
    rho
}

#[test]
fn reduced_two_matches_naive_reference() {
    for n in 2..=5u32 {
        let amps = random_state(n, 0x2D0 + n as u64);
        let sv = state_from(n, &amps);
        for a in 0..n {
            for b in 0..n {
                if a == b {
                    assert!(qsim::measure::reduced_two(&sv, a, b).is_err(), "a == b");
                    continue;
                }
                let got = qsim::measure::reduced_two(&sv, a, b).unwrap();
                let want = naive_reduced_two(&amps, a, b);
                for (idx, (g, w)) in got.iter().zip(want.iter()).enumerate() {
                    assert_close(*g, *w, &format!("rho[{idx}] for ({a},{b}), n={n}"));
                }
            }
        }
    }
}

#[test]
fn reduced_two_has_the_marginals_on_its_diagonal() {
    // Tracing out either qubit of the pair must give back the one-qubit matrix,
    // which ties reduced_two to reduced_one rather than only to its own naive twin.
    let amps = random_state(4, 0x11FE);
    let sv = state_from(4, &amps);
    for a in 0..4u32 {
        for b in 0..4u32 {
            if a == b {
                continue;
            }
            let rho = qsim::measure::reduced_two(&sv, a, b).unwrap();
            let diag = |k: usize| rho[2 * (k * 4 + k)];
            // Summing over qubit b's value leaves qubit a's marginal.
            let a1 = diag(1) + diag(3);
            let [_, _, _, want_a] = qsim::measure::reduced_one(&sv, a).unwrap();
            assert_close(a1, want_a, &format!("P({a}=1) from the pair ({a},{b})"));
            let b1 = diag(2) + diag(3);
            let [_, _, _, want_b] = qsim::measure::reduced_one(&sv, b).unwrap();
            assert_close(b1, want_b, &format!("P({b}=1) from the pair ({a},{b})"));
            assert_close(
                diag(0) + diag(1) + diag(2) + diag(3),
                1.0,
                &format!("trace of the pair ({a},{b})"),
            );
        }
    }
}

#[test]
fn reduced_two_of_a_bell_pair_is_the_bell_projector() {
    // (|00> + |11>)/sqrt(2): the only non-zero entries are the four corners of
    // the 00/11 block, each exactly 1/2 with no imaginary part.
    let mut sim = Simulator::new(2).unwrap();
    sim.prepare_bell().unwrap();
    let rho = sim.reduced_two(0, 1).unwrap();
    for k in 0..4usize {
        for l in 0..4usize {
            let at = 2 * (k * 4 + l);
            let want = if (k == 0 || k == 3) && (l == 0 || l == 3) { 0.5 } else { 0.0 };
            assert_close(rho[at], want, &format!("Re rho[{k}][{l}]"));
            assert_close(rho[at + 1], 0.0, &format!("Im rho[{k}][{l}]"));
        }
    }
}
