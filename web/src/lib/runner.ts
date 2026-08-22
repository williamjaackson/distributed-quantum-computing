/**
 * Running a program and recording what the engine did at every step.
 *
 * Each step is executed once, in order, against whichever backend is holding
 * the register, and a summary is taken afterwards. Scrubbing the timeline
 * replays those recorded summaries rather than re-running gates, so stepping
 * backwards is exact even across a measurement — which is irreversible and
 * could not be undone by inverting gates.
 *
 * How much detail a frame keeps is a budget decision, and the only reason there
 * is a qubit ceiling at all:
 *
 * * Below [`AMPS_QUBIT_LIMIT`] every frame keeps the whole amplitude array, so
 *   every view is exact and the state-vector chart draws one mark per basis
 *   state.
 * * Above it, frames keep the Bloch vectors, the largest amplitudes and the
 *   correlation matrix. That is everything the views actually draw, at
 *   kilobytes a frame instead of megabytes, and it is what lets the register go
 *   as far as the engine can take it.
 */
import type { Backend, EngineLimits, Execution } from './backend';
import { createBackend, engineLimits, loadWasm, TOP_K } from './backend';
import { GATE_CONTROLS, GATE_PARAMS } from './steps';
import type { Classical, Frame, InputValues, Program, Step, Timeline } from './types';

/**
 * Largest register for which every frame keeps a full copy of the state.
 *
 * 14 qubits is 16384 amplitudes — 256 KiB a frame, so a few hundred steps costs
 * tens of megabytes. One more qubit doubles it.
 */
export const AMPS_QUBIT_LIMIT = 14;

/**
 * Amplitude visits allowed per frame for the correlation matrix.
 *
 * Every pair costs one pass over the state, so all pairs is `O(n^2 * 2^n)`.
 * 1.5e8 keeps a frame under roughly a tenth of a second and works out to about
 * 19 qubits, past which the qubit map shows its dials without links and says so.
 */
export const LINK_BUDGET = 1.5e8;

/** Backstop against a program whose generator never terminates. */
export const MAX_STEPS = 2048;

export function keepAmplitudes(nQubits: number, limits: EngineLimits): boolean {
  return nQubits <= Math.min(AMPS_QUBIT_LIMIT, limits.fullArrayLimit);
}

export function computeLinks(nQubits: number): boolean {
  const pairs = (nQubits * (nQubits - 1)) / 2;
  return pairs > 0 && pairs * 2 ** nQubits <= LINK_BUDGET;
}

/**
 * Largest register that stays comfortable to step through.
 *
 * Not an engine limit — measured cost. The per-step summary is a pass over the
 * state per qubit, so it grows as `n * 2^n`: about 10 ms a step at 16 qubits,
 * 60 ms at 22, and a quarter of a second at 24. 22 is the last size where
 * pressing play still feels like playback.
 */
export const INTERACTIVE_QUBITS = 22;

/**
 * Guard rail on a sharded run, in qubits.
 *
 * Sharding removes the engine's ceiling — capacity becomes the machine's memory
 * — which means nothing stops a stray click from asking for more RAM than the
 * machine has and taking the tab down with it. 30 qubits is 16 GiB.
 */
export const SHARDED_CEILING = 30;

/**
 * Largest register the visualiser will attempt.
 *
 * `limits` is passed in rather than read here, because the engine's own numbers
 * are only knowable once the module has loaded and this is called during the
 * first render. A null `limits` means "not known yet", which resolves to the
 * interactive ceiling — the one value that is safe without asking the engine.
 */
export function ceiling(
  execution: Execution,
  unlocked: boolean,
  limits: EngineLimits | null,
): number {
  if (!unlocked || !limits) return INTERACTIVE_QUBITS;
  return execution === 'whole' ? limits.maxWholeState : SHARDED_CEILING;
}

function validate(step: Step, nQubits: number): void {
  if (step.kind === 'measure') {
    if (step.qubit < 0 || step.qubit >= nQubits) {
      throw new Error(`measure on qubit ${step.qubit}, register has ${nQubits}`);
    }
    return;
  }
  const controls = GATE_CONTROLS[step.name];
  if (controls === undefined) throw new Error(`unknown gate '${step.name}'`);
  const arity = step.name === 'swap' ? 2 : controls + 1;
  if (step.qubits.length !== arity) {
    throw new Error(`gate '${step.name}' takes ${arity} qubit(s), got ${step.qubits.length}`);
  }
  const wanted = GATE_PARAMS[step.name] ?? 0;
  if (step.params.length !== wanted) {
    throw new Error(`gate '${step.name}' takes ${wanted} angle(s), got ${step.params.length}`);
  }
  for (const q of step.qubits) {
    if (q < 0 || q >= nQubits) {
      throw new Error(`gate '${step.name}' touches qubit ${q}, register has ${nQubits}`);
    }
  }
}

export interface RunOptions {
  execution: Execution;
  /** Allow the engine's full ceiling instead of the interactive one. */
  unlocked: boolean;
  /** Called as steps complete, so a long run can show progress. */
  onProgress?: (done: number) => void;
  /** Checked between steps; a true return abandons the run. */
  cancelled?: () => boolean;
}

/**
 * Execute `program` from |00…0> and record a summary after every step.
 *
 * Nothing is thrown: a program that asks for an impossible gate produces a
 * timeline holding everything that ran before the failure plus the message, so
 * the visualiser can show exactly how far the engine got.
 */
export async function runProgram(
  program: Program,
  values: InputValues,
  seed: number,
  options: RunOptions,
): Promise<Timeline> {
  const { execution, unlocked, onProgress, cancelled } = options;
  // Every limit below comes from the engine, so the module has to be up first.
  await loadWasm();
  const limits = engineLimits();
  const requested = program.qubits(values);
  const max = ceiling(execution, unlocked, limits);
  const nQubits = Math.max(1, Math.min(max, requested));
  const wireLabels =
    program.wireLabels?.(values) ?? Array.from({ length: nQubits }, (_, i) => `q${i}`);

  const want = { amps: keepAmplitudes(nQubits, limits), links: computeLinks(nQubits) };
  const steps: Step[] = [];
  const frames: Frame[] = [];
  const bits: Record<string, number> = {};
  let error: string | undefined;
  if (requested > max) {
    error = `${requested} qubits exceeds this run's ceiling of ${max}`;
  }

  const cl: Classical = {
    get: (bit) => bits[bit],
    bit: (name) => bits[name] ?? 0,
    all: () => ({ ...bits }),
  };

  let backend: Backend | null = null;
  const started = performance.now();
  try {
    backend = await createBackend(nQubits, seed, execution);
    frames.push(await snapshot(backend, 0, bits, want));

    if (!error) {
      for (const step of program.build(values, cl)) {
        if (steps.length >= MAX_STEPS) {
          error = `stopped at the ${MAX_STEPS}-step limit`;
          break;
        }
        if (cancelled?.()) {
          error = 'run abandoned';
          break;
        }
        validate(step, nQubits);
        if (step.kind === 'measure') {
          bits[step.bit] = await backend.measure(step.qubit);
        } else {
          await backend.applyGate(step.name, step.qubits, step.params);
        }
        steps.push(step);
        frames.push(await snapshot(backend, steps.length, bits, want));
        onProgress?.(steps.length);
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const elapsedMs = performance.now() - started;

  const info = {
    description: backend?.description ?? 'not started',
    sharded: backend?.sharded ?? false,
    shards: backend?.shards ?? 1,
    exchangedBlocks: exchanged(backend),
  };
  backend?.dispose();

  // A run that failed before its first snapshot still needs one frame, or every
  // view would have to special-case an empty timeline.
  if (frames.length === 0) {
    frames.push({
      index: 0,
      norm: 0,
      bits: {},
      bloch: new Float64Array(3 * nQubits),
      top: new Float64Array(0),
      topTruncated: false,
      amps: null,
      links: null,
    });
  }

  return {
    program,
    values,
    seed,
    nQubits,
    amplitudeCount: 2 ** nQubits,
    wireLabels,
    steps,
    frames,
    backend: info,
    // What the frames actually hold, not what was asked for. A backend is
    // allowed to decline: the sharded path has no cross-shard two-qubit reduced
    // matrix, so it returns no links however affordable the budget said they were.
    detail: {
      amps: frames[0].amps !== null,
      links: frames[0].links !== null,
      /** Why links are missing, when they are. */
      linksReason: frames[0].links !== null ? null : want.links ? 'sharded' : 'cost',
    },
    elapsedMs,
    error,
  };
}

function exchanged(backend: Backend | null): number {
  return backend && 'exchangedBlocks' in backend
    ? (backend as { exchangedBlocks: number }).exchangedBlocks
    : 0;
}

async function snapshot(
  backend: Backend,
  index: number,
  bits: Record<string, number>,
  want: { amps: boolean; links: boolean },
): Promise<Frame> {
  const s = await backend.snapshot(want);
  return {
    index,
    norm: s.norm,
    bits: { ...bits },
    bloch: s.bloch,
    top: s.top,
    topTruncated: s.topTruncated,
    amps: s.amps,
    links: s.links,
  };
}

/**
 * Draw `shots` samples of the state as it stands after `upto` steps, using the
 * engine's own sampler.
 *
 * A recorded frame is a summary, not a state, and no backend has a "load this
 * state" entry point — nothing the engine does needs one. So this replays the
 * program to that step on a fresh register and samples there, which keeps the
 * sampling inside the engine instead of reimplemented over the recorded top-k.
 * The cost is a second run, which is why the Shots view asks before doing it on
 * anything large.
 */
export async function sampleAt(
  timeline: Timeline,
  upto: number,
  shots: number,
  sampleSeed: number,
  execution: Execution,
): Promise<Map<number, number>> {
  const backend = await createBackend(timeline.nQubits, timeline.seed, execution);
  try {
    for (let i = 0; i < upto && i < timeline.steps.length; i++) {
      const step = timeline.steps[i];
      if (step.kind === 'measure') await backend.measure(step.qubit);
      else await backend.applyGate(step.name, step.qubits, step.params);
    }
    return await backend.sample(shots, sampleSeed);
  } finally {
    backend.dispose();
  }
}

export { TOP_K };
