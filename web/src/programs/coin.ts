/**
 * Quantum coin flip — the smallest program that shows superposition and
 * collapse in the same run.
 *
 * A Hadamard puts each qubit exactly halfway between 0 and 1; the measurement
 * picks one side. Step through it and the qubit map fills to half, then snaps.
 */
import { h, measure } from '../lib/steps';
import { bool, num } from '../lib/inputs';
import type { Program, Readout, Step } from '../lib/types';

export const coin: Program = {
  id: 'coin',
  name: 'Coin flip',
  blurb: 'Hadamard, then measure — a fair random bit per qubit.',
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
    { id: 'measure', kind: 'toggle', label: 'Measure at the end', default: true },
  ],
  qubits: (v) => num(v, 'qubits', 3),
  wireLabels: (v) => Array.from({ length: num(v, 'qubits', 3) }, (_, i) => `coin ${i}`),
  *build(v): Iterable<Step> {
    const n = num(v, 'qubits', 3);
    for (let q = 0; q < n; q++) {
      yield h(q, { stage: 'Superpose', note: `Put coin ${q} into an even superposition` });
    }
    if (bool(v, 'measure', true)) {
      for (let q = 0; q < n; q++) {
        yield measure(q, `c${q}`, { stage: 'Measure', note: `Collapse coin ${q}` });
      }
    }
  },
  outputs: ({ nQubits, bits, shots, measurement }) => {
    const measured = Array.from({ length: nQubits }, (_, q) => bits[`c${q}`]).filter(
      (b) => b !== undefined,
    ) as number[];
    const rows: Readout[] = [
      measured.length === 0
        ? { label: 'This run', value: 'not measured', hero: true }
        : {
            label: 'This run',
            value: measured.map((b) => (b === 0 ? 'H' : 'T')).join(' '),
            hero: true,
            hint: `H is |0⟩, T is |1⟩ — one of ${measurement.taken.toLocaleString()} shots`,
          },
    ];
    // A fair coin is a claim about repetition, not about one flip: every one of
    // the 2^n outcomes should come up about equally often.
    const total = shots.reduce((a, o) => a + o.count, 0);
    if (total > 0) {
      const expected = total / 2 ** nQubits;
      let worst = 0;
      for (const o of shots) worst = Math.max(worst, Math.abs(o.count - expected) / expected);
      rows.push({
        label: 'Outcomes seen',
        value: `${shots.length} of ${2 ** nQubits}`,
        hint: 'all of them, for a fair coin',
      });
      rows.push({
        label: 'Off even by',
        value: `${(worst * 100).toFixed(1)}%`,
        hint: `over ${total.toLocaleString()} shots — shrinks as you take more`,
      });
    }
    return rows;
  },
};
