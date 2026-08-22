/** Messages between the orchestrator and a single shard worker. */

export interface ShardInfo {
  localQubits: number;
  globalQubits: number;
  sliceAmplitudes: number;
  blockAmplitudes: number;
  numBlocks: number;
  sliceBytes: number;
}

export type ShardReq =
  | { id: number; kind: 'init'; localQubits: number; shardBits: number; index: number }
  | { id: number; kind: 'reset' }
  | { id: number; kind: 'applyLocal'; base: string; params: number[]; controls: number[]; target: number }
  /** Copy one block out of linear memory for the partner shard. */
  | { id: number; kind: 'exportBlock'; block: number }
  /** Stage the partner's block, then apply this shard's row of the 2x2. */
  | {
      id: number;
      kind: 'importApply';
      block: number;
      isLow: boolean;
      base: string;
      params: number[];
      localCmask: number;
      buffer: ArrayBuffer;
    }
  /** Fill with pseudorandom amplitudes; resolves with this slice's mass. */
  | { id: number; kind: 'fillRandom'; seed: number }
  /** Normalise after a distributed fill. */
  | { id: number; kind: 'scale'; factor: number }
  /** Modular-exponentiation oracle over this slice alone; no communication. */
  | { id: number; kind: 'modexpLocal'; a: number; modulus: number; workQubits: number }
  /** This slice's share of the counting-register distribution. */
  | { id: number; kind: 'registerMarginal'; lowQubits: number }
  | { id: number; kind: 'mass' }
  | { id: number; kind: 'localProbabilityOfOne'; qubit: number }
  | { id: number; kind: 'probabilities' }
  | { id: number; kind: 'sampleLocal'; shots: number; seed: number };

export type ShardRes =
  | { id: number; type: 'ok'; data: unknown }
  | { id: number; type: 'error'; error: string };

/**
 * Omit that distributes across a union — a conditional type only distributes
 * over a naked type parameter, so the indirection through `T` is load-bearing.
 * A plain `Omit<ShardReq, 'id'>` would collapse to the shared keys and drop
 * every payload field.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A shard request minus the id the handle assigns. */
export type ShardReqBody = DistributiveOmit<ShardReq, 'id'>;
