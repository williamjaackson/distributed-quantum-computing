/**
 * Teleportation — the one program on the list whose circuit is not fixed in
 * advance.
 *
 * The two corrections at the end depend on what the mid-circuit measurements
 * gave, so the generator reads the classical register as it goes. The circuit
 * diagram therefore shows the gates that were actually applied, marked as
 * conditional, rather than a pair of maybe-gates.
 */
import { cx, h, measure, u3, xg, zg } from '../lib/steps';
import { num } from '../lib/inputs';
import { angle } from '../lib/format';
import type { Classical, Program, Step } from '../lib/types';

export const teleport: Program = {
  id: 'teleport',
  name: 'Teleportation',
  blurb: 'Move a qubit’s state to another qubit using two classical bits.',
  detail:
    'Qubit 0 is prepared in an arbitrary state. Qubits 1 and 2 start as a Bell pair, so measuring qubits 0 and 1 together destroys the original and leaves qubit 2 holding it up to one of four known errors — which the two measured bits identify exactly. Watch the polarisation view: the arrow on qubit 0 vanishes at the measurement and reappears on qubit 2 after the corrections.',
  suggestedView: 'bloch',
  inputs: [
    {
      id: 'theta',
      kind: 'slider',
      label: 'Payload θ',
      min: 0,
      max: Math.PI,
      step: Math.PI / 24,
      default: Math.PI / 3,
      format: angle,
      hint: 'Tilt away from |0⟩',
    },
    {
      id: 'phi',
      kind: 'slider',
      label: 'Payload φ',
      min: 0,
      max: 2 * Math.PI,
      step: Math.PI / 12,
      default: Math.PI / 4,
      format: angle,
      hint: 'Rotation about the Z axis',
    },
  ],
  qubits: () => 3,
  wireLabels: () => ['payload', 'alice', 'bob'],
  *build(v, cl: Classical): Iterable<Step> {
    const theta = num(v, 'theta', Math.PI / 3);
    const phi = num(v, 'phi', Math.PI / 4);

    yield u3(0, theta, phi, 0, {
      stage: 'Prepare',
      note: `Prepare the payload at θ=${angle(theta)}, φ=${angle(phi)}`,
    });
    yield h(1, { stage: 'Share', note: 'Start the Bell pair alice and bob will share' });
    yield cx(1, 2, { stage: 'Share', note: 'Entangle alice with bob' });
    yield cx(0, 1, { stage: 'Send', note: 'Interact the payload with alice’s half' });
    yield h(0, { stage: 'Send', note: 'Rotate the payload into the measurement basis' });
    yield measure(0, 'm0', { stage: 'Send', note: 'Measure the payload — the original is gone' });
    yield measure(1, 'm1', { stage: 'Send', note: 'Measure alice’s half' });

    if (cl.bit('m1') === 1) {
      yield xg(2, { stage: 'Correct', conditional: 'm1 = 1', note: 'Undo the bit flip' });
    }
    if (cl.bit('m0') === 1) {
      yield zg(2, { stage: 'Correct', conditional: 'm0 = 1', note: 'Undo the phase flip' });
    }
  },
  result: ({ values, bits, p1, shots, measurement }) => {
    const theta = num(values, 'theta', Math.PI / 3);
    const wanted = Math.sin(theta / 2) ** 2;
    const arrived = p1[2];
    const drawn = shots.reduce((a, o) => a + o.count, 0) || 1;
    const ones = shots.reduce((a, o) => a + ((o.index >> 2) & 1 ? o.count : 0), 0);
    const correction = [bits.m1 ? 'X' : null, bits.m0 ? 'Z' : null].filter(Boolean).join(' then ');

    return {
      answer: `${(arrived * 100).toFixed(2)}% on bob`,
      answerNote: 'the payload, moved without moving',
      expected: `${(wanted * 100).toFixed(2)}%`,
      correct: Math.abs(arrived - wanted) < 1e-9,
      confidence: `${((ones / drawn) * 100).toFixed(1)}% of shots measured 1`,
      confidenceNote: `Over ${measurement.taken.toLocaleString()} shots, whichever of the four corrections each one needed. The payload has to arrive every time, not on average — that is the claim.`,
      detail: [
        {
          label: 'Correction',
          value: correction || 'none needed',
          note: 'Which of the four errors the measurement left behind, chosen by the two classical bits — the only thing that travelled. Without the correction bob holds the wrong state, and a companion test in the engine checks that teleportation fails without it.',
        },
      ],
    };
  },
};
