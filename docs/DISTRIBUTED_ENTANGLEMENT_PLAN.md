# Distributing qsim across browsers: architecture and implementation plan

This document describes how the `qsim` engine — the Rust/WASM state-vector
simulator in `engine/` — is extended to run across multiple machines, each
contributing compute from its own browser tab, in two modes: **shots** and
**expand**. It also describes what was actually built alongside this plan
(`net/signaling-server/`, `web/`) and what still needs hands-on browser
testing before it's production-ready.

## 0. Framing: what is actually being distributed

`qsim` is a classical simulator. Nothing in this plan transmits quantum
entanglement over a network — that isn't physically possible with classical
messages, and isn't what's being built. What *is* distributed is the
**simulation** of an entangled state: either many independent copies of it
(shots mode) or one enormous state vector's slices, spread across enough
machines' RAM to hold it (expand mode). Worth saying plainly once, so the
rest of this document can talk about "entanglement" the way `engine/README.md`
already does — as a property of the simulated register — without it reading
like a claim about physics.

## 1. The two modes, at a glance

| | **Shots mode** | **Expand mode** |
|---|---|---|
| What's split | The *shot count* | The *qubit register* |
| Per-machine qubit cap | Up to the single-module ceiling (26–27, see `engine/README.md`) | `maxShardQubits` (typically 26) per shard; total is `shards × maxShardQubits` |
| Cross-machine traffic during the run | None — only the circuit (small) goes out and each histogram (small) comes back | Every gate that touches a "global" qubit moves 64 MiB blocks between the two shards it pairs (see §4) |
| Speedup shape | Near-linear in machine count, bounded by the slowest machine | Not a speedup — a *capacity* increase; wall-clock per gate can go *up* as shard count grows, because more gates become cross-machine |
| Fault tolerance | A dropped machine costs redone work, never correctness (§3.4) | A dropped shard-holder loses that shard's data permanently; the run must restart (§4.6) |
| Needs a shard layout at all | No | Yes — reuses `shard.rs`'s existing planner unchanged |

Both modes reuse the *same* `engine/pkg` build and the same per-tab
architecture: one dedicated Worker holding one WASM module instance (see
`engine/README.md`'s "K module instances hold K times as much"), talked to
from the tab's main thread over `postMessage`. What differs between modes is
only what that Worker is asked to hold — a full `Simulator` in shots mode, one
`Shard` in expand mode — and what the network carries.

## 2. Network architecture

### 2.1 Signaling

Two browsers cannot find each other unassisted — WebRTC needs a third party
to relay the initial handshake (SDP offers/answers and ICE candidates) before
a direct connection exists. `net/signaling-server/server.mjs` is that third
party: a small Node/`ws` process that does nothing but relay opaque blobs by
peer id inside a room. It never sees circuit definitions, gate data, or block
exchanges — those all move over the WebRTC connections it introduced, never
back through it. Losing the signaling server mid-run does not corrupt
anything in progress; it only prevents a *new* peer from joining after that
point.

Room codes are short (6 characters, unambiguous alphabet), created by the
host, and shared out-of-band (a link, read aloud, however). Rooms expire
after two hours of inactivity so an abandoned session doesn't sit in the
server's memory forever. See the protocol comment at the top of
`server.mjs` for the exact message shapes.

### 2.2 Full mesh, not a star

Every participant — host included — opens a direct `RTCPeerConnection` to
every *other* participant (`web/src/mesh.js`), not just to the host. This
matters specifically for expand mode: a block exchange happens between
whichever two machines hold the two shards a gate pairs, and that is not
always the host. Routing exchange traffic through the host would make it a
bandwidth bottleneck for every run; direct peer-to-peer keeps each exchange's
cost on only the two machines actually involved.

Each connection carries two data channels:

- **`ctrl`** — reliable, ordered, small JSON. Every RPC call and its reply
  (see §5) travels here.
- **`bulk`** — reliable, ordered, chunked binary (see §2.3). Exchange blocks
  travel here, on a separate channel so a multi-megabyte transfer can never
  delay a `ctrl` message behind it (SCTP multiplexes channels on one
  connection independently).

Glare (both sides trying to offer at once) is avoided with a simple rule
instead of full "perfect negotiation": the peer with the lexicographically
smaller id always creates the offer for a given pair. That's sufficient here
because a pair's channels are never renegotiated mid-run.

**NAT traversal**: the default configuration uses only a public STUN server
(`stun:stun.l.google.com:19302`), which is enough on most home and office
networks. Symmetric NATs and some corporate/mobile networks will fail to
connect without a TURN server relaying the actual media — add one to the
`iceServers` list passed into `PeerMesh` (`web/src/mesh.js`'s constructor)
if peers on such networks can't connect. This is the single most likely
real-world snag; budget for it before trying this across the open internet
with machines you don't control the network of.

### 2.3 Chunking

Data channels cap message size well below what a 64 MiB exchange block
needs, so every bulk transfer is split into 64 KiB chunks with a 16-byte
header (`transferId`, sequence, total, payload length — see
`web/src/chunker.js`) and reassembled on the other end. The header exists
even though channels are ordered because a machine can have more than one
logical transfer in flight on the same channel (see §4.5's "one shard per
machine" constraint for why that's still bounded).

## 3. Shots mode

### 3.1 Protocol

The host has a circuit (`[{name, qubits, params}, ...]`), a register size,
and a total shot count. It splits the shots as evenly as possible
(`evenSplit`, largest-remainder not needed since shots are indivisible units
handed out in whole numbers) across itself (optionally) and every connected
peer. Every participant then, independently:

1. `init-simulator` with its qubit count and a *distinct* seed
   (`baseSeed + participantIndex` — distinct seeds, not a cryptographic
   requirement, just enough that no two participants draw the same sample
   stream).
2. `apply-gate` for every gate in the circuit, in order.
3. `sample` for its shot share, returning a sparse `[index, count, ...]`
   histogram.

The host merges every returned histogram by summing counts per basis-state
index (`mergeHistograms` in `web/src/shot-merge.js`). No amplitude data, no
partial state, nothing but the circuit description and the final counts
ever crosses the network. This is why shots mode needs no shard layout, no
full mesh between peers (only host↔peer matters), and scales close to
linearly: total wall time is roughly one participant's build-plus-sample
time, not the sum across all of them.

### 3.2 Where the speedup comes from, and its ceiling

Speedup is bounded by the slowest participant finishing its share — a
machine on a much weaker CPU, or one that also has to build a deep circuit
before it can start sampling, holds up the merge. The current implementation
does *not* dynamically rebalance a slow-but-not-dead participant's remaining
work onto faster ones; it only recovers from an outright disconnect (§3.4).
Adaptive rebalancing (give faster machines a second helping while a slow one
is still working through its first) is a reasonable follow-up and is called
out again in §7.

### 3.3 What never needs to match across participants

Each participant's *entire* register lives on one machine, so shots mode
never touches `engine/src/shard.rs` at all — every participant just runs the
plain `Simulator`. This is deliberate: shots mode's only requirement is that
every participant build the *same* state, which any correct standalone
`Simulator` run already guarantees, with nothing new to get wrong.

### 3.4 Fault tolerance

If a participant disconnects before returning its histogram,
`HostOrchestrator.runShotsMode` notices (its `sample` call rejects) and
re-runs that exact shot count on the host itself once every other
participant has reported in. The host is always available to itself, so this
always terminates — it just costs the time to redo the lost share. See
`web/test/host-orchestrator.test.mjs`'s recovery test for the exact behavior.

## 4. Expand mode

### 4.1 What's reused from the engine, unchanged

Nothing about *deciding* how a gate splits across shards is reimplemented in
JavaScript. `engine/src/shard.rs`'s `plan()` and `plan_gate()` — already
exercised end-to-end against the whole-state `Simulator` by
`engine/tests/sharding.rs` and `engine/smoke-sharded.mjs` — remain the only
code that classifies qubits as local/global and builds the step list. The
browser orchestrator's job (`web/src/shard-plan-bridge.js`) is exactly what
`engine/smoke-sharded.mjs` already does for its in-process harness: decode
the flat plan Rust handed back, and iterate it. `engine/README.md` says this
outright — "the browser side only executes, never decides" — and this plan
keeps that boundary exactly where it already was; it just moves "executes"
from same-process shards to separate machines.

### 4.2 Shard layout and the one-shard-per-machine constraint

`plan_shards(globalQubits, maxShardQubits, minShardBits)` returns
`shard_bits`, `local_qubits`, and `shards = 2^shard_bits`, precisely as it
does today. The orchestrator then needs exactly `shards` machines, each
holding **exactly one** shard (`web/src/host-orchestrator.js`,
`web/src/exchange.js`). This is a deliberate simplification: with one shard
per machine, a machine has at most one active exchange partner at any given
step (a shard has exactly one partner for a given target bit), so there's
never a need to disambiguate which of several concurrent exchanges a given
block belongs to. Supporting several shards per machine — useful for a
beefy machine that wants to contribute proportionally more — is possible but
needs per-shard-pair transfer tagging added to `exchange.js`; it's called
out in §7 rather than built now, to keep the first version's concurrency
story simple enough to fully verify.

### 4.3 The gate loop

For each gate in the circuit, in order:

1. The host calls `plan-gate` (its own local wasm instance — the host always
   runs a copy of the engine for planning, whether or not it also holds a
   shard) and decodes the result into steps.
2. For each **local** step (`kind: 'local'`), the host tells every shard
   whose id satisfies the step's `globalCmask` (`participantShards`) to run
   `apply-local-base` — no network traffic beyond that one small instruction.
3. For each **pair** step (`kind: 'pair'`), the host computes the
   `[low, high]` shard pairs (`exchangePairs`) and tells both owners to run
   a block exchange with each other directly (§4.4) — the host names the
   partner but never sees the data.
4. The host waits for every step's participants to finish before starting
   the next step.

That last point — a full barrier every step — is the simplest correct choice,
not the fastest one. Steps touching disjoint shard subsets (e.g. two
independent pair exchanges within the same step already run concurrently;
that part is *not* serialized) could in principle pipeline across gate
boundaries too, letting a shard that finished its part of gate *N* start
gate *N+1* while another shard is still finishing gate *N*. Getting that
right requires tracking per-shard dependencies precisely enough to never let
a shard apply gate *N+1* on data that hasn't yet received gate *N*'s
exchange — solvable, but a correctness-sensitive optimization best done as a
follow-up with its own test coverage, not folded into the first version.

### 4.4 The block exchange, and why it's bandwidth-bound

A pair step needs both shards' full slices, but neither side can afford a
second buffer that size — so, exactly as `engine/src/shard.rs` already does
for same-process shards, the exchange runs in fixed 64 MiB blocks
(`BLOCK_AMPS`), keeping peak memory at one slice plus one block on each
machine. `web/src/exchange.js` runs the identical lockstep on both sides:
send my block *b* (read via `read-own-block`, a copy of the *pre-update*
slice — see the ordering note in `engine-worker.js`), wait for the partner's
block *b*, stage it (`stage-partner-block`) and apply the pair kernel
(`apply-pair`) for that block, then move to *b+1*. Neither side can get more
than one block ahead of the other.

This is the part of expand mode that is fundamentally bandwidth-bound: every
gate that touches a global qubit moves the *entire* pair of shards' slices
across the network, once each direction, every time. A 26-qubit shard is
1 GiB; a circuit with even a modest number of global-qubit gates will move
tens of gigabytes over the wire. Expand mode buys you qubits you could not
otherwise address at all, in exchange for a per-gate cost that plain
same-machine sharding doesn't pay (that pays only for *inter-process* memory
bandwidth, not a home network's). Two consequences worth planning around:

- Put circuits' entangling structure in mind when choosing which qubits are
  "local" vs "global": if a circuit's global-qubit gates are rare, the
  network cost is rare too. A circuit that entangles broadly across all
  qubits on every layer will spend most of its wall-clock time exchanging
  blocks, on any network slower than the RAM bus a single-machine sharded
  run would use instead.
- Fewer, larger shards (more `local_qubits`, fewer `shard_bits`) means fewer
  pair steps need a network exchange at all, at the cost of needing more RAM
  per machine. `maxShardQubits` is the knob; the UI's "max qubits per shard"
  field sets it directly.

### 4.5 Sampling

Once the circuit is done, the host asks every shard for its
`probability-mass`, allocates the requested total shot count across shards
in proportion to that mass (`stratifiedShotAllocation`, largest-remainder so
the allocation sums exactly), and asks each shard to `sample-local`
independently. `engine/src/measure.rs`'s `sample_unnormalised` already draws
uniforms in `[0, mass)` specifically so this is exact within a slice without
ever forming the global distribution — expand mode's sampling step needed no
new engine code, only the orchestration to allocate and remap
(`globalIndex`, mirroring `shard.rs`'s documented
`global = (shard_id << local_qubits) | local` split) shard-local results into
one merged histogram.

### 4.6 Fault tolerance — read this before running anything that matters

Unlike shots mode, **a shard's amplitude data lives on exactly one machine,
with no replica anywhere.** If that machine drops mid-circuit, the state is
gone; there is nothing to recover it from, because nothing else in the
system ever held a copy (replicating every shard would double the memory and
bandwidth cost this whole mode exists to spread out — a real trade-off, not
an oversight). `HostOrchestrator.runExpandMode` checks for a disconnected
owner before and after every step and raises a clear error the moment it
detects one; it does not attempt to paper over the loss. Practically: run
expand mode on machines you have some reason to trust will stay connected
for the duration (a LAN you control, or at least a warning to participants
before a long run), and treat a failed run as "restart it," not "resume it."
Checkpointing shard state periodically (so a restart resumes from the last
checkpoint instead of from scratch) is a real option for long-running
circuits and is listed as future work in §7 rather than built now.

## 5. Wire protocol reference

**Signaling** (`web/src/protocol.js`'s `SIG`): `create-room`,
`room-created`, `join-room`, `joined`, `join-failed`, `peer-joined`,
`peer-left`, `signal`, `error` — see `net/signaling-server/server.mjs`'s
header comment for the exact JSON shapes.

**Mesh RPC**: every call is `{id, t, ...args}`; every reply is
`{id, ok:true, result}` or `{id, ok:false, error}`. The vocabulary of `t`
values is *not* a separate enum to keep in sync by hand — it is exactly
`engine-worker.js`'s command set (`init-simulator`, `apply-gate`, `sample`,
`init-shard`, `reset-shard`, `apply-local-base`, `probability-mass`,
`sample-local`, `plan-shards`, `plan-gate`, `base-gates`, ...), forwarded
verbatim by `peer-runtime.js`, plus exactly one orchestration-level command,
`start-exchange`, that means "go run the block-exchange lockstep with the
named partner" rather than a single wasm call. See the top-of-file comment
in `web/src/protocol.js`.

**Chunk header** (`web/src/chunker.js`): 16 bytes, little-endian —
`transferId: u32`, `seq: u32`, `total: u32`, `payloadLen: u32` — followed by
up to 64 KiB of payload.

## 6. What was built, and how to run it

```
net/signaling-server/   Node/ws relay — `npm install && npm start` (defaults to :8787)
web/                     Everything that runs in the browser
  index.html             The control page (open directly, or serve statically)
  src/                   protocol.js, chunker.js, mesh.js, signaling-client.js,
                         rpc.js, exchange.js, shard-plan-bridge.js, shot-merge.js,
                         engine-worker.js, worker-bridge.js, host-orchestrator.js,
                         peer-runtime.js, app.js
  test/                  `npm test` — see §6.2
docs/                    this file
```

### 6.1 End-to-end run

1. `cd engine && ./build.sh` — produces `engine/pkg/`, which `web/src/engine-worker.js`
   imports directly (as `../../engine/pkg/qsim.js`). This sandbox's network
   policy blocked fetching the `wasm32-unknown-unknown` Rust target, so
   `pkg/` could not be built or exercised here — run this step on a machine
   with normal network access (the existing `engine/README.md` already
   documents this exact step, so if you've built the engine before, nothing
   about that has changed).
2. `cd net/signaling-server && npm install && npm start`.
3. Serve `web/` over HTTP (it uses ES module imports and a Worker, both of
   which require a real origin — `python3 -m http.server` or any static
   file server from inside `web/` works) and open it in one tab: click
   **Create room**, note the room code or copy the share link.
4. Open the share link (or the same page with `?room=CODE` — and
   `&signal=...` if the signaling server isn't on `localhost:8787`) in
   another tab, another browser, or another machine on the same network.
5. On the host tab, pick a mode, pick or write a circuit, and click **Run**.

### 6.2 What's covered by the tests included here, and what isn't

Everything in `web/test/` and `net/signaling-server/test/` (93 tests total,
all passing as of this plan — 30 Rust correctness tests + 18 Rust sharding
tests, unaffected and unmodified by any of this, plus 40 new JS unit/
integration tests and 5 signaling-server tests) runs in plain Node with no
browser: chunking round-trips, the shard-plan decode/pairing arithmetic
(hand-verified against `shard.rs`'s documented bit-math), histogram merging
and stratified sampling allocation, the worker-bridge and mesh-RPC
request/response correlation, the signaling server against real WebSocket
clients, and — the one that matters most — a full `runExpandMode` run with
a real `HostOrchestrator`, a real `PeerRuntime`, and real `exchange.js`
logic wired through a fake two-node network fabric, checked to confirm each
side actually received the *other* side's data (not its own, not nothing)
and applied the pair kernel with the roles `Step::pairs` assigns.

What is **not** covered, because it requires an actual browser (and, for a
realistic check, two actual machines): real `RTCPeerConnection` negotiation
(offer/answer/ICE across a real network, including behind NAT), the Worker
message-transfer path in `engine-worker.js` against the *real* wasm module
(memory-view correctness under `memory.grow`, the exact behavior this file's
comments reason about but can't execute here), and the UI in `index.html`
end to end. Try the two-tabs-on-`localhost` flow in §6.1 first — it
exercises the full stack except cross-machine NAT traversal — before
trying it across two separate machines or networks.

## 7. Known limitations and deferred work

- **No pipelining across steps or gates.** Every step barriers on every
  participant. Correct, simple, and leaves real speed on the table for
  circuits where many steps touch disjoint shard subsets. (§4.3)
- **One shard per machine.** A beefy machine can't yet host two shards to
  contribute proportionally more compute/memory than a weaker one. (§4.2)
- **No adaptive shot rebalancing in shots mode.** A slow-but-connected
  participant is waited on in full; only an outright disconnect is
  recovered from. (§3.2)
- **No shard checkpointing.** A dropped shard-holder always means restarting
  expand mode from scratch, however long the run had gotten. (§4.6)
- **STUN only by default.** Peers behind symmetric NATs or restrictive
  corporate/mobile networks will need a TURN server added to
  `PeerMesh`'s `iceServers`. (§2.2)
- **No room passphrase.** Anyone with a room code can join and, if the host
  assigns them a shard or shot-worker role, run wasm code on the host's
  behalf. Fine among trusted machines; add a passphrase check in
  `server.mjs` before using this across people you don't already trust.
- **The UI's shard-count estimate (`1 << (qubits - maxShardQubits)`) is a
  local approximation of `plan_shards`**, computed before the real wasm call
  so the page can build an assignment list without an extra round trip.
  `runExpandMode` re-derives the authoritative count from the real
  `plan_shards` call and raises a clear error on any mismatch, so this can
  never silently misbehave — worth knowing about if the UI ever asks for a
  different number of machines than expected.
