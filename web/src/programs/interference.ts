/**
 * Interference — one qubit, two Hadamards, and a phase in between.
 *
 * The optical Mach-Zehnder interferometer, on a single qubit. The phase never
 * changes any probability while it is applied; it only decides what the second
 * Hadamard adds up to. Drag the slider with the state-vector or complex-plane
 * view open and watch probability move without any measurement happening.
 */
import { h, measure, p } from '../lib/steps';
import { bool, num } from '../lib/inputs';
import { angle } from '../lib/format';
import type { Program, Readout, Step } from '../lib/types';

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
    { id: 'measure', kind: 'toggle', label: 'Measure at the end', default: false },
  ],
  qubits: () => 1,
  wireLabels: () => ['path'],
  *build(v): Iterable<Step> {
    const phi = num(v, 'phi', Math.PI);
    yield h(0, { stage: 'Split', note: 'Split into two equal paths' });
    yield p(0, phi, { stage: 'Phase', note: `Delay the |1⟩ path by ${angle(phi)}` });
    yield h(0, { stage: 'Recombine', note: 'Recombine the paths — they interfere' });
    if (bool(v, 'measure')) yield measure(0, 'c0', { stage: 'Measure' });
  },
  outputs: ({ p1, values, bits, shots, measurement }) => {
    const phi = typeof values.phi === 'number' ? values.phi : 0;
    const total = shots.reduce((a, o) => a + o.count, 0);
    const ones = shots.find((o) => o.index === 1)?.count ?? 0;
    const rows: Readout[] = [
      {
        label: 'Measured 1',
        value: total > 0 ? `${((ones / total) * 100).toFixed(2)}%` : '—',
        hero: true,
        hint: `${ones.toLocaleString()} of ${measurement.taken.toLocaleString()} shots`,
      },
      { label: 'P(1), exactly', value: `${(p1[0] * 100).toFixed(2)}%` },
      { label: 'Predicted sin²(φ/2)', value: `${(Math.sin(phi / 2) ** 2 * 100).toFixed(2)}%` },
    ];
    if (bits.c0 !== undefined) rows.push({ label: 'Measured', value: `|${bits.c0}⟩` });
    return rows;
  },
};
