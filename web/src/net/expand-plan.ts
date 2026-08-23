export interface ExpandParticipant {
  id: string;
  memoryGiB: number;
}

export interface ExpandShardAssignment {
  shard: number;
  participantId: string;
  slot: number;
}

export interface DistributedShardPlan {
  globalQubits: number;
  shardBits: number;
  localQubits: number;
  shards: number;
  bytesPerShard: number;
  totalBytes: number;
  assignments: ExpandShardAssignment[];
  slotsByParticipant: Record<string, number>;
}

const GIB = 1024 ** 3;

/**
 * Plan one global register over memory contributed by several machines.
 *
 * A physical machine may own any number of worker-backed shards. We retain at
 * least two shard-id bits where the register is large enough, matching the
 * local backend's useful parallelism floor, then increase the shard count
 * until every slice fits a WASM module and the contributed slot total can hold
 * the register. Assignment is round-robin across machines with remaining
 * slots, keeping adjacent shard ids spread out rather than filling one machine
 * before touching the next.
 */
export function planDistributedShards(
  globalQubits: number,
  participants: ExpandParticipant[],
  maxLocalQubits = 26,
): DistributedShardPlan {
  if (!Number.isInteger(globalQubits) || globalQubits < 1 || globalQubits > 52) {
    throw new RangeError(`globalQubits must be an integer from 1 to 52, got ${globalQubits}`);
  }
  const usable = participants
    .map((p) => ({ id: p.id, bytes: Math.max(0, p.memoryGiB) * GIB }))
    .filter((p) => p.id && p.bytes > 0);
  if (usable.length === 0) throw new Error('no machine has contributed memory');

  const maxMachines = Math.max(1, 2 ** Math.max(0, globalQubits - 2));
  const active = usable.slice(0, maxMachines);
  const minBits = Math.min(
    globalQubits - 1,
    Math.max(
      0,
      globalQubits - maxLocalQubits,
      globalQubits > 2 ? 2 : 1,
      Math.ceil(Math.log2(active.length * 2)),
    ),
  );
  for (let shardBits = minBits; shardBits < Math.min(globalQubits, 31); shardBits++) {
    const localQubits = globalQubits - shardBits;
    if (localQubits > maxLocalQubits) continue;
    const shards = 2 ** shardBits;
    const bytesPerShard = 2 ** localQubits * 16;
    // A participating machine always runs a local shard group, never a lone
    // module. Machines that cannot fit two slices at this size sit this run out.
    const slots = active
      .map((p) => ({ id: p.id, slots: Math.floor(p.bytes / bytesPerShard) }))
      .filter((p) => p.slots >= 2);
    if (slots.reduce((n, p) => n + p.slots, 0) < shards) continue;

    const used = new Map(slots.map((p) => [p.id, 0]));
    const assignments: ExpandShardAssignment[] = [];
    let cursor = 0;
    for (let shard = 0; shard < shards; shard++) {
      let chosen: (typeof slots)[number] | undefined;
      for (let tries = 0; tries < slots.length; tries++) {
        const candidate = slots[(cursor + tries) % slots.length];
        if ((used.get(candidate.id) ?? 0) < candidate.slots) {
          chosen = candidate;
          cursor = (cursor + tries + 1) % slots.length;
          break;
        }
      }
      if (!chosen) throw new Error('internal error assigning expand shards');
      const slot = used.get(chosen.id) ?? 0;
      used.set(chosen.id, slot + 1);
      assignments.push({ shard, participantId: chosen.id, slot });
    }
    return {
      globalQubits,
      shardBits,
      localQubits,
      shards,
      bytesPerShard,
      totalBytes: bytesPerShard * shards,
      assignments,
      slotsByParticipant: Object.fromEntries(used),
    };
  }
  const total = usable.reduce((n, p) => n + p.bytes, 0);
  throw new Error(
    `${globalQubits} qubits need ${(2 ** globalQubits * 16 / GIB).toFixed(1)} GiB; ` +
      `the room contributes ${(total / GIB).toFixed(1)} GiB in usable shard slots`,
  );
}

export function maxDistributedQubits(
  participants: ExpandParticipant[],
  maxLocalQubits = 26,
  ceiling = 52,
): number {
  let max = 0;
  for (let qubits = 1; qubits <= ceiling; qubits++) {
    try {
      planDistributedShards(qubits, participants, maxLocalQubits);
      max = qubits;
    } catch {
      // Capacity is monotonic in state bytes; once one size fails, larger
      // registers cannot recover without more contributed memory.
      if (qubits > maxLocalQubits) break;
    }
  }
  return max;
}
