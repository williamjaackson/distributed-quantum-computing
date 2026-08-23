/**
 * A shared session: one host, any number of read-only viewers whose machines
 * help take the shots.
 *
 * The design leans entirely on the engine's determinism. A run is a pure
 * function of `SharedState` (program, inputs, shots, seed, readout flag), so
 * the host never streams frames — it broadcasts those few values and every
 * viewer reproduces the identical timeline locally, then just follows the
 * host's playhead. The one thing a viewer cannot reproduce is a histogram
 * that several machines took *together*, so the merged result is broadcast
 * once per run (`SharedResult`, matched back by `runKey`).
 *
 * Work flows the other way as one RPC: the host splits the shot count and
 * asks each connected viewer for its share (`WORK_SHOTS`); the viewer runs
 * the same program with the seed it was handed and returns a flat histogram.
 * A viewer that disconnects mid-share costs redone work, never shots — the
 * runner re-takes the lost share on the host (see runner.ts).
 *
 * This class is framework-free and transport-injectable so the whole
 * host↔viewer conversation can run in a unit test over an in-memory fabric;
 * useSession.ts adapts it to React.
 */
import type { Measurement } from '../lib/types';
import type { ShotOutcome } from '../lib/types';
import type { ShardReqBody } from '../lib/shardProtocol';
import type { PlanStep } from '../lib/shardedRegister';
import type { CtrlMessage, MeshEvents } from './mesh';
import { PeerMesh } from './mesh';
import { PeerRpc, respondTo } from './rpc';
import type { SignalingEvents } from './signaling-client';
import { SignalingClient } from './signaling-client';
import type { BestShot, SharedResult, SharedStageLayout, SharedState, WorkReply, WorkRequest } from './protocol';
import { runKey, WORK_SHARD, WORK_SHOTS } from './protocol';
import { flatFromOutcomes, RESULT_OUTCOME_CAP } from './shots';

export type SessionRole = 'solo' | 'host' | 'viewer';

/** What this machine is doing for the host right now, for the UI. */
export interface WorkStatus {
  programId: string;
  shots: number;
  /** Shots completed so far (only moves for circuits that measure). */
  done: number;
  /** Circuit steps built so far. */
  step: number;
}

/** Runs one work request on this machine; wired to the runner by the app. */
export type SessionWorker = (
  req: WorkRequest,
  progress: {
    onStep(done: number): void;
    onShot(done: number, of: number): void;
    cancelled(): boolean;
  },
) => Promise<WorkReply>;

export type SessionShardWorker = (
  slot: number,
  req: ShardReqBody | { kind: 'release' },
) => Promise<unknown>;
export type SessionShardPairWorker = (
  lowSlot: number,
  highSlot: number,
  step: PlanStep,
  blocks: number,
) => Promise<number>;

// The narrow surfaces the session needs, so tests can inject an in-memory
// fabric instead of real WebSockets and RTCPeerConnections.
export interface SignalingLike {
  peerId: string | null;
  connect(): Promise<void>;
  createRoom(room?: string): void;
  joinRoom(room: string): void;
  sendSignal(to: string, data: unknown): void;
  on<K extends keyof SignalingEvents & string>(
    type: K,
    fn: (detail: SignalingEvents[K]) => void,
  ): () => void;
}

export interface MeshLike {
  connectTo(peerId: string): void;
  sendCtrl(peerId: string, message: CtrlMessage): void;
  sendBulk(peerId: string, buffer: ArrayBuffer | ArrayBufferView): number;
  connectedPeerIds?(): string[];
  on<K extends keyof MeshEvents & string>(type: K, fn: (detail: MeshEvents[K]) => void): () => void;
}

export interface SessionTransport {
  signaling(url: string): SignalingLike;
  mesh(signaling: SignalingLike, selfId: string): MeshLike;
}

const realTransport: SessionTransport = {
  signaling: (url) => new SignalingClient(url),
  mesh: (signaling, selfId) => new PeerMesh(signaling as SignalingClient, selfId),
};

/**
 * The page's own origin, `/ws` path — where the Vite dev/preview server (and
 * any production host doing the same) serves the room relay. Same origin is
 * what keeps the share link down to `?j=CODE`.
 */
export function defaultSignalUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export class Session {
  role: SessionRole = 'solo';
  room: string | null = null;
  /** The link to hand out, once hosting. */
  link: string | null = null;
  error: string | null = null;

  // Mirrored from the host, when viewing.
  shared: SharedState | null = null;
  sharedKey: string | null = null;
  layout: SharedStageLayout | null = null;
  playhead = 0;
  result: SharedResult | null = null;
  working: WorkStatus | null = null;
  /** Shots this machine has contributed to the host, over the session. */
  contributed = 0;
  hostLost = false;
  /** Memory this browser is willing to devote to Expand shard workers. */
  memoryGiB = 1;

  #transport: SessionTransport;
  #signalUrl: string | null;
  #mesh: MeshLike | null = null;
  /** Connected helpers, in a stable order so a run can index them. */
  #ready: string[] = [];
  #rpcs = new Map<string, PeerRpc>();
  #hostId: string | null = null;
  #worker: SessionWorker | null = null;
  #shardWorker: SessionShardWorker | null = null;
  #shardPairWorker: SessionShardPairWorker | null = null;
  #hostedSlots = new Set<number>();
  #capacities = new Map<string, number>();
  #bulkReady = new Map<string, ArrayBuffer>();
  #bulkWaiters = new Map<
    string,
    { resolve: (buffer: ArrayBuffer) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  #workGen = 0;
  /** Last message of each kind, replayed to peers that connect later. */
  #lastCast = new Map<string, CtrlMessage>();

  #version = 0;
  #subs = new Set<() => void>();
  #lastBump = 0;

  constructor(opts: { signalUrl?: string; transport?: SessionTransport } = {}) {
    this.#signalUrl = opts.signalUrl ?? null;
    this.#transport = opts.transport ?? realTransport;
  }

  // --- reactivity (useSyncExternalStore-shaped) ---

  subscribe = (fn: () => void): (() => void) => {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  };

  get version(): number {
    return this.#version;
  }

  #bump(): void {
    this.#version++;
    for (const fn of [...this.#subs]) fn();
  }

  /** Bump, but at most a few times a second — progress ticks arrive per shot. */
  #bumpSoon(): void {
    const now = Date.now();
    if (now - this.#lastBump < 200) return;
    this.#lastBump = now;
    this.#bump();
  }

  #signalingUrl(): string {
    return this.#signalUrl ?? defaultSignalUrl();
  }

  // --- hosting ---

  /** Create a room and start accepting viewers. */
  async share(requestedRoom?: string): Promise<void> {
    if (this.role !== 'solo') return;
    try {
      const signaling = this.#transport.signaling(this.#signalingUrl());
      await signaling.connect();
      const created = new Promise<{ room: string; peerId: string }>((resolve, reject) => {
        signaling.on('room-created', resolve);
        signaling.on('server-error', (e) => reject(new Error(e.message)));
      });
      signaling.createRoom(requestedRoom?.trim().toUpperCase());
      const { room, peerId } = await created;

      const mesh = this.#transport.mesh(signaling, peerId);
      this.#mesh = mesh;
      signaling.on('peer-joined', ({ peerId: joined }) => mesh.connectTo(joined));
      mesh.on('peer-connected', ({ peerId: id }) => {
        this.#ready.push(id);
        this.#rpcs.set(id, new PeerRpc(mesh, id));
        this.#capacities.set(id, 1);
        // A late joiner needs to know what is running right now, not wait for
        // the host to change something.
        for (const msg of this.#lastCast.values()) {
          try {
            mesh.sendCtrl(id, msg);
          } catch {
            break; // already gone again; the disconnect event cleans up
          }
        }
        this.#bump();
      });
      mesh.on('ctrl-message', ({ peerId: from, message }) => this.#onCtrl(from, message));
      mesh.on('bulk-message', (detail) => this.#onBulk(detail));
      mesh.on('peer-disconnected', ({ peerId: id }) => {
        this.#ready = this.#ready.filter((p) => p !== id);
        this.#rpcs.get(id)?.rejectAllPending(new Error(`the machine helping with this share disconnected`));
        this.#rpcs.delete(id);
        this.#capacities.delete(id);
        this.#dropBulkPeer(id);
        this.#bump();
      });

      this.role = 'host';
      this.room = room;
      this.link =
        typeof location === 'undefined'
          ? `?j=${room}`
          : `${location.origin}${location.pathname}?j=${room}`;
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.#bump();
  }

  /** Connected helpers available to take shot shares right now. */
  workers(): number {
    return this.role === 'host' ? this.#ready.length : 0;
  }

  setMemoryGiB(value: number): void {
    this.memoryGiB = Math.min(16, Math.max(0.25, value));
    if (this.role === 'viewer' && this.#mesh) {
      for (const id of this.#mesh.connectedPeerIds?.() ?? []) {
        try {
          this.#mesh.sendCtrl(id, { t: 'capacity', memoryGiB: this.memoryGiB });
        } catch {
          // A closing channel will be removed by its disconnect event.
        }
      }
    }
    this.#bump();
  }

  expandParticipants(): Array<{ id: string; worker: number | null; memoryGiB: number }> {
    if (this.role !== 'host') return [];
    return [
      { id: 'host', worker: null, memoryGiB: this.memoryGiB },
      ...this.#ready.map((id, worker) => ({
        id,
        worker,
        memoryGiB: this.#capacities.get(id) ?? 1,
      })),
    ];
  }

  /** Ask helper `worker` (an index into the current helpers) for shots. */
  runShots(worker: number, req: WorkRequest): Promise<WorkReply> {
    const id = this.#ready[worker];
    const rpc = id === undefined ? undefined : this.#rpcs.get(id);
    if (!rpc) return Promise.reject(new Error('helper left before starting'));
    return rpc.call<WorkReply>(WORK_SHOTS, req as unknown as Record<string, unknown>);
  }

  /** Execute a shard command on one slot owned by a connected helper. */
  async runShard(worker: number, slot: number, req: ShardReqBody): Promise<unknown> {
    const peerId = this.#ready[worker];
    const rpc = peerId === undefined ? undefined : this.#rpcs.get(peerId);
    if (!peerId || !rpc || !this.#mesh) throw new Error('expand helper left before the shard command');

    if (req.kind === 'exportBlock') {
      const reply = await rpc.call<{ bulkTransferId: number }>(WORK_SHARD, { slot, req });
      const buffer = await this.#waitBulk(peerId, reply.bulkTransferId);
      return new Float64Array(buffer);
    }

    if (req.kind === 'importApply' || req.kind === 'importDot') {
      const bulkTransferId = this.#mesh.sendBulk(peerId, req.buffer);
      const { buffer: _buffer, ...withoutBuffer } = req;
      return rpc.call(WORK_SHARD, { slot, req: withoutBuffer, bulkTransferId });
    }
    return rpc.call(WORK_SHARD, { slot, req });
  }

  releaseRemoteShard(worker: number, slot: number): void {
    const peerId = this.#ready[worker];
    const rpc = peerId === undefined ? undefined : this.#rpcs.get(peerId);
    if (rpc) void rpc.call(WORK_SHARD, { slot, req: { kind: 'release' } }).catch(() => {});
  }

  runShardPair(
    worker: number,
    lowSlot: number,
    highSlot: number,
    step: PlanStep,
    blocks: number,
  ): Promise<number> {
    const peerId = this.#ready[worker];
    const rpc = peerId === undefined ? undefined : this.#rpcs.get(peerId);
    if (!rpc) return Promise.reject(new Error('expand helper left before the local shard exchange'));
    return rpc.call<number>(WORK_SHARD, { pair: { lowSlot, highSlot, step, blocks } });
  }

  get hostedShards(): number {
    return this.#hostedSlots.size;
  }

  /** Broadcast what is running. Returns the run's key, for `broadcastResult`. */
  broadcastState(state: SharedState): string {
    const key = runKey(state);
    this.#cast({ t: 'state', key, state: state as unknown as Record<string, unknown> });
    return key;
  }

  broadcastLayout(layout: SharedStageLayout): void {
    this.#cast({ t: 'layout', layout: layout as unknown as Record<string, unknown> });
  }

  broadcastPlayhead(index: number): void {
    this.#cast({ t: 'playhead', index });
  }

  /** Broadcast the merged measurement of the run identified by `key`. */
  broadcastResult(
    key: string,
    outcomes: ShotOutcome[],
    measurement: Measurement,
    bestShot: BestShot,
  ): void {
    let shared = measurement;
    if (outcomes.length > RESULT_OUTCOME_CAP) {
      const capNote = `viewers see the top ${RESULT_OUTCOME_CAP.toLocaleString()} of ${outcomes.length.toLocaleString()} distinct outcomes`;
      shared = { ...measurement, note: measurement.note ? `${measurement.note} — ${capNote}` : capNote };
    }
    const result: SharedResult = {
      key,
      flat: flatFromOutcomes(outcomes, RESULT_OUTCOME_CAP),
      measurement: shared,
      bestShot,
    };
    this.#cast({ t: 'result', result: result as unknown as Record<string, unknown> });
  }

  #cast(msg: CtrlMessage): void {
    if (this.role !== 'host' || !this.#mesh) return;
    this.#lastCast.set(msg.t as string, msg);
    for (const id of this.#ready) {
      try {
        this.#mesh.sendCtrl(id, msg);
      } catch {
        // A channel that just closed tears down via the mesh's own events;
        // nothing to do here beyond not letting one peer block the rest.
      }
    }
  }

  // --- viewing ---

  /** The machine-side of a viewer: how a work request actually runs. */
  setWorker(fn: SessionWorker): void {
    this.#worker = fn;
  }

  /** Join a room read-only and start helping. */
  async join(room: string): Promise<void> {
    if (this.role !== 'solo') return;
    this.role = 'viewer';
    this.room = room;
    this.#bump();
    try {
      const signaling = this.#transport.signaling(this.#signalingUrl());
      await signaling.connect();
      const joined = new Promise<{ peerId: string; peers: { peerId: string }[] }>(
        (resolve, reject) => {
          signaling.on('joined', resolve);
          signaling.on('join-failed', ({ reason }) =>
            reject(new Error(`could not join room ${room} — ${reason}`)),
          );
          signaling.on('server-error', (e) => reject(new Error(e.message)));
        },
      );
      signaling.joinRoom(room);
      const { peerId, peers } = await joined;

      const mesh = this.#transport.mesh(signaling, peerId);
      this.#mesh = mesh;
      for (const p of peers) mesh.connectTo(p.peerId);
      signaling.on('peer-joined', ({ peerId: id }) => mesh.connectTo(id));
      mesh.on('ctrl-message', ({ peerId: from, message }) => this.#onCtrl(from, message));
      mesh.on('bulk-message', (detail) => this.#onBulk(detail));
      mesh.on('peer-connected', ({ peerId: id }) => {
        try {
          mesh.sendCtrl(id, { t: 'capacity', memoryGiB: this.memoryGiB });
        } catch {
          // disconnect handling below owns the state transition
        }
      });
      mesh.on('peer-disconnected', ({ peerId: id }) => {
        this.#dropBulkPeer(id);
        if (id === this.#hostId) {
          this.hostLost = true;
          this.#bump();
        }
      });
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.#bump();
  }

  #onCtrl(from: string, message: CtrlMessage): void {
    if (message.id !== undefined && typeof message.t === 'string') {
      // An RPC request. Only the host issues these, which is also how a
      // viewer learns who the host is without a role handshake.
      this.#hostId = from;
      this.hostLost = false;
      void respondTo(
        (reply) => {
          try {
            this.#mesh?.sendCtrl(from, reply);
          } catch {
            // The host vanished mid-share; it re-takes the work itself.
          }
        },
        message,
        (t, args) => {
          if (t === WORK_SHOTS) return this.#runWork(args as unknown as WorkRequest);
          if (t === WORK_SHARD) return this.#runShardWork(from, args);
          throw new Error(`unknown request '${t}'`);
        },
      );
      return;
    }
    if (message.id !== undefined) return; // an RPC reply; PeerRpc's business

    switch (message.t) {
      case 'state':
        this.#hostId = from;
        this.hostLost = false;
        this.shared = message.state as unknown as SharedState;
        this.sharedKey = message.key as string;
        break;
      case 'capacity':
        if (this.role !== 'host') return;
        this.#capacities.set(from, Math.min(16, Math.max(0.25, Number(message.memoryGiB) || 1)));
        break;
      case 'layout':
        this.layout = message.layout as unknown as SharedStageLayout;
        break;
      case 'playhead':
        this.playhead = message.index as number;
        break;
      case 'result':
        this.result = message.result as unknown as SharedResult;
        break;
      default:
        return;
    }
    this.#bump();
  }

  setShardWorker(fn: SessionShardWorker): void {
    this.#shardWorker = fn;
  }

  setShardPairWorker(fn: SessionShardPairWorker): void {
    this.#shardPairWorker = fn;
  }

  async #runShardWork(from: string, args: Record<string, unknown>): Promise<unknown> {
    if (args.pair) {
      const pair = args.pair as {
        lowSlot: number;
        highSlot: number;
        step: PlanStep;
        blocks: number;
      };
      if (!this.#shardPairWorker) throw new Error('no local expand exchange runtime ready');
      return this.#shardPairWorker(pair.lowSlot, pair.highSlot, pair.step, pair.blocks);
    }
    const worker = this.#shardWorker;
    if (!worker || !this.#mesh) throw new Error('no expand shard runtime ready on this machine');
    const slot = Number(args.slot);
    let req = args.req as unknown as ShardReqBody | { kind: 'release' };
    if (args.bulkTransferId !== undefined && (req.kind === 'importApply' || req.kind === 'importDot')) {
      const buffer = await this.#waitBulk(from, Number(args.bulkTransferId));
      req = { ...req, buffer } as ShardReqBody;
    }
    const result = await worker(slot, req);
    if (req.kind === 'init') this.#hostedSlots.add(slot);
    if (req.kind === 'release') this.#hostedSlots.delete(slot);
    if (req.kind === 'init' || req.kind === 'release') this.#bump();
    if (req.kind === 'exportBlock') {
      const view = result as ArrayBufferView;
      const bulkTransferId = this.#mesh.sendBulk(from, view);
      return { bulkTransferId };
    }
    return ArrayBuffer.isView(result) ? Array.from(result as unknown as ArrayLike<number>) : result;
  }

  #bulkKey(peerId: string, transferId: number): string {
    return `${peerId}:${transferId}`;
  }

  #onBulk({ peerId, transferId, buffer }: { peerId: string; transferId: number; buffer: ArrayBuffer }): void {
    const key = this.#bulkKey(peerId, transferId);
    const waiter = this.#bulkWaiters.get(key);
    if (waiter) {
      this.#bulkWaiters.delete(key);
      clearTimeout(waiter.timer);
      waiter.resolve(buffer);
    } else {
      this.#bulkReady.set(key, buffer);
    }
  }

  #waitBulk(peerId: string, transferId: number): Promise<ArrayBuffer> {
    const key = this.#bulkKey(peerId, transferId);
    const ready = this.#bulkReady.get(key);
    if (ready) {
      this.#bulkReady.delete(key);
      return Promise.resolve(ready);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#bulkWaiters.delete(key);
        reject(new Error(`timed out waiting for expand block ${transferId} from ${peerId}`));
      }, 30_000);
      this.#bulkWaiters.set(key, { resolve, reject, timer });
    });
  }

  #dropBulkPeer(peerId: string): void {
    for (const [key, waiter] of this.#bulkWaiters) {
      if (!key.startsWith(`${peerId}:`)) continue;
      clearTimeout(waiter.timer);
      waiter.reject(new Error('peer disconnected during an expand block transfer'));
      this.#bulkWaiters.delete(key);
    }
  }

  async #runWork(req: WorkRequest): Promise<WorkReply> {
    const worker = this.#worker;
    if (!worker) throw new Error('no engine ready on this machine yet');
    // Latest wins: a newer request from the host supersedes whatever share
    // this machine was still working through (the host has already stopped
    // caring about the old run).
    const gen = ++this.#workGen;
    this.working = { programId: req.programId, shots: req.shots, done: 0, step: 0 };
    this.#bump();
    try {
      const reply = await worker(req, {
        onStep: (done) => {
          if (gen !== this.#workGen || !this.working) return;
          this.working = { ...this.working, step: done };
          this.#bumpSoon();
        },
        onShot: (done) => {
          if (gen !== this.#workGen || !this.working) return;
          this.working = { ...this.working, done };
          this.#bumpSoon();
        },
        cancelled: () => gen !== this.#workGen,
      });
      this.contributed += reply.taken;
      return reply;
    } finally {
      if (gen === this.#workGen) this.working = null;
      this.#bump();
    }
  }
}
