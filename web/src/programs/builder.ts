import { DEFAULT_CIRCUIT, parseCircuit } from '../lib/circuit';
import { GATE_CONTROLS, GATE_PARAMS, VARIADIC } from '../lib/steps';
import type { GateStep, Program, Step } from '../lib/types';

const initial = JSON.stringify(DEFAULT_CIRCUIT);

export const builder: Program = {
  id: 'builder',
  name: 'Circuit builder',
  blurb: 'Compose a quantum circuit gate by gate.',
  detail: 'Build a circuit from the simulator’s gate set. Add gates from the palette, choose their wires and angles, then use the circuit view and transport controls to inspect how every operation changes the register.',
  suggestedView: 'circuit',
  inputs: [{ id: 'circuit', kind: 'circuit', label: 'Circuit', default: initial }],
  qubits: (values) => parseCircuit(values.circuit).qubits,
  wireLabels: (values) => Array.from({ length: parseCircuit(values.circuit).qubits }, (_, q) => `q${q}`),
  *build(values): Iterable<Step> {
    const circuit = parseCircuit(values.circuit);
    for (const [index, gate] of circuit.gates.entries()) {
      const declared = GATE_CONTROLS[gate.name];
      if (declared === undefined || gate.qubits.some((q) => !Number.isInteger(q) || q < 0 || q >= circuit.qubits) || new Set(gate.qubits).size !== gate.qubits.length || gate.params.length !== (GATE_PARAMS[gate.name] ?? 0)) continue;
      const controls = declared === VARIADIC ? gate.qubits.length - 1 : declared;
      yield { kind: 'gate', name: gate.name, qubits: gate.qubits, params: gate.params, controls, stage: 'Custom circuit', note: `Gate ${index + 1}` } satisfies GateStep;
    }
  },
  result: ({ shots, measurement, likeliest, nQubits }) => ({
    answer: `|${likeliest.toString(2).padStart(nQubits, '0')}⟩ is most likely`,
    answerNote: `${shots[0]?.count ?? 0} of ${measurement.taken.toLocaleString()} shots`,
    confidence: 'Inspect the views to understand the final state',
  }),
};
