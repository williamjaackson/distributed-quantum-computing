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
import type { Backend, EngineLimits } from './backend';
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
 * Seed for one shot of a run, derived from the run's own seed.
 *
 * The run seed is *not* derived from anything: it comes from the caller, which
 * rolls a fresh one whenever a new measurement is asked for. An earlier version
 * derived it from a fixed index in the name of reproducibility, and the result
 * was a coin flip that came up heads every single time — the one thing a coin
 * flip must not do. Shots within a run are still derived, so the histogram is
 * stable while you read it.
 */
function seedFor(run: number, shot: number): number {
  return (run + Math.imul(shot + 1, 0x9e3779b1)) >>> 0;
}

export function keepAmplitudes(nQubits: number, limits: EngineLimits): boolean {
  return nQubits <= Math.min(AMPS_QUBIT_LIMIT, limits.fullArrayLimit);
}

export function computeLinks(nQubits: number): boolean {
  const pairs = (nQubits * (nQubits - 1)) / 2;
  return pairs > 0 && pairs * 2 ** nQubits <= LINK_BUDGET;
}

/**
 * Largest register the visualiser will attempt, in qubits.
 *
 * Everything runs sharded, so this is not an engine limit: a shard holds 26
 * qubits and K shards hold K times as much, which puts the real ceiling at the
 * machine's memory. 30 qubits is 16 shards of 1 GiB.
 *
 * It is a guard rail, not a recommendation. Cost grows as `n * 2^n` per step
 * because the summary is a pass over the state per qubit — about 10 ms a step at
 * 16 qubits, 60 ms at 22, a quarter of a second at 24, and tens of seconds by
 * 28. Past the low twenties this stops being playback and becomes a batch job
 * with a progress line, which is worth doing and worth knowing about.
 */
export const CEILING = 30;

export function ceiling(): number {
  return CEILING;
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
  /** How many times to measure the circuit. */
  shots: number;
  /**
   * Seed for this run's measurements.
   *
   * A fresh one means a fresh draw. The caller decides when that happens —
   * pressing Measure again should give a different answer, changing an input
   * should not.
   */
  seed: number;
  /**
   * Which outcome a readout should land on.
   *
   * `draw` measures, which is what a machine does. `best` replays the
   * best-scoring shot — legitimate, because you did take those shots and keeping
   * the best of them is how a sampling algorithm is used, but it is a selection
   * among draws rather than a measurement, so it says so.
   */
  readoutSource: 'draw' | 'best';
  /**
   * Read every qubit out at the end, collapsing the register.
   *
   * Off by default, because a readout is not part of an algorithm: it is the act
   * of looking, it destroys the superposition, and most of these programs end
   * with the interesting thing still in one. So it is something you ask for,
   * after the circuit has finished.
   */
  measureAtEnd: boolean;
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
  const { shots, seed, measureAtEnd, readoutSource } = options;
  const { onProgress, cancelled } = options;
  // Every limit below comes from the engine, so the module has to be up first.
  await loadWasm();
  const limits = engineLimits();
  const requested = program.qubits(values);
  const max = ceiling();
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
    backend = await createBackend(nQubits, seedFor(seed, 0));
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
  //
  // Taken here, at the end of the *circuit*, before any readout is appended —
  // and not as an optimisation. Reading every qubit out at the end is precisely
  // what sampling the final state models, so appending one cannot change the
  // distribution; sampling after it would collapse the answer to one draw.
  const circuitSteps = steps.length;
  let outcomes: ShotOutcome[] = [];
  let measurement: Measurement = { requested: shots, taken: 0, method: 'sampled' };
  const collapses = steps.filter((s) => s.kind === 'measure').length;
  if (backend && !error) {
    try {
      const result =
        collapses === 0
          ? await sampleOnce(backend, shots, seed)
          : await repeatRun(backend, program, values, steps.length, nQubits, shots, seed, cancelled);
      outcomes = result.outcomes;
      measurement = result.measurement;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // Rank the shots, if the program says what better means. The best one is
  // usually not the likeliest, which is the whole reason a sampling algorithm
  // takes more than one.
  let bestShot: Timeline['bestShot'] = null;
  if (program.score) {
    outcomes.forEach((o, rank) => {
      const score = program.score!(o.index, values);
      if (score === null || !Number.isFinite(score)) return;
      if (!bestShot || score < bestShot.score) {
        bestShot = { index: o.index, score, count: o.count, rank: rank + 1 };
      }
    });
  }

  // The readout, if asked for: every qubit in turn, so the collapse is something
  // you watch rather than a single jump. A qubit already definite does not move,
  // and an entangled partner moves without being touched.
  let readout: number | null = null;
  const readoutBits: string[] = [];
  const replay: number | null =
    readoutSource === 'best' && bestShot !== null ? (bestShot as { index: number }).index : null;
  if (backend && !error && measureAtEnd) {
    try {
      // `repeatRun` reset the register to take its shots, so put the trajectory
      // back. The same seed reproduces the run the frames recorded.
      if (collapses > 0) {
        await backend.reset(seedFor(seed, 0));
        const replay: Record<string, number> = {};
        const cl2: Classical = {
          get: (b) => replay[b],
          bit: (b) => replay[b] ?? 0,
          all: () => ({ ...replay }),
        };
        for (const step of program.build(values, cl2)) {
          if (step.kind === 'measure') replay[step.bit] = await backend.measure(step.qubit);
          else await backend.applyGate(step.name, step.qubits, step.params);
        }
      }
      readout = 0;
      for (let q = 0; q < nQubits; q++) {
        const bit = `r${q}`;
        readoutBits.push(bit);
        let outcome: number;
        if (replay === null) {
          outcome = await backend.measure(q);
        } else {
          // Replaying a shot: the outcome is known, so project rather than draw.
          outcome = (replay >> q) & 1;
          await backend.collapse(q, outcome);
        }
        bits[bit] = outcome;
        readout |= outcome << q;
        steps.push({
          kind: 'measure',
          qubit: q,
          bit,
          stage: replay === null ? 'Readout' : 'Best shot',
          note:
            replay === null
              ? `Look at qubit ${q} — it has to decide`
              : `Qubit ${q} came up ${outcome} in the best of the shots`,
        });
        frames.push(await snapshot(backend, steps.length, bits, want));
      }
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
    shots: outcomes,
    measurement,
    circuitSteps,
    readout,
    readoutSource: replay === null ? 'draw' : 'best',
    readoutBits,
    bestShot,
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
async function sampleOnce(backend: Backend, shots: number, seed: number): Promise<Ensemble> {
  const counts = await backend.sample(shots, seedFor(seed, 0));
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
  seed: number,
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
    await backend.reset(seedFor(seed, shot));
    for (const key of Object.keys(bits)) delete bits[key];
    for (const step of program.build(values, cl)) {
      if (step.kind === 'measure') bits[step.bit] = await backend.measure(step.qubit);
      else await backend.applyGate(step.name, step.qubits, step.params);
    }
    // One draw of whatever is left undetermined. A measured qubit is already
    // collapsed, so this reads the register the way a machine would.
    for (const [index, count] of await backend.sample(1, seedFor(seed, shot ^ 0x5f5e1))) {
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
