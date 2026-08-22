/**
 * Shor's algorithm across worker-owned shards.
 *
 * Sharding fits this circuit better than it might seem. The counting register
 * occupies the high index bits, so a shard id *is* the top of `x`, which means:
 *
 * * the **oracle is communication-free** — `a^x = a^(offset) · a^(x_low)`, so each
 *   shard derives its own starting power and permutes only its local work
 *   register;
 * * the **marginal is communication-free** — the work register being traced out is
 *   the low bits, and slices in shard order are already in ascending `x`.
 *
 * Only the inverse QFT crosses boundaries, because the counting register is where
 * the shard-id bits live. Two optimisations cut that: running the core on reversed
 * qubit indices moves the bit reversal onto the readout (removing swaps that each
 * cost three CNOTs), and truncating small-angle controlled phases removes exactly
 * the expensive high-qubit ones.
 *
 * The trade is real and worth stating: it buys about one extra bit of N over the
 * single-module path, for substantially more wall time per attempt.
 */

import { initPlanning, ShardedEngine, planLayout, type ShardLayout } from './shardedEngine';
import {
  candidateBase,
  factorsFromPeriod,
  gcd,
  periodFromPhase,
  unitFromSeed,
} from './shor';
import type { PhaseDistribution, ShorAttempt, ShorResult } from './protocol';

export interface ShardedShorOptions {
  modulus: number;
  workQubits: number;
  countQubits: number;
  maxAttempts: number;
  seed: number;
  coprimeOnly: boolean;
  /**
   * Approximate-QFT window: controlled phases further apart than this are
   * dropped. `Infinity` keeps the exact transform.
   */
  qftWindow: number;
  /**
   * Force at least this many shard bits even when one slice would fit.
   *
   * Below the single-module ceiling the planner would use a single shard, which
   * is right for speed but means the cross-shard paths never run. Useful both for
   * verifying them at small sizes and for spreading a register that fits over
   * more cores.
   */
  minShardBits: number;
}

export interface ShardedShorProgress {
  stage: string;
  attempt?: ShorAttempt;
}

/** Trim to the values carrying probability; see the single-module version. */
function trimDistribution(
  marginal: Float64Array,
  countQubits: number,
  period: number | null,
  keep = 48,
): PhaseDistribution {
  const idx = Array.from(marginal.keys()).filter((i) => marginal[i] > 1e-6);
  idx.sort((i, j) => marginal[j] - marginal[i]);
  const chosen = idx.slice(0, keep).sort((i, j) => i - j);
  let coverage = 0;
  for (const i of chosen) coverage += marginal[i];
  return {
    countQubits,
    x: chosen,
    probability: chosen.map((i) => marginal[i]),
    peakSpacing: period ? 2 ** countQubits / period : null,
    coverage,
  };
}

function sampleDistribution(marginal: Float64Array, seed: number): number {
  const r = unitFromSeed(seed);
  let acc = 0;
  for (let i = 0; i < marginal.length; i++) {
    acc += marginal[i];
    if (r < acc) return i;
  }
  return marginal.length - 1;
}

export interface ShardedShorResult extends ShorResult {
  layout: ShardLayout;
  crossShardGates: number;
}

export async function runShorSharded(
  options: ShardedShorOptions,
  onProgress?: (p: ShardedShorProgress) => void,
): Promise<ShardedShorResult> {
  const { modulus, workQubits, countQubits, maxAttempts, seed, coprimeOnly, qftWindow } = options;
  const minShardBits = options.minShardBits ?? 0;
  const total = workQubits + countQubits;
  // planLayout reads the engine's own limits, so the module has to be up first.
  // ShardedEngine.create would do this, but the layout is needed before that.
  await initPlanning();
  const layout = planLayout(total, minShardBits);

  // The work register must stay inside a slice, or the oracle would need an
  // all-to-all shuffle instead of no communication at all.
  if (workQubits > layout.localQubits) {
    throw new Error(
      `${total} qubits shards into ${layout.localQubits}-qubit slices, which cannot hold a ` +
        `${workQubits}-qubit work register — the shard boundary must fall inside the counting register`,
    );
  }

  const started = performance.now();
  const attempts: ShorAttempt[] = [];
  let distribution: PhaseDistribution | null = null;
  let factors: [number, number] | null = null;
  let gates = 0;
  let crossShardGates = 0;

  for (let attempt = 1; attempt <= maxAttempts && !factors; attempt++) {
    const t0 = performance.now();
    const a = candidateBase(modulus, seed, attempt, coprimeOnly);

    const shared = gcd(a, modulus);
    if (shared > 1) {
      const rec: ShorAttempt = {
        attempt,
        a,
        classicalHit: true,
        measured: null,
        phase: null,
        period: null,
        factors: [shared, modulus / shared],
        outcome: `gcd(${a}, ${modulus}) = ${shared} — a lucky guess, no quantum work needed`,
        ms: performance.now() - t0,
      };
      attempts.push(rec);
      onProgress?.({ stage: `attempt ${attempt}: classical hit`, attempt: rec });
      factors = rec.factors;
      break;
    }

    onProgress?.({ stage: `attempt ${attempt}: allocating ${layout.shards} shards` });
    const engine = await ShardedEngine.create(layout);
    try {
      onProgress?.({ stage: `attempt ${attempt}: superposing and applying the oracle` });
      await engine.applyGate('x', [0]); // work register starts at |1>
      gates++;
      for (let q = workQubits; q < total; q++) {
        await engine.applyGate('h', [q]);
        gates++;
      }
      await engine.applyModexp(a, modulus, workQubits);

      onProgress?.({ stage: `attempt ${attempt}: inverse QFT across ${layout.shards} shards` });
      const qft = await engine.inverseQft(workQubits, countQubits, qftWindow);
      gates += qft.gates;
      crossShardGates += qft.crossShard;

      const raw = await engine.registerMarginal(workQubits);
      // The skipped bit reversal shows up here: outcome x sits at reverse(x).
      const marginal = new Float64Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        marginal[ShardedEngine.reverseBits(i, countQubits)] = raw[i];
      }

      const measured = sampleDistribution(marginal, seed + attempt * 7919);
      const precision = 2 ** countQubits;
      const period = periodFromPhase(measured, precision, a, modulus);
      if (!distribution) distribution = trimDistribution(marginal, countQubits, period);

      let outcome: string;
      if (period === null) {
        outcome = `no valid period from phase ${measured}/${precision}`;
      } else {
        const res = factorsFromPeriod(period, a, modulus);
        factors = res.factors;
        outcome = res.factors
          ? `period ${period} → ${res.factors[0]} × ${res.factors[1]}`
          : `period ${period} but ${res.reason}`;
      }

      const rec: ShorAttempt = {
        attempt,
        a,
        classicalHit: false,
        measured,
        phase: measured / precision,
        period,
        factors,
        outcome,
        ms: performance.now() - t0,
      };
      attempts.push(rec);
      onProgress?.({ stage: `attempt ${attempt} done`, attempt: rec });
    } finally {
      engine.dispose();
      // Let the OS reclaim the slices before the next attempt allocates.
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return {
    modulus,
    factorisation: '',
    workQubits,
    countQubits,
    totalQubits: total,
    factors,
    attempts,
    distribution,
    trueOrder: null,
    gates,
    totalMs: performance.now() - started,
    layout,
    crossShardGates,
  };
}
