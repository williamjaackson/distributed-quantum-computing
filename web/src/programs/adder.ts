/**
 * A ripple-carry adder — arithmetic, done with nothing but reversible gates.
 *
 * This is the program that makes the inputs and outputs concrete: set A and B,
 * step through, and read the sum out of three qubits that were |0⟩ a moment ago.
 * Then tick "A in superposition" and the same circuit, unchanged, adds every
 * value of A to B at once — four sums in one pass, which is the whole reason
 * anyone builds one of these out of Toffoli gates.
 */
import { ccx, cx, h, measure, xg } from '../lib/steps';
import { bits, bool } from '../lib/inputs';
import type { Program, Readout, Step } from '../lib/types';

// Fixed wiring. Two 2-bit inputs, a 3-bit sum, and one carry between the
// columns — 8 qubits, 256 amplitudes.
const A0 = 0;
const A1 = 1;
const B0 = 2;
const B1 = 3;
const S0 = 4;
const S1 = 5;
const S2 = 6;
const C1 = 7;

export const adder: Program = {
  id: 'adder',
  name: 'Two-bit adder',
  blurb: 'A + B on eight qubits, optionally for every A at once.',
  detail:
    'Each output bit is built from reversible gates only: CNOT is exclusive-or, and Toffoli is the AND that produces a carry. The high bit is the majority of the two top input bits and the carry, which three Toffolis compute. Nothing here is quantum — until A is put into superposition, at which point the sum register holds every answer simultaneously and the state-vector view shows all four.',
  suggestedView: 'circuit',
  inputs: [
    { id: 'a', kind: 'bits', label: 'A', width: 2, default: 2 },
    { id: 'b', kind: 'bits', label: 'B', width: 2, default: 3 },
    {
      id: 'superpose',
      kind: 'toggle',
      label: 'A in superposition',
      default: false,
      hint: 'adds every A to B in one pass',
    },
    { id: 'measure', kind: 'toggle', label: 'Measure the sum', default: false },
  ],
  qubits: () => 8,
  wireLabels: () => ['a0', 'a1', 'b0', 'b1', 'sum0', 'sum1', 'sum2', 'carry'],
  *build(v): Iterable<Step> {
    const a = bits(v, 'a', 2);
    const b = bits(v, 'b', 2);
    const superpose = bool(v, 'superpose');

    if (superpose) {
      yield h(A0, { stage: 'Load', note: 'A takes every value at once' });
      yield h(A1, { stage: 'Load', note: 'A takes every value at once' });
    } else {
      if (a & 1) yield xg(A0, { stage: 'Load', note: `Load A = ${a}` });
      if (a & 2) yield xg(A1, { stage: 'Load', note: `Load A = ${a}` });
    }
    if (b & 1) yield xg(B0, { stage: 'Load', note: `Load B = ${b}` });
    if (b & 2) yield xg(B1, { stage: 'Load', note: `Load B = ${b}` });

    // Low column: sum bit is the XOR, carry is the AND.
    yield cx(A0, S0, { stage: 'Low bit', note: 'sum0 ← a0' });
    yield cx(B0, S0, { stage: 'Low bit', note: 'sum0 ← sum0 ⊕ b0' });
    yield ccx(A0, B0, C1, { stage: 'Low bit', note: 'carry ← a0 AND b0' });

    // High column: three inputs to exclusive-or, and a majority for the carry out.
    yield cx(A1, S1, { stage: 'High bit', note: 'sum1 ← a1' });
    yield cx(B1, S1, { stage: 'High bit', note: 'sum1 ← sum1 ⊕ b1' });
    yield cx(C1, S1, { stage: 'High bit', note: 'sum1 ← sum1 ⊕ carry' });

    yield ccx(A1, B1, S2, { stage: 'Carry out', note: 'sum2 ← a1 AND b1' });
    yield ccx(A1, C1, S2, { stage: 'Carry out', note: 'sum2 ← sum2 ⊕ (a1 AND carry)' });
    yield ccx(B1, C1, S2, { stage: 'Carry out', note: 'sum2 ← sum2 ⊕ (b1 AND carry)' });

    if (bool(v, 'measure')) {
      yield measure(S0, 's0', { stage: 'Read out' });
      yield measure(S1, 's1', { stage: 'Read out' });
      yield measure(S2, 's2', { stage: 'Read out' });
    }
  },
  outputs: ({ values, readRegister, finished }) => {
    const a = (typeof values.a === 'number' ? values.a : 0) & 3;
    const b = (typeof values.b === 'number' ? values.b : 0) & 3;
    const superpose = values.superpose === true;
    const sum = readRegister([S0, S1, S2]);
    const rows: Readout[] = [];

    if (superpose) {
      rows.push({
        label: 'Sum',
        value: `${b} … ${b + 3}`,
        hero: true,
        hint: `every A added to B = ${b}, all in one pass`,
      });
      rows.push({
        label: 'Likeliest branch',
        value: `${sum.value}`,
        hint: `${(sum.confidence * 100).toFixed(1)}% of the probability`,
      });
    } else {
      rows.push({
        label: `${a} + ${b}`,
        value: finished ? `${sum.value}` : '…',
        hero: true,
        hint: finished && sum.value !== a + b ? `expected ${a + b}` : 'read from sum2 sum1 sum0',
      });
      rows.push({
        label: 'Confidence',
        value: `${(sum.confidence * 100).toFixed(1)}%`,
        hint: 'probability of that reading',
      });
    }
    return rows;
  },
};
