/**
 * GHZ state — entanglement spread across a whole chain.
 *
 * A ladder of CNOTs turns one qubit's superposition into an all-or-nothing
 * agreement between every qubit in the register. On the qubit map the links
 * light up one at a time as the chain is built.
 */
import { cx, h, measure } from '../lib/steps';
import { bool, num } from '../lib/inputs';
import type { Program, Readout, Step } from '../lib/types';

export const ghz: Program = {
  id: 'ghz',
  name: 'GHZ chain',
  blurb: 'One superposition, propagated to every qubit at once.',
  detail:
    'Only two of the 2ⁿ basis states ever carry any amplitude: all-zeros and all-ones. Each CNOT extends the agreement by one qubit without ever making an individual qubit any less undecided — every marginal stays at exactly 50/50 no matter how long the chain gets.',
  suggestedView: 'qubits',
  inputs: [
    {
      id: 'qubits',
      kind: 'stepper',
      label: 'Chain length',
      min: 2,
      max: 30,
      default: 5,
      unit: 'qubits',
      capByCeiling: true,
      hint: 'past 14 the frames hold summaries rather than whole states',
    },
    { id: 'measure', kind: 'toggle', label: 'Measure the first qubit', default: false },
  ],
  qubits: (v) => num(v, 'qubits', 5),
  *build(v): Iterable<Step> {
    const n = num(v, 'qubits', 5);
    yield h(0, { stage: 'Seed', note: 'Superpose the head of the chain' });
    for (let q = 1; q < n; q++) {
      yield cx(q - 1, q, { stage: 'Extend', note: `Extend the agreement to qubit ${q}` });
    }
    if (bool(v, 'measure')) {
      yield measure(0, 'c0', {
        stage: 'Measure',
        note: 'One measurement decides the entire register',
      });
    }
  },
  outputs: ({ nQubits, amplitudeCount, probabilityOf, bits }) => {
    const all1 = amplitudeCount - 1;
    const rows: Readout[] = [
      {
        label: 'Register',
        value: `${nQubits} qubits, ${amplitudeCount.toLocaleString()} amplitudes`,
        hero: true,
      },
      {
        label: 'All agree',
        value: `${((probabilityOf(0) + probabilityOf(all1)) * 100).toFixed(1)}%`,
        hint: 'P(|0…0⟩) + P(|1…1⟩)',
      },
    ];
    if (bits.c0 !== undefined) {
      rows.push({ label: 'Collapsed to', value: bits.c0 === 1 ? '|1…1⟩' : '|0…0⟩' });
    }
    return rows;
  },
};
