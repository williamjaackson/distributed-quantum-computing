/**
 * Bell pair — two qubits, four maximally entangled states.
 *
 * The point of this one is the qubit map: each qubit on its own reads as a
 * featureless 50/50, its Bloch vector collapsed to a point at the centre of the
 * sphere, while the link between them sits at full strength. All of the
 * information is in the pair, none of it in either half.
 */
import { cx, h, xg, zg } from '../lib/steps';
import { str } from '../lib/inputs';
import type { Program, Step } from '../lib/types';

/**
 * The four Bell states.
 *
 * `agree` is what the pair *claims*: Φ says the two qubits always match, Ψ says
 * they always differ. Both are maximally entangled, so the claim is the only
 * thing that distinguishes them by measurement — the sign does not show up in
 * any single-basis count at all.
 */
const VARIANTS: Record<string, { label: string; ket: string; agree: boolean }> = {
  'phi+': { label: 'Φ⁺', ket: '(|00⟩ + |11⟩)/√2', agree: true },
  'phi-': { label: 'Φ⁻', ket: '(|00⟩ − |11⟩)/√2', agree: true },
  'psi+': { label: 'Ψ⁺', ket: '(|01⟩ + |10⟩)/√2', agree: false },
  'psi-': { label: 'Ψ⁻', ket: '(|01⟩ − |10⟩)/√2', agree: false },
};

export const bell: Program = {
  id: 'bell',
  name: 'Bell pair',
  blurb: 'Entangle two qubits into one of the four Bell states.',
  detail:
    'A Hadamard on the first qubit and a CNOT onto the second produce Φ⁺. The other three Bell states are one extra gate away: X flips which outcomes agree, Z flips the sign between them. Measuring either qubit fixes the other instantly — step past the first measurement and watch the second qubit snap without any gate touching it.',
  suggestedView: 'qubits',
  inputs: [
    {
      id: 'variant',
      kind: 'select',
      label: 'Bell state',
      default: 'phi+',
      options: Object.entries(VARIANTS).map(([value, v]) => ({
        value,
        label: `${v.label}  ${v.ket}`,
      })),
    },
  ],
  qubits: () => 2,
  wireLabels: () => ['alice', 'bob'],
  *build(v): Iterable<Step> {
    const variant = str(v, 'variant', 'phi+');
    yield h(0, { stage: 'Entangle', note: "Superpose alice's qubit" });
    yield cx(0, 1, { stage: 'Entangle', note: "Copy alice's value onto bob — now they are entangled" });
    if (variant === 'psi+' || variant === 'psi-') {
      yield xg(1, { stage: 'Adjust', note: 'Flip bob so the outcomes disagree' });
    }
    if (variant === 'phi-' || variant === 'psi-') {
      yield zg(0, { stage: 'Adjust', note: 'Put a minus sign between the two branches' });
    }
  },
  result: ({ values, bits, probabilityOf, shots, measurement }) => {
    const variant = VARIANTS[String(values.variant)] ?? VARIANTS['phi+'];
    const drawn = shots.reduce((a, o) => a + o.count, 0) || 1;
    const agreed = shots.reduce((a, o) => a + (o.index === 0 || o.index === 3 ? o.count : 0), 0);
    const shouldAgree = variant.agree;
    const observed = shouldAgree ? agreed : drawn - agreed;

    return {
      answer: `${observed.toLocaleString()} of ${measurement.taken.toLocaleString()} shots ${
        shouldAgree ? 'agreed' : 'disagreed'
      }`,
      answerNote: `${variant.ket}`,
      expected: `all of them ${shouldAgree ? 'agree' : 'disagree'}`,
      correct: observed === drawn,
      confidence: `${((probabilityOf(0) + probabilityOf(3)) * 100).toFixed(1)}% agree, exactly`,
      confidenceNote:
        'Either qubit on its own is a featureless 50/50. All of the information is in whether they match, which is what makes this entanglement rather than two random bits.',
      detail:
        bits.a === undefined
          ? undefined
          : [{ label: 'Measured', value: `alice ${bits.a}, bob ${bits.b ?? '?'}` }],
    };
  }
};
