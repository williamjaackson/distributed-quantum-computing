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

/** One measured qubit count in the sharded probe. */
export interface ShardedProbePoint {
  qubits: number;
  shards: number;
  localQubits: number;
  bytesPerShard: number;
  totalBytes: number;
  allocated: boolean;
  allocMs: number;
  /** A gate below the shard boundary: no communication at all. */
  localGateMs: number;
  /** A gate on a global qubit: pairs every shard and exchanges blocks. */
  globalGateMs: number;
  exchangedBlocks: number;
  normError: number;
  error?: string;
}

export type ShardedStopReason = 'budget' | 'allocation-failed' | 'user-limit';

export interface ShardedProbeResult {
  points: ShardedProbePoint[];
  maxQubits: number;
  budgetBytes: number;
  stopReason: ShardedStopReason;
  totalMs: number;
}

export interface ShardedProbeOptions {
  minQubits: number;
  maxQubits: number;
  /**
   * Hard cap on total allocation.
   *
   * This is a guard rail, not an optimisation. Asking for more memory than the
   * machine has does not fail gracefully — the browser kills the tab, taking the
   * results with it. Measured here: 8 GiB succeeded, 16 GiB killed the renderer.
   */
  budgetBytes: number;
}

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
  while ((16 * 2 ** (n + 1)) <= budgetBytes && n < 40) n++;
  return n;
}

/**
 * Walk the qubit count upward, allocating a sharded register at each size and
 * timing one local gate and one cross-shard gate.
 *
 * Two timings rather than a full layer: they isolate the two costs that actually
 * matter — work below the boundary, which is free of communication, and work
 * above it, which is not.
 */
export async function probeSharded(
  options: ShardedProbeOptions,
  onPoint?: (p: ShardedProbePoint, current: number) => void,
): Promise<ShardedProbeResult> {
  await initPlanning();
  const started = performance.now();
  const points: ShardedProbePoint[] = [];
  let maxQubits = 0;
  let stopReason: ShardedStopReason = 'user-limit';

  for (let n = options.minQubits; n <= options.maxQubits; n++) {
    const layout = planLayout(n);
    if (layout.totalBytes > options.budgetBytes) {
      stopReason = 'budget';
      break;
    }
    onPoint?.(
      {
        qubits: n,
        shards: layout.shards,
        localQubits: layout.localQubits,
        bytesPerShard: layout.bytesPerShard,
        totalBytes: layout.totalBytes,
        allocated: false,
        allocMs: 0,
        localGateMs: NaN,
        globalGateMs: NaN,
        exchangedBlocks: 0,
        normError: NaN,
      },
      n,
    );

    const t0 = performance.now();
    let engine: ShardedEngine;
    try {
      engine = await ShardedEngine.create(layout);
    } catch (e) {
      points.push({
        qubits: n,
        shards: layout.shards,
        localQubits: layout.localQubits,
        bytesPerShard: layout.bytesPerShard,
        totalBytes: layout.totalBytes,
        allocated: false,
        allocMs: performance.now() - t0,
        localGateMs: NaN,
        globalGateMs: NaN,
        exchangedBlocks: 0,
        normError: NaN,
        error: e instanceof Error ? e.message : String(e),
      });
      stopReason = 'allocation-failed';
      break;
    }
    const allocMs = performance.now() - t0;

    const time = async (fn: () => Promise<void>) => {
      const t = performance.now();
      await fn();
      return performance.now() - t;
    };
    // Qubit 0 is always local; the top qubit is global whenever there is more
    // than one shard.
    const localGateMs = await time(() => engine.applyGate('h', [0]));
    const globalGateMs = await time(() => engine.applyGate('h', [n - 1]));
    const normError = Math.abs((await engine.norm()) - 1);

    const point: ShardedProbePoint = {
      qubits: n,
      shards: layout.shards,
      localQubits: layout.localQubits,
      bytesPerShard: layout.bytesPerShard,
      totalBytes: layout.totalBytes,
      allocated: true,
      allocMs,
      localGateMs,
      globalGateMs,
      exchangedBlocks: engine.exchangedBlocks,
      normError,
    };
    points.push(point);
    maxQubits = n;
    onPoint?.(point, n);

    // Terminate before the next size: the slices must actually be handed back
    // before a larger allocation is attempted.
    engine.dispose();
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    points,
    maxQubits,
    budgetBytes: options.budgetBytes,
    stopReason,
    totalMs: performance.now() - started,
  };
}
