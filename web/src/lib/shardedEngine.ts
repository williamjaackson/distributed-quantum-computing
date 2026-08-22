import init, { planGate, planShards, baseGates, maxShardQubits } from 'qsim';
import wasmUrl from 'qsim/qsim_bg.wasm?url';
import type { ShardInfo, ShardReq, ShardReqBody, ShardRes } from './shardProtocol';

/** A `qubits`-wide register spread across `shards` workers. */
export interface ShardLayout {
  globalQubits: number;
  shardBits: number;
  localQubits: number;
  shards: number;
  bytesPerShard: number;
  totalBytes: number;
}

/** One decoded step of a planned gate. See `shard::encode_plan` in the engine. */
interface PlanStep {
  base: string;
  /** 0 = intra-shard, 1 = shard pairing. */
  kind: number;
  globalCmask: number;
  targetBit: number;
  localCmask: number;
  params: number[];
  /** Local qubit indices, controls first then target (local steps only). */
  qubits: number[];
}

let planningReady: Promise<void> | null = null;

/**
 * The orchestrator needs `planGate`, which lives in the engine.
 *
 * It loads its own module instance for planning only — no `Shard` is allocated
 * here, so the cost is the 54 KB module and nothing else. The alternative, a
 * round trip to a worker per gate, would add latency for no benefit, and
 * re-deriving the planning rules in TypeScript would put the subtle part of the
 * design somewhere untested.
 */
export function initPlanning(): Promise<void> {
  if (!planningReady) planningReady = init({ module_or_path: wasmUrl }).then(() => undefined);
  return planningReady;
}

export function planLayout(globalQubits: number, minShardBits = 0): ShardLayout {
  const [shardBits, localQubits, shards, bytesPerShard, totalBytes] = planShards(
    globalQubits,
    maxShardQubits(),
    minShardBits,
  );
  return { globalQubits, shardBits, localQubits, shards, bytesPerShard, totalBytes };
}

export function maxQubitsPerShard(): number {
  return maxShardQubits();
}

function decodePlan(enc: Float64Array, base: string[]): PlanStep[] {
  let i = 0;
  const steps: PlanStep[] = [];
  const n = enc[i++];
  for (let s = 0; s < n; s++) {
    const b = base[enc[i++]];
    const kind = enc[i++];
    const globalCmask = enc[i++];
    const targetBit = enc[i++];
    const localCmask = enc[i++];
    const nParams = enc[i++];
    const params = Array.from(enc.slice(i, i + nParams));
    i += nParams;
    const nQubits = enc[i++];
    const qubits = Array.from(enc.slice(i, i + nQubits));
    i += nQubits;
    steps.push({ base: b, kind, globalCmask, targetBit, localCmask, params, qubits });
  }
  return steps;
}

class ShardHandle {
  private worker: Worker;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private dead: Error | null = null;

  constructor(readonly index: number) {
    this.worker = new Worker(new URL('../worker/shard.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.addEventListener('message', (e: MessageEvent<ShardRes>) => {
      const msg = e.data;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.type === 'ok') entry.resolve(msg.data);
      else entry.reject(new Error(msg.error));
    });
    // A shard can die outright rather than throwing — a browser may kill the
    // worker on memory pressure instead of failing the allocation. Failing every
    // in-flight request keeps the probe from hanging on a dead shard.
    this.worker.addEventListener('error', (e) => {
      this.dead = new Error(e.message || `shard ${index} worker failed`);
      for (const [, entry] of this.pending) entry.reject(this.dead);
      this.pending.clear();
    });
  }

  send<T>(req: ShardReqBody, transfer?: Transferable[]): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...req, id } as ShardReq, transfer ?? []);
    });
  }

  terminate() {
    this.worker.terminate();
    this.pending.clear();
  }
}

/**
 * A state vector spread across worker-owned shards.
 *
 * All the orchestration decisions come from the engine's `planGate`; this class
 * only routes the work and moves blocks between shard pairs.
 */
export class ShardedEngine {
  private handles: ShardHandle[] = [];
  private base: string[] = [];
  /** Blocks moved between shards, so callers can report communication volume. */
  exchangedBlocks = 0;
  info: ShardInfo | null = null;

  private constructor(readonly layout: ShardLayout) {}

  /** Spawn the workers and allocate every slice. Rejects if any shard fails. */
  static async create(layout: ShardLayout): Promise<ShardedEngine> {
    await initPlanning();
    const engine = new ShardedEngine(layout);
    engine.base = baseGates();
    try {
      for (let w = 0; w < layout.shards; w++) engine.handles.push(new ShardHandle(w));
      const infos = await Promise.all(
        engine.handles.map((h) =>
          h.send<ShardInfo>({
            kind: 'init',
            localQubits: layout.localQubits,
            shardBits: layout.shardBits,
            index: h.index,
          }),
        ),
      );
      engine.info = infos[0];
      return engine;
    } catch (e) {
      engine.dispose();
      throw e;
    }
  }

  dispose() {
    this.handles.forEach((h) => h.terminate());
    this.handles = [];
  }

  async reset() {
    await Promise.all(this.handles.map((h) => h.send({ kind: 'reset' })));
  }

  /** Total probability, summed across shards. 1.0 for any unitary circuit. */
  async norm(): Promise<number> {
    const masses = await Promise.all(this.handles.map((h) => h.send<number>({ kind: 'mass' })));
    return masses.reduce((a, b) => a + b, 0);
  }

  /**
   * P(qubit = 1). A local qubit is summed within each slice; a global qubit is
   * decided entirely by which shards carry mass, since it *is* a shard-id bit.
   */
  async probabilityOfOne(qubit: number): Promise<number> {
    if (qubit < this.layout.localQubits) {
      const parts = await Promise.all(
        this.handles.map((h) => h.send<number>({ kind: 'localProbabilityOfOne', qubit })),
      );
      return parts.reduce((a, b) => a + b, 0);
    }
    const bit = 1 << (qubit - this.layout.localQubits);
    const masses = await Promise.all(this.handles.map((h) => h.send<number>({ kind: 'mass' })));
    return masses.reduce((acc, m, w) => (w & bit ? acc + m : acc), 0);
  }

  /** Every amplitude probability, concatenated. Small registers only. */
  async probabilities(): Promise<Float64Array> {
    const parts = await Promise.all(
      this.handles.map((h) => h.send<Float64Array>({ kind: 'probabilities' })),
    );
    const out = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  async applyGate(name: string, qubits: number[], params: number[] = []): Promise<void> {
    const enc = planGate(
      name,
      new Uint32Array(qubits),
      new Float64Array(params),
      this.layout.localQubits,
      this.layout.shardBits,
    );
    for (const step of decodePlan(enc, this.base)) {
      if (step.kind === 0) await this.runLocal(step);
      else await this.runPair(step);
    }
  }

  /** Intra-shard step: every participating shard runs it at once, no traffic. */
  private async runLocal(step: PlanStep) {
    const controls = step.qubits.slice(0, -1);
    const target = step.qubits[step.qubits.length - 1];
    const taking = this.handles.filter((h) => (h.index & step.globalCmask) === step.globalCmask);
    await Promise.all(
      taking.map((h) =>
        h.send({ kind: 'applyLocal', base: step.base, params: step.params, controls, target }),
      ),
    );
  }

  /**
   * Shard-pairing step.
   *
   * Every disjoint pair runs concurrently; within a pair the exchange is blocked,
   * and both slices must be staged before either is written because each output
   * row reads both inputs.
   */
  private async runPair(step: PlanStep) {
    const bit = 1 << step.targetBit;
    const pairs: [ShardHandle, ShardHandle][] = [];
    for (const h of this.handles) {
      if ((h.index & step.globalCmask) !== step.globalCmask) continue;
      if (h.index & bit) continue;
      pairs.push([h, this.handles[h.index | bit]]);
    }
    await Promise.all(pairs.map(([lo, hi]) => this.exchangePair(step, lo, hi)));
  }

  private async exchangePair(step: PlanStep, lo: ShardHandle, hi: ShardHandle) {
    const blocks = this.info?.numBlocks ?? 1;
    for (let b = 0; b < blocks; b++) {
      // Both exports first: neither shard may be written before both are read.
      const [loBlock, hiBlock] = await Promise.all([
        lo.send<Float64Array>({ kind: 'exportBlock', block: b }),
        hi.send<Float64Array>({ kind: 'exportBlock', block: b }),
      ]);
      this.exchangedBlocks += 2;
      // Buffers are transferred, not copied — the relay through this thread is
      // an ownership move, so the only real copies are inside the workers.
      await Promise.all([
        lo.send(
          {
            kind: 'importApply',
            block: b,
            isLow: true,
            base: step.base,
            params: step.params,
            localCmask: step.localCmask,
            buffer: hiBlock.buffer as ArrayBuffer,
          },
          [hiBlock.buffer],
        ),
        hi.send(
          {
            kind: 'importApply',
            block: b,
            isLow: false,
            base: step.base,
            params: step.params,
            localCmask: step.localCmask,
            buffer: loBlock.buffer as ArrayBuffer,
          },
          [loBlock.buffer],
        ),
      ]);
    }
  }

  /**
   * Fill every slice with random amplitudes and normalise globally.
   *
   * Returns the wall-clock cost, which is itself a measurement: this is the
   * first time the pages are forced to hold real data.
   */
  async fill(seed: number): Promise<number> {
    const t0 = performance.now();
    const masses = await Promise.all(
      this.handles.map((h) => h.send<number>({ kind: 'fillRandom', seed })),
    );
    const total = masses.reduce((a, b) => a + b, 0);
    if (!(total > 0) || !Number.isFinite(total)) throw new Error(`fill produced mass ${total}`);
    const factor = 1 / Math.sqrt(total);
    await Promise.all(this.handles.map((h) => h.send({ kind: 'scale', factor })));
    return performance.now() - t0;
  }

  /**
   * Modular-exponentiation oracle across every slice, in parallel.
   *
   * Costs nothing in communication. The counting register lives in the high index
   * bits, so a shard id is the top of `x`, and `a^x = a^(offset) · a^(x_low)`
   * splits cleanly — each shard derives its own starting power from its index and
   * permutes only its local work register.
   *
   * Requires the shard boundary to fall inside the counting register, so the work
   * register stays local.
   */
  async applyModexp(a: number, modulus: number, workQubits: number): Promise<void> {
    if (workQubits > this.layout.localQubits) {
      throw new Error(
        `work register of ${workQubits} qubits does not fit in a ${this.layout.localQubits}-qubit slice`,
      );
    }
    await Promise.all(
      this.handles.map((h) => h.send({ kind: 'modexpLocal', a, modulus, workQubits })),
    );
  }

  /**
   * The counting register's distribution, with the work register traced out.
   *
   * Also communication-free, and the concatenation order is not arbitrary: a
   * shard id *is* the top of the counting register, so slices in index order are
   * already in ascending `x`.
   */
  async registerMarginal(workQubits: number): Promise<Float64Array> {
    const parts = await Promise.all(
      this.handles.map((h) =>
        h.send<Float64Array>({ kind: 'registerMarginal', lowQubits: workQubits }),
      ),
    );
    const out = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  /**
   * Inverse QFT over the counting register (the high `count` qubits).
   *
   * The forward transform is `swaps ∘ core`, so the inverse is `core⁻¹ ∘ swaps`
   * and the swaps come *first* — omitting them would permute the input, not the
   * output. Conjugating by the swap network relabels qubits, so running the core
   * on reversed indices moves the permutation to the end, where dropping it is a
   * pure relabelling of the readout. Worth doing here: those swaps straddle the
   * shard boundary and each decomposes into three CNOTs.
   *
   * `window` truncates the small-angle controlled phases (an approximate QFT).
   * Those contribute least to the result and, on the high qubits, are exactly the
   * expensive cross-shard ones.
   *
   * Returns the gate count and how many of them had to cross a boundary.
   */
  async inverseQft(
    work: number,
    count: number,
    window = Infinity,
  ): Promise<{ gates: number; crossShard: number }> {
    // Reversed labels, so the bit reversal lands on the readout instead.
    const q = (j: number) => work + count - 1 - j;
    const boundary = this.layout.localQubits;
    let gates = 0;
    let crossShard = 0;
    for (let j = 0; j < count; j++) {
      for (let k = 0; k < j; k++) {
        if (j - k > window) continue;
        await this.applyGate('cp', [q(k), q(j)], [-Math.PI / 2 ** (j - k)]);
        gates++;
        if (q(j) >= boundary) crossShard++;
      }
      await this.applyGate('h', [q(j)]);
      gates++;
      if (q(j) >= boundary) crossShard++;
    }
    return { gates, crossShard };
  }

  /** Reverse the low `count` bits — the readout relabelling the skipped swaps imply. */
  static reverseBits(x: number, count: number): number {
    let out = 0;
    for (let b = 0; b < count; b++) if ((x >> b) & 1) out |= 1 << (count - 1 - b);
    return out;
  }

  /**
   * Sample the global distribution exactly, without ever forming it: pick a
   * shard in proportion to its probability mass, then sample inside that slice.
   */
  async sample(shots: number, seed: number): Promise<Map<number, number>> {
    const masses = await Promise.all(this.handles.map((h) => h.send<number>({ kind: 'mass' })));
    const total = masses.reduce((a, b) => a + b, 0);
    let s = (seed >>> 0) || 1;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * total;

    // Shots per shard, drawn from the mass distribution.
    const perShard = new Array<number>(this.handles.length).fill(0);
    for (let i = 0; i < shots; i++) {
      const r = rand();
      let acc = 0;
      let w = this.handles.length - 1;
      for (let k = 0; k < this.handles.length; k++) {
        acc += masses[k];
        if (r < acc) {
          w = k;
          break;
        }
      }
      perShard[w]++;
    }

    const counts = new Map<number, number>();
    const stride = this.layout.localQubits;
    await Promise.all(
      this.handles.map(async (h, w) => {
        if (perShard[w] === 0) return;
        const flat = await h.send<Float64Array>({
          kind: 'sampleLocal',
          shots: perShard[w],
          seed: seed + w * 7919,
        });
        for (let i = 0; i < flat.length; i += 2) {
          // Local index plus the shard id in the high bits gives the global one.
          const global = w * 2 ** stride + flat[i];
          counts.set(global, (counts.get(global) ?? 0) + flat[i + 1]);
        }
      }),
    );
    return counts;
  }

  /**
   * One layer of the benchmark workload: H on every qubit, a CNOT ring, then T
   * on every qubit — the same shape the single-module benchmark uses, so the
   * numbers are comparable. The ring necessarily crosses shard boundaries.
   */
  async benchLayer(): Promise<number> {
    const n = this.layout.globalQubits;
    let gates = 0;
    for (let q = 0; q < n; q++) {
      await this.applyGate('h', [q]);
      gates++;
    }
    if (n >= 2) {
      for (let q = 0; q < n; q++) {
        await this.applyGate('cx', [q, (q + 1) % n]);
        gates++;
      }
    }
    for (let q = 0; q < n; q++) {
      await this.applyGate('t', [q]);
      gates++;
    }
    return gates;
  }
}

// ---------------------------------------------------------------------------
// Capacity probe
// ---------------------------------------------------------------------------

/**
 * How a qubit count came out.
 *
 * Deliberately not a boolean. "The allocation succeeded" turns out to be a very
 * weak claim: a fresh state vector is all zeros, and zero pages are nearly free
 * — the OS commits them lazily and its compressor squashes them away. Measured
 * in Chrome, 6 GiB of zeros allocates in 13 ms (~460 GB/s, far above any real
 * memory bandwidth, so nothing was actually written), while writing 1 GiB of
 * varied data takes ~820 ms. So a size can allocate cleanly and still be
 * unusable.
 */
export type SizeVerdict =
  /** Allocated, filled with real data, and gates ran at a sane rate. */
  | 'viable'
  /** Allocated and filled, but throughput collapsed — swapping, not computing. */
  | 'degraded'
  /** A shard refused the allocation. */
  | 'refused'
  /** Not attempted: past the memory budget. */
  | 'skipped';

/** One measured qubit count. */
export interface ShardedProbePoint {
  qubits: number;
  shards: number;
  localQubits: number;
  bytesPerShard: number;
  totalBytes: number;
  verdict: SizeVerdict;
  allocMs: number;
  /** Cost of forcing every page to hold real data. */
  fillMs: number;
  /**
   * First local gate after the fill, including any first-touch page faulting.
   * Reported separately because hiding it would misattribute setup cost to the
   * steady-state rate.
   */
  localGateColdMs: number;
  /** Warm local gate — the steady-state cost, and what the verdict uses. */
  localGateMs: number;
  /** A gate on a global qubit: pairs every shard and exchanges blocks. */
  globalGateMs: number;
  /**
   * Effective memory bandwidth of the warm local gate, in GB/s.
   *
   * Every gate reads and writes the whole state, so this is bounded by DRAM.
   * It is the health signal: DRAM delivers tens of GB/s, swap well under one,
   * and the size is only usable while this stays in the former regime.
   */
  bandwidthGBps: number;
  exchangedBlocks: number;
  /** |norm - 1| after the gates, on a fully populated state. */
  normError: number;
  error?: string;
}

export interface ShardedProbeResult {
  points: ShardedProbePoint[];
  /** Largest size that actually computed at a sane rate. */
  maxViableQubits: number;
  /** Largest size that allocated at all, viable or not. */
  maxAllocatedQubits: number;
  peakBandwidthGBps: number;
  viableFloorGBps: number;
  budgetBytes: number;
  totalMs: number;
}

export interface ShardedProbeOptions {
  minQubits: number;
  maxQubits: number;
  /**
   * Hard cap on total allocation.
   *
   * A guard rail, not an optimisation. Overshooting RAM does not fail
   * gracefully — the browser kills the tab and takes the results with it.
   */
  budgetBytes: number;
  /**
   * Absolute bandwidth floor, in GB/s, below which a size counts as degraded.
   *
   * Deliberately absolute rather than a fraction of the best size seen. Two
   * things break a relative rule: bandwidth *rises* with worker count (measured
   * ~20 GB/s on one worker, ~95 on four), so sizes with different shard counts
   * are not comparable; and a running peak makes a verdict depend on the order
   * sizes happened to be measured in.
   *
   * An absolute floor works because DRAM and swap are two orders of magnitude
   * apart. Measured on this machine, healthy sizes ran 15-95 GB/s and thrashing
   * ones 0-4, so anything in the low single digits is swapping rather than
   * computing.
   */
  viableFloorGBps: number;
  /**
   * A cold gate slower than this marks the size degraded without re-timing it.
   * Repeating a measurement that is already pathological only prolongs the
   * thrashing.
   */
  giveUpAfterMs: number;
  /** Non-zero probability mass is required after the fill, so the seed matters. */
  seed: number;
}

export const DEFAULT_PROBE_OPTIONS: Omit<ShardedProbeOptions, 'budgetBytes'> = {
  // Below ~24 qubits a gate is fast enough that RPC overhead dominates, so the
  // bandwidth figure stops meaning anything and the size is never in question.
  minQubits: 24,
  maxQubits: 34,
  viableFloorGBps: 5,
  giveUpAfterMs: 20000,
  seed: 0x5EED,
};

/** Where partial results are kept, so a tab crash still leaves evidence. */
export const PROBE_STORAGE_KEY = 'qsim.shardedProbe.partial';

/**
 * A conservative default memory budget.
 *
 * `navigator.deviceMemory` is deliberately coarse and capped at 8 for privacy,
 * so treat it as a lower bound rather than the machine's real capacity.
 */
export function defaultBudgetBytes(): number {
  const gib = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  return gib * 1024 ** 3;
}

/** Largest register that fits in `budgetBytes`. */
export function maxQubitsForBudget(budgetBytes: number): number {
  let n = 1;
  while (16 * 2 ** (n + 1) <= budgetBytes && n < 40) n++;
  return n;
}

function emptyPoint(n: number, layout: ShardLayout, verdict: SizeVerdict): ShardedProbePoint {
  return {
    qubits: n,
    shards: layout.shards,
    localQubits: layout.localQubits,
    bytesPerShard: layout.bytesPerShard,
    totalBytes: layout.totalBytes,
    verdict,
    allocMs: 0,
    fillMs: 0,
    localGateColdMs: NaN,
    localGateMs: NaN,
    globalGateMs: NaN,
    bandwidthGBps: NaN,
    exchangedBlocks: 0,
    normError: NaN,
  };
}

/**
 * Walk the qubit count upward, and at each size prove the register is actually
 * *computable* rather than merely allocatable.
 *
 * Per size: allocate every slice, fill them with random amplitudes so no page is
 * left as free zeros, normalise, then time one local gate and one cross-shard
 * gate and check the norm survived. A size only counts as viable if the fill
 * succeeded and the local gate ran at a reasonable fraction of the best
 * bandwidth seen — allocation alone proves almost nothing.
 *
 * Partial results are written to `localStorage` after every size, because the
 * failure mode near the ceiling is the tab dying rather than an exception.
 */
export async function probeSharded(
  options: ShardedProbeOptions,
  onPoint?: (p: ShardedProbePoint, current: number) => void,
): Promise<ShardedProbeResult> {
  await initPlanning();
  const started = performance.now();
  const points: ShardedProbePoint[] = [];
  let peakBandwidthGBps = 0;

  const persist = () => {
    try {
      localStorage.setItem(
        PROBE_STORAGE_KEY,
        JSON.stringify({ at: Date.now(), budgetBytes: options.budgetBytes, points }),
      );
    } catch {
      // Storage being unavailable must not abort a run.
    }
  };

  for (let n = options.minQubits; n <= options.maxQubits; n++) {
    const layout = planLayout(n);
    if (layout.totalBytes > options.budgetBytes) {
      points.push(emptyPoint(n, layout, 'skipped'));
      persist();
      break;
    }

    onPoint?.(emptyPoint(n, layout, 'skipped'), n);

    let engine: ShardedEngine;
    const tAlloc = performance.now();
    try {
      engine = await ShardedEngine.create(layout);
    } catch (e) {
      const p = emptyPoint(n, layout, 'refused');
      p.allocMs = performance.now() - tAlloc;
      p.error = e instanceof Error ? e.message : String(e);
      points.push(p);
      onPoint?.(p, n);
      persist();
      break;
    }
    const allocMs = performance.now() - tAlloc;

    try {
      // Force every page resident before timing anything. Without this the
      // measurements describe a buffer of zeros, not a state vector.
      const fillMs = await engine.fill(options.seed + n);

      const time = async (fn: () => Promise<void>) => {
        const t = performance.now();
        await fn();
        return performance.now() - t;
      };

      // The first gate pays first-touch faulting; the warm one is the steady
      // state. Take the best of two warm runs, unless the cold one was already
      // pathological -- re-timing a thrashing register just prolongs it.
      const localGateColdMs = await time(() => engine.applyGate('h', [0]));
      let localGateMs = localGateColdMs;
      if (localGateColdMs < options.giveUpAfterMs) {
        for (let rep = 0; rep < 2; rep++) {
          localGateMs = Math.min(localGateMs, await time(() => engine.applyGate('h', [0])));
        }
      }
      const globalGateMs = await time(() => engine.applyGate('h', [n - 1]));
      const normError = Math.abs((await engine.norm()) - 1);

      // Every gate reads and writes the whole state.
      const bandwidthGBps = (layout.totalBytes * 2) / 1e9 / (localGateMs / 1000);
      peakBandwidthGBps = Math.max(peakBandwidthGBps, bandwidthGBps);

      const healthy = bandwidthGBps >= options.viableFloorGBps;
      const point: ShardedProbePoint = {
        qubits: n,
        shards: layout.shards,
        localQubits: layout.localQubits,
        bytesPerShard: layout.bytesPerShard,
        totalBytes: layout.totalBytes,
        verdict: healthy && normError < 1e-9 ? 'viable' : 'degraded',
        allocMs,
        fillMs,
        localGateColdMs,
        localGateMs,
        globalGateMs,
        bandwidthGBps,
        exchangedBlocks: engine.exchangedBlocks,
        normError,
      };
      points.push(point);
      onPoint?.(point, n);
      persist();
    } catch (e) {
      // A shard dying mid-fill is the signature of running out of memory for
      // real, as opposed to the allocator declining up front.
      const p = emptyPoint(n, layout, 'refused');
      p.allocMs = allocMs;
      p.error = e instanceof Error ? e.message : String(e);
      points.push(p);
      onPoint?.(p, n);
      persist();
      engine.dispose();
      break;
    }

    // Hand the slices back before attempting a larger allocation. Worker
    // termination is asynchronous on the OS side, and a too-short pause here
    // leaks pressure into the next size and corrupts its measurement.
    engine.dispose();
    await new Promise((r) => setTimeout(r, 500));
  }

  const viable = points.filter((p) => p.verdict === 'viable');
  const allocated = points.filter((p) => p.verdict === 'viable' || p.verdict === 'degraded');
  return {
    points,
    maxViableQubits: viable.length ? viable[viable.length - 1].qubits : 0,
    maxAllocatedQubits: allocated.length ? allocated[allocated.length - 1].qubits : 0,
    peakBandwidthGBps,
    viableFloorGBps: options.viableFloorGBps,
    budgetBytes: options.budgetBytes,
    totalMs: performance.now() - started,
  };
}
