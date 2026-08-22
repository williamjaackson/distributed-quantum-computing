//! The circuit [`crate::qaoa::run_qaoa`] runs, as data instead of as side effects.
//!
//! `run_qaoa` applies its gates straight to a `Simulator` and hands back a
//! histogram, which is the right shape for asking "what does this problem
//! sample to". It is the wrong shape for a caller that wants to *watch* the
//! circuit: a visualiser needs the gates one at a time, in order, with somewhere
//! to stop.
//!
//! So this plans the same circuit rather than running it, and
//! `plan_matches_run_qaoa` in `tests/qaoa_module.rs`-adjacent coverage asserts
//! the two produce the same state to the last bit. That test is the whole point
//! of the module: without it this is a second copy of the construction, and a
//! second copy is exactly what a visualiser must not have.
//!
//! Nothing about the objective function lives here either. `qaoa.rs` leaves
//! scoring to the caller deliberately, and the same reasoning applies twice
//! over: a plan is a circuit, and what makes one allocation better than another
//! is not.

use crate::qaoa::QaoaConfig;

/// Which part of the QAOA circuit a gate belongs to.
///
/// Carried through so a caller can label the stages without re-deriving the
/// structure from gate positions — the run is 100-odd gates and four of them
/// mean something quite different from the rest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    /// Hadamards: every allocation at once.
    Superpose,
    /// The global budget term, which couples every pair of supplies.
    Budget,
    /// One consumer's demand term; the index is into [`QaoaConfig::penalties`].
    Penalty(usize),
    /// The mixer, which turns the phases into probability.
    Mixer,
}

impl Part {
    /// `(tag, index)`, for a flat encoding.
    pub fn encode(self) -> (usize, usize) {
        match self {
            Part::Superpose => (0, 0),
            Part::Budget => (1, 0),
            Part::Penalty(i) => (2, i),
            Part::Mixer => (3, 0),
        }
    }
}

/// One gate of the planned circuit, in the engine's own calling convention.
#[derive(Clone, Debug, PartialEq)]
pub struct PlannedGate {
    pub name: &'static str,
    /// Controls first, then the target — as [`crate::dispatch::apply_named`] wants.
    pub qubits: Vec<u32>,
    pub params: Vec<f64>,
    pub part: Part,
}

impl PlannedGate {
    fn new(name: &'static str, qubits: Vec<u32>, params: Vec<f64>, part: Part) -> Self {
        PlannedGate { name, qubits, params, part }
    }
}

/// A ZZ rotation as the three gates a two-qubit-gate machine would run.
fn zz(i: u32, j: u32, angle: f64, part: Part) -> [PlannedGate; 3] {
    [
        PlannedGate::new("cx", vec![i, j], vec![], part),
        PlannedGate::new("rz", vec![j], vec![angle], part),
        PlannedGate::new("cx", vec![i, j], vec![], part),
    ]
}

/// Plan the circuit for `config`, gate by gate, in the order `run_qaoa` applies it.
///
/// The register is assumed to be exactly as wide as `config.weights`. It is the
/// only width that means anything: `run_qaoa` opens by putting *every* qubit of
/// the simulator into superposition, so a spare one would be superposed and then
/// never used, which is a configuration mistake rather than a case to support.
pub fn plan(config: &QaoaConfig) -> Vec<PlannedGate> {
    let n = config.weights.len();
    let mut gates = Vec::new();

    for q in 0..n {
        gates.push(PlannedGate::new("h", vec![q as u32], vec![], Part::Superpose));
    }

    // The global budget term. Diagonal entries land as the loop reaches `j == i`,
    // so the order is rz(0), zz(0, 1..), rz(1), zz(1, 2..) — matching `run_qaoa`,
    // which matters because these gates do not all commute in floating point.
    for i in 0..n {
        for j in 0..n {
            if i == j {
                let coeff = config.global_lambda
                    * (config.weights[i] * config.weights[i]
                        - 2.0 * config.total_water * config.weights[i]);
                let angle = -2.0 * config.gamma * coeff;
                gates.push(PlannedGate::new("rz", vec![i as u32], vec![angle], Part::Budget));
            } else if i < j {
                let coeff = 2.0 * config.global_lambda * config.weights[i] * config.weights[j];
                let angle = -2.0 * config.gamma * coeff;
                gates.extend(zz(i as u32, j as u32, angle, Part::Budget));
            }
        }
    }

    // One demand term per consumer that has one. Note which consumers *do*: the
    // config drives this, and a consumer with no penalty spec contributes nothing
    // to the phases at all, however much it is owed.
    for (index, penalty) in config.penalties.iter().enumerate() {
        let part = Part::Penalty(index);
        let qubits = &penalty.qubits;
        for a in 0..qubits.len() {
            let i = qubits[a];
            for b in (a + 1)..qubits.len() {
                let j = qubits[b];
                let coeff = 2.0 * penalty.multiplier * config.weights[i] * config.weights[j];
                let angle = -2.0 * config.gamma * coeff;
                gates.extend(zz(i as u32, j as u32, angle, part));
            }
            let coeff = penalty.multiplier
                * (config.weights[i] * config.weights[i]
                    - 2.0 * penalty.target * config.weights[i]);
            let angle = -2.0 * config.gamma * coeff;
            gates.push(PlannedGate::new("rz", vec![i as u32], vec![angle], part));
        }
    }

    for q in 0..n {
        gates.push(PlannedGate::new(
            "rx",
            vec![q as u32],
            vec![-2.0 * config.beta],
            Part::Mixer,
        ));
    }

    gates
}

/// Flatten a plan for transfer across the WASM boundary.
///
/// Layout, all `f64`: `[n_gates, then per gate:
/// name_id, part_tag, part_index, n_qubits, qubits..., n_params, params...]`,
/// where `name_id` indexes [`crate::dispatch::GATE_NAMES`] — the same list
/// `gateNames()` already hands to JS, so the consumer needs no second table.
pub fn encode(gates: &[PlannedGate]) -> Vec<f64> {
    let mut out = vec![gates.len() as f64];
    for g in gates {
        let name_id = crate::dispatch::GATE_NAMES
            .iter()
            .position(|n| *n == g.name)
            .expect("planned gate is in GATE_NAMES");
        let (tag, index) = g.part.encode();
        out.push(name_id as f64);
        out.push(tag as f64);
        out.push(index as f64);
        out.push(g.qubits.len() as f64);
        out.extend(g.qubits.iter().map(|q| *q as f64));
        out.push(g.params.len() as f64);
        out.extend(g.params.iter().copied());
    }
    out
}
