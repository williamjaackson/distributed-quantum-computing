/**
 * The vocabulary shared by programs, the runner, and the views.
 *
 * A program is a *generator* of steps rather than a static list, so a step can
 * depend on a mid-circuit measurement (teleportation needs exactly that). The
 * runner pulls one step at a time, executes it against the engine, and records
 * the resulting state — which means the resolved step list is only known after
 * the run. Everything downstream reads that resolved list, so the circuit
 * diagram shows what actually happened, not what might have.
 */

/** A gate, in the engine's own calling convention: controls first, then target. */
export interface GateStep {
  kind: 'gate';
  /** Engine gate name — must be one of `gateNames()`. */
  name: string;
  /** Controls first, then the target. */
  qubits: number[];
  params: number[];
  /** How many leading entries of `qubits` are controls. */
  controls: number;
  note?: string;
  stage?: string;
  /** Set when the program emitted this only because of a measured bit. */
  conditional?: string;
}

export interface MeasureStep {
  kind: 'measure';
  qubit: number;
  /** Name of the classical bit the outcome lands in. */
  bit: string;
  note?: string;
  stage?: string;
  conditional?: string;
}

export type Step = GateStep | MeasureStep;

/** Classical bits recorded by measurement, readable by a running program. */
export interface Classical {
  get(bit: string): number | undefined;
  /** Reads as 0 when unmeasured, for use directly in `if`. */
  bit(name: string): number;
  all(): Record<string, number>;
}

export type InputValue = number | string | boolean;
export type InputValues = Record<string, InputValue>;

/**
 * A bound that may depend on the other inputs — Grover's marked item is as wide
 * as its register, so the control has to be re-sized when the register is.
 */
export type Dynamic<T> = T | ((values: InputValues) => T);

interface InputBase {
  id: string;
  label: string;
  hint?: string;
}

export type InputSpec =
  | (InputBase & {
      kind: 'slider';
      min: number;
      max: number;
      step: number;
      default: number;
      /** Rendered beside the value, e.g. `π rad`. */
      unit?: string;
      /** Overrides the default numeric formatting of the value. */
      format?: (v: number) => string;
    })
  | (InputBase & {
      kind: 'stepper';
      min: number;
      max: Dynamic<number>;
      default: number;
      /** Rendered after the value, e.g. `qubits`. */
      unit?: string;
      /**
       * This input sizes the register, so its ceiling is whatever the run's is.
       * Set it and the control stops where the visualiser stops, instead of
       * offering a number that would then be quietly clamped.
       */
      capByCeiling?: boolean;
    })
  | (InputBase & {
      kind: 'select';
      options: { value: string; label: string; hint?: string }[];
      default: string;
    })
  | (InputBase & { kind: 'bits'; width: Dynamic<number>; default: number })
  | (InputBase & { kind: 'toggle'; default: boolean });

/** One line of the Outputs panel. */
export interface Readout {
  label: string;
  value: string;
  hint?: string;
  /** Renders as the headline figure of the panel. */
  hero?: boolean;
}

/** What a program gets to inspect when producing its readouts. */
export interface ReadoutContext {
  nQubits: number;
  /** 2^n. */
  amplitudeCount: number;
  values: InputValues;
  /**
   * Probability of one basis state.
   *
   * Exact for any state carrying real probability. On a register too large to
   * hold whole it comes from the recorded largest amplitudes, so a state below
   * that floor reads as 0 — which is the right answer to within the floor.
   */
  probabilityOf(index: number): number;
  /** The whole distribution, when the register was small enough to hold one. */
  probabilities: Float64Array | null;
  /** P(qubit = 1) per qubit. Always available, whatever the register size. */
  p1: Float64Array;
  bits: Record<string, number>;
  /** Basis index with the largest probability. */
  likeliest: number;
  /** Shannon entropy of the distribution in bits, when it could be computed. */
  entropyBits: number | null;
  /** Reads a set of qubits as a little-endian integer, from the joint distribution. */
  readRegister(qubits: number[]): { value: number; confidence: number };
  /** True once every step has run. */
  finished: boolean;
}

export interface Program {
  id: string;
  name: string;
  /** One line, shown in the picker. */
  blurb: string;
  /** A paragraph explaining what to watch for. */
  detail: string;
  /** The view that shows this program off best. */
  suggestedView?: string;
  inputs: InputSpec[];
  qubits(values: InputValues): number;
  /** Human names for the wires, indexed by qubit. */
  wireLabels?(values: InputValues): string[];
  build(values: InputValues, cl: Classical): Iterable<Step>;
  outputs?(ctx: ReadoutContext): Readout[];
}

/**
 * The register at one point in the run.
 *
 * Deliberately a *summary* rather than the state itself. Keeping every
 * amplitude for every step is what caps a visualiser at a dozen qubits — 26
 * qubits is a gigabyte, once — whereas the Bloch vectors, the largest
 * amplitudes and the correlation matrix are all a view ever draws, and together
 * they are kilobytes. `amps` is the exception, filled in only while the whole
 * array is cheap enough to be worth having exactly.
 */
export interface Frame {
  /** 0 is the initial state; frame `i` is the state after `steps[i - 1]`. */
  index: number;
  norm: number;
  bits: Record<string, number>;
  /** Per-qubit Bloch vectors, `[x, y, z]` each. Always present. */
  bloch: Float64Array;
  /** `[index, re, im]` triples, largest probability first. Always present. */
  top: Float64Array;
  /** True when `top` is a truncated view of a larger distribution. */
  topTruncated: boolean;
  /** Every amplitude, when the register was small enough to keep a copy. */
  amps: Float64Array | null;
  /** `n x n` pairwise correlations, when computing them was affordable. */
  links: Float64Array | null;
}

export interface Timeline {
  program: Program;
  values: InputValues;
  seed: number;
  nQubits: number;
  amplitudeCount: number;
  wireLabels: string[];
  steps: Step[];
  /** `steps.length + 1` frames: one before the first step, one after each. */
  frames: Frame[];
  /** How the register was held — whole state or sharded across workers. */
  backend: {
    description: string;
    sharded: boolean;
    shards: number;
    /** Blocks moved between shards over the whole run; 0 when not sharded. */
    exchangedBlocks: number;
  };
  /** What the frames actually hold, which a backend may narrow. */
  detail: {
    amps: boolean;
    links: boolean;
    /** Why links are absent: too costly to compute, or unavailable when sharded. */
    linksReason: 'cost' | 'sharded' | null;
  };
  /** Wall-clock milliseconds the engine spent executing the whole program. */
  elapsedMs: number;
  /** Set when the program stopped early — the timeline holds what ran. */
  error?: string;
}
