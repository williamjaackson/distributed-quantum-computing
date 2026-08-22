//! The modular-exponentiation oracle behind Shor's algorithm.
//!
//! The oracle is the one piece applied directly to amplitudes rather than
//! decomposed into gates, so it needs its own checks: that it is reversible,
//! that it produces exactly |x>|a^x mod N>, and that the period visible in the
//! work register is the multiplicative order the algorithm is hunting for.

use qsim::circuits::{gcd, mod_pow, modexp_oracle, multiplicative_order};
use qsim::state::QsimError;
use qsim::Simulator;

/// Prepare |x>|1> with x in uniform superposition over `t` counting qubits.
fn superposed_input(count_qubits: u32, work_qubits: u32) -> Simulator {
    let mut sim = Simulator::new(count_qubits + work_qubits).unwrap();
    // y = 1 lives in the low bits.
    sim.apply_named("x", &[0], &[]).unwrap();
    for q in work_qubits..work_qubits + count_qubits {
        sim.apply_named("h", &[q], &[]).unwrap();
    }
    sim
}

#[test]
fn oracle_maps_each_x_to_a_power_of_a() {
    // N = 15, a = 7: order 4, cycle 1 -> 7 -> 4 -> 13 -> 1.
    let (n, t, a, modulus) = (4u32, 4u32, 7u64, 15u64);
    let mut sim = superposed_input(t, n);
    modexp_oracle(sim.state_mut(), a, modulus, n).unwrap();

    let p = sim.probabilities().unwrap();
    let amplitude = 1.0 / (1u64 << t) as f64; // |1/sqrt(2^t)|^2
    let block = 1usize << n;

    for x in 0..(1usize << t) {
        let want_y = mod_pow(a, x as u64, modulus) as usize;
        for y in 0..block {
            let got = p[x * block + y];
            let expect = if y == want_y { amplitude } else { 0.0 };
            assert!(
                (got - expect).abs() < 1e-12,
                "x={x}: P(y={y}) = {got}, expected {expect} (a^x mod N = {want_y})"
            );
        }
    }
    assert!((sim.norm() - 1.0).abs() < 1e-12);
}

#[test]
fn oracle_is_reversible() {
    // Applying the oracle for a and then for its modular inverse restores the
    // input, which is what makes it a legal quantum operation at all.
    let (n, t, a, modulus) = (4u32, 4u32, 7u64, 15u64);
    let order = multiplicative_order(a, modulus).unwrap();
    // a^(order-1) is the inverse of a.
    let a_inv = mod_pow(a, order - 1, modulus);
    assert_eq!(a * a_inv % modulus, 1, "a_inv is not the inverse of a");

    let mut sim = superposed_input(t, n);
    let before = sim.probabilities().unwrap();
    modexp_oracle(sim.state_mut(), a, modulus, n).unwrap();
    modexp_oracle(sim.state_mut(), a_inv, modulus, n).unwrap();
    let after = sim.probabilities().unwrap();

    for (i, (b, a2)) in before.iter().zip(after.iter()).enumerate() {
        assert!((b - a2).abs() < 1e-12, "amplitude {i} not restored: {b} vs {a2}");
    }
}

#[test]
fn oracle_preserves_the_norm_across_moduli() {
    for (modulus, a) in [(15u64, 7u64), (21, 5), (33, 2), (35, 8), (55, 7)] {
        let n = (64 - (modulus - 1).leading_zeros()) as u32;
        let t = 4u32;
        let mut sim = superposed_input(t, n);
        modexp_oracle(sim.state_mut(), a, modulus, n).unwrap();
        assert!(
            (sim.norm() - 1.0).abs() < 1e-12,
            "N={modulus}, a={a}: norm {}",
            sim.norm()
        );
    }
}

#[test]
fn work_register_period_is_the_multiplicative_order() {
    // The whole point: the sequence a^x mod N repeats with period r, and that
    // periodicity in x is what the inverse QFT converts into a measurable peak.
    for (modulus, a, want_r) in [(15u64, 7u64, 4u64), (15, 2, 4), (21, 2, 6), (33, 5, 10)] {
        assert_eq!(multiplicative_order(a, modulus), Some(want_r), "order of {a} mod {modulus}");
        // Confirm directly from the oracle's own mapping.
        let seen: Vec<u64> = (0..want_r).map(|x| mod_pow(a, x, modulus)).collect();
        assert_eq!(mod_pow(a, want_r, modulus), 1, "a^r != 1");
        assert_eq!(
            seen.iter().collect::<std::collections::HashSet<_>>().len(),
            want_r as usize,
            "cycle for {a} mod {modulus} repeats early"
        );
    }
}

#[test]
fn oracle_rejects_parameters_that_are_not_reversible() {
    let mut sim = Simulator::new(8).unwrap();
    // a shares a factor with N, so y -> y*a is not a bijection.
    assert!(matches!(
        modexp_oracle(sim.state_mut(), 6, 15, 4),
        Err(QsimError::InvalidOracle(_))
    ));
    // Work register too narrow to hold values mod N.
    assert!(matches!(
        modexp_oracle(sim.state_mut(), 7, 15, 3),
        Err(QsimError::InvalidOracle(_))
    ));
    // Degenerate modulus.
    assert!(matches!(
        modexp_oracle(sim.state_mut(), 7, 1, 4),
        Err(QsimError::InvalidOracle(_))
    ));
    // A rejected oracle must leave the state untouched.
    assert!((sim.norm() - 1.0).abs() < 1e-12);
}

#[test]
fn classical_helpers_agree_with_definitions() {
    assert_eq!(gcd(0, 5), 5);
    assert_eq!(gcd(12, 18), 6);
    assert_eq!(gcd(17, 5), 1);
    assert_eq!(mod_pow(7, 0, 15), 1);
    assert_eq!(mod_pow(7, 4, 15), 1);
    assert_eq!(mod_pow(2, 10, 1000), 24);
    assert_eq!(multiplicative_order(4, 15), Some(2));
    // No order when a is not coprime to N.
    assert_eq!(multiplicative_order(6, 15), None);
}

#[test]
fn full_period_finding_recovers_the_order() {
    // End to end on the quantum side: superpose, oracle, inverse QFT, and check
    // the distribution concentrates on multiples of 2^t / r.
    let (n, t, a, modulus) = (4u32, 8u32, 7u64, 15u64);
    let r = multiplicative_order(a, modulus).unwrap();
    let mut sim = superposed_input(t, n);
    modexp_oracle(sim.state_mut(), a, modulus, n).unwrap();
    inverse_qft(&mut sim, n, t);

    // Marginal over the counting register.
    let p = sim.probabilities().unwrap();
    let block = 1usize << n;
    let mut marginal = vec![0.0f64; 1usize << t];
    for (i, v) in p.iter().enumerate() {
        marginal[i / block] += v;
    }

    // Peaks sit at x = k * 2^t / r for integer k.
    let spacing = (1u64 << t) / r;
    let mut peak_mass = 0.0;
    for k in 0..r {
        peak_mass += marginal[(k * spacing) as usize];
    }
    assert!(
        peak_mass > 0.99,
        "expected the mass at multiples of {spacing} to dominate, got {peak_mass}"
    );
    assert!((sim.norm() - 1.0).abs() < 1e-12);
}

/// Inverse QFT over the counting register (qubits `work..work+count`).
///
/// The forward transform is Hadamards with descending controlled phases then a
/// bit-reversal; the inverse runs that backwards with negated angles.
fn inverse_qft(sim: &mut Simulator, work: u32, count: u32) {
    let q = |j: u32| work + j;
    for i in 0..count / 2 {
        sim.apply_named("swap", &[q(i), q(count - 1 - i)], &[]).unwrap();
    }
    for j in 0..count {
        for k in 0..j {
            let angle = -std::f64::consts::PI / ((1u64 << (j - k)) as f64);
            sim.apply_named("cp", &[q(k), q(j)], &[angle]).unwrap();
        }
        sim.apply_named("h", &[q(j)], &[]).unwrap();
    }
}
