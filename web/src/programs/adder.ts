/**
 * A ripple-carry adder — arithmetic, done with nothing but reversible gates.
 *
 * This is the program that makes the inputs and outputs concrete: set A and B,
 * step through, and read the sum. Then tick "A in superposition" and the same
 * circuit, unchanged, adds every value of A to B at once, which is the whole
 * reason anyone builds one of these out of Toffoli gates.
 *
 * The construction is Cuccaro's, which is the one worth showing rather than the
 * obvious one. A naive adder needs a fresh qubit per output bit and per carry —
 * `4n + 1` for `n` bits. This needs `2n + 2`, because the sum is written *into*
 * B and every carry is computed, used and then unwritten. Two blocks do it:
 *
 *   MAJ — writes the carry out of one column, in place
 *   UMA — reads it back out, undoes it, and leaves the sum bit behind
 *
 * The second half of the circuit is the first half run backwards, and the qubit
 * map shows what that buys: A comes back exactly as it was entered. Nothing was
 * consumed and nothing was left behind, which is what "reversible" means when
 * you can watch it.
 */
import { ccx, cx, h, measure, xg } from '../lib/steps';
import { bits, bool, num } from '../lib/inputs';
import type { GateStep, Program, Readout, Step } from '../lib/types';

/**
 * Qubit layout for `n`-bit inputs: a carry in, the two registers, a carry out.
 *
 * `a` is restored by the end and `b` holds the low bits of the sum, so the
 * answer is `b` with `carryOut` on top — `n + 1` bits, as addition requires.
 */
function layout(n: number) {
  return {
    carryIn: 0,
    a: Array.from({ length: n }, (_, i) => 1 + i),
    b: Array.from({ length: n }, (_, i) => 1 + n + i),
    carryOut: 1 + 2 * n,
    total: 2 * n + 2,
  };
}

/** Writes the carry of one column into `c1`, in place. */
function maj(c0: number, b: number, c1: number, stage: string): GateStep[] {
  return [
    cx(c1, b, { stage, note: 'MAJ: fold the carry in' }),
    cx(c1, c0, { stage, note: 'MAJ: fold the carry in' }),
    ccx(c0, b, c1, { stage, note: 'MAJ: the carry out of this column' }),
  ];
}

/** Undoes a MAJ, leaving this column's sum bit behind in `b`. */
function uma(c0: number, b: number, c1: number, stage: string): GateStep[] {
  return [
    ccx(c0, b, c1, { stage, note: 'UMA: unwrite the carry' }),
    cx(c1, c0, { stage, note: 'UMA: unwrite the carry' }),
    cx(c0, b, { stage, note: 'UMA: and this column’s sum bit drops out' }),
  ];
}

export const adder: Program = {
  id: 'adder',
  name: 'Ripple-carry adder',
  blurb: 'A + B in place, optionally for every A at once.',
  detail:
    'Each output bit is built from reversible gates only: CNOT is exclusive-or, and Toffoli is the AND that produces a carry. Carries ripple up through the MAJ blocks and are unwritten on the way back down through the UMA blocks, so the sum lands in B and A is returned exactly as it went in — watch the qubit map to see it come back. Nothing here is quantum until A is put into superposition, at which point B holds every answer simultaneously and the state-vector view shows all of them.',
  suggestedView: 'circuit',
  inputs: [
    {
      id: 'width',
      kind: 'stepper',
      label: 'Register width',
      min: 1,
      max: 6,
      default: 2,
      unit: 'bits each',
      capByCeiling: true,
      hint: '2n + 2 qubits, because the sum is written into B',
    },
    { id: 'a', kind: 'bits', label: 'A', width: (v) => (typeof v.width === 'number' ? v.width : 2), default: 2 },
    { id: 'b', kind: 'bits', label: 'B', width: (v) => (typeof v.width === 'number' ? v.width : 2), default: 3 },
    {
      id: 'superpose',
      kind: 'toggle',
      label: 'A in superposition',
      default: false,
      hint: 'adds every A to B in one pass',
    },
    { id: 'measure', kind: 'toggle', label: 'Measure the sum', default: false },
  ],
  qubits: (v) => layout(num(v, 'width', 2)).total,
  wireLabels: (v) => {
    const n = num(v, 'width', 2);
    return [
      'carry in',
      ...Array.from({ length: n }, (_, i) => `a${i}`),
      ...Array.from({ length: n }, (_, i) => `b${i} → sum${i}`),
      `sum${n}`,
    ];
  },
  *build(v): Iterable<Step> {
    const n = num(v, 'width', 2);
    const { carryIn, a, b, carryOut } = layout(n);
    const av = bits(v, 'a', n);
    const bv = bits(v, 'b', n);
    const superpose = bool(v, 'superpose');

    for (let i = 0; i < n; i++) {
      if (superpose) {
        yield h(a[i], { stage: 'Load', note: 'A takes every value at once' });
      } else if ((av >> i) & 1) {
        yield xg(a[i], { stage: 'Load', note: `Load A = ${av}` });
      }
      if ((bv >> i) & 1) yield xg(b[i], { stage: 'Load', note: `Load B = ${bv}` });
    }

    // Carries ripple up: each MAJ leaves this column's carry in a[i].
    const chain = [carryIn, ...a];
    for (let i = 0; i < n; i++) {
      yield* maj(chain[i], b[i], chain[i + 1], `Carry up · bit ${i}`);
    }
    yield cx(a[n - 1], carryOut, { stage: 'Carry out', note: 'The top carry is the high bit' });
    // …and are unwritten on the way back down, dropping a sum bit each time.
    for (let i = n - 1; i >= 0; i--) {
      yield* uma(chain[i], b[i], chain[i + 1], `Sum down · bit ${i}`);
    }

    if (bool(v, 'measure')) {
      for (let i = 0; i < n; i++) yield measure(b[i], `s${i}`, { stage: 'Read out' });
      yield measure(carryOut, `s${n}`, { stage: 'Read out' });
    }
  },
  outputs: ({ values, readRegister, shots, measurement }) => {
    const n = typeof values.width === 'number' ? values.width : 2;
    const { a, b, carryOut } = layout(n);
    const mask = (1 << n) - 1;
    const av = (typeof values.a === 'number' ? values.a : 0) & mask;
    const bv = (typeof values.b === 'number' ? values.b : 0) & mask;
    const superpose = values.superpose === true;
    const restored = readRegister(a);
    const rows: Readout[] = [];

    /** The sum register's value in one measured outcome. */
    const sumOf = (state: number) => {
      let v = 0;
      b.forEach((q, i) => (v |= ((state >> q) & 1) << i));
      return v | (((state >> carryOut) & 1) << n);
    };
    const bySum = new Map<number, number>();
    for (const o of shots) {
      const key = sumOf(o.index);
      bySum.set(key, (bySum.get(key) ?? 0) + o.count);
    }
    const total = [...bySum.values()].reduce((x, y) => x + y, 0) || 1;

    if (superpose) {
      rows.push({
        label: 'Sums held at once',
        value: `${bv} … ${bv + mask}`,
        hero: true,
        hint: `every A added to B = ${bv}, in one pass over ${mask + 1} values`,
      });
      rows.push({
        label: 'Sums actually drawn',
        value: [...bySum.keys()].sort((x, y) => x - y).join(', '),
        hint: `over ${total.toLocaleString()} shots — one measurement collapses to one of them`,
      });
    } else {
      const drawn = [...bySum].sort((x, y) => y[1] - x[1])[0];
      rows.push({
        label: `${av} + ${bv}`,
        value: drawn ? `${drawn[0]}` : '—',
        hero: true,
        hint:
          drawn && drawn[0] !== av + bv
            ? `expected ${av + bv}`
            : `all ${measurement.taken.toLocaleString()} shots read sum${n}…sum0 the same way`,
      });
      if (bySum.size > 1) {
        rows.push({
          label: 'Disagreeing shots',
          value: `${bySum.size} different sums`,
          hint: 'reversible arithmetic on definite inputs should give exactly one answer',
        });
      }
    }
    rows.push({
      label: 'A afterwards',
      // In superposition every value of A is equally likely, so the likeliest
      // one is a coin toss between ties and reporting it would say nothing.
      // What matters is that the spread came back intact.
      value: superpose ? `all ${mask + 1} values` : `${restored.value}`,
      hint: superpose
        ? restored.confidence <= 1.5 / (mask + 1)
          ? 'still spread evenly — the circuit never consumed it'
          : 'the spread came back uneven, which it should not have'
        : restored.value === av
          ? 'returned unchanged, as a reversible circuit must'
          : `expected ${av} — A should come back untouched`,
    });
    rows.push({
      label: 'Qubits used',
      value: `${2 * n + 2}`,
      hint: `a naive adder with a wire per carry would need ${4 * n + 1}`,
    });
    return rows;
  },
};
