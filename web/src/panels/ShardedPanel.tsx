import { useCallback, useEffect, useMemo, useState } from 'react';
import { LineChart } from '../charts/LineChart';
import { DataTable, TableDisclosure, type Column } from '../components/DataTable';
import { Hero, StatTile } from '../components/StatTile';
import { formatBytes, formatCount, formatMs } from '../lib/format';
import {
  defaultBudgetBytes,
  initPlanning,
  maxQubitsForBudget,
  maxQubitsPerShard,
  probeSharded,
  type ShardedProbePoint,
  type ShardedProbeResult,
} from '../lib/shardedEngine';

/** One wasm module cannot hold more than this, whatever the machine has. */
const SINGLE_MODULE_BYTES = 1024 ** 3;
const GIB = 1024 ** 3;

export function ShardedPanel() {
  const safeBudget = useMemo(() => defaultBudgetBytes(), []);
  const [budgetGiB, setBudgetGiB] = useState(safeBudget / GIB);
  // The orchestrator plans layouts with the engine's own logic, so nothing here
  // may touch a WASM export until the planning module has loaded.
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
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

  const budgetBytes = budgetGiB * GIB;
  const ceiling = maxQubitsForBudget(budgetBytes);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setLive([]);
    setResult(null);
    try {
      const res = await probeSharded(
        { minQubits: 24, maxQubits: 34, budgetBytes },
        (p, n) => {
          setCurrent(n);
          if (p.allocated || p.error) setLive((prev) => [...prev, p]);
        },
      );
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setCurrent(null);
    }
  }, [budgetBytes]);

  const points = running || !result ? live : result.points;
  const measured = points.filter((p) => p.allocated);
  const top = measured[measured.length - 1];
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
          <label htmlFor="budget">Memory budget</label>
          <select
            id="budget"
            value={budgetGiB}
            disabled={running}
            onChange={(e) => setBudgetGiB(Number(e.target.value))}
          >
            {[safeBudget / GIB, (safeBudget * 1.5) / GIB, (safeBudget * 2) / GIB].map((g, i) => (
              <option key={g} value={g}>
                {g} GiB — {['safe', 'aggressive', 'may crash the tab'][i]}
              </option>
            ))}
          </select>
        </div>
        <button className="primary" onClick={run} disabled={running}>
          {running ? 'Probing…' : points.length ? 'Run again' : 'Run sharded probe'}
        </button>
        <p className="control-hint">
          Spreads one register across {maxQubitsPerShard()}-qubit slices, one worker each, and walks
          upward. Stops at {ceiling} qubits for this budget.
        </p>
      </div>

      <div className="banner">
        <div>
          <strong>Why a budget instead of probing until it fails.</strong> Overshooting RAM does not
          fail gracefully — the browser kills the tab and takes the results with it. The safe default
          comes from <span className="mono">navigator.deviceMemory</span>, which is deliberately
          coarse and capped at 8, so treat it as a lower bound on what this machine really has.
        </div>
      </div>

      {error && (
        <div className="banner banner-critical">
          <div>
            <strong>Probe failed.</strong> {error}
          </div>
        </div>
      )}

      {running && (
        <p className="progress-line">
          Allocating {current ?? '…'} qubits
          {current != null &&
            ` — ${formatBytes(16 * 2 ** current)} across ${2 ** Math.max(0, current - maxQubitsPerShard())} worker(s)`}
        </p>
      )}

      {top && (
        <>
          <Hero
            value={String(top.qubits)}
            unit={top.qubits === 1 ? 'qubit' : 'qubits'}
            detail={`${formatBytes(top.totalBytes)} of amplitudes across ${top.shards} workers, ${formatBytes(
              top.bytesPerShard,
            )} each. A single WASM module tops out at 26 qubits — sharding is what gets past it.`}
          />
          <div className="tiles" style={{ marginTop: 20 }}>
            <StatTile label="Workers" value={String(top.shards)} sub={`${top.localQubits} qubits per slice`} />
            <StatTile
              label="Local gate"
              value={formatMs(top.localGateMs)}
              sub="below the boundary — no communication"
            />
            <StatTile
              label="Cross-shard gate"
              value={formatMs(top.globalGateMs)}
              sub={`${top.exchangedBlocks} blocks exchanged`}
            />
            <StatTile
              label="Worst norm error"
              value={
                Math.max(...measured.map((p) => p.normError)) === 0
                  ? '0'
                  : Math.max(...measured.map((p) => p.normError)).toExponential(1)
              }
              sub="|total probability − 1|"
            />
          </div>
        </>
      )}

      {result && !running && <StopBanner result={result} />}

      {points.length === 0 && !running && (
        <div className="card">
          <p className="empty">Run the probe to see how far this machine goes.</p>
        </div>
      )}

      {points.length > 0 && (
        <div className={running ? 'stale' : undefined}>
          <div className="card">
            <h2>Cost of crossing a shard boundary</h2>
            <p className="card-note">
              Both series are a Hadamard: one on qubit 0, one on the top qubit. At 26 qubits and
              below there is only one worker, so <em>both</em> are local and the top-qubit gate is
              actually the faster of the two — its amplitude pairs are far apart and stream
              sequentially, while qubit 0 pairs neighbours. The lines diverge exactly where sharding
              begins: from 27 qubits the top qubit is a shard-id bit, so that gate now pairs every
              worker and exchanges slices in blocks. The gap after the crossover is the price of
              sharding.
            </p>
            <LineChart
              x={x}
              series={[
                {
                  label: 'Local gate',
                  values: points.map((p) => (p.allocated ? p.localGateMs : null)),
                  colorVar: '--series-1',
                },
                {
                  label: 'Cross-shard gate',
                  values: points.map((p) => (p.allocated ? p.globalGateMs : null)),
                  colorVar: '--series-2',
                },
              ]}
              yScaleType="log"
              formatY={formatMs}
              formatX={(v) => String(v)}
              xLabel="Qubits"
              yLabel="Time per gate"
            />
          </div>

          <div className="card">
            <h2>Breaking through the single-module ceiling</h2>
            <p className="card-note">
              Total amplitudes held. The lower dashed line is all one WASM module can address as a
              single allocation; the upper one is the memory budget. Everything to the right of the
              first line is only reachable because the register is split across workers.
            </p>
            <LineChart
              x={x}
              series={[
                { label: 'Total', values: points.map((p) => p.totalBytes), colorVar: '--series-1' },
                {
                  label: 'Per shard',
                  values: points.map((p) => p.bytesPerShard),
                  colorVar: '--series-2',
                },
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
              Shard layout and timings at every size, including the block counts behind each
              cross-shard gate.
            </p>
            <ShardedTable points={points} />
          </div>
        </div>
      )}
    </>
  );
}

function StopBanner({ result }: { result: ShardedProbeResult }) {
  const next = 16 * 2 ** (result.maxQubits + 1);
  const body = () => {
    switch (result.stopReason) {
      case 'budget':
        return (
          <>
            <strong>Stopped at the {formatBytes(result.budgetBytes)} budget.</strong> The next size up
            needs {formatBytes(next)}. Raise the budget to push further — but past this machine's real
            RAM the tab dies rather than reporting a failure.
          </>
        );
      case 'allocation-failed':
        return (
          <>
            <strong>A shard was refused at {result.maxQubits + 1} qubits.</strong> {result.maxQubits} is
            the practical limit here. The allocation failed cleanly, which is the good case — the
            browser returned an error instead of killing the worker.
          </>
        );
      case 'user-limit':
        return <strong>Reached the end of the requested range at {result.maxQubits} qubits.</strong>;
    }
  };
  return (
    <div className={`banner ${result.stopReason === 'allocation-failed' ? 'banner-critical' : 'banner-good'}`}>
      <div>
        {body()} Whole probe took {formatMs(result.totalMs)}.
      </div>
    </div>
  );
}

function ShardedTable({ points }: { points: ShardedProbePoint[] }) {
  const columns: Column<ShardedProbePoint>[] = [
    { key: 'q', header: 'Qubits', render: (p) => p.qubits },
    { key: 'sh', header: 'Workers', render: (p) => p.shards },
    { key: 'lq', header: 'Qubits/slice', render: (p) => p.localQubits },
    { key: 'per', header: 'Per shard', render: (p) => formatBytes(p.bytesPerShard) },
    { key: 'tot', header: 'Total', render: (p) => formatBytes(p.totalBytes) },
    { key: 'ok', header: 'Allocated', render: (p) => (p.allocated ? 'yes' : 'refused') },
    { key: 'al', header: 'Allocate', render: (p) => formatMs(p.allocMs) },
    { key: 'lg', header: 'Local gate', render: (p) => (p.allocated ? formatMs(p.localGateMs) : '—') },
    { key: 'gg', header: 'Cross-shard', render: (p) => (p.allocated ? formatMs(p.globalGateMs) : '—') },
    { key: 'bl', header: 'Blocks', render: (p) => formatCount(p.exchangedBlocks) },
    {
      key: 'nm',
      header: '|norm − 1|',
      render: (p) => (p.allocated ? (p.normError === 0 ? '0' : p.normError.toExponential(1)) : '—'),
    },
  ];
  return (
    <TableDisclosure label="measurement table">
      <DataTable rows={points} columns={columns} />
    </TableDisclosure>
  );
}
