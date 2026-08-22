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
import { GATE_PARAMS, gateArity, GATE_CONTROLS } from './steps';
import type {
  Classical,
  Frame,
  InputValues,
  Measurement,
  Program,
  ShotOutcome,
  Step,
  Timeline,
} from './types';

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

/**
 * Amplitude visits allowed for taking shots of a circuit that measures.
 *
 * Such a circuit collapses differently every run, so N shots means running it N
 * times — there is no shortcut, and `shots x gates x 2^n` grows fast. When the
 * budget cannot afford the shots asked for, fewer are taken and the timeline
 * says so; a quietly reduced shot count would make the answer look more certain
 * than it is.
 */
export const SHOT_BUDGET = 4e8;

/** Shot counts the UI offers. */
export const SHOT_OPTIONS = [128, 1024, 8192, 65536];

/**
 * Seed for one shot's measurement draws.
 *
 * Derived from the shot index rather than taken from the user, so the same
 * inputs always give the same answer and "shot 7" is always the same run. A
 * seed control would be asking the reader to manage the thing shots exist to
 * average away.
 */
function seedFor(shot: number): number {
  return (0x5eed + Math.imul(shot, 0x9e3779b1)) >>> 0;
}

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
  if (GATE_CONTROLS[step.name] === undefined) {
    throw new Error(`unknown gate '${step.name}'`);
  }
  const arity = gateArity(step.name);
  if (arity !== null && step.qubits.length !== arity) {
    throw new Error(`gate '${step.name}' takes ${arity} qubit(s), got ${step.qubits.length}`);
  }
  // A variadic gate needs at least one control and a target, which is the one
  // arity mistake its name cannot rule out.
  if (arity === null && step.qubits.length < 2) {
    throw new Error(`gate '${step.name}' needs a control and a target`);
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
  /** How many times to measure the circuit. */
  shots: number;
  /** Which shot the recorded frames should be. */
  shotIndex: number;
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
  options: RunOptions,
): Promise<Timeline> {
  const { execution, unlocked, shots, shotIndex, onProgress, cancelled } = options;
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
    backend = await createBackend(nQubits, seedFor(shotIndex), execution);
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
  // The answer. A state vector is not a result: what a program produces is what
  // comes back when you measure it, so every run is measured.
  let outcomes: ShotOutcome[] = [];
  let measurement: Measurement = { requested: shots, taken: 0, method: 'sampled' };
  if (backend && !error) {
    try {
      const collapses = steps.filter((s) => s.kind === 'measure').length;
      const result = collapses === 0
        ? await sampleOnce(backend, shots)
        : await repeatRun(backend, program, values, steps.length, nQubits, shots, cancelled);
      outcomes = result.outcomes;
      measurement = result.measurement;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
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
    shotIndex,
    nQubits,
    amplitudeCount: 2 ** nQubits,
    wireLabels,
    steps,
    frames,
    backend: info,
    // What the frames actually hold, not what was asked for. A backend is
    // allowed to decline: the sharded path has no cross-shard two-qubit reduced
    // matrix, so it returns no links however affordable the budget said they were.
    shots: outcomes,
    measurement,
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

// ---------------------------------------------------------------------------
// Taking the shots
// ---------------------------------------------------------------------------

interface Ensemble {
  outcomes: ShotOutcome[];
  measurement: Measurement;
}

function ranked(counts: Map<number, number>): ShotOutcome[] {
  return [...counts]
    .map(([index, count]) => ({ index, count }))
    .sort((a, b) => b.count - a.count || a.index - b.index);
}

/**
 * Shots of a circuit that never measures.
 *
 * Every shot shares the same final state, so the engine's sampler draws all of
 * them from it in one pass. Exact, and no more expensive for a million shots
 * than for one.
 */
async function sampleOnce(backend: Backend, shots: number): Promise<Ensemble> {
  const counts = await backend.sample(shots, seedFor(0));
  return {
    outcomes: ranked(counts),
    measurement: { requested: shots, taken: shots, method: 'sampled' },
  };
}

/**
 * Shots of a circuit that measures, by running it again per shot.
 *
 * There is no shortcut here: a mid-circuit measurement collapses the state, a
 * later gate can depend on the outcome, and so each shot is a different run.
 * Frames are not recorded for these — that is what makes it affordable — and
 * the register is reset rather than reallocated.
 */
async function repeatRun(
  backend: Backend,
  program: Program,
  values: InputValues,
  gates: number,
  nQubits: number,
  shots: number,
  cancelled?: () => boolean,
): Promise<Ensemble> {
  const perShot = Math.max(1, gates) * 2 ** nQubits;
  const affordable = Math.max(1, Math.floor(SHOT_BUDGET / perShot));
  const taken = Math.min(shots, affordable);
  const counts = new Map<number, number>();
  const bits: Record<string, number> = {};
  const cl: Classical = {
    get: (bit) => bits[bit],
    bit: (name) => bits[name] ?? 0,
    all: () => ({ ...bits }),
  };

  for (let shot = 0; shot < taken; shot++) {
    if (cancelled?.()) break;
    await backend.reset(seedFor(shot));
    for (const key of Object.keys(bits)) delete bits[key];
    for (const step of program.build(values, cl)) {
      if (step.kind === 'measure') bits[step.bit] = await backend.measure(step.qubit);
      else await backend.applyGate(step.name, step.qubits, step.params);
    }
    // One draw of whatever is left undetermined. A measured qubit is already
    // collapsed, so this reads the register the way a machine would.
    for (const [index, count] of await backend.sample(1, seedFor(shot ^ 0x5f5e1))) {
      counts.set(index, (counts.get(index) ?? 0) + count);
    }
  }

  return {
    outcomes: ranked(counts),
    measurement: {
      requested: shots,
      taken,
      method: 'repeated',
      note:
        taken < shots
          ? `this circuit measures, so each shot is a separate run — ${taken.toLocaleString()} of them fits the budget`
          : undefined,
    },
  };
}

export { TOP_K };
