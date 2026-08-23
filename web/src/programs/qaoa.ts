/**
 * QAOA on the power-grid allocation problem, driven by the engine's own runner.
 *
 * Twenty watts of supply, four consumers that between them want twenty-seven:
 * two homes wanting 2 W, a hospital wanting 10 W, a factory wanting 13 W.
 * Twelve qubits are twelve switchable supplies of fixed size, so one bit string
 * is one allocation and the register holds all 4096 of them at once.
 *
 * **There is no circuit in this file.** `engine/src/qaoa.rs` builds the QAOA
 * circuit for a `QaoaConfig`, and `qaoa_plan::plan` returns those same gates as
 * data — proved to be the same circuit, to 1e-13, by `tests/qaoa_plan.rs`. This
 * program's whole job is to turn the panel's inputs into that config, ask for
 * the plan, and label the parts it comes back tagged with. A second copy of the
 * construction written in TypeScript is exactly what a visualiser must not have:
 * it would be a picture of a circuit that resembles the one the engine runs.
 *
 * What *is* here is the problem and the objective, and deliberately so. The
 * engine module keeps both out on the grounds that neither is generic — the
 * weights, the groupings and what makes one allocation better than another are
 * the caller's business. So they are the caller's business.
 */
import { qaoaPlan, gateNames } from 'qsim';
import { GATE_CONTROLS } from '../lib/steps';
import { num, str } from '../lib/inputs';
import type { GateStep, Program, Readout, Step } from '../lib/types';

// ---------------------------------------------------------------------------
// The problem
// ---------------------------------------------------------------------------

/** Watts each qubit switches on, indexed by qubit. `QaoaConfig::weights`. */
const WATTS = [1, 1, 1, 1, 1, 2, 4, 3, 1, 2, 4, 6];

interface Consumer {
  name: string;
  short: string;
  /** `EntitySpec::qubits` — which supplies feed this consumer. */
  qubits: number[];
  /** Watts wanted. */
  demand: number;
  /** How much a shortfall here matters. */
  weight: number;
}

const CONSUMERS: Consumer[] = [
  { name: 'Home 1', short: 'H1', qubits: [0, 1], demand: 2, weight: 3 },
  { name: 'Home 2', short: 'H2', qubits: [2, 3], demand: 2, weight: 3 },
  { name: 'Hospital', short: 'HP', qubits: [4, 5, 6, 7], demand: 10, weight: 5 },
  { name: 'Factory', short: 'F', qubits: [8, 9, 10, 11], demand: 13, weight: 5 },
];

const QUBITS = WATTS.length;
const STATES = 1 << QUBITS;
/** `QaoaConfig::total_water` — the supply there is to share. */
const BUDGET = 20;

/**
 * Which consumers get a demand term in the cost Hamiltonian.
 *
 * `qaoa.rs`'s own example lists only the hospital and the factory, so the two
 * homes are scored by the objective but never appear in the phases. That is a
 * real modelling choice with a visible consequence, so it is a control rather
 * than a detail buried in a constant.
 */
const PENALTY_SETS: Record<string, Consumer[]> = {
  configured: CONSUMERS.filter((c) => c.demand > 2),
  all: CONSUMERS,
  none: [],
};

/**
 * Weighted unmet demand — the objective, matching `penalty_for_state` in
 * `tests/qaoa_module.rs`.
 *
 * Over-supplying costs nothing here; going over budget is not a cost but a
 * disqualification, which is what the engine's global penalty term is
 * approximating with phases.
 */
function objective(state: number): number {
  const allocated = allocations(state);
  if (allocated.reduce((a, b) => a + b, 0) > BUDGET) return Infinity;
  return CONSUMERS.reduce(
    (sum, c, i) => sum + (c.weight * Math.max(0, c.demand - allocated[i])) / c.demand,
    0,
  );
}

/** Watts each consumer ends up with, in `CONSUMERS` order. */
function allocations(state: number): number[] {
  return CONSUMERS.map((c) => c.qubits.reduce((s, q) => s + ((state >> q) & 1) * WATTS[q], 0));
}

interface Best {
  cost: number;
  allocated: number[];
  /** Every state that reaches the optimum — there is rarely just one. */
  states: number[];
  feasible: number;
}

let cachedBest: Best | null = null;

/**
 * The best allocation the encoding can express, by exhaustion.
 *
 * 4096 states is nothing, and a QAOA result with nothing to compare it against
 * is just a number. `tests/optimization_problem.rs` pins the same answer down
 * independently, which is what makes this a cross-check rather than a mirror.
 */
function classicalBest(): Best {
  if (cachedBest) return cachedBest;
  let cost = Infinity;
  let states: number[] = [];
  let feasible = 0;
  for (let x = 0; x < STATES; x++) {
    const c = objective(x);
    if (!Number.isFinite(c)) continue;
    feasible++;
    if (c < cost - 1e-12) {
      cost = c;
      states = [x];
    } else if (Math.abs(c - cost) < 1e-12) {
      states.push(x);
    }
  }
  cachedBest = { cost, allocated: allocations(states[0]), states, feasible };
  return cachedBest;
}

// ---------------------------------------------------------------------------
// The circuit, from the engine
// ---------------------------------------------------------------------------

/** `qaoa_plan::Part`, as the flat encoding carries it. */
const PART_LABEL = ['Superpose', 'Budget · 20 W', 'Demand', 'Mixer'] as const;

/**
 * Decode `qaoaPlan`'s flat output into visualiser steps.
 *
 * Layout is `[n, then per gate: name_id, part_tag, part_index, n_qubits,
 * qubits…, n_params, params…]` with `name_id` indexing `gateNames()` — see
 * `qaoa_plan::encode`.
 */
function decodePlan(flat: Float64Array, penalties: Consumer[]): GateStep[] {
  const names = gateNames();
  const steps: GateStep[] = [];
  let at = 0;
  const next = () => flat[at++];
  const count = next();

  for (let g = 0; g < count; g++) {
    const name = names[next()];
    const tag = next();
    const partIndex = next();
    const qubits = Array.from({ length: next() }, () => next());
    const params = Array.from({ length: next() }, () => next());

    const stage =
      tag === 2
        ? `Demand · ${penalties[partIndex]?.name ?? `penalty ${partIndex}`}`
        : PART_LABEL[tag];
    steps.push({
      kind: 'gate',
      name,
      qubits,
      params,
      controls: GATE_CONTROLS[name] ?? 0,
      stage,
      note: note(tag, name, qubits, penalties[partIndex]),
    });
  }
  if (at !== flat.length) {
    throw new Error(`qaoaPlan returned ${flat.length} values, ${at} were read`);
  }
  return steps;
}

function note(tag: number, name: string, qubits: number[], penalty?: Consumer): string {
  if (tag === 0) return 'Every allocation at once';
  if (tag === 3) return 'Turn the phases into probability';
  const who = tag === 1 ? 'the 20 W budget' : `${penalty?.name ?? 'a consumer'}’s demand`;
  if (name === 'cx') return `Couple supplies ${qubits[0]} and ${qubits[1]} for ${who}`;
  return `Cost of supply ${qubits[qubits.length - 1]} against ${who}, as a phase`;
}

// ---------------------------------------------------------------------------
// The program
// ---------------------------------------------------------------------------

export const qaoa: Program = {
  id: 'qaoa',
  name: 'QAOA power grid',
  blurb: 'Share 20 W between four consumers that want 27 — on 12 qubits.',
  detail:
    'The circuit is the engine’s own: qaoa.rs builds it from a QaoaConfig and this program only supplies the config. Watch it with the state-vector view open — the cost layer writes each allocation’s shortfall into its phase and the bars do not move at all, which is the step that makes people think nothing happened. The mixer then turns those phases into interference. QAOA is a sampler, so the answer is the cheapest allocation among the shots, not the likeliest outcome: the likeliest is usually mediocre. Raise the shot count and the answer improves; drag γ toward 0.04 and it improves far more, because the optimum goes from 2.5× to 33× as likely. One round is powerful and brittle at once.',
  suggestedView: 'state',
  inputs: [
    {
      id: 'gamma',
      kind: 'slider',
      label: 'Cost angle γ',
      min: 0,
      max: 0.2,
      step: 0.002,
      default: 0.1,
      format: (v) => v.toFixed(3),
      hint: 'qaoa.rs ships 0.1; around 0.04 does far better — the peak is sharp',
    },
    {
      id: 'beta',
      kind: 'slider',
      label: 'Mixer angle β',
      min: 0,
      max: Math.PI / 2,
      step: 0.02,
      default: 0.5,
      format: (v) => `${v.toFixed(2)} rad`,
      hint: 'how much of that phase is turned into probability',
    },
    {
      id: 'lambda',
      kind: 'slider',
      label: 'Budget weight λ',
      min: 0,
      max: 30,
      step: 1,
      default: 10,
      hint: 'how badly the 20 W budget may be broken',
    },
    {
      id: 'penalties',
      kind: 'select',
      label: 'Demand terms',
      default: 'configured',
      options: [
        {
          value: 'configured',
          label: 'Hospital and factory',
          hint: 'as qaoa.rs configures it — the homes are scored but never phased',
        },
        { value: 'all', label: 'Every consumer', hint: 'the homes get demand terms too' },
        { value: 'none', label: 'Budget only', hint: 'no demand terms at all' },
      ],
    },
  ],
  qubits: () => QUBITS,
  // Weighted unmet demand, with an over-budget allocation disqualified outright.
  // This is what `tests/qaoa_module.rs` scans the histogram for, so the app can
  // rank the shots the same way the engine's own test does.
  score: (state) => {
    const cost = objective(state);
    return Number.isFinite(cost) ? cost : null;
  },
  wireLabels: () =>
    CONSUMERS.flatMap((c) => c.qubits.map((q) => `${c.short} ${WATTS[q]}W`)),
  *build(v): Iterable<Step> {
    const penalties = PENALTY_SETS[str(v, 'penalties', 'configured')] ?? [];
    // Flat arrays, because the WASM boundary carries numbers and nothing else.
    const qubits: number[] = [];
    const offsets: number[] = [0];
    for (const c of penalties) {
      qubits.push(...c.qubits);
      offsets.push(qubits.length);
    }
    const flat = qaoaPlan(
      new Float64Array(WATTS),
      BUDGET,
      num(v, 'gamma', 0.1),
      num(v, 'beta', 0.5),
      num(v, 'lambda', 10),
      new Uint32Array(qubits),
      new Uint32Array(offsets),
      new Float64Array(penalties.map((c) => c.demand)),
      new Float64Array(penalties.map((c) => c.weight)),
    );
    yield* decodePlan(flat, penalties);
  },
  outputs: ({ probabilityOf, shots, measurement, bestShot }) => {
    const best = classicalBest();
    // The answer, the way `tests/qaoa_module.rs` defines it: the cheapest
    // allocation among the states actually sampled. QAOA is a sampler, not an
    // oracle — the likeliest outcome is usually mediocre, and reporting it as
    // the result is how you end up presenting a wrong answer confidently. The
    // ranking comes from `score`, so the panel and the Best shot button cannot
    // disagree about which allocation won.
    const found = bestShot ? { state: bestShot.index, cost: bestShot.score } : null;
    let feasibleShots = 0;
    for (const o of shots) {
      if (Number.isFinite(objective(o.index))) feasibleShots += o.count;
    }
    const drawn = shots.reduce((a, o) => a + o.count, 0) || 1;
    const optimumHits = shots
      .filter((o) => best.states.includes(o.index))
      .reduce((a, o) => a + o.count, 0);

    const before = best.states.length / STATES;
    const now = best.states.reduce((s, x) => s + probabilityOf(x), 0);
    const allocated = found ? allocations(found.state) : null;

    const rows: Readout[] = [
      {
        label: `Best of ${measurement.taken.toLocaleString()} shots`,
        value: allocated
          ? CONSUMERS.map((c, i) => `${c.short} ${allocated[i]}`).join(' · ')
          : 'nothing within budget',
        hero: true,
        hint: allocated
          ? `${allocated.reduce((a, b) => a + b, 0)} of ${BUDGET} W used, leaving ${found!.cost.toFixed(
              4,
            )} unmet`
          : 'every shot broke the budget',
      },
      {
        label: 'Optimum',
        value: CONSUMERS.map((c, i) => `${c.short} ${best.allocated[i]}`).join(' · '),
        hint: `${best.cost.toFixed(4)} unmet, by exhaustive search over the ${best.feasible.toLocaleString()} allocations within budget`,
      },
      {
        label: 'Best shot ranked',
        value: bestShot ? `${bestShot.rank} of ${shots.length}` : '—',
        hint: bestShot
          ? `by how often it came up — ${bestShot.count} time${
              bestShot.count === 1 ? '' : 's'
            }. The best allocation is rarely the likeliest one`
          : 'nothing within budget was drawn',
      },
      {
        label: 'Shots that found it',
        value: `${optimumHits.toLocaleString()} of ${measurement.taken.toLocaleString()}`,
        hint:
          optimumHits === 0
            ? 'none — take more shots, or move γ'
            : `${((optimumHits / drawn) * 100).toFixed(2)}% of them`,
      },
      {
        label: 'Shots within budget',
        value: `${((feasibleShots / drawn) * 100).toFixed(1)}%`,
        hint: 'the budget is a phase penalty, not a constraint — it can be broken',
      },
      {
        label: 'P(optimum)',
        value: `${(now * 100).toFixed(3)}%`,
        hint: `${(now / before).toFixed(1)}× the ${(before * 100).toFixed(3)}% an even draw would give`,
      },
    ];
    return rows;
  },
};
