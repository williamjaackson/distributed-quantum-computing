import { useCallback, useMemo, useState } from 'react';
import { LineChart } from '../charts/LineChart';
import { DataTable, TableDisclosure, type Column } from '../components/DataTable';
import { Hero, StatTile } from '../components/StatTile';
import type { EngineClient } from '../lib/engineClient';
import { formatBytes, formatCount, formatMs } from '../lib/format';
import type { EngineInfo, ProbePoint, ProbeResult } from '../lib/protocol';

/** wasm32 addresses at most 4 GiB, so this is the hard wall for any run. */
const WASM_CEILING = 4 * 1024 ** 3;
/**
 * Upper bound on the adaptive layer count. High enough that small registers
 * still reach the timing target (where one layer is microseconds), and never
 * reached at large ones, where a single layer already exceeds it.
 */
const MAX_LAYERS = 50000;

const MEMORY_TICKS = [2 ** 10, 2 ** 15, 2 ** 20, 2 ** 25, 2 ** 30, 2 ** 32];

interface Props {
  client: EngineClient;
  info: EngineInfo;
}

export function CapacityPanel({ client, info }: Props) {
  const [maxQubits, setMaxQubits] = useState(info.maxQubits);
  const [targetMs, setTargetMs] = useState(120);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [live, setLive] = useState<ProbePoint[]>([]);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setLive([]);
    setCurrent(null);
    try {
      const res = await client.call<ProbeResult>(
        {
          kind: 'probe',
          options: {
            minQubits: 8,
            maxQubits,
            targetMs,
            maxLayers: MAX_LAYERS,
            totalBudgetMs: 180000,
          },
        },
        (p) => {
          if (p.kind !== 'probe') return;
          setCurrent(p.currentQubits);
          if (p.point) setLive((prev) => [...prev, p.point as ProbePoint]);
        },
      );
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setCurrent(null);
    }
  }, [client, maxQubits, targetMs]);

  // Show streaming points while a run is in flight, the settled result after.
  const points = running || !result ? live : result.points;
  const measured = points.filter((p) => p.allocated);

  const stats = useMemo(() => {
    if (!measured.length) return null;
    const peak = measured.reduce((a, b) => (b.amplitudeUpdatesPerSec > a.amplitudeUpdatesPerSec ? b : a));
    const top = measured[measured.length - 1];
    return {
      top,
      peak,
      worstNorm: Math.max(...measured.map((p) => p.normError)),
      heap: Math.max(...points.map((p) => p.wasmHeapBytes)),
    };
  }, [measured, points]);

  const x = points.map((p) => p.qubits);
  const fmtQubits = (v: number) => String(v);

  return (
    <>
      <div className="controls">
        <div className="control">
          <label htmlFor="maxq">Try up to</label>
          <input
            id="maxq"
            type="number"
            min={10}
            max={info.maxQubits}
            value={maxQubits}
            disabled={running}
            onChange={(e) => setMaxQubits(Math.max(10, Math.min(info.maxQubits, Number(e.target.value))))}
          />
        </div>
        <div className="control">
          <label htmlFor="target">Time per measurement</label>
          <select
            id="target"
            value={targetMs}
            disabled={running}
            onChange={(e) => setTargetMs(Number(e.target.value))}
          >
            <option value={40}>40 ms — quick</option>
            <option value={120}>120 ms — balanced</option>
            <option value={400}>400 ms — precise</option>
          </select>
        </div>
        <button className="primary" onClick={run} disabled={running}>
          {running ? 'Probing…' : points.length ? 'Run again' : 'Run capacity probe'}
        </button>
        <p className="control-hint">
          Walks the qubit count upward, timing a fixed gate workload at each size, until the browser
          refuses the allocation.
        </p>
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
          Measuring {current ?? '…'} qubits
          {current != null && ` — state vector ${formatBytes(16 * 2 ** current)}`}
          {' · '}
          {measured.length} of {maxQubits - 8 + 1} sizes done
        </p>
      )}

      {stats && (
        <>
          <Hero
            value={String(stats.top.qubits)}
            unit={stats.top.qubits === 1 ? 'qubit' : 'qubits'}
            detail={`Largest register this browser would allocate — ${formatBytes(
              stats.top.stateBytes,
            )} of amplitudes, ${formatCount(stats.top.amplitudes)} complex numbers. The engine can address ${
              info.maxQubits
            } qubits before wasm32 runs out of address space.`}
          />

          <div className="tiles" style={{ marginTop: 20 }}>
            <StatTile
              label="Peak throughput"
              value={`${formatCount(stats.peak.amplitudeUpdatesPerSec)}/s`}
              sub={`amplitude updates, at ${stats.peak.qubits} qubits`}
            />
            <StatTile
              label="Slowest gate"
              value={formatMs(stats.top.msPerGate)}
              sub={`one gate at ${stats.top.qubits} qubits`}
            />
            <StatTile label="WASM heap peak" value={formatBytes(stats.heap)} sub="linear memory, never shrinks" />
            <StatTile
              label="Worst norm error"
              value={stats.worstNorm === 0 ? '0' : stats.worstNorm.toExponential(1)}
              sub="|total probability − 1|"
            />
          </div>
        </>
      )}

      {result && !running && <StopReasonBanner result={result} info={info} />}

      {points.length === 0 && !running && (
        <div className="card">
          <p className="empty">Run the probe to measure this machine.</p>
        </div>
      )}

      {points.length > 0 && (
        <div className={running ? 'stale' : undefined}>
          <div className="card">
            <h2>Time per gate</h2>
            <p className="card-note">
              Each added qubit doubles the state vector, so it doubles the work per gate. On a
              logarithmic axis that exponential cost is a straight line — the defining constraint of
              state-vector simulation.
            </p>
            <LineChart
              x={x}
              series={[{ label: 'Time per gate', values: points.map((p) => (p.allocated ? p.msPerGate : null)), colorVar: '--series-1' }]}
              yScaleType="log"
              formatY={formatMs}
              formatX={fmtQubits}
              xLabel="Qubits"
              yLabel="Time per gate"
              endLabels
            />
          </div>

          <div className="card">
            <h2>Throughput</h2>
            <p className="card-note">
              Amplitudes updated per second. Unlike time-per-gate this is roughly flat — the engine
              does the same work per amplitude at every size — so it isolates the machine's memory
              bandwidth. The fall-off at the top is the state vector outgrowing cache.
            </p>
            <LineChart
              x={x}
              series={[
                {
                  label: 'Amplitude updates/s',
                  values: points.map((p) => (p.allocated ? p.amplitudeUpdatesPerSec : null)),
                  colorVar: '--series-1',
                },
              ]}
              formatY={(v) => `${formatCount(v)}/s`}
              formatX={fmtQubits}
              xLabel="Qubits"
              yLabel="Amplitude updates/s"
            />
          </div>

          <div className="card">
            <h2>Memory</h2>
            <p className="card-note">
              The state vector needs 2<sup>n</sup> × 16 bytes. The dashed line is the 4 GiB wasm32
              address space — the wall this simulator cannot pass, whatever the machine has installed.
            </p>
            <LineChart
              x={x}
              series={[
                { label: 'State vector', values: points.map((p) => p.stateBytes), colorVar: '--series-1' },
                { label: 'WASM heap', values: points.map((p) => p.wasmHeapBytes || null), colorVar: '--series-2' },
              ]}
              yScaleType="log"
              yTicks={MEMORY_TICKS}
              formatY={(v) => formatBytes(v, 0)}
              formatX={fmtQubits}
              xLabel="Qubits"
              yLabel="Memory"
              referenceLines={[{ value: WASM_CEILING, label: '4 GiB — wasm32 limit' }]}
            />
          </div>

          <div className="card">
            <h3>Measurements</h3>
            <p className="card-note">Every value plotted above, plus the gate counts behind each timing.</p>
            <ProbeTable points={points} />
          </div>
        </div>
      )}
    </>
  );
}

function StopReasonBanner({ result, info }: { result: ProbeResult; info: EngineInfo }) {
  const n = result.maxQubitsAllocated;
  const nextBytes = 16 * 2 ** (n + 1);

  const message = () => {
    switch (result.stopReason) {
      case 'allocation-failed':
        return (
          <>
            <strong>Hit the memory ceiling at {n + 1} qubits.</strong> The browser refused{' '}
            {formatBytes(nextBytes)} for the next state vector, so {n} qubits is this machine's
            practical limit. The engine returned an error rather than aborting, which is why the run
            finished cleanly.
          </>
        );
      case 'engine-limit':
        return (
          <>
            <strong>Reached the engine's own ceiling of {info.maxQubits} qubits.</strong> Past this,
            2<sup>n</sup> × 16 bytes no longer fits in a 32-bit address space — this machine had
            memory to spare.
          </>
        );
      case 'budget-exhausted':
        return (
          <>
            <strong>Stopped on the time budget after {formatMs(result.totalMs)}.</strong> Sizes above{' '}
            {n} qubits were not measured, so this is a lower bound rather than the real ceiling.
          </>
        );
      case 'user-limit':
        return (
          <>
            <strong>Stopped at the requested limit of {n} qubits.</strong> The engine can address up
            to {info.maxQubits}; raise "Try up to" to find the real ceiling.
          </>
        );
    }
  };

  return (
    <div className={`banner ${result.stopReason === 'allocation-failed' ? 'banner-critical' : 'banner-good'}`}>
      <div>
        {message()} Whole probe took {formatMs(result.totalMs)}.
      </div>
    </div>
  );
}

function ProbeTable({ points }: { points: ProbePoint[] }) {
  const columns: Column<ProbePoint>[] = [
    { key: 'q', header: 'Qubits', render: (p) => p.qubits },
    { key: 'amp', header: 'Amplitudes', render: (p) => formatCount(p.amplitudes) },
    { key: 'bytes', header: 'State vector', render: (p) => formatBytes(p.stateBytes) },
    { key: 'alloc', header: 'Allocated', render: (p) => (p.allocated ? 'yes' : 'refused') },
    { key: 'layers', header: 'Layers', render: (p) => (p.allocated ? p.layers : '—') },
    { key: 'gates', header: 'Gates', render: (p) => (p.allocated ? formatCount(p.gates) : '—') },
    { key: 'total', header: 'Elapsed', render: (p) => (p.allocated ? formatMs(p.totalMs) : '—') },
    { key: 'per', header: 'Per gate', render: (p) => (p.allocated ? formatMs(p.msPerGate) : '—') },
    {
      key: 'thr',
      header: 'Updates/s',
      render: (p) => (p.allocated ? `${formatCount(p.amplitudeUpdatesPerSec)}/s` : '—'),
    },
    { key: 'heap', header: 'WASM heap', render: (p) => formatBytes(p.wasmHeapBytes) },
    {
      key: 'norm',
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
