/**
 * What the views read, derived from one recorded frame.
 *
 * Almost nothing is computed here any more. The Bloch vectors, the largest
 * amplitudes and the correlation matrix all come out of the engine — the same
 * `bloch_vector`, `top_amplitudes` and `reduced_two` that `cargo test` checks
 * against naive references — so there is exactly one implementation of each and
 * it is the tested one. This file's job is to present them, and to be honest
 * about which of them a given frame actually has.
 *
 * Index convention, matching the engine: qubit `q` is bit `q` of the basis
 * index, so `|index>` has qubit 0 as its *least* significant bit.
 */
import type { Frame } from './types';

export interface QubitStat {
  /** P(qubit = 1). */
  p1: number;
  /** Bloch vector — the axis expectation values <X>, <Y>, <Z>. */
  x: number;
  y: number;
  z: number;
  /** Bloch vector length. 1 for a qubit in a pure state of its own, 0 when
   *  maximally entangled with the rest of the register. */
  r: number;
  /** Tr(rho^2) for this qubit alone: (1 + r^2) / 2. */
  purity: number;
}

export interface BasisEntry {
  index: number;
  re: number;
  im: number;
  prob: number;
  mag: number;
  /** Phase in radians, in (-pi, pi]. */
  phase: number;
}

export interface Analysis {
  nQubits: number;
  /** 2^n, whether or not that many marks could ever be drawn. */
  amplitudeCount: number;
  qubits: QubitStat[];
  /** Occupied basis states, largest first. Truncated on a large register. */
  support: BasisEntry[];
  /** True when `support` is only the largest slice of the distribution. */
  supportTruncated: boolean;
  likeliest: number;
  /** Every basis state's probability — only on a register small enough to hold. */
  probs: Float64Array | null;
  /** `n x n` pairwise correlations, or null when they were too costly. */
  links: Float64Array | null;
  /** Total probability. Exact from the engine's own norm. */
  total: number;
  /** Shannon entropy in bits; needs the whole distribution, so may be null. */
  entropyBits: number | null;
}

/** Below this a probability is treated as absent — it is rounding, not physics. */
export const EPS = 1e-12;

export function analyse(frame: Frame, nQubits: number, amplitudeCount: number): Analysis {
  const support: BasisEntry[] = [];
  for (let i = 0; i + 2 < frame.top.length; i += 3) {
    const re = frame.top[i + 1];
    const im = frame.top[i + 2];
    const prob = re * re + im * im;
    if (prob <= EPS) continue;
    support.push({
      index: frame.top[i],
      re,
      im,
      prob,
      mag: Math.sqrt(prob),
      phase: Math.atan2(im, re),
    });
  }
  // The engine returns these already ordered; sorting again costs nothing at
  // this length and means a backend that merges shard lists cannot get it wrong.
  support.sort((a, b) => b.prob - a.prob || a.index - b.index);

  const probs = frame.amps ? probabilities(frame.amps) : null;
  let entropyBits: number | null = null;
  if (probs) {
    entropyBits = 0;
    for (const p of probs) if (p > EPS) entropyBits -= p * Math.log2(p);
  }

  return {
    nQubits,
    amplitudeCount,
    qubits: readBloch(frame.bloch, nQubits),
    support,
    supportTruncated: frame.topTruncated,
    likeliest: support.length > 0 ? support[0].index : 0,
    probs,
    links: frame.links,
    total: frame.norm,
    entropyBits,
  };
}

export function probabilities(amps: Float64Array): Float64Array {
  const out = new Float64Array(amps.length / 2);
  for (let i = 0; i < out.length; i++) {
    const re = amps[2 * i];
    const im = amps[2 * i + 1];
    out[i] = re * re + im * im;
  }
  return out;
}

function readBloch(bloch: Float64Array, nQubits: number): QubitStat[] {
  const out: QubitStat[] = [];
  for (let q = 0; q < nQubits; q++) {
    const x = bloch[3 * q] ?? 0;
    const y = bloch[3 * q + 1] ?? 0;
    const z = bloch[3 * q + 2] ?? 0;
    const r = Math.min(1, Math.hypot(x, y, z));
    // <Z> = P(0) - P(1), so P(1) falls straight out of the vector rather than
    // being a second thing the engine has to report. Clamped because a <Z> a
    // rounding step past 1 would otherwise show up as a negative probability.
    const p1 = Math.min(1, Math.max(0, (1 - z) / 2));
    out.push({ p1, x, y, z, r, purity: (1 + r * r) / 2 });
  }
  return out;
}

/**
 * Read a set of qubits as a little-endian integer.
 *
 * Marginalises the joint distribution rather than reading each bit's marginal
 * independently, and the difference matters: in a superposition of |01> and
 * |10> each bit reads "half", and combining bit marginals would invent |00> and
 * |11> as answers. Grouping the joint distribution instead returns a value the
 * register genuinely holds, with the probability of reading it.
 *
 * Falls back to the recorded top-k when the whole distribution is out of reach,
 * which is exact whenever the answer is one of the states that carries real
 * probability — and that is the only case where the reading means anything.
 */
export function readRegister(
  analysis: Analysis,
  qubits: number[],
): { value: number; confidence: number } {
  const groups = new Map<number, number>();
  const add = (index: number, p: number) => {
    let v = 0;
    for (let k = 0; k < qubits.length; k++) {
      if ((index >> qubits[k]) & 1) v |= 1 << k;
    }
    groups.set(v, (groups.get(v) ?? 0) + p);
  };

  if (analysis.probs) {
    for (let i = 0; i < analysis.probs.length; i++) {
      if (analysis.probs[i] > 0) add(i, analysis.probs[i]);
    }
  } else {
    for (const e of analysis.support) add(e.index, e.prob);
  }

  let value = 0;
  let confidence = 0;
  for (const [v, p] of groups) {
    if (p > confidence) {
      confidence = p;
      value = v;
    }
  }
  return { value, confidence };
}
