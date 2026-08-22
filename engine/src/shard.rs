//! Sharded execution: one `Shard` per worker, each holding a contiguous slice
//! of the global state vector.
//!
//! # Why shard at all
//!
//! A wasm32 module can address 4 GiB, and a single Rust allocation is capped at
//! `isize::MAX` (2 GiB), so one module tops out around 26-27 qubits. Separate
//! module instances get separate address spaces, so K of them hold K times as
//! much. Total memory is bounded only by RAM.
//!
//! # The index split
//!
//! A global amplitude index splits into a shard id (the top `shard_bits`) and a
//! local index (the remaining `local_qubits`):
//!
//! ```text
//! global = (shard_id << local_qubits) | local
//! ```
//!
//! That makes qubit `q` one of two kinds:
//!
//! * **Local** (`q < local_qubits`) — the gate acts entirely within each shard's
//!   own indices. Every shard runs the ordinary kernel on its own slice,
//!   independently and in parallel, with no communication at all.
//! * **Global** (`q >= local_qubits`) — bit `q - local_qubits` of the shard id.
//!   The partner amplitude for local index `L` in shard `w` is local index `L` in
//!   shard `w ^ (1 << (q - local_qubits))`. So the gate becomes an *elementwise*
//!   2x2 between two whole slices: no strides, perfectly sequential access.
//!
//! Controls follow the same split. A global control is a condition on the shard
//! id, so it is resolved by the orchestrator simply choosing which shards take
//! part; the shard itself only ever sees local controls.
//!
//! # Blocked exchange
//!
//! A global-target gate needs both slices, but allocating a second buffer as big
//! as the slice would double peak memory — the one thing we are trying to avoid.
//! Instead the exchange runs in fixed-size blocks, so a shard holds its slice
//! plus one block, whatever the slice size.

use crate::complex::{Mat2, C};
use crate::dispatch::{self, Op};
use crate::rng::Rng;
use crate::state::{memory_bytes_required, QsimError, StateVector};

/// Amplitudes per exchange block: 4 Mi amplitudes, 64 MiB.
///
/// Large enough that the per-block message overhead is negligible against the
/// copy, small enough that the scratch buffer stays a rounding error next to a
/// multi-gigabyte slice.
pub const BLOCK_AMPS: usize = 4 * 1024 * 1024;

/// Elementwise 2x2 between this shard's amplitudes and a partner's block.
///
/// `is_low` selects which output row this shard owns. For a gate
/// `[[a, b], [c, d]]` acting on global amplitudes `(x, y)` — where `x` has the
/// target bit clear and `y` has it set — the shard with the bit clear computes
/// `a*x + b*y` and the shard with it set computes `c*x + d*y`. Each shard writes
/// only its own row, so no shard ever needs the other's output.
///
/// `cmask` is a mask over *local* indices for any local controls; `offset` is the
/// local index the block starts at, so the mask test stays correct block to
/// block. `cmask == 0` means unconditional and takes a branch-free path.
pub fn apply_pair_block(own: &mut [C], partner: &[C], m: Mat2, is_low: bool, cmask: usize, offset: usize) {
    debug_assert_eq!(own.len(), partner.len());
    if cmask == 0 {
        if is_low {
            for (o, p) in own.iter_mut().zip(partner) {
                *o = m.a * *o + m.b * *p;
            }
        } else {
            for (o, p) in own.iter_mut().zip(partner) {
                *o = m.c * *p + m.d * *o;
            }
        }
    } else {
        for (i, (o, p)) in own.iter_mut().zip(partner).enumerate() {
            if (offset + i) & cmask == cmask {
                *o = if is_low {
                    m.a * *o + m.b * *p
                } else {
                    m.c * *p + m.d * *o
                };
            }
        }
    }
}

/// One slice of a sharded state vector.
pub struct Shard {
    state: StateVector,
    /// Staging area for one block of a partner's amplitudes.
    scratch: Vec<C>,
    index: u32,
    shard_bits: u32,
}

impl Shard {
    /// Allocate shard `index` of `2^shard_bits`, holding `local_qubits` worth of
    /// amplitudes.
    ///
    /// Only shard 0 carries the |00...0> amplitude; every other shard starts at
    /// zero, which together form the correct global ground state.
    pub fn try_new(local_qubits: u32, shard_bits: u32, index: u32) -> Result<Self, QsimError> {
        if index >= (1u32 << shard_bits) {
            return Err(QsimError::InvalidShard { index, shards: 1u32 << shard_bits });
        }
        let mut state = StateVector::try_new(local_qubits)?;
        if index != 0 {
            // try_new seeds amps[0] = 1, which is only right for shard 0.
            state.amps_mut()[0] = C::ZERO;
        }
        let block = BLOCK_AMPS.min(state.len());
        let mut scratch: Vec<C> = Vec::new();
        scratch
            .try_reserve_exact(block)
            .map_err(|_| QsimError::OutOfMemory {
                requested: local_qubits,
                bytes: (block as u64) * 16,
            })?;
        scratch.resize(block, C::ZERO);
        Ok(Shard { state, scratch, index, shard_bits })
    }

    pub fn index(&self) -> u32 {
        self.index
    }

    pub fn shard_bits(&self) -> u32 {
        self.shard_bits
    }

    pub fn local_qubits(&self) -> u32 {
        self.state.n_qubits()
    }

    /// Total qubits across every shard.
    pub fn global_qubits(&self) -> u32 {
        self.state.n_qubits() + self.shard_bits
    }

    pub fn len(&self) -> usize {
        self.state.len()
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    pub fn amps(&self) -> &[C] {
        self.state.amps()
    }

    pub fn amps_mut(&mut self) -> &mut [C] {
        self.state.amps_mut()
    }

    pub fn scratch_mut(&mut self) -> &mut [C] {
        &mut self.scratch
    }

    pub fn block_amps(&self) -> usize {
        self.scratch.len()
    }

    pub fn num_blocks(&self) -> usize {
        self.state.len().div_ceil(self.scratch.len())
    }

    /// Reset to the global ground state.
    pub fn reset(&mut self) {
        self.state.amps_mut().fill(C::ZERO);
        if self.index == 0 {
            self.state.amps_mut()[0] = C::ONE;
        }
    }

    /// This shard's contribution to the total probability. Summing over shards
    /// gives the global norm.
    pub fn probability_mass(&self) -> f64 {
        self.state.norm()
    }

    /// Apply a gate whose target and controls are all local qubits.
    ///
    /// Any global controls must already have been resolved by the caller
    /// deciding whether this shard participates.
    pub fn apply_local(&mut self, name: &str, qubits: &[u32], params: &[f64]) -> Result<(), QsimError> {
        dispatch::apply_named(&mut self.state, name, qubits, params)
    }

    /// Apply a base (uncontrolled) gate with an explicit local control list.
    ///
    /// This is the form planned steps use: resolving a global control by shard
    /// selection changes the arity, so the original gate name no longer fits.
    pub fn apply_local_base(
        &mut self,
        base: &str,
        params: &[f64],
        controls: &[u32],
        target: u32,
    ) -> Result<(), QsimError> {
        dispatch::apply_base(&mut self.state, base, params, controls, target)
    }

    /// Probability that a *local* qubit is 1, summed over this shard only.
    pub fn local_probability_of_one(&self, qubit: u32) -> Result<f64, QsimError> {
        crate::measure::probability_of_one(&self.state, qubit)
    }

    /// One-qubit reduced density matrix over this slice, for a *local* qubit.
    ///
    /// Every element is a sum over amplitudes, so the orchestrator recovers the
    /// global matrix by adding the shards' contributions — no slice needs to see
    /// any other.
    pub fn local_reduced_one(&self, qubit: u32) -> Result<[f64; 4], QsimError> {
        crate::measure::reduced_one(&self.state, qubit)
    }

    /// The `k` largest amplitudes in this slice, by *local* index.
    ///
    /// The orchestrator shifts each index by the shard id and merges the lists,
    /// which gives the global top-k exactly: a state can only be in the global
    /// top-k if it is in its own shard's top-k.
    pub fn local_top_amplitudes(&self, k: usize) -> Vec<(u64, C)> {
        crate::measure::top_amplitudes(&self.state, k)
    }

    /// Collapse a *local* qubit onto `outcome`, rescaling the kept branch.
    ///
    /// The outcome and the scale factor are decided by the orchestrator, not
    /// here: the draw has to happen once for the whole register against the
    /// global marginal, and a shard cannot see it. Splitting the decision from
    /// the mutation is what makes a sharded measurement a measurement of one
    /// state rather than of `K` unrelated ones.
    pub fn collapse_local(&mut self, qubit: u32, outcome: u8, scale: f64) -> Result<(), QsimError> {
        self.state.check_qubit(qubit)?;
        let step = 1usize << qubit;
        for block in self.state.amps_mut().chunks_exact_mut(step << 1) {
            let (lo, hi) = block.split_at_mut(step);
            let (kept, killed) = if outcome == 1 { (hi, lo) } else { (lo, hi) };
            for x in kept.iter_mut() {
                *x = x.scale(scale);
            }
            killed.fill(C::ZERO);
        }
        Ok(())
    }

    /// Zero the whole slice.
    ///
    /// A *global* qubit is a bit of the shard id, so measuring it does not
    /// collapse anything within a slice — it decides which slices survive at
    /// all. The ones on the unobserved side are emptied by this.
    pub fn clear(&mut self) {
        self.state.amps_mut().fill(C::ZERO);
    }

    /// `sum(own * conj(partner))` over one block, as `[re, im]`.
    ///
    /// This is the off-diagonal reduced element for a *global* qubit, whose two
    /// branches live in different shards — the one case where a per-qubit
    /// summary cannot be computed slice-locally. It reuses the same staging
    /// buffer and block loop as a gate exchange, so it costs one pass over the
    /// slice and no extra memory.
    pub fn dot_scratch(&self, block: usize) -> Result<[f64; 2], QsimError> {
        let span = self.block_amps();
        let start = block * span;
        if start >= self.state.len() {
            return Err(QsimError::BlockOutOfRange { block, blocks: self.num_blocks() });
        }
        let end = (start + span).min(self.state.len());
        let mut re = 0.0;
        let mut im = 0.0;
        for (a, b) in self.state.amps()[start..end].iter().zip(self.scratch.iter()) {
            re += a.re * b.re + a.im * b.im;
            im += a.im * b.re - a.re * b.im;
        }
        Ok([re, im])
    }

    /// Fill the slice with pseudorandom amplitudes, returning its probability
    /// mass (the sum of squared magnitudes, before normalisation).
    ///
    /// This exists for capacity validation, and the reason is not obvious. A
    /// freshly allocated slice is all zeros, and zero pages are nearly free: the
    /// OS commits them lazily and compresses them away, so an allocation can
    /// succeed at a size the machine could never actually compute at. Filling
    /// with varied values forces every page to be genuinely resident.
    ///
    /// A random state is also the honest worst case rather than an artificial
    /// one: real circuits spread amplitude across every basis state within a few
    /// layers, so this is what the memory will look like in practice.
    ///
    /// The caller sums the masses across shards and applies the reciprocal square
    /// root via [`Shard::scale`] to get a properly normalised global state.
    pub fn fill_random(&mut self, seed: u64) -> f64 {
        // Mix the shard index in so slices differ; identical slices would let a
        // page-deduplicating allocator collapse them back down.
        let mut rng = Rng::new(seed ^ ((self.index as u64).wrapping_mul(0x9E3779B97F4A7C15)));
        let mut mass = 0.0;
        for a in self.state.amps_mut() {
            let re = rng.next_f64() - 0.5;
            let im = rng.next_f64() - 0.5;
            *a = C::new(re, im);
            mass += re * re + im * im;
        }
        mass
    }

    /// Multiply every amplitude by `factor`, to normalise after a filled slice.
    pub fn scale(&mut self, factor: f64) {
        for a in self.state.amps_mut() {
            *a = a.scale(factor);
        }
    }

    /// Apply one block of a global-target gate. `partner_block` holds the same
    /// local index range from the partner shard.
    pub fn apply_pair(
        &mut self,
        name: &str,
        params: &[f64],
        block: usize,
        is_low: bool,
        local_cmask: usize,
    ) -> Result<(), QsimError> {
        let op = dispatch::parse_op(name, params)?;
        let m = op.matrix().ok_or_else(|| QsimError::NotPairable(name.to_string()))?;
        let bs = self.scratch.len();
        let start = block * bs;
        if start >= self.state.len() {
            return Err(QsimError::BlockOutOfRange { block, blocks: self.num_blocks() });
        }
        let end = (start + bs).min(self.state.len());
        let n = end - start;
        let (own, partner) = (&mut self.state.amps_mut()[start..end], &self.scratch[..n]);
        apply_pair_block(own, partner, m, is_low, local_cmask, start);
        Ok(())
    }
}

/// How a qubit maps onto the shard layout.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum QubitKind {
    /// Intra-shard: acts on local index bit `bit`.
    Local { bit: u32 },
    /// Inter-shard: acts on shard-id bit `bit`.
    Global { bit: u32 },
}

/// Classify a global qubit index against a shard layout.
pub fn classify(qubit: u32, local_qubits: u32) -> QubitKind {
    if qubit < local_qubits {
        QubitKind::Local { bit: qubit }
    } else {
        QubitKind::Global { bit: qubit - local_qubits }
    }
}

/// Largest shard count worth using for `global_qubits`, given a per-shard cap.
///
/// Each shard must stay under the single-allocation limit, so the slice size is
/// what drives the count, not the core count.
pub fn min_shard_bits(global_qubits: u32, max_shard_qubits: u32) -> u32 {
    global_qubits.saturating_sub(max_shard_qubits)
}

/// Bytes one shard's slice needs, for capacity planning before allocating.
pub fn shard_bytes(global_qubits: u32, shard_bits: u32) -> u64 {
    memory_bytes_required(global_qubits.saturating_sub(shard_bits))
}

/// Plan for a sharded run: how many shards, and how big each slice is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShardPlan {
    pub global_qubits: u32,
    pub shard_bits: u32,
    pub local_qubits: u32,
    pub shards: u32,
    pub bytes_per_shard: u64,
    pub total_bytes: u64,
}

/// Choose a shard layout.
///
/// `max_shard_qubits` caps the slice size (26 keeps every slice at 1 GiB, safely
/// under the 2 GiB single-allocation limit). `min_shards_bits` lets the caller
/// ask for extra shards purely for parallelism when the slices would otherwise
/// be small enough to need only one or two.
pub fn plan(global_qubits: u32, max_shard_qubits: u32, min_shard_bits_hint: u32) -> ShardPlan {
    let needed = min_shard_bits(global_qubits, max_shard_qubits);
    // Never ask for more shards than there are amplitudes to divide.
    let shard_bits = needed.max(min_shard_bits_hint).min(global_qubits);
    let local_qubits = global_qubits - shard_bits;
    let bytes_per_shard = memory_bytes_required(local_qubits);
    ShardPlan {
        global_qubits,
        shard_bits,
        local_qubits,
        shards: 1u32 << shard_bits,
        bytes_per_shard,
        total_bytes: bytes_per_shard << shard_bits,
    }
}

impl Op {
    /// Whether this op can be executed as an elementwise shard pairing.
    /// SWAP cannot; the orchestrator decomposes it into CNOTs instead.
    pub fn is_pairable(self) -> bool {
        matches!(self, Op::Unitary { .. })
    }
}

// ---------------------------------------------------------------------------
// Gate planning
// ---------------------------------------------------------------------------

/// What a planned step does.
#[derive(Clone, Debug, PartialEq)]
pub enum StepKind {
    /// Runs inside each participating shard, with no communication.
    ///
    /// `qubits` are *local* indices, controls first then target.
    Local { qubits: Vec<u32> },
    /// Pairs shards differing in shard-id bit `target_bit` and applies an
    /// elementwise 2x2 across the two slices.
    Pair { target_bit: u32, local_cmask: usize },
}

/// One executable step of a gate under a shard layout.
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    /// Uncontrolled gate name; see [`crate::dispatch::BASE_GATES`].
    pub base: &'static str,
    pub params: Vec<f64>,
    /// Shards take part only where `id & global_cmask == global_cmask`. This is
    /// how a control on a global qubit is resolved: by selection, not by masking.
    pub global_cmask: usize,
    pub kind: StepKind,
}

impl Step {
    /// Shard ids that participate, for a given shard count.
    pub fn shards(&self, shards: u32) -> Vec<u32> {
        (0..shards)
            .filter(|w| (*w as usize) & self.global_cmask == self.global_cmask)
            .collect()
    }

    /// `(low, high)` shard pairs for a [`StepKind::Pair`] step. `low` has the
    /// target bit clear and owns the first output row.
    pub fn pairs(&self, shards: u32) -> Vec<(u32, u32)> {
        match self.kind {
            StepKind::Pair { target_bit, .. } => {
                let bit = 1u32 << target_bit;
                (0..shards)
                    .filter(|w| {
                        (*w as usize) & self.global_cmask == self.global_cmask && w & bit == 0
                    })
                    .map(|w| (w, w | bit))
                    .collect()
            }
            StepKind::Local { .. } => Vec::new(),
        }
    }
}

/// Turn a gate on global qubit indices into steps against a shard layout.
///
/// Controls split by kind: global controls become a shard-selection mask, local
/// controls stay as masks or control qubits inside the shard. SWAP has no 2x2
/// form, so it is decomposed into three CNOTs and planned recursively.
pub fn plan_gate(
    name: &str,
    qubits: &[u32],
    params: &[f64],
    local_qubits: u32,
    shard_bits: u32,
) -> Result<Vec<Step>, QsimError> {
    let global_qubits = local_qubits + shard_bits;
    let op = dispatch::parse_op(name, params)?;
    op.check_arity(name, qubits.len())?;

    for (i, &q) in qubits.iter().enumerate() {
        if q >= global_qubits {
            return Err(QsimError::InvalidQubit { qubit: q, n_qubits: global_qubits });
        }
        if qubits[..i].contains(&q) {
            return Err(QsimError::DuplicateQubit(q));
        }
    }

    let (gate_controls, target) = match op {
        Op::Swap => {
            // SWAP(a, b) = CNOT(a,b) CNOT(b,a) CNOT(a,b).
            let (a, b) = (qubits[0], qubits[1]);
            let mut steps = Vec::new();
            for pair in [[a, b], [b, a], [a, b]] {
                steps.extend(plan_gate("cx", &pair, &[], local_qubits, shard_bits)?);
            }
            return Ok(steps);
        }
        Op::Unitary { controls, .. } => (&qubits[..controls], qubits[controls]),
    };

    let (base, base_params) = op.base().expect("Swap handled above");

    let mut global_cmask = 0usize;
    let mut local_cmask = 0usize;
    let mut local_controls: Vec<u32> = Vec::new();
    for &c in gate_controls {
        match classify(c, local_qubits) {
            QubitKind::Local { bit } => {
                local_cmask |= 1usize << bit;
                local_controls.push(bit);
            }
            QubitKind::Global { bit } => global_cmask |= 1usize << bit,
        }
    }

    let kind = match classify(target, local_qubits) {
        QubitKind::Local { bit } => {
            // Entirely intra-shard: the ordinary kernel handles the local
            // controls, so no mask is needed here.
            let mut qs = local_controls;
            qs.push(bit);
            StepKind::Local { qubits: qs }
        }
        QubitKind::Global { bit } => StepKind::Pair { target_bit: bit, local_cmask },
    };

    Ok(vec![Step { base, params: base_params, global_cmask, kind }])
}

/// Flatten a plan for transfer across the WASM boundary.
///
/// Layout, all `f64`: `[n_steps, then per step:
/// base_id, kind, global_cmask, target_bit, local_cmask,
/// n_params, params..., n_qubits, qubits...]`
///
/// The consumer enumerates participating shards and pairs itself from the two
/// masks — a trivial loop — which keeps the encoding independent of shard count.
pub fn encode_plan(steps: &[Step]) -> Vec<f64> {
    let mut out = vec![steps.len() as f64];
    for s in steps {
        let base_id = dispatch::base_gate_id(s.base).expect("planned base gate is known") as f64;
        let (kind, target_bit, local_cmask, qubits): (f64, f64, f64, &[u32]) = match &s.kind {
            StepKind::Local { qubits } => (0.0, -1.0, 0.0, qubits.as_slice()),
            StepKind::Pair { target_bit, local_cmask } => {
                (1.0, *target_bit as f64, *local_cmask as f64, &[])
            }
        };
        out.push(base_id);
        out.push(kind);
        out.push(s.global_cmask as f64);
        out.push(target_bit);
        out.push(local_cmask);
        out.push(s.params.len() as f64);
        out.extend(s.params.iter().copied());
        out.push(qubits.len() as f64);
        out.extend(qubits.iter().map(|q| *q as f64));
    }
    out
}
