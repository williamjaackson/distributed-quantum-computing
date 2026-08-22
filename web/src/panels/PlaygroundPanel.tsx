import { useCallback, useEffect, useState } from 'react';
import { ColumnChart } from '../charts/ColumnChart';
import { DataTable, TableDisclosure } from '../components/DataTable';
import { StatTile } from '../components/StatTile';
import type { EngineClient } from '../lib/engineClient';
import { formatBasisState, formatProbability } from '../lib/format';
import type { PlaygroundState, RequestBody } from '../lib/protocol';

/** Small enough that the full amplitude array stays cheap to ship and chart. */
const MAX_PLAYGROUND_QUBITS = 10;

const SINGLE_GATES = ['h', 'x', 'y', 'z', 's', 'sdg', 't', 'tdg'] as const;
const ROTATIONS = ['rx', 'ry', 'rz', 'p'] as const;
const TWO_GATES = ['cx', 'cy', 'cz', 'ch', 'swap'] as const;

interface Props {
  client: EngineClient;
}

export function PlaygroundPanel({ client }: Props) {
  const [nQubits, setNQubits] = useState(3);
  const [state, setState] = useState<PlaygroundState | null>(null);
  const [target, setTarget] = useState(0);
  const [control, setControl] = useState(1);
  const [angle, setAngle] = useState(Math.PI / 4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (req: RequestBody) => {
      setBusy(true);
      setError(null);
      try {
        setState(await client.call<PlaygroundState>(req));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  // Reallocate whenever the register size changes; clamp the qubit selectors so
  // they cannot point past the new register.
  useEffect(() => {
    setTarget((t) => Math.min(t, nQubits - 1));
    setControl((c) => Math.min(c, nQubits - 1));
    void send({ kind: 'pgInit', nQubits });
  }, [nQubits, send]);

  const qubits = Array.from({ length: nQubits }, (_, i) => i);
  const distinct = control !== target;

  return (
    <>
      <div className="controls">
        <div className="control">
          <label htmlFor="pgn">Qubits</label>
          <select id="pgn" value={nQubits} onChange={(e) => setNQubits(Number(e.target.value))}>
            {Array.from({ length: MAX_PLAYGROUND_QUBITS - 1 }, (_, i) => i + 2).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="control">
          <label htmlFor="pgt">Target</label>
          <select id="pgt" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
            {qubits.map((q) => (
              <option key={q} value={q}>
                q{q}
              </option>
            ))}
          </select>
        </div>
        <div className="control">
          <label htmlFor="pgc">Control</label>
          <select id="pgc" value={control} onChange={(e) => setControl(Number(e.target.value))}>
            {qubits.map((q) => (
              <option key={q} value={q}>
                q{q}
              </option>
            ))}
          </select>
        </div>
        <div className="control">
          <label htmlFor="pga">Angle (rad)</label>
          <input
            id="pga"
            type="number"
            step={0.1}
            value={Number(angle.toFixed(4))}
            onChange={(e) => setAngle(Number(e.target.value))}
          />
        </div>
        <button className="secondary" onClick={() => void send({ kind: 'pgReset' })} disabled={busy}>
          Reset to |0…0⟩
        </button>
      </div>

      <div className="card">
        <h2>Apply a gate</h2>
        <p className="card-note">
          Single-qubit gates act on the target. Two-qubit gates use control → target; they are
          disabled while both selectors point at the same qubit, which the engine rejects. The three
          state preparations reset the register first; QFT is a transform and applies to whatever
          state is already there.
        </p>

        <div className="qubit-row" style={{ marginBottom: 12 }}>
          {SINGLE_GATES.map((g) => (
            <button
              key={g}
              className="chip"
              disabled={busy}
              onClick={() => void send({ kind: 'pgApply', gate: g, qubits: [target], params: [] })}
            >
              {g.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="qubit-row" style={{ marginBottom: 12 }}>
          {ROTATIONS.map((g) => (
            <button
              key={g}
              className="chip"
              disabled={busy}
              onClick={() => void send({ kind: 'pgApply', gate: g, qubits: [target], params: [angle] })}
            >
              {g.toUpperCase()}(θ)
            </button>
          ))}
        </div>
        <div className="qubit-row" style={{ marginBottom: 12 }}>
          {TWO_GATES.map((g) => (
            <button
              key={g}
              className="chip"
              disabled={busy || !distinct}
              onClick={() => void send({ kind: 'pgApply', gate: g, qubits: [control, target], params: [] })}
            >
              {g.toUpperCase()}
            </button>
          ))}
          <button
            className="chip"
            disabled={busy || !distinct}
            onClick={() => void send({ kind: 'pgApply', gate: 'cp', qubits: [control, target], params: [angle] })}
          >
            CP(θ)
          </button>
        </div>
        <div className="qubit-row">
          {(
            [
              ['uniform', 'prepare uniform'],
              ['bell', 'prepare Bell'],
              ['ghz', 'prepare GHZ'],
              ['qft', 'apply QFT'],
            ] as const
          ).map(([circuit, label]) => (
            <button
              key={circuit}
              className="chip"
              disabled={busy}
              onClick={() => void send({ kind: 'pgPrepare', circuit })}
            >
              {label}
            </button>
          ))}
          <button
            className="chip"
            disabled={busy}
            onClick={() => void send({ kind: 'pgMeasure', qubit: target })}
          >
            measure q{target}
          </button>
        </div>

        {error && (
          <div className="banner banner-critical" style={{ marginTop: 16, marginBottom: 0 }}>
            <div>
              <strong>Rejected.</strong> {error}
            </div>
          </div>
        )}
      </div>

      {state && (
        <>
          <div className="tiles">
            <StatTile label="Register" value={`${state.nQubits} qubits`} sub={`${2 ** state.nQubits} amplitudes`} />
            <StatTile
              label="Total probability"
              value={state.norm.toFixed(12)}
              sub="stays at 1 under unitary gates"
            />
            <StatTile
              label="Non-zero amplitudes"
              value={String(state.probabilities.filter((p) => p > 1e-12).length)}
              sub="states with support"
            />
            <StatTile label="Gates applied" value={String(state.history.length)} sub="this session" />
          </div>

          <div className="card">
            <h2>Probability distribution</h2>
            <p className="card-note">
              Probability of each basis state, most-significant qubit first. Hover any bar for the
              exact value.
            </p>
            <ColumnChart
              categories={state.probabilities.map((_, i) => formatBasisState(i, state.nQubits))}
              series={[{ label: 'Probability', values: state.probabilities, colorVar: '--series-1' }]}
              formatY={(v) => v.toFixed(2)}
              xLabel="Basis state"
              yLabel="Probability"
            />
            <TableDisclosure label="amplitude table">
              <DataTable
                rows={state.probabilities.map((p, i) => ({
                  label: formatBasisState(i, state.nQubits),
                  re: state.amplitudes[2 * i],
                  im: state.amplitudes[2 * i + 1],
                  p,
                }))}
                columns={[
                  { key: 's', header: 'Basis state', render: (r) => `|${r.label}⟩` },
                  { key: 're', header: 'Re', render: (r) => r.re.toFixed(6) },
                  { key: 'im', header: 'Im', render: (r) => r.im.toFixed(6) },
                  { key: 'p', header: 'Probability', render: (r) => formatProbability(r.p) },
                ]}
              />
            </TableDisclosure>
          </div>

          {state.history.length > 0 && (
            <div className="card">
              <h3>Applied so far</h3>
              <ul className="history">
                {state.history.map((h, i) => (
                  <li key={i}>
                    {i + 1}. {h}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </>
  );
}
