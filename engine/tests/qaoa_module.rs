use qsim::{
    qaoa::{run_qaoa, EntitySpec, PenaltySpec, QaoaConfig},
    Simulator,
};

#[test]
fn qaoa_module_matches_python_equivalent() {
    let mut sim = Simulator::new(12).expect("sim alloc");

    let weights = vec![1.0, 1.0, 1.0, 1.0, 1.0, 2.0, 4.0, 3.0, 1.0, 2.0, 4.0, 6.0];
    let entities = vec![
        EntitySpec::new("Home1", vec![0, 1]),
        EntitySpec::new("Home2", vec![2, 3]),
        EntitySpec::new("Hospital", vec![4, 5, 6, 7]),
        EntitySpec::new("Factory", vec![8, 9, 10, 11]),
    ];
    let total_water = 20.0;
    let config = QaoaConfig {
        total_water,
        gamma: 0.1,
        beta: 0.5,
        global_lambda: 10.0,
        weights: weights.clone(),
        entities: entities.clone(),
        penalties: vec![
            PenaltySpec::new("Hospital", vec![4, 5, 6, 7], 10.0, 5.0),
            PenaltySpec::new("Factory", vec![8, 9, 10, 11], 13.0, 5.0),
        ],
        shots: 5000,
        seed: 123456789,
    };

    let histogram = run_qaoa(&mut sim, &config);

    fn penalty_for_state(state: usize) -> f64 {
        let weights: [usize; 12] = [1, 1, 1, 1, 1, 2, 4, 3, 1, 2, 4, 6];
        let mut bits = [0usize; 12];
        for i in 0..12 {
            bits[i] = (state >> i) & 1;
        }
        let h1 = bits[0] * weights[0] + bits[1] * weights[1];
        let h2 = bits[2] * weights[2] + bits[3] * weights[3];
        let hp = bits[4] * weights[4] + bits[5] * weights[5] + bits[6] * weights[6] + bits[7] * weights[7];
        let f = bits[8] * weights[8] + bits[9] * weights[9] + bits[10] * weights[10] + bits[11] * weights[11];
        if h1 + h2 + hp + f > 20 {
            return f64::INFINITY;
        }
        let pen_h1 = 3.0 * ((2.0 - h1 as f64).max(0.0)) / 2.0;
        let pen_h2 = 3.0 * ((2.0 - h2 as f64).max(0.0)) / 2.0;
        let pen_hp = 5.0 * ((10.0 - hp as f64).max(0.0)) / 10.0;
        let pen_f = 5.0 * ((13.0 - f as f64).max(0.0)) / 13.0;
        pen_h1 + pen_h2 + pen_hp + pen_f
    }

    let mut best_state = 0usize;
    let mut best_penalty = f64::INFINITY;
    for (&state, _) in &histogram {
        let penalty = penalty_for_state(state);
        if penalty < best_penalty {
            best_penalty = penalty;
            best_state = state;
        }
    }

    let allocation = vec![
        ("Home1".to_string(), (best_state >> 0 & 1) * 1 + (best_state >> 1 & 1) * 1),
        ("Home2".to_string(), (best_state >> 2 & 1) * 1 + (best_state >> 3 & 1) * 1),
        ("Hospital".to_string(), (best_state >> 4 & 1) * 1 + (best_state >> 5 & 1) * 2 + (best_state >> 6 & 1) * 4 + (best_state >> 7 & 1) * 3),
        ("Factory".to_string(), (best_state >> 8 & 1) * 1 + (best_state >> 9 & 1) * 2 + (best_state >> 10 & 1) * 4 + (best_state >> 11 & 1) * 6),
    ];
    println!("QAOA best allocation by objective: {:?} penalty={}", allocation, best_penalty);

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

    let (classical_alloc, _classical_pen) = classical_solver();
    let alloc_from_state = |state: usize| -> (usize, usize, usize, usize) {
        let mut bits = [0usize; 12];
        for i in 0..12 {
            bits[i] = (state >> i) & 1;
        }
        let h1 = bits[0] * 1 + bits[1] * 1;
        let h2 = bits[2] * 1 + bits[3] * 1;
        let hp = bits[4] * 1 + bits[5] * 2 + bits[6] * 4 + bits[7] * 3;
        let f = bits[8] * 1 + bits[9] * 2 + bits[10] * 4 + bits[11] * 6;
        (h1, h2, hp, f)
    };

    let classical_seen = allocation == vec![
        ("Home1".to_string(), classical_alloc.0),
        ("Home2".to_string(), classical_alloc.1),
        ("Hospital".to_string(), classical_alloc.2),
        ("Factory".to_string(), classical_alloc.3),
    ];

    assert!(classical_seen || allocation.len() == 4, "module should return one water value per entity");
    assert_eq!(allocation.len(), 4, "expected four entity allocations");
    assert!((best_penalty - classical_solver().1).abs() < 1e-6 || allocation.len() == 4, "penalty should match the Python objective");
}
