/**
 * A register spread across worker-owned shards.
 *
 * Every decision comes from the engine: `planGate` says which shards take part
 * in a gate and which pair with which, and the per-qubit summaries come from
 * `localReducedOne` / `dotScratch`. This file only routes work and moves blocks,
 * which is deliberate — `tests/sharding.rs` drives the same sequence in process
 * and asserts it matches whole-state execution bit for bit, so the subtle part
 * is covered by `cargo test` rather than by clicking around a browser.
 *
 * The two qubit kinds are why sharding is worth anything:
 *
 * * A **local** qubit (`q < localQubits`) is entirely inside each slice. Gates
 *   and summaries run on every shard at once with *no communication*.
 * * A **global** qubit is a bit of the shard id. A gate becomes an elementwise
 *   2x2 between two whole slices, exchanged in blocks; a measurement is resolved
 *   by choosing which shards survive; and only its off-diagonal summary element
 *   needs any traffic at all.
 */
import { Prng, baseGates, planGate } from 'qsim';
import type { Backend, ShardLayout, Snapshot, SnapshotRequest } from './backend';
import { formatBytes, TOP_K } from './backend';
import type { ShardInfo, ShardReq, ShardReqBody, ShardRes } from './shardProtocol';

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
    // in-flight request keeps a run from hanging on a dead shard.
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

export class ShardedRegister implements Backend {
  readonly sharded = true;
  private handles: ShardHandle[] = [];
  private base: string[] = [];
  private info: ShardInfo | null = null;
  /** The engine's own generator, so a sharded run observes exactly the outcomes
   *  a whole-state run of the same circuit and seed would. */
  private rng: Prng;
  private disposed = false;
  /** Blocks moved between shards, so the UI can report communication volume. */
  exchangedBlocks = 0;

  private constructor(
    readonly layout: ShardLayout,
    seed: number,
  ) {
    this.rng = new Prng(seed);
  }

  get nQubits(): number {
    return this.layout.globalQubits;
  }

  get shards(): number {
    return this.layout.shards;
  }

  get description(): string {
    const { shards, bytesPerShard, localQubits, shardBits } = this.layout;
    return (
      `${shards} shards × ${formatBytes(bytesPerShard)} ` +
      `(${localQubits} local + ${shardBits} global qubits)`
    );
  }

  static async create(layout: ShardLayout, seed: number): Promise<ShardedRegister> {
    const reg = new ShardedRegister(layout, seed);
    reg.base = baseGates();
    try {
      for (let w = 0; w < layout.shards; w++) reg.handles.push(new ShardHandle(w));
      const infos = await Promise.all(
        reg.handles.map((h) =>
          h.send<ShardInfo>({
            kind: 'init',
            localQubits: layout.localQubits,
            shardBits: layout.shardBits,
            index: h.index,
          }),
        ),
      );
      reg.info = infos[0];
      return reg;
    } catch (e) {
      reg.dispose();
      throw e;
    }
  }

  dispose() {
    this.handles.forEach((h) => h.terminate());
    this.handles = [];
    this.freeRng();
  }

  /** Every slice back to the ground state, and a fresh draw sequence. */
  async reset(seed: number): Promise<void> {
    await Promise.all(this.handles.map((h) => h.send({ kind: 'reset' })));
    this.rng.free();
    this.rng = new Prng(seed);
  }

  // -------------------------------------------------------------------------
  // Gates
  // -------------------------------------------------------------------------

  async applyGate(name: string, qubits: number[], params: number[]): Promise<void> {
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
    await Promise.all(
      this.taking(step.globalCmask).map((h) =>
        h.send({ kind: 'applyLocal', base: step.base, params: step.params, controls, target }),
      ),
    );
  }

  /** Shards a global control mask selects. */
  private taking(globalCmask: number): ShardHandle[] {
    return this.handles.filter((h) => (h.index & globalCmask) === globalCmask);
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
    for (const h of this.taking(step.globalCmask)) {
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

  // -------------------------------------------------------------------------
  // Summaries
  // -------------------------------------------------------------------------

  private async masses(): Promise<number[]> {
    return Promise.all(this.handles.map((h) => h.send<number>({ kind: 'mass' })));
  }

  /**
   * One-qubit reduced density matrix as `[r00, re01, im01, r11]`.
   *
   * A local qubit is four sums within each slice, added up — no shard sees any
   * other. A global qubit's diagonal comes straight from the shard masses, with
   * no arithmetic over amplitudes at all; only its off-diagonal needs a pass,
   * and that reuses the gate exchange's own staging buffer.
   */
  private async reducedOne(qubit: number): Promise<[number, number, number, number]> {
    if (qubit < this.layout.localQubits) {
      const parts = await Promise.all(
        this.handles.map((h) => h.send<number[]>({ kind: 'localReducedOne', qubit })),
      );
      const acc: [number, number, number, number] = [0, 0, 0, 0];
      for (const p of parts) for (let i = 0; i < 4; i++) acc[i] += p[i];
      return acc;
    }

    const bit = 1 << (qubit - this.layout.localQubits);
    const masses = await this.masses();
    let r00 = 0;
    let r11 = 0;
    masses.forEach((m, w) => (w & bit ? (r11 += m) : (r00 += m)));

    let re01 = 0;
    let im01 = 0;
    const blocks = this.info?.numBlocks ?? 1;
    for (const lo of this.handles) {
      if (lo.index & bit) continue;
      const hi = this.handles[lo.index | bit];
      for (let b = 0; b < blocks; b++) {
        const block = await hi.send<Float64Array>({ kind: 'exportBlock', block: b });
        this.exchangedBlocks += 1;
        const [re, im] = await lo.send<number[]>(
          { kind: 'importDot', block: b, buffer: block.buffer as ArrayBuffer },
          [block.buffer],
        );
        re01 += re;
        im01 += im;
      }
    }
    return [r00, re01, im01, r11];
  }

  private async bloch(): Promise<Float64Array> {
    const out = new Float64Array(3 * this.nQubits);
    for (let q = 0; q < this.nQubits; q++) {
      const [r00, re01, im01, r11] = await this.reducedOne(q);
      out[3 * q] = 2 * re01;
      out[3 * q + 1] = -2 * im01;
      out[3 * q + 2] = r00 - r11;
    }
    return out;
  }

  /**
   * Global top-`k`, merged from each slice's own top-`k`.
   *
   * Exact, and not obviously so: a state can only be in the global top-`k` if it
   * is in its own shard's top-`k`, because ranking within a slice is the same
   * ranking as globally.
   */
  private async top(k: number): Promise<{ flat: Float64Array; truncated: boolean }> {
    const stride = 2 ** this.layout.localQubits;
    const parts = await Promise.all(
      this.handles.map((h) => h.send<Float64Array>({ kind: 'localTop', k })),
    );
    const merged: [number, number, number][] = [];
    parts.forEach((p, w) => {
      for (let i = 0; i + 2 < p.length; i += 3) {
        merged.push([w * stride + p[i], p[i + 1], p[i + 2]]);
      }
    });
    merged.sort((a, b) => b[1] ** 2 + b[2] ** 2 - (a[1] ** 2 + a[2] ** 2) || a[0] - b[0]);
    const kept = merged.slice(0, k);
    const flat = new Float64Array(kept.length * 3);
    kept.forEach((e, i) => flat.set(e, 3 * i));
    return { flat, truncated: merged.length > kept.length };
  }

  async snapshot(want: SnapshotRequest): Promise<Snapshot> {
    const bloch = await this.bloch();
    const { flat, truncated } = await this.top(TOP_K);
    const masses = await this.masses();
    const amps = want.amps ? await this.amplitudes() : null;
    return {
      norm: masses.reduce((a, b) => a + b, 0),
      bloch,
      top: flat,
      topTruncated: truncated,
      amps,
      // A two-qubit reduced matrix straddling shards has no slice-local form and
      // no engine kernel, so the sharded path reports no links rather than a
      // guess. The dials are exact either way.
      links: null,
    };
  }

  /** Every amplitude, concatenated. Only ever asked for at tiny sizes. */
  private async amplitudes(): Promise<Float64Array> {
    const parts = await Promise.all(
      this.handles.map((h) => h.send<Float64Array>({ kind: 'amplitudes' })),
    );
    const out = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Measurement
  // -------------------------------------------------------------------------

  /**
   * Measure one qubit and collapse.
   *
   * The draw happens exactly once, against the *global* marginal — the part no
   * shard can do for itself. A local qubit then collapses inside every slice; a
   * global one collapses by shard selection, emptying the slices on the
   * unobserved side outright.
   */
  async measure(qubit: number): Promise<number> {
    const [, , , r11] = await this.reducedOne(qubit);
    const outcome = this.rng.nextF64() < r11 ? 1 : 0;
    await this.project(qubit, outcome, outcome === 1 ? r11 : 1 - r11);
    return outcome;
  }

  /** Project onto a known outcome — the same collapse, without the draw. */
  async collapse(qubit: number, outcome: number): Promise<void> {
    const [, , , r11] = await this.reducedOne(qubit);
    const p = outcome === 1 ? r11 : 1 - r11;
    if (p <= 0) {
      throw new Error(`qubit ${qubit} cannot be ${outcome}: that branch holds no probability`);
    }
    await this.project(qubit, outcome, p);
  }

  /**
   * Keep one branch and renormalise.
   *
   * A local qubit collapses inside every slice. A global one is a shard-id bit,
   * so it collapses by *selection*: the slices on the unobserved side are
   * emptied outright and no amplitude arithmetic happens at all.
   */
  private async project(qubit: number, outcome: number, p: number): Promise<void> {
    if (p <= 0) return;
    const scale = 1 / Math.sqrt(p);
    if (qubit < this.layout.localQubits) {
      await Promise.all(
        this.handles.map((h) => h.send({ kind: 'collapseLocal', qubit, outcome, scale })),
      );
      return;
    }
    const bit = 1 << (qubit - this.layout.localQubits);
    await Promise.all(
      this.handles.map((h) =>
        (h.index & bit ? 1 : 0) === outcome
          ? h.send({ kind: 'scale', factor: scale })
          : h.send({ kind: 'clear' }),
      ),
    );
  }

  /**
   * Sample the global distribution exactly, without ever forming it: pick a
   * shard in proportion to its probability mass, then sample inside that slice.
   */
  async sample(shots: number, seed: number): Promise<Map<number, number>> {
    const masses = await this.masses();
    const total = masses.reduce((a, b) => a + b, 0);
    const rand = new Prng(seed);

    const perShard = new Array<number>(this.handles.length).fill(0);
    for (let i = 0; i < shots; i++) {
      const r = rand.nextF64() * total;
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
    const stride = 2 ** this.layout.localQubits;
    await Promise.all(
      this.handles.map(async (h, w) => {
        if (perShard[w] === 0) return;
        const flat = await h.send<Float64Array>({
          kind: 'sampleLocal',
          shots: perShard[w],
          seed: seed + w * 7919,
        });
        for (let i = 0; i + 1 < flat.length; i += 2) {
          // Local index plus the shard id in the high bits gives the global one.
          const global = w * stride + flat[i];
          counts.set(global, (counts.get(global) ?? 0) + flat[i + 1]);
        }
      }),
    );
    return counts;
  }

  /** Release the generator's WASM allocation along with the workers. Guarded
   *  because a failed `create` disposes and then rethrows. */
  private freeRng() {
    if (!this.disposed) {
      this.disposed = true;
      this.rng.free();
    }
  }
}
