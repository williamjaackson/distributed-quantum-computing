/**
 * Quantum coin flip — the smallest program that shows superposition and
 * collapse in the same run.
 *
 * A Hadamard puts each qubit exactly halfway between 0 and 1; the measurement
 * picks one side. Step through it and the qubit map fills to half, then snaps.
 */
import { h } from '../lib/steps';
import { num } from '../lib/inputs';
import type { Program, Step } from '../lib/types';

export const coin: Program = {
  id: 'coin',
  name: 'Coin flip',
  blurb: 'A Hadamard on every qubit — a fair random bit each.',
  detail:
    'Each Hadamard turns |0⟩ into an equal superposition of |0⟩ and |1⟩. Nothing is random yet: the state is exactly half-and-half and the simulator knows both amplitudes. Randomness only appears at the measurement, which collapses the register onto one outcome and renormalises.',
  suggestedView: 'qubits',
  inputs: [
    {
      id: 'qubits',
      kind: 'stepper',
      label: 'Coins',
      min: 1,
      max: 30,
      default: 3,
      unit: 'qubits',
      capByCeiling: true,
    },
  ],
  qubits: (v) => num(v, 'qubits', 3),
  wireLabels: (v) => Array.from({ length: num(v, 'qubits', 3) }, (_, i) => `coin ${i}`),
  *build(v): Iterable<Step> {
    const n = num(v, 'qubits', 3);
    for (let q = 0; q < n; q++) {
      yield h(q, { stage: 'Superpose', note: `Put coin ${q} into an even superposition` });
    }
  },
  result: ({ nQubits, shots, measurement }) => {
    const drawn = shots.reduce((a, o) => a + o.count, 0) || 1;
    const even = drawn / 2 ** nQubits;
    let worst = 0;
    for (const o of shots) worst = Math.max(worst, Math.abs(o.count - even) / even);
    // Sampling error on a count of `even` is about its square root; four of those
    // is a band a fair coin sits inside and a biased one does not.
    const tolerance = (4 * Math.sqrt(even)) / even;

    return {
      answer: `${shots.length} of ${2 ** nQubits} outcomes seen`,
      answerNote: `over ${measurement.taken.toLocaleString()} shots`,
      // A fair coin has no right *outcome*, which is the whole claim. What can be
      // checked is the distribution, so that is what `expected` describes.
      expected: 'every outcome equally often',
      correct: shots.length === 2 ** nQubits && worst <= tolerance,
      confidence: `within ${(worst * 100).toFixed(0)}% of even`,
      confidenceNote: `Sampling alone allows about ${(tolerance * 100).toFixed(
        0,
      )}% at this shot count. The gap shrinks as the square root of the shots, and that convergence is the only thing about a coin that can be verified.`,
    };
  },
};
