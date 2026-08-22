/**
 * Deutsch–Jozsa — one oracle call decides a global property.
 *
 * A classical program has to check more than half of the 2ⁿ inputs before it
 * can rule out "constant". This asks once. Pick an oracle, run it, and read the
 * input register: all zeros means constant, anything else means balanced.
 */
import { cx, h, measure, xg } from '../lib/steps';
import { bool, num, str } from '../lib/inputs';
import type { Program, Readout, Step } from '../lib/types';

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
      max: 24,
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
    { id: 'measure', kind: 'toggle', label: 'Measure the input register', default: true },
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
    if (bool(v, 'measure', true)) {
      for (let q = 0; q < n; q++) yield measure(q, `x${q}`, { stage: 'Measure' });
    }
  },
  outputs: ({ nQubits, values, p1, probabilityOf, bits, shots, measurement }) => {
    const n = nQubits - 1;
    const oracle = ORACLES[String(values.oracle)] ?? ORACLES.parity;
    // P(input register = 0…0), summed over both values of the output qubit.
    // Only two basis states can contribute, so this needs no full distribution
    // and stays exact at any register size.
    const pZero = probabilityOf(0) + probabilityOf(1 << n);
    void p1;
    const measured = Array.from({ length: n }, (_, q) => bits[`x${q}`]);
    const anyMeasured = measured.some((b) => b !== undefined);
    // The verdict is what the shots said, which is the point of the algorithm:
    // one query per shot, and every shot reading zero means constant.
    const mask = (1 << n) - 1;
    const total = shots.reduce((a, o) => a + o.count, 0);
    const zeros = shots.reduce((a, o) => a + ((o.index & mask) === 0 ? o.count : 0), 0);
    const verdict = total > 0 ? (zeros === total ? 'constant' : 'balanced') : pZero > 0.5 ? 'constant' : 'balanced';
    const rows: Readout[] = [
      {
        label: 'Verdict',
        value: verdict,
        hero: true,
        hint:
          total > 0
            ? `${zeros.toLocaleString()} of ${measurement.taken.toLocaleString()} shots read |0…0⟩ — one oracle call each`
            : 'from one oracle call',
      },
      { label: 'Truth', value: oracle.kind, hint: oracle.label },
      { label: 'P(input reads 0…0)', value: `${(pZero * 100).toFixed(1)}%` },
    ];
    if (anyMeasured) {
      let s = '';
      for (let q = n - 1; q >= 0; q--) s += measured[q] ?? '?';
      rows.push({ label: 'Measured', value: `|${s}⟩` });
    }
    rows.push({
      label: 'Classical cost',
      value: `${(1 << (n - 1)) + 1} queries`,
      hint: 'to be certain, worst case',
    });
    return rows;
  },
};
