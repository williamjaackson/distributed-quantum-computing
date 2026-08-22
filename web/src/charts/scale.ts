/** Scales and tick generation shared by the chart components. */

export interface Scale {
  /** Data value -> pixel position. */
  map: (v: number) => number;
  /** Pixel position -> data value. */
  invert: (px: number) => number;
  domain: [number, number];
  range: [number, number];
  ticks: number[];
}

/** "Nice" step sizes: 1, 2, 5 x 10^k — the clean numbers axis ticks should land on. */
function niceStep(rough: number): number {
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  if (norm <= 1) return mag;
  if (norm <= 2) return 2 * mag;
  if (norm <= 5) return 5 * mag;
  return 10 * mag;
}

export function linearScale(
  domain: [number, number],
  range: [number, number],
  tickCount = 5,
  explicitTicks?: number[],
): Scale {
  let [d0, d1] = domain;
  if (d0 === d1) {
    // A flat series still needs a visible band rather than a divide-by-zero.
    const pad = Math.abs(d0) || 1;
    d0 -= pad / 2;
    d1 += pad / 2;
  }
  const step = niceStep((d1 - d0) / tickCount);
  const lo = Math.floor(d0 / step) * step;
  const hi = Math.ceil(d1 / step) * step;
  const ticks: number[] = [];
  if (explicitTicks) {
    ticks.push(...explicitTicks.filter((t) => t >= lo && t <= hi));
  } else {
    // Accumulate by index, not by repeated addition, to avoid drift on
    // fractional steps producing ticks like 0.30000000000000004.
    for (let i = 0; lo + i * step <= hi + step / 1e6; i++) ticks.push(lo + i * step);
  }
  const span = hi - lo;
  const [r0, r1] = range;
  return {
    map: (v) => r0 + ((v - lo) / span) * (r1 - r0),
    invert: (px) => lo + ((px - r0) / (r1 - r0)) * span,
    domain: [lo, hi],
    range,
    ticks,
  };
}

/**
 * Log scale, clamped to positive values.
 *
 * Ticks land on decades. Where the span is narrow enough that decades alone
 * would leave one or two labels, the 2x and 5x subdivisions are added so the
 * axis still carries readable values.
 */
export function logScale(
  domain: [number, number],
  range: [number, number],
  explicitTicks?: number[],
): Scale {
  const d0 = Math.max(domain[0], Number.MIN_VALUE);
  const d1 = Math.max(domain[1], d0 * 10);
  // Explicit ticks also set the bounds, so a caller can pin the axis to
  // meaningful values (1 KiB, 1 MiB, 4 GiB) instead of decades of ten.
  const tickLo = explicitTicks?.length ? Math.min(...explicitTicks) : Infinity;
  const tickHi = explicitTicks?.length ? Math.max(...explicitTicks) : -Infinity;
  const lo = Math.min(10 ** Math.floor(Math.log10(d0)), tickLo);
  const hi = Math.max(10 ** Math.ceil(Math.log10(d1)), tickHi);
  const decades = Math.log10(hi / lo);

  let ticks: number[];
  if (explicitTicks) {
    ticks = explicitTicks.filter((t) => t >= lo * (1 - 1e-9) && t <= hi * (1 + 1e-9));
  } else {
    ticks = [];
    for (let e = Math.log10(lo); e <= Math.log10(hi) + 1e-9; e++) {
      const base = 10 ** e;
      ticks.push(base);
      if (decades <= 3 && base * 10 <= hi + 1e-9) {
        ticks.push(base * 2, base * 5);
      }
    }
    ticks = ticks.filter((t) => t <= hi + 1e-9).sort((a, b) => a - b);
  }

  const l0 = Math.log10(lo);
  const l1 = Math.log10(hi);
  const [r0, r1] = range;
  return {
    map: (v) => r0 + ((Math.log10(Math.max(v, Number.MIN_VALUE)) - l0) / (l1 - l0)) * (r1 - r0),
    invert: (px) => 10 ** (l0 + ((px - r0) / (r1 - r0)) * (l1 - l0)),
    domain: [lo, hi],
    range,
    ticks,
  };
}

/** Evenly spaced band scale for categorical x positions. */
export function bandScale(count: number, range: [number, number]) {
  const [r0, r1] = range;
  const width = (r1 - r0) / Math.max(count, 1);
  return {
    width,
    center: (i: number) => r0 + width * (i + 0.5),
    start: (i: number) => r0 + width * i,
  };
}

export function extent(values: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  return [lo, hi];
}
