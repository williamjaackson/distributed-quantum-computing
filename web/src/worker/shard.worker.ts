/// One shard of a sharded state vector.
///
/// Each shard worker instantiates its own WASM module, so it gets its own 4 GiB
/// address space. That is the entire point: K workers hold K times as much as one
/// module could, and total capacity is bounded by RAM instead.
///
/// This worker only ever *executes* — which shards take part, which pair with
/// which, and what the control masks are all come from `planGate` in Rust.

import init, { Shard } from 'qsim';
import wasmUrl from 'qsim/qsim_bg.wasm?url';
import type { ShardInfo, ShardReq, ShardRes } from '../lib/shardProtocol';

const ctx = globalThis as unknown as {
  postMessage: (msg: ShardRes, transfer?: Transferable[]) => void;
  addEventListener: (type: 'message', cb: (e: MessageEvent<ShardReq>) => void) => void;
};

let wasmMemory: WebAssembly.Memory | null = null;
const ready = init({ module_or_path: wasmUrl }).then((out) => {
  wasmMemory = out.memory;
});

let shard: Shard | null = null;
let ampsOffset = 0;
let scratchOffset = 0;
let sliceSlots = 0; // f64 slots (2 per amplitude)
let blockSlots = 0;

// Views are re-derived whenever the underlying buffer identity changes.
// Growing WASM memory replaces the ArrayBuffer and detaches every view over the
// old one, and any call that passes a Vec across the boundary can allocate — so
// caching a view for the worker's lifetime would be a latent crash.
let cachedBuffer: ArrayBufferLike | null = null;
let ampsView: Float64Array = new Float64Array(0);
let scratchView: Float64Array = new Float64Array(0);

function refreshViews() {
  if (!wasmMemory || !shard) return;
  if (cachedBuffer !== wasmMemory.buffer) {
    cachedBuffer = wasmMemory.buffer;
    ampsView = new Float64Array(wasmMemory.buffer, ampsOffset, sliceSlots);
    scratchView = new Float64Array(wasmMemory.buffer, scratchOffset, blockSlots);
  }
}

/** Slot range of block `b`, clamped to the end of the slice. */
function blockRange(b: number): [number, number] {
  const start = b * blockSlots;
  return [start, Math.min(start + blockSlots, sliceSlots)];
}

function handle(req: ShardReq): { data: unknown; transfer?: Transferable[] } {
  if (req.kind === 'init') {
    shard?.free();
    shard = new Shard(req.localQubits, req.shardBits, req.index);
    ampsOffset = shard.ampsOffset;
    scratchOffset = shard.scratchOffset;
    sliceSlots = shard.sliceAmplitudes * 2;
    blockSlots = shard.blockAmplitudes * 2;
    cachedBuffer = null;
    refreshViews();
    const info: ShardInfo = {
      localQubits: shard.localQubits,
      globalQubits: shard.globalQubits,
      sliceAmplitudes: shard.sliceAmplitudes,
      blockAmplitudes: shard.blockAmplitudes,
      numBlocks: shard.numBlocks,
      sliceBytes: shard.sliceAmplitudes * 16,
    };
    return { data: info };
  }

  if (!shard) throw new Error('shard not initialised');

  switch (req.kind) {
    case 'reset':
      shard.reset();
      return { data: null };

    case 'applyLocal':
      shard.applyLocalBase(
        req.base,
        new Float64Array(req.params),
        new Uint32Array(req.controls),
        req.target,
      );
      return { data: null };

    case 'exportBlock': {
      refreshViews();
      const [start, end] = blockRange(req.block);
      // Fresh buffer so it can be transferred; a view over WASM memory cannot be.
      const out = new Float64Array(end - start);
      out.set(ampsView.subarray(start, end));
      return { data: out, transfer: [out.buffer] };
    }

    case 'importApply': {
      refreshViews();
      const [start, end] = blockRange(req.block);
      const incoming = new Float64Array(req.buffer, 0, end - start);
      scratchView.set(incoming);
      shard.applyPair(
        req.base,
        new Float64Array(req.params),
        req.block,
        req.isLow,
        req.localCmask,
      );
      return { data: null };
    }

    case 'mass':
      return { data: shard.probabilityMass() };

    case 'localProbabilityOfOne':
      return { data: shard.localProbabilityOfOne(req.qubit) };

    case 'probabilities': {
      const p = shard.probabilities();
      return { data: p, transfer: [p.buffer] };
    }

    case 'sampleLocal': {
      const s = shard.sampleLocalFlat(req.shots, req.seed);
      return { data: s, transfer: [s.buffer] };
    }
  }
}

ctx.addEventListener('message', (e) => {
  const req = e.data;
  ready
    .then(() => {
      const { data, transfer } = handle(req);
      ctx.postMessage({ id: req.id, type: 'ok', data }, transfer);
    })
    .catch((err: unknown) => {
      ctx.postMessage({
        id: req.id,
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    });
});
