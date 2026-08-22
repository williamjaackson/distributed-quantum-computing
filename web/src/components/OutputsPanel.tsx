/**
 * What the run produced: the program's own readouts, the classical bits, and
 * the engine's norm as a sanity check.
 *
 * These describe the end of the run, deliberately. A readout is the answer, and
 * an answer that changed as you scrubbed the timeline would not be one — the
 * views are what show the state mid-circuit. The norm is the exception: it is a
 * property of wherever the playhead is, and worth watching there.
 */
import type { Readout } from '../lib/types';

interface Props {
  readouts: Readout[];
  bits: Record<string, number>;
  norm: number;
}

export function OutputsPanel({ readouts, bits, norm }: Props) {
  const hero = readouts.find((r) => r.hero);
  const rest = readouts.filter((r) => r !== hero);
  const bitNames = Object.keys(bits);

  return (
    <div>
      {hero && (
        <div className="hero">
          <div className="hero-label">{hero.label}</div>
          <div className={`hero-value${hero.value.length > 14 ? ' is-long' : ''}`}>
            {hero.value}
          </div>
          {hero.hint && <div className="hero-hint">{hero.hint}</div>}
        </div>
      )}

      {rest.map((r) => (
        <div className="out-row" key={r.label}>
          <span className="out-label">{r.label}</span>
          <span className="out-value">{r.value}</span>
          {r.hint && <span className="out-hint">{r.hint}</span>}
        </div>
      ))}

      <div className="out-row">
        <span className="out-label">Classical bits</span>
        {bitNames.length === 0 ? (
          <span className="out-value">none measured</span>
        ) : (
          <span className="out-value">
            <span className="bit-pills">
              {bitNames.map((name) => (
                <span className="bit-pill" key={name}>
                  {name}=<b>{bits[name]}</b>
                </span>
              ))}
            </span>
          </span>
        )}
      </div>

      <div className="out-row">
        <span className="out-label">Norm</span>
        <span className="out-value">{norm.toFixed(12)}</span>
        <span className="out-hint">
          total probability at the playhead — 1 for any correct unitary sequence
        </span>
      </div>
    </div>
  );
}
