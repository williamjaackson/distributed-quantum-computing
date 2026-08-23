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
  fullArrayQubitLimit,
  maxQubits,
  maxShardQubits,
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

/**
 * Build a register for `nQubits`. Always sharded.
 *
 * One module could hold anything up to 26 qubits, and for a while the app chose
 * between the two. That was a setting nobody wanted to think about and a second
 * code path to keep honest, so it is gone: K shards hold K times what one module
 * can, the mechanism is identical at four qubits and at thirty, and the ceiling
 * becomes the machine's memory rather than `isize::MAX`.
 *
 * At least two shards even for a tiny register, so the sharded path is the path
 * — a "sharded" run over a single shard would exercise none of the routing.
 */
export async function createBackend(nQubits: number, seed: number): Promise<Backend> {
  await loadWasm();
  const minShardBits = Math.min(2, Math.max(1, nQubits - 1));
  return ShardedRegister.create(planLayout(nQubits, minShardBits), seed);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Bloch vector of one qubit, read off a raw amplitude array.
 *
 * The engine computes these during a run; this is for the one case that has the
 * amplitudes and not a register — pairing them up for a correlation.
 */
export function blochOf(amps: Float64Array, q: number): Float64Array {
  const n = amps.length / 2;
  const bit = 1 << q;
  let r00 = 0;
  let r11 = 0;
  let re01 = 0;
  let im01 = 0;
  for (let i = 0; i < n; i++) {
    const are = amps[2 * i];
    const aim = amps[2 * i + 1];
    if ((i & bit) === 0) {
      r00 += are * are + aim * aim;
      const j = i | bit;
      const bre = amps[2 * j];
      const bim = amps[2 * j + 1];
      re01 += are * bre + aim * bim;
      im01 += aim * bre - are * bim;
    } else {
      r11 += are * are + aim * aim;
    }
  }
  return Float64Array.of(2 * re01, -2 * im01, r00 - r11);
}

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
