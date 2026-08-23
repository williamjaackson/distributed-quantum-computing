/**
 * Step constructors for program files.
 *
 * The engine takes gates as `(name, qubits, params)` with controls listed
 * before the target. Rather than have every program repeat that convention,
 * each gate gets a helper with named arguments, and the control count comes
 * from one table — the same table the circuit renderer reads to decide which
 * wires get a control dot.
 */
import type { GateStep, MeasureStep } from './types';

/**
 * A gate whose control count comes from the call: every qubit but the last.
 * Mirrors `dispatch::VARIADIC` in the engine.
 */
export const VARIADIC = -1;

/** Controls each engine gate name takes, mirroring `dispatch::parse_op`. */
export const GATE_CONTROLS: Record<string, number> = {
  h: 0, x: 0, y: 0, z: 0, s: 0, sdg: 0, t: 0, tdg: 0,
  rx: 0, ry: 0, rz: 0, p: 0, u3: 0,
  cx: 1, cy: 1, cz: 1, ch: 1, crx: 1, cry: 1, crz: 1, cp: 1,
  ccx: 2, ccz: 2,
  mcx: VARIADIC, mcz: VARIADIC,
  swap: 0,
};

/** Qubits a gate takes, or null when that depends on the call. */
export function gateArity(name: string): number | null {
  const controls = GATE_CONTROLS[name];
  if (controls === undefined) return null;
  if (controls === VARIADIC) return null;
  return name === 'swap' ? 2 : controls + 1;
}

/** Angles each gate expects, for validation and for labelling. */
export const GATE_PARAMS: Record<string, number> = {
  rx: 1, ry: 1, rz: 1, p: 1, crx: 1, cry: 1, crz: 1, cp: 1, u3: 3,
};

type Extra = Pick<GateStep, 'note' | 'stage' | 'conditional'>;

function gate(name: string, qubits: number[], params: number[], extra?: Partial<Extra>): GateStep {
  const declared = GATE_CONTROLS[name] ?? 0;
  const controls = declared === VARIADIC ? qubits.length - 1 : declared;
  return { kind: 'gate', name, qubits, params, controls, ...extra };
}

// Single-qubit, no angle.
export const h = (q: number, x?: Partial<Extra>) => gate('h', [q], [], x);
export const xg = (q: number, x?: Partial<Extra>) => gate('x', [q], [], x);
export const yg = (q: number, x?: Partial<Extra>) => gate('y', [q], [], x);
export const zg = (q: number, x?: Partial<Extra>) => gate('z', [q], [], x);
export const s = (q: number, x?: Partial<Extra>) => gate('s', [q], [], x);
export const sdg = (q: number, x?: Partial<Extra>) => gate('sdg', [q], [], x);
export const t = (q: number, x?: Partial<Extra>) => gate('t', [q], [], x);
export const tdg = (q: number, x?: Partial<Extra>) => gate('tdg', [q], [], x);

// Single-qubit rotations.
export const rx = (q: number, theta: number, x?: Partial<Extra>) => gate('rx', [q], [theta], x);
export const ry = (q: number, theta: number, x?: Partial<Extra>) => gate('ry', [q], [theta], x);
export const rz = (q: number, theta: number, x?: Partial<Extra>) => gate('rz', [q], [theta], x);
export const p = (q: number, theta: number, x?: Partial<Extra>) => gate('p', [q], [theta], x);
export const u3 = (q: number, theta: number, phi: number, lambda: number, x?: Partial<Extra>) =>
  gate('u3', [q], [theta, phi, lambda], x);

// Controlled.
export const cx = (c: number, target: number, x?: Partial<Extra>) => gate('cx', [c, target], [], x);
export const cy = (c: number, target: number, x?: Partial<Extra>) => gate('cy', [c, target], [], x);
export const cz = (c: number, target: number, x?: Partial<Extra>) => gate('cz', [c, target], [], x);
export const ch = (c: number, target: number, x?: Partial<Extra>) => gate('ch', [c, target], [], x);
export const cp = (c: number, target: number, theta: number, x?: Partial<Extra>) =>
  gate('cp', [c, target], [theta], x);
export const crz = (c: number, target: number, theta: number, x?: Partial<Extra>) =>
  gate('crz', [c, target], [theta], x);
export const ccx = (c0: number, c1: number, target: number, x?: Partial<Extra>) =>
  gate('ccx', [c0, c1, target], [], x);
export const ccz = (c0: number, c1: number, target: number, x?: Partial<Extra>) =>
  gate('ccz', [c0, c1, target], [], x);
export const swap = (a: number, b: number, x?: Partial<Extra>) => gate('swap', [a, b], [], x);

/**
 * Multi-controlled X and Z: every qubit but the last is a control.
 *
 * The engine takes the control count from the call, so these are the same kernel
 * `cx` and `cz` use rather than a decomposition — no ancillas, no extra gates.
 */
export const mcx = (qubits: number[], x?: Partial<Extra>) => gate('mcx', qubits, [], x);
export const mcz = (qubits: number[], x?: Partial<Extra>) => gate('mcz', qubits, [], x);

export const measure = (
  qubit: number,
  bit: string,
  x?: Partial<Pick<MeasureStep, 'note' | 'stage' | 'conditional'>>,
): MeasureStep => ({ kind: 'measure', qubit, bit, ...x });

/** The gate's target qubit — the last entry, except for SWAP which has two. */
export function targets(step: GateStep): number[] {
  return step.name === 'swap' ? [...step.qubits] : step.qubits.slice(step.controls);
}

export function controlsOf(step: GateStep): number[] {
  return step.name === 'swap' ? [] : step.qubits.slice(0, step.controls);
}
