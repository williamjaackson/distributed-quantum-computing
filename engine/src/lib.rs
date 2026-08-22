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
pub mod dispatch;
pub mod gates;
pub mod measure;
pub mod qaoa;
pub mod rng;
pub mod shard;
pub mod state;

use complex::C;
use rng::Rng;
use state::{QsimError, StateVector};
use wasm_bindgen::prelude::*;

pub use dispatch::GATE_NAMES;

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
        dispatch::apply_named(&mut self.sv, name, qubits, params)
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

// ---------------------------------------------------------------------------
// Sharded execution bindings
// ---------------------------------------------------------------------------

/// One slice of a sharded state vector, for a worker to own.
///
/// # Pointer validity
///
/// [`JsShard::amps_offset`] and [`JsShard::scratch_offset`] are byte offsets into
/// this module's linear memory. Growing WASM memory detaches the old
/// `ArrayBuffer`, so any `Float64Array` view over it goes stale. Construct the
/// shard first, then take views — after that nothing here allocates, so the
/// views stay valid for the lifetime of the shard.
#[wasm_bindgen(js_name = Shard)]
pub struct JsShard {
    inner: shard::Shard,
}

#[wasm_bindgen(js_class = Shard)]
impl JsShard {
    #[wasm_bindgen(constructor)]
    pub fn new(local_qubits: u32, shard_bits: u32, index: u32) -> Result<JsShard, JsValue> {
        Ok(JsShard {
            inner: shard::Shard::try_new(local_qubits, shard_bits, index).map_err(js_err)?,
        })
    }

    #[wasm_bindgen(getter, js_name = localQubits)]
    pub fn local_qubits(&self) -> u32 {
        self.inner.local_qubits()
    }

    #[wasm_bindgen(getter, js_name = globalQubits)]
    pub fn global_qubits(&self) -> u32 {
        self.inner.global_qubits()
    }

    #[wasm_bindgen(getter, js_name = shardIndex)]
    pub fn shard_index(&self) -> u32 {
        self.inner.index()
    }

    /// Amplitudes in this slice.
    #[wasm_bindgen(getter, js_name = sliceAmplitudes)]
    pub fn slice_amplitudes(&self) -> f64 {
        self.inner.len() as f64
    }

    /// Byte offset of the amplitude array in linear memory.
    #[wasm_bindgen(getter, js_name = ampsOffset)]
    pub fn amps_offset(&self) -> u32 {
        self.inner.amps().as_ptr() as usize as u32
    }

    /// Byte offset of the exchange staging buffer.
    #[wasm_bindgen(getter, js_name = scratchOffset)]
    pub fn scratch_offset(&mut self) -> u32 {
        self.inner.scratch_mut().as_ptr() as usize as u32
    }

    #[wasm_bindgen(getter, js_name = blockAmplitudes)]
    pub fn block_amplitudes(&self) -> f64 {
        self.inner.block_amps() as f64
    }

    #[wasm_bindgen(getter, js_name = numBlocks)]
    pub fn num_blocks(&self) -> u32 {
        self.inner.num_blocks() as u32
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }

    /// Apply a planned local step: a base gate with an explicit control list, on
    /// local qubit indices.
    #[wasm_bindgen(js_name = applyLocalBase)]
    pub fn apply_local_base(
        &mut self,
        base: &str,
        params: Vec<f64>,
        controls: Vec<u32>,
        target: u32,
    ) -> Result<(), JsValue> {
        self.inner
            .apply_local_base(base, &params, &controls, target)
            .map_err(js_err)
    }

    /// Apply one block of a planned pair step. The partner's block must already
    /// have been written into the scratch buffer.
    #[wasm_bindgen(js_name = applyPair)]
    pub fn apply_pair(
        &mut self,
        base: &str,
        params: Vec<f64>,
        block: u32,
        is_low: bool,
        local_cmask: f64,
    ) -> Result<(), JsValue> {
        self.inner
            .apply_pair(base, &params, block as usize, is_low, local_cmask as usize)
            .map_err(js_err)
    }

    /// Fill with pseudorandom amplitudes and return this slice's probability mass.
    ///
    /// Capacity validation needs this: a freshly allocated slice is all zeros,
    /// and zero pages are nearly free (committed lazily, then compressed away),
    /// so an allocation can succeed at a size that could never really be
    /// computed on. Filling forces every page resident.
    #[wasm_bindgen(js_name = fillRandom)]
    pub fn fill_random(&mut self, seed: f64) -> f64 {
        self.inner.fill_random(seed as u64)
    }

    /// Multiply every amplitude by `factor`, to normalise after a filled slice.
    pub fn scale(&mut self, factor: f64) {
        self.inner.scale(factor);
    }

    /// This slice's share of the total probability; sum across shards for the norm.
    #[wasm_bindgen(js_name = probabilityMass)]
    pub fn probability_mass(&self) -> f64 {
        self.inner.probability_mass()
    }

    /// P(qubit = 1) over this slice only, for a *local* qubit.
    #[wasm_bindgen(js_name = localProbabilityOfOne)]
    pub fn local_probability_of_one(&self, qubit: u32) -> Result<f64, JsValue> {
        self.inner.local_probability_of_one(qubit).map_err(js_err)
    }

    /// Sample this slice's local distribution, flattened to
    /// `[local_index, count, ...]`. The orchestrator picks which shard to draw
    /// from in proportion to `probabilityMass`, which keeps the overall sample
    /// exact without ever forming the global distribution.
    #[wasm_bindgen(js_name = sampleLocalFlat)]
    pub fn sample_local_flat(&self, shots: u32, seed: f64) -> Vec<f64> {
        let pairs = measure::sample_unnormalised(self.inner.amps(), shots, seed as u64);
        let mut out = Vec::with_capacity(pairs.len() * 2);
        for (idx, count) in pairs {
            out.push(idx as f64);
            out.push(count as f64);
        }
        out
    }

    /// Probabilities across this slice. Guarded like the whole-state version.
    pub fn probabilities(&self) -> Result<Vec<f64>, JsValue> {
        if self.inner.local_qubits() > measure::FULL_ARRAY_QUBIT_LIMIT {
            return Err(js_err(QsimError::TooLargeForOperation {
                n_qubits: self.inner.local_qubits(),
                limit: measure::FULL_ARRAY_QUBIT_LIMIT,
            }));
        }
        Ok(self.inner.amps().iter().map(|a| a.norm_sqr()).collect())
    }
}

/// Plan a gate against a shard layout, flattened for the orchestrator.
///
/// See [`shard::encode_plan`] for the layout. Planning is pure arithmetic and
/// costs nothing next to the block copies it schedules, so it runs per gate.
#[wasm_bindgen(js_name = planGate)]
pub fn plan_gate(
    name: &str,
    qubits: Vec<u32>,
    params: Vec<f64>,
    local_qubits: u32,
    shard_bits: u32,
) -> Result<Vec<f64>, JsValue> {
    let steps =
        shard::plan_gate(name, &qubits, &params, local_qubits, shard_bits).map_err(js_err)?;
    Ok(shard::encode_plan(&steps))
}

/// Uncontrolled gate names, indexed by the `base_id` a plan step carries.
#[wasm_bindgen(js_name = baseGates)]
pub fn base_gates() -> Vec<String> {
    dispatch::BASE_GATES.iter().map(|s| s.to_string()).collect()
}

/// Choose a shard layout: `[shard_bits, local_qubits, shards, bytes_per_shard, total_bytes]`.
#[wasm_bindgen(js_name = planShards)]
pub fn plan_shards(global_qubits: u32, max_shard_qubits: u32, min_shard_bits: u32) -> Vec<f64> {
    let p = shard::plan(global_qubits, max_shard_qubits, min_shard_bits);
    vec![
        p.shard_bits as f64,
        p.local_qubits as f64,
        p.shards as f64,
        p.bytes_per_shard as f64,
        p.total_bytes as f64,
    ]
}

/// Largest slice a single shard should hold, in qubits.
///
/// 26 qubits is 1 GiB — comfortably under the 2 GiB `isize::MAX` cap on a single
/// allocation, with room for the scratch block and allocator overhead.
#[wasm_bindgen(js_name = maxShardQubits)]
pub fn max_shard_qubits() -> u32 {
    26
}

/// Amplitudes per exchange block.
#[wasm_bindgen(js_name = blockAmplitudes)]
pub fn block_amplitudes() -> f64 {
    shard::BLOCK_AMPS as f64
}
