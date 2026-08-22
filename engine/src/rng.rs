//! Small seedable PRNG.
//!
//! Rolled by hand rather than using `rand`, which drags in `getrandom` and its
//! WASM entropy-source configuration. Measurement needs reproducibility from an
//! explicit seed far more than it needs cryptographic quality, and xorshift64*
//! is plenty for sampling a probability distribution.

pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        // SplitMix-style scramble, then force non-zero: xorshift is stuck at 0.
        let mut s = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        s ^= s >> 33;
        Rng {
            state: if s == 0 { 0x9E3779B97F4A7C15 } else { s },
        }
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }

    /// Uniform in [0, 1) using the top 53 bits — the exact f64 mantissa width.
    #[inline]
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / 9007199254740992.0)
    }
}
