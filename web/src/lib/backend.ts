/**
 * How the register is held, behind one interface.
 *
 * There are two, and the visualiser does not care which it is talking to:
 *
 * * **Whole state** — one WASM module on this thread, up to 26 qubits (1 GiB,
 *   the `isize::MAX` cap on a single Rust allocation).
 * * **Sharded** — one module per worker, each with its own 4 GiB address space,
 *   so capacity is bounded by RAM instead. `shard.rs` plans every gate; the
 *   orchestrator only routes.
 *
 * Everything is async, including the whole-state path that could be synchronous.
 * A 22-qubit gate takes real milliseconds and a sharded one takes a round trip
 * per block, so a single async shape is what lets the same runner drive both —
 * and lets the UI show progress rather than freeze.
 *
 * The interface is deliberately narrow: gates, measurement, a *summary*, and
 * sampling. Nothing asks for the whole state, because past 22 qubits the engine
 * refuses to hand one over and it would be pointless to draw if it did.
 */
import init, {
  Simulator,
  fullArrayQubitLimit,
  maxQubits,
  maxShardQubits,
  memoryBytesRequired,
  planShards,
} from 'qsim';
import wasmUrl from 'qsim/qsim_bg.wasm?url';
import { ShardedRegister } from './shardedRegister';

/** Basis states kept per frame when the whole distribution is out of reach. */
export const TOP_K = 512;

export interface Snapshot {
  norm: number;
  /** Per-qubit Bloch vectors, three entries each. */
  bloch: Float64Array;
  /** `[index, re, im]` triples, largest probability first. */
  top: Float64Array;
  /** True when `top` is a truncated view of a larger distribution. */
  topTruncated: boolean;
  /** Whole amplitude array, when one was asked for and is affordable. */
  amps: Float64Array | null;
  /** `n x n` pairwise correlations, when the budget allowed computing them. */
  links: Float64Array | null;
}

export interface Backend {
  readonly nQubits: number;
  /** One line naming how the state is held, for the UI. */
  readonly description: string;
  readonly sharded: boolean;
  /** Shard count, 1 for the whole-state path. */
  readonly shards: number;
  applyGate(name: string, qubits: number[], params: number[]): Promise<void>;
  measure(qubit: number): Promise<number>;
  /**
   * Project one qubit onto a given outcome instead of a drawn one.
   *
   * What replaying a recorded shot needs: the outcome is already known, and
   * drawing again would give a different one.
   */
  collapse(qubit: number, outcome: number): Promise<void>;
  /**
   * Return to |0…0> and reseed the measurement draw.
   *
   * Taking N shots of a circuit that measures means running it N times, and
   * allocating a register per shot would dominate the cost of the shots
   * themselves — at 26 qubits it would be a gigabyte a time.
   */
  reset(seed: number): Promise<void>;
  snapshot(want: SnapshotRequest): Promise<Snapshot>;
  sample(shots: number, seed: number): Promise<Map<number, number>>;
  dispose(): void;
}

export interface SnapshotRequest {
  /** Keep the whole amplitude array on this frame. */
  amps: boolean;
  /** Compute the pairwise correlation matrix on this frame. */
  links: boolean;
}

let loading: Promise<void> | null = null;
let loaded = false;

/** Load the module once. Also what the shard orchestrator plans against. */
export function loadWasm(): Promise<void> {
  loading ??= init({ module_or_path: wasmUrl }).then(() => {
    loaded = true;
  });
  return loading;
}

export interface EngineLimits {
  /** Largest register a single module can allocate — 26 on wasm32. */
  maxWholeState: number;
  /** Past this the engine refuses to return a full array at all. */
  fullArrayLimit: number;
  /** Largest slice one shard should hold. */
  maxShardQubits: number;
}

/**
 * What this build can do, read from the engine itself.
 *
 * Throws before [`loadWasm`] resolves rather than returning a plausible-looking
 * default: these numbers decide how large a register the UI will offer, and a
 * guessed one would be wrong in exactly the direction that matters.
 */
export function engineLimits(): EngineLimits {
  if (!loaded) {
    throw new Error('engineLimits() called before loadWasm() resolved');
  }
  return {
    maxWholeState: maxQubits(),
    fullArrayLimit: fullArrayQubitLimit(),
    maxShardQubits: maxShardQubits(),
  };
}

/** The limits, or null while the module is still loading. */
export function engineLimitsIfReady(): EngineLimits | null {
  return loaded ? engineLimits() : null;
}

export interface ShardLayout {
  globalQubits: number;
  shardBits: number;
  localQubits: number;
  shards: number;
  bytesPerShard: number;
  totalBytes: number;
}

export function planLayout(globalQubits: number, minShardBits = 0): ShardLayout {
  const [shardBits, localQubits, shards, bytesPerShard, totalBytes] = planShards(
    globalQubits,
    maxShardQubits(),
    minShardBits,
  );
  return { globalQubits, shardBits, localQubits, shards, bytesPerShard, totalBytes };
}

export type Execution = 'auto' | 'whole' | 'sharded';

/**
 * Build a backend for `nQubits`.
 *
 * `auto` uses one module while one module will do — it is strictly faster, since
 * a sharded gate on a global qubit costs a block exchange per pair. Sharding can
 * also be forced at any size, which is the only way to *watch* it work: the
 * mechanism is identical at four qubits and at thirty.
 */
export async function createBackend(
  nQubits: number,
  seed: number,
  execution: Execution,
): Promise<Backend> {
  await loadWasm();
  const limits = engineLimits();
  const useShards =
    execution === 'sharded' || (execution === 'auto' && nQubits > limits.maxShardQubits);
  if (!useShards) {
    if (nQubits > limits.maxWholeState) {
      throw new Error(
        `${nQubits} qubits needs sharding — one module holds at most ${limits.maxWholeState}`,
      );
    }
    return new WholeStateBackend(nQubits, seed);
  }
  // Forcing sharding at a small size still has to produce more than one shard,
  // or it would demonstrate nothing.
  const minShardBits = execution === 'sharded' ? Math.min(2, Math.max(1, nQubits - 1)) : 0;
  return ShardedRegister.create(planLayout(nQubits, minShardBits), seed);
}

// ---------------------------------------------------------------------------
// Whole state, on this thread
// ---------------------------------------------------------------------------

class WholeStateBackend implements Backend {
  readonly sharded = false;
  readonly shards = 1;
  readonly description: string;
  private sim: Simulator;

  constructor(readonly nQubits: number, seed: number) {
    this.sim = new Simulator(nQubits);
    this.sim.setSeed(seed);
    this.description = `one ${formatBytes(memoryBytesRequired(nQubits))} state vector`;
  }

  async applyGate(name: string, qubits: number[], params: number[]): Promise<void> {
    this.sim.applyGate(name, new Uint32Array(qubits), new Float64Array(params));
  }

  async measure(qubit: number): Promise<number> {
    return this.sim.measure(qubit);
  }

  async collapse(qubit: number, outcome: number): Promise<void> {
    this.sim.collapse(qubit, outcome);
  }

  async reset(seed: number): Promise<void> {
    this.sim.reset();
    this.sim.setSeed(seed);
  }

  async snapshot(want: SnapshotRequest): Promise<Snapshot> {
    const n = this.nQubits;
    const bloch = new Float64Array(3 * n);
    for (let q = 0; q < n; q++) bloch.set(this.sim.blochVector(q), 3 * q);
    const top = this.sim.topAmplitudesFlat(TOP_K);
    const count = 2 ** n;
    return {
      norm: this.sim.norm(),
      bloch,
      top,
      topTruncated: top.length / 3 >= TOP_K && count > TOP_K,
      amps: want.amps ? this.sim.amplitudes() : null,
      links: want.links ? this.correlations() : null,
    };
  }

  /**
   * Connected Pauli correlation for every pair, from the engine's own two-qubit
   * reduced density matrices.
   */
  private correlations(): Float64Array {
    const n = this.nQubits;
    const out = new Float64Array(n * n);
    const single = (q: number) => this.sim.blochVector(q);
    const bloch: Float64Array[] = [];
    for (let q = 0; q < n; q++) bloch.push(single(q));
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const c = pauliCorrelation(this.sim.reducedTwoFlat(a, b), bloch[a], bloch[b]);
        out[a * n + b] = c;
        out[b * n + a] = c;
      }
    }
    return out;
  }

  async sample(shots: number, seed: number): Promise<Map<number, number>> {
    const flat = this.sim.sampleFlat(shots, seed);
    const out = new Map<number, number>();
    for (let i = 0; i + 1 < flat.length; i += 2) {
      out.set(flat[i], (out.get(flat[i]) ?? 0) + flat[i + 1]);
    }
    return out;
  }

  dispose() {
    this.sim.free();
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** X, Y, Z as row-major `[re, im]` pairs. */
const PAULI: number[][] = [
  [0, 0, 1, 0, 1, 0, 0, 0],
  [0, 0, 0, -1, 0, 1, 0, 0],
  [1, 0, 0, 0, 0, 0, -1, 0],
];

/**
 * Total connected Pauli correlation between two qubits, in [0, 1].
 *
 * `T[i][j] = <P_i P_j> - <P_i><P_j>` over the three axes; the measure is its
 * Frobenius norm over sqrt(3), the norm a maximally entangled pair reaches.
 * Reading it: 0 is independent, 1 is a Bell pair. A pair left *classically*
 * correlated — say by measuring one half of a Bell pair — keeps only the ZZ
 * term and lands at 1/sqrt(3) ~ 0.58, so the map separates "share information"
 * from "are entangled" by magnitude alone.
 *
 * Chosen over mutual information because it needs no eigendecomposition, and
 * over concurrence because it extends unchanged to a pair drawn out of a larger,
 * mixed register.
 */
export function pauliCorrelation(
  rho: Float64Array | number[],
  blochA: Float64Array,
  blochB: Float64Array,
): number {
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const t = traceProduct(rho, i, j) - blochA[i] * blochB[j];
      sum += t * t;
    }
  }
  return Math.min(1, Math.sqrt(sum / 3));
}

/**
 * `Tr(rho * (P_i on a) (x) (P_j on b))`, real part only — the imaginary part is
 * zero for a Hermitian state and a Hermitian observable, so carrying it would
 * only accumulate rounding noise.
 */
function traceProduct(rho: Float64Array | number[], i: number, j: number): number {
  const A = PAULI[i];
  const B = PAULI[j];
  let acc = 0;
  for (let k = 0; k < 4; k++) {
    for (let l = 0; l < 4; l++) {
      // M[l][k] = A[bit0(l)][bit0(k)] * B[bit1(l)][bit1(k)]
      const ai = 2 * (((l & 1) << 1) | (k & 1));
      const bi = 2 * ((((l >> 1) & 1) << 1) | ((k >> 1) & 1));
      const mre = A[ai] * B[bi] - A[ai + 1] * B[bi + 1];
      const mim = A[ai] * B[bi + 1] + A[ai + 1] * B[bi];
      acc += rho[2 * (k * 4 + l)] * mre - rho[2 * (k * 4 + l) + 1] * mim;
    }
  }
  return acc;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
