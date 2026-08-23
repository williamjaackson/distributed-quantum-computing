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
import { Info } from './Info';

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
      <h2 className="card-title">
        Execution{' '}
        <Info about="execution">
          {`${chosen.hint}. ` +
            (timeline
              ? `Right now: ${timeline.backend.description}, recording ${
                  timeline.detail.amps ? 'every amplitude' : 'a summary'
                } per step, correlation links ${timeline.detail.links ? 'on' : 'off'}. ` +
                `Full states stop at ${AMPS_QUBIT_LIMIT} qubits; past that a frame keeps the Bloch vectors and the largest amplitudes, which is all a view draws. `
              : '') +
            (limits
              ? `This build holds ${limits.maxWholeState} qubits in one module (${formatBytes(
                  2 ** limits.maxWholeState * 16,
                )}), returns full arrays out of WASM to ${limits.fullArrayLimit}, and puts ${
                  limits.maxShardQubits
                } qubits in a shard. Sharded runs are capped at ${ceiling(
                  'sharded',
                  true,
                  limits,
                )} here as a guard rail, not by the engine — past that the limit is the machine's memory.`
              : '')}
        </Info>
      </h2>

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

      <div className="field field-inline">
        <label className="switch">
          <input type="checkbox" checked={unlocked} onChange={(e) => onUnlocked(e.target.checked)} />
          <span className="field-label">Go past {INTERACTIVE_QUBITS} qubits</span>
        </label>
        <Info about="the qubit ceiling">
          {unlocked
            ? `The ceiling is ${cap} qubits. A step costs a pass over the state per qubit, so expect a wait rather than playback.`
            : `${INTERACTIVE_QUBITS} qubits is the last size where a step is still about 60 ms — 10 ms at 16, 250 ms at 24. Turn this on to reach ${ceiling(
                execution,
                true,
                limits,
              )}.`}
        </Info>
      </div>
    </section>
  );
}
