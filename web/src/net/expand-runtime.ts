import type { Backend, ShardLayout } from '../lib/backend';
import type { ShardReqBody } from '../lib/shardProtocol';
import { ShardHandle, ShardedRegister } from '../lib/shardedRegister';
import type { PlanStep, ShardTransport } from '../lib/shardedRegister';
import type { Session } from './session';
import { planDistributedShards } from './expand-plan';

/** Worker-backed shard slots contributed by this browser to a remote host. */
export class ExpandShardPool {
  #handles = new Map<number, ShardHandle>();

  async run(slot: number, req: ShardReqBody | { kind: 'release' }): Promise<unknown> {
    if (req.kind === 'release') {
      this.#handles.get(slot)?.terminate();
      this.#handles.delete(slot);
      return null;
    }
    if (req.kind === 'init') {
      this.#handles.get(slot)?.terminate();
      const handle = new ShardHandle(req.index);
      this.#handles.set(slot, handle);
      return handle.send(req);
    }
    const handle = this.#handles.get(slot);
    if (!handle) throw new Error(`expand shard slot ${slot} is not initialised`);
    return handle.send(req, 'buffer' in req ? [req.buffer] : undefined);
  }

  async exchange(lowSlot: number, highSlot: number, step: PlanStep, blocks: number): Promise<number> {
    const low = this.#handles.get(lowSlot);
    const high = this.#handles.get(highSlot);
    if (!low || !high) throw new Error('one of the local expand shard slots is not initialised');
    for (let block = 0; block < blocks; block++) {
      const [lowBlock, highBlock] = await Promise.all([
        low.send<Float64Array>({ kind: 'exportBlock', block }),
        high.send<Float64Array>({ kind: 'exportBlock', block }),
      ]);
      await Promise.all([
        low.send(
          {
            kind: 'importApply',
            block,
            isLow: true,
            base: step.base,
            params: step.params,
            localCmask: step.localCmask,
            buffer: highBlock.buffer as ArrayBuffer,
          },
          [highBlock.buffer],
        ),
        high.send(
          {
            kind: 'importApply',
            block,
            isLow: false,
            base: step.base,
            params: step.params,
            localCmask: step.localCmask,
            buffer: lowBlock.buffer as ArrayBuffer,
          },
          [lowBlock.buffer],
        ),
      ]);
    }
    return blocks * 2;
  }

  dispose(): void {
    for (const handle of this.#handles.values()) handle.terminate();
    this.#handles.clear();
  }
}

class RemoteShardTransport implements ShardTransport {
  readonly owner: string;

  constructor(
    readonly index: number,
    private session: Session,
    private worker: number,
    private slot: number,
    participantId: string,
  ) {
    this.owner = participantId;
  }

  send<T>(req: ShardReqBody): Promise<T> {
    return this.session.runShard(this.worker, this.slot, req) as Promise<T>;
  }

  terminate(): void {
    this.session.releaseRemoteShard(this.worker, this.slot);
  }

  exchangeWith(partner: ShardTransport, step: PlanStep, blocks: number): Promise<number> {
    if (!(partner instanceof RemoteShardTransport) || partner.worker !== this.worker) {
      return Promise.reject(new Error('remote shards do not share one machine'));
    }
    return this.session.runShardPair(this.worker, this.slot, partner.slot, step, blocks);
  }
}

/** Build a single state vector whose worker shards span all contributing machines. */
export async function createDistributedBackend(
  nQubits: number,
  seed: number,
  session: Session,
): Promise<Backend> {
  const participants = session.expandParticipants();
  const plan = planDistributedShards(
    nQubits,
    participants.map(({ id, memoryGiB }) => ({ id, memoryGiB })),
  );
  const byId = new Map(participants.map((p) => [p.id, p]));
  const handles: ShardTransport[] = plan.assignments.map((assignment) => {
    const participant = byId.get(assignment.participantId);
    if (!participant) throw new Error(`expand participant ${assignment.participantId} disappeared`);
    return participant.worker === null
      ? new ShardHandle(assignment.shard)
      : new RemoteShardTransport(
          assignment.shard,
          session,
          participant.worker,
          assignment.slot,
          assignment.participantId,
        );
  });
  const layout: ShardLayout = {
    globalQubits: plan.globalQubits,
    shardBits: plan.shardBits,
    localQubits: plan.localQubits,
    shards: plan.shards,
    bytesPerShard: plan.bytesPerShard,
    totalBytes: plan.totalBytes,
  };
  return ShardedRegister.createWithTransports(layout, seed, handles);
}
