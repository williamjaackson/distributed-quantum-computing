import { useCallback, useState } from 'react';
import { ColumnChart } from '../charts/ColumnChart';
import { LineChart } from '../charts/LineChart';
import { DataTable, TableDisclosure, type Column } from '../components/DataTable';
import { StatTile } from '../components/StatTile';
import { Status } from '../components/Status';
import type { EngineClient } from '../lib/engineClient';
import { formatMs } from '../lib/format';
import type { TestChart, TestCheck, TestGroup, TestResult } from '../lib/protocol';

interface Props {
  client: EngineClient;
}

export function TestsPanel({ client }: Props) {
  const [running, setRunning] = useState(false);
  const [groups, setGroups] = useState<TestGroup[]>([]);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setGroups([]);
    setResult(null);
    try {
      const res = await client.call<TestResult>({ kind: 'runTests' }, (p) => {
        if (p.kind === 'tests') setGroups((prev) => [...prev, p.group]);
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [client]);

  const shown = result ? result.groups : groups;

  return (
    <>
      <div className="controls">
        <button className="primary" onClick={run} disabled={running}>
          {running ? 'Running…' : shown.length ? 'Run again' : 'Run engine tests'}
        </button>
        <p className="control-hint">
          Every scenario below runs against the same WASM build the benchmark uses, with expected
          values taken from the physics rather than from the engine.
        </p>
      </div>

      {error && (
        <div className="banner banner-critical">
          <div>
            <strong>Test run failed.</strong> {error}
          </div>
        </div>
      )}

      {result && (
        <div className="tiles">
          <StatTile label="Checks passed" value={String(result.passed)} sub={`of ${result.passed + result.failed}`} />
          <StatTile
            label="Checks failed"
            value={String(result.failed)}
            sub={result.failed === 0 ? 'engine matches theory' : 'see the tables below'}
          />
          <StatTile label="Scenarios" value={String(result.groups.length)} sub="circuits exercised" />
          <StatTile label="Wall time" value={formatMs(result.totalMs)} sub="whole suite, in the worker" />
        </div>
      )}

      {shown.length === 0 && !running && (
        <div className="card">
          <p className="empty">Run the suite to exercise the engine in this browser.</p>
        </div>
      )}

      {shown.map((g) => (
        <GroupCard key={g.id} group={g} />
      ))}

      {running && <p className="progress-line">Running scenario {shown.length + 1}…</p>}
    </>
  );
}

function GroupCard({ group }: { group: TestGroup }) {
  const failed = group.checks.filter((c) => !c.pass).length;
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'baseline' }}>
        <h2>{group.title}</h2>
        <Status pass={failed === 0} />
      </div>
      <p className="card-note">{group.description}</p>

      {group.chart && <GroupChart chart={group.chart} />}

      <CheckTable checks={group.checks} ms={group.ms} />
    </div>
  );
}

function GroupChart({ chart }: { chart: TestChart }) {
  if (chart.kind === 'distribution') {
    return (
      <>
        <ColumnChart
          categories={chart.categories}
          series={[
            { label: chart.measuredLabel, values: chart.measured, colorVar: '--series-1' },
            { label: chart.theoreticalLabel, values: chart.theoretical, colorVar: '--series-2' },
          ]}
          formatY={(v) => v.toFixed(2)}
          xLabel={chart.xLabel}
          yLabel={chart.yLabel}
        />
        <TableDisclosure label="distribution table">
          <DataTable
            rows={chart.categories.map((c, i) => ({
              c,
              m: chart.measured[i],
              t: chart.theoretical[i],
            }))}
            columns={[
              { key: 'c', header: chart.xLabel, render: (r) => r.c },
              { key: 'm', header: chart.measuredLabel, render: (r) => r.m.toFixed(6) },
              { key: 't', header: chart.theoreticalLabel, render: (r) => r.t.toFixed(6) },
              { key: 'd', header: 'Difference', render: (r) => (r.m - r.t).toExponential(2) },
            ]}
          />
        </TableDisclosure>
      </>
    );
  }

  const fmt = chart.logY
    ? (v: number) => v.toExponential(0)
    : (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString() : v.toFixed(3));

  return (
    <>
      <LineChart
        x={chart.x}
        series={chart.series.map((s, i) => ({
          label: s.label,
          values: s.values,
          colorVar: i === 0 ? '--series-1' : i === 1 ? '--series-2' : '--series-3',
        }))}
        yScaleType={chart.logY ? 'log' : 'linear'}
        formatY={fmt}
        formatX={(v) => (Number.isInteger(v) ? String(v) : v.toFixed(2))}
        xLabel={chart.xLabel}
        yLabel={chart.yLabel}
      />
      <TableDisclosure label="series table">
        <DataTable
          rows={chart.x.map((xv, i) => ({ xv, values: chart.series.map((s) => s.values[i]) }))}
          columns={[
            { key: 'x', header: chart.xLabel, render: (r) => r.xv },
            ...chart.series.map((s, si) => ({
              key: `s${si}`,
              header: s.label,
              render: (r: { values: number[] }) => r.values[si]?.toExponential(4) ?? '—',
            })),
          ]}
        />
      </TableDisclosure>
    </>
  );
}

function CheckTable({ checks, ms }: { checks: TestCheck[]; ms: number }) {
  const columns: Column<TestCheck>[] = [
    { key: 'n', header: 'Check', render: (c) => c.name },
    { key: 'e', header: 'Expected', render: (c) => fmtValue(c.expected) },
    { key: 'm', header: 'Measured', render: (c) => fmtValue(c.measured) },
    { key: 'd', header: 'Difference', render: (c) => fmtDiff(c.measured - c.expected) },
    { key: 't', header: 'Tolerance', render: (c) => fmtDiff(c.tolerance) },
    { key: 's', header: 'Result', render: (c) => <Status pass={c.pass} /> },
  ];
  return (
    <div style={{ marginTop: 12 }}>
      <DataTable rows={checks} columns={columns} />
      <p className="tile-sub" style={{ marginTop: 8 }}>
        {checks.length} checks in {formatMs(ms)}
      </p>
    </div>
  );
}

function fmtValue(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  if (Number.isInteger(v) && Math.abs(v) < 1e6) return String(v);
  if (Math.abs(v) < 1e-4) return v.toExponential(2);
  return v.toFixed(6);
}

function fmtDiff(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  return v.toExponential(1);
}
