// Smoke test for the *built* WASM artifact, run under Node.
//
// `cargo test` covers the Rust core on the host; this checks the thing that
// actually ships — that the module instantiates, the camelCase bindings line up,
// and the memory ceiling behaves. Run with: node engine/smoke.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initSync, Simulator, maxQubits, canAllocate, memoryBytesRequired, engineVersion, fullArrayQubitLimit } from './pkg/qsim.js';

const here = dirname(fileURLToPath(import.meta.url));
initSync({ module: readFileSync(join(here, 'pkg/qsim_bg.wasm')) });

const gib = (b) => (b / 1024 ** 3).toFixed(2) + ' GiB';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

console.log(`qsim v${engineVersion()}  maxQubits=${maxQubits()}  fullArrayLimit=${fullArrayQubitLimit()}\n`);

// Bell state
{
  const s = new Simulator(2);
  s.prepareBell();
  const p = s.probabilities();
  check('Bell state is 50/50 over |00> and |11>',
    Math.abs(p[0] - 0.5) < 1e-12 && Math.abs(p[3] - 0.5) < 1e-12 && p[1] === 0 && p[2] === 0,
    `[${Array.from(p).map((v) => v.toFixed(3)).join(', ')}]`);
}

// GHZ marginals
{
  const s = new Simulator(8);
  s.prepareGhz();
  const marg = Array.from({ length: 8 }, (_, q) => s.probabilityOfOne(q));
  check('GHZ(8): every qubit marginal is 0.5', marg.every((m) => Math.abs(m - 0.5) < 1e-12));
  check('GHZ(8): norm preserved', Math.abs(s.norm() - 1) < 1e-12);
}

// Grover
{
  const n = 12, marked = 2731;
  const s = new Simulator(n);
  const iters = s.runGrover(marked, -1);
  const p = s.probabilities();
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
  check(`Grover n=${n} peaks on the marked state after ${iters} iterations`,
    best === marked && p[marked] > 0.9, `P(marked)=${p[marked].toFixed(4)}`);
}

// Gate dispatch by name
{
  const s = new Simulator(3);
  s.applyGate('h', [0], []);
  s.applyGate('cx', [0, 1], []);
  s.applyGate('ccx', [0, 1, 2], []);
  const p = s.probabilities();
  check('h + cx + ccx builds a GHZ-like superposition',
    Math.abs(p[0] - 0.5) < 1e-12 && Math.abs(p[7] - 0.5) < 1e-12);
}

// Errors surface as JS exceptions rather than trapping the module
{
  let threw = '';
  try { new Simulator(3).applyGate('bogus', [0], []); } catch (e) { threw = String(e); }
  check('unknown gate throws a readable error', threw.includes('bogus'), threw);

  threw = '';
  try { new Simulator(3).applyGate('cx', [1, 1], []); } catch (e) { threw = String(e); }
  check('duplicate qubit throws', threw.length > 0, threw);
}

// Sampling
{
  const s = new Simulator(4);
  s.prepareUniform();
  const flat = s.sampleFlat(10000, 42);
  let total = 0;
  for (let i = 1; i < flat.length; i += 2) total += flat[i];
  check('sampling conserves shot count', total === 10000, `${total} shots`);
}

// Capacity: walk upward until allocation is refused.
{
  let maxOk = 0;
  for (let n = 1; n <= maxQubits(); n++) {
    if (!canAllocate(n)) break;
    maxOk = n;
  }
  check(`allocated up to ${maxOk} qubits (${gib(memoryBytesRequired(maxOk))}) under Node`, maxOk >= 20);

  const s = new Simulator(Math.min(maxOk, 22));
  const t0 = performance.now();
  const gates = s.benchLayers(5);
  const ms = performance.now() - t0;
  check(`benchmark ran ${gates} gates on ${s.nQubits} qubits`,
    gates > 0 && Math.abs(s.norm() - 1) < 1e-6,
    `${ms.toFixed(1)} ms, ${(gates / (ms / 1000) / 1000).toFixed(1)}k gates/s, norm=${s.norm().toFixed(12)}`);
}

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' check(s) failed'}`);
process.exit(failures === 0 ? 0 : 1);
