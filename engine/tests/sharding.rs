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

    /// One-qubit reduced density matrix as `[r00, re01, im01, r11]`.
    ///
    /// The two qubit kinds are answered in completely different ways, which is
    /// the whole point of the split. A local qubit's elements are sums *within*
    /// each slice, so the shards need no contact at all. A global qubit's two
    /// branches live in *different* slices, so the diagonal comes straight from
    /// the shard masses — no arithmetic over amplitudes whatsoever — while only
    /// the off-diagonal needs a pass, and it reuses the gate exchange's own
    /// staging buffer to get it.
    fn reduced_one(&mut self, qubit: u32) -> Result<[f64; 4], QsimError> {
        if qubit < self.local_qubits {
            let mut acc = [0.0; 4];
            for s in &self.shards {
                let part = s.local_reduced_one(qubit)?;
                for (a, p) in acc.iter_mut().zip(part.iter()) {
                    *a += p;
                }
            }
            return Ok(acc);
        }

        let bit = 1u32 << (qubit - self.local_qubits);
        let mut r00 = 0.0;
        let mut r11 = 0.0;
        for (w, s) in self.shards.iter().enumerate() {
            let mass = s.probability_mass();
            if w as u32 & bit == 0 {
                r00 += mass;
            } else {
                r11 += mass;
            }
        }

        let mut re01 = 0.0;
        let mut im01 = 0.0;
        for low in 0..self.n_shards() {
            if low & bit != 0 {
                continue;
            }
            let high = low | bit;
            let blocks = self.shards[low as usize].num_blocks();
            let block_amps = self.shards[low as usize].block_amps();
            let slice_len = self.shards[low as usize].len();
            for b in 0..blocks {
                let start = b * block_amps;
                let n = (start + block_amps).min(slice_len) - start;
                let (a, rest) = self.shards.split_at_mut(high as usize);
                let lo = &mut a[low as usize];
                let hi = &rest[0];
                lo.scratch_mut()[..n].copy_from_slice(&hi.amps()[start..start + n]);
                self.exchanges += 1;
                let [re, im] = lo.dot_scratch(b)?;
                re01 += re;
                im01 += im;
            }
        }
        Ok([r00, re01, im01, r11])
    }

    fn bloch(&mut self, qubit: u32) -> Result<[f64; 3], QsimError> {
        let [r00, re01, im01, r11] = self.reduced_one(qubit)?;
        Ok([2.0 * re01, -2.0 * im01, r00 - r11])
    }

    /// Global top-`k`, merged from each slice's own top-`k`.
    ///
    /// Exact, and not obviously so: a state can only be in the global top-`k`
    /// if it is in its own shard's top-`k`, since ranking within a slice is the
    /// same ranking as globally.
    fn top_amplitudes(&self, k: usize) -> Vec<(u64, C)> {
        let stride = 1u64 << self.local_qubits;
        let mut merged: Vec<(u64, C)> = Vec::new();
        for (w, s) in self.shards.iter().enumerate() {
            for (i, a) in s.local_top_amplitudes(k) {
                merged.push((w as u64 * stride + i, a));
            }
        }
        merged.sort_by(|x, y| {
            y.1.norm_sqr()
                .partial_cmp(&x.1.norm_sqr())
                .unwrap()
                .then(x.0.cmp(&y.0))
        });
        merged.truncate(k);
        merged
    }

    /// Measure one qubit and collapse, drawing the outcome exactly once against
    /// the *global* marginal — the part a shard cannot do for itself.
    fn measure(&mut self, qubit: u32, rng: &mut Rng) -> Result<u8, QsimError> {
        let [_, _, _, r11] = self.reduced_one(qubit)?;
        let outcome: u8 = if rng.next_f64() < r11 { 1 } else { 0 };
        let p = if outcome == 1 { r11 } else { 1.0 - r11 };
        if p <= 0.0 {
            return Ok(outcome);
        }
        let scale = 1.0 / p.sqrt();

        if qubit < self.local_qubits {
            for s in &mut self.shards {
                s.collapse_local(qubit, outcome, scale)?;
            }
        } else {
            // A global qubit collapses by *shard selection*: the slices on the
            // unobserved side hold nothing afterwards, and no slice is touched
            // amplitude-by-amplitude except to rescale.
            let bit = 1u32 << (qubit - self.local_qubits);
            for (w, s) in self.shards.iter_mut().enumerate() {
                let side: u8 = if w as u32 & bit != 0 { 1 } else { 0 };
                if side == outcome {
                    s.scale(scale);
                } else {
                    s.clear();
                }
            }
        }
        Ok(outcome)
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
        // Variadic names, at the arity the sweep happens to pass them.
        ("mcx", 2, vec![]),
        ("mcz", 2, vec![]),
        ("mcx", 3, vec![]),
        ("mcz", 3, vec![]),
        ("mcx", 4, vec![]),
        ("mcz", 4, vec![]),
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

// ---------------------------------------------------------------------------
// Summaries and measurement, sharded
//
// A visualiser needs per-qubit summaries and mid-circuit measurement to work at
// sharded sizes, where no caller can hold the whole state. Each one is checked
// against `Simulator` on the same circuit, so the sharded answer has to be the
// same answer — not merely a plausible one.
// ---------------------------------------------------------------------------

/// A circuit that entangles across the whole register, so no qubit is left in a
/// state of its own and every summary is non-trivial.
fn spread(sim: &mut Simulator, sharded: &mut ShardedSim, n: u32) -> Result<(), QsimError> {
    let mut apply = |name: &str, qubits: &[u32], params: &[f64]| -> Result<(), QsimError> {
        sim.apply_named(name, qubits, params)?;
        sharded.apply(name, qubits, params)
    };
    for q in 0..n {
        apply("ry", &[q], &[0.4 + 0.3 * q as f64])?;
    }
    for q in 0..n - 1 {
        apply("cx", &[q, q + 1], &[])?;
    }
    for q in 0..n {
        apply("p", &[q], &[0.2 * (q as f64 + 1.0)])?;
    }
    apply("h", &[0], &[])?;
    Ok(())
}

#[test]
fn bloch_vectors_match_whole_state_across_every_layout() {
    let n = 4u32;
    for shard_bits in 0..=n {
        let mut whole = Simulator::new(n).unwrap();
        let mut sharded = ShardedSim::new(n, shard_bits).unwrap();
        spread(&mut whole, &mut sharded, n).unwrap();
        assert_matches(&sharded, &whole, &format!("state before summaries, {shard_bits} bits"));

        for q in 0..n {
            let got = sharded.bloch(q).unwrap();
            let want = whole.bloch_vector(q).unwrap();
            for (axis, (g, w)) in got.iter().zip(want.iter()).enumerate() {
                assert!(
                    (g - w).abs() < TOL,
                    "shard_bits={shard_bits} qubit {q} axis {axis}: sharded {g} vs whole {w}"
                );
            }
        }
        // The summary must not have disturbed anything, exchange buffer or not.
        assert_matches(&sharded, &whole, &format!("state after summaries, {shard_bits} bits"));
    }
}

#[test]
fn top_amplitudes_match_whole_state_across_every_layout() {
    let n = 4u32;
    for shard_bits in 0..=n {
        let mut whole = Simulator::new(n).unwrap();
        let mut sharded = ShardedSim::new(n, shard_bits).unwrap();
        spread(&mut whole, &mut sharded, n).unwrap();

        for k in [1usize, 3, 16] {
            let got = sharded.top_amplitudes(k);
            let want = whole.top_amplitudes(k);
            assert_eq!(got.len(), want.len(), "top {k} length, {shard_bits} bits");
            for (rank, (g, w)) in got.iter().zip(want.iter()).enumerate() {
                assert_eq!(g.0, w.0, "top {k} index at rank {rank}, {shard_bits} bits");
                assert!(
                    (g.1.re - w.1.re).abs() < TOL && (g.1.im - w.1.im).abs() < TOL,
                    "top {k} amplitude at rank {rank}, {shard_bits} bits"
                );
            }
        }
    }
}

#[test]
fn measurement_matches_whole_state_across_every_layout() {
    // The same seed drives both, and the marginals agree, so both must observe
    // the same outcome and collapse onto the same state — including for a qubit
    // that is global in one layout and local in another.
    let n = 4u32;
    for shard_bits in 0..=n {
        for target in 0..n {
            let mut whole = Simulator::new(n).unwrap();
            let mut sharded = ShardedSim::new(n, shard_bits).unwrap();
            spread(&mut whole, &mut sharded, n).unwrap();

            whole.set_seed(0xC0FFEE);
            let mut rng = Rng::new(0xC0FFEE);
            let want = whole.measure(target).unwrap();
            let got = sharded.measure(target, &mut rng).unwrap();

            assert_eq!(got, want, "outcome for qubit {target}, {shard_bits} bits");
            assert_matches(
                &sharded,
                &whole,
                &format!("collapsed state, qubit {target}, {shard_bits} bits"),
            );
            assert!(
                (sharded.norm() - 1.0).abs() < TOL,
                "norm after collapse: {}",
                sharded.norm()
            );
        }
    }
}

#[test]
fn measuring_a_global_qubit_empties_the_shards_it_rules_out() {
    // 3 qubits split 1/2: qubit 2 is the shard-id bit, so measuring it must
    // leave exactly one shard holding everything.
    let mut sharded = ShardedSim::new(3, 1).unwrap();
    sharded.apply("h", &[2], &[]).unwrap();
    let mut rng = Rng::new(7);
    let outcome = sharded.measure(2, &mut rng).unwrap();
    let masses: Vec<f64> = sharded.shards.iter().map(|s| s.probability_mass()).collect();
    let (kept, emptied) = if outcome == 1 { (1, 0) } else { (0, 1) };
    assert!(
        (masses[kept] - 1.0).abs() < TOL,
        "surviving shard holds everything, got {}",
        masses[kept]
    );
    assert!(masses[emptied] == 0.0, "ruled-out shard is empty, got {}", masses[emptied]);
}

#[test]
fn a_local_summary_needs_no_communication() {
    // Local qubits are the reason sharding is worth doing: their summaries are
    // sums within a slice, so asking for one moves nothing between shards.
    let mut sharded = ShardedSim::new(4, 2).unwrap();
    sharded.apply("h", &[0], &[]).unwrap();
    let before = sharded.exchanges;
    for q in 0..sharded.local_qubits {
        sharded.bloch(q).unwrap();
    }
    assert_eq!(sharded.exchanges, before, "local summaries caused traffic");
    // A global qubit's off-diagonal genuinely cannot be answered locally.
    sharded.bloch(sharded.local_qubits).unwrap();
    assert!(sharded.exchanges > before, "global summary caused no traffic");
}
