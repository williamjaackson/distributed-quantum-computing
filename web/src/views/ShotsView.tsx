/**
 * What a real machine would hand back: counts from repeated measurement.
 *
 * Everything else in this app shows the amplitudes, which no experiment can
 * see. This view calls the engine's own sampler on the state as it stands at the
 * playhead, so the bars are draws and the ticks are the exact probabilities —
 * the gap between them is sampling noise, and it shrinks as the shot count goes
 * up.
 *
 * Sampling means replaying the program to the playhead on a fresh register,
 * because a recorded frame is a summary rather than a state. That is instant on
 * a small register and genuinely expensive on a large one, so past
 * `AUTO_SAMPLE_LIMIT` it waits to be asked.
 */
import { useCallback, useEffect, useState } from 'react';
import { sampleAt } from '../lib/runner';
import { ket, pct } from '../lib/format';
import { useMeasure } from '../lib/useMeasure';
import { useTip } from '../components/Tooltip';
import type { ViewProps } from './types';

const SHOT_OPTIONS = [128, 1024, 8192, 65536];
const PLOT_H = 230;
const MARGIN = { top: 12, right: 16, bottom: 42, left: 46 };
/** Outcomes are ranked by count; past this the tail becomes one bar. */
const MAX_BARS = 32;
/** Above this register size, a replay costs enough to be worth asking about. */
const AUTO_SAMPLE_LIMIT = 16;

export function ShotsView({ timeline, index, analysis, execution }: ViewProps) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const { bind, node } = useTip();
  const [shots, setShots] = useState(1024);
  const [round, setRound] = useState(0);
  const [draws, setDraws] = useState<{ index: number; count: number }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const auto = timeline.nQubits <= AUTO_SAMPLE_LIMIT;

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // The seed moves with the playhead and the resample counter, so stepping
      // does not silently reuse one draw and "resample" actually resamples.
      const counts = await sampleAt(
        timeline,
        index,
        shots,
        0x51ede + round * 7919 + index * 104729,
        execution,
      );
      setDraws([...counts].map(([i, count]) => ({ index: i, count })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [timeline, index, shots, round, execution]);

  useEffect(() => {
    if (!auto) {
      setDraws(null);
      return;
    }
    let alive = true;
    void (async () => {
      await run();
      if (!alive) setDraws(null);
    })();
    return () => {
      alive = false;
    };
  }, [auto, run]);

  const total = (draws ?? []).reduce((a, d) => a + d.count, 0) || 1;
  const ranked = [...(draws ?? [])].sort((a, b) => b.count - a.count);
  const shown = ranked.slice(0, MAX_BARS);
  const hidden = ranked.slice(MAX_BARS);
  const hiddenCount = hidden.reduce((a, d) => a + d.count, 0);

  // Exact probabilities come from the recorded top-k, which covers every state a
  // sampler is at all likely to hit.
  const exactOf = new Map(analysis.support.map((e) => [e.index, e.prob]));
  const exact = (i: number) => exactOf.get(i) ?? 0;

  const plotW = Math.max(200, (width || 600) - MARGIN.left - MARGIN.right);
  const slots = shown.length + (hiddenCount > 0 ? 1 : 0);
  const slot = plotW / Math.max(1, slots);
  const barW = Math.max(2, Math.min(24, slot - 2));
  const maxShare = Math.max(
    ...shown.map((d) => d.count / total),
    ...shown.map((d) => exact(d.index)),
    0.05,
  );
  const domain = Math.min(1, Math.ceil(maxShare * 10) / 10);

  const x = (i: number) => MARGIN.left + (i + 0.5) * slot;
  const y = (share: number) => MARGIN.top + PLOT_H * (1 - share / domain);

  return (
    <div ref={ref}>
      <div className="controls" style={{ marginBottom: 8 }}>
        <span className="field-hint">shots</span>
        <div className="speed-buttons">
          {SHOT_OPTIONS.map((s) => (
            <button key={s} aria-pressed={s === shots} onClick={() => setShots(s)}>
              {s.toLocaleString()}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => (auto ? setRound((r) => r + 1) : void run())} disabled={busy}>
          {busy ? 'Sampling…' : draws ? 'Resample' : 'Sample'}
        </button>
        {!auto && (
          <span className="field-hint">
            {timeline.nQubits} qubits — each draw replays the circuit, so it is on request
          </span>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {draws === null ? (
        <p className="note">No sample yet.</p>
      ) : (
        <>
          <svg
            width={Math.max(width, 220)}
            height={MARGIN.top + PLOT_H + MARGIN.bottom}
            role="img"
            aria-label="Sampled measurement outcomes"
          >
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <g key={f}>
                <line
                  x1={MARGIN.left}
                  x2={MARGIN.left + plotW}
                  y1={y(domain * f)}
                  y2={y(domain * f)}
                  stroke={f === 0 ? 'var(--axis)' : 'var(--grid)'}
                />
                <text
                  x={MARGIN.left - 8}
                  y={y(domain * f) + 4}
                  textAnchor="end"
                  fontSize={10}
                  fill="var(--text-muted)"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {pct(domain * f, 0)}
                </text>
              </g>
            ))}

            {shown.map((d, i) => {
              const share = d.count / total;
              return (
                <g key={d.index}>
                  <rect
                    x={x(i) - barW / 2}
                    y={y(share)}
                    width={barW}
                    height={PLOT_H * (share / domain)}
                    rx={Math.min(4, barW / 2)}
                    fill="var(--blue-300)"
                  />
                  {/* Exact probability, as a tick across the bar. */}
                  <line
                    x1={x(i) - barW / 2 - 3}
                    x2={x(i) + barW / 2 + 3}
                    y1={y(exact(d.index))}
                    y2={y(exact(d.index))}
                    stroke="var(--text-primary)"
                    strokeWidth={2}
                  />
                  <text
                    x={x(i)}
                    y={MARGIN.top + PLOT_H + 14}
                    textAnchor="middle"
                    fontSize={9}
                    className="mono"
                    fill="var(--text-muted)"
                    transform={
                      slot < 34 ? `rotate(-45, ${x(i)}, ${MARGIN.top + PLOT_H + 14})` : undefined
                    }
                  >
                    {ket(d.index, analysis.nQubits)}
                  </text>
                  <rect
                    x={x(i) - slot / 2}
                    y={MARGIN.top}
                    width={slot}
                    height={PLOT_H}
                    fill="transparent"
                    {...bind(
                      `${ket(d.index, analysis.nQubits)}\n` +
                        `sampled ${d.count.toLocaleString()} / ${total.toLocaleString()} = ${pct(
                          share,
                          2,
                        )}\n` +
                        `exact   ${pct(exact(d.index), 2)}`,
                    )}
                  />
                </g>
              );
            })}

            {hiddenCount > 0 && (
              <g>
                <rect
                  x={x(shown.length) - barW / 2}
                  y={y(hiddenCount / total)}
                  width={barW}
                  height={PLOT_H * (hiddenCount / total / domain)}
                  rx={Math.min(4, barW / 2)}
                  fill="var(--axis)"
                />
                <text
                  x={x(shown.length)}
                  y={MARGIN.top + PLOT_H + 14}
                  textAnchor="middle"
                  fontSize={9}
                  fill="var(--text-muted)"
                >
                  other
                </text>
              </g>
            )}
          </svg>

          <div className="legend">
            <span className="legend-item">
              <span className="swatch" style={{ background: 'var(--blue-300)' }} />
              sampled share of {total.toLocaleString()} shots
            </span>
            <span className="legend-item">
              <svg width={18} height={8} aria-hidden>
                <line x1={0} y1={4} x2={18} y2={4} stroke="var(--text-primary)" strokeWidth={2} />
              </svg>
              exact probability
            </span>
            {hiddenCount > 0 && (
              <span className="legend-item">
                <span className="swatch" style={{ background: 'var(--axis)' }} />
                {hidden.length} rarer outcomes, combined
              </span>
            )}
          </div>

          <table className="data">
            <thead>
              <tr>
                <th>Outcome</th>
                <th>Shots</th>
                <th>Sampled</th>
                <th>Exact</th>
              </tr>
            </thead>
            <tbody>
              {ranked.slice(0, 8).map((d) => (
                <tr key={d.index}>
                  <td>{ket(d.index, analysis.nQubits)}</td>
                  <td>{d.count.toLocaleString()}</td>
                  <td>{pct(d.count / total, 2)}</td>
                  <td>{pct(exact(d.index), 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">
            {ranked.length} distinct outcome{ranked.length === 1 ? '' : 's'} in this draw
            {ranked.length > 8 ? '; the 8 most frequent are tabled.' : '.'} Sampling does not
            disturb the state — the playhead is exactly where it was.
          </p>
        </>
      )}
      {node}
    </div>
  );
}
