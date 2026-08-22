//! Minimal complex number type.
//!
//! Hand-rolled rather than pulling in `num-complex` so the gate kernels can be
//! tuned without fighting a generic abstraction, and so the WASM payload stays small.

use std::ops::{Add, Mul, Sub};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct C {
    pub re: f64,
    pub im: f64,
}

impl C {
    pub const ZERO: C = C { re: 0.0, im: 0.0 };
    pub const ONE: C = C { re: 1.0, im: 0.0 };
    pub const I: C = C { re: 0.0, im: 1.0 };

    #[inline(always)]
    pub const fn new(re: f64, im: f64) -> Self {
        C { re, im }
    }

    /// `e^{i*theta}`
    #[inline(always)]
    pub fn from_phase(theta: f64) -> Self {
        C {
            re: theta.cos(),
            im: theta.sin(),
        }
    }

    /// Squared magnitude — the measurement probability of this amplitude.
    #[inline(always)]
    pub fn norm_sqr(self) -> f64 {
        self.re * self.re + self.im * self.im
    }

    #[inline(always)]
    pub fn conj(self) -> Self {
        C {
            re: self.re,
            im: -self.im,
        }
    }

    #[inline(always)]
    pub fn scale(self, k: f64) -> Self {
        C {
            re: self.re * k,
            im: self.im * k,
        }
    }
}

impl Add for C {
    type Output = C;
    #[inline(always)]
    fn add(self, o: C) -> C {
        C {
            re: self.re + o.re,
            im: self.im + o.im,
        }
    }
}

impl Sub for C {
    type Output = C;
    #[inline(always)]
    fn sub(self, o: C) -> C {
        C {
            re: self.re - o.re,
            im: self.im - o.im,
        }
    }
}

impl Mul for C {
    type Output = C;
    #[inline(always)]
    fn mul(self, o: C) -> C {
        C {
            re: self.re * o.re - self.im * o.im,
            im: self.re * o.im + self.im * o.re,
        }
    }
}

/// A 2x2 unitary, row-major: `[[a, b], [c, d]]`.
#[derive(Clone, Copy, Debug)]
pub struct Mat2 {
    pub a: C,
    pub b: C,
    pub c: C,
    pub d: C,
}
