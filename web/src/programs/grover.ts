/**
 * Grover's search — amplitude amplification, one visible step at a time.
 *
 * The state-vector view is the one to watch: the marked bar climbs while every
 * other bar shrinks, and it does so in a fixed number of rounds. Step one round
 * too far and it starts falling again, which is the part a static diagram of
 * Grover never manages to convey.
 *
 * The register is limited by the *step count*, not by the gate set. Each round
 * is about `6n + 2` gates and the optimal round count grows as sqrt(2^n), so the
 * whole circuit grows as `n · 2^(n/2)` — around 1500 steps at ten qubits, which
 * is where the timeline's own limit lands. The oracle itself is a phase flip on
 * one state out of 2^n, which is a Z with `n - 1` controls; the engine takes its
 * control count from the call, so that is one gate at any width rather than a
 * decomposition with ancillas.
 */
import { h, mcz, measure, xg } from '../lib/steps';
import { bits, bool, num, str } from '../lib/inputs';
import type { Program, Readout, Step } from '../lib/types';

/** Optimal round count for one marked item in 2^n — floor(pi/4 * sqrt(N)). */
function optimalRounds(n: number): number {
  return Math.max(1, Math.floor((Math.PI / 4) * Math.sqrt(1 << n)));
}

/** Gates one round costs, for the estimate shown beside the round count. */
function gatesPerRound(n: number, marked: number): number {
  let zeros = 0;
  for (let q = 0; q < n; q++) if (((marked >> q) & 1) === 0) zeros++;
  return 2 * zeros + 1 + 4 * n + 1;
}

export const grover: Program = {
  id: 'grover',
  name: 'Grover search',
  blurb: 'Amplify one marked state out of an even superposition.',
  detail:
    'Start with every state equally likely. Each round does two things: the oracle flips the sign of the marked amplitude — invisible on its own, since a sign is not a probability — and the diffusion operator reflects every amplitude about the average, which turns that sign into height. Each round rotates the state a fixed angle toward the answer, so overshooting is a real failure mode: set the rounds past optimal and watch the peak come back down.',
  suggestedView: 'state',
  inputs: [
    {
      id: 'qubits',
      kind: 'stepper',
      label: 'Search space',
      min: 2,
      max: 10,
      default: 4,
      unit: 'qubits',
      capByCeiling: true,
      hint: 'the round count grows as √N, so the circuit length is what binds',
    },
    {
      id: 'marked',
      kind: 'bits',
      label: 'Marked item',
      width: (v) => (typeof v.qubits === 'number' ? v.qubits : 4),
      default: 5,
    },
    {
      id: 'rounds',
      kind: 'select',
      label: 'Rounds',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Optimal', hint: 'floor(π/4·√N)' },
        { value: 'half', label: 'Half of optimal', hint: 'stopped early' },
        { value: 'over', label: 'Optimal + 2', hint: 'overshoots — the peak falls again' },
        { value: '1', label: '1' },
        { value: '2', label: '2' },
      ],
    },
    { id: 'measure', kind: 'toggle', label: 'Measure at the end', default: false },
  ],
  qubits: (v) => num(v, 'qubits', 4),
  *build(v): Iterable<Step> {
    const n = num(v, 'qubits', 4);
    const marked = bits(v, 'marked', n);
    const optimal = optimalRounds(n);
    const choice = str(v, 'rounds', 'auto');
    const rounds =
      choice === 'auto'
        ? optimal
        : choice === 'half'
          ? Math.max(1, Math.floor(optimal / 2))
          : choice === 'over'
            ? optimal + 2
            : Number(choice);
    const all = Array.from({ length: n }, (_, q) => q);

    for (let q = 0; q < n; q++) {
      yield h(q, { stage: 'Spread', note: 'Make every state equally likely' });
    }

    for (let r = 1; r <= rounds; r++) {
      const stage = `Round ${r} · oracle`;
      // The oracle flips the sign of one state. Mapping that state to |1…1> with
      // X gates is what lets a single all-ones phase flip stand in for an
      // arbitrary marked item.
      for (let q = 0; q < n; q++) {
        if (((marked >> q) & 1) === 0) yield xg(q, { stage, note: 'Re-label the marked state' });
      }
      yield mcz(all, { stage, note: 'Flip the sign of the marked amplitude' });
      for (let q = 0; q < n; q++) {
        if (((marked >> q) & 1) === 0) yield xg(q, { stage, note: 'Undo the re-labelling' });
      }

      const diff = `Round ${r} · diffusion`;
      for (let q = 0; q < n; q++) yield h(q, { stage: diff, note: 'Into the average basis' });
      for (let q = 0; q < n; q++) yield xg(q, { stage: diff });
      yield mcz(all, { stage: diff, note: 'Reflect about the average' });
      for (let q = 0; q < n; q++) yield xg(q, { stage: diff });
      for (let q = 0; q < n; q++) {
        yield h(q, { stage: diff, note: 'Back to the computational basis' });
      }
    }

    if (bool(v, 'measure')) {
      for (let q = 0; q < n; q++) yield measure(q, `c${q}`, { stage: 'Measure' });
    }
  },
  outputs: ({ nQubits, amplitudeCount, values, probabilityOf, shots, measurement }) => {
    const marked = (typeof values.marked === 'number' ? values.marked : 0) & (amplitudeCount - 1);
    let bitstring = '';
    for (let q = nQubits - 1; q >= 0; q--) bitstring += (marked >> q) & 1;
    const flat = 1 / amplitudeCount;
    const optimal = optimalRounds(nQubits);
    const total = shots.reduce((a, o) => a + o.count, 0) || 1;
    const hits = shots.find((o) => o.index === marked)?.count ?? 0;
    const rows: Readout[] = [
      {
        label: 'Measured the marked state',
        value: `${hits.toLocaleString()} of ${measurement.taken.toLocaleString()} shots`,
        hero: true,
        hint: `${((hits / total) * 100).toFixed(1)}% — searching at random would give ${(
          flat * 100
        ).toFixed(2)}%`,
      },
      {
        label: 'Looking for',
        value: `|${bitstring}⟩ = ${marked} of ${amplitudeCount.toLocaleString()}`,
      },
      {
        label: 'P(marked), exactly',
        value: `${(probabilityOf(marked) * 100).toFixed(1)}%`,
        hint: `${(probabilityOf(marked) / flat).toFixed(0)}× the even draw it started from`,
      },
      {
        label: 'Optimal rounds',
        value: `${optimal}`,
        hint: `≈ ${(optimal * gatesPerRound(nQubits, marked)).toLocaleString()} gates; a classical
               search needs ${Math.round(amplitudeCount / 2).toLocaleString()} guesses on average`,
      },
    ];
    return rows;
  },
};
