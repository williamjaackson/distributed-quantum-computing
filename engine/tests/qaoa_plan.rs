//! The planned QAOA circuit must be the circuit `qaoa::run_qaoa` runs.
//!
//! `qaoa_plan` exists so a caller can step through the circuit instead of only
//! sampling its output, and the moment it drifts from `run_qaoa` it stops being
//! a plan and becomes a second, quietly different implementation. So every check
//! here is the same comparison: build a config, run it both ways, and require
//! the two states to agree to the last bit.

use qsim::qaoa::{run_qaoa, EntitySpec, PenaltySpec, QaoaConfig};
use qsim::qaoa_plan::{encode, plan, Part};
use qsim::{dispatch, Simulator};

const TOL: f64 = 1e-13;

/// The instance from `qaoa.rs`'s own example: 20 W across four consumers.
fn power_grid() -> QaoaConfig {
    QaoaConfig {
        total_water: 20.0,
        gamma: 0.1,
        beta: 0.5,
        global_lambda: 10.0,
        weights: vec![1.0, 1.0, 1.0, 1.0, 1.0, 2.0, 4.0, 3.0, 1.0, 2.0, 4.0, 6.0],
        entities: vec![
            EntitySpec::new("Home1", vec![0, 1]),
            EntitySpec::new("Home2", vec![2, 3]),
            EntitySpec::new("Hospital", vec![4, 5, 6, 7]),
            EntitySpec::new("Factory", vec![8, 9, 10, 11]),
        ],
        penalties: vec![
            PenaltySpec::new("Hospital", vec![4, 5, 6, 7], 10.0, 5.0),
            PenaltySpec::new("Factory", vec![8, 9, 10, 11], 13.0, 5.0),
        ],
        shots: 1000,
        seed: 123456789,
    }
}

/// Apply a plan to a fresh register, the way a stepping caller would.
fn run_plan(config: &QaoaConfig) -> Simulator {
    let mut sim = Simulator::new(config.weights.len() as u32).expect("sim alloc");
    for gate in plan(config) {
        sim.apply_named(gate.name, &gate.qubits, &gate.params)
            .unwrap_or_else(|e| panic!("planned gate {} failed: {e}", gate.name));
    }
    sim
}

fn assert_same_state(config: &QaoaConfig, what: &str) {
    let mut theirs = Simulator::new(config.weights.len() as u32).expect("sim alloc");
    run_qaoa(&mut theirs, config);
    let planned = run_plan(config);

    let a = planned.state().amps();
    let b = theirs.state().amps();
    assert_eq!(a.len(), b.len(), "{what}: register size");
    for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
        assert!(
            (x.re - y.re).abs() < TOL && (x.im - y.im).abs() < TOL,
            "{what}: amplitude {i} planned ({}, {}) vs run_qaoa ({}, {})",
            x.re, x.im, y.re, y.im
        );
    }
    assert!((planned.norm() - 1.0).abs() < TOL, "{what}: norm {}", planned.norm());
}

#[test]
fn plan_matches_run_qaoa_on_the_power_grid() {
    assert_same_state(&power_grid(), "power grid, as configured");
}

#[test]
fn plan_matches_run_qaoa_across_the_parameter_space() {
    // The angles multiply every coefficient, so a sign or factor-of-two error
    // hides at one setting and not at another.
    for gamma in [0.0, 0.01, 0.1, 0.37] {
        for beta in [0.0, 0.25, 0.5, 1.1] {
            for global_lambda in [0.0, 1.0, 10.0] {
                let config = QaoaConfig { gamma, beta, global_lambda, ..power_grid() };
                assert_same_state(&config, &format!("γ={gamma} β={beta} λ={global_lambda}"));
            }
        }
    }
}

#[test]
fn plan_matches_run_qaoa_for_other_problem_shapes() {
    // A different width, different weights, and penalty sets that overlap, are
    // empty, or cover a single qubit — the shapes a generic runner has to take.
    let base = QaoaConfig {
        total_water: 7.0,
        gamma: 0.05,
        beta: 0.4,
        global_lambda: 3.0,
        weights: vec![1.0, 2.0, 3.0, 1.0, 4.0, 2.0],
        entities: vec![
            EntitySpec::new("A", vec![0, 1, 2]),
            EntitySpec::new("B", vec![3, 4, 5]),
        ],
        penalties: vec![],
        shots: 100,
        seed: 7,
    };

    let cases = vec![
        ("no penalties at all", vec![]),
        ("one single-qubit penalty", vec![PenaltySpec::new("A", vec![2], 3.0, 4.0)]),
        (
            "overlapping penalties",
            vec![
                PenaltySpec::new("A", vec![0, 1, 2], 4.0, 2.0),
                PenaltySpec::new("B", vec![2, 3, 4], 5.0, 1.5),
            ],
        ),
        (
            "the same qubits twice",
            vec![
                PenaltySpec::new("A", vec![0, 1], 2.0, 1.0),
                PenaltySpec::new("A again", vec![0, 1], 2.0, 3.0),
            ],
        ),
    ];
    for (what, penalties) in cases {
        let config = QaoaConfig { penalties, ..base.clone() };
        assert_same_state(&config, what);
    }
}

#[test]
fn the_plan_says_which_part_each_gate_belongs_to() {
    let config = power_grid();
    let gates = plan(&config);
    let n = config.weights.len();

    let count = |p: Part| gates.iter().filter(|g| g.part == p).count();
    assert_eq!(count(Part::Superpose), n, "one Hadamard per supply");
    assert_eq!(count(Part::Mixer), n, "one mixer rotation per supply");
    // The budget term couples every pair — three gates each — plus a diagonal.
    assert_eq!(count(Part::Budget), 3 * (n * (n - 1) / 2) + n, "budget term");
    for (i, penalty) in config.penalties.iter().enumerate() {
        let k = penalty.qubits.len();
        assert_eq!(
            count(Part::Penalty(i)),
            3 * (k * (k - 1) / 2) + k,
            "penalty {} ({})",
            i,
            penalty.name
        );
    }
    // 12 Hadamards, a 210-gate budget term (66 pairs at three gates each plus
    // twelve diagonals), 22 gates for each of the two demand terms, and 12 mixer
    // rotations. Every pair term is a CNOT · RZ · CNOT, which is what makes one
    // twelve-qubit round this long.
    assert_eq!(gates.len(), 278, "the power grid is 278 gates at one round");

    // Superpose first, mixer last: the phases have to be written before they can
    // be turned into probability.
    assert!(gates.iter().take(n).all(|g| g.part == Part::Superpose));
    assert!(gates.iter().rev().take(n).all(|g| g.part == Part::Mixer));
}

#[test]
fn every_planned_gate_is_one_the_engine_accepts() {
    for config in [power_grid(), QaoaConfig { beta: 0.0, ..power_grid() }] {
        for gate in plan(&config) {
            let op = dispatch::parse_op(gate.name, &gate.params)
                .unwrap_or_else(|e| panic!("{} is not a gate: {e}", gate.name));
            op.check_arity(gate.name, gate.qubits.len())
                .unwrap_or_else(|e| panic!("{} has the wrong arity: {e}", gate.name));
            assert!(
                dispatch::GATE_NAMES.contains(&gate.name),
                "{} is missing from GATE_NAMES, so it cannot be encoded",
                gate.name
            );
        }
    }
}

#[test]
fn the_encoding_round_trips() {
    let config = power_grid();
    let gates = plan(&config);
    let flat = encode(&gates);

    let mut at = 0usize;
    let take = |at: &mut usize| {
        let v = flat[*at];
        *at += 1;
        v
    };
    assert_eq!(take(&mut at) as usize, gates.len(), "gate count");
    for (index, want) in gates.iter().enumerate() {
        let name = dispatch::GATE_NAMES[take(&mut at) as usize];
        let tag = take(&mut at) as usize;
        let part_index = take(&mut at) as usize;
        let n_qubits = take(&mut at) as usize;
        let qubits: Vec<u32> = (0..n_qubits).map(|_| take(&mut at) as u32).collect();
        let n_params = take(&mut at) as usize;
        let params: Vec<f64> = (0..n_params).map(|_| take(&mut at)).collect();

        assert_eq!(name, want.name, "gate {index} name");
        assert_eq!(qubits, want.qubits, "gate {index} qubits");
        assert_eq!(params, want.params, "gate {index} params");
        assert_eq!((tag, part_index), want.part.encode(), "gate {index} part");
    }
    assert_eq!(at, flat.len(), "the encoding has no trailing bytes");
}
