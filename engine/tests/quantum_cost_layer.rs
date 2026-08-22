use std::collections::HashMap;

use qsim::Simulator;

#[test]
fn python_qaoa_cost_and_mixer_match() {
    const N: u32 = 12;
    let mut sim = Simulator::new(N).expect("sim alloc");

    // 1) Preparation: H on every qubit (equal superposition)
    sim.prepare_uniform().expect("prepare uniform");

    // 2) Python weights and QAOA parameters
    let weights: [f64; 12] = [1.0, 1.0, 1.0, 1.0, 1.0, 2.0, 4.0, 3.0, 1.0, 2.0, 4.0, 6.0];
    let gamma = 0.1_f64;
    let beta = 0.5_f64;
    let lam = 10.0_f64;

    // Global penalty: Lambda * (Total_Allocated - 20)^2
    for i in 0..(N as usize) {
        for j in 0..(N as usize) {
            if i == j {
                let coeff = lam * (weights[i] * weights[i] - 40.0 * weights[i]);
                let angle = -2.0 * gamma * coeff;
                sim.apply_named("rz", &[i as u32], &[angle]).expect("rz");
            } else if i < j {
                let coeff = 2.0 * lam * weights[i] * weights[j];
                let angle = -2.0 * gamma * coeff;
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("cx");
                sim.apply_named("rz", &[j as u32], &[angle]).expect("rz");
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("cx");
            }
        }
    }

    // Hospital penalty: 5 * (10 - HP)^2
    for i in 4..8 {
        for j in 4..8 {
            if i == j {
                let coeff = 5.0 * (weights[i] * weights[i] - 20.0 * weights[i]);
                let angle = -2.0 * gamma * coeff;
                sim.apply_named("rz", &[i as u32], &[angle]).expect("rz");
            } else if i < j {
                let coeff = 10.0 * weights[i] * weights[j];
                let angle = -2.0 * gamma * coeff;
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("cx");
                sim.apply_named("rz", &[j as u32], &[angle]).expect("rz");
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("cx");
            }
        }
    }

    // Factory penalty: 5 * (13 - F)^2
    for i in 8..12 {
        for j in 8..12 {
            if i == j {
                let coeff = 5.0 * (weights[i] * weights[i] - 26.0 * weights[i]);
                let angle = -2.0 * gamma * coeff;
                sim.apply_named("rz", &[i as u32], &[angle]).expect("rz");
            } else if i < j {
                let coeff = 10.0 * weights[i] * weights[j];
                let angle = -2.0 * gamma * coeff;
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("cx");
                sim.apply_named("rz", &[j as u32], &[angle]).expect("rz");
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("cx");
            }
        }
    }

    // 3) Mixer layer: XPowGate(exponent=(-2 * beta) / pi) == RX(-2 * beta)
    for q in 0..N {
        sim.apply_named("rx", &[q], &[-2.0 * beta]).expect("rx mixer");
    }

    // Classical brute force solver from the Python script
    fn classical_solver() -> ((usize, usize, usize, usize), f64) {
        let mut best_pen: Option<f64> = None;
        let mut best_alloc = (0usize, 0usize, 0usize, 0usize);
        for h1 in 0..=2 {
            for h2 in 0..=2 {
                for hp in 0..=10 {
                    for f in 0..=13 {
                        let total = h1 + h2 + hp + f;
                        if total > 20 {
                            continue;
                        }
                        let pen_h1 = 3.0 * ((2.0 - h1 as f64).max(0.0)) / 2.0;
                        let pen_h2 = 3.0 * ((2.0 - h2 as f64).max(0.0)) / 2.0;
                        let pen_hp = 5.0 * ((10.0 - hp as f64).max(0.0)) / 10.0;
                        let pen_f = 5.0 * ((13.0 - f as f64).max(0.0)) / 13.0;
                        let total_pen = pen_h1 + pen_h2 + pen_hp + pen_f;
                        if best_pen.is_none() || total_pen < best_pen.unwrap() {
                            best_pen = Some(total_pen);
                            best_alloc = (h1, h2, hp, f);
                        }
                    }
                }
            }
        }
        (best_alloc, best_pen.expect("classical best"))
    }

    let (classical_alloc, classical_pen) = classical_solver();
    println!(
        "Classical optimum (brute-force): Home1={}W Home2={}W Hospital={}W Factory={}W  penalty={:.6}",
        classical_alloc.0, classical_alloc.1, classical_alloc.2, classical_alloc.3, classical_pen
    );

    // 4) Measure all qubits at the end, matching the Python 'measure(*qubits)'
    let shots = 5000;
    let flat = sim.sample_flat(shots, 123456789u64);
    let mut hist: HashMap<usize, usize> = HashMap::new();
    for pair in flat.chunks(2) {
        let state = pair[0] as usize;
        let count = pair[1] as usize;
        if count > 0 {
            *hist.entry(state).or_insert(0) += count;
        }
    }

    let weights_usize: [usize; 12] = [1, 1, 1, 1, 1, 2, 4, 3, 1, 2, 4, 6];
    let alloc_from_state = |val: usize| -> (usize, usize, usize, usize) {
        let mut bits = [0usize; 12];
        for i in 0..12 {
            bits[i] = (val >> i) & 1;
        }
        let alloc_h1 = bits[0] * weights_usize[0] + bits[1] * weights_usize[1];
        let alloc_h2 = bits[2] * weights_usize[2] + bits[3] * weights_usize[3];
        let alloc_hp = bits[4] * weights_usize[4]
            + bits[5] * weights_usize[5]
            + bits[6] * weights_usize[6]
            + bits[7] * weights_usize[7];
        let alloc_f = bits[8] * weights_usize[8]
            + bits[9] * weights_usize[9]
            + bits[10] * weights_usize[10]
            + bits[11] * weights_usize[11];
        (alloc_h1, alloc_h2, alloc_hp, alloc_f)
    };

    let mut found_count = 0usize;
    for (state, count) in &hist {
        if alloc_from_state(*state) == classical_alloc {
            found_count = *count;
            break;
        }
    }

    println!(
        "Top measured outcomes (value,count): {:?}",
        hist.iter().take(10).collect::<Vec<_>>()
    );

    println!(
        "Quantum sampling observed the classical optimum {} times among {} shots.",
        found_count, shots
    );

    assert!(found_count > 0, "Python-equivalent QAOA circuit did not sample the classical optimum");
}
