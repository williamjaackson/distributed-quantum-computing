/**
 * Deutsch–Jozsa — one oracle call decides a global property.
 *
 * A classical program has to check more than half of the 2ⁿ inputs before it
 * can rule out "constant". This asks once. Pick an oracle, run it, and read the
 * input register: all zeros means constant, anything else means balanced.
 */
import { cx, h, xg } from '../lib/steps';
import { num, str } from '../lib/inputs';
import type { Program, Step } from '../lib/types';

const ORACLES: Record<string, { label: string; kind: 'constant' | 'balanced'; hint: string }> = {
  zero: { label: 'f(x) = 0', kind: 'constant', hint: 'constant — no gates at all' },
  one: { label: 'f(x) = 1', kind: 'constant', hint: 'constant — a global sign flip' },
  parity: { label: 'f(x) = parity of x', kind: 'balanced', hint: 'balanced — CNOT from every input' },
  first: { label: 'f(x) = x₀', kind: 'balanced', hint: 'balanced — depends on one bit' },
};

export const deutschJozsa: Program = {
  id: 'deutsch-jozsa',
  name: 'Deutsch–Jozsa',
  blurb: 'Tell a constant function from a balanced one in a single query.',
  detail:
    'The output qubit is prepared in |−⟩, which turns the oracle from "write f(x) somewhere" into "multiply the amplitude of |x⟩ by (−1)^f(x)" — phase kickback. A constant function multiplies everything by the same sign and the final Hadamards put the register back to |0…0⟩ exactly. A balanced one leaves a pattern of signs that cannot cancel, so |0…0⟩ becomes impossible.',
  suggestedView: 'state',
  inputs: [
    {
      id: 'qubits',
      kind: 'stepper',
      label: 'Input register',
      min: 1,
      max: 28,
      default: 3,
      unit: 'qubits',
      capByCeiling: true,
    },
    {
      id: 'oracle',
      kind: 'select',
      label: 'Oracle',
      default: 'parity',
      options: Object.entries(ORACLES).map(([value, o]) => ({
        value,
        label: o.label,
        hint: o.hint,
      })),
    },
  ],
  qubits: (v) => num(v, 'qubits', 3) + 1,
  wireLabels: (v) => {
    const n = num(v, 'qubits', 3);
    return [...Array.from({ length: n }, (_, i) => `x${i}`), 'f(x)'];
  },
  *build(v): Iterable<Step> {
    const n = num(v, 'qubits', 3);
    const out = n;
    const oracle = str(v, 'oracle', 'parity');

    yield xg(out, { stage: 'Prepare', note: 'Flip the output qubit to |1⟩' });
    yield h(out, { stage: 'Prepare', note: 'Put the output into |−⟩ so f shows up as a phase' });
    for (let q = 0; q < n; q++) {
      yield h(q, { stage: 'Prepare', note: `Query every input at once (qubit ${q})` });
    }

    if (oracle === 'one') {
      yield xg(out, { stage: 'Oracle', note: 'f(x) = 1 for every x — one global sign flip' });
    } else if (oracle === 'parity') {
      for (let q = 0; q < n; q++) {
        yield cx(q, out, { stage: 'Oracle', note: `f depends on x${q}` });
      }
    } else if (oracle === 'first') {
      yield cx(0, out, { stage: 'Oracle', note: 'f depends on x₀ alone' });
    }
    // f(x) = 0 needs no gate. The absence is the point: the oracle is a black
    // box and this one does nothing to the phases.

    for (let q = 0; q < n; q++) {
      yield h(q, { stage: 'Decode', note: 'Interfere the phase pattern back into bits' });
    }
  },
  result: ({ nQubits, values, probabilityOf, shots, measurement }) => {
    const n = nQubits - 1;
    const oracle = ORACLES[String(values.oracle)] ?? ORACLES.parity;
    const mask = (1 << n) - 1;
    const drawn = shots.reduce((a, o) => a + o.count, 0) || 1;
    const zeros = shots.reduce((a, o) => a + ((o.index & mask) === 0 ? o.count : 0), 0);
    const verdict = zeros === drawn ? 'constant' : 'balanced';

    return {
      answer: verdict,
      answerNote: 'from a single oracle call per shot',
      expected: oracle.kind,
      correct: verdict === oracle.kind,
      confidence: `${zeros.toLocaleString()} of ${measurement.taken.toLocaleString()} shots read |0…0⟩`,
      confidenceNote:
        'A constant function sends every shot to |0…0⟩ exactly; a balanced one makes it impossible. There is no middle ground to be uncertain about, which is why one query is enough.',
      detail: [
        {
          label: 'P(|0…0⟩)',
          value: `${(probabilityOf(0) + probabilityOf(1 << n)).toFixed(3)}`,
          note: 'Summed over both values of the output qubit, which the algorithm never looks at.',
        },
        {
          label: 'Classical cost',
          value: `${(1 << (n - 1)) + 1} queries`,
          note: 'A classical program has to check more than half the inputs before it can rule out "constant". Worst case, that is 2^(n-1) + 1 of them.',
        },
      ],
    };
  },
};
