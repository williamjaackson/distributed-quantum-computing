/**
 * Message types shared between the UI thread and the simulation worker.
 *
 * Everything that touches the WASM module runs in the worker: a near-capacity
 * probe allocates gigabytes and blocks for seconds at a time, which would freeze
 * the page if it ran on the main thread.
 */

export interface EngineInfo {
  version: string;
  maxQubits: number;
  fullArrayQubitLimit: number;
  gateNames: string[];
}

/** One measured qubit count in the capacity probe. */
export interface ProbePoint {
  qubits: number;
  amplitudes: number;
  /** Theoretical state-vector size: 2^n * 16 bytes. */
  stateBytes: number;
  allocated: boolean;
  layers: number;
  gates: number;
  totalMs: number;
  msPerGate: number;
  /** Amplitudes updated per second — the memory-bandwidth-bound throughput. */
  amplitudeUpdatesPerSec: number;
  /** Actual WASM linear memory after the run, which never shrinks. */
  wasmHeapBytes: number;
  /** |norm - 1| after the workload: a correctness canary at full scale. */
  normError: number;
}

export interface ProbeOptions {
  minQubits: number;
  maxQubits: number;
  /** Per-measurement wall-clock target; layer count adapts to hit it. */
  targetMs: number;
  maxLayers: number;
  /** Ceiling for the whole probe, so a slow machine still finishes. */
  totalBudgetMs: number;
}

export type StopReason = 'allocation-failed' | 'budget-exhausted' | 'engine-limit' | 'user-limit';

export interface ProbeResult {
  points: ProbePoint[];
  maxQubitsAllocated: number;
  stopReason: StopReason;
  totalMs: number;
  wasmHeapBytes: number;
  engineMaxQubits: number;
}

export interface TestCheck {
  name: string;
  expected: number;
  measured: number;
  tolerance: number;
  pass: boolean;
}

export type TestChart =
  | {
      kind: 'distribution';
      categories: string[];
      measured: number[];
      theoretical: number[];
      measuredLabel: string;
      theoreticalLabel: string;
      xLabel: string;
      yLabel: string;
    }
  | {
      kind: 'series';
      x: number[];
      xLabel: string;
      yLabel: string;
      logY?: boolean;
      series: { label: string; values: number[] }[];
    };

export interface TestGroup {
  id: string;
  title: string;
  description: string;
  checks: TestCheck[];
  chart?: TestChart;
  ms: number;
}

export interface TestResult {
  groups: TestGroup[];
  passed: number;
  failed: number;
  totalMs: number;
}

/** One pass of Shor's algorithm with a particular base `a`. */
export interface ShorAttempt {
  attempt: number;
  /** The base whose period is being found. */
  a: number;
  /** Set when gcd(a, N) > 1 handed us a factor with no quantum work at all. */
  classicalHit: boolean;
  /** Phase register outcome, or null if the attempt never got that far. */
  measured: number | null;
  /** measured / 2^t — the estimate of s/r. */
  phase: number | null;
  period: number | null;
  factors: [number, number] | null;
  outcome: string;
  ms: number;
}

/** The counting register's exact distribution, for plotting. */
export interface PhaseDistribution {
  countQubits: number;
  /** Only the values carrying meaningful probability. */
  x: number[];
  probability: number[];
  /** Spacing between ideal peaks, 2^t / r, when the period is known. */
  peakSpacing: number | null;
  /** Total probability retained by the plotted values. */
  coverage: number;
}

export interface ShorResult {
  modulus: number;
  factorisation: string;
  workQubits: number;
  countQubits: number;
  totalQubits: number;
  factors: [number, number] | null;
  attempts: ShorAttempt[];
  /** Distribution from the first attempt that ran the quantum circuit. */
  distribution: PhaseDistribution | null;
  /** Classical check of the period, for comparison only. */
  trueOrder: number | null;
  gates: number;
  totalMs: number;
}

export interface PlaygroundState {
  nQubits: number;
  probabilities: number[];
  /** Flattened [re, im, ...] pairs. */
  amplitudes: number[];
  norm: number;
  history: string[];
}

export type Request =
  | { id: number; kind: 'info' }
  | { id: number; kind: 'probe'; options: ProbeOptions }
  | { id: number; kind: 'runTests' }
  | {
      id: number;
      kind: 'runShor';
      modulus: number;
      workQubits: number;
      countQubits: number;
      maxAttempts: number;
      seed: number;
      /** Skip bases that hand over a factor classically, so the quantum path runs. */
      coprimeOnly: boolean;
    }
  | { id: number; kind: 'pgInit'; nQubits: number }
  | { id: number; kind: 'pgApply'; gate: string; qubits: number[]; params: number[] }
  | { id: number; kind: 'pgPrepare'; circuit: 'uniform' | 'bell' | 'ghz' | 'qft' }
  | { id: number; kind: 'pgMeasure'; qubit: number }
  | { id: number; kind: 'pgReset' };

/**
 * Omit that distributes across a union. A conditional type only distributes over
 * a naked type parameter, so the indirection through `T` is load-bearing.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * `Request` minus the id the client assigns.
 *
 * A plain `Omit<Request, 'id'>` would collapse the union to the keys every
 * member shares, dropping every payload field.
 */
export type RequestBody = DistributiveOmit<Request, 'id'>;

export type Progress =
  | { kind: 'probe'; currentQubits: number; point?: ProbePoint; note?: string }
  | { kind: 'tests'; group: TestGroup }
  | { kind: 'shor'; stage: string; attempt?: ShorAttempt };

export type Response =
  | { id: number; type: 'ok'; data: unknown }
  | { id: number; type: 'error'; error: string }
  | { id: number; type: 'progress'; progress: Progress };
