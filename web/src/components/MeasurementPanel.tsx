/**
 * What the run measured.
 *
 * This is not a view of the state, which is why it is not one of the tabs. A
 * state vector is not a result — the amplitudes are not something any experiment
 * can read. The answer is what comes back when you measure, repeatedly, and
 * that is a property of the run, so it sits beside the outputs where the answer
 * belongs.
 *
 * Sampled counts are shown against the exact probability, because the gap
 * between them *is* the shot noise, and watching it close as the shot count goes
 * up is the clearest way to see why anyone takes more than one.
 *
 * A table rather than a chart, deliberately. One outcome at 96% beside a dozen
 * at 0.3% makes bars useless — the long one is full, the rest are invisible —
 * and the numbers are the thing being compared anyway.
 */
import type { Analysis } from '../lib/analysis';
import { SHOT_OPTIONS } from '../lib/runner';
import { ket, pct } from '../lib/format';
import { Info } from './Info';
import type { Timeline } from '../lib/types';

interface Props {
  timeline: Timeline;
  analysis: Analysis;
  shots: number;
  onShots: (n: number) => void;
}

/** Outcomes listed before the tail is folded away. */
const ROWS = 6;

export function MeasurementPanel({ timeline, analysis, shots, onShots }: Props) {
  const { measurement } = timeline;
  const total = measurement.taken || 1;
  // A circuit that measures ends in a different state every shot, so there is no
  // single exact distribution to compare against and the column would be a lie.
  const comparable = measurement.method === 'sampled';
  const shown = timeline.shots.slice(0, ROWS);
  const rest = timeline.shots.slice(ROWS);
  const restCount = rest.reduce((a, o) => a + o.count, 0);
  const exact = new Map(analysis.support.map((e) => [e.index, e.prob]));

  return (
    <section className="card">
      <h2 className="card-title">
        Measured{' '}
        <Info about="the measured outcomes">
          {comparable
            ? 'The circuit never measures, so every shot is drawn from one final state and the exact probability is known. The gap between sampled and exact is the shot noise — take more shots and it closes.'
            : 'The circuit measures, so every shot is a separate run of it and there is no single final state to compare against.'}
        </Info>
        <select
          className="compact heading-control"
          value={shots}
          aria-label="Shots"
          onChange={(e) => onShots(Number(e.target.value))}
        >
          {SHOT_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n.toLocaleString()} shots
            </option>
          ))}
        </select>
      </h2>

      {timeline.shots.length === 0 ? (
        <p className="field-hint">Nothing measured — the run did not finish.</p>
      ) : (
        <>
          <table className="data">
            <thead>
              <tr>
                <th>Outcome</th>
                <th>Shots</th>
                {comparable && <th>Exact</th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.index}>
                  <td>{ket(o.index, timeline.nQubits)}</td>
                  <td>{pct(o.count / total, 1)}</td>
                  {comparable && <td>{pct(exact.get(o.index) ?? 0, 1)}</td>}
                </tr>
              ))}
              {restCount > 0 && (
                <tr>
                  <td>{rest.length} rarer</td>
                  <td>{pct(restCount / total, 1)}</td>
                  {comparable && <td />}
                </tr>
              )}
            </tbody>
          </table>

          <p className="note">
            {timeline.shots.length.toLocaleString()} distinct outcome
            {timeline.shots.length === 1 ? '' : 's'} in {measurement.taken.toLocaleString()} shots
            {measurement.note ? ` — ${measurement.note}` : ''}
          </p>
        </>
      )}
    </section>
  );
}
