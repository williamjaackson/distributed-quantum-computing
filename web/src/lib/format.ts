/** Value formatters shared by charts, tables and stat tiles. */

const KIB = 1024;

/** Bytes in binary units — the natural unit for a 2^n state vector. */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < KIB) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes / KIB;
  let u = 0;
  while (v >= KIB && u < units.length - 1) {
    v /= KIB;
    u++;
  }
  // Whole numbers are exact here (every size is a power of two), so don't
  // decorate them with a trailing .0.
  const d = Number.isInteger(v) ? 0 : digits;
  return `${v.toFixed(d)} ${units[u]}`;
}

/** Compact decimal magnitude: 1.2K, 45.6M, 2.3G. */
export function formatCount(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs < 1000) return abs < 10 && !Number.isInteger(v) ? v.toFixed(digits) : String(Math.round(v));
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [scale, suffix] of units) {
    if (abs >= scale) return `${(v / scale).toFixed(digits)}${suffix}`;
  }
  return String(v);
}

/** Durations, choosing a unit that keeps 2-4 significant digits readable. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 0.001) return `${(ms * 1e6).toFixed(1)} ns`;
  if (ms < 1) return `${(ms * 1000).toFixed(1)} µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatProbability(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p === 0) return '0';
  if (p < 1e-4) return p.toExponential(1);
  return p.toFixed(4);
}

/** Basis state index as a bit string, most-significant qubit first. */
export function formatBasisState(index: number, nQubits: number): string {
  return index.toString(2).padStart(nQubits, '0');
}
