import { useCallback, useEffect, useMemo, useState } from 'react';
import { LineChart } from '../charts/LineChart';
import { DataTable, TableDisclosure, type Column } from '../components/DataTable';
import { Hero, StatTile } from '../components/StatTile';
import { formatBytes, formatCount, formatMs } from '../lib/format';
import {
  DEFAULT_MEMORY_PROBE,
  deviceMemoryGiB,
  fallbackBudgetBytes,
  measureUsableMemory,
  suggestBudgetBytes,
  type MemoryProbeResult,
} from '../lib/memoryProbe';
import {
  DEFAULT_PROBE_OPTIONS,
  initPlanning,
  maxQubitsForBudget,
  probeSharded,
  type ShardedProbePoint,
  type ShardedProbeResult,
  type SizeVerdict,
} from '../lib/shardedEngine';

/** All one WASM module can hold as a single allocation. */
const SINGLE_MODULE_BYTES = 1024 ** 3;
const GIB = 1024 ** 3;

const VERDICT_LABEL: Record<SizeVerdict, string> = {
  viable: 'Viable',
  degraded: 'Degraded',
  refused: 'Refused',
  skipped: 'Not attempted',
};

/** Icon plus text — never colour alone, and these sit beside series hues. */
function Verdict({ verdict }: { verdict: SizeVerdict }) {
  const cls =
    verdict === 'viable' ? 'status-pass' : verdict === 'degraded' ? 'status-warn' : 'status-fail';
  const icon = verdict === 'viable' ? '✓' : verdict === 'degraded' ? '!' : '✕';
  return (
    <span className={`status ${cls}`}>
      <span className="status-icon" aria-hidden="true">
        {verdict === 'skipped' ? '·' : icon}
      </span>
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

/**
 * What the machine actually has, versus what it admits to.
 *
 * Worth showing side by side: `navigator.deviceMemory` is capped at 8 and absent
 * outside a secure context, so a reader who sees "8" needs to know that is the
 * API's ceiling and not their hardware.
 */
function MemoryReadout({
  memory,
  reportedGiB,
}: {
  memory: MemoryProbeResult | null;
  reportedGiB: number | null;
}) {
  if (!memory) {
    return (
      <div className="banner">
        <div>
          <strong>Budget defaults to a floor, not a measurement.</strong>{' '}
          {reportedGiB === null ? (
            <>
              <span className="mono">navigator.deviceMemory</span> is unavailable here — it needs a
              secure context, so it is absent over plain HTTP to a LAN address.
            </>
          ) : (
            <>
              <span className="mono">navigator.deviceMemory</span> reports {reportedGiB} GiB, but the
              Device Memory API <em>caps that value at 8</em> to limit fingerprinting — it reads 8 on
              a 16 GB machine and 8 on a 128 GB one, so it cannot describe a large machine.
            </>
          )}{' '}
          There is no web API for total RAM, so press <strong>Detect</strong> to measure this one, or
          just type a budget.
        </div>
      </div>
    );
  }

  const knee = memory.stop === 'knee';
  return (
    <div className="banner banner-good">
      <div>
        <strong>
          Measured {Math.floor(memory.fastBytes / GIB)} GiB committable at full speed
        </strong>{' '}
        (peak {memory.peakGBps.toFixed(0)} GB/s
        {memory.baseline && `, knee below ${memory.baseline.kneeAtGBps.toFixed(1)} GB/s`},{' '}
        {(memory.elapsedMs / 1000).toFixed(1)} s).{' '}
        {knee ? (
          <>
            Past that the write rate fell away as the OS compressor engaged. Memory beyond the knee
            still works — measured about 4x slower — which is exactly why a budget larger than RAM
            can appear to succeed.
          </>
        ) : (
          <>
            Stopped at {(memory.committedBytes / GIB).toFixed(0)} GiB without finding a knee
            ({memory.stop}), so this is a lower bound on the machine.
          </>
        )}{' '}
        {reportedGiB !== null && (
          <>
            For comparison, <span className="mono">navigator.deviceMemory</span> reports{' '}
            {reportedGiB} GiB — that API is capped at 8.
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One chip per size attempted — the at-a-glance answer.
 *
 * Categorical outcomes belong in labelled chips, not a chart: there is nothing
 * to compare along a scale, only a state to read per size. Each chip carries its
 * qubit count and a short reason, so colour reinforces rather than carries.
 */
function VerdictLadder({ points, floorGBps }: { points: ShardedProbePoint[]; floorGBps: number }) {
  const reason = (p: ShardedProbePoint) => {
    // Number.isFinite also covers null, which is what NaN becomes once a point
    // has round-tripped through the localStorage crash record.
    const bw = Number.isFinite(p.bandwidthGBps) ? p.bandwidthGBps : null;
    switch (p.verdict) {
      case 'viable':
        return bw === null ? 'measured' : `${bw.toFixed(0)} GB/s`;
      case 'degraded':
        return bw === null ? 'swapping' : `${bw.toFixed(1)} GB/s — swapping`;
      case 'refused':
        return 'refused';
      case 'skipped':
        return 'over budget';
    }
  };
  return (
    <div className="card">
      <h2>Every size attempted</h2>
      <p className="card-note">
        A size counts as viable only if it allocated, filled with real amplitudes, and then ran a
        gate at {floorGBps} GB/s or better. DRAM delivers tens of GB/s and swap well under one, so
        that floor separates computing from thrashing by a wide margin.
      </p>
      <div className="ladder">
        {points.map((p) => (
          <span key={p.qubits} className={`ladder-chip ladder-${p.verdict}`}>
            <span className="n">{p.qubits}</span>
            <span className="meta">
              {VERDICT_LABEL[p.verdict]} · {reason(p)}
            </span>
          </span>
        ))}
      </div>
      <div className="ladder-legend">
        {(['viable', 'degraded', 'refused', 'skipped'] as SizeVerdict[]).map((v) => (
          <span key={v} className="ladder-key">
            <i className={`key-${v}`} aria-hidden="true" />
            {VERDICT_LABEL[v]}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ShardedPanel() {
  const reportedGiB = useMemo(() => deviceMemoryGiB(), []);
  const [budgetGiB, setBudgetGiB] = useState(() => fallbackBudgetBytes() / GIB);
  const [memory, setMemory] = useState<MemoryProbeResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectProgress, setDetectProgress] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [live, setLive] = useState<ShardedProbePoint[]>([]);
  const [result, setResult] = useState<ShardedProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    initPlanning()
      .then(() => alive && setReady(true))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  const detect = useCallback(async () => {
    setDetecting(true);
    setError(null);
    setDetectProgress(null);
    try {
      const res = await measureUsableMemory(DEFAULT_MEMORY_PROBE, (step) =>
        setDetectProgress(
          `${(step.committedBytes / GIB).toFixed(1)} GiB committed at ${step.chunkGBps.toFixed(1)} GB/s`,
        ),
      );
      setMemory(res);
      setBudgetGiB(suggestBudgetBytes(res.fastBytes) / GIB);
      // Give the OS a moment to reclaim before anything else allocates.
      await new Promise((r) => setTimeout(r, 750));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetecting(false);
      setDetectProgress(null);
    }
  }, []);

  const budgetBytes = budgetGiB * GIB;
  const ceiling = maxQubitsForBudget(budgetBytes);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setLive([]);
    setResult(null);
    try {
      const res = await probeSharded(
        { ...DEFAULT_PROBE_OPTIONS, budgetBytes },
        (p, n) => {
          setStage(`${n} qubits`);
          if (p.verdict !== 'skipped') setLive((prev) => [...prev, p]);
        },
      );
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setStage(null);
    }
  }, [budgetBytes]);

  const points = running || !result ? live : result.points;
  const attempted = points.filter((p) => p.verdict === 'viable' || p.verdict === 'degraded');
  const viable = points.filter((p) => p.verdict === 'viable');
  const best = viable[viable.length - 1];
  const x = points.map((p) => p.qubits);

  if (error && !ready) {
    return (
      <div className="banner banner-critical">
        <div>
          <strong>Could not load the engine.</strong> {error}
        </div>
      </div>
    );
  }
  if (!ready) return <p className="progress-line">Loading engine…</p>;

  return (
    <>
      <div className="controls">
        <div className="control">
          <label htmlFor="budget">Memory budget (GiB)</label>
          <input
            id="budget"
            type="number"
            min={1}
            max={512}
            step={1}
            value={budgetGiB}
            disabled={running || detecting}
            onChange={(e) =>
              setBudgetGiB(Math.max(1, Math.min(512, Number(e.target.value) || 1)))
            }
          />
        </div>
        <button className="secondary" onClick={detect} disabled={running || detecting}>
          {detecting ? 'Measuring…' : 'Detect'}
        </button>
        <button className="primary" onClick={run} disabled={running}>
          {running ? 'Probing…' : points.length ? 'Run again' : 'Run sharded probe'}
        </button>
        <p className="control-hint">
          At each size: allocate, fill with real amplitudes, then time gates. Stops at {ceiling}{' '}
          qubits for this budget. <strong>Detect</strong> measures this machine.
        </p>
      </div>

      {detecting && (
        <p className="progress-line">
          Committing memory to find the limit… {detectProgress ?? ''}
        </p>
      )}

      <MemoryReadout memory={memory} reportedGiB={reportedGiB} />

      <div className="banner">
        <div>
          <strong>Why every size gets filled before it is timed.</strong> A fresh state vector is all
          zeros, and zero pages are nearly free — the OS commits them lazily and compresses them
          away. Measured here: 6&nbsp;GiB of zeros allocates in <strong>13&nbsp;ms</strong> (about
          460&nbsp;GB/s, far above real memory bandwidth, so nothing was written), while writing
          1&nbsp;GiB of varied data takes <strong>~820&nbsp;ms</strong>. So "the allocation
          succeeded" proves almost nothing. Each size here is filled with random amplitudes first,
          which is also the honest worst case: real circuits spread amplitude across every basis
          state within a few layers.
        </div>
      </div>

      {error && (
        <div className="banner banner-critical">
          <div>
            <strong>Probe failed.</strong> {error}
          </div>
        </div>
      )}

      {running && <p className="progress-line">Measuring {stage ?? '…'}…</p>}

      {best && (
        <>
          <Hero
            value={String(best.qubits)}
            unit={best.qubits === 1 ? 'qubit' : 'qubits'}
            detail={`${formatBytes(best.totalBytes)} across ${best.shards} workers, ${formatBytes(
              best.bytesPerShard,
            )} each — filled with real amplitudes and still computing at ${best.bandwidthGBps.toFixed(
              0,
            )} GB/s. A single WASM module tops out at 26 qubits.`}
          />
          <div className="tiles" style={{ marginTop: 20 }}>
            <StatTile label="Workers" value={String(best.shards)} sub={`${best.localQubits} qubits per slice`} />
            <StatTile
              label="Local gate"
              value={formatMs(best.localGateMs)}
              sub={`${best.bandwidthGBps.toFixed(0)} GB/s effective`}
            />
            <StatTile
              label="Cross-shard gate"
              value={formatMs(best.globalGateMs)}
              sub={`${best.exchangedBlocks} blocks exchanged`}
            />
            <StatTile
              label="Worst norm error"
              value={
                attempted.length === 0
                  ? '—'
                  : Math.max(...attempted.map((p) => p.normError)).toExponential(1)
              }
              sub="on a fully populated state"
            />
          </div>
        </>
      )}

      {result && !running && <OutcomeBanner result={result} />}

      {points.length === 0 && !running && (
        <div className="card">
          <p className="empty">Run the probe to see how far this machine really goes.</p>
        </div>
      )}

      {points.length > 0 && (
        <div className={running ? 'stale' : undefined}>
          <VerdictLadder
            points={points}
            floorGBps={result?.viableFloorGBps ?? DEFAULT_PROBE_OPTIONS.viableFloorGBps}
          />

          <div className="card">
            <h2>Effective bandwidth — and where it stops being real</h2>
            <p className="card-note">
              Every gate reads and writes the whole state, so its rate is bounded by DRAM. The first
              gate after filling also pays first-touch page faulting, which is why cold and warm are
              plotted apart: while only the cold line dips, that is setup cost being paid once. When
              the warm line falls through the floor too, the working set no longer fits and the
              machine is swapping rather than computing — the case a pass/fail allocation check
              cannot see.
            </p>
            <LineChart
              x={x}
              series={[
                {
                  label: 'Warm gate',
                  values: points.map((p) => (Number.isFinite(p.bandwidthGBps) ? p.bandwidthGBps : null)),
                  colorVar: '--series-1',
                },
                {
                  label: 'Cold gate (first touch)',
                  values: points.map((p) =>
                    Number.isFinite(p.localGateColdMs)
                      ? (p.totalBytes * 2) / 1e9 / (p.localGateColdMs / 1000)
                      : null,
                  ),
                  colorVar: '--series-2',
                },
              ]}
              yScaleType="log"
              formatY={(v) => `${v >= 1 ? v.toFixed(0) : v.toFixed(2)} GB/s`}
              formatX={(v) => String(v)}
              xLabel="Qubits"
              yLabel="Effective bandwidth"
              referenceLines={[
                {
                  value: result?.viableFloorGBps ?? DEFAULT_PROBE_OPTIONS.viableFloorGBps,
                  label: `${result?.viableFloorGBps ?? DEFAULT_PROBE_OPTIONS.viableFloorGBps} GB/s — below here is swapping`,
                },
              ]}
            />
          </div>

          <div className="card">
            <h2>Cost of crossing a shard boundary</h2>
            <p className="card-note">
              The two gates are both a Hadamard: one on qubit 0, one on the top qubit. At 26 qubits
              and below there is one worker, so both are local — and the top-qubit gate is the faster
              of the two, since its amplitude pairs stream sequentially while qubit 0 pairs
              neighbours. They diverge exactly where sharding begins: from 27 qubits the top qubit is
              a shard-id bit, so that gate pairs every worker and exchanges slices in blocks. The
              fill is plotted alongside as the reference cost of one full pass over the state.
            </p>
            <LineChart
              x={x}
              series={[
                {
                  label: 'Local gate',
                  values: points.map((p) => (Number.isFinite(p.localGateMs) ? p.localGateMs : null)),
                  colorVar: '--series-1',
                },
                {
                  label: 'Cross-shard gate',
                  values: points.map((p) => (Number.isFinite(p.globalGateMs) ? p.globalGateMs : null)),
                  colorVar: '--series-2',
                },
                {
                  label: 'Fill (one pass over the whole state)',
                  values: points.map((p) => (p.fillMs > 0 ? p.fillMs : null)),
                  colorVar: '--series-3',
                },
              ]}
              yScaleType="log"
              formatY={formatMs}
              formatX={(v) => String(v)}
              xLabel="Qubits"
              yLabel="Time"
            />
          </div>

          <div className="card">
            <h2>Breaking through the single-module ceiling</h2>
            <p className="card-note">
              The lower dashed line is all one WASM module can address as a single allocation; the
              upper one is the memory budget. Everything to the right of the first line is only
              reachable because the register is split across workers.
            </p>
            <LineChart
              x={x}
              series={[
                { label: 'Total', values: points.map((p) => p.totalBytes), colorVar: '--series-1' },
                { label: 'Per shard', values: points.map((p) => p.bytesPerShard), colorVar: '--series-2' },
              ]}
              yScaleType="log"
              yTicks={[2 ** 25, 2 ** 27, 2 ** 29, 2 ** 30, 2 ** 32, 2 ** 33, 2 ** 34]}
              formatY={(v) => formatBytes(v, 0)}
              formatX={(v) => String(v)}
              xLabel="Qubits"
              yLabel="Memory"
              referenceLines={[
                { value: SINGLE_MODULE_BYTES, label: '1 GiB — one module, one allocation' },
                { value: budgetBytes, label: `${budgetGiB} GiB — budget` },
              ]}
            />
          </div>

          <div className="card">
            <h3>Measurements</h3>
            <p className="card-note">
              Every size attempted, with the verdict for each. Partial results are also written to
              local storage after each size, so a crash near the ceiling still leaves a record of
              where it stopped.
            </p>
            <ShardedTable points={points} />
          </div>
        </div>
      )}
    </>
  );
}

function OutcomeBanner({ result }: { result: ShardedProbeResult }) {
  const last = result.points[result.points.length - 1];
  const degraded = result.maxAllocatedQubits > result.maxViableQubits;
  const critical = last?.verdict === 'refused';

  return (
    <div className={`banner ${critical ? 'banner-critical' : 'banner-good'}`}>
      <div>
        <strong>
          {result.maxViableQubits} qubits viable
          {degraded && `, ${result.maxAllocatedQubits} allocated`}.
        </strong>{' '}
        {degraded && (
          <>
            Sizes above {result.maxViableQubits} allocated and filled, but a warm gate ran below{' '}
            {result.viableFloorGBps} GB/s against a peak of {result.peakBandwidthGBps.toFixed(0)} —
            allocated is not the same as usable.{' '}
          </>
        )}
        {last?.verdict === 'refused' && (
          <>
            A shard was refused at {last.qubits} qubits{last.error ? `: ${last.error}` : ''}. Failing
            cleanly is the good case — the alternative near the ceiling is the tab dying.{' '}
          </>
        )}
        {last?.verdict === 'skipped' && (
          <>
            Stopped at the {formatBytes(result.budgetBytes)} budget; {last.qubits} qubits would need{' '}
            {formatBytes(last.totalBytes)}.{' '}
          </>
        )}
        Whole probe took {formatMs(result.totalMs)}.
      </div>
    </div>
  );
}

function ShardedTable({ points }: { points: ShardedProbePoint[] }) {
  const num = (v: number, f: (n: number) => string) => (Number.isFinite(v) ? f(v) : '—');
  const columns: Column<ShardedProbePoint>[] = [
    { key: 'q', header: 'Qubits', render: (p) => p.qubits },
    { key: 'v', header: 'Verdict', render: (p) => <Verdict verdict={p.verdict} /> },
    { key: 'sh', header: 'Workers', render: (p) => p.shards },
    { key: 'tot', header: 'Total', render: (p) => formatBytes(p.totalBytes) },
    { key: 'per', header: 'Per shard', render: (p) => formatBytes(p.bytesPerShard) },
    { key: 'al', header: 'Allocate', render: (p) => num(p.allocMs, formatMs) },
    { key: 'fi', header: 'Fill', render: (p) => (p.fillMs > 0 ? formatMs(p.fillMs) : '—') },
    { key: 'lc', header: 'Local (cold)', render: (p) => num(p.localGateColdMs, formatMs) },
    { key: 'lg', header: 'Local (warm)', render: (p) => num(p.localGateMs, formatMs) },
    { key: 'gg', header: 'Cross-shard', render: (p) => num(p.globalGateMs, formatMs) },
    { key: 'bw', header: 'GB/s', render: (p) => num(p.bandwidthGBps, (v) => v.toFixed(0)) },
    { key: 'bl', header: 'Blocks', render: (p) => formatCount(p.exchangedBlocks) },
    { key: 'nm', header: '|norm − 1|', render: (p) => num(p.normError, (v) => (v === 0 ? '0' : v.toExponential(1))) },
  ];
  return (
    <TableDisclosure label="measurement table">
      <DataTable rows={points} columns={columns} />
    </TableDisclosure>
  );
}
