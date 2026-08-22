/** Display formatting. Nothing here is allowed to change a number's meaning. */
import type { GateStep, Step } from './types';
import { controlsOf, targets } from './steps';

/** Basis state as bits, qubit `n-1` first — the usual big-endian reading. */
export function bitString(index: number, nQubits: number): string {
  let out = '';
  for (let q = nQubits - 1; q >= 0; q--) out += (index >> q) & 1;
  return out;
}

export function ket(index: number, nQubits: number): string {
  return `|${bitString(index, nQubits)}⟩`;
}

export function pct(p: number, digits = 1): string {
  if (p > 0 && p < 0.001) return '<0.1%';
  // `(-1e-18).toFixed(1)` is "-0.0"; a probability never displays as negative.
  const v = Math.abs(p) < Number.EPSILON ? 0 : p;
  return `${(v * 100).toFixed(digits)}%`;
}

export function fixed(v: number, digits = 3): string {
  const s = v.toFixed(digits);
  // Avoid the "-0.000" that a tiny negative rounds to.
  return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
}

/** Complex number as `a + bi`, with the sign carried by the operator. */
export function complex(re: number, im: number, digits = 3): string {
  const sign = im < 0 ? '−' : '+';
  return `${fixed(re, digits)} ${sign} ${fixed(Math.abs(im), digits)}i`;
}

const PI_FRACTIONS: [number, string][] = [
  [1, 'π'],
  [1 / 2, 'π/2'],
  [1 / 3, 'π/3'],
  [1 / 4, 'π/4'],
  [1 / 6, 'π/6'],
  [1 / 8, 'π/8'],
  [1 / 16, 'π/16'],
  [2 / 3, '2π/3'],
  [3 / 4, '3π/4'],
  [3 / 2, '3π/2'],
  [2, '2π'],
];

/** Angles as a fraction of pi where one fits exactly, else radians. */
export function angle(rad: number): string {
  if (rad === 0) return '0';
  const ratio = rad / Math.PI;
  for (const [value, label] of PI_FRACTIONS) {
    if (Math.abs(Math.abs(ratio) - value) < 1e-9) return `${ratio < 0 ? '−' : ''}${label}`;
  }
  return `${fixed(rad, 3)} rad`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Short label for a gate box in the circuit diagram. */
export function gateLabel(step: GateStep): string {
  const base = step.name.replace(/^c+/, '') || step.name;
  const name = step.name === 'swap' ? 'SWAP' : base.toUpperCase();
  if (step.params.length === 0) return name;
  if (step.name === 'u3') return 'U3';
  return `${name}(${angle(step.params[0])})`;
}

/** One-line description, used when the program gave no note of its own. */
export function describe(step: Step, wires: string[]): string {
  const wire = (q: number) => wires[q] ?? `q${q}`;
  if (step.kind === 'measure') return `Measure ${wire(step.qubit)} into ${step.bit}`;
  if (step.note) return step.note;
  if (step.name === 'swap') return `Swap ${wire(step.qubits[0])} and ${wire(step.qubits[1])}`;
  const ctrl = controlsOf(step);
  const tgt = targets(step).map(wire).join(', ');
  const label = gateLabel(step);
  return ctrl.length === 0
    ? `${label} on ${tgt}`
    : `${label} on ${tgt}, controlled by ${ctrl.map(wire).join(' and ')}`;
}

/** The literal engine call this step makes, so the UI can show it verbatim. */
export function engineCall(step: Step): string {
  if (step.kind === 'measure') return `measure(${step.qubit})`;
  const params = step.params.map((v) => fixed(v, 4)).join(', ');
  return `applyGate("${step.name}", [${step.qubits.join(', ')}], [${params}])`;
}
