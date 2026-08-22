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
    Component: CircuitView,
  },
  {
    id: 'state',
    name: 'State vector',
    subtitle: 'every amplitude — probability as height, phase as an angle',
    Component: StateVectorView,
  },
  {
    id: 'qubits',
    name: 'Qubit map',
    subtitle: 'each qubit’s own value, and what it is correlated with',
    Component: QubitMapView,
  },
  {
    id: 'bloch',
    name: 'Polarisation',
    subtitle: 'per-qubit direction on the Bloch sphere',
    Component: PolarisationView,
  },
  {
    id: 'complex',
    name: 'Complex plane',
    subtitle: 'amplitudes as points — phase is the angle, exactly',
    Component: ComplexPlaneView,
  },
];

export function viewById(id: string): ViewDef {
  return VIEWS.find((v) => v.id === id) ?? VIEWS[0];
}
