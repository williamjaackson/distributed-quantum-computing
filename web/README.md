# qsim visualiser

A step-through view of the engine. Pick a program, feed it inputs, and watch
the register from whichever angle answers the question.

```sh
npm run dev        # from the repo root: builds the WASM package, then serves
npm test           # engine tests, smoke tests, typecheck, program verification
```

## Layout

Three columns: what to run on the left, what it looks like in the middle, what
came out on the right. The answer has a column of its own because it was ending
up below the fold of a scrolling sidebar, which is the one place an answer must
never be.

Explanation lives behind an ⓘ, not in the layout. The dividing line: if it
*explains*, it hides; if it is a fact about what you are looking at — a count, a
percentage, a caveat about what has been truncated — it stays visible, because
hiding those would be hiding the data. Data rows reveal their note on hover
rather than carrying an ⓘ each, since the row is already a hit target and six
more small buttons is not simpler.

Controls are counted too. Speed was six buttons and is one select; the shot
count was four and is one. What is left is what was asked for: start, back,
play/pause, forward, end, a scrubber, and the measurement buttons that appear
only once the circuit has finished.

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
| `lib/backend.ts` | the `Backend` interface, and the shard layout it builds |
| `lib/shardedRegister.ts` | the sharded implementation, over workers |
| `lib/runner.ts` | executes a program, records frames, budgets the detail |
| `lib/analysis.ts` | presents a recorded frame to the views |
| `programs/*.ts` | one program per file |
| `views/*.tsx` | one projection per file |
| `verify.mjs` | every program against the engine, under Node |

## One shape for every program

Each program used to invent its own output rows — ten programs, ten
vocabularies, anywhere from two to six rows in a different order — so reading a
new one meant working out its language first. They all answer the same three
questions, so the shape is fixed and only the words inside it change:

| | |
| --- | --- |
| **Answer** | what the run computed, in the program's terms |
| **Expected** | what it should be, when that is knowable another way, with ✓ / ✗ |
| **Confidence** | how strongly the shots support it |

`expected` is the interesting part of the contract. Nine of these ten problems
have an answer that is knowable independently — by exhaustive search, by
arithmetic, from an analytic formula — so a program says what the answer *should*
be and the panel marks whether the run got it. A coin flip cannot, and leaves it
out; that absence is itself the point.

Measurement is not a program's business either. Seven of them used to carry
their own "measure at the end" toggle, which duplicated the transport's Measure
button in seven slightly different ways. They are all unitary now except
teleportation, whose measurements are part of the algorithm rather than a display
option.

Views share a footer for the same reason: one component renders the legend from
a table of marks and one line of facts, so the bottom of the screen does not
change shape when you switch tabs.

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

There is deliberately no shots view — see below.

Probability and phase get two different encodings — height and angle — rather
than one colour-coded bar. A phase is a direction, so a dial reads at a glance
and survives greyscale. Colour is left to carry one thing: blue is |1⟩ and
amplitude, grey is |0⟩ and chrome, orange is measurement. The palette is the
data-viz reference set, validated all-pairs on the light surface.

## Measurement

Playing stops at the end of the *circuit*, where most of these programs leave
the interesting thing in a superposition. The transport's primary button then
offers to **measure**, and pressing it reads every qubit out in turn so the
collapse is something you watch rather than a jump — a Bell pair's second qubit
snaps the moment the first is looked at, without a gate touching it. It is a
separate button because looking is a separate act from computing, and a
destructive one. A program that already measured everything itself is not
offered it: there is nothing left to decide.

Pressing it gives you **one draw**, which is what a machine gives you, and
pressing it again gives you a *different* one — on a Bell pair, six presses gave
\|11⟩ \|00⟩ \|11⟩ \|11⟩ \|00⟩ \|00⟩, always agreeing and never predictable. The
panel says what that draw scored next to what the best of your shots scored —
because one sample from a distribution where the answer has 0.1% of the
probability is almost always a poor one, and a collapsed register is the most
prominent thing on screen. Beside it is **Best shot**, which collapses onto the
best-scoring outcome the shots actually produced. That is a selection among
draws rather than a measurement, so it says so; but keeping the best of a
thousand runs is how a sampling algorithm is used, and it puts the answer in the
register instead of only in a panel.

What "best" means is the program's business, not the app's: a program can
implement `score(state, values)` — lower is better, `null` disqualifies — and
the app ranks the shots with it. A program whose output is a single definite
state has nothing to rank and leaves it out.

A state vector is not a result. The amplitudes are not something any experiment
can read, and the answer to "what does this program compute" is what comes back
when you measure it, repeatedly. So measurement is not one of the views: it is
part of every run, and it lives beside the outputs because that is where an
answer belongs.

How the shots are taken depends on the circuit, and the difference is not
cosmetic:

| | when | cost |
| --- | --- | --- |
| **sampled** | no mid-circuit measurement | one pass — every shot is drawn from the same final state, exactly |
| **repeated** | the circuit measures | the whole circuit re-run per shot; there is no shortcut, so it is budgeted |

For a sampled run the exact probability sits beside the sampled share, because
that gap *is* the shot noise and watching it close as the count rises is the
reason anyone takes more than one shot. For a repeated run there is no single
final state to compare against, so the column is absent rather than invented.

There is no seed control. A seed asks the reader to manage the one thing shots
exist to average away, so the run picks its own and rolls it every time you ask
to measure. An earlier version derived it from a fixed index instead, in the
name of reproducibility, and the result was a coin flip that came up heads on
every fresh page load — the one thing a coin flip must not do. Reproducibility
is not worth that.

How many shots is a property of the algorithm, not a taste setting, so a program
states its own default and most want the standard thousand. A sampling optimiser
whose best outcome carries one part in a thousand of the distribution will miss
it half the time at a thousand shots and report a worse one with a straight
face; that is a budget, not a bug, and the program is what knows the difference.

Readouts describe the end of the *circuit* — not the playhead, and not the end
of the timeline. An answer that changes as you scrub is not an answer; and a
readout collapses the state to one draw, which would turn "P(marked) = 96%" into
"100%" and make the exact column contradict the shot column beside it. The
collapse is reported separately, as the one draw it is.
And a program's answer is what it measured, not what was most probable — Grover
reports how many shots found the marked state, the adder whether all of them
read the same sum, Deutsch–Jozsa's verdict is what the shots said. The
difference is not pedantic: for QAOA the likeliest outcome is a *bad*
allocation, and reporting it was a wrong answer stated confidently.

## Register size

There is no hand-picked qubit cap. There are four real ceilings, and the
visualiser's own is the *cost of summarising a step*, not the memory to store
one:

| Ceiling | Value | Set by |
| ------- | ----- | ------ |
| Whole amplitude array per frame | 14 qubits | 16 B × 2ⁿ × steps — 256 KiB a frame at 14 |
| Comfortable stepping | 22 qubits | measured: ~40 ms a step at 20, 180 ms at 24, 4.7 s at 28 |
| One WASM module | 26 qubits | `isize::MAX` caps a single Rust allocation at 2 GiB |
| Register | 30 qubits | 16 shards × 1 GiB, and the machine has to have 16 GiB |

Execution is always sharded. There used to be a setting choosing between a
whole-state backend and a sharded one, and it was doing nothing useful: the
sharded path is a superset, so the choice was between "shard" and "shard". With
it went the qubit cap it was gating, because the limit is what the machine can
allocate, not which mode you picked. 28 qubits is 4 shards of 1 GiB and takes
about 131 s to step through a 28-gate circuit; 29 is 8 shards. The panel states
the layout and the cost before you commit to it.

Above 14 qubits a frame keeps a *summary* — the Bloch vectors, the largest
amplitudes and the correlation matrix — which is everything a view draws, at
kilobytes rather than megabytes. Those come from the engine's own
`bloch_vector`, `top_amplitudes` and `reduced_two_of`, each one pass with no buffer
proportional to the state, so they stay available at any size. Summarising is
what actually costs: a frame needs one pass per qubit, so it grows as `n · 2ⁿ`
and dominates the gates themselves by a factor of n.

Grover is the one program whose limit is the *circuit*, not the register. A
round is about `6n + 2` gates and the optimal round count grows as `sqrt(2^n)`,
so the whole search grows as `n · 2^(n/2)` — around 1500 steps at ten qubits,
which is where the timeline's own step limit lands. Its oracle is a single
`mcz` at any width, because the engine takes a gate's control count from the
call.

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
