//! Generic QAOA runner for allocation-style problems.
//!
//! This module builds the QAOA circuit for the supplied weights and entity groupings,
//! applies the cost-layer and mixer layer, and returns the sampled basis-state histogram.
//! It intentionally does not encode a specific objective function or a fixed set of
//! weights/penalties; those are problem-specific and should be supplied by the caller
//! or implemented in a test harness.
//!
//! Example:
//! ```rust
//! use std::collections::HashMap;
//!
//! use rock::{
//!     qaoa::{run_qaoa, EntitySpec, PenaltySpec, QaoaConfig},
//!     Simulator,
//! };
//!
//! let mut sim = Simulator::new(12).unwrap();
//!
//! let config = QaoaConfig {
//!     total_water: 20.0,
//!     gamma: 0.1,
//!     beta: 0.5,
//!     global_lambda: 10.0,
//!     weights: vec![1.0, 1.0, 1.0, 1.0, 1.0, 2.0, 4.0, 3.0, 1.0, 2.0, 4.0, 6.0],
//!     entities: vec![
//!         EntitySpec::new("Home1", vec![0, 1]),
//!         EntitySpec::new("Home2", vec![2, 3]),
//!         EntitySpec::new("Hospital", vec![4, 5, 6, 7]),
//!         EntitySpec::new("Factory", vec![8, 9, 10, 11]),
//!     ],
//!     penalties: vec![
//!         PenaltySpec::new("Hospital", vec![4, 5, 6, 7], 10.0, 5.0),
//!         PenaltySpec::new("Factory", vec![8, 9, 10, 11], 13.0, 5.0),
//!     ],
//!     shots: 5000,
//!     seed: 123456789,
//! };
//!
//! let histogram: HashMap<usize, usize> = run_qaoa(&mut sim, &config);
//! println!("sampled histogram: {:?}", histogram);
//! ```
//!
//! The exact objective-function scoring is intentionally kept outside this module so
//! the library remains generic and the problem-specific check can live in a test file.

use std::collections::HashMap;

use crate::Simulator;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntitySpec {
    pub name: String,
    pub qubits: Vec<usize>,
}

impl EntitySpec {
    pub fn new(name: impl Into<String>, qubits: Vec<usize>) -> Self {
        Self {
            name: name.into(),
            qubits,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PenaltySpec {
    pub name: String,
    pub qubits: Vec<usize>,
    pub target: f64,
    pub multiplier: f64,
}

impl PenaltySpec {
    pub fn new(name: impl Into<String>, qubits: Vec<usize>, target: f64, multiplier: f64) -> Self {
        Self {
            name: name.into(),
            qubits,
            target,
            multiplier,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct QaoaConfig {
    pub total_water: f64,
    pub gamma: f64,
    pub beta: f64,
    pub global_lambda: f64,
    pub weights: Vec<f64>,
    pub entities: Vec<EntitySpec>,
    pub penalties: Vec<PenaltySpec>,
    pub shots: u32,
    pub seed: u64,
}

fn decode_allocation(state: usize, entities: &[EntitySpec], weights: &[f64]) -> Vec<(String, usize)> {
    let mut allocations = Vec::with_capacity(entities.len());
    for entity in entities {
        let mut total = 0usize;
        for &q in &entity.qubits {
            total += (((state >> q) & 1) as usize) * weights[q].round() as usize;
        }
        allocations.push((entity.name.clone(), total));
    }
    allocations
}

pub fn run_qaoa(sim: &mut Simulator, config: &QaoaConfig) -> HashMap<usize, usize> {
    let n = config.weights.len();
    sim.prepare_uniform().expect("prepare_uniform");

    for i in 0..n {
        for j in 0..n {
            if i == j {
                let coeff = config.global_lambda
                    * (config.weights[i] * config.weights[i]
                        - 2.0 * config.total_water * config.weights[i]);
                let angle = -2.0 * config.gamma * coeff;
                sim.apply_named("rz", &[i as u32], &[angle]).expect("global rz");
            } else if i < j {
                let coeff = 2.0 * config.global_lambda * config.weights[i] * config.weights[j];
                let angle = -2.0 * config.gamma * coeff;
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("global cx");
                sim.apply_named("rz", &[j as u32], &[angle]).expect("global zz-rz");
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("global cx");
            }
        }
    }

    for penalty in &config.penalties {
        let qubits = &penalty.qubits;
        for a in 0..qubits.len() {
            let i = qubits[a];
            for b in (a + 1)..qubits.len() {
                let j = qubits[b];
                let coeff = 2.0 * penalty.multiplier * config.weights[i] * config.weights[j];
                let angle = -2.0 * config.gamma * coeff;
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("penalty cx");
                sim.apply_named("rz", &[j as u32], &[angle]).expect("penalty rz");
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("penalty cx");
            }

            let coeff = penalty.multiplier
                * (config.weights[i] * config.weights[i]
                    - 2.0 * penalty.target * config.weights[i]);
            let angle = -2.0 * config.gamma * coeff;
            sim.apply_named("rz", &[i as u32], &[angle]).expect("penalty diagonal");
        }
    }

    for q in 0..n {
        sim.apply_named("rx", &[q as u32], &[-2.0 * config.beta]).expect("mixer");
    }

    let flat = sim.sample_flat(config.shots, config.seed);
    let mut histogram = HashMap::new();
    for pair in flat.chunks(2) {
        let state = pair[0] as usize;
        let count = pair[1] as usize;
        if count > 0 {
            *histogram.entry(state).or_insert(0) += count;
        }
    }

    histogram
}
