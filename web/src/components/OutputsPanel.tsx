/**
 * What the run produced: the program's own readouts, the classical bits, and
 * the engine's norm as a sanity check.
 *
 * A row's explanation is on hover rather than under it. Every one of these used
 * to be a wrapped line of prose in a 300px column, which is most of why this
 * panel was three screens long. Hover rather than an ⓘ per row: the row is
 * already a hit target, and six more little buttons is not simpler.
 *
 * These describe the end of the run, deliberately. A readout is the answer, and
 * an answer that changed as you scrubbed the timeline would not be one — the
 * views are what show the state mid-circuit. The norm is the exception: it is a
 * property of wherever the playhead is, and worth watching there.
 */
import type { Readout } from '../lib/types';
import { useTip } from './Tooltip';

interface Props {
  readouts: Readout[];
  bits: Record<string, number>;
  norm: number;
  /** The basis state the run collapsed to, once it has been read out. */
  collapsed: {
    index: number;
    ket: string;
    source: 'draw' | 'best';
    /** The program's score for it, when the program scores outcomes. */
    score: number | null;
    best: { index: number; score: number; count: number; rank: number } | null;
  } | null;
  /** Bit names the readout created — folded into `collapsed` rather than listed. */
  hideBits: string[];
}

export function OutputsPanel({ readouts, bits, norm, collapsed, hideBits }: Props) {
  const { bind, node } = useTip();
  const hero = readouts.find((r) => r.hero);
  const rest = readouts.filter((r) => r !== hero);
  const hidden = new Set(hideBits);
  const bitNames = Object.keys(bits).filter((b) => !hidden.has(b));

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
        <div
          className={`out-row${r.hint ? ' has-note' : ''}`}
          key={r.label}
          {...(r.hint ? bind(r.hint, true) : {})}
        >
          <span className="out-label">{r.label}</span>
          <span className="out-value">{r.value}</span>
        </div>
      ))}

      {collapsed && (
        <div
          className="out-row has-note"
          {...bind(
            collapsed.source === 'best'
              ? `The best-scoring of the shots — it came up ${
                  collapsed.best?.count ?? 0
                } time(s), ranked ${collapsed.best?.rank ?? 0} by frequency. Selecting the best of many draws is how a sampling algorithm is used, but it is a selection, not a measurement.`
              : collapsed.score !== null && collapsed.best
                ? `This draw scores ${collapsed.score.toFixed(
                    4,
                  )}; the best of the shots scored ${collapsed.best.score.toFixed(
                    4,
                  )}. One measurement is one sample — the answer is the best of them.`
                : 'One sample. The register is definite now, and looking again would give the same answer.',
            true,
          )}
        >
          <span className="out-label">
            {collapsed.source === 'best' ? 'Best shot' : 'One draw'}
          </span>
          <span className="out-value">{collapsed.ket}</span>
        </div>
      )}

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

      <div
        className="out-row has-note"
        {...bind('Total probability at the playhead. 1 for any correct unitary sequence.', true)}
      >
        <span className="out-label">Norm</span>
        <span className="out-value">{norm.toFixed(12)}</span>
      </div>
      {node}
    </div>
  );
}
