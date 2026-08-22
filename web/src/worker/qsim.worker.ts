/// Simulation worker: owns the WASM module and every state vector.
///
/// The capacity probe allocates up to a couple of gigabytes and blocks for
/// seconds per measurement, so none of it can run on the UI thread.

import init, {
  Simulator,
  canAllocate,
  engineVersion,
  fullArrayQubitLimit,
  gateNames,
  maxQubits,
  memoryBytesRequired,
} from 'qsim';
import wasmUrl from 'qsim/qsim_bg.wasm?url';
import type {
  EngineInfo,
  PlaygroundState,
  ProbeOptions,
  ProbePoint,
  ProbeResult,
  Progress,
  Request,
  Response,
  StopReason,
  TestCheck,
  TestGroup,
  TestResult,
} from '../lib/protocol';

// The DOM lib types `self` as a Window; rather than pull in the conflicting
// webworker lib, name just the two members this file uses.
const ctx = globalThis as unknown as {
  postMessage: (msg: Response) => void;
  addEventListener: (type: 'message', cb: (e: MessageEvent<Request>) => void) => void;
};

let wasmMemory: WebAssembly.Memory | null = null;

const ready = init({ module_or_path: wasmUrl }).then((out) => {
  wasmMemory = out.memory;
});

/** Actual WASM linear memory. Grows on demand and never shrinks. */
function heapBytes(): number {
  return wasmMemory ? wasmMemory.buffer.byteLength : 0;
}

// ---------------------------------------------------------------------------
// Capacity probe
// ---------------------------------------------------------------------------

function runProbe(options: ProbeOptions, emit: (p: Progress) => void): ProbeResult {
  const started = performance.now();
  const points: ProbePoint[] = [];
  const engineMax = maxQubits();
  const hardMax = Math.min(options.maxQubits, engineMax);

  let maxQubitsAllocated = 0;
  let stopReason: StopReason = options.maxQubits < engineMax ? 'user-limit' : 'engine-limit';

  for (let n = options.minQubits; n <= hardMax; n++) {
    if (performance.now() - started > options.totalBudgetMs) {
      stopReason = 'budget-exhausted';
      emit({ kind: 'probe', currentQubits: n, note: 'time budget exhausted' });
      break;
    }
    emit({ kind: 'probe', currentQubits: n });

    // Ask first, so hitting the ceiling does not leave a failed run in the
    // timing series. Rust returns an error here instead of aborting the module.
    let sim: Simulator | null = null;
    if (canAllocate(n)) {
      try {
        sim = new Simulator(n);
      } catch {
        sim = null;
      }
    }

    if (!sim) {
      const failed: ProbePoint = {
        qubits: n,
        amplitudes: 2 ** n,
        stateBytes: memoryBytesRequired(n),
        allocated: false,
        layers: 0,
        gates: 0,
        totalMs: 0,
        msPerGate: NaN,
        amplitudeUpdatesPerSec: NaN,
        wasmHeapBytes: heapBytes(),
        normError: NaN,
      };
      points.push(failed);
      stopReason = 'allocation-failed';
      emit({ kind: 'probe', currentQubits: n, point: failed });
      break;
    }

    maxQubitsAllocated = n;

    // Adapt the layer count to the target duration: at low qubit counts one
    // layer is too fast to time, and near capacity one layer is already slow.
    let layers = 1;
    let ms = 0;
    let gates = 0;
    for (;;) {
      sim.reset();
      const t0 = performance.now();
      gates = sim.benchLayers(layers);
      ms = performance.now() - t0;
      if (ms >= options.targetMs || layers >= options.maxLayers) break;
      const projected = Math.ceil((layers * options.targetMs) / Math.max(ms, 0.05));
      layers = Math.min(Math.max(layers * 2, projected), options.maxLayers);
    }

    const amplitudes = 2 ** n;
    const point: ProbePoint = {
      qubits: n,
      amplitudes,
      stateBytes: memoryBytesRequired(n),
      allocated: true,
      layers,
      gates,
      totalMs: ms,
      msPerGate: ms / gates,
      amplitudeUpdatesPerSec: (gates * amplitudes) / (ms / 1000),
      wasmHeapBytes: heapBytes(),
      normError: Math.abs(sim.norm() - 1),
    };

    // Release explicitly — JS finalisation is not prompt enough to free a
    // multi-gigabyte buffer before the next allocation is attempted.
    sim.free();

    points.push(point);
    emit({ kind: 'probe', currentQubits: n, point });
  }

  return {
    points,
    maxQubitsAllocated,
    stopReason,
    totalMs: performance.now() - started,
    wasmHeapBytes: heapBytes(),
    engineMaxQubits: engineMax,
  };
}

// ---------------------------------------------------------------------------
// Engine test suite
// ---------------------------------------------------------------------------

function check(name: string, measured: number, expected: number, tolerance: number): TestCheck {
  return {
    name,
    expected,
    measured,
    tolerance,
    pass: Number.isFinite(measured) && Math.abs(measured - expected) <= tolerance,
  };
}

/** Deterministic LCG, so the random-circuit test is reproducible run to run. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const bits = (i: number, n: number) => i.toString(2).padStart(n, '0');

/** applyGate takes typed arrays across the WASM boundary; this keeps call sites readable. */
const gate = (sim: Simulator, name: string, qubits: number[], params: number[] = []) =>
  sim.applyGate(name, new Uint32Array(qubits), new Float64Array(params));

function bellGroup(): TestGroup {
  const t0 = performance.now();
  const n = 2;
  const sim = new Simulator(n);
  sim.prepareBell();
  const exact = Array.from(sim.probabilities());

  // Sampled frequencies exercise the sampler as well as the state.
  const shots = 40000;
  const flat = sim.sampleFlat(shots, 20260822);
  const freq = new Array(4).fill(0);
  for (let i = 0; i < flat.length; i += 2) freq[flat[i]] = flat[i + 1] / shots;

  const checks = [
    check('P(|00>)', exact[0], 0.5, 1e-12),
    check('P(|11>)', exact[3], 0.5, 1e-12),
    check('P(|01>) — forbidden', exact[1], 0, 1e-15),
    check('P(|10>) — forbidden', exact[2], 0, 1e-15),
    check('Sampled |00> frequency', freq[0], 0.5, 0.01),
    check('Total probability', sim.norm(), 1, 1e-12),
  ];
  sim.free();

  return {
    id: 'bell',
    title: 'Bell state — entanglement',
    description:
      'H on qubit 0 then CNOT(0→1). The two qubits become perfectly correlated: only |00> and |11> can occur, each with probability 1/2. Bars compare 40,000 sampled shots against the exact amplitudes.',
    checks,
    chart: {
      kind: 'distribution',
      categories: exact.map((_, i) => `|${bits(i, n)}>`),
      measured: freq,
      theoretical: exact,
      measuredLabel: 'Sampled (40k shots)',
      theoreticalLabel: 'Exact probability',
      xLabel: 'Basis state',
      yLabel: 'Probability',
    },
    ms: performance.now() - t0,
  };
}

function ghzGroup(): TestGroup {
  const t0 = performance.now();
  const n = 6;
  const sim = new Simulator(n);
  sim.prepareGhz();
  const p = Array.from(sim.probabilities());
  const last = (1 << n) - 1;

  const leakage = p.reduce((acc, v, i) => (i === 0 || i === last ? acc : acc + v), 0);
  const marginals = Array.from({ length: n }, (_, q) => sim.probabilityOfOne(q));

  const checks = [
    check(`P(|${'0'.repeat(n)}>)`, p[0], 0.5, 1e-12),
    check(`P(|${'1'.repeat(n)}>)`, p[last], 0.5, 1e-12),
    check('Probability outside the two peaks', leakage, 0, 1e-15),
    check('Worst single-qubit marginal P(1)', Math.max(...marginals.map((m) => Math.abs(m - 0.5))) + 0.5, 0.5, 1e-12),
    check('Total probability', sim.norm(), 1, 1e-12),
  ];
  const theoretical = p.map((_, i) => (i === 0 || i === last ? 0.5 : 0));
  sim.free();

  return {
    id: 'ghz',
    title: 'GHZ state — global correlation, local randomness',
    description:
      'A chain of CNOTs spreads one Hadamard across 6 qubits. All 64 basis states are reachable in principle, but only the all-zeros and all-ones states carry any probability — while every individual qubit still looks like a fair coin.',
    checks,
    chart: {
      kind: 'distribution',
      categories: p.map((_, i) => `|${bits(i, n)}>`),
      measured: p,
      theoretical,
      measuredLabel: 'Engine',
      theoreticalLabel: 'Theory',
      xLabel: 'Basis state (64 total)',
      yLabel: 'Probability',
    },
    ms: performance.now() - t0,
  };
}

function qftGroup(): TestGroup {
  const t0 = performance.now();
  const n = 6;
  const period = 4;
  const sim = new Simulator(n);

  // Hadamards on the qubits above the period's bit width build a uniform
  // superposition over the multiples of 4 — a comb with period 4.
  for (let q = 2; q < n; q++) gate(sim, 'h', [q]);
  sim.applyQft();
  const p = Array.from(sim.probabilities());

  const N = 1 << n;
  const spacing = N / period;
  const theoretical = p.map((_, k) => (k % spacing === 0 ? 1 / period : 0));
  const peaks = [0, 1, 2, 3].map((j) => p[j * spacing]);

  // Independently, QFT on a basis state must match the DFT closed form.
  const dft = new Simulator(5);
  dft.setBasisState(11);
  dft.applyQft();
  const amps = Array.from(dft.amplitudes());
  let worstDft = 0;
  const M = 32;
  for (let k = 0; k < M; k++) {
    const angle = (2 * Math.PI * 11 * k) / M;
    const wantRe = Math.cos(angle) / Math.sqrt(M);
    const wantIm = Math.sin(angle) / Math.sqrt(M);
    worstDft = Math.max(worstDft, Math.abs(amps[2 * k] - wantRe), Math.abs(amps[2 * k + 1] - wantIm));
  }
  dft.free();

  const checks = [
    ...peaks.map((v, j) => check(`P(k = ${j * spacing})`, v, 1 / period, 1e-12)),
    check('Probability off the peaks', p.reduce((a, v, k) => (k % spacing === 0 ? a : a + v), 0), 0, 1e-14),
    check('Worst amplitude error vs analytic DFT', worstDft, 0, 1e-12),
    check('Total probability', sim.norm(), 1, 1e-12),
  ];
  sim.free();

  return {
    id: 'qft',
    title: 'Quantum Fourier transform — period finding',
    description:
      'The input is a uniform superposition over every multiple of 4 (a comb of period 4 across 64 states). The QFT turns that period into four sharp peaks spaced 64/4 = 16 apart — the mechanism behind Shor’s algorithm. A separate check compares QFT of a basis state against the closed-form DFT.',
    checks,
    chart: {
      kind: 'distribution',
      categories: p.map((_, i) => String(i)),
      measured: p,
      theoretical,
      measuredLabel: 'Engine',
      theoreticalLabel: 'Theory',
      xLabel: 'Frequency index k',
      yLabel: 'Probability',
    },
    ms: performance.now() - t0,
  };
}

function groverGroup(): TestGroup {
  const t0 = performance.now();
  const n = 8;
  const N = 1 << n;
  const marked = 181;
  const maxIters = 30;

  const theta = Math.asin(1 / Math.sqrt(N));
  const measured: number[] = [];
  const theoretical: number[] = [];
  const xs: number[] = [];

  // Each point restarts from scratch, which keeps the engine call trivially
  // simple; the whole sweep is only a few thousand 256-amplitude gates.
  for (let r = 0; r <= maxIters; r++) {
    const sim = new Simulator(n);
    sim.runGrover(marked, r);
    measured.push(sim.probabilities()[marked]);
    sim.free();
    theoretical.push(Math.sin((2 * r + 1) * theta) ** 2);
    xs.push(r);
  }

  const optimal = Math.floor((Math.PI / 4) * Math.sqrt(N));
  const best = new Simulator(n);
  best.runGrover(marked, optimal);
  const finalP = Array.from(best.probabilities());
  let peak = 0;
  for (let i = 1; i < finalP.length; i++) if (finalP[i] > finalP[peak]) peak = i;
  const norm = best.norm();
  best.free();

  const worstDeviation = Math.max(...measured.map((v, i) => Math.abs(v - theoretical[i])));

  const checks = [
    check(`P(marked) after ${optimal} iterations`, finalP[marked], 1, 0.01),
    check('Most likely state is the marked one', peak, marked, 0),
    check('Worst deviation from sin²((2r+1)θ)', worstDeviation, 0, 1e-9),
    check('Uniform-start probability P(marked)', measured[0], 1 / N, 1e-12),
    check('Total probability', norm, 1, 1e-12),
  ];

  return {
    id: 'grover',
    title: 'Grover search — amplitude amplification',
    description:
      `Searching 256 states for one marked item. Each iteration rotates the state a little further toward the target, so the success probability follows sin²((2r+1)θ) exactly — peaking near ${optimal} iterations, then falling again if you overshoot. That is the √N speedup, visible as a curve.`,
    checks,
    chart: {
      kind: 'series',
      x: xs,
      xLabel: 'Grover iterations',
      yLabel: 'P(marked state)',
      series: [
        { label: 'Engine', values: measured },
        { label: 'Theory sin²((2r+1)θ)', values: theoretical },
      ],
    },
    ms: performance.now() - t0,
  };
}

function teleportGroup(): TestGroup {
  const t0 = performance.now();
  const steps = 21;
  const xs: number[] = [];
  const received: number[] = [];
  const expected: number[] = [];
  let worst = 0;
  let worstNorm = 0;

  // Sweep the payload state around the Bloch sphere. <Z> on the receiving
  // qubit must track cos(theta) for every prepared state and every one of the
  // four measurement branches.
  for (let i = 0; i < steps; i++) {
    const theta = (Math.PI * i) / (steps - 1);
    const sim = new Simulator(3);
    sim.setSeed(1000 + i);
    sim.teleport(theta, 0.8);
    const z = sim.expectationZ(2);
    worstNorm = Math.max(worstNorm, Math.abs(sim.norm() - 1));
    sim.free();

    xs.push(Number(theta.toFixed(4)));
    received.push(z);
    expected.push(Math.cos(theta));
    worst = Math.max(worst, Math.abs(z - Math.cos(theta)));
  }

  // Phase, not just amplitude: undo the prepared rotation on the receiver and
  // the qubit must land exactly on |0>.
  let worstResidual = 0;
  const branches = new Set<number>();
  for (let seed = 0; seed < 16; seed++) {
    const sim = new Simulator(3);
    sim.setSeed(seed);
    branches.add(sim.teleport(0.9, 2.4));
    gate(sim, 'u3', [2], [-0.9, 0, -2.4]);
    worstResidual = Math.max(worstResidual, sim.probabilityOfOne(2));
    sim.free();
  }

  const checks = [
    check('Worst ⟨Z⟩ error across the sweep', worst, 0, 1e-12),
    check('Worst residual after inverting the rotation', worstResidual, 0, 1e-12),
    check('Correction branches exercised', branches.size, 4, 0),
    check('Worst norm deviation', worstNorm, 0, 1e-12),
  ];

  return {
    id: 'teleport',
    title: 'Teleportation — mid-circuit measurement and collapse',
    description:
      'Qubit 0 holds a prepared state; qubits 1 and 2 share a Bell pair. Measuring qubits 0 and 1 collapses the register, and two classical bits tell the receiver which correction to apply. Inverting the original rotation on qubit 2 returns it exactly to |0>, so phase is preserved, not just probability.',
    checks,
    chart: {
      kind: 'series',
      x: xs,
      xLabel: 'Prepared θ (radians)',
      yLabel: '⟨Z⟩ on the receiving qubit',
      series: [
        { label: 'Received (qubit 2)', values: received },
        { label: 'Theory cos θ', values: expected },
      ],
    },
    ms: performance.now() - t0,
  };
}

function unitarityGroup(): TestGroup {
  const t0 = performance.now();
  const n = 16;
  const sim = new Simulator(n);
  const rand = lcg(4242);
  const oneQ = ['h', 'x', 'y', 'z', 's', 'sdg', 't', 'tdg'];
  const paramQ = ['rx', 'ry', 'rz', 'p'];

  const xs: number[] = [];
  const errors: number[] = [];
  const total = 600;

  for (let g = 1; g <= total; g++) {
    const roll = rand();
    const a = Math.floor(rand() * n);
    let b = Math.floor(rand() * n);
    if (b === a) b = (a + 1) % n;

    if (roll < 0.4) {
      gate(sim, oneQ[Math.floor(rand() * oneQ.length)], [a]);
    } else if (roll < 0.7) {
      gate(sim, paramQ[Math.floor(rand() * paramQ.length)], [a], [rand() * 2 * Math.PI]);
    } else if (roll < 0.9) {
      gate(sim, 'cx', [a, b]);
    } else {
      gate(sim, 'cp', [a, b], [rand() * 2 * Math.PI]);
    }

    if (g % 20 === 0) {
      xs.push(g);
      // Floor the plotted error so an exact 0 is still drawable on a log axis.
      errors.push(Math.max(Math.abs(sim.norm() - 1), 1e-18));
    }
  }

  const finalError = Math.abs(sim.norm() - 1);
  sim.free();

  const checks = [
    check(`|norm − 1| after ${total} random gates on ${n} qubits`, finalError, 0, 1e-9),
    check('Worst |norm − 1| along the way', Math.max(...errors), 0, 1e-9),
  ];

  return {
    id: 'unitarity',
    title: 'Unitarity — floating-point drift over a long circuit',
    description:
      `600 randomly chosen gates on a 16-qubit register (65,536 amplitudes). Every gate is unitary, so total probability must stay at 1. Rounding error accumulates as a random walk rather than a drift, which is what keeps deep circuits trustworthy — note the y-axis is around 1e-16.`,
    checks,
    chart: {
      kind: 'series',
      x: xs,
      xLabel: 'Gates applied',
      yLabel: '|norm − 1|',
      logY: true,
      series: [{ label: 'Norm error', values: errors }],
    },
    ms: performance.now() - t0,
  };
}

function samplingGroup(): TestGroup {
  const t0 = performance.now();
  const sim = new Simulator(2);
  sim.prepareBell();

  const shotCounts = [16, 64, 256, 1024, 4096, 16384, 65536, 262144];
  const deviations: number[] = [];
  const reference: number[] = [];

  for (const shots of shotCounts) {
    const flat = sim.sampleFlat(shots, 777);
    let hits = 0;
    let total = 0;
    for (let i = 0; i < flat.length; i += 2) {
      total += flat[i + 1];
      if (flat[i] === 0) hits = flat[i + 1];
    }
    deviations.push(Math.max(Math.abs(hits / total - 0.5), 1e-6));
    // Standard error of a fair coin: 0.5/sqrt(shots).
    reference.push(0.5 / Math.sqrt(shots));
  }

  const last = deviations[deviations.length - 1];
  const flat = sim.sampleFlat(10000, 5);
  let impossible = 0;
  let shotTotal = 0;
  for (let i = 0; i < flat.length; i += 2) {
    shotTotal += flat[i + 1];
    if (flat[i] !== 0 && flat[i] !== 3) impossible += flat[i + 1];
  }
  sim.free();

  const checks = [
    check('Deviation from 0.5 at 262,144 shots', last, 0, 0.005),
    check('Shots accounted for', shotTotal, 10000, 0),
    check('Samples landing on forbidden states', impossible, 0, 0),
  ];

  return {
    id: 'sampling',
    title: 'Sampling — convergence to the true distribution',
    description:
      'Measuring a Bell state repeatedly. The error in the observed |00> frequency should shrink like 1/√shots, tracking the standard error of a fair coin — and no shot may ever land on |01> or |10>.',
    checks,
    chart: {
      kind: 'series',
      x: shotCounts,
      xLabel: 'Shots',
      yLabel: '|observed − 0.5|',
      logY: true,
      series: [
        { label: 'Observed error', values: deviations },
        { label: 'Standard error 0.5/√shots', values: reference },
      ],
    },
    ms: performance.now() - t0,
  };
}

function runTests(emit: (p: Progress) => void): TestResult {
  const started = performance.now();
  const builders = [
    bellGroup,
    ghzGroup,
    qftGroup,
    groverGroup,
    teleportGroup,
    unitarityGroup,
    samplingGroup,
  ];
  const groups: TestGroup[] = [];
  for (const build of builders) {
    const group = build();
    groups.push(group);
    emit({ kind: 'tests', group });
  }
  const checks = groups.flatMap((g) => g.checks);
  return {
    groups,
    passed: checks.filter((c) => c.pass).length,
    failed: checks.filter((c) => !c.pass).length,
    totalMs: performance.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Playground — one long-lived simulator the UI mutates gate by gate
// ---------------------------------------------------------------------------

let playground: Simulator | null = null;
let history: string[] = [];

function playgroundSnapshot(): PlaygroundState {
  if (!playground) throw new Error('playground not initialised');
  return {
    nQubits: playground.nQubits,
    probabilities: Array.from(playground.probabilities()),
    amplitudes: Array.from(playground.amplitudes()),
    norm: playground.norm(),
    history: [...history],
  };
}

function handle(req: Request): unknown {
  const emit = (progress: Progress) => ctx.postMessage({ id: req.id, type: 'progress', progress });

  switch (req.kind) {
    case 'info': {
      const info: EngineInfo = {
        version: engineVersion(),
        maxQubits: maxQubits(),
        fullArrayQubitLimit: fullArrayQubitLimit(),
        gateNames: gateNames(),
      };
      return info;
    }
    case 'probe':
      return runProbe(req.options, emit);
    case 'runTests':
      return runTests(emit);
    case 'pgInit':
      playground?.free();
      playground = new Simulator(req.nQubits);
      history = [];
      return playgroundSnapshot();
    case 'pgApply':
      playground?.applyGate(req.gate, new Uint32Array(req.qubits), new Float64Array(req.params));
      history.push(
        `${req.gate}(${req.qubits.join(', ')}${req.params.length ? '; ' + req.params.map((p) => p.toFixed(3)).join(', ') : ''})`,
      );
      return playgroundSnapshot();
    case 'pgPrepare': {
      if (!playground) throw new Error('playground not initialised');
      // The three state preparations reset first: their names promise a specific
      // state, and layering them onto an arbitrary one silently produces
      // something else (a second Hadamard on the same qubit cancels the first).
      // QFT is a transform, so it deliberately applies in place.
      if (req.circuit === 'qft') {
        playground.applyQft();
        history.push('qft() — applied to the current state');
      } else {
        playground.reset();
        if (req.circuit === 'uniform') playground.prepareUniform();
        else if (req.circuit === 'bell') playground.prepareBell();
        else playground.prepareGhz();
        history.push(`reset + ${req.circuit}()`);
      }
      return playgroundSnapshot();
    }
    case 'pgMeasure': {
      if (!playground) throw new Error('playground not initialised');
      const bit = playground.measure(req.qubit);
      history.push(`measure(${req.qubit}) → ${bit}`);
      return playgroundSnapshot();
    }
    case 'pgReset':
      playground?.reset();
      history = [];
      return playgroundSnapshot();
  }
}

ctx.addEventListener('message', (e) => {
  const req = e.data;
  ready
    .then(() => {
      const data = handle(req);
      ctx.postMessage({ id: req.id, type: 'ok', data });
    })
    .catch((err: unknown) => {
      ctx.postMessage({ id: req.id, type: 'error', error: err instanceof Error ? err.message : String(err) });
    });
});
