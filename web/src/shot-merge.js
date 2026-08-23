// Merges per-peer sampling results into one histogram.
//
// Used by both modes: mode A (shots) merges one histogram per peer, each
// drawn from that peer's own full state vector. Mode B (expand) merges one
// histogram per *shard*, each drawn from `sampleLocalFlat` — the shard's
// local index needs combining with its shard id into a global index first
// (see `globalIndex`), because engine/src/measure.rs's `sample_unnormalised`
// only ever sees local indices; the global<->local split is the orchestrator's
// job, not the engine's (same "Rust decides the math, JS just carries data"
// split the rest of this bridge follows).
//
// Every basis-state index here fits exactly in a JS `number`: the largest
// realistic global qubit count is far below 53 (2^53 amplitudes alone would
// need ~144 petabytes), so plain doubles never lose precision — no BigInt
// needed.

/**
 * Combine a shard's local basis-state index with its shard id into the
 * global basis-state index, per the split documented in engine/src/shard.rs:
 * `global = (shard_id << local_qubits) | local`.
 */
export function globalIndex(shardId, localIndex, localQubits) {
  return shardId * 2 ** localQubits + localIndex;
}

/**
 * Merge histograms, each given as a flat `[index, count, index, count, ...]`
 * array — the exact shape `sampleFlat` / `sampleLocalFlat` return. Returns a
 * `Map<number, number>` of basis-state index to total count.
 *
 * `toGlobal(index, sourceMeta)` optionally remaps each source's local index to
 * a global one before merging (mode B); omit it for mode A, where every
 * peer's index is already a global basis-state index into the same
 * non-sharded register.
 */
export function mergeHistograms(sources, toGlobal = (index) => index) {
  const merged = new Map();
  for (const { flat, meta } of sources) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const index = toGlobal(flat[i], meta);
      const count = flat[i + 1];
      merged.set(index, (merged.get(index) ?? 0) + count);
    }
  }
  return merged;
}

/** Total shots represented by a flat `[index, count, ...]` array. */
export function totalShots(flat) {
  let total = 0;
  for (let i = 1; i < flat.length; i += 2) total += flat[i];
  return total;
}

/**
 * Split `totalShotsWanted` as evenly as possible across `n` workers: the
 * first `totalShotsWanted % n` workers get one extra shot. Used by mode A to
 * assign each peer's share, and by mode B to assign each shard's
 * probability-proportional share (see `stratifiedShotAllocation` below).
 */
export function evenSplit(totalShotsWanted, n) {
  const base = Math.floor(totalShotsWanted / n);
  const remainder = totalShotsWanted % n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * Mode B sampling: allocate `totalShotsWanted` across shards in proportion to
 * each shard's probability mass, using the largest-remainder method so the
 * allocation sums to exactly `totalShotsWanted` even though each share is an
 * integer. `masses` need not sum to exactly 1 (floating-point drift is
 * expected after many gates); it is renormalised internally.
 */
export function stratifiedShotAllocation(masses, totalShotsWanted) {
  const totalMass = masses.reduce((a, b) => a + b, 0);
  if (totalMass <= 0) return masses.map(() => 0);
  const exact = masses.map((m) => (m / totalMass) * totalShotsWanted);
  const base = exact.map(Math.floor);
  let assigned = base.reduce((a, b) => a + b, 0);
  let remaining = totalShotsWanted - assigned;
  const order = exact
    .map((v, i) => [v - base[i], i])
    .sort((a, b) => b[0] - a[0]);
  const out = [...base];
  for (let k = 0; k < order.length && remaining > 0; k++, remaining--) {
    out[order[k][1]] += 1;
  }
  return out;
}
