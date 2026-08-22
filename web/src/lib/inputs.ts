/**
 * Reading program inputs.
 *
 * Input values live in one flat `Record<string, number | string | boolean>` so
 * the panel can render them generically. These accessors are how a program gets
 * a typed value back out, with a fallback rather than an exception — a stale
 * value after a program switch should not take the run down.
 */
import type { Dynamic, InputSpec, InputValues } from './types';

export function resolve<T>(d: Dynamic<T>, values: InputValues): T {
  return typeof d === 'function' ? (d as (v: InputValues) => T)(values) : d;
}

export function num(values: InputValues, id: string, fallback = 0): number {
  const v = values[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function str(values: InputValues, id: string, fallback = ''): string {
  const v = values[id];
  return typeof v === 'string' ? v : fallback;
}

export function bool(values: InputValues, id: string, fallback = false): boolean {
  const v = values[id];
  return typeof v === 'boolean' ? v : fallback;
}

/** An integer input masked to `width` bits, for registers that resize. */
export function bits(values: InputValues, id: string, width: number): number {
  return num(values, id) & ((1 << width) - 1);
}

export function defaultValues(specs: InputSpec[]): InputValues {
  const out: InputValues = {};
  for (const spec of specs) out[spec.id] = spec.default;
  return out;
}
