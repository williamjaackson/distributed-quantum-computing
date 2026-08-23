/**
 * The view registry. One projection at a time — they are different ways of
 * looking at the same amplitudes, and side by side they compete rather than
 * combine.
 *
 * There is no shots view. Measurement is not another way of looking at the
 * state, it is what turns a state into an answer, so it belongs to the run
 * rather than to one projection of it — see `MeasurementPanel`.
 */
import { CircuitView } from './CircuitView';
import { StateVectorView } from './StateVectorView';
import { QubitMapView } from './QubitMapView';
import { PolarisationView } from './PolarisationView';
import { ComplexPlaneView } from './ComplexPlaneView';
import type { ViewDef } from './types';

export const VIEWS: ViewDef[] = [
  {
    id: 'circuit',
    name: 'Circuit',
    subtitle: 'the gates, in the order the engine ran them',
    about:
      'One column per step, so the playhead never lands between two gates — click a column to jump there. Executed columns are tinted, dashed gates ran only because a measured bit said so, and the double line at the bottom is the classical register.',
    Component: CircuitView,
  },
  {
    id: 'state',
    name: 'State vector',
    subtitle: 'every amplitude — probability as height, phase as an angle',
    about:
      'Bars sit at their basis index, so the shape holds as the register grows. Probability is height and phase is a dial beneath — two encodings, because a phase is a direction and a colour scale would not survive being printed. Past one mark per pixel the marks are binned and each is the largest in its column.',
    Component: StateVectorView,
  },
  {
    id: 'qubits',
    name: 'Qubit map',
    subtitle: 'each qubit’s own value, and what it is correlated with',
    about:
      'Each dial fills from the bottom with P(1): grey is a definite 0, full blue a definite 1, half-full exactly undecided. Chords are the connected Pauli correlation — 1 for a Bell pair, about 0.58 for a pair that is only classically correlated, 0 for independent qubits. A qubit stuck at half with a heavy chord has no state of its own.',
    Component: QubitMapView,
  },
  {
    id: 'bloch',
    name: 'Polarisation',
    subtitle: 'per-qubit direction on the Bloch sphere',
    about:
      'North is |0⟩, south is |1⟩; anywhere on the equator is a 50/50 superposition and the angle around it is the phase. The arrow’s length is how much of a state the qubit has of its own — a dot at the centre means it is entangled, and all of its information is in the correlations rather than in the qubit.',
    Component: PolarisationView,
  },
  {
    id: 'complex',
    name: 'Complex plane',
    subtitle: 'amplitudes as points — phase is the angle, exactly',
    about:
      'The only view where phase is exact rather than encoded: the angle on screen is the phase and the distance from the origin is the magnitude. The radial scale is the smallest power of two containing the largest amplitude, so a state spread over thousands of basis states is still visible; angles are never scaled.',
    Component: ComplexPlaneView,
  },
];

export function viewById(id: string): ViewDef {
  return VIEWS.find((v) => v.id === id) ?? VIEWS[0];
}
