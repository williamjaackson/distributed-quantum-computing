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

**Engine tests** re-runs Bell, GHZ, QFT period-finding, Grover, teleportation,
long-circuit unitarity and sampling convergence against expected values taken
from the physics. Same WASM build the benchmark uses, so a pass here says
something about the shipped artifact.

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
gracefully: the browser kills the tab and takes the results with it (measured —
8 GiB succeeded, 16 GiB killed the renderer). The default comes from
`navigator.deviceMemory`, which is deliberately coarse and capped at 8, so it
reads as a conservative lower bound. Partial results are written to
`localStorage` after every size, so a crash still leaves a record of where it
stopped.

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
