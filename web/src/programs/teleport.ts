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
import { angle, fixed } from '../lib/format';
import type { Classical, Program, Readout, Step } from '../lib/types';

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
  outputs: ({ values, bits, p1, finished }) => {
    const theta = typeof values.theta === 'number' ? values.theta : 0;
    const wanted = Math.sin(theta / 2) ** 2;
    const got = p1[2];
    const rows: Readout[] = [
      {
        label: 'Bob’s P(1)',
        value: `${(got * 100).toFixed(2)}%`,
        hero: true,
        hint: `payload was ${(wanted * 100).toFixed(2)}%`,
      },
    ];
    if (bits.m0 !== undefined && bits.m1 !== undefined) {
      rows.push({
        label: 'Classical bits sent',
        value: `m0=${bits.m0}, m1=${bits.m1}`,
        hint: 'the only thing that travelled',
      });
      const correction = [bits.m1 ? 'X' : null, bits.m0 ? 'Z' : null].filter(Boolean).join(' then ');
      rows.push({ label: 'Correction applied', value: correction || 'none needed' });
    }
    if (finished) {
      rows.push({
        label: 'Error',
        value: fixed(Math.abs(got - wanted), 6),
        hint: 'difference from the prepared payload',
      });
    }
    return rows;
  },
};
