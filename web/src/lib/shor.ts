/**
 * Classical scaffolding around Shor's algorithm.
 *
 * Shor's is mostly classical: the only quantum step is finding the period of
 * `a^x mod N`. Everything here — choosing a target, picking `a`, turning a phase
 * measurement back into a period, and turning a period into factors — is
 * ordinary arithmetic, and keeping it separate makes clear how small the quantum
 * part actually is.
 */

import {
  periodFromPhase as wasmPeriodFromPhase,
  resolvablePeriod as wasmResolvablePeriod,
} from 'qsim';

export function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export function modPow(base: number, exp: number, modulus: number): number {
  if (modulus === 1) return 0;
  let acc = 1;
  base %= modulus;
  while (exp > 0) {
    if (exp & 1) acc = (acc * base) % modulus;
    base = (base * base) % modulus;
    exp >>= 1;
  }
  return acc;
}

/** Bits needed to hold values mod N. */
export function bitsFor(n: number): number {
  return Math.max(1, Math.ceil(Math.log2(n + 1)));
}

export function primeFactors(n: number): Map<number, number> {
  const f = new Map<number, number>();
  let d = 2;
  while (d * d <= n) {
    while (n % d === 0) {
      f.set(d, (f.get(d) ?? 0) + 1);
      n /= d;
    }
    d++;
  }
  if (n > 1) f.set(n, (f.get(n) ?? 0) + 1);
  return f;
}

/**
 * Is `n` something Shor's algorithm can usefully be pointed at?
 *
 * Even numbers and prime powers are excluded because both have trivial classical
 * shortcuts, and running the quantum routine on them would prove nothing. An odd
 * composite with at least two distinct prime factors is the real case.
 */
export function isShorTarget(n: number): boolean {
  if (n < 15 || n % 2 === 0) return false;
  const f = primeFactors(n);
  return f.size >= 2;
}

/** The largest number Shor can address with `total` qubits, and why. */
export interface ShorPlan {
  /** Work register: holds values mod N. */
  workQubits: number;
  /** Counting register: sets the precision of the phase estimate. */
  countQubits: number;
  totalQubits: number;
  /** Largest N this layout can represent. */
  maxModulus: number;
  /** Largest valid target at or below `maxModulus`. */
  modulus: number;
  factorisation: string;
}

/**
 * Largest factorisation that fits in a qubit budget.
 *
 * The work register needs `n = ceil(log2 N)` qubits. The counting register wants
 * `t = 2n`, because recovering the period from the measured phase by continued
 * fractions needs `2^t > N^2` to pin down a unique convergent. So the budget goes
 * as `3n`, and each extra bit of N costs three qubits.
 *
 * `countRatio` below 2 trades success rate for a larger N — the phase estimate
 * gets coarser and more attempts fail.
 */
export function planShor(availableQubits: number, countRatio = 2): ShorPlan | null {
  for (let n = Math.floor(availableQubits / (1 + countRatio)); n >= 4; n--) {
    const t = Math.max(2, Math.round(n * countRatio));
    if (n + t > availableQubits) continue;
    const maxModulus = 2 ** n - 1;
    for (let N = maxModulus; N >= 15; N -= 2) {
      if (!isShorTarget(N)) continue;
      const f = primeFactors(N);
      const factorisation = [...f.entries()]
        .map(([p, e]) => (e > 1 ? `${p}^${e}` : `${p}`))
        .join(' × ');
      return { workQubits: n, countQubits: t, totalQubits: n + t, maxModulus, modulus: N, factorisation };
    }
  }
  return null;
}

/**
 * Largest period a counting register of `countQubits` can resolve.
 *
 * Delegates to the engine. See `periodFromPhase` below for why.
 */
export function resolvablePeriod(countQubits: number): number {
  return wasmResolvablePeriod(countQubits);
}

/**
 * Recover a period from a measured phase by continued fractions.
 *
 * Delegates to the engine, where it is covered by tests, rather than being
 * reimplemented here. That split is deliberate and was learned the hard way: this
 * routine first shipped as TypeScript with no test runner in the project at all,
 * and it was wrong in a way that looked like success — an unbounded multiplier
 * turned it into a classical brute-force order search that ignored the
 * measurement entirely and "factored" numbers no register could resolve.
 *
 * The sharding planner is in Rust for exactly this reason, so that the browser
 * side executes and never decides. This is the same rule applied to the piece
 * that actually broke.
 *
 * Returns null when no period explains the measurement, which is an ordinary
 * outcome rather than an error.
 */
export function periodFromPhase(
  measured: number,
  precision: number,
  a: number,
  modulus: number,
): number | null {
  const r = wasmPeriodFromPhase(measured, precision, a, modulus);
  return r < 0 ? null : r;
}

/**
 * Turn a period into factors.
 *
 * With `r` even and `a^(r/2) ≢ -1`, the difference of squares
 * `(a^(r/2) - 1)(a^(r/2) + 1) ≡ 0 mod N` splits N, and a gcd finds the split.
 * Both excluded cases genuinely fail rather than being an oversight, which is
 * why the algorithm retries with a fresh `a`.
 */
export function factorsFromPeriod(
  period: number,
  a: number,
  modulus: number,
): { factors: [number, number] | null; reason: string } {
  if (period % 2 !== 0) return { factors: null, reason: `period ${period} is odd` };
  const root = modPow(a, period / 2, modulus);
  if (root === modulus - 1) {
    return { factors: null, reason: `a^(r/2) ≡ −1 mod ${modulus}, which gives no split` };
  }
  const f1 = gcd(root - 1, modulus);
  const f2 = gcd(root + 1, modulus);
  for (const f of [f1, f2]) {
    if (f > 1 && f < modulus) return { factors: [f, modulus / f], reason: 'split found' };
  }
  return { factors: null, reason: `gcd gave only trivial factors (${f1}, ${f2})` };
}

/**
 * SplitMix32 mixer.
 *
 * A single LCG step is not enough here: the seeds fed in are sequential
 * (`seed + attempt * k`), and one round of an LCG maps sequential inputs to
 * sequential outputs. That produced a base sequence walking down in steps of 3,
 * and phase draws creeping up by 0.069 each attempt — so every measurement
 * landed in the same bucket. This avalanches properly.
 */
export function mix32(x: number): number {
  x = (x + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0;
  return (x ^ (x >>> 15)) >>> 0;
}

/** A uniform draw in [0, 1) from a seed, well distributed for nearby seeds. */
export function unitFromSeed(seed: number): number {
  return mix32(seed) / 4294967296;
}

/**
 * Deterministic choice of `a`, so a run reproduces from its seed.
 *
 * With `coprimeOnly`, bases sharing a factor with N are skipped. Those are
 * legitimate Shor outcomes — gcd hands over a factor for free — but for small N
 * they are common enough to crowd out the quantum path entirely: half of all
 * bases below 15 factor it classically, and about a third below 33.
 */
export function candidateBase(
  modulus: number,
  seed: number,
  attempt: number,
  coprimeOnly = false,
): number {
  const span = Math.max(1, modulus - 3);
  for (let probe = 0; probe < 64; probe++) {
    const a = 2 + (mix32(seed ^ Math.imul(attempt * 64 + probe, 0x9e3779b9)) % span);
    if (!coprimeOnly || gcd(a, modulus) === 1) return a;
  }
  return 2;
}
