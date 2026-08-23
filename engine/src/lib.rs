//! `rock` — a quantum circuit state-vector simulator for the browser.
//!
//! The API comes in two layers:
//!
//! * [`Simulator`] is plain Rust and returns [`RockError`]. All the behaviour
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
pub mod qaoa_plan;
pub mod rng;
pub mod shard;
pub mod state;

use complex::C;
use rng::Rng;
use state::{RockError, StateVector};
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
    pub fn new(n_qubits: u32) -> Result<Simulator, RockError> {
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
    ) -> Result<(), RockError> {
        dispatch::apply_named(&mut self.sv, name, qubits, params)
    }

    /// Total probability — 1.0 for any correct unitary sequence.
    pub fn norm(&self) -> f64 {
        self.sv.norm()
    }

    pub fn probabilities(&self) -> Result<Vec<f64>, RockError> {
        measure::probabilities(&self.sv)
    }

    pub fn amplitudes(&self) -> Result<Vec<f64>, RockError> {
        measure::amplitudes_flat(&self.sv)
    }

    pub fn probability_of_one(&self, qubit: u32) -> Result<f64, RockError> {
        measure::probability_of_one(&self.sv, qubit)
    }

    pub fn expectation_z(&self, qubit: u32) -> Result<f64, RockError> {
        measure::expectation_z(&self.sv, qubit)
    }

    /// Bloch vector of one qubit: `[<X>, <Y>, <Z>]`. Streams, so any register size.
    pub fn bloch_vector(&self, qubit: u32) -> Result<[f64; 3], RockError> {
        measure::bloch_vector(&self.sv, qubit)
    }

    /// The `k` most probable basis states, largest first.
    pub fn top_amplitudes(&self, k: usize) -> Vec<(u64, C)> {
        measure::top_amplitudes(&self.sv, k)
    }

    /// Two-qubit reduced density matrix; see [`measure::reduced_two`].
    pub fn reduced_two(&self, a: u32, b: u32) -> Result<[f64; 32], RockError> {
        measure::reduced_two(&self.sv, a, b)
    }

    /// Measure one qubit, collapsing the state onto the observed outcome.
    pub fn measure(&mut self, qubit: u32) -> Result<u8, RockError> {
        measure::measure(&mut self.sv, qubit, &mut self.rng)
    }

    /// Collapse one qubit onto a given outcome; see [`measure::collapse`].
    pub fn collapse(&mut self, qubit: u32, outcome: u8) -> Result<(), RockError> {
        measure::collapse(&mut self.sv, qubit, outcome)
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

    pub fn prepare_uniform(&mut self) -> Result<(), RockError> {
        circuits::uniform(&mut self.sv)
    }

    pub fn prepare_bell(&mut self) -> Result<(), RockError> {
        circuits::bell(&mut self.sv)
    }

    pub fn prepare_ghz(&mut self) -> Result<(), RockError> {
        circuits::ghz(&mut self.sv)
    }

    pub fn apply_qft(&mut self) -> Result<(), RockError> {
        circuits::qft(&mut self.sv)
    }

    /// Run Grover's search for `marked`. A negative `iterations` selects the
    /// optimal count. Returns the iterations performed.
    pub fn run_grover(&mut self, marked: usize, iterations: i32) -> Result<u32, RockError> {
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
    pub fn teleport(&mut self, theta: f64, phi: f64) -> Result<(u8, u8), RockError> {
        circuits::teleport(&mut self.sv, theta, phi, &mut self.rng)
    }

    /// Collapse the register onto a single basis state — the usual starting point
    /// for checking a transform against its analytic form.
    pub fn set_basis_state(&mut self, index: usize) -> Result<(), RockError> {
        if index >= self.sv.len() {
            return Err(RockError::InvalidQubit {
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

fn js_err(e: RockError) -> JsValue {
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

    /// Bloch vector of one qubit as `[x, y, z]`.
    ///
    /// The whole-register summary the views actually need, without ever pulling
    /// a full array across the boundary — so it stays available at register
    /// sizes where `amplitudes()` is refused outright.
    #[wasm_bindgen(js_name = blochVector)]
    pub fn bloch_vector(&self, qubit: u32) -> Result<Vec<f64>, JsValue> {
        self.inner
            .bloch_vector(qubit)
            .map(|v| v.to_vec())
            .map_err(js_err)
    }

    /// Two-qubit reduced density matrix as 16 interleaved `(re, im)` entries,
    /// row-major, with the subsystem index `bit_a + 2 * bit_b`.
    #[wasm_bindgen(js_name = reducedTwoFlat)]
    pub fn reduced_two_flat(&self, a: u32, b: u32) -> Result<Vec<f64>, JsValue> {
        self.inner.reduced_two(a, b).map(|m| m.to_vec()).map_err(js_err)
    }

    /// The `k` most probable basis states, flattened to
    /// `[index, re, im, index, re, im, ...]`, largest first.
    ///
    /// Indices are `f64` — exact to 2^53, so well past any addressable register.
    #[wasm_bindgen(js_name = topAmplitudesFlat)]
    pub fn top_amplitudes_flat(&self, k: u32) -> Vec<f64> {
        let mut out = Vec::with_capacity(k as usize * 3);
        for (i, a) in self.inner.top_amplitudes(k as usize) {
            out.push(i as f64);
            out.push(a.re);
            out.push(a.im);
        }
        out
    }

    pub fn measure(&mut self, qubit: u32) -> Result<u32, JsValue> {
        self.inner.measure(qubit).map(|b| b as u32).map_err(js_err)
    }

    /// Collapse one qubit onto a given outcome rather than a drawn one.
    ///
    /// Post-selection. The caller that needs this is one replaying an outcome it
    /// already knows — a recorded shot, say — where drawing again would give a
    /// different answer and defeat the point.
    pub fn collapse(&mut self, qubit: u32, outcome: u32) -> Result<(), JsValue> {
        self.inner.collapse(qubit, outcome as u8).map_err(js_err)
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
// QAOA, as a circuit a caller can walk
// ---------------------------------------------------------------------------

/// The gates [`qaoa::run_qaoa`] would apply for a config, flattened.
///
/// Returns `[n_gates, then per gate: name_id, part_tag, part_index, n_qubits,
/// qubits..., n_params, params...]`, where `name_id` indexes [`gate_names`] and
/// `part_tag` is 0 superpose, 1 budget, 2 penalty, 3 mixer. See
/// [`qaoa_plan::encode`].
///
/// The penalty list arrives as a flat qubit array plus offsets, one target and
/// one multiplier per penalty — the shape a `Vec<PenaltySpec>` takes when it has
/// to cross a boundary that carries only numbers.
///
/// `entities` are deliberately absent: they say how to *read* an allocation out
/// of a basis state and have no effect on the circuit at all, so a caller that
/// wants the gates should not have to describe them.
#[wasm_bindgen(js_name = qaoaPlan)]
pub fn qaoa_plan(
    weights: Vec<f64>,
    total_water: f64,
    gamma: f64,
    beta: f64,
    global_lambda: f64,
    penalty_qubits: Vec<u32>,
    penalty_offsets: Vec<u32>,
    penalty_targets: Vec<f64>,
    penalty_multipliers: Vec<f64>,
) -> Result<Vec<f64>, JsValue> {
    let err = |m: String| JsValue::from_str(&m);
    if weights.is_empty() {
        return Err(err("qaoaPlan needs at least one weight".into()));
    }
    if penalty_offsets.is_empty() {
        return Err(err("penalty_offsets needs a leading zero even with no penalties".into()));
    }
    let count = penalty_offsets.len() - 1;
    if penalty_targets.len() != count || penalty_multipliers.len() != count {
        return Err(err(format!(
            "{count} penalties from offsets, but {} targets and {} multipliers",
            penalty_targets.len(),
            penalty_multipliers.len()
        )));
    }
    if penalty_offsets[0] != 0 || *penalty_offsets.last().unwrap() as usize != penalty_qubits.len()
    {
        return Err(err("penalty_offsets must run from 0 to penalty_qubits.len()".into()));
    }

    let mut penalties = Vec::with_capacity(count);
    for i in 0..count {
        let (from, to) = (penalty_offsets[i] as usize, penalty_offsets[i + 1] as usize);
        if to < from {
            return Err(err("penalty_offsets must not decrease".into()));
        }
        let qubits: Vec<usize> = penalty_qubits[from..to].iter().map(|q| *q as usize).collect();
        if let Some(bad) = qubits.iter().find(|q| **q >= weights.len()) {
            return Err(err(format!(
                "penalty {i} names qubit {bad}, but there are {} weights",
                weights.len()
            )));
        }
        penalties.push(qaoa::PenaltySpec::new(
            format!("penalty {i}"),
            qubits,
            penalty_targets[i],
            penalty_multipliers[i],
        ));
    }

    let config = qaoa::QaoaConfig {
        total_water,
        gamma,
        beta,
        global_lambda,
        weights,
        // The circuit does not read these; see the note above.
        entities: Vec::new(),
        penalties,
        shots: 0,
        seed: 0,
    };
    Ok(qaoa_plan::encode(&qaoa_plan::plan(&config)))
}

// ---------------------------------------------------------------------------
// Randomness, shared with the sharded orchestrator
// ---------------------------------------------------------------------------

/// The engine's own generator, exposed so a caller can draw from the *same*
/// stream the whole-state path uses.
///
/// A sharded measurement cannot be drawn inside a shard — the outcome has to be
/// decided once against the global marginal, which only the orchestrator can
/// see. If the orchestrator brings its own generator, the same circuit under the
/// same seed observes different outcomes depending on how the register happened
/// to be held, which makes the two execution paths impossible to compare. Using
/// this instead makes them bit-identical.
#[wasm_bindgen(js_name = Prng)]
pub struct JsRng {
    inner: Rng,
}

#[wasm_bindgen(js_class = Prng)]
impl JsRng {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: f64) -> JsRng {
        JsRng { inner: Rng::new(seed as u64) }
    }

    /// Next uniform in `[0, 1)`, advancing the stream.
    #[wasm_bindgen(js_name = nextF64)]
    pub fn next_f64(&mut self) -> f64 {
        self.inner.next_f64()
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

    /// One-qubit reduced density matrix over this slice as `[r00, re01, im01, r11]`,
    /// for a *local* qubit. Sum the four across shards to get the global matrix.
    #[wasm_bindgen(js_name = localReducedOne)]
    pub fn local_reduced_one(&self, qubit: u32) -> Result<Vec<f64>, JsValue> {
        self.inner
            .local_reduced_one(qubit)
            .map(|v| v.to_vec())
            .map_err(js_err)
    }

    /// This slice's `k` largest amplitudes as `[local_index, re, im, ...]`.
    #[wasm_bindgen(js_name = localTopAmplitudesFlat)]
    pub fn local_top_amplitudes_flat(&self, k: u32) -> Vec<f64> {
        let mut out = Vec::with_capacity(k as usize * 3);
        for (i, a) in self.inner.local_top_amplitudes(k as usize) {
            out.push(i as f64);
            out.push(a.re);
            out.push(a.im);
        }
        out
    }

    /// Collapse a *local* qubit onto an outcome the orchestrator drew.
    #[wasm_bindgen(js_name = collapseLocal)]
    pub fn collapse_local(&mut self, qubit: u32, outcome: u32, scale: f64) -> Result<(), JsValue> {
        self.inner
            .collapse_local(qubit, outcome as u8, scale)
            .map_err(js_err)
    }

    /// Empty the slice — used for the shards a global measurement rules out.
    pub fn clear(&mut self) {
        self.inner.clear();
    }

    /// `sum(own * conj(partner))` over one block as `[re, im]`, with the partner's
    /// block already staged in the scratch buffer.
    #[wasm_bindgen(js_name = dotScratch)]
    pub fn dot_scratch(&self, block: u32) -> Result<Vec<f64>, JsValue> {
        self.inner
            .dot_scratch(block as usize)
            .map(|v| v.to_vec())
            .map_err(js_err)
    }

    /// Probabilities across this slice. Guarded like the whole-state version.
    pub fn probabilities(&self) -> Result<Vec<f64>, JsValue> {
        if self.inner.local_qubits() > measure::FULL_ARRAY_QUBIT_LIMIT {
            return Err(js_err(RockError::TooLargeForOperation {
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

/// Two-qubit reduced density matrix over a raw amplitude array.
///
/// `amps` is `[re0, im0, re1, im1, ...]` for a power-of-two number of states.
/// Sixteen interleaved `(re, im)` entries come back, row-major, with the
/// subsystem index `bit_a + 2 * bit_b`.
///
/// This exists for the sharded path. A pair of qubits straddling two shards has
/// no slice-local reduced matrix, so the orchestrator reassembles the amplitudes
/// and asks here — which keeps one implementation of the arithmetic rather than
/// a second copy in the caller that agrees only by inspection.
#[wasm_bindgen(js_name = reducedTwoOf)]
pub fn reduced_two_of(amps: Vec<f64>, a: u32, b: u32) -> Result<Vec<f64>, JsValue> {
    let states: Vec<C> = amps.chunks_exact(2).map(|p| C::new(p[0], p[1])).collect();
    measure::reduced_two_of(&states, a, b)
        .map(|m| m.to_vec())
        .map_err(js_err)
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
