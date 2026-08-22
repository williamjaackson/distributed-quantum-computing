use qsim::Simulator;

// Verify the cost-layer unitary implemented via single-qubit RZ and ZZ
// (decomposed as CNOT-RZ-CNOT) applies the expected phases to the uniform
// superposition. The expected amplitude for basis state `x` is
// 1/sqrt(2^n) * exp(i * phi_x) where phi_x is computed from the applied
// RZ/ZZ angles.

#[test]
fn cost_layer_matches_expected_phases() {
    const N: u32 = 12;
    let mut sim = Simulator::new(N).expect("sim alloc");

    // Prepare uniform superposition (H on every qubit)
    sim.prepare_uniform().expect("prepare uniform");

    // weights mapping from the Python example
    let weights: [f64; 12] = [1.0, 1.0, 1.0, 1.0, 1.0, 2.0, 4.0, 3.0, 1.0, 2.0, 4.0, 6.0];

    // parameters
    let gamma = 0.1_f64;
    let lam = 10.0_f64; // global penalty Lagrange multiplier

    // record applied single-qubit RZ angles per qubit and pair ZZ angles
    let mut single_angles = vec![0.0_f64; N as usize];
    let mut pair_angles = vec![vec![0.0_f64; N as usize]; N as usize];

    // Global penalty: Lambda * (Total_Allocated - 20)^2 expanded
    for i in 0..(N as usize) {
        for j in 0..(N as usize) {
            if i == j {
                let coeff = lam * (weights[i] * weights[i] - 40.0 * weights[i]);
                let angle = -2.0 * gamma * coeff;
                sim.apply_named("rz", &[i as u32], &[angle]).expect("rz");
                single_angles[i] += angle;
            } else if i < j {
                let coeff = 2.0 * lam * weights[i] * weights[j];
                let angle = -2.0 * gamma * coeff;
                // implement ZZ(angle) via CNOT(i->j); RZ(j, angle); CNOT(i->j)
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("cx");
                sim.apply_named("rz", &[j as u32], &[angle]).expect("rz");
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("cx");
                pair_angles[i][j] += angle;
            }
        }
    }

    // Hospital penalty: 5 * (10 - HP)^2 for hp indices 4..7
    for i in 4..8 {
        for j in 4..8 {
            if i == j {
                let coeff = 5.0 * (weights[i] * weights[i] - 20.0 * weights[i]);
                let angle = -2.0 * gamma * coeff;
                sim.apply_named("rz", &[i as u32], &[angle]).expect("rz");
                single_angles[i] += angle;
            } else if i < j {
                let coeff = 10.0 * weights[i] * weights[j];
                let angle = -2.0 * gamma * coeff;
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("cx");
                sim.apply_named("rz", &[j as u32], &[angle]).expect("rz");
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("cx");
                pair_angles[i][j] += angle;
            }
        }
    }

    // Factory penalty: 5 * (13 - F)^2 for f indices 8..11
    for i in 8..12 {
        for j in 8..12 {
            if i == j {
                let coeff = 5.0 * (weights[i] * weights[i] - 26.0 * weights[i]);
                let angle = -2.0 * gamma * coeff;
                sim.apply_named("rz", &[i as u32], &[angle]).expect("rz");
                single_angles[i] += angle;
            } else if i < j {
                let coeff = 10.0 * weights[i] * weights[j];
                let angle = -2.0 * gamma * coeff;
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("cx");
                sim.apply_named("rz", &[j as u32], &[angle]).expect("rz");
                sim.apply_named("cx", &[i as u32, j as u32], &[] as &[f64]).expect("cx");
                pair_angles[i][j] += angle;
            }
        }
    }

    // Now read back the amplitudes and compare against analytic phases.
    let amps_flat = sim.amplitudes().expect("amplitudes");
    let n_states = 1usize << N;
    assert_eq!(amps_flat.len(), n_states * 2);

    let uniform_amp = 1.0 / (2usize.pow(N) as f64).sqrt();

    // --- Classical brute-force solver (same logic as the Python example) ---
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
    println!("Classical optimum (brute-force): Home1={}W Home2={}W Hospital={}W Factory={}W  penalty={:.6}",
        classical_alloc.0, classical_alloc.1, classical_alloc.2, classical_alloc.3, classical_pen);

    // helper: decode allocation from basis state value
    let weights_usize: [usize; 12] = [1,1,1,1,1,2,4,3,1,2,4,6];
    let alloc_from_state = |val: usize| -> (usize, usize, usize, usize) {
        let mut bits = [0usize; 12];
        for i in 0..12 { bits[i] = (val >> i) & 1; }
        let alloc_h1 = bits[0]*weights_usize[0] + bits[1]*weights_usize[1];
        let alloc_h2 = bits[2]*weights_usize[2] + bits[3]*weights_usize[3];
        let alloc_hp = bits[4]*weights_usize[4] + bits[5]*weights_usize[5] + bits[6]*weights_usize[6] + bits[7]*weights_usize[7];
        let alloc_f  = bits[8]*weights_usize[8] + bits[9]*weights_usize[9] + bits[10]*weights_usize[10] + bits[11]*weights_usize[11];
        (alloc_h1, alloc_h2, alloc_hp, alloc_f)
    };

    let mut best_prob = -1.0_f64;
    let mut best_state = 0usize;

    for state in 0..n_states {
        // compute bits and z values (z = +1 for |0>, -1 for |1>)
        let mut phi = 0.0_f64;
        for q in 0..(N as usize) {
            let bit = ((state >> q) & 1) as i32;
            let two_b_minus1 = (2 * bit - 1) as f64;
            phi += two_b_minus1 * single_angles[q] / 2.0;
        }
        for i in 0..(N as usize) {
            for j in (i + 1)..(N as usize) {
                let pair_angle = pair_angles[i][j];
                if pair_angle == 0.0 {
                    continue;
                }
                let bi = ((state >> i) & 1) as i32;
                let bj = ((state >> j) & 1) as i32;
                let zi = (1 - 2 * bi) as f64; // +1 for 0, -1 for 1
                let zj = (1 - 2 * bj) as f64;
                phi += -pair_angle / 2.0 * (zi * zj);
            }
        }

        let expected_re = uniform_amp * phi.cos();
        let expected_im = uniform_amp * phi.sin();

        let re = amps_flat[2 * state];
        let im = amps_flat[2 * state + 1];
        let prob = re * re + im * im;
        if prob > best_prob {
            best_prob = prob;
            best_state = state;
        }

        let diff_re = (re - expected_re).abs();
        let diff_im = (im - expected_im).abs();
        let tol = 1e-12;
        assert!(diff_re < tol && diff_im < tol, "state {} mismatch: got ({},{}) expected ({},{})", state, re, im, expected_re, expected_im);
        // If this state matches the classical allocation, print its details
        let alloc = alloc_from_state(state);
        if alloc == classical_alloc {
            // compute classical penalty for this allocation
            let pen_h1 = 3.0 * ((2.0 - alloc.0 as f64).max(0.0)) / 2.0;
            let pen_h2 = 3.0 * ((2.0 - alloc.1 as f64).max(0.0)) / 2.0;
            let pen_hp = 5.0 * ((10.0 - alloc.2 as f64).max(0.0)) / 10.0;
            let pen_f = 5.0 * ((13.0 - alloc.3 as f64).max(0.0)) / 13.0;
            let total_pen = pen_h1 + pen_h2 + pen_hp + pen_f;
            println!("Found basis state {} matching classical alloc Home1={} Home2={} HP={} F={}  penalty={:.6}  prob={:.6}",
                state, alloc.0, alloc.1, alloc.2, alloc.3, total_pen, prob);
        }
    }

    // print the most probable state's allocation and penalty
    let best_alloc_state = alloc_from_state(best_state);
    let pen_h1 = 3.0 * ((2.0 - best_alloc_state.0 as f64).max(0.0)) / 2.0;
    let pen_h2 = 3.0 * ((2.0 - best_alloc_state.1 as f64).max(0.0)) / 2.0;
    let pen_hp = 5.0 * ((10.0 - best_alloc_state.2 as f64).max(0.0)) / 10.0;
    let pen_f = 5.0 * ((13.0 - best_alloc_state.3 as f64).max(0.0)) / 13.0;
    let total_pen = pen_h1 + pen_h2 + pen_hp + pen_f;
    println!("Most probable state {} alloc Home1={} Home2={} HP={} F={} penalty={:.6} prob={:.6}",
        best_state, best_alloc_state.0, best_alloc_state.1, best_alloc_state.2, best_alloc_state.3, total_pen, best_prob);
}
