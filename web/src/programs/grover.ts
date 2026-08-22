/**
 * Grover's search — amplitude amplification, one visible step at a time.
 *
 * The state-vector view is the one to watch: the marked bar climbs while every
 * other bar shrinks, and it does so in a fixed number of rounds. Step one round
 * too far and it starts falling again, which is the part a static diagram of
 * Grover never manages to convey.
 *
 * The register is capped at three qubits because the phase oracle here is a
 * genuine multi-controlled Z, and the engine's largest is CCZ — two controls.
 * Going wider needs ancilla qubits to chain the controls, which buys a bigger
 * search space at the cost of a circuit that no longer reads at a glance.
 */
import { ccz, cz, h, measure, xg } from '../lib/steps';
import { bits, bool, num, str } from '../lib/inputs';
import type { GateStep, Program, Readout, Step } from '../lib/types';

/** Optimal round count for one marked item in 2^n — floor(pi/4 * sqrt(N)). */
function optimalRounds(n: number): number {
  return Math.max(1, Math.floor((Math.PI / 4) * Math.sqrt(1 << n)));
}

/** Phase flip on |1…1⟩: CZ for two qubits, CCZ for three. */
function allOnesPhaseFlip(n: number, stage: string, note: string): GateStep {
  return n === 2 ? cz(0, 1, { stage, note }) : ccz(0, 1, 2, { stage, note });
}

export const grover: Program = {
  id: 'grover',
  name: 'Grover search',
  blurb: 'Amplify one marked state out of an even superposition.',
  detail:
    'Start with every state equally likely. Each round does two things: the oracle flips the sign of the marked amplitude — invisible on its own, since a sign is not a probability — and the diffusion operator reflects every amplitude about the average, which turns that sign into height. Each round rotates the state a fixed angle toward the answer, so overshooting is a real failure mode.',
  suggestedView: 'state',
  inputs: [
    { id: 'qubits', kind: 'stepper', label: 'Search space', min: 2, max: 3, default: 3, unit: 'qubits' },
    {
      id: 'marked',
      kind: 'bits',
      label: 'Marked item',
      width: (v) => (typeof v.qubits === 'number' ? v.qubits : 3),
      default: 5,
    },
    {
      id: 'rounds',
      kind: 'select',
      label: 'Rounds',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Optimal', hint: 'floor(π/4·√N)' },
        { value: '1', label: '1' },
        { value: '2', label: '2' },
        { value: '3', label: '3' },
        { value: '4', label: '4 (overshoots)' },
      ],
    },
    { id: 'measure', kind: 'toggle', label: 'Measure at the end', default: false },
  ],
  qubits: (v) => num(v, 'qubits', 3),
  *build(v): Iterable<Step> {
    const n = num(v, 'qubits', 3);
    const marked = bits(v, 'marked', n);
    const choice = str(v, 'rounds', 'auto');
    const rounds = choice === 'auto' ? optimalRounds(n) : Number(choice);

    for (let q = 0; q < n; q++) {
      yield h(q, { stage: 'Spread', note: 'Make every state equally likely' });
    }

    for (let r = 1; r <= rounds; r++) {
      const stage = `Round ${r} · oracle`;
      // The oracle flips the sign of one state. Mapping that state to |1…1⟩ with
      // X gates is what lets a single all-ones phase flip stand in for an
      // arbitrary marked item.
      for (let q = 0; q < n; q++) {
        if (((marked >> q) & 1) === 0) yield xg(q, { stage, note: 'Re-label the marked state' });
      }
      yield allOnesPhaseFlip(n, stage, 'Flip the sign of the marked amplitude');
      for (let q = 0; q < n; q++) {
        if (((marked >> q) & 1) === 0) yield xg(q, { stage, note: 'Undo the re-labelling' });
      }

      const diff = `Round ${r} · diffusion`;
      for (let q = 0; q < n; q++) yield h(q, { stage: diff, note: 'Into the average basis' });
      for (let q = 0; q < n; q++) yield xg(q, { stage: diff });
      yield allOnesPhaseFlip(n, diff, 'Reflect about the average');
      for (let q = 0; q < n; q++) yield xg(q, { stage: diff });
      for (let q = 0; q < n; q++) yield h(q, { stage: diff, note: 'Back to the computational basis' });
    }

    if (bool(v, 'measure')) {
      for (let q = 0; q < n; q++) yield measure(q, `c${q}`, { stage: 'Measure' });
    }
  },
  outputs: ({ nQubits, amplitudeCount, values, probabilityOf, likeliest }) => {
    const marked = (typeof values.marked === 'number' ? values.marked : 0) & ((1 << nQubits) - 1);
    let bitstring = '';
    for (let q = nQubits - 1; q >= 0; q--) bitstring += (marked >> q) & 1;
    const classical = 1 / amplitudeCount;
    const rows: Readout[] = [
      {
        label: 'P(marked)',
        value: `${(probabilityOf(marked) * 100).toFixed(1)}%`,
        hero: true,
        hint: `was ${(classical * 100).toFixed(1)}% before amplification`,
      },
      { label: 'Looking for', value: `|${bitstring}⟩ = ${marked}` },
      {
        label: 'Likeliest state',
        value: likeliest === marked ? 'the marked one' : `${likeliest} — not the marked one`,
      },
    ];
    return rows;
  },
};
