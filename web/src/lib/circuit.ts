import type { InputValue } from './types';

export interface CircuitGate {
  name: string;
  qubits: number[];
  params: number[];
}

export interface CircuitDefinition {
  qubits: number;
  gates: CircuitGate[];
}

export const DEFAULT_CIRCUIT: CircuitDefinition = {
  qubits: 2,
  gates: [
    { name: 'h', qubits: [0], params: [] },
    { name: 'cx', qubits: [0, 1], params: [] },
  ],
};

export function parseCircuit(raw: InputValue | undefined): CircuitDefinition {
  try {
    const value = JSON.parse(typeof raw === 'string' ? raw : '') as Partial<CircuitDefinition>;
    if (!Number.isInteger(value.qubits) || (value.qubits ?? 0) < 1 || !Array.isArray(value.gates)) throw new Error();
    return { qubits: Math.min(12, value.qubits!), gates: value.gates.slice(0, 80) as CircuitGate[] };
  } catch {
    return DEFAULT_CIRCUIT;
  }
}
