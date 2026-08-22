//! `qsim` — a quantum circuit state-vector simulator for the browser.
//!
//! The API comes in two layers:
//!
//! * [`Simulator`] is plain Rust and returns [`QsimError`]. All the behaviour
//!   lives here, so `cargo test` on the host exercises the real code paths —
//!   including the error paths.
//! * [`JsSimulator`] is a thin `wasm-bindgen` wrapper that renames methods to
//!   camelCase and converts errors to `JsValue`. It is deliberately logic-free:
//!   a `JsValue` cannot be constructed off wasm32 (it panics, and the generated
//!   shims are `extern "C"` so the panic aborts rather than unwinds), which would
//!   make any error path untestable natively.

pub mod bench;
pub mod circuits;
pub mod complex;
pub mod gates;
pub mod measure;
pub mod rng;
pub mod state;

use complex::C;
use gates::Gate;
use rng::Rng;
use state::{QsimError, StateVector};
use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------------------
// Gate name dispatch
// ---------------------------------------------------------------------------

/// A parsed operation: a single-qubit unitary plus a control count, or a swap.
///
/// Folding every controlled gate into "unitary + N controls" means one kernel
/// family covers CNOT, CZ, controlled-phase and Toffoli, and the JS side needs
/// no per-gate binding — it passes a name, the qubits, and any angles.
enum Op {
    Unitary { gate: Gate, controls: usize },
    Swap,
}

fn param(params: &[f64], i: usize, name: &str, needed: usize) -> Result<f64, QsimError> {
    params
        .get(i)
        .copied()
        .ok_or_else(|| QsimError::MissingParams {
            gate: name.to_string(),
            expected: needed,
            got: params.len(),
        })
}

fn parse_op(name: &str, params: &[f64]) -> Result<Op, QsimError> {
    let lower = name.to_ascii_lowercase();
    let n = lower.as_str();

    let fixed = match n {
        "h" => Some(Gate::H),
        "x" => Some(Gate::X),
        "y" => Some(Gate::Y),
        "z" => Some(Gate::Z),
        "s" => Some(Gate::S),
        "sdg" => Some(Gate::Sdg),
        "t" => Some(Gate::T),
        "tdg" => Some(Gate::Tdg),
        _ => None,
    };
    if let Some(g) = fixed {
        return Ok(Op::Unitary { gate: g, controls: 0 });
    }

    // Rotations and phase shifts, one angle. The leading `c` marks the
    // controlled variant, which reuses the same base gate.
    let one_angle = matches!(
        n,
        "rx" | "ry" | "rz" | "p" | "phase" | "crx" | "cry" | "crz" | "cp" | "cphase"
    );
    if one_angle {
        let theta = param(params, 0, n, 1)?;
        let base = match n {
            "rx" | "crx" => Gate::RX(theta),
            "ry" | "cry" => Gate::RY(theta),
            "rz" | "crz" => Gate::RZ(theta),
            _ => Gate::P(theta),
        };
        let controls = if n.starts_with('c') { 1 } else { 0 };
        return Ok(Op::Unitary { gate: base, controls });
    }

    match n {
        "u3" | "u" => Ok(Op::Unitary {
            gate: Gate::U3(
                param(params, 0, n, 3)?,
                param(params, 1, n, 3)?,
                param(params, 2, n, 3)?,
            ),
            controls: 0,
        }),
        "cx" | "cnot" => Ok(Op::Unitary { gate: Gate::X, controls: 1 }),
        "cy" => Ok(Op::Unitary { gate: Gate::Y, controls: 1 }),
        "cz" => Ok(Op::Unitary { gate: Gate::Z, controls: 1 }),
        "ch" => Ok(Op::Unitary { gate: Gate::H, controls: 1 }),
        "ccx" | "toffoli" => Ok(Op::Unitary { gate: Gate::X, controls: 2 }),
        "ccz" => Ok(Op::Unitary { gate: Gate::Z, controls: 2 }),
        "swap" => Ok(Op::Swap),
        _ => Err(QsimError::UnknownGate(name.to_string())),
    }
}

/// Every gate name [`Simulator::apply_named`] understands, for UI palettes.
pub const GATE_NAMES: &[&str] = &[
    "h", "x", "y", "z", "s", "sdg", "t", "tdg", "rx", "ry", "rz", "p", "u3", "cx", "cy", "cz",
    "ch", "crx", "cry", "crz", "cp", "ccx", "ccz", "swap",
];

// ---------------------------------------------------------------------------
// Simulator — the pure-Rust API
// ---------------------------------------------------------------------------

pub struct Simulator {
    sv: StateVector,
    rng: Rng,
}

impl Simulator {
    /// Allocate an `n_qubits` register in |00...0>.
    ///
    /// Returns `Err` rather than panicking when the allocation is refused, so the
    /// capacity probe can walk `n` upward and catch the ceiling.
    pub fn new(n_qubits: u32) -> Result<Simulator, QsimError> {
        Ok(Simulator {
            sv: StateVector::try_new(n_qubits)?,
            rng: Rng::new(0x5EED),
        })
    }

    pub fn n_qubits(&self) -> u32 {
        self.sv.n_qubits()
    }

    pub fn num_amplitudes(&self) -> usize {
        self.sv.len()
    }

    pub fn memory_bytes(&self) -> u64 {
        state::memory_bytes_required(self.sv.n_qubits())
    }

    pub fn reset(&mut self) {
        self.sv.reset();
    }

    pub fn set_seed(&mut self, seed: u64) {
        self.rng = Rng::new(seed);
    }

    /// Apply a named gate. `qubits` lists controls first, then the target.
    pub fn apply_named(
        &mut self,
        name: &str,
        qubits: &[u32],
        params: &[f64],
    ) -> Result<(), QsimError> {
        match parse_op(name, params)? {
            Op::Swap => {
                if qubits.len() != 2 {
                    return Err(QsimError::WrongArity {
                        gate: name.to_string(),
                        expected: 2,
                        got: qubits.len(),
                    });
                }
                gates::apply_swap(&mut self.sv, qubits[0], qubits[1])
            }
            Op::Unitary { gate, controls } => {
                if qubits.len() != controls + 1 {
                    return Err(QsimError::WrongArity {
                        gate: name.to_string(),
                        expected: controls + 1,
                        got: qubits.len(),
                    });
                }
                let (ctrl, target) = qubits.split_at(controls);
                gates::apply_controlled(&mut self.sv, gate, ctrl, target[0])
            }
        }
    }

    /// Total probability — 1.0 for any correct unitary sequence.
    pub fn norm(&self) -> f64 {
        self.sv.norm()
    }

    pub fn probabilities(&self) -> Result<Vec<f64>, QsimError> {
        measure::probabilities(&self.sv)
    }

    pub fn amplitudes(&self) -> Result<Vec<f64>, QsimError> {
        measure::amplitudes_flat(&self.sv)
    }

    pub fn probability_of_one(&self, qubit: u32) -> Result<f64, QsimError> {
        measure::probability_of_one(&self.sv, qubit)
    }

    pub fn expectation_z(&self, qubit: u32) -> Result<f64, QsimError> {
        measure::expectation_z(&self.sv, qubit)
    }

    /// Measure one qubit, collapsing the state onto the observed outcome.
    pub fn measure(&mut self, qubit: u32) -> Result<u8, QsimError> {
        measure::measure(&mut self.sv, qubit, &mut self.rng)
    }

    /// Sample without collapsing, flattened to `[state, count, state, count, ...]`.
    pub fn sample_flat(&self, shots: u32, seed: u64) -> Vec<f64> {
        let pairs = measure::sample(&self.sv, shots, seed);
        let mut out = Vec::with_capacity(pairs.len() * 2);
        for (idx, count) in pairs {
            out.push(idx as f64);
            out.push(count as f64);
        }
        out
    }

    /// Run `layers` of the benchmark workload; returns the gates applied.
    /// Timing is taken on the caller's side around this call.
    pub fn bench_layers(&mut self, layers: u32) -> u64 {
        bench::bench_layers(&mut self.sv, layers)
    }

    pub fn prepare_uniform(&mut self) -> Result<(), QsimError> {
        circuits::uniform(&mut self.sv)
    }

    pub fn prepare_bell(&mut self) -> Result<(), QsimError> {
        circuits::bell(&mut self.sv)
    }

    pub fn prepare_ghz(&mut self) -> Result<(), QsimError> {
        circuits::ghz(&mut self.sv)
    }

    pub fn apply_qft(&mut self) -> Result<(), QsimError> {
        circuits::qft(&mut self.sv)
    }

    /// Run Grover's search for `marked`. A negative `iterations` selects the
    /// optimal count. Returns the iterations performed.
    pub fn run_grover(&mut self, marked: usize, iterations: i32) -> Result<u32, QsimError> {
        let iters = if iterations < 0 {
            circuits::grover_iterations(self.sv.n_qubits())
        } else {
            iterations as u32
        };
        circuits::grover(&mut self.sv, marked, iters)?;
        Ok(iters)
    }

    /// Teleport `U3(theta, phi, 0)|0>` from qubit 0 to qubit 2. Returns the two
    /// measured correction bits.
    pub fn teleport(&mut self, theta: f64, phi: f64) -> Result<(u8, u8), QsimError> {
        circuits::teleport(&mut self.sv, theta, phi, &mut self.rng)
    }

    /// Collapse the register onto a single basis state — the usual starting point
    /// for checking a transform against its analytic form.
    pub fn set_basis_state(&mut self, index: usize) -> Result<(), QsimError> {
        if index >= self.sv.len() {
            return Err(QsimError::InvalidQubit {
                qubit: index as u32,
                n_qubits: self.sv.n_qubits(),
            });
        }
        self.sv.reset();
        self.sv.amps_mut()[0] = C::ZERO;
        self.sv.amps_mut()[index] = C::ONE;
        Ok(())
    }

    pub fn state(&self) -> &StateVector {
        &self.sv
    }

    pub fn state_mut(&mut self) -> &mut StateVector {
        &mut self.sv
    }
}

// ---------------------------------------------------------------------------
// JsSimulator — wasm-bindgen wrapper, no logic of its own
// ---------------------------------------------------------------------------

fn js_err(e: QsimError) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[wasm_bindgen(js_name = Simulator)]
pub struct JsSimulator {
    inner: Simulator,
}

#[wasm_bindgen(js_class = Simulator)]
impl JsSimulator {
    #[wasm_bindgen(constructor)]
    pub fn new(n_qubits: u32) -> Result<JsSimulator, JsValue> {
        Ok(JsSimulator {
            inner: Simulator::new(n_qubits).map_err(js_err)?,
        })
    }

    #[wasm_bindgen(getter, js_name = nQubits)]
    pub fn n_qubits(&self) -> u32 {
        self.inner.n_qubits()
    }

    /// Number of amplitudes (2^n) as f64 — exact well past the 27-qubit ceiling,
    /// and avoids forcing BigInt on the JS side.
    #[wasm_bindgen(getter, js_name = numAmplitudes)]
    pub fn num_amplitudes(&self) -> f64 {
        self.inner.num_amplitudes() as f64
    }

    #[wasm_bindgen(getter, js_name = memoryBytes)]
    pub fn memory_bytes(&self) -> f64 {
        self.inner.memory_bytes() as f64
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }

    #[wasm_bindgen(js_name = setSeed)]
    pub fn set_seed(&mut self, seed: f64) {
        self.inner.set_seed(seed as u64);
    }

    #[wasm_bindgen(js_name = applyGate)]
    pub fn apply_gate(
        &mut self,
        name: &str,
        qubits: Vec<u32>,
        params: Vec<f64>,
    ) -> Result<(), JsValue> {
        self.inner.apply_named(name, &qubits, &params).map_err(js_err)
    }

    pub fn norm(&self) -> f64 {
        self.inner.norm()
    }

    /// Probability of each basis state. Errors past `fullArrayQubitLimit()`
    /// rather than risk an out-of-memory abort.
    pub fn probabilities(&self) -> Result<Vec<f64>, JsValue> {
        self.inner.probabilities().map_err(js_err)
    }

    /// Amplitudes as `[re0, im0, re1, im1, ...]`.
    pub fn amplitudes(&self) -> Result<Vec<f64>, JsValue> {
        self.inner.amplitudes().map_err(js_err)
    }

    #[wasm_bindgen(js_name = probabilityOfOne)]
    pub fn probability_of_one(&self, qubit: u32) -> Result<f64, JsValue> {
        self.inner.probability_of_one(qubit).map_err(js_err)
    }

    #[wasm_bindgen(js_name = expectationZ)]
    pub fn expectation_z(&self, qubit: u32) -> Result<f64, JsValue> {
        self.inner.expectation_z(qubit).map_err(js_err)
    }

    pub fn measure(&mut self, qubit: u32) -> Result<u32, JsValue> {
        self.inner.measure(qubit).map(|b| b as u32).map_err(js_err)
    }

    #[wasm_bindgen(js_name = sampleFlat)]
    pub fn sample_flat(&self, shots: u32, seed: f64) -> Vec<f64> {
        self.inner.sample_flat(shots, seed as u64)
    }

    #[wasm_bindgen(js_name = benchLayers)]
    pub fn bench_layers(&mut self, layers: u32) -> f64 {
        self.inner.bench_layers(layers) as f64
    }

    #[wasm_bindgen(js_name = prepareUniform)]
    pub fn prepare_uniform(&mut self) -> Result<(), JsValue> {
        self.inner.prepare_uniform().map_err(js_err)
    }

    #[wasm_bindgen(js_name = prepareBell)]
    pub fn prepare_bell(&mut self) -> Result<(), JsValue> {
        self.inner.prepare_bell().map_err(js_err)
    }

    #[wasm_bindgen(js_name = prepareGhz)]
    pub fn prepare_ghz(&mut self) -> Result<(), JsValue> {
        self.inner.prepare_ghz().map_err(js_err)
    }

    #[wasm_bindgen(js_name = applyQft)]
    pub fn apply_qft(&mut self) -> Result<(), JsValue> {
        self.inner.apply_qft().map_err(js_err)
    }

    /// Run Grover's search. Pass `iterations = -1` for the optimal count.
    #[wasm_bindgen(js_name = runGrover)]
    pub fn run_grover(&mut self, marked: f64, iterations: i32) -> Result<u32, JsValue> {
        self.inner
            .run_grover(marked as usize, iterations)
            .map_err(js_err)
    }

    /// Teleport a state from qubit 0 to qubit 2. Returns the correction bits
    /// packed as `m0 | (m1 << 1)`.
    pub fn teleport(&mut self, theta: f64, phi: f64) -> Result<u32, JsValue> {
        let (m0, m1) = self.inner.teleport(theta, phi).map_err(js_err)?;
        Ok(m0 as u32 | ((m1 as u32) << 1))
    }

    #[wasm_bindgen(js_name = setBasisState)]
    pub fn set_basis_state(&mut self, index: f64) -> Result<(), JsValue> {
        self.inner.set_basis_state(index as usize).map_err(js_err)
    }
}

// ---------------------------------------------------------------------------
// Module-level helpers for the capacity probe
// ---------------------------------------------------------------------------

/// Largest qubit count this build can address (27 on wasm32).
#[wasm_bindgen(js_name = maxQubits)]
pub fn max_qubits() -> u32 {
    state::MAX_QUBITS
}

/// Bytes the state vector for `n_qubits` would need, whether or not it fits.
#[wasm_bindgen(js_name = memoryBytesRequired)]
pub fn memory_bytes_required(n_qubits: u32) -> f64 {
    state::memory_bytes_required(n_qubits) as f64
}

/// Try to allocate `n_qubits` and immediately release it.
///
/// The probe calls this before running a timed workload, so hitting the ceiling
/// does not leave a failed run in the timing series.
#[wasm_bindgen(js_name = canAllocate)]
pub fn can_allocate(n_qubits: u32) -> bool {
    StateVector::try_new(n_qubits).is_ok()
}

#[wasm_bindgen(js_name = gatesPerLayer)]
pub fn gates_per_layer(n_qubits: u32) -> f64 {
    bench::gates_per_layer(n_qubits) as f64
}

/// Upper bound on the register size for which full-state arrays are returned.
#[wasm_bindgen(js_name = fullArrayQubitLimit)]
pub fn full_array_qubit_limit() -> u32 {
    measure::FULL_ARRAY_QUBIT_LIMIT
}

#[wasm_bindgen(js_name = gateNames)]
pub fn gate_names() -> Vec<String> {
    GATE_NAMES.iter().map(|s| s.to_string()).collect()
}

#[wasm_bindgen(js_name = engineVersion)]
pub fn engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
