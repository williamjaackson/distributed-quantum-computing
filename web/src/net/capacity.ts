import { evenSplit } from './shots';

export interface ShotCapacity {
  machines: number;
  smallestShare: number;
  largestShare: number;
}

export function shotCapacity(shots: number, helpers: number): ShotCapacity {
  const machines = Math.max(1, Math.floor(helpers) + 1);
  const shares = evenSplit(Math.max(0, Math.floor(shots)), machines);
  return {
    machines,
    smallestShare: Math.min(...shares),
    largestShare: Math.max(...shares),
  };
}

export interface ExpandCapacity {
  machines: number;
  usableShards: number;
  maxQubits: number;
  bytesPerShard: number;
  totalBytes: number;
}

/**
 * Capacity of the planned one-shard-per-machine expand layout.
 *
 * Shard ids are bits, so only the largest power-of-two group can form one
 * register. Extra machines remain available for shots until another arrives.
 */
export function expandCapacity(machines: number, maxShardQubits: number): ExpandCapacity {
  const available = Math.max(1, Math.floor(machines));
  const usableShards = 2 ** Math.floor(Math.log2(available));
  const localQubits = Math.max(1, Math.floor(maxShardQubits));
  const bytesPerShard = 2 ** localQubits * 16;
  return {
    machines: available,
    usableShards,
    maxQubits: localQubits + Math.log2(usableShards),
    bytesPerShard,
    totalBytes: bytesPerShard * usableShards,
  };
}
