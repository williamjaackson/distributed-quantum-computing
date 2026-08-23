// Verification for the program library, against the real engine.
//
// The browser is not needed for any of this: a program is a generator of steps,
// and the engine runs under Node from the same built artifact the page loads. So
// the invariants worth pinning down — every gate is one the engine knows, the
// norm survives, and the claims each program makes in its own readouts are true
// — are checked here rather than by clicking.
//
// Node strips the types from the imported `.ts` sources directly, which is why
// the programs can be pulled in as they are. Run with: node web/verify.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// Through the package name, not the path: the app's own modules import 'qsim',
// and two specifiers that reach the same file still have to be the same module
// instance or only one of them ends up initialised.
import { initSync, Simulator, gateNames, qaoaPlan } from 'qsim';
import { PROGRAMS } from './src/programs/index.ts';
import { defaultValues } from './src/lib/inputs.ts';
import { GATE_CONTROLS, GATE_PARAMS, gateArity } from './src/lib/steps.ts';

const here = dirname(fileURLToPath(import.meta.url));
initSync({ module: readFileSync(join(here, '../engine/pkg/qsim_bg.wasm')) });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

/**
 * Run a program's steps through the engine and return the final state.
 *
 * `readOut` measures every qubit afterwards, which is what the visualiser's
 * Measure button appends: the collapse has to leave the register on exactly one
 * basis state, and it has to be one the circuit gave some probability to.
 */
function run(program, values, seed = 0x5eed, readOut = false) {
  const n = program.qubits(values);
  const sim = new Simulator(n);
  sim.setSeed(seed);
  const bits = {};
  const cl = { get: (b) => bits[b], bit: (b) => bits[b] ?? 0, all: () => ({ ...bits }) };
  const steps = [];
  for (const step of program.build(values, cl)) {
    steps.push(step);
    if (step.kind === 'measure') bits[step.bit] = sim.measure(step.qubit);
    else sim.applyGate(step.name, new Uint32Array(step.qubits), new Float64Array(step.params));
  }
  const probs = n <= 22 ? sim.probabilities() : null;
  let readout = null;
  if (readOut) {
    readout = 0;
    for (let q = 0; q < n; q++) readout |= sim.measure(q) << q;
  }
  const collapsed = readOut && n <= 22 ? sim.probabilities() : null;
  const out = { n, steps, bits, norm: sim.norm(), probs, readout, collapsed };
  sim.free();
  return out;
}

// ---------------------------------------------------------------------------
// Every program, with its default inputs
// ---------------------------------------------------------------------------

const known = new Set(gateNames());
for (const program of PROGRAMS) {
  const values = defaultValues(program.inputs);
  const { n, steps, norm } = run(program, values);
  const problems = [];
  for (const step of steps) {
    if (step.kind === 'measure') {
      if (step.qubit < 0 || step.qubit >= n) problems.push(`measure q${step.qubit} of ${n}`);
      continue;
    }
    if (!known.has(step.name)) problems.push(`unknown gate '${step.name}'`);
    // `gateArity` is null for a gate whose control count comes from the call, so
    // the rule lives in one place rather than being restated here.
    const arity = gateArity(step.name);
    if (arity !== null && step.qubits.length !== arity) {
      problems.push(`${step.name} takes ${arity} qubits, got ${step.qubits.length}`);
    }
    if (arity === null && step.qubits.length < 2) {
      problems.push(`${step.name} needs a control and a target`);
    }
    if (GATE_CONTROLS[step.name] === undefined) problems.push(`${step.name} not in the arity table`);
    if (step.params.length !== (GATE_PARAMS[step.name] ?? 0)) {
      problems.push(`${step.name} angle count`);
    }
    for (const q of step.qubits) {
      if (q < 0 || q >= n) problems.push(`${step.name} touches q${q} of ${n}`);
    }
    if (!step.stage) problems.push(`${step.name} has no stage label`);
  }
  check(
    `${program.id}: ${steps.length} steps on ${n} qubits, all gates valid`,
    problems.length === 0,
    problems.slice(0, 3).join('; '),
  );
  check(`${program.id}: norm survives the run`, Math.abs(norm - 1) < 1e-12, norm.toFixed(15));
}

// ---------------------------------------------------------------------------
// Reading the register out
//
// What the Measure button appends. A readout has to leave the register on
// exactly one basis state, that state has to be one the circuit actually gave
// probability to, and the norm has to survive the collapse — which is the
// renormalisation working.
// ---------------------------------------------------------------------------

for (const program of PROGRAMS) {
  const values = defaultValues(program.inputs);
  const { n, readout, collapsed, probs, norm } = run(program, values, 0x5eed, true);
  if (n > 22) continue;
  const occupied = collapsed.filter((p) => p > 1e-12).length;
  check(
    `${program.id}: reading every qubit out leaves one definite state`,
    occupied === 1 && Math.abs(collapsed[readout] - 1) < 1e-12,
    `|${readout.toString(2).padStart(n, '0')}> at ${collapsed[readout]}, ${occupied} state(s) occupied`,
  );
  check(
    `${program.id}: the collapse landed somewhere the circuit allowed`,
    probs[readout] > 1e-12 && Math.abs(norm - 1) < 1e-12,
    `it had probability ${(probs[readout] * 100).toFixed(3)}% beforehand`,
  );
}

// ---------------------------------------------------------------------------
// Claims individual programs make in their own readouts
// ---------------------------------------------------------------------------

const byId = (id) => PROGRAMS.find((p) => p.id === id);

// Teleportation: qubit 2 ends up holding what qubit 0 was prepared with.
{
  const program = byId('teleport');
  const values = defaultValues(program.inputs);
  let worst = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const { probs, n } = run(program, values, seed);
    let p1 = 0;
    for (let i = 0; i < probs.length; i++) if ((i >> 2) & 1) p1 += probs[i];
    worst = Math.max(worst, Math.abs(p1 - Math.sin(values.theta / 2) ** 2));
    if (n !== 3) throw new Error('teleport should use 3 qubits');
  }
  check('teleport: the payload arrives whatever the measurements said', worst < 1e-12, `worst error ${worst.toExponential(2)}`);
}

// Deutsch–Jozsa: a constant oracle leaves the input register certain, a balanced
// one makes |0…0> impossible. One query either way.
{
  const program = byId('deutsch-jozsa');
  for (const [oracle, constant] of [['zero', true], ['one', true], ['parity', false], ['first', false]]) {
    const values = { ...defaultValues(program.inputs), oracle, measure: false };
    const { probs } = run(program, values);
    const n = program.qubits(values) - 1;
    let pZero = 0;
    for (let i = 0; i < probs.length; i++) if ((i & ((1 << n) - 1)) === 0) pZero += probs[i];
    check(
      `deutsch-jozsa: '${oracle}' reads as ${constant ? 'constant' : 'balanced'}`,
      Math.abs(pZero - (constant ? 1 : 0)) < 1e-12,
      `P(0…0) = ${pZero.toFixed(15)}`,
    );
  }
}

// Grover, at every width the program offers. The oracle is one `mcz` however
// wide the register is, so a failure here would mean the variadic control count
// broke somewhere between the program and the kernel.
{
  const program = byId('grover');
  for (const qubits of [2, 3, 5, 8, 10]) {
    const marked = (1 << qubits) - 3;
    const { probs, steps } = run(program, {
      ...defaultValues(program.inputs), qubits, marked, measure: false,
    });
    let peak = 0;
    probs.forEach((p, i) => { if (p > probs[peak]) peak = i; });
    const flat = 1 / probs.length;
    check(
      `grover: ${qubits} qubits, the marked state is the peak`,
      peak === marked,
      `${steps.length} steps, P(marked) = ${(probs[marked] * 100).toFixed(2)}% against a flat ${(flat * 100).toFixed(3)}%`,
    );
    check(
      `grover: ${qubits} qubits, amplified past four times flat`,
      probs[marked] > Math.max(0.5, flat * 4),
      `${(probs[marked] * 100).toFixed(1)}%`,
    );
  }
  // Overshooting is a real failure mode and the program exposes it on purpose.
  const optimal = run(program, { ...defaultValues(program.inputs), qubits: 5, marked: 9, rounds: 'auto' });
  const over = run(program, { ...defaultValues(program.inputs), qubits: 5, marked: 9, rounds: 'over' });
  check(
    'grover: two rounds past optimal makes it worse',
    over.probs[9] < optimal.probs[9],
    `${(optimal.probs[9] * 100).toFixed(1)}% -> ${(over.probs[9] * 100).toFixed(1)}%`,
  );
}

// The adder: reversible arithmetic, over every input pair at every width, and
// A restored each time — the property the whole Cuccaro construction is for.
{
  const program = byId('adder');
  for (const width of [1, 2, 3, 4]) {
    const mask = (1 << width) - 1;
    const wrong = [];
    for (let a = 0; a <= mask; a++) {
      for (let b = 0; b <= mask; b++) {
        const { probs } = run(program, { ...defaultValues(program.inputs), width, a, b });
        let peak = 0;
        probs.forEach((p, i) => { if (p > probs[peak]) peak = i; });
        // Layout: carry in, a[width], b[width], carry out.
        let sum = 0;
        for (let i = 0; i < width; i++) sum |= ((peak >> (1 + width + i)) & 1) << i;
        sum |= ((peak >> (1 + 2 * width)) & 1) << width;
        let back = 0;
        for (let i = 0; i < width; i++) back |= ((peak >> (1 + i)) & 1) << i;
        if (sum !== a + b) wrong.push(`${a}+${b}=${sum}`);
        else if (back !== a) wrong.push(`A became ${back} from ${a}`);
        else if (probs[peak] < 1 - 1e-12) wrong.push(`${a}+${b} only ${probs[peak]}`);
      }
    }
    check(
      `adder: ${width}-bit inputs on ${2 * width + 2} qubits, every pair sums and restores A`,
      wrong.length === 0,
      wrong.slice(0, 3).join(' '),
    );
  }
  // In superposition the sum register must hold every answer at equal weight.
  const { probs } = run(program, { ...defaultValues(program.inputs), width: 2, b: 1, superpose: true });
  const seen = new Map();
  probs.forEach((p, i) => {
    if (p < 1e-12) return;
    let sum = 0;
    for (let k = 0; k < 2; k++) sum |= ((i >> (3 + k)) & 1) << k;
    sum |= ((i >> 5) & 1) << 2;
    seen.set(sum, (seen.get(sum) ?? 0) + p);
  });
  const sums = [...seen.keys()].sort((x, y) => x - y);
  const even = [...seen.values()].every((p) => Math.abs(p - 0.25) < 1e-12);
  check(
    'adder: A in superposition holds every sum at once, evenly',
    sums.join(',') === '1,2,3,4' && even,
    `sums ${sums.join(', ')} each ${[...seen.values()].map((p) => p.toFixed(3)).join('/')}`,
  );
}

// QAOA: the program must be a *driver* for the engine's circuit, not a second
// copy of it. tests/qaoa_plan.rs already proves the plan matches run_qaoa; what
// is left to check here is that nothing is added, removed or reordered on the
// way through the program and across the WASM boundary.
{
  const program = byId('qaoa');
  const values = defaultValues(program.inputs);
  const names = gateNames();

  // The plan, asked for directly, with the config the program's defaults imply.
  const WATTS = [1, 1, 1, 1, 1, 2, 4, 3, 1, 2, 4, 6];
  const planFor = (gamma, beta, lambda, penalties) => {
    const qubits = [];
    const offsets = [0];
    for (const p of penalties) {
      qubits.push(...p.qubits);
      offsets.push(qubits.length);
    }
    const flat = qaoaPlan(
      new Float64Array(WATTS), 20, gamma, beta, lambda,
      new Uint32Array(qubits), new Uint32Array(offsets),
      new Float64Array(penalties.map((p) => p.target)),
      new Float64Array(penalties.map((p) => p.multiplier)),
    );
    const out = [];
    let at = 0;
    const next = () => flat[at++];
    const count = next();
    for (let g = 0; g < count; g++) {
      const name = names[next()];
      next(); next();
      const qs = Array.from({ length: next() }, () => next());
      const ps = Array.from({ length: next() }, () => next());
      out.push(`${name}(${qs.join(',')})[${ps.map((v) => v.toFixed(12)).join(',')}]`);
    }
    return out;
  };

  const configured = [
    { qubits: [4, 5, 6, 7], target: 10, multiplier: 5 },
    { qubits: [8, 9, 10, 11], target: 13, multiplier: 5 },
  ];
  const { steps } = run(program, values);
  const asRun = steps.map(
    (s) => `${s.name}(${s.qubits.join(',')})[${s.params.map((v) => v.toFixed(12)).join(',')}]`,
  );
  const asPlanned = planFor(values.gamma, values.beta, values.lambda, configured);
  check(
    'qaoa: the program yields exactly the engine\'s planned circuit',
    asRun.length === asPlanned.length && asRun.every((g, i) => g === asPlanned[i]),
    `${asRun.length} steps vs ${asPlanned.length} planned` +
      (asRun.length === asPlanned.length
        ? ''
        : `; first difference at ${asRun.findIndex((g, i) => g !== asPlanned[i])}`),
  );
  check(
    'qaoa: one round of the power grid is 278 gates',
    asRun.length === 278,
    `${asRun.length}`,
  );

  // Changing which consumers get a demand term must change the circuit, by the
  // right number of gates: three per pair plus one diagonal per qubit.
  const block = (k) => 3 * ((k * (k - 1)) / 2) + k;
  const budget = block(12);
  for (const [choice, expected] of [
    ['configured', 12 + budget + block(4) * 2 + 12],
    ['all', 12 + budget + block(2) * 2 + block(4) * 2 + 12],
    ['none', 12 + budget + 12],
  ]) {
    const { steps: s } = run(program, { ...values, penalties: choice });
    check(`qaoa: '${choice}' demand terms give ${expected} gates`, s.length === expected, `${s.length}`);
  }

  // The objective, and the optimum optimization_problem.rs pins independently.
  const GROUPS = [[0, 1], [2, 3], [4, 5, 6, 7], [8, 9, 10, 11]];
  const DEMAND = [2, 2, 10, 13];
  const WEIGHT = [3, 3, 5, 5];
  const objective = (x) => {
    const a = GROUPS.map((g) => g.reduce((t, q) => t + ((x >> q) & 1) * WATTS[q], 0));
    if (a.reduce((t, v) => t + v, 0) > 20) return Infinity;
    return GROUPS.reduce((t, _, i) => t + (WEIGHT[i] * Math.max(0, DEMAND[i] - a[i])) / DEMAND[i], 0);
  };
  let bestCost = Infinity;
  let optimal = [];
  for (let x = 0; x < 4096; x++) {
    const c = objective(x);
    if (c < bestCost - 1e-12) { bestCost = c; optimal = [x]; }
    else if (Math.abs(c - bestCost) < 1e-12) optimal.push(x);
  }
  check(
    'qaoa: the optimum is the allocation the engine tests expect',
    Math.abs(bestCost - 2.692308) < 1e-6 && optimal.length === 2,
    `unmet demand ${bestCost.toFixed(6)} at ${optimal.length} states`,
  );

  // What the circuit does with it, at the angles qaoa.rs ships and at better
  // ones. Both are claims the program makes in its own panel.
  const before = optimal.length / 4096;
  const measure = (over) => {
    const { probs } = run(program, { ...values, ...over });
    return {
      amplification: optimal.reduce((t, x) => t + probs[x], 0) / before,
      probs,
    };
  };
  const shipped = measure({});
  check(
    'qaoa: the shipped angles amplify the optimum at all',
    shipped.amplification > 2,
    `${shipped.amplification.toFixed(2)}x at the default γ=${values.gamma}, β=${values.beta}`,
  );
  const tuned = measure({ gamma: 0.04, beta: 0.68 });
  check(
    'qaoa: a better setting is reachable on the sliders',
    tuned.amplification > 20 && tuned.amplification > shipped.amplification * 5,
    `${tuned.amplification.toFixed(1)}x at γ=0.04, β=0.68 against ${shipped.amplification.toFixed(2)}x shipped`,
  );

  // The answer is the cheapest allocation among the shots, which is a different
  // and better thing than the likeliest outcome. At the shipped angles the
  // likeliest outcome is a poor allocation, so a readout that reported it would
  // be confidently wrong — this is the check that would have caught that.
  const bestSampled = (probs, shots) => {
    // Draw deterministically from the distribution, the way the sampler does:
    // take the states in order of probability until the shots run out.
    const ranked = [...probs.keys()].sort((a, b) => probs[b] - probs[a]);
    let left = shots;
    let best = Infinity;
    for (const x of ranked) {
      if (left <= 0) break;
      const expected = probs[x] * shots;
      if (expected < 0.5) break;
      left -= expected;
      best = Math.min(best, objective(x));
    }
    return best;
  };
  const likeliest = (probs) => {
    let peak = 0;
    probs.forEach((p, i) => { if (p > probs[peak]) peak = i; });
    return objective(peak);
  };
  check(
    'qaoa: the likeliest outcome is a much worse answer than the shots give',
    likeliest(shipped.probs) > bestSampled(shipped.probs, 1024) + 1,
    `likeliest leaves ${likeliest(shipped.probs).toFixed(4)} unmet, best of ~1024 shots leaves ` +
      `${bestSampled(shipped.probs, 1024).toFixed(4)}, optimum is ${bestCost.toFixed(4)}`,
  );
  check(
    'qaoa: enough shots reach the optimum at the shipped angles',
    bestSampled(shipped.probs, 65536) <= bestCost + 1e-9,
    `best of ~65536 shots leaves ${bestSampled(shipped.probs, 65536).toFixed(4)}`,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
