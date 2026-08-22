/**
 * How the register is being held, and how much of it is being recorded.
 *
 * This panel exists because the visualiser has real ceilings and it is better to
 * name them than to silently cap the qubit count. There are three, and they are
 * not the same number:
 *
 * * **Full state per frame** — recording every amplitude for every step is what
 *   used to limit this app. Past `AMPS_QUBIT_LIMIT` frames keep summaries
 *   instead, which is everything the views draw.
 * * **One module** — a single Rust allocation is capped at `isize::MAX`, so one
 *   state vector holds at most 26 qubits.
 * * **Sharded** — a module per worker, each with its own address space, so the
 *   limit becomes the machine's memory.
 */
import type { EngineLimits, Execution } from '../lib/backend';
import { formatBytes } from '../lib/backend';
import { AMPS_QUBIT_LIMIT, INTERACTIVE_QUBITS, ceiling } from '../lib/runner';
import type { Timeline } from '../lib/types';

interface Props {
  execution: Execution;
  onExecution: (e: Execution) => void;
  unlocked: boolean;
  onUnlocked: (v: boolean) => void;
  timeline: Timeline | null;
  limits: EngineLimits | null;
}

const MODES: { value: Execution; label: string; hint: string }[] = [
  {
    value: 'auto',
    label: 'Automatic',
    hint: 'one module while one will do, sharded past its 26-qubit ceiling',
  },
  { value: 'whole', label: 'Single module', hint: 'one state vector on this thread' },
  {
    value: 'sharded',
    label: 'Sharded',
    hint: 'one module per worker — forced on, so the mechanism is visible at any size',
  },
];

export function ExecutionPanel({
  execution,
  onExecution,
  unlocked,
  onUnlocked,
  timeline,
  limits,
}: Props) {
  const chosen = MODES.find((m) => m.value === execution) ?? MODES[0];
  const cap = ceiling(execution, unlocked, limits);
  return (
    <section className="card">
      <h2 className="card-title">Execution</h2>
      <select
        value={execution}
        onChange={(e) => onExecution(e.target.value as Execution)}
        aria-label="Execution mode"
      >
        {MODES.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
      <span className="field-hint">{chosen.hint}</span>

      <div className="field">
        <label className="switch">
          <input
            type="checkbox"
            checked={unlocked}
            onChange={(e) => onUnlocked(e.target.checked)}
          />
          <span className="field-label">Go past {INTERACTIVE_QUBITS} qubits</span>
        </label>
        <span className="field-hint">
          {unlocked
            ? `Ceiling is now ${cap} qubits${
                limits ? ` (${formatBytes(2 ** cap * 16)} of state)` : ''
              }. A step costs a pass over the state per qubit, so expect a wait rather than playback.`
            : `Ceiling is ${INTERACTIVE_QUBITS} qubits — the last size where a step is still about 60 ms.${
                limits ? ` Turn this on to reach ${ceiling(execution, true, limits)}.` : ''
              }`}
        </span>
      </div>

      {timeline && (
        <>
          <div className="out-row">
            <span className="out-label">Holding the state</span>
            <span className="out-value">{timeline.backend.sharded ? 'sharded' : 'one module'}</span>
            <span className="out-hint">{timeline.backend.description}</span>
          </div>
          <div className="out-row">
            <span className="out-label">Recorded per step</span>
            <span className="out-value">
              {timeline.detail.amps ? 'every amplitude' : 'summary'}
            </span>
            <span className="out-hint">
              {timeline.detail.amps
                ? `${formatBytes(timeline.amplitudeCount * 16)} × ${timeline.frames.length} frames`
                : `Bloch vectors and the largest amplitudes — full states stop at ${AMPS_QUBIT_LIMIT} qubits`}
            </span>
          </div>
          <div className="out-row">
            <span className="out-label">Correlation links</span>
            <span className="out-value">{timeline.detail.links ? 'on' : 'off'}</span>
            <span className="out-hint">
              {timeline.detail.links
                ? 'one pass over the state per qubit pair, every step'
                : 'too costly at this register size'}
            </span>
          </div>
        </>
      )}

      {limits && (
        <p className="note">
          This build: {limits.maxWholeState} qubits in one module ({formatBytes(2 ** limits.maxWholeState * 16)}),
          full arrays out of WASM to {limits.fullArrayLimit}, {limits.maxShardQubits} qubits a shard.
          Sharded runs are capped at {ceiling('sharded', true, limits)} qubits here as a guard
          rail, not by the engine — past that the limit is the machine's memory.
        </p>
      )}
    </section>
  );
}
