//! The state vector: 2^n complex amplitudes.

use crate::complex::C;

/// Hard ceiling on qubit count, set by pointer width.
///
/// On wasm32 `usize` is 32 bits and the whole address space is 4 GiB, so
/// `2^n * size_of::<C>()` (16 bytes) must stay under that: 2^28 * 16 == 2^32,
/// which overflows exactly, leaving 27 as the largest representable size.
/// Reaching even 27 depends on the browser actually granting ~2 GiB, which is
/// what the capacity probe measures.
pub const MAX_QUBITS: u32 = if usize::BITS == 32 { 27 } else { 32 };

#[derive(Debug, Clone, PartialEq)]
pub enum QsimError {
    /// Requested qubit count exceeds what this build can address.
    TooManyQubits { requested: u32, max: u32 },
    /// The allocator refused the request — this is the expected outcome at the
    /// top of the capacity probe, so it must be recoverable, never a panic.
    OutOfMemory { requested: u32, bytes: u64 },
    InvalidQubit { qubit: u32, n_qubits: u32 },
    /// Same qubit used twice in a multi-qubit gate.
    DuplicateQubit(u32),
    WrongArity { gate: String, expected: usize, got: usize },
    UnknownGate(String),
    /// Operation would allocate a second buffer as large as the state vector.
    TooLargeForOperation { n_qubits: u32, limit: u32 },
    /// A parameterised gate was invoked without enough angles.
    MissingParams { gate: String, expected: usize, got: usize },
}

impl std::fmt::Display for QsimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QsimError::TooManyQubits { requested, max } => write!(
                f,
                "{requested} qubits exceeds the maximum of {max} for this build"
            ),
            QsimError::OutOfMemory { requested, bytes } => write!(
                f,
                "out of memory allocating {requested} qubits ({bytes} bytes)"
            ),
            QsimError::InvalidQubit { qubit, n_qubits } => {
                write!(f, "qubit {qubit} out of range for a {n_qubits}-qubit state")
            }
            QsimError::DuplicateQubit(q) => {
                write!(f, "qubit {q} used more than once in the same gate")
            }
            QsimError::WrongArity { gate, expected, got } => write!(
                f,
                "gate {gate} expects {expected} qubit(s), got {got}"
            ),
            QsimError::UnknownGate(g) => write!(f, "unknown gate '{g}'"),
            QsimError::TooLargeForOperation { n_qubits, limit } => write!(
                f,
                "operation needs a full-size buffer; {n_qubits} qubits exceeds the limit of {limit}"
            ),
            QsimError::MissingParams { gate, expected, got } => write!(
                f,
                "gate {gate} expects {expected} parameter(s), got {got}"
            ),
        }
    }
}

/// Bytes needed for the amplitude array of an `n`-qubit state.
///
/// Computed in `u64` so it stays correct past the 32-bit ceiling and can be
/// reported to the UI for qubit counts this machine cannot actually allocate.
pub fn memory_bytes_required(n_qubits: u32) -> u64 {
    (std::mem::size_of::<C>() as u64) << n_qubits
}

pub struct StateVector {
    n_qubits: u32,
    amps: Vec<C>,
}

/// Deliberately summarises rather than deriving: a derived `Debug` would try to
/// format up to 2^27 amplitudes if a state vector ever reached an assertion.
impl std::fmt::Debug for StateVector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StateVector")
            .field("n_qubits", &self.n_qubits)
            .field("amplitudes", &self.amps.len())
            .finish()
    }
}

impl StateVector {
    /// Allocate an `n`-qubit register in |00...0>.
    ///
    /// Uses `try_reserve_exact` so an oversized request returns `Err` instead of
    /// aborting the process — essential in WASM, where a panic poisons the whole
    /// module instance and would kill the benchmark mid-probe.
    pub fn try_new(n_qubits: u32) -> Result<Self, QsimError> {
        if n_qubits > MAX_QUBITS {
            return Err(QsimError::TooManyQubits {
                requested: n_qubits,
                max: MAX_QUBITS,
            });
        }
        let len = 1usize << n_qubits;
        let mut amps: Vec<C> = Vec::new();
        amps.try_reserve_exact(len)
            .map_err(|_| QsimError::OutOfMemory {
                requested: n_qubits,
                bytes: memory_bytes_required(n_qubits),
            })?;
        amps.resize(len, C::ZERO);
        amps[0] = C::ONE;
        Ok(StateVector { n_qubits, amps })
    }

    #[inline]
    pub fn n_qubits(&self) -> u32 {
        self.n_qubits
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.amps.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        false
    }

    #[inline]
    pub fn amps(&self) -> &[C] {
        &self.amps
    }

    #[inline]
    pub fn amps_mut(&mut self) -> &mut [C] {
        &mut self.amps
    }

    /// Collapse back to |00...0> without reallocating.
    pub fn reset(&mut self) {
        self.amps.fill(C::ZERO);
        self.amps[0] = C::ONE;
    }

    /// Total probability. Should stay at 1 for any sequence of unitary gates —
    /// the cheapest end-to-end check that the kernels are correct.
    pub fn norm(&self) -> f64 {
        self.amps.iter().map(|a| a.norm_sqr()).sum()
    }

    pub(crate) fn check_qubit(&self, q: u32) -> Result<(), QsimError> {
        if q >= self.n_qubits {
            Err(QsimError::InvalidQubit {
                qubit: q,
                n_qubits: self.n_qubits,
            })
        } else {
            Ok(())
        }
    }

    /// Validate that every qubit is in range and no qubit repeats.
    pub(crate) fn check_distinct(&self, qubits: &[u32]) -> Result<(), QsimError> {
        for (i, &q) in qubits.iter().enumerate() {
            self.check_qubit(q)?;
            if qubits[..i].contains(&q) {
                return Err(QsimError::DuplicateQubit(q));
            }
        }
        Ok(())
    }
}
