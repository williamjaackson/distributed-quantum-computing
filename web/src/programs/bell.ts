/**
 * Bell pair — two qubits, four maximally entangled states.
 *
 * The point of this one is the qubit map: each qubit on its own reads as a
 * featureless 50/50, its Bloch vector collapsed to a point at the centre of the
 * sphere, while the link between them sits at full strength. All of the
 * information is in the pair, none of it in either half.
 */
import { cx, h, measure, xg, zg } from '../lib/steps';
import { bool, str } from '../lib/inputs';
import type { Program, Readout, Step } from '../lib/types';

const VARIANTS: Record<string, { label: string; ket: string }> = {
  'phi+': { label: 'Φ⁺', ket: '(|00⟩ + |11⟩)/√2' },
  'phi-': { label: 'Φ⁻', ket: '(|00⟩ − |11⟩)/√2' },
  'psi+': { label: 'Ψ⁺', ket: '(|01⟩ + |10⟩)/√2' },
  'psi-': { label: 'Ψ⁻', ket: '(|01⟩ − |10⟩)/√2' },
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
    { id: 'measure', kind: 'toggle', label: 'Measure both qubits', default: false },
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
    if (bool(v, 'measure')) {
      yield measure(0, 'a', { stage: 'Measure', note: 'Alice measures — bob is decided too' });
      yield measure(1, 'b', { stage: 'Measure', note: 'Bob measures — no surprises left' });
    }
  },
  outputs: ({ values, bits, probabilityOf }) => {
    const variant = VARIANTS[String(values.variant)] ?? VARIANTS['phi+'];
    const agree = probabilityOf(0) + probabilityOf(3);
    const rows: Readout[] = [{ label: 'Bell state', value: variant.ket, hero: true }];
    rows.push({
      label: 'Outcomes agree',
      value: `${(agree * 100).toFixed(1)}%`,
      hint: 'P(|00⟩) + P(|11⟩)',
    });
    if (bits.a !== undefined) {
      rows.push({ label: 'Alice measured', value: `${bits.a}` });
    }
    if (bits.b !== undefined) {
      rows.push({ label: 'Bob measured', value: `${bits.b}` });
    }
    return rows;
  },
};
