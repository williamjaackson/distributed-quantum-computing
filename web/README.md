# qsim visualiser

A step-through view of the engine. Pick a program, feed it inputs, and watch
the register from whichever angle answers the question.

```sh
npm run dev        # from the repo root: builds the WASM package, then serves
npm test           # engine tests, smoke tests, typecheck, program verification
```

## The shape of it

One source of truth: `runProgram` executes a program one step at a time and
records what the register looked like after each, and everything on screen is a
function of that timeline plus a playhead. Changing an input re-runs from
scratch — microseconds at small sizes — so the display cannot drift from the
engine.

| File | Contents |
| ---- | -------- |
| `lib/types.ts` | `Program`, `Step`, `Frame`, `Timeline` — the vocabulary |
| `lib/steps.ts` | step constructors, and the gate arity table |
| `lib/backend.ts` | the `Backend` interface and the whole-state implementation |
| `lib/shardedRegister.ts` | the sharded implementation, over workers |
| `lib/runner.ts` | executes a program, records frames, budgets the detail |
| `lib/analysis.ts` | presents a recorded frame to the views |
| `programs/*.ts` | one program per file |
| `views/*.tsx` | one projection per file |
| `verify.mjs` | every program against the engine, under Node |

## Programs

A program is a *generator* of steps rather than a list, so a step can depend on
a mid-circuit measurement — teleportation's corrections need exactly that. The
runner pulls one step at a time, executes it, and records the result, which
means the resolved step list is only known after the run. That is why the
circuit diagram shows the gates that *actually ran*, with conditional ones
marked, rather than a pair of maybe-gates.

Adding one is adding a file and a line in `programs/index.ts`. It declares its
own inputs, its own qubit count, its own wire names and its own readouts;
nothing else in the app needs to know it exists.

## The views

One at a time, deliberately — they are different ways of looking at the same
amplitudes, and side by side they compete rather than combine.

| View | Shows | Good for |
| ---- | ----- | -------- |
| Circuit | the gates in execution order, playhead on the last one | following what ran |
| State vector | probability as height, phase as a dial | interference, amplification |
| Qubit map | a dial per qubit, chorded by correlation | entanglement, collapse |
| Polarisation | a Bloch sphere per qubit | phase on a single qubit; entanglement as a *short* arrow |
| Complex plane | amplitudes as points | phase, exactly — the QFT's winding |
| Shots | the engine's sampler against the exact probabilities | what an experiment would return |

Probability and phase get two different encodings — height and angle — rather
than one colour-coded bar. A phase is a direction, so a dial reads at a glance
and survives greyscale. Colour is left to carry one thing: blue is |1⟩ and
amplitude, grey is |0⟩ and chrome, orange is measurement. The palette is the
data-viz reference set, validated all-pairs on the light surface.

## Register size

There is no hand-picked qubit cap. There are four real ceilings, and the
visualiser's own is the *cost of summarising a step*, not the memory to store
one:

| Ceiling | Value | Set by |
| ------- | ----- | ------ |
| Whole amplitude array per frame | 14 qubits | 16 B × 2ⁿ × steps — 256 KiB a frame at 14 |
| Comfortable stepping | 22 qubits | measured: ~10 ms a step at 16, 60 ms at 22, 250 ms at 24 |
| One WASM module | 26 qubits | `isize::MAX` caps a single Rust allocation at 2 GiB |
| Sharded | RAM | a module per worker, each with its own address space |

Above 14 qubits a frame keeps a *summary* — the Bloch vectors, the largest
amplitudes and the correlation matrix — which is everything a view draws, at
kilobytes rather than megabytes. Those come from the engine's own
`bloch_vector`, `top_amplitudes` and `reduced_two`, each one pass with no buffer
proportional to the state, so they stay available at any size. Past 22 qubits is
an explicit choice in the Execution panel, with the memory cost stated.

Correlation links are the one thing that gets switched off rather than
approximated: a link needs one pass over the state per pair, so all pairs is
`O(n² · 2ⁿ)`. The budget allows it to about 19 qubits, and the map says so
rather than drawing an empty ring that implies independence.

## Sharded execution

Selectable at any size, not only past 26 qubits — the mechanism is identical at
four qubits and at thirty, and forcing it on is the only way to watch it work.
`planGate` in Rust decides which shards take part in a gate and which pair with
which; this side only routes work and moves blocks.

Two things had to be added to make a sharded register *visualisable* rather than
merely computable:

- **Summaries.** A local qubit's are sums within each slice, so the shards never
  communicate. A global qubit is a shard-id bit, so its diagonal comes straight
  from the shard masses with no amplitude arithmetic at all, and only its
  off-diagonal needs a pass — which reuses the gate exchange's own staging
  buffer.
- **Measurement.** The outcome has to be drawn *once*, against the global
  marginal, which no shard can see. So the orchestrator draws it and hands both
  the outcome and the scale factor to `collapse_local`. A global qubit collapses
  by shard selection instead: the slices on the unobserved side are emptied.

The orchestrator draws from the engine's `Prng` rather than one of its own,
which makes a sharded run bit-identical to a whole-state run of the same circuit
and seed. Without that, switching execution mode changes the measured outcomes
and the two paths cannot be compared at all — and comparing them is the point:
`tests/sharding.rs` proves the algorithm in process, and identical readouts in
the browser prove this reimplementation of the routing.

## Verification

`node web/verify.mjs` runs every program through the engine under Node. A
program is a generator of steps and the engine has no browser dependency, so
there is nothing to click:

- every gate name, arity and qubit index is one the engine accepts
- the norm survives every run
- teleportation's payload arrives whatever the measurements said
- Deutsch–Jozsa returns the right verdict for each oracle, in one query
- the adder is correct over all sixteen input pairs, with certainty
- Grover's marked state is the peak, past 94%

Node strips the types from the imported `.ts` sources; `tsresolve.mjs` fills in
the extensions its resolver wants and Vite's does not, so the app source stays
written for the bundler.
