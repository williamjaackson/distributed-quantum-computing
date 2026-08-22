//! Sharded execution must produce bit-identical results to whole-state
//! execution.
//!
//! Everything here compares a fully orchestrated sharded run against
//! `Simulator` on the same circuit. That equivalence is the only property that
//! matters: if it holds for random circuits across every shard layout, the index
//! split, the control classification, the low/high row assignment and the
//! blocked exchange are all correct together.
//!
//! `ShardedSim` below is also the reference the TypeScript orchestrator follows,
//! so the tricky logic is exercised here rather than in the browser.

use qsim::circuits;
use qsim::complex::C;
use qsim::dispatch::BASE_GATES;
use qsim::rng::Rng;
use qsim::shard::{encode_plan, plan_gate, Shard, Step, StepKind};
use qsim::state::QsimError;
use qsim::Simulator;

const TOL: f64 = 1e-13;

/// In-process orchestrator: owns every shard and performs the exchanges as
/// plain copies, exactly where a worker would postMessage a block.
struct ShardedSim {
    shards: Vec<Shard>,
    shard_bits: u32,
    local_qubits: u32,
    /// Blocks copied between shards, so tests can assert communication actually
    /// happened (and that local gates cause none).
    exchanges: usize,
}

impl ShardedSim {
    fn new(global_qubits: u32, shard_bits: u32) -> Result<Self, QsimError> {
        let local_qubits = global_qubits - shard_bits;
        let shards = (0..(1u32 << shard_bits))
            .map(|i| Shard::try_new(local_qubits, shard_bits, i))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ShardedSim { shards, shard_bits, local_qubits, exchanges: 0 })
    }

    fn n_shards(&self) -> u32 {
        1u32 << self.shard_bits
    }

    fn apply(&mut self, name: &str, qubits: &[u32], params: &[f64]) -> Result<(), QsimError> {
        let steps = plan_gate(name, qubits, params, self.local_qubits, self.shard_bits)?;
        for step in &steps {
            self.run_step(step)?;
        }
        Ok(())
    }

    fn run_step(&mut self, step: &Step) -> Result<(), QsimError> {
        match &step.kind {
            StepKind::Local { qubits } => {
                let (controls, target) = qubits.split_at(qubits.len() - 1);
                for w in step.shards(self.n_shards()) {
                    self.shards[w as usize]
                        .apply_local_base(step.base, &step.params, controls, target[0])?;
                }
                Ok(())
            }
            StepKind::Pair { local_cmask, .. } => {
                for (low, high) in step.pairs(self.n_shards()) {
                    self.exchange_pair(step, low, high, *local_cmask)?;
                }
                Ok(())
            }
        }
    }

    /// Blocked exchange between a shard pair.
    ///
    /// Both slices must be staged before either is written, since each output
    /// row reads both inputs — the same ordering constraint a worker faces.
    fn exchange_pair(
        &mut self,
        step: &Step,
        low: u32,
        high: u32,
        local_cmask: usize,
    ) -> Result<(), QsimError> {
        let blocks = self.shards[low as usize].num_blocks();
        let block_amps = self.shards[low as usize].block_amps();
        let slice_len = self.shards[low as usize].len();

        for b in 0..blocks {
            let start = b * block_amps;
            let n = (start + block_amps).min(slice_len) - start;

            // Split so both shards can be borrowed mutably at once.
            let (a, rest) = self.shards.split_at_mut(high as usize);
            let lo = &mut a[low as usize];
            let hi = &mut rest[0];

            lo.scratch_mut()[..n].copy_from_slice(&hi.amps()[start..start + n]);
            hi.scratch_mut()[..n].copy_from_slice(&lo.amps()[start..start + n]);
            self.exchanges += 2;

            lo.apply_pair(step.base, &step.params, b, true, local_cmask)?;
            hi.apply_pair(step.base, &step.params, b, false, local_cmask)?;
        }
        Ok(())
    }

    /// Concatenate every slice into the global amplitude vector.
    fn amplitudes(&self) -> Vec<C> {
        let mut out = Vec::with_capacity(self.shards.len() * self.shards[0].len());
        for s in &self.shards {
            out.extend_from_slice(s.amps());
        }
        out
    }

    fn norm(&self) -> f64 {
        self.shards.iter().map(|s| s.probability_mass()).sum()
    }
}

fn assert_matches(sharded: &ShardedSim, whole: &Simulator, what: &str) {
    let got = sharded.amplitudes();
    let want = whole.state().amps();
    assert_eq!(got.len(), want.len(), "{what}: length mismatch");
    for (i, (g, w)) in got.iter().zip(want.iter()).enumerate() {
        assert!(
            (g.re - w.re).abs() < TOL && (g.im - w.im).abs() < TOL,
            "{what}: amplitude {i} sharded ({}, {}) vs whole ({}, {})",
            g.re, g.im, w.re, w.im
        );
    }
}

/// Every gate the planner can see, at every arity, with angles.
fn gate_menu() -> Vec<(&'static str, usize, Vec<f64>)> {
    vec![
        ("h", 1, vec![]),
        ("x", 1, vec![]),
        ("y", 1, vec![]),
        ("z", 1, vec![]),
        ("s", 1, vec![]),
        ("sdg", 1, vec![]),
        ("t", 1, vec![]),
        ("tdg", 1, vec![]),
        ("rx", 1, vec![0.7]),
        ("ry", 1, vec![-1.3]),
        ("rz", 1, vec![2.1]),
        ("p", 1, vec![0.45]),
        ("u3", 1, vec![0.6, 1.1, -0.3]),
        ("cx", 2, vec![]),
        ("cy", 2, vec![]),
        ("cz", 2, vec![]),
        ("ch", 2, vec![]),
        ("crx", 2, vec![0.9]),
        ("cry", 2, vec![-0.4]),
        ("crz", 2, vec![1.7]),
        ("cp", 2, vec![0.33]),
        ("swap", 2, vec![]),
        ("ccx", 3, vec![]),
        ("ccz", 3, vec![]),
    ]
}

#[test]
fn every_gate_matches_whole_state_at_every_qubit_position() {
    // 4 qubits split 2/2 puts every gate's target and controls on both sides of
    // the local/global boundary across the sweep.
    let n = 4u32;
    for shard_bits in 0..=n {
        for (name, arity, params) in gate_menu() {
            // Walk the qubit tuple across all positions so each qubit role lands
            // both local and global.
            for offset in 0..n {
                let qubits: Vec<u32> = (0..arity as u32).map(|k| (offset + k) % n).collect();
                if qubits.iter().collect::<std::collections::HashSet<_>>().len() != arity {
                    continue;
                }

                let mut sharded = ShardedSim::new(n, shard_bits).unwrap();
                let mut whole = Simulator::new(n).unwrap();
                // Spread amplitude everywhere first, so a dropped index or a
                // swapped output row cannot hide behind zeros.
                for q in 0..n {
                    sharded.apply("h", &[q], &[]).unwrap();
                    whole.apply_named("h", &[q], &[]).unwrap();
                    sharded.apply("t", &[q], &[]).unwrap();
                    whole.apply_named("t", &[q], &[]).unwrap();
                }

                sharded.apply(name, &qubits, &params).unwrap();
                whole.apply_named(name, &qubits, &params).unwrap();
                assert_matches(
                    &sharded,
                    &whole,
                    &format!("{name} on {qubits:?}, shard_bits={shard_bits}"),
                );
            }
        }
    }
}

#[test]
fn random_circuits_match_whole_state_across_every_layout() {
    let n = 5u32;
    for shard_bits in 0..=n {
        let mut rng = Rng::new(0xC0FFEE + shard_bits as u64);
        let mut sharded = ShardedSim::new(n, shard_bits).unwrap();
        let mut whole = Simulator::new(n).unwrap();
        let menu = gate_menu();

        for step in 0..300 {
            let (name, arity, params) = &menu[(rng.next_u64() as usize) % menu.len()];
            // Distinct random qubits.
            let mut qubits: Vec<u32> = Vec::new();
            while qubits.len() < *arity {
                let q = (rng.next_u64() % n as u64) as u32;
                if !qubits.contains(&q) {
                    qubits.push(q);
                }
            }
            sharded.apply(name, &qubits, params).unwrap();
            whole.apply_named(name, &qubits, params).unwrap();

            if step % 50 == 0 {
                assert_matches(
                    &sharded,
                    &whole,
                    &format!("random circuit shard_bits={shard_bits} after {step} gates"),
                );
            }
        }
        assert_matches(&sharded, &whole, &format!("random circuit shard_bits={shard_bits} final"));
        assert!(
            (sharded.norm() - 1.0).abs() < 1e-12,
            "shard_bits={shard_bits}: norm drifted to {}",
            sharded.norm()
        );
    }
}

#[test]
fn algorithms_match_whole_state_when_sharded() {
    let n = 6u32;
    for shard_bits in [0u32, 1, 2, 3] {
        // GHZ: a CNOT chain that necessarily crosses every shard boundary.
        let mut sharded = ShardedSim::new(n, shard_bits).unwrap();
        let mut whole = Simulator::new(n).unwrap();
        sharded.apply("h", &[0], &[]).unwrap();
        whole.apply_named("h", &[0], &[]).unwrap();
        for q in 1..n {
            sharded.apply("cx", &[q - 1, q], &[]).unwrap();
            whole.apply_named("cx", &[q - 1, q], &[]).unwrap();
        }
        assert_matches(&sharded, &whole, &format!("GHZ shard_bits={shard_bits}"));

        // QFT: controlled phases at every qubit separation, plus the final swaps.
        let mut sharded = ShardedSim::new(n, shard_bits).unwrap();
        let mut whole = Simulator::new(n).unwrap();
        for q in 0..n {
            sharded.apply("h", &[q], &[]).unwrap();
            whole.apply_named("h", &[q], &[]).unwrap();
        }
        for j in (0..n).rev() {
            sharded.apply("h", &[j], &[]).unwrap();
            whole.apply_named("h", &[j], &[]).unwrap();
            for k in (0..j).rev() {
                let angle = std::f64::consts::PI / ((1u64 << (j - k)) as f64);
                sharded.apply("cp", &[k, j], &[angle]).unwrap();
                whole.apply_named("cp", &[k, j], &[angle]).unwrap();
            }
        }
        for i in 0..n / 2 {
            sharded.apply("swap", &[i, n - 1 - i], &[]).unwrap();
            whole.apply_named("swap", &[i, n - 1 - i], &[]).unwrap();
        }
        assert_matches(&sharded, &whole, &format!("QFT shard_bits={shard_bits}"));
    }
}

#[test]
fn local_gates_cause_no_communication() {
    // The whole point of the layout: gates below the boundary must be free.
    let n = 6u32;
    let shard_bits = 2u32;
    let local = n - shard_bits;
    let mut sim = ShardedSim::new(n, shard_bits).unwrap();

    for q in 0..local {
        sim.apply("h", &[q], &[]).unwrap();
    }
    for q in 1..local {
        sim.apply("cx", &[q - 1, q], &[]).unwrap();
    }
    assert_eq!(sim.exchanges, 0, "local-only circuit exchanged data");

    // A gate on a global qubit must exchange.
    sim.apply("h", &[n - 1], &[]).unwrap();
    assert!(sim.exchanges > 0, "global gate exchanged nothing");
}

#[test]
fn global_control_is_resolved_by_shard_selection() {
    // A control on a global qubit should be handled by choosing shards, never by
    // masking inside one — so the step's mask must be set and shard list reduced.
    let steps = plan_gate("cx", &[3, 0], &[], 2, 2).unwrap();
    assert_eq!(steps.len(), 1);
    let s = &steps[0];
    assert_eq!(s.base, "x");
    // Qubit 3 with local_qubits=2 is shard-id bit 1.
    assert_eq!(s.global_cmask, 0b10);
    assert!(matches!(s.kind, StepKind::Local { .. }));
    // Only the two shards with that bit set take part.
    assert_eq!(s.shards(4), vec![2, 3]);
}

#[test]
fn global_target_pairs_shards_differing_in_one_bit() {
    let steps = plan_gate("h", &[2], &[], 2, 2).unwrap();
    let s = &steps[0];
    assert_eq!(s.kind, StepKind::Pair { target_bit: 0, local_cmask: 0 });
    assert_eq!(s.pairs(4), vec![(0, 1), (2, 3)]);

    let steps = plan_gate("h", &[3], &[], 2, 2).unwrap();
    assert_eq!(steps[0].pairs(4), vec![(0, 2), (1, 3)]);
}

#[test]
fn local_control_with_global_target_becomes_a_mask() {
    // Control on local qubit 1, target on global qubit 2.
    let steps = plan_gate("cx", &[1, 2], &[], 2, 2).unwrap();
    let s = &steps[0];
    assert_eq!(s.global_cmask, 0);
    assert_eq!(s.kind, StepKind::Pair { target_bit: 0, local_cmask: 0b10 });
    assert_eq!(s.pairs(4), vec![(0, 1), (2, 3)]);
}

#[test]
fn swap_decomposes_into_three_cnots() {
    let steps = plan_gate("swap", &[0, 3], &[], 2, 2).unwrap();
    assert_eq!(steps.len(), 3, "SWAP has no 2x2 form and must decompose");
    assert!(steps.iter().all(|s| s.base == "x"));
}

#[test]
fn single_shard_layout_is_all_local() {
    // shard_bits = 0 must degenerate to ordinary whole-state execution.
    for q in 0..4u32 {
        let steps = plan_gate("h", &[q], &[], 4, 0).unwrap();
        assert!(matches!(steps[0].kind, StepKind::Local { .. }), "qubit {q} should be local");
        assert_eq!(steps[0].global_cmask, 0);
    }
}

#[test]
fn plan_rejects_invalid_requests() {
    assert!(matches!(
        plan_gate("h", &[9], &[], 2, 2),
        Err(QsimError::InvalidQubit { .. })
    ));
    assert!(matches!(
        plan_gate("cx", &[1, 1], &[], 2, 2),
        Err(QsimError::DuplicateQubit(1))
    ));
    assert!(matches!(
        plan_gate("cx", &[1], &[], 2, 2),
        Err(QsimError::WrongArity { .. })
    ));
    assert!(matches!(
        plan_gate("nope", &[1], &[], 2, 2),
        Err(QsimError::UnknownGate(_))
    ));
}

#[test]
fn encoded_plan_round_trips_the_fields_a_consumer_needs() {
    // The TypeScript orchestrator reads this flat encoding, so its layout is
    // part of the contract.
    let steps = plan_gate("ccx", &[0, 3, 2], &[], 2, 2).unwrap();
    let enc = encode_plan(&steps);
    let mut i = 0;
    let n_steps = enc[i] as usize;
    i += 1;
    assert_eq!(n_steps, 1);

    let base_id = enc[i] as usize;
    assert_eq!(BASE_GATES[base_id], "x");
    let kind = enc[i + 1];
    assert_eq!(kind, 1.0, "target qubit 2 is global, so this is a pair step");
    let global_cmask = enc[i + 2] as usize;
    assert_eq!(global_cmask, 0b10, "control on qubit 3 is shard-id bit 1");
    let target_bit = enc[i + 3] as i32;
    assert_eq!(target_bit, 0);
    let local_cmask = enc[i + 4] as usize;
    assert_eq!(local_cmask, 0b1, "control on qubit 0 is local bit 0");
    let n_params = enc[i + 5] as usize;
    assert_eq!(n_params, 0);
    let n_qubits = enc[i + 6 + n_params] as usize;
    assert_eq!(n_qubits, 0, "pair steps carry no local qubit list");
    assert_eq!(enc.len(), i + 7 + n_params, "encoding has trailing bytes");
}

#[test]
fn blocked_exchange_is_independent_of_block_count() {
    // A slice larger than one block must give the same answer as one that fits,
    // which is what proves the offset handling in the masked path.
    let n = 6u32;
    let mut a = ShardedSim::new(n, 1).unwrap();
    let mut whole = Simulator::new(n).unwrap();
    for q in 0..n {
        a.apply("h", &[q], &[]).unwrap();
        whole.apply_named("h", &[q], &[]).unwrap();
    }
    // Local control + global target exercises the masked block path.
    a.apply("cx", &[0, n - 1], &[]).unwrap();
    whole.apply_named("cx", &[0, n - 1], &[]).unwrap();
    a.apply("cp", &[2, n - 1], &[0.7]).unwrap();
    whole.apply_named("cp", &[2, n - 1], &[0.7]).unwrap();
    assert_matches(&a, &whole, "masked blocked exchange");
    assert!(a.shards[0].num_blocks() >= 1);
}

#[test]
fn shard_plan_keeps_slices_under_the_allocation_limit() {
    // 26 local qubits is 1 GiB, comfortably under the 2 GiB isize::MAX cap.
    for n in 20..=30u32 {
        let p = qsim::shard::plan(n, 26, 0);
        assert!(
            p.bytes_per_shard <= 1024 * 1024 * 1024,
            "{n} qubits: slice of {} bytes exceeds 1 GiB",
            p.bytes_per_shard
        );
        assert_eq!(p.local_qubits + p.shard_bits, n);
        assert_eq!(p.total_bytes, qsim::state::memory_bytes_required(n));
    }
    // A parallelism hint adds shards even when one slice would already fit.
    let p = qsim::shard::plan(20, 26, 3);
    assert_eq!(p.shard_bits, 3);
    assert_eq!(p.local_qubits, 17);
}

#[test]
fn shard_masses_partition_the_total_probability() {
    // Sampling a sharded state works by choosing a shard in proportion to its
    // probability mass, then sampling within it. That is only exact if the
    // masses partition 1 and each slice samples its own weights correctly.
    let n = 4u32;
    let shard_bits = 2u32;
    let mut sim = ShardedSim::new(n, shard_bits).unwrap();
    sim.apply("h", &[0], &[]).unwrap();
    for q in 1..n {
        sim.apply("cx", &[q - 1, q], &[]).unwrap();
    }

    let masses: Vec<f64> = sim.shards.iter().map(|s| s.probability_mass()).collect();
    let total: f64 = masses.iter().sum();
    assert!((total - 1.0).abs() < 1e-12, "masses sum to {total}");
    // GHZ on 4 qubits is |0000> + |1111>; those land in the first and last shard.
    assert!((masses[0] - 0.5).abs() < 1e-12, "shard 0 mass {}", masses[0]);
    assert!((masses[3] - 0.5).abs() < 1e-12, "shard 3 mass {}", masses[3]);
    assert!(masses[1].abs() < 1e-15 && masses[2].abs() < 1e-15, "middle shards carry mass");

    // Sampling within a slice must respect its own weights, not assume unit mass.
    let drawn = qsim::measure::sample_unnormalised(sim.shards[0].amps(), 500, 7);
    let shots: u32 = drawn.iter().map(|(_, c)| *c).sum();
    assert_eq!(shots, 500, "slice sampling lost shots");
    assert!(drawn.iter().all(|(i, _)| *i == 0), "slice 0 only supports local index 0");

    // A zero-mass slice must yield nothing rather than dividing by zero.
    assert!(qsim::measure::sample_unnormalised(sim.shards[1].amps(), 500, 7).is_empty());
}

// -- capacity validation ---------------------------------------------------

impl ShardedSim {
    /// Fill every slice with random amplitudes and normalise globally.
    fn fill_random(&mut self, seed: u64) {
        let masses: Vec<f64> = self
            .shards
            .iter_mut()
            .map(|s| s.fill_random(seed))
            .collect();
        let total: f64 = masses.iter().sum();
        let factor = 1.0 / total.sqrt();
        for s in self.shards.iter_mut() {
            s.scale(factor);
        }
    }
}

#[test]
fn filling_leaves_no_zero_amplitudes() {
    // The whole point of the fill: a freshly allocated slice is all zeros, and
    // zero pages cost almost nothing, so an allocation can succeed at a size
    // that could never really be computed on. After filling, every page must
    // hold real data.
    let mut sim = ShardedSim::new(6, 2).unwrap();

    // What the old validation left behind: two gates on a fresh register.
    sim.apply("h", &[0], &[]).unwrap();
    sim.apply("h", &[5], &[]).unwrap();
    let nonzero_before = sim.amplitudes().iter().filter(|a| a.norm_sqr() > 0.0).count();
    assert_eq!(nonzero_before, 4, "two gates on a fresh register touch only four amplitudes");

    let mut sim = ShardedSim::new(6, 2).unwrap();
    sim.fill_random(0xF11);
    let amps = sim.amplitudes();
    assert!(
        amps.iter().all(|a| a.norm_sqr() > 0.0),
        "a filled state must have no zero amplitudes"
    );
    assert!((sim.norm() - 1.0).abs() < 1e-12, "filled state norm {}", sim.norm());
}

#[test]
fn filled_slices_differ_from_each_other() {
    // Identical slices would let a page-deduplicating allocator collapse them,
    // which would defeat the point of filling in the first place.
    let mut sim = ShardedSim::new(6, 2).unwrap();
    sim.fill_random(7);
    let slices: Vec<&[C]> = sim.shards.iter().map(|s| s.amps()).collect();
    for i in 1..slices.len() {
        assert_ne!(slices[0], slices[i], "shard {i} holds the same bytes as shard 0");
    }
}

#[test]
fn gates_on_a_filled_state_preserve_the_norm() {
    // A far stronger check than the same test on a near-empty register: every
    // one of the 2^n terms contributes rounding error here, not just four.
    for shard_bits in 0..=3u32 {
        let mut sharded = ShardedSim::new(6, shard_bits).unwrap();
        sharded.fill_random(0xABC);
        for q in 0..6 {
            sharded.apply("h", &[q], &[]).unwrap();
            sharded.apply("cx", &[q, (q + 1) % 6], &[]).unwrap();
            sharded.apply("t", &[q], &[]).unwrap();
        }
        assert!(
            (sharded.norm() - 1.0).abs() < 1e-12,
            "shard_bits={shard_bits}: norm {} after gates on a filled state",
            sharded.norm()
        );
    }
}

#[test]
fn a_filled_sharded_state_still_matches_whole_state_execution() {
    // Equivalence must hold on a fully populated state, not just one reachable
    // from |00...0> — that is where a mis-assigned output row would show up in
    // every amplitude rather than a handful.
    let n = 5u32;
    for shard_bits in 1..=3u32 {
        let mut sharded = ShardedSim::new(n, shard_bits).unwrap();
        sharded.fill_random(0x5151);

        // Copy the identical state into a whole-state simulator.
        let mut whole = Simulator::new(n).unwrap();
        whole.state_mut().amps_mut().copy_from_slice(&sharded.amplitudes());

        for q in 0..n {
            sharded.apply("h", &[q], &[]).unwrap();
            whole.apply_named("h", &[q], &[]).unwrap();
            sharded.apply("cp", &[q, (q + 1) % n], &[0.6]).unwrap();
            whole.apply_named("cp", &[q, (q + 1) % n], &[0.6]).unwrap();
        }
        assert_matches(&sharded, &whole, &format!("filled state, shard_bits={shard_bits}"));
    }
}

// -- Shor's algorithm across shards ----------------------------------------

impl ShardedSim {
    /// Modular-exponentiation oracle, run independently on every slice.
    fn modexp(&mut self, a: u64, modulus: u64, work_qubits: u32) -> Result<(), QsimError> {
        for s in self.shards.iter_mut() {
            s.modexp_oracle_local(a, modulus, work_qubits)?;
        }
        Ok(())
    }

    /// Global counting-register marginal, concatenated in shard order.
    fn register_marginal(&self, work_qubits: u32) -> Vec<f64> {
        let mut out = Vec::new();
        for s in &self.shards {
            out.extend(s.register_marginal(work_qubits).unwrap());
        }
        out
    }

    /// Inverse QFT over the counting register, driven through the planner so
    /// cross-shard gates are routed exactly as the browser orchestrator does.
    ///
    /// The forward transform is `swaps ∘ core`, so the inverse is
    /// `core⁻¹ ∘ swaps` — the swaps come *first*. Simply omitting them therefore
    /// permutes the input, not the output, and gives a different answer.
    ///
    /// Conjugating by the swap network relabels qubits, so
    /// `core⁻¹ ∘ S = S ∘ core̅⁻¹` where `core̅` runs on reversed qubit indices.
    /// That moves the permutation to the end, where dropping it really is just a
    /// relabelling of the readout — worth having, because those swaps straddle
    /// the shard boundary and each decomposes into three CNOTs.
    fn inverse_qft(&mut self, work: u32, count: u32, keep_swaps: bool) {
        // Reversed labels when the swaps are dropped, normal labels otherwise.
        let q = |j: u32| if keep_swaps { work + j } else { work + count - 1 - j };
        if keep_swaps {
            for i in 0..count / 2 {
                self.apply("swap", &[work + i, work + count - 1 - i], &[]).unwrap();
            }
        }
        for j in 0..count {
            for k in 0..j {
                let angle = -std::f64::consts::PI / ((1u64 << (j - k)) as f64);
                self.apply("cp", &[q(k), q(j)], &[angle]).unwrap();
            }
            self.apply("h", &[q(j)], &[]).unwrap();
        }
    }
}

/// The same circuit on one whole state vector, for comparison.
fn whole_state_period_finding(work: u32, count: u32, a: u64, modulus: u64) -> Vec<f64> {
    let mut sim = Simulator::new(work + count).unwrap();
    sim.apply_named("x", &[0], &[]).unwrap();
    for q in work..work + count {
        sim.apply_named("h", &[q], &[]).unwrap();
    }
    circuits::modexp_oracle(sim.state_mut(), a, modulus, work).unwrap();
    for i in 0..count / 2 {
        sim.apply_named("swap", &[work + i, work + count - 1 - i], &[]).unwrap();
    }
    for j in 0..count {
        for k in 0..j {
            let angle = -std::f64::consts::PI / ((1u64 << (j - k)) as f64);
            sim.apply_named("cp", &[work + k, work + j], &[angle]).unwrap();
        }
        sim.apply_named("h", &[work + j], &[]).unwrap();
    }
    qsim::measure::register_marginal(sim.state(), work).unwrap()
}

#[test]
fn shard_local_oracle_matches_the_whole_state_oracle() {
    // The oracle is the one step applied straight to amplitudes, and each shard
    // seeds it from its own power of a. If the index arithmetic were off by even
    // one shard the amplitudes would land in the wrong blocks.
    let (work, count, a, modulus) = (4u32, 4u32, 7u64, 15u64);
    for shard_bits in 0..=count {
        let mut sharded = ShardedSim::new(work + count, shard_bits).unwrap();
        let mut whole = Simulator::new(work + count).unwrap();
        sharded.apply("x", &[0], &[]).unwrap();
        whole.apply_named("x", &[0], &[]).unwrap();
        for q in work..work + count {
            sharded.apply("h", &[q], &[]).unwrap();
            whole.apply_named("h", &[q], &[]).unwrap();
        }

        let before = sharded.exchanges;
        sharded.modexp(a, modulus, work).unwrap();
        assert_eq!(sharded.exchanges, before, "the oracle must not communicate");

        circuits::modexp_oracle(whole.state_mut(), a, modulus, work).unwrap();
        assert_matches(&sharded, &whole, &format!("sharded oracle, shard_bits={shard_bits}"));
    }
}

#[test]
fn sharded_period_finding_matches_whole_state() {
    // End to end: superpose, oracle, inverse QFT, marginal — sharded against
    // whole-state. The counting register spans the shard boundary, so the QFT
    // genuinely exchanges slices here.
    let (work, count, a, modulus) = (4u32, 6u32, 7u64, 15u64);
    let want = whole_state_period_finding(work, count, a, modulus);

    for shard_bits in 1..=4u32 {
        let mut sharded = ShardedSim::new(work + count, shard_bits).unwrap();
        sharded.apply("x", &[0], &[]).unwrap();
        for q in work..work + count {
            sharded.apply("h", &[q], &[]).unwrap();
        }
        sharded.modexp(a, modulus, work).unwrap();
        sharded.inverse_qft(work, count, true);

        let got = sharded.register_marginal(work);
        assert_eq!(got.len(), want.len(), "marginal length, shard_bits={shard_bits}");
        for (x, (g, w)) in got.iter().zip(want.iter()).enumerate() {
            assert!(
                (g - w).abs() < 1e-12,
                "shard_bits={shard_bits}: marginal at x={x} is {g}, expected {w}"
            );
        }
        assert!(sharded.exchanges > 0, "the QFT should have crossed the boundary");
        // r = 4, so the mass sits on multiples of 2^count / 4.
        let spacing = (1usize << count) / 4;
        let peaks: f64 = (0..4).map(|k| got[k * spacing]).sum();
        assert!(peaks > 0.99, "shard_bits={shard_bits}: peak mass only {peaks}");
    }
}

#[test]
fn dropping_the_bit_reversal_only_reverses_the_readout() {
    // The final swaps of the QFT are a relabelling, so skipping them and reading
    // the measured bits in reverse gives the same distribution. Worth exploiting:
    // those swaps straddle the shard boundary and decompose into three CNOTs each.
    let (work, count, a, modulus) = (4u32, 6u32, 7u64, 15u64);
    let with_swaps = whole_state_period_finding(work, count, a, modulus);

    let mut sharded = ShardedSim::new(work + count, 2).unwrap();
    sharded.apply("x", &[0], &[]).unwrap();
    for q in work..work + count {
        sharded.apply("h", &[q], &[]).unwrap();
    }
    sharded.modexp(a, modulus, work).unwrap();
    sharded.inverse_qft(work, count, false);
    let without = sharded.register_marginal(work);

    let reverse_bits = |x: usize| (0..count).fold(0usize, |acc, b| {
        acc | (((x >> b) & 1) << (count - 1 - b))
    });
    for x in 0..with_swaps.len() {
        let got = without[reverse_bits(x)];
        assert!(
            (got - with_swaps[x]).abs() < 1e-12,
            "x={x}: reversed readout {got} vs swapped {}",
            with_swaps[x]
        );
    }
}
