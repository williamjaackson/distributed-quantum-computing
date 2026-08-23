// Runs inside a dedicated Worker — one per browser tab that contributes
// compute, whether that tab is the host or a joined peer. Owns exactly one
// wasm module instance, which is exactly the unit of parallelism the engine
// was designed around: "separate module instances get separate address
// spaces, so K of them hold K times as much" (engine/README.md). Putting
// that instance in a Worker rather than the main thread keeps a multi-second
// gate application or a multi-hundred-megabyte block exchange from freezing
// the tab's UI and its WebRTC signaling.
//
// Talks to the main thread with a small request/response protocol (see
// worker-bridge.js for the caller side): `{id, cmd, ...args}` in,
// `{id, ok, result}` or `{id, ok:false, error}` out. Every wasm call that can
// return `Result<_, JsValue>` is wrapped in try/catch here so a bad request
// (e.g. an out-of-range qubit) becomes an error reply, never an uncaught
// exception that kills the worker mid-run.
//
// Never holds a long-lived typed-array view over wasm linear memory. Any
// `memory.grow` — including one triggered by an unrelated small allocation
// deep inside a later call — detaches every existing ArrayBuffer view over
// that memory, silently turning a cached view into a zero-length husk. Views
// are cheap to construct, so this always builds a fresh one from the current
// `wasmExports.memory.buffer` right before use instead of caching one at
// shard-creation time (which is what engine/smoke-sharded.mjs does — safe
// there only because that harness never calls into the module again after
// taking its views).

// Adjust this import if you relocate web/ relative to engine/pkg/.
import init, {
  Simulator,
  Shard,
  planShards,
  planGate,
  baseGates,
  maxShardQubits,
  blockAmplitudes,
  gateNames,
  engineVersion,
} from '../../engine/pkg/qsim.js';

let wasmExports = null;
let simulator = null; // mode A: full non-sharded register
let shard = null; // mode B: this worker's one shard

function ampsView() {
  return new Float64Array(wasmExports.memory.buffer, shard.ampsOffset, shard.sliceAmplitudes * 2);
}
function scratchView() {
  return new Float64Array(wasmExports.memory.buffer, shard.scratchOffset, shard.blockAmplitudes * 2);
}

const handlers = {
  async 'init-wasm'({ wasmUrl }) {
    wasmExports = await init(wasmUrl ? { module_or_path: wasmUrl } : undefined);
    return { engineVersion: engineVersion(), maxShardQubits: maxShardQubits(), blockAmplitudes: blockAmplitudes(), gateNames: gateNames() };
  },

  // --- Mode A: shots ---
  'init-simulator'({ nQubits, seed }) {
    simulator?.free();
    simulator = new Simulator(nQubits);
    if (seed !== undefined) simulator.setSeed(seed);
    return { nQubits: simulator.nQubits, memoryBytes: simulator.memoryBytes };
  },
  'apply-gate'({ name, qubits, params }) {
    simulator.applyGate(name, qubits, params ?? []);
  },
  'reset-simulator'() {
    simulator.reset();
  },
  sample({ shots, seed }) {
    return { flat: Array.from(simulator.sampleFlat(shots, seed)) };
  },
  norm() {
    return { norm: simulator.norm() };
  },

  // --- Mode B: qubit expansion ---
  'init-shard'({ localQubits, shardBits, index }) {
    shard?.free();
    shard = new Shard(localQubits, shardBits, index);
    return {
      localQubits: shard.localQubits,
      globalQubits: shard.globalQubits,
      sliceAmplitudes: shard.sliceAmplitudes,
      blockAmplitudes: shard.blockAmplitudes,
      numBlocks: shard.numBlocks,
    };
  },
  'reset-shard'() {
    shard.reset();
  },
  'apply-local-base'({ base, params, controls, target }) {
    shard.applyLocalBase(base, params ?? [], controls ?? [], target);
  },
  /** Read block `block` of this shard's own amplitudes, as a fresh copy the
   * caller can hand straight to a data channel (and, on the way back,
   * transfer to the main thread with no further copy). */
  'read-own-block'({ block }) {
    const amps = ampsView();
    const bs = shard.blockAmplitudes * 2;
    const start = block * bs;
    const end = Math.min(start + bs, amps.length);
    const copy = amps.slice(start, end); // Float64Array.slice always copies
    return { buffer: copy.buffer, transfer: [copy.buffer] };
  },
  /** Stage the partner's block bytes into this shard's scratch buffer. */
  'stage-partner-block'({ buffer }) {
    const incoming = new Float64Array(buffer);
    scratchView().set(incoming);
  },
  'apply-pair'({ base, params, block, isLow, localCmask }) {
    shard.applyPair(base, params ?? [], block, isLow, localCmask);
  },
  'probability-mass'() {
    return { mass: shard.probabilityMass() };
  },
  'sample-local'({ shots, seed }) {
    return { flat: Array.from(shard.sampleLocalFlat(shots, seed)) };
  },

  // --- Shared planning helpers, exposed so the host tab's own worker can
  // plan without a second, separate wasm instance ---
  'plan-shards'({ globalQubits, maxShardQubits: cap, minShardBits }) {
    return { plan: Array.from(planShards(globalQubits, cap, minShardBits ?? 0)) };
  },
  'plan-gate'({ name, qubits, params, localQubits, shardBits }) {
    return { encoded: Array.from(planGate(name, qubits, params ?? [], localQubits, shardBits)) };
  },
  'base-gates'() {
    return { baseGates: baseGates() };
  },
};

self.onmessage = async (event) => {
  const { id, cmd, ...args } = event.data;
  const handler = handlers[cmd];
  if (!handler) {
    self.postMessage({ id, ok: false, error: `unknown worker command '${cmd}'` });
    return;
  }
  try {
    const result = (await handler(args)) ?? {};
    const transfer = result.transfer ?? [];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) });
  }
};
