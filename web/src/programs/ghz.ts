/**
 * GHZ state — entanglement spread across a whole chain.
 *
 * A ladder of CNOTs turns one qubit's superposition into an all-or-nothing
 * agreement between every qubit in the register. On the qubit map the links
 * light up one at a time as the chain is built.
 */
import { cx, h } from '../lib/steps';
import { num } from '../lib/inputs';
import type { Program, Step } from '../lib/types';

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
  ],
  qubits: (v) => num(v, 'qubits', 5),
  *build(v): Iterable<Step> {
    const n = num(v, 'qubits', 5);
    yield h(0, { stage: 'Seed', note: 'Superpose the head of the chain' });
    for (let q = 1; q < n; q++) {
      yield cx(q - 1, q, { stage: 'Extend', note: `Extend the agreement to qubit ${q}` });
    }
  },
  result: ({ nQubits, amplitudeCount, probabilityOf, shots, measurement }) => {
    const all1 = amplitudeCount - 1;
    const drawn = shots.reduce((a, o) => a + o.count, 0) || 1;
    const agreed = shots.reduce((a, o) => a + (o.index === 0 || o.index === all1 ? o.count : 0), 0);

    return {
      answer: `${agreed.toLocaleString()} of ${measurement.taken.toLocaleString()} shots agreed`,
      answerNote: `all ${nQubits} qubits the same, every time`,
      expected: 'all of them agree',
      correct: agreed === drawn,
      confidence: `${((probabilityOf(0) + probabilityOf(all1)) * 100).toFixed(1)}% agree, exactly`,
      confidenceNote: `Only two of the ${amplitudeCount.toLocaleString()} basis states ever carry any amplitude, however long the chain gets — and no individual qubit is any less undecided for it.`,
      detail: [
        {
          label: 'Outcomes seen',
          value: `${shots.length} of ${amplitudeCount.toLocaleString()}`,
          note: 'Two, for a GHZ state: all-zeros and all-ones. Everything else is ruled out by the entanglement.',
        },
      ],
    };
  },
};
