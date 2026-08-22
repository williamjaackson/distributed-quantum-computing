//! Gate kernels.
//!
//! A single-qubit gate acting on qubit `t` mixes every pair of amplitudes whose
//! indices differ only in bit `t`. Those pairs sit exactly `step = 1 << t` apart,
//! so the state splits into contiguous blocks of `2 * step` that each divide into
//! a "bit clear" half and a "bit set" half. Iterating with `chunks_exact_mut` +
//! `split_at_mut` hands the compiler two disjoint slices of known equal length,
//! which lets it drop bounds checks and vectorise the inner loop — no `unsafe`.
//!
//! Nothing here ever materialises a 2^n x 2^n matrix; the largest object is 2x2.

use crate::complex::{Mat2, C};
use crate::state::{QsimError, StateVector};

const INV_SQRT2: f64 = std::f64::consts::FRAC_1_SQRT_2;

// ---------------------------------------------------------------------------
// Uncontrolled kernels
// ---------------------------------------------------------------------------

/// Generic 2x2 application: the fallback for gates with no cheaper structure.
fn apply_mat2(sv: &mut StateVector, m: Mat2, target: u32) {
    let step = 1usize << target;
    for block in sv.amps_mut().chunks_exact_mut(step << 1) {
        let (lo, hi) = block.split_at_mut(step);
        for (x, y) in lo.iter_mut().zip(hi.iter_mut()) {
            let (a, b) = (*x, *y);
            *x = m.a * a + m.b * b;
            *y = m.c * a + m.d * b;
        }
    }
}

/// Diagonal gate: multiply each half by a constant. Half the flops of the
/// generic path and no cross-term, so Z/S/T/RZ/Phase all land here.
fn apply_diag(sv: &mut StateVector, p0: C, p1: C, target: u32) {
    let step = 1usize << target;
    for block in sv.amps_mut().chunks_exact_mut(step << 1) {
        let (lo, hi) = block.split_at_mut(step);
        for (x, y) in lo.iter_mut().zip(hi.iter_mut()) {
            *x = p0 * *x;
            *y = p1 * *y;
        }
    }
}

/// Pauli X: a pure swap, no arithmetic at all.
fn apply_x(sv: &mut StateVector, target: u32) {
    let step = 1usize << target;
    for block in sv.amps_mut().chunks_exact_mut(step << 1) {
        let (lo, hi) = block.split_at_mut(step);
        lo.swap_with_slice(hi);
    }
}

/// Pauli Z: negate the "bit set" half.
fn apply_z(sv: &mut StateVector, target: u32) {
    let step = 1usize << target;
    for block in sv.amps_mut().chunks_exact_mut(step << 1) {
        let (_, hi) = block.split_at_mut(step);
        for y in hi.iter_mut() {
            *y = C::new(-y.re, -y.im);
        }
    }
}

/// Pauli Y: swap plus a +-i twist, done with real adds rather than complex muls.
fn apply_y(sv: &mut StateVector, target: u32) {
    let step = 1usize << target;
    for block in sv.amps_mut().chunks_exact_mut(step << 1) {
        let (lo, hi) = block.split_at_mut(step);
        for (x, y) in lo.iter_mut().zip(hi.iter_mut()) {
            let (a, b) = (*x, *y);
            // -i * b  and  +i * a
            *x = C::new(b.im, -b.re);
            *y = C::new(-a.im, a.re);
        }
    }
}

/// Hadamard: sum/difference scaled by 1/sqrt(2), all real multiplies.
fn apply_h(sv: &mut StateVector, target: u32) {
    let step = 1usize << target;
    for block in sv.amps_mut().chunks_exact_mut(step << 1) {
        let (lo, hi) = block.split_at_mut(step);
        for (x, y) in lo.iter_mut().zip(hi.iter_mut()) {
            let (a, b) = (*x, *y);
            *x = C::new((a.re + b.re) * INV_SQRT2, (a.im + b.im) * INV_SQRT2);
            *y = C::new((a.re - b.re) * INV_SQRT2, (a.im - b.im) * INV_SQRT2);
        }
    }
}

// ---------------------------------------------------------------------------
// Controlled kernels
// ---------------------------------------------------------------------------

/// Apply `m` to `target` only on basis states where every control bit is 1.
///
/// Controls may sit either side of the target bit, so the mask is tested per
/// element against the absolute index rather than per block.
fn apply_mat2_controlled(sv: &mut StateVector, m: Mat2, cmask: usize, target: u32) {
    let step = 1usize << target;
    for (b, block) in sv.amps_mut().chunks_exact_mut(step << 1).enumerate() {
        let base = b * (step << 1);
        let (lo, hi) = block.split_at_mut(step);
        for k in 0..step {
            if (base + k) & cmask == cmask {
                let (a, bb) = (lo[k], hi[k]);
                lo[k] = m.a * a + m.b * bb;
                hi[k] = m.c * a + m.d * bb;
            }
        }
    }
}

/// Controlled X (CNOT / Toffoli): swap only where the controls hold.
fn apply_x_controlled(sv: &mut StateVector, cmask: usize, target: u32) {
    let step = 1usize << target;
    for (b, block) in sv.amps_mut().chunks_exact_mut(step << 1).enumerate() {
        let base = b * (step << 1);
        let (lo, hi) = block.split_at_mut(step);
        for k in 0..step {
            if (base + k) & cmask == cmask {
                std::mem::swap(&mut lo[k], &mut hi[k]);
            }
        }
    }
}

/// Controlled diagonal (CZ, controlled-phase): touches only the all-ones corner,
/// so it degenerates to a single scalar multiply per matching index.
fn apply_diag_controlled(sv: &mut StateVector, p0: C, p1: C, cmask: usize, target: u32) {
    let step = 1usize << target;
    for (b, block) in sv.amps_mut().chunks_exact_mut(step << 1).enumerate() {
        let base = b * (step << 1);
        let (lo, hi) = block.split_at_mut(step);
        for k in 0..step {
            if (base + k) & cmask == cmask {
                lo[k] = p0 * lo[k];
                hi[k] = p1 * hi[k];
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Gate definitions
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Gate {
    H,
    X,
    Y,
    Z,
    S,
    Sdg,
    T,
    Tdg,
    RX(f64),
    RY(f64),
    RZ(f64),
    /// Phase shift on |1>: diag(1, e^{i*theta}).
    P(f64),
    /// General single-qubit unitary U3(theta, phi, lambda).
    U3(f64, f64, f64),
}

impl Gate {
    pub fn matrix(self) -> Mat2 {
        match self {
            Gate::H => Mat2 {
                a: C::new(INV_SQRT2, 0.0),
                b: C::new(INV_SQRT2, 0.0),
                c: C::new(INV_SQRT2, 0.0),
                d: C::new(-INV_SQRT2, 0.0),
            },
            Gate::X => Mat2 {
                a: C::ZERO,
                b: C::ONE,
                c: C::ONE,
                d: C::ZERO,
            },
            Gate::Y => Mat2 {
                a: C::ZERO,
                b: C::new(0.0, -1.0),
                c: C::I,
                d: C::ZERO,
            },
            Gate::RX(t) => {
                let (c, s) = ((t / 2.0).cos(), (t / 2.0).sin());
                Mat2 {
                    a: C::new(c, 0.0),
                    b: C::new(0.0, -s),
                    c: C::new(0.0, -s),
                    d: C::new(c, 0.0),
                }
            }
            Gate::RY(t) => {
                let (c, s) = ((t / 2.0).cos(), (t / 2.0).sin());
                Mat2 {
                    a: C::new(c, 0.0),
                    b: C::new(-s, 0.0),
                    c: C::new(s, 0.0),
                    d: C::new(c, 0.0),
                }
            }
            Gate::U3(theta, phi, lam) => {
                let (c, s) = ((theta / 2.0).cos(), (theta / 2.0).sin());
                Mat2 {
                    a: C::new(c, 0.0),
                    b: C::from_phase(lam).scale(-s),
                    c: C::from_phase(phi).scale(s),
                    d: C::from_phase(phi + lam).scale(c),
                }
            }
            // Diagonal gates, expressed as a matrix for completeness.
            _ => {
                let (p0, p1) = self.diagonal().expect("non-diagonal gate handled above");
                Mat2 {
                    a: p0,
                    b: C::ZERO,
                    c: C::ZERO,
                    d: p1,
                }
            }
        }
    }

    /// The diagonal entries, if this gate is diagonal. Lets callers pick the
    /// cheaper kernel and makes controlled-phase gates trivial.
    pub fn diagonal(self) -> Option<(C, C)> {
        match self {
            Gate::Z => Some((C::ONE, C::new(-1.0, 0.0))),
            Gate::S => Some((C::ONE, C::I)),
            Gate::Sdg => Some((C::ONE, C::new(0.0, -1.0))),
            Gate::T => Some((C::ONE, C::from_phase(std::f64::consts::FRAC_PI_4))),
            Gate::Tdg => Some((C::ONE, C::from_phase(-std::f64::consts::FRAC_PI_4))),
            Gate::P(t) => Some((C::ONE, C::from_phase(t))),
            Gate::RZ(t) => Some((C::from_phase(-t / 2.0), C::from_phase(t / 2.0))),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Apply a single-qubit gate, routing to a specialised kernel where one exists.
pub fn apply(sv: &mut StateVector, gate: Gate, target: u32) -> Result<(), QsimError> {
    sv.check_qubit(target)?;
    match gate {
        Gate::H => apply_h(sv, target),
        Gate::X => apply_x(sv, target),
        Gate::Y => apply_y(sv, target),
        Gate::Z => apply_z(sv, target),
        other => match other.diagonal() {
            Some((p0, p1)) => apply_diag(sv, p0, p1, target),
            None => apply_mat2(sv, other.matrix(), target),
        },
    }
    Ok(())
}

/// Apply a single-qubit gate conditioned on any number of control qubits.
///
/// With an empty control list this is exactly [`apply`], which keeps the
/// gate-dispatch layer in `lib.rs` from special-casing arity.
pub fn apply_controlled(
    sv: &mut StateVector,
    gate: Gate,
    controls: &[u32],
    target: u32,
) -> Result<(), QsimError> {
    if controls.is_empty() {
        return apply(sv, gate, target);
    }
    let mut all: Vec<u32> = controls.to_vec();
    all.push(target);
    sv.check_distinct(&all)?;

    let cmask = controls.iter().fold(0usize, |m, &c| m | (1usize << c));
    match gate {
        Gate::X => apply_x_controlled(sv, cmask, target),
        other => match other.diagonal() {
            Some((p0, p1)) => apply_diag_controlled(sv, p0, p1, cmask, target),
            None => apply_mat2_controlled(sv, other.matrix(), cmask, target),
        },
    }
    Ok(())
}

/// Exchange two qubits by swapping the amplitudes whose bits disagree.
pub fn apply_swap(sv: &mut StateVector, a: u32, b: u32) -> Result<(), QsimError> {
    sv.check_distinct(&[a, b])?;
    let (ma, mb) = (1usize << a, 1usize << b);
    let amps = sv.amps_mut();
    for i in 0..amps.len() {
        // Visit each disagreeing pair once by requiring a set / b clear.
        if (i & ma != 0) && (i & mb == 0) {
            amps.swap(i, i ^ ma ^ mb);
        }
    }
    Ok(())
}
