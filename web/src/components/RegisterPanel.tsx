/**
 * How the register is held, and what is being recorded of it.
 *
 * Read-only. There used to be a choice here — one module or sharded, plus a
 * toggle to unlock a higher ceiling — and it was a setting nobody wanted to
 * think about guarding a limit that was not the machine's. Everything is
 * sharded now, so this reports rather than asks.
 */
import type { EngineLimits } from '../lib/backend';
import { formatBytes } from '../lib/backend';
import { AMPS_QUBIT_LIMIT, CEILING } from '../lib/runner';
import type { Timeline } from '../lib/types';
import { Info } from './Info';

interface Props {
  timeline: Timeline | null;
  limits: EngineLimits | null;
}

export function RegisterPanel({ timeline, limits }: Props) {
  return (
    <section className="card">
      <h2 className="card-title">
        Register{' '}
        <Info about="the register">
          {`Always sharded: one WASM module per worker, each with its own address space, so K shards hold K times what one module can and the ceiling is the machine's memory rather than a 2 GiB cap on a single allocation. A shard holds ${
            limits?.maxShardQubits ?? 26
          } qubits, and ${CEILING} qubits — ${formatBytes(
            2 ** CEILING * 16,
          )} across 16 shards — is the guard rail here. Cost grows as n·2^n per step, so past the low twenties this is a batch job with a progress line rather than playback.`}
        </Info>
      </h2>

      {timeline ? (
        <>
          <div className="out-row">
            <span className="out-label">Held as</span>
            <span className="out-value">
              {timeline.backend.shards} × {formatBytes(2 ** timeline.nQubits * 16 / timeline.backend.shards)}
            </span>
          </div>
          <div className="out-row">
            <span className="out-label">Total state</span>
            <span className="out-value">{formatBytes(2 ** timeline.nQubits * 16)}</span>
          </div>
          <div className="out-row">
            <span className="out-label">Recorded</span>
            <span className="out-value">
              {timeline.detail.amps ? 'every amplitude' : 'summary'}
            </span>
          </div>
        </>
      ) : (
        <p className="field-hint">starting…</p>
      )}

      <p className="note">
        Whole states are kept to {AMPS_QUBIT_LIMIT} qubits; past that a frame holds the Bloch
        vectors and the largest amplitudes, which is all a view draws.
      </p>
    </section>
  );
}
