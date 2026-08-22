/**
 * What the run produced: the program's own readouts, the classical bits, and
 * the engine's norm as a sanity check.
 *
 * Readouts update with the playhead, not just at the end — a half-finished run
 * shows a half-finished answer, which is the interesting part when stepping.
 */
import type { Readout } from '../lib/types';

interface Props {
  readouts: Readout[];
  bits: Record<string, number>;
  norm: number;
  finished: boolean;
}

export function OutputsPanel({ readouts, bits, norm, finished }: Props) {
  const hero = readouts.find((r) => r.hero);
  const rest = readouts.filter((r) => r !== hero);
  const bitNames = Object.keys(bits);

  return (
    <div>
      {hero && (
        <div className="hero">
          <div className="hero-label">{hero.label}</div>
          <div className="hero-value">{hero.value}</div>
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
          total probability — 1 for any correct unitary sequence
          {finished ? '' : ', mid-run'}
        </span>
      </div>
    </div>
  );
}
