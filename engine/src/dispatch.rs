//! Gate-name dispatch, shared by the whole-state and sharded execution paths.
//!
//! Folding every controlled gate into "single-qubit unitary + N controls" means
//! one kernel family covers CNOT, CZ, controlled-phase and Toffoli, and callers
//! need no per-gate binding — they pass a name, the qubits, and any angles.

use crate::complex::Mat2;
use crate::gates::{self, Gate};
use crate::state::{QsimError, StateVector};

/// A parsed operation.
#[derive(Clone, Copy, Debug)]
pub enum Op {
    Unitary { gate: Gate, controls: usize },
    Swap,
}

fn param(params: &[f64], i: usize, name: &str, needed: usize) -> Result<f64, QsimError> {
    params
        .get(i)
        .copied()
        .ok_or_else(|| QsimError::MissingParams {
            gate: name.to_string(),
            expected: needed,
            got: params.len(),
        })
}

pub fn parse_op(name: &str, params: &[f64]) -> Result<Op, QsimError> {
    let lower = name.to_ascii_lowercase();
    let n = lower.as_str();

    let fixed = match n {
        "h" => Some(Gate::H),
        "x" => Some(Gate::X),
        "y" => Some(Gate::Y),
        "z" => Some(Gate::Z),
        "s" => Some(Gate::S),
        "sdg" => Some(Gate::Sdg),
        "t" => Some(Gate::T),
        "tdg" => Some(Gate::Tdg),
        _ => None,
    };
    if let Some(g) = fixed {
        return Ok(Op::Unitary { gate: g, controls: 0 });
    }

    // Rotations and phase shifts, one angle. A leading `c` marks the controlled
    // variant, which reuses the same base gate.
    let one_angle = matches!(
        n,
        "rx" | "ry" | "rz" | "p" | "phase" | "crx" | "cry" | "crz" | "cp" | "cphase"
    );
    if one_angle {
        let theta = param(params, 0, n, 1)?;
        let base = match n {
            "rx" | "crx" => Gate::RX(theta),
            "ry" | "cry" => Gate::RY(theta),
            "rz" | "crz" => Gate::RZ(theta),
            _ => Gate::P(theta),
        };
        let controls = if n.starts_with('c') { 1 } else { 0 };
        return Ok(Op::Unitary { gate: base, controls });
    }

    match n {
        "u3" | "u" => Ok(Op::Unitary {
            gate: Gate::U3(
                param(params, 0, n, 3)?,
                param(params, 1, n, 3)?,
                param(params, 2, n, 3)?,
            ),
            controls: 0,
        }),
        "cx" | "cnot" => Ok(Op::Unitary { gate: Gate::X, controls: 1 }),
        "cy" => Ok(Op::Unitary { gate: Gate::Y, controls: 1 }),
        "cz" => Ok(Op::Unitary { gate: Gate::Z, controls: 1 }),
        "ch" => Ok(Op::Unitary { gate: Gate::H, controls: 1 }),
        "ccx" | "toffoli" => Ok(Op::Unitary { gate: Gate::X, controls: 2 }),
        "ccz" => Ok(Op::Unitary { gate: Gate::Z, controls: 2 }),
        "swap" => Ok(Op::Swap),
        _ => Err(QsimError::UnknownGate(name.to_string())),
    }
}

impl Op {
    /// Qubits this operation expects.
    pub fn arity(self) -> usize {
        match self {
            Op::Swap => 2,
            Op::Unitary { controls, .. } => controls + 1,
        }
    }

    pub fn matrix(self) -> Option<Mat2> {
        match self {
            Op::Swap => None,
            Op::Unitary { gate, .. } => Some(gate.matrix()),
        }
    }

    pub fn check_arity(self, name: &str, got: usize) -> Result<(), QsimError> {
        if got == self.arity() {
            Ok(())
        } else {
            Err(QsimError::WrongArity {
                gate: name.to_string(),
                expected: self.arity(),
                got,
            })
        }
    }
}

/// Apply a named gate to a whole state vector. `qubits` lists controls first,
/// then the target.
pub fn apply_named(
    sv: &mut StateVector,
    name: &str,
    qubits: &[u32],
    params: &[f64],
) -> Result<(), QsimError> {
    let op = parse_op(name, params)?;
    op.check_arity(name, qubits.len())?;
    match op {
        Op::Swap => gates::apply_swap(sv, qubits[0], qubits[1]),
        Op::Unitary { gate, controls } => {
            let (ctrl, target) = qubits.split_at(controls);
            gates::apply_controlled(sv, gate, ctrl, target[0])
        }
    }
}

/// Every gate name [`apply_named`] understands, for UI palettes.
pub const GATE_NAMES: &[&str] = &[
    "h", "x", "y", "z", "s", "sdg", "t", "tdg", "rx", "ry", "rz", "p", "u3", "cx", "cy", "cz",
    "ch", "crx", "cry", "crz", "cp", "ccx", "ccz", "swap",
];

/// Gate names in their *uncontrolled* form.
///
/// A planned step's arity changes when some controls are resolved by shard
/// selection ("ccx" with one global control becomes a one-control gate), so a
/// plan cannot carry the original name. It carries the base gate plus an
/// explicit control list instead, and these are the names for that base.
pub const BASE_GATES: &[&str] = &[
    "h", "x", "y", "z", "s", "sdg", "t", "tdg", "rx", "ry", "rz", "p", "u3",
];

impl Op {
    /// The uncontrolled name and angles for this op's base gate.
    pub fn base(self) -> Option<(&'static str, Vec<f64>)> {
        let (name, params) = match self {
            Op::Swap => return None,
            Op::Unitary { gate, .. } => match gate {
                Gate::H => ("h", vec![]),
                Gate::X => ("x", vec![]),
                Gate::Y => ("y", vec![]),
                Gate::Z => ("z", vec![]),
                Gate::S => ("s", vec![]),
                Gate::Sdg => ("sdg", vec![]),
                Gate::T => ("t", vec![]),
                Gate::Tdg => ("tdg", vec![]),
                Gate::RX(t) => ("rx", vec![t]),
                Gate::RY(t) => ("ry", vec![t]),
                Gate::RZ(t) => ("rz", vec![t]),
                Gate::P(t) => ("p", vec![t]),
                Gate::U3(a, b, c) => ("u3", vec![a, b, c]),
            },
        };
        Some((name, params))
    }
}

/// Index of a base gate in [`BASE_GATES`], for compact plan encoding.
pub fn base_gate_id(name: &str) -> Option<usize> {
    BASE_GATES.iter().position(|g| *g == name)
}

/// Apply a base (uncontrolled) gate with an explicit control list.
pub fn apply_base(
    sv: &mut StateVector,
    base: &str,
    params: &[f64],
    controls: &[u32],
    target: u32,
) -> Result<(), QsimError> {
    match parse_op(base, params)? {
        Op::Swap => Err(QsimError::NotPairable(base.to_string())),
        Op::Unitary { gate, .. } => gates::apply_controlled(sv, gate, controls, target),
    }
}
