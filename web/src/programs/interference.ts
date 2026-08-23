/**
 * Interference — one qubit, two Hadamards, and a phase in between.
 *
 * The optical Mach-Zehnder interferometer, on a single qubit. The phase never
 * changes any probability while it is applied; it only decides what the second
 * Hadamard adds up to. Drag the slider with the state-vector or complex-plane
 * view open and watch probability move without any measurement happening.
 */
import { h, p } from '../lib/steps';
import { num } from '../lib/inputs';
import { angle } from '../lib/format';
import type { Program, Step } from '../lib/types';

export const interference: Program = {
  id: 'interference',
  name: 'Interference',
  blurb: 'H · phase(φ) · H — phase turns into probability.',
  detail:
    'After the first Hadamard both outcomes are equally likely, and the phase gate leaves that untouched — it rotates one amplitude in the complex plane and nothing else. The second Hadamard makes the two paths meet: they add at φ = 0 and cancel at φ = π, so P(1) traces sin²(φ/2). This is the whole trick behind every quantum algorithm on the list.',
  suggestedView: 'complex',
  inputs: [
    {
      id: 'phi',
      kind: 'slider',
      label: 'Phase φ',
      min: 0,
      max: 2 * Math.PI,
      step: Math.PI / 16,
      default: Math.PI,
      format: angle,
      hint: 'Applied between the two Hadamards',
    },
  ],
  qubits: () => 1,
  wireLabels: () => ['path'],
  *build(v): Iterable<Step> {
    const phi = num(v, 'phi', Math.PI);
    yield h(0, { stage: 'Split', note: 'Split into two equal paths' });
    yield p(0, phi, { stage: 'Phase', note: `Delay the |1⟩ path by ${angle(phi)}` });
    yield h(0, { stage: 'Recombine', note: 'Recombine the paths — they interfere' });
  },
  result: ({ p1, values, shots, measurement }) => {
    const phi = typeof values.phi === 'number' ? values.phi : 0;
    const predicted = Math.sin(phi / 2) ** 2;
    const drawn = shots.reduce((a, o) => a + o.count, 0) || 1;
    const ones = shots.find((o) => o.index === 1)?.count ?? 0;

    return {
      answer: `${((ones / drawn) * 100).toFixed(1)}% measured 1`,
      answerNote: `${ones.toLocaleString()} of ${measurement.taken.toLocaleString()} shots`,
      expected: `${(predicted * 100).toFixed(2)}%`,
      // The shots have to land within sampling error of the curve, not on it.
      correct: Math.abs(ones / drawn - predicted) < 4 / Math.sqrt(drawn),
      confidence: `${(p1[0] * 100).toFixed(2)}% exactly`,
      confidenceNote:
        'The state vector says exactly what the probability is; the shots are draws from it. The gap between them is sampling noise.',
      detail: [
        {
          label: 'Predicted',
          value: 'sin²(φ/2)',
          note: 'The two paths add at φ = 0 and cancel at φ = π. This closed form is the whole content of a Mach-Zehnder interferometer.',
        },
      ],
    };
  }
};
