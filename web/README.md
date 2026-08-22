# Test bench

Vite + React + TypeScript front end for the `qsim` engine.

Requires the WASM package first — `engine/pkg` is a build artifact, not checked in:

```sh
npm run build:wasm     # from the repo root
npm --prefix web run dev
```

`web/package.json` depends on `qsim` via `file:../engine/pkg`, so a rebuild of the
engine is picked up without reinstalling.

## Everything runs in a worker

`src/worker/qsim.worker.ts` owns the WASM module and every state vector. A probe
near capacity allocates a couple of gigabytes and blocks for seconds per
measurement, which would freeze the page on the main thread. The worker also
processes messages serially — deliberate, since concurrent multi-gigabyte
allocations would fight over the same WASM heap.

`src/lib/engineClient.ts` wraps it in promise-based RPC with progress callbacks,
so the capacity probe can stream each measurement as it lands.

Simulator handles are released with an explicit `.free()`. JS finalisation is not
prompt enough to hand back a 1 GiB buffer before the next allocation is tried.

## The three panels

**Capacity benchmark** walks the qubit count from 8 upward, timing a fixed gate
workload at each size until the browser refuses the allocation. The layer count
adapts per size to hit a wall-clock target — at 8 qubits a single layer is
microseconds, and near capacity one layer already takes seconds. Reports the
stop reason explicitly, including when it stopped on the time budget rather than
the real ceiling, so a truncated run never reads as a complete one.

**Algorithm tests** runs Shor's algorithm, factoring the largest number the qubit
budget allows.

Shor's is mostly classical — the only quantum step is finding the period of
`a^x mod N`. `src/lib/shor.ts` holds the arithmetic (choosing a target, picking a
base, continued fractions, gcd) and the worker runs the circuit: superpose the
counting register, apply the modular-exponentiation oracle, inverse QFT, measure.

The oracle is applied straight to the amplitude array rather than decomposed into
gates. A gate-level modular multiplier costs thousands of Toffolis plus its own
ancillas, which would dominate both the qubit budget and the runtime while
teaching nothing about period finding — the part that is actually quantum.
Grover's oracle is handled the same way.

**The counting ratio, not the qubit total, decides how large a number fits.** The
work register needs `n = ⌈log₂ N⌉`; the counting register gets `n × ratio` and
sets the phase precision. So the budget goes as `n × (1 + ratio)`. Textbook Shor
uses ratio 2, because recovering the period provably needs `2^t > N²` — but that
bound is conservative, and testing small multiples of each continued-fraction
convergent recovers the period even from a coarse estimate. Measured on 26
qubits: ratio 2 reaches 255, ratio 1 reaches **8189 = 19 × 431** in one or two
attempts. Hence the default is the aggressive end.

Failed attempts are ordinary, not bugs: a period can come out odd, or `a^(r/2)`
can be −1 mod N, and either yields nothing, so the algorithm retries with a new
base. Bases sharing a factor with N are also skipped by default — gcd hands over
a factor for free, which is legitimate Shor but for small N crowds out the
quantum path entirely (half of all bases below 15 factor it classically).

### Factoring across shards

Sharding fits this circuit far better than it looks. The counting register sits in
the high index bits, so a shard id *is* the top of `x`, which means:

- the **oracle needs no communication** — `a^x = a^(offset) · a^(x_low)`, so each
  shard derives its own starting power from its index and permutes only its local
  work register;
- the **marginal needs no communication** — the work register being traced out is
  the low bits, and slices in shard order are already in ascending `x`.

Only the inverse QFT crosses boundaries. Two things cut that sharply, and the
second was a surprise:

The forward transform is `swaps ∘ core`, so the inverse is `core⁻¹ ∘ swaps` and
the swaps come *first*. Simply omitting them permutes the input, not the output,
and gives a wrong answer. But conjugating by the swap network relabels qubits, so
running the core on **reversed** qubit indices moves the permutation to the end,
where dropping it really is just reversing the readout bits.

That also reorders the loop — and this is where the win is. The controlled phases
for step `j` number `j`, so with reversed labels the shard-id qubits land at the
*start* of the loop where they carry the fewest of them. Measured at 8 shards:
**6 cross-shard gates instead of 39.**

| | Single module | Sharded |
| --- | --- | --- |
| Largest N | 8189 = 19 × 431 | **16383 = 381 × 43** |
| Qubits | 26 | 28 |
| Wall time | 8.5 s | 11 s |
| Cross-shard gates | — | 3 |

Verified against the single-module path at 4 and 8 shards on N = 15, 33 and 255:
identical factors and identical measured phases.

This replaces the earlier engine-test tab. The correctness suite still runs under
`cargo test` (55 tests), and factoring exercises the QFT, the oracle and
measurement end-to-end against an answer that is checkable by multiplication.

**Sharded capacity** spreads one register across many workers, each owning a
26-qubit slice in its own WASM module, and walks upward. This is what gets past
the single-module ceiling: 26 qubits in one module, **29** across eight.

**Playground** applies gates one at a time to a small register, with a live
probability distribution and amplitude table.

## The sharded orchestrator

`src/lib/shardedEngine.ts` drives `src/worker/shard.worker.ts`, one worker per
slice. Every orchestration *decision* — which shards take part, which pair with
which, what the control masks are — comes from `planGate` in the engine, so the
subtle part is covered by Rust tests rather than reimplemented here. This side
only executes.

The orchestrator loads its own planning-only WASM instance (no slice allocated,
so the cost is the 54 KB module) rather than round-tripping to a worker per gate.

Exchanges move blocks with transferable `ArrayBuffer`s, so the relay through the
main thread is an ownership move rather than a copy — the only real copies are
WASM-to-JS and JS-to-WASM inside the workers. Nothing here needs
`SharedArrayBuffer`, which means no COOP/COEP headers and no restrictions on
where this can be hosted.

### Validating a qubit count

"The allocation succeeded" is a very weak claim, and the probe originally rested
on it. A fresh state vector is all zeros, and zero pages are nearly free — the OS
commits them lazily and its compressor squashes them away. Measured in Chrome:

| Operation | Time |
| --------- | ---- |
| Allocate 6 GiB of zeros | **13 ms** (~460 GB/s — nothing was written) |
| Write 1 GiB of varied data | **~820 ms** |

Worse, the old workload left the register almost entirely zero: two Hadamards on
a fresh state touch exactly **four** amplitudes at any size, so at 30 qubits
99.9999996% of 16 GiB was zero bytes. A size could pass while being unusable.

So each size is now: allocate every slice → **fill with random amplitudes** so no
page is left as free zeros → normalise → time gates → check the norm survived.
The fill doubles as the honest worst case, since real circuits spread amplitude
across every basis state within a few layers.

Sizes get a verdict rather than a boolean: `viable`, `degraded` (allocated and
filled but thrashing), `refused`, or `skipped`.

The verdict uses an **absolute** bandwidth floor, not a fraction of the best size
seen. Two things break a relative rule: bandwidth *rises* with worker count
(measured ~20 GB/s on one worker, ~95 on four), so sizes with different shard
counts are not comparable; and a running peak makes a verdict depend on the order
sizes happened to be measured in. An absolute floor works because DRAM and swap
are two orders of magnitude apart.

Gates are timed cold and warm separately. The first gate after a fill pays
first-touch page faulting, and attributing that to the steady-state rate is what
made an earlier run report false `degraded` verdicts.

**A memory budget still caps the walk**, because overshooting RAM does not fail
gracefully: the browser kills the tab and takes the results with it. Partial
results are written to `localStorage` after every size, so a crash still leaves a
record of where it stopped.

### Sizing the budget to the actual machine

`navigator.deviceMemory` cannot do this. It is deliberately coarse **and capped
at 8** to limit fingerprinting, so it reads 8 on a 16 GB machine and 8 on a
128 GB one, and it is absent entirely outside a secure context (so, missing when
served over plain HTTP to a LAN address). There is no web API for total RAM.

So `src/lib/memoryProbe.ts` measures it: commit chunks of real, varied data and
watch the write rate. What that reveals is not a cliff but two knees, measured on
a 16 GB M4:

```text
 0.5 - 6.5 GiB   7-18 GB/s   uncompressed, free pages available
 7.0 - 7.5 GiB   1-2  GB/s   transition: the OS compressor engages
 8.0 - 14  GiB   ~3   GB/s   compressed - still works, roughly 4x slower
```

It committed the full 14 GiB on a 16 GB machine without dying. That is precisely
why a budget larger than RAM appears to work, and why "did it allocate" is
worthless as a test. The reported figure is the **first** knee.

Getting that detection right took two corrections, both worth keeping in mind:

- The first chunk is unrepresentatively fast (cache-resident template, fresh
  heap). Including it made the probe report 1 GiB on a machine `vm_stat` showed
  had 6.9 GiB free. Warm-up chunks are now excluded.
- The knee is measured against a **stable baseline of the same measurement**, not
  a running peak. This is relative where the qubit-count verdict is absolute, and
  the difference is real: chunk-to-chunk here is like-for-like, whereas the
  qubit-count probe compares configurations with different worker counts. The
  uncompressed rate is a property of the machine, so a fixed GB/s figure would
  misjudge slower and faster hardware alike.

The transition is noisy — one chunk dipped to 1.16 GB/s then recovered to 3.5 —
so the decision rests on a rolling median, never a single sample. The budget is
a plain numeric input, so it can always be set by hand regardless of what the
probe or the browser says.

Views over WASM memory are re-derived whenever the buffer identity changes.
Growing WASM memory replaces the `ArrayBuffer` and detaches every view over the
old one, and any call passing a `Vec` across the boundary can allocate — so
caching a view for the worker's lifetime would be a latent crash.

## Charts

Hand-rolled SVG (`src/charts/`) rather than a charting library, so the mark specs
land exactly: 2px lines, ≥8px markers with a 2px surface ring, a 2px surface gap
between adjacent bars, solid hairline gridlines, dashed lines reserved for
limits. Charts render at measured pixel width instead of scaling a fixed
viewBox, which keeps hairlines hairline at any container size.

Colors come from the data-viz reference palette. The three categorical slots in
use were checked with the palette validator in both light and dark on the
all-pairs list: worst CVD ΔE 9.2 light / 9.4 dark, worst normal-vision ΔE 24.0
light / 20.9 dark. Light-mode aqua sits at 2.74:1 against the surface, below the
3:1 bar, so the relief rule applies — every chart carries a table view, which is
also what keeps any value from being hover-only.

Dark mode is its own selection from the same ramps, not an inverted light mode.
