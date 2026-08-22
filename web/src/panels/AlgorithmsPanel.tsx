import { useCallback, useMemo, useState } from 'react';
import { ColumnChart } from '../charts/ColumnChart';
import { DataTable, TableDisclosure, type Column } from '../components/DataTable';
import { Hero, StatTile } from '../components/StatTile';
import { Status } from '../components/Status';
import type { EngineClient } from '../lib/engineClient';
import { formatMs } from '../lib/format';
import type { EngineInfo, ShorAttempt, ShorResult } from '../lib/protocol';
import { isShorTarget, planShor, primeFactors } from '../lib/shor';

/**
 * Attempts to allow before giving up.
 *
 * Failures are expected, not exceptional: an odd period, or a base whose
 * `a^(r/2)` is −1, both yield nothing and the algorithm simply retries. Roughly
 * half of all bases succeed, so ten attempts makes a run essentially certain
 * without letting a pathological case spin forever.
 */
const MAX_ATTEMPTS = 10;

/**
 * Counting-register size as a multiple of the work register.
 *
 * This, not the qubit total, is what actually caps the number you can factor.
 * The budget goes as `n * (1 + ratio)`, so shrinking the ratio moves qubits from
 * phase precision into the modulus. Textbook Shor uses 2, because recovering the
 * period by continued fractions provably needs `2^t > N^2` — but that bound is
 * conservative, and testing small multiples of each convergent recovers the
 * period even when the estimate is coarse.
 *
 * Measured on 25-26 qubits: ratio 2 reaches 255, ratio 1 reaches 8189 = 19 × 431
 * in one or two attempts. Hence the default is the aggressive end, with the
 * reliable end available when a number resists.
 */
const RATIOS: { value: number; label: string }[] = [
  { value: 1, label: 'largest N (1×) — a few more retries' },
  { value: 1.25, label: 'balanced (1.25×)' },
  { value: 1.5, label: 'cautious (1.5×)' },
  { value: 2, label: 'textbook (2×) — most reliable, smallest N' },
];

export function AlgorithmsPanel({ client, info }: { client: EngineClient; info: EngineInfo }) {
  // Capped at the single-module limit rather than lower: Shor issues well over a
  // hundred sequential gates per attempt, and the sharded path's per-gate cost
  // (hundreds of milliseconds) would turn one attempt into minutes.
  const budget = info.maxQubits;
  const [qubits, setQubits] = useState(budget);
  const [ratio, setRatio] = useState(1);
  const [custom, setCustom] = useState('');
  const [seed, setSeed] = useState(7);
  const [coprimeOnly, setCoprimeOnly] = useState(true);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<ShorResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plan = useMemo(() => planShor(qubits, ratio), [qubits, ratio]);
  const customN = custom.trim() === '' ? null : Number(custom);
  const customValid = customN !== null && Number.isInteger(customN) && isShorTarget(customN);
  const target = customValid ? customN : plan?.modulus ?? null;

  // A custom N needs its own register widths, still within budget.
  const layout = useMemo(() => {
    if (!target) return null;
    const work = Math.max(4, Math.ceil(Math.log2(target + 1)));
    const count = Math.min(Math.max(2, Math.round(work * ratio)), Math.max(2, qubits - work));
    return { work, count, total: work + count };
  }, [target, qubits, ratio]);

  const expected = useMemo(() => {
    if (!target) return '';
    return [...primeFactors(target).entries()]
      .map(([p, e]) => (e > 1 ? `${p}^${e}` : `${p}`))
      .join(' × ');
  }, [target]);

  const run = useCallback(async () => {
    if (!target || !layout) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await client.call<ShorResult>(
        {
          kind: 'runShor',
          modulus: target,
          workQubits: layout.work,
          countQubits: layout.count,
          maxAttempts: MAX_ATTEMPTS,
          seed,
          coprimeOnly,
        },
        (p) => {
          if (p.kind === 'shor') setStage(p.stage);
        },
      );
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setStage(null);
    }
  }, [client, target, layout, seed, coprimeOnly]);

  const correct =
    result?.factors != null && result.factors[0] * result.factors[1] === result.modulus;

  return (
    <>
      <div className="controls">
        <div className="control">
          <label htmlFor="alg-qubits">Qubit budget</label>
          <input
            id="alg-qubits"
            type="number"
            min={12}
            max={budget}
            value={qubits}
            disabled={running}
            onChange={(e) => setQubits(Math.max(12, Math.min(budget, Number(e.target.value) || 12)))}
          />
        </div>
        <div className="control">
          <label htmlFor="alg-n">Number to factor</label>
          <input
            id="alg-n"
            type="number"
            placeholder={plan ? String(plan.modulus) : ''}
            value={custom}
            disabled={running}
            onChange={(e) => setCustom(e.target.value)}
          />
        </div>
        <div className="control">
          <label htmlFor="alg-ratio">Counting register</label>
          <select
            id="alg-ratio"
            value={ratio}
            disabled={running}
            onChange={(e) => setRatio(Number(e.target.value))}
          >
            {RATIOS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div className="control">
          <label htmlFor="alg-seed">Seed</label>
          <input
            id="alg-seed"
            type="number"
            value={seed}
            disabled={running}
            onChange={(e) => setSeed(Number(e.target.value) || 0)}
          />
        </div>
        <div className="control">
          <label htmlFor="alg-coprime">Base selection</label>
          <select
            id="alg-coprime"
            value={coprimeOnly ? 'quantum' : 'faithful'}
            disabled={running}
            onChange={(e) => setCoprimeOnly(e.target.value === 'quantum')}
          >
            <option value="quantum">Force period finding</option>
            <option value="faithful">Allow classical shortcuts</option>
          </select>
        </div>
        <button className="primary" onClick={run} disabled={running || !target || !layout}>
          {running ? 'Factoring…' : 'Run Shor'}
        </button>
      </div>

      {custom.trim() !== '' && !customValid && (
        <div className="banner banner-critical">
          <div>
            <strong>{custom} is not a useful target.</strong> Shor needs an odd composite with at
            least two distinct prime factors — an even number or a prime power both have trivial
            classical shortcuts, so running the quantum routine on them would prove nothing.
          </div>
        </div>
      )}

      {plan && layout && target && (
        <div className="banner">
          <div>
            <strong>
              {qubits} qubits factors numbers up to {plan.maxModulus}.
            </strong>{' '}
            The work register needs ⌈log₂ N⌉ = {layout.work} qubits to hold values mod N; the
            counting register gets {layout.count} ({ratio}×), which sets how precisely the phase — and
            so the period — can be read. The budget therefore goes as n × (1 + {ratio}), which makes
            the counting ratio, not the qubit total, the thing that decides how big N can be. Target{' '}
            <strong>{target}</strong> = {expected}, using {layout.total} of {qubits}.
          </div>
        </div>
      )}

      {error && (
        <div className="banner banner-critical">
          <div>
            <strong>Run failed.</strong> {error}
          </div>
        </div>
      )}

      {running && <p className="progress-line">{stage ?? 'Starting…'}</p>}

      {result && (
        <>
          <Hero
            value={result.factors ? `${result.factors[0]} × ${result.factors[1]}` : 'no factors'}
            unit={`= ${result.modulus}`}
            detail={
              result.factors
                ? `Found by period finding on ${result.totalQubits} qubits in ${result.attempts.length} attempt${
                    result.attempts.length === 1 ? '' : 's'
                  }. The quantum step found the period of a^x mod ${result.modulus}; everything else is arithmetic.`
                : `No factors after ${result.attempts.length} attempts. Odd periods and a^(r/2) ≡ −1 are ordinary Shor failures — raise the attempt count or change the seed.`
            }
          />
          <div className="tiles" style={{ marginTop: 20 }}>
            <StatTile
              label="Verified"
              value={correct ? 'yes' : 'no'}
              sub={correct ? `${result.factors![0]} × ${result.factors![1]} = ${result.modulus}` : 'product does not match'}
            />
            <StatTile label="Attempts" value={String(result.attempts.length)} sub={`of ${MAX_ATTEMPTS} allowed`} />
            <StatTile label="Gates" value={String(result.gates)} sub={`on ${result.totalQubits} qubits`} />
            <StatTile label="Wall time" value={formatMs(result.totalMs)} sub="whole run, in the worker" />
          </div>

          {result.distribution && (
            <div className="card">
              <h2>What the quantum step actually measures</h2>
              <p className="card-note">
                The counting register's distribution after the inverse QFT. The oracle leaves the work
                register periodic in x with period r, and the transform turns that period into peaks
                spaced 2<sup>{result.countQubits}</sup>/r ={' '}
                {result.distribution.peakSpacing?.toFixed(1) ?? '—'} apart. Reading one peak gives a
                phase ≈ s/r, and continued fractions recover r from it. Showing the{' '}
                {result.distribution.x.length} values that carry probability, out of{' '}
                {2 ** result.countQubits} — together{' '}
                {(result.distribution.coverage * 100).toFixed(1)}% of the total.
              </p>
              <ColumnChart
                categories={result.distribution.x.map(String)}
                series={[
                  {
                    label: 'Probability',
                    values: result.distribution.probability,
                    colorVar: '--series-1',
                  },
                ]}
                formatY={(v) => v.toFixed(3)}
                xLabel="Counting register outcome"
                yLabel="Probability"
              />
            </div>
          )}

          <div className="card">
            <h3>Attempts</h3>
            <p className="card-note">
              Shor's algorithm is probabilistic and its failures are ordinary. A period can come out
              odd, or a<sup>r/2</sup> can be −1 mod N, and either yields nothing — so it picks a new
              base and tries again.{' '}
              {result.trueOrder != null && (
                <>
                  The classical order of the last base is {result.trueOrder}, shown only to check the
                  quantum answer.
                </>
              )}
            </p>
            <AttemptTable attempts={result.attempts} countQubits={result.countQubits} />
          </div>
        </>
      )}

      {!result && !running && (
        <div className="card">
          <p className="empty">Run the algorithm to factor {target ?? 'a number'}.</p>
        </div>
      )}
    </>
  );
}

function AttemptTable({ attempts, countQubits }: { attempts: ShorAttempt[]; countQubits: number }) {
  const columns: Column<ShorAttempt>[] = [
    { key: 'n', header: '#', render: (a) => a.attempt },
    { key: 'a', header: 'Base a', render: (a) => a.a },
    {
      key: 'm',
      header: 'Measured',
      render: (a) => (a.measured == null ? '—' : `${a.measured} / ${2 ** countQubits}`),
    },
    { key: 'p', header: 'Phase', render: (a) => (a.phase == null ? '—' : a.phase.toFixed(5)) },
    { key: 'r', header: 'Period r', render: (a) => a.period ?? '—' },
    {
      key: 'f',
      header: 'Factors',
      render: (a) => (a.factors ? `${a.factors[0]} × ${a.factors[1]}` : '—'),
    },
    { key: 'o', header: 'Outcome', render: (a) => a.outcome },
    { key: 's', header: '', render: (a) => <Status pass={a.factors != null} /> },
    { key: 't', header: 'Time', render: (a) => formatMs(a.ms) },
  ];
  return (
    <TableDisclosure label="attempt log">
      <DataTable rows={attempts} columns={columns} />
    </TableDisclosure>
  );
}
