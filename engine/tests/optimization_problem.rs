// Integration test that mirrors the Python QAOA-style classical brute-force
// solver from the user's example. This checks the classical optimum and
// penalty value reported in the prompt.

#[test]
fn classical_bruteforce_optimum_matches_expected() {
    // weights for the 12 qubits (indices 0..11)
    // H1: 0,1 | H2: 2,3 | HP: 4..7 | F: 8..11
    let weights: [usize; 12] = [1, 1, 1, 1, 1, 2, 4, 3, 1, 2, 4, 6];

    // classical brute-force search using the same ranges as the Python script
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

    let best_pen = best_pen.expect("expected at least one allocation");

    // Expected result stated in the prompt
    let expected_alloc = (2usize, 2usize, 10usize, 6usize);
    let expected_pen = 2.692308_f64;

    assert_eq!(best_alloc, expected_alloc, "best allocation did not match expected");
    let diff = (best_pen - expected_pen).abs();
    assert!(diff < 1e-6, "penalty differs: got {} expected {} (diff {})", best_pen, expected_pen, diff);
}
