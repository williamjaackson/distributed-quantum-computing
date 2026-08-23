/**
 * What the run computed, in the same shape for every program.
 *
 * Answer, then what it should have been, then how sure — the three questions
 * every one of these programs is answering. They used to each invent their own
 * rows, so reading a new program's output meant working out its vocabulary
 * first. Now the skeleton is fixed and only the words inside it change.
 *
 * A row's explanation is on hover rather than under it. Every one of these used
 * to be a wrapped line of prose in a narrow column, which is most of why this
 * panel ran three screens long. Hover rather than an ⓘ per row: the row is
 * already a hit target, and six more little buttons is not simpler.
 *
 * These describe the end of the circuit, deliberately. A readout collapses the
 * state to one draw, and an answer that changed as you scrubbed would not be
 * one; the views are what show the state mid-circuit.
 */
import type { ProgramResult } from '../lib/types';
import { useTip } from './Tooltip';

interface Props {
  result: ProgramResult | null;
  bits: Record<string, number>;
  norm: number;
  /** The basis state the run collapsed to, once it has been read out. */
  collapsed: {
    index: number;
    ket: string;
    source: 'draw' | 'best';
    score: number | null;
    best: { index: number; score: number; count: number; rank: number } | null;
  } | null;
  /** Bit names the readout created — folded into `collapsed` rather than listed. */
  hideBits: string[];
}

export function OutputsPanel({ result, bits, norm, collapsed, hideBits }: Props) {
  const { bind, node } = useTip();
  const hidden = new Set(hideBits);
  const bitNames = Object.keys(bits).filter((b) => !hidden.has(b));

  function Row({ label, value, note }: { label: string; value: string; note?: string }) {
    return (
      <div className={`out-row${note ? ' has-note' : ''}`} {...(note ? bind(note, true) : {})}>
        <span className="out-label">{label}</span>
        <span className="out-value">{value}</span>
      </div>
    );
  }

  return (
    <div>
      {result ? (
        <>
          <div className="hero">
            <div className="hero-label">Answer</div>
            <div className={`hero-value${result.answer.length > 14 ? ' is-long' : ''}`}>
              {result.answer}
            </div>
            {result.answerNote && <div className="hero-hint">{result.answerNote}</div>}
          </div>

          {result.expected !== undefined && (
            <div
              className="out-row has-note"
              {...bind(
                result.correct
                  ? 'The run agrees with the answer worked out independently — by exhaustive search, by arithmetic, or from the analytic form.'
                  : 'The run disagrees with the answer worked out independently. Either the parameters are not good enough, or something is wrong.',
                true,
              )}
            >
              <span className="out-label">Expected</span>
              <span className="out-value">{result.expected}</span>
              {result.correct !== undefined && (
                <span className={`verdict${result.correct ? ' is-match' : ' is-miss'}`}>
                  {result.correct ? '✓ matches' : '✗ differs'}
                </span>
              )}
            </div>
          )}

          {result.confidence && (
            <Row label="Confidence" value={result.confidence} note={result.confidenceNote} />
          )}

          {result.detail?.map((d) => (
            <Row key={d.label} label={d.label} value={d.value} note={d.note} />
          ))}
        </>
      ) : (
        <p className="field-hint">no result yet</p>
      )}

      {collapsed && (
        <Row
          label={collapsed.source === 'best' ? 'Best shot' : 'One draw'}
          value={collapsed.ket}
          note={
            collapsed.source === 'best'
              ? `The best-scoring of the shots — it came up ${
                  collapsed.best?.count ?? 0
                } time(s), ranked ${
                  collapsed.best?.rank ?? 0
                } by frequency. Selecting the best of many draws is how a sampling algorithm is used, but it is a selection, not a measurement.`
              : collapsed.score !== null && collapsed.best
                ? `This draw scores ${collapsed.score.toFixed(
                    4,
                  )}; the best of the shots scored ${collapsed.best.score.toFixed(
                    4,
                  )}. One measurement is one sample — the answer is the best of them.`
                : 'One sample. The register is definite now, and looking again would give the same answer.'
          }
        />
      )}

      {bitNames.length > 0 && (
        <Row
          label="Classical bits"
          value={bitNames.map((n) => `${n}=${bits[n]}`).join(' ')}
          note="Bits the circuit measured for itself, mid-run — not the final readout."
        />
      )}

      <Row
        label="Norm"
        value={norm.toFixed(12)}
        note="Total probability at the playhead. 1 for any correct unitary sequence."
      />
      {node}
    </div>
  );
}
