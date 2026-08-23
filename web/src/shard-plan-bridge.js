// Bridges the Rust-decided shard plan (from `planGate` / `planShards` in
// engine/src/shard.rs, exposed via wasm-bindgen in engine/src/lib.rs) into
// the browser orchestrator's world of "which peer talks to which peer."
//
// This deliberately mirrors — and does not re-derive — the same decode/iterate
// logic that engine/smoke-sharded.mjs uses to check the sharded path against
// the whole-state Simulator. That equivalence is what engine/tests/sharding.rs
// and smoke-sharded.mjs already establish; this module's job is only to read
// what Rust already decided; per engine/README.md: "the browser side only
// executes, never decides." Nothing here performs qubit-classification or
// gate-matrix math — that stays in Rust, covered by its own test suite.

/**
 * Decode the flat Float64Array `planGate()` returns.
 *
 * Layout: `[n_steps, then per step: base_id, kind, global_cmask, target_bit,
 * local_cmask, n_params, params..., n_qubits, qubits...]` — see
 * `encode_plan` in engine/src/shard.rs for the authoritative definition.
 *
 * `baseGateNames` is the array returned by the wasm `baseGates()` export;
 * pass it in rather than hard-coding gate names here, so this module can't
 * drift out of sync with the engine's gate set.
 */
export function decodePlan(encoded, baseGateNames) {
  let i = 0;
  const steps = [];
  const n = encoded[i++];
  for (let s = 0; s < n; s++) {
    const base = baseGateNames[encoded[i++]];
    const kindCode = encoded[i++];
    const globalCmask = encoded[i++];
    const targetBit = encoded[i++];
    const localCmask = encoded[i++];
    const nParams = encoded[i++];
    const params = Array.from(encoded.slice(i, i + nParams));
    i += nParams;
    const nQubits = encoded[i++];
    const qubits = Array.from(encoded.slice(i, i + nQubits));
    i += nQubits;
    steps.push({
      base,
      kind: kindCode === 0 ? 'local' : 'pair',
      globalCmask,
      targetBit,
      localCmask,
      params,
      qubits, // only meaningful for 'local' steps: controls..., target
    });
  }
  return steps;
}

/**
 * Shard ids that take part in `step`, for a layout of `shardCount` shards.
 * Mirrors `Step::shards` in engine/src/shard.rs.
 */
export function participantShards(step, shardCount) {
  const out = [];
  for (let w = 0; w < shardCount; w++) {
    if ((w & step.globalCmask) === step.globalCmask) out.push(w);
  }
  return out;
}

/**
 * `[low, high]` shard-id pairs a 'pair' step must exchange, for a layout of
 * `shardCount` shards. Mirrors `Step::pairs` in engine/src/shard.rs. Throws
 * if called on a 'local' step — there is nothing to pair.
 */
export function exchangePairs(step, shardCount) {
  if (step.kind !== 'pair') {
    throw new TypeError(`exchangePairs called on a '${step.kind}' step`);
  }
  const bit = 1 << step.targetBit;
  const out = [];
  for (let w = 0; w < shardCount; w++) {
    if ((w & step.globalCmask) === step.globalCmask && (w & bit) === 0) {
      out.push([w, w | bit]);
    }
  }
  return out;
}

/**
 * For a 'local' step, split its qubits array (controls first, then target)
 * into `{ controls, target }`, matching what `Shard.applyLocalBase` expects.
 */
export function localStepControlsAndTarget(step) {
  if (step.kind !== 'local') {
    throw new TypeError(`localStepControlsAndTarget called on a '${step.kind}' step`);
  }
  return { controls: step.qubits.slice(0, -1), target: step.qubits[step.qubits.length - 1] };
}
