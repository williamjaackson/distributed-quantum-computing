// Smoke test for the sharded bindings, run under Node.
//
// Creates K shards inside ONE module (they are just separate allocations, so
// this is a fine correctness harness) and orchestrates them exactly as the
// browser will: decode the flat plan, run local steps in place, and stage
// blocks through each shard's scratch buffer for pair steps. Then compares
// against the whole-state Simulator.
//
// The plan-decoding below is the reference the TypeScript orchestrator follows.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  initSync, Simulator, Shard, planGate, planShards, baseGates, maxShardQubits, blockAmplitudes,
} from './pkg/rock.js';

const here = dirname(fileURLToPath(import.meta.url));
const wasm = initSync({ module: readFileSync(join(here, 'pkg/rock_bg.wasm')) });
const BASE = baseGates();

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

/** Decode the flat plan emitted by planGate(). */
function decodePlan(enc) {
  let i = 0;
  const steps = [];
  const n = enc[i++];
  for (let s = 0; s < n; s++) {
    const base = BASE[enc[i++]];
    const kind = enc[i++];
    const globalCmask = enc[i++];
    const targetBit = enc[i++];
    const localCmask = enc[i++];
    const nParams = enc[i++];
    const params = Array.from(enc.slice(i, i + nParams)); i += nParams;
    const nQubits = enc[i++];
    const qubits = Array.from(enc.slice(i, i + nQubits)); i += nQubits;
    steps.push({ base, kind, globalCmask, targetBit, localCmask, params, qubits });
  }
  return steps;
}

class ShardedSim {
  constructor(globalQubits, shardBits) {
    this.shardBits = shardBits;
    this.localQubits = globalQubits - shardBits;
    this.nShards = 1 << shardBits;
    this.shards = [];
    for (let w = 0; w < this.nShards; w++) {
      this.shards.push(new Shard(this.localQubits, shardBits, w));
    }
    // Views are taken after every allocation is done: growing WASM memory
    // detaches the buffer and would invalidate anything captured earlier.
    this.sliceAmps = this.shards[0].sliceAmplitudes;
    this.blockAmps = this.shards[0].blockAmplitudes;
    this.numBlocks = this.shards[0].numBlocks;
    this.amps = this.shards.map(s => new Float64Array(wasm.memory.buffer, s.ampsOffset, this.sliceAmps * 2));
    this.scratch = this.shards.map(s => new Float64Array(wasm.memory.buffer, s.scratchOffset, this.blockAmps * 2));
    this.exchanges = 0;
  }

  apply(name, qubits, params = []) {
    const plan = decodePlan(planGate(name, new Uint32Array(qubits), new Float64Array(params), this.localQubits, this.shardBits));
    for (const st of plan) {
      if (st.kind === 0) {
        const controls = st.qubits.slice(0, -1);
        const target = st.qubits[st.qubits.length - 1];
        for (let w = 0; w < this.nShards; w++) {
          if ((w & st.globalCmask) !== st.globalCmask) continue;
          this.shards[w].applyLocalBase(st.base, new Float64Array(st.params), new Uint32Array(controls), target);
        }
      } else {
        const bit = 1 << st.targetBit;
        for (let w = 0; w < this.nShards; w++) {
          if ((w & st.globalCmask) !== st.globalCmask || (w & bit) !== 0) continue;
          this.exchangePair(st, w, w | bit);
        }
      }
    }
  }

  exchangePair(st, low, high) {
    const bs = this.blockAmps * 2;   // f64 slots per block
    for (let b = 0; b < this.numBlocks; b++) {
      const start = b * bs;
      const n = Math.min(bs, this.sliceAmps * 2 - start);
      // Both slices must be staged before either is written: each output row
      // reads both inputs. In the browser the shards live in separate memories,
      // so this temp only exists because this harness shares one.
      const lowBlock = this.amps[low].slice(start, start + n);
      this.scratch[low].set(this.amps[high].subarray(start, start + n));
      this.scratch[high].set(lowBlock);
      this.exchanges += 2;
      this.shards[low].applyPair(st.base, new Float64Array(st.params), b, true, st.localCmask);
      this.shards[high].applyPair(st.base, new Float64Array(st.params), b, false, st.localCmask);
    }
  }

  amplitudes() {
    const out = new Float64Array(this.nShards * this.sliceAmps * 2);
    this.amps.forEach((a, w) => out.set(a, w * this.sliceAmps * 2));
    return out;
  }

  norm() {
    return this.shards.reduce((acc, s) => acc + s.probabilityMass(), 0);
  }
}

const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

console.log(`maxShardQubits=${maxShardQubits()}  blockAmplitudes=${blockAmplitudes()}  baseGates=${BASE.length}\n`);

// Layout planning
{
  const [bits, local, shards, per, total] = planShards(29, 26, 0);
  check('planShards(29) splits into 8 x 26-qubit slices',
    bits === 3 && local === 26 && shards === 8 && per === 1024 ** 3 && total === 8 * 1024 ** 3,
    `${shards} shards x ${(per / 1024 ** 3).toFixed(0)} GiB = ${(total / 1024 ** 3).toFixed(0)} GiB`);
}

// Sharded == whole-state, for a random circuit at every layout
{
  const n = 5;
  const menu = [
    ['h', 1, []], ['x', 1, []], ['y', 1, []], ['z', 1, []], ['t', 1, []],
    ['rx', 1, [0.7]], ['rz', 1, [1.3]], ['u3', 1, [0.6, 1.1, -0.3]],
    ['cx', 2, []], ['cz', 2, []], ['cp', 2, [0.4]], ['swap', 2, []], ['ccx', 3, []],
  ];
  let worst = 0;
  for (let shardBits = 0; shardBits <= n; shardBits++) {
    const sharded = new ShardedSim(n, shardBits);
    const whole = new Simulator(n);
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let step = 0; step < 200; step++) {
      const [name, arity, params] = menu[Math.floor(rnd() * menu.length)];
      const qubits = [];
      while (qubits.length < arity) {
        const q = Math.floor(rnd() * n);
        if (!qubits.includes(q)) qubits.push(q);
      }
      sharded.apply(name, qubits, params);
      whole.applyGate(name, new Uint32Array(qubits), new Float64Array(params));
    }
    const diff = maxDiff(sharded.amplitudes(), whole.amplitudes());
    worst = Math.max(worst, diff);
    check(`shardBits=${shardBits}: 200-gate random circuit matches whole-state`,
      diff < 1e-12 && Math.abs(sharded.norm() - 1) < 1e-12,
      `max amplitude diff ${diff.toExponential(1)}, norm ${sharded.norm().toFixed(12)}, ${sharded.exchanges} block exchanges`);
    whole.free();
    sharded.shards.forEach(s => s.free());
  }
  check('worst deviation across all layouts is at rounding level', worst < 1e-12, worst.toExponential(1));
}

// A GHZ chain across shards, then the mass partition sampling relies on
{
  const n = 6, shardBits = 3;
  const sim = new ShardedSim(n, shardBits);
  sim.apply('h', [0]);
  for (let q = 1; q < n; q++) sim.apply('cx', [q - 1, q]);
  const masses = sim.shards.map(s => s.probabilityMass());
  const total = masses.reduce((a, b) => a + b, 0);
  check(`GHZ(${n}) across ${1 << shardBits} shards: masses partition 1`,
    Math.abs(total - 1) < 1e-12 && Math.abs(masses[0] - 0.5) < 1e-12 && Math.abs(masses[masses.length - 1] - 0.5) < 1e-12,
    `first=${masses[0].toFixed(3)} last=${masses[masses.length - 1].toFixed(3)} total=${total.toFixed(12)}`);
  sim.shards.forEach(s => s.free());
}

// Local gates must not communicate; global ones must.
{
  const n = 6, shardBits = 2, local = n - shardBits;
  const sim = new ShardedSim(n, shardBits);
  for (let q = 0; q < local; q++) sim.apply('h', [q]);
  const afterLocal = sim.exchanges;
  sim.apply('h', [n - 1]);
  check('local gates exchange nothing; a global gate does',
    afterLocal === 0 && sim.exchanges > 0, `local=${afterLocal}, after global=${sim.exchanges}`);
  sim.shards.forEach(s => s.free());
}

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' check(s) failed'}`);
process.exit(failures === 0 ? 0 : 1);
