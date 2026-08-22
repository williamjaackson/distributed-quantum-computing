/**
 * Quantum Fourier transform — the same circuit `circuits::qft` runs natively.
 *
 * Feed it a basis state and every amplitude comes out with the same magnitude
 * but a phase that winds around the circle at a rate set by the input. The
 * complex-plane view makes that literal: the points sit on a ring and the
 * winding number *is* the number you put in.
 */
import { cp, h, swap, xg } from '../lib/steps';
import { bits, num } from '../lib/inputs';
import { angle } from '../lib/format';
import type { Program, Readout, Step } from '../lib/types';

export const qft: Program = {
  id: 'qft',
  name: 'Fourier transform',
  blurb: 'Turn a number into a phase winding across all 2ⁿ amplitudes.',
  detail:
    'The transform is a Hadamard on each qubit interleaved with controlled phase rotations of halving angle, then a layer of swaps to undo the bit reversal the recursion leaves behind. Applied to |k⟩ it produces a flat distribution — every outcome equally likely — where all the information now lives in the phases. Period finding, and so Shor’s algorithm, is built on exactly this.',
  suggestedView: 'complex',
  inputs: [
    {
      id: 'qubits',
      kind: 'stepper',
      label: 'Register',
      min: 2,
      max: 20,
      default: 3,
      unit: 'qubits',
      capByCeiling: true,
    },
    {
      id: 'input',
      kind: 'bits',
      label: 'Input |k⟩',
      width: (v) => (typeof v.qubits === 'number' ? v.qubits : 3),
      default: 1,
    },
  ],
  qubits: (v) => num(v, 'qubits', 3),
  *build(v): Iterable<Step> {
    const n = num(v, 'qubits', 3);
    const k = bits(v, 'input', n);

    for (let q = 0; q < n; q++) {
      if ((k >> q) & 1) yield xg(q, { stage: 'Load', note: `Set qubit ${q} to load |${k}⟩` });
    }
    for (let j = n - 1; j >= 0; j--) {
      yield h(j, { stage: 'Transform', note: `Hadamard on qubit ${j}` });
      for (let m = j - 1; m >= 0; m--) {
        const theta = Math.PI / (1 << (j - m));
        yield cp(m, j, theta, {
          stage: 'Transform',
          note: `Rotate qubit ${j} by ${angle(theta)} when qubit ${m} is 1`,
        });
      }
    }
    for (let i = 0; i < Math.floor(n / 2); i++) {
      yield swap(i, n - 1 - i, { stage: 'Reverse', note: 'Undo the bit reversal' });
    }
  },
  outputs: ({ nQubits, amplitudeCount, values, probabilities, entropyBits, shots, measurement }) => {
    const k = (typeof values.input === 'number' ? values.input : 0) & ((1 << nQubits) - 1);
    const flat = 1 / amplitudeCount;
    let worst: number | null = null;
    if (probabilities) {
      worst = 0;
      for (const p of probabilities) worst = Math.max(worst, Math.abs(p - flat));
    }
    const rows: Readout[] = [
      { label: 'Input', value: `|${k}⟩`, hero: true },
      {
        label: 'Distribution',
        value:
          worst === null
            ? 'too large to check in full'
            : worst < 1e-9
              ? 'perfectly flat'
              : `off flat by ${(worst * 100).toFixed(2)}%`,
        hint: `every state at ${(flat * 100).toFixed(1)}%`,
      },
    ];
    if (entropyBits !== null) {
      rows.push({ label: 'Entropy', value: `${entropyBits.toFixed(2)} of ${nQubits} bits` });
    }
    rows.push({
      label: 'Outcomes measured',
      value: `${shots.length} of ${amplitudeCount.toLocaleString()}`,
      hint: `over ${measurement.taken.toLocaleString()} shots — a flat distribution hides the input completely`,
    });
    return rows;
  },
};
