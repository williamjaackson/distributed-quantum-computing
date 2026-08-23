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
import { ccx, cx, h, xg } from '../lib/steps';
import { bits, bool, num } from '../lib/inputs';
import type { GateStep, Program, Step } from '../lib/types';

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
  ],
  qubits: (v) => layout(num(v, 'width', 2)).total,
  // How far the sum register is from the arithmetic answer. Zero for every shot
  // unless A is in superposition, where the branches carry different sums.
  score: (state, v) => {
    const n = num(v, 'width', 2);
    const { a, b, carryOut } = layout(n);
    const read = (qs: number[]) => qs.reduce((t, q, i) => t | (((state >> q) & 1) << i), 0);
    return Math.abs(read([...b, carryOut]) - (read(a) + bits(v, 'b', n)));
  },
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

  },
  result: ({ values, readRegister, shots, measurement }) => {
    const n = num(values, 'width', 2);
    const { a, b, carryOut } = layout(n);
    const mask = (1 << n) - 1;
    const av = bits(values, 'a', n);
    const bv = bits(values, 'b', n);
    const superpose = values.superpose === true;
    const restored = readRegister(a);

    const sumOf = (state: number) => {
      let v = 0;
      b.forEach((q, i) => (v |= ((state >> q) & 1) << i));
      return v | (((state >> carryOut) & 1) << n);
    };
    const sums = new Map<number, number>();
    for (const o of shots) {
      const key = sumOf(o.index);
      sums.set(key, (sums.get(key) ?? 0) + o.count);
    }
    const ordered = [...sums.keys()].sort((x, y) => x - y);

    return superpose
      ? {
          answer: ordered.join(', '),
          answerNote: `every A added to B = ${bv}, in one pass`,
          expected: Array.from({ length: mask + 1 }, (_, i) => i + bv).join(', '),
          correct:
            ordered.length === mask + 1 && ordered.every((v, i) => v === i + bv),
          confidence: `${sums.size} sums over ${measurement.taken.toLocaleString()} shots`,
          confidenceNote:
            'Each shot collapses to one branch, so a single measurement gives one of these sums. The register held all of them at once until it was looked at.',
          detail: [
            { label: 'A afterwards', value: `all ${mask + 1} values`, note: 'The circuit never consumed it.' },
            {
              label: 'Qubits used',
              value: `${2 * n + 2}`,
              note: `A naive adder with a wire per output bit and per carry would need ${4 * n + 1}. Cuccaro's construction writes the sum into B and unwrites every carry, which is why the second half of the circuit is the first half backwards.`,
            },
          ],
        }
      : {
          answer: `${[...sums].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '—'}`,
          answerNote: `${av} + ${bv}, read from sum${n}…sum0`,
          expected: `${av + bv}`,
          correct: sums.size === 1 && ordered[0] === av + bv,
          confidence:
            sums.size === 1
              ? `all ${measurement.taken.toLocaleString()} shots agreed`
              : `${sums.size} different sums drawn`,
          confidenceNote:
            'Reversible arithmetic on definite inputs is deterministic: every shot must give the same sum, and more than one would mean something is wrong.',
          detail: [
            {
              label: 'A afterwards',
              value: `${restored.value}`,
              note:
                restored.value === av
                  ? 'Returned exactly as it went in, which is what reversible means when you can watch it.'
                  : `Expected ${av} — A should come back untouched.`,
            },
            {
              label: 'Qubits used',
              value: `${2 * n + 2}`,
              note: `A naive adder with a wire per output bit and per carry would need ${4 * n + 1}. Cuccaro's construction writes the sum into B and unwrites every carry, which is why the second half of the circuit is the first half backwards.`,
            },
          ],
        };
  },
};
