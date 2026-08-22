/**
 * The state vector itself: one bar per basis state, plus the phases.
 *
 * Probability and phase are two different things and get two different
 * encodings rather than one colour-coded bar — height for probability, an angle
 * for phase. A phase is a direction, so a dial reads correctly at a glance and
 * survives being printed in greyscale.
 *
 * Bars are placed at their basis index on a linear axis, so the picture stays
 * the same shape as the register grows. Past one mark per pixel the marks are
 * binned by column and each one is the largest amplitude in its column — a
 * spectrum rather than a bar per state, which is the only honest way to draw
 * more states than there are pixels. The note says when that is happening.
 */
import type { BasisEntry } from '../lib/analysis';
import { bitString, bytes, complex, fixed, ket, pct } from '../lib/format';
import { useMeasure } from '../lib/useMeasure';
import { useTip } from '../components/Tooltip';
import type { ViewProps } from './types';

/** Fixed y-axis stops. Snapping to these keeps the axis from twitching on every
 *  step, which would make the bars impossible to compare across a run. */
const STOPS = [0.05, 0.125, 0.25, 0.5, 1];

const PLOT_H = 210;
const DIAL_H = 54;
const MARGIN = { top: 12, right: 16, bottom: 26, left: 46 };
/** A dial narrower than this collides with its neighbour. */
const DIAL_MIN_GAP = 18;
/** Enough hit targets to cover any state worth hovering, without 4096 rects. */
const MAX_HITS = 512;

export function StateVectorView({ analysis }: ViewProps) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const { bind, node } = useTip();
  const { support, supportTruncated, nQubits, likeliest, amplitudeCount: count } = analysis;

  const plotW = Math.max(180, width - MARGIN.left - MARGIN.right);
  const maxP = support.length > 0 ? support[0].prob : 0;
  const domain = STOPS.find((s) => maxP <= s + 1e-9) ?? 1;
  const slot = plotW / count;
  // A wide axis with only a few occupied states would draw sub-pixel marks and
  // read as an empty chart, so a sparse distribution gets a visible minimum.
  const floorW = support.length <= 128 ? 4 : 1;
  const barW = Math.max(floorW, Math.min(24, slot - (slot > 6 ? 2 : 0)));

  const x = (i: number) => MARGIN.left + (i + 0.5) * slot;
  const y = (p: number) => MARGIN.top + PLOT_H * (1 - p / domain);

  // One mark per pixel column at most, carrying the largest amplitude in it.
  const binned = support.length > plotW;
  const marks = binned ? binByColumn(support, count, plotW) : support;

  const significant = support.filter((e) => e.prob > 0.002).slice(0, 64);
  const sortedByIndex = [...significant].sort((a, b) => a.index - b.index);
  let minGap = Infinity;
  for (let i = 1; i < sortedByIndex.length; i++) {
    minGap = Math.min(minGap, x(sortedByIndex[i].index) - x(sortedByIndex[i - 1].index));
  }
  const showDials = sortedByIndex.length > 0 && minGap >= DIAL_MIN_GAP;

  // Dials are 8px in radius, so pin them inside the plot; a bar at index 0 or
  // 2^n - 1 sits right on the edge.
  const dialX = (i: number) =>
    Math.max(MARGIN.left + 9, Math.min(MARGIN.left + plotW - 9, x(i)));
  const ticks = axisTicks(count);
  const hits = support.slice(0, MAX_HITS);

  return (
    <div ref={ref}>
      <svg
        width={Math.max(width, 200)}
        height={MARGIN.top + PLOT_H + MARGIN.bottom + (showDials ? DIAL_H : 0)}
        role="img"
        aria-label="State vector"
      >
        {/* Gridlines carry the values the bars are not labelled with. */}
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
              {pct(domain * f, domain <= 0.125 ? 1 : 0)}
            </text>
          </g>
        ))}

        {/* Bars: probability of each basis state. Rounded at the data end,
            square at the baseline. */}
        {marks.map((e) => {
          const h = PLOT_H * (e.prob / domain);
          if (h < 0.4) return null;
          return (
            <path
              key={e.index}
              d={bar(x(e.index) - barW / 2, barW, y(e.prob), MARGIN.top + PLOT_H)}
              fill={e.index === likeliest ? 'var(--blue)' : 'var(--blue-300)'}
            />
          );
        })}

        {ticks.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={MARGIN.top + PLOT_H + 15}
            textAnchor="middle"
            fontSize={10}
            fill="var(--text-muted)"
            className="mono"
          >
            {count <= 32 ? bitString(i, nQubits) : i.toLocaleString()}
          </text>
        ))}
        {/* Phase dials, aligned under the bars they belong to. */}
        {showDials && (
          <g transform={`translate(0, ${MARGIN.top + PLOT_H + MARGIN.bottom})`}>
            <text x={MARGIN.left - 8} y={16} textAnchor="end" fontSize={10} fill="var(--text-muted)">
              phase
            </text>
            {sortedByIndex.map((e) => (
              <g key={e.index} transform={`translate(${dialX(e.index)}, 14)`}>
                <circle r={8} fill="none" stroke="var(--grid)" />
                <line
                  x1={0}
                  y1={0}
                  x2={8 * Math.cos(e.phase)}
                  y2={-8 * Math.sin(e.phase)}
                  stroke="var(--blue)"
                  strokeWidth={2}
                  strokeLinecap="round"
                />
              </g>
            ))}
          </g>
        )}

        {/* Hit targets, wider than the marks they cover. */}
        {hits.map((e) => (
          <rect
            key={`h-${e.index}`}
            x={x(e.index) - Math.max(barW, 8) / 2}
            y={MARGIN.top}
            width={Math.max(barW, 8)}
            height={PLOT_H}
            fill="transparent"
            {...bind(
              `${ket(e.index, nQubits)}  (index ${e.index})\n` +
                `probability  ${pct(e.prob, 3)}\n` +
                `amplitude    ${complex(e.re, e.im)}\n` +
                `phase        ${fixed(e.phase, 3)} rad`,
            )}
          />
        ))}
      </svg>

      <p className="note">
        {supportTruncated
          ? `The ${support.length} largest of ${count.toLocaleString()} basis states — the rest are below the recorded floor.`
          : `${support.length.toLocaleString()} of ${count.toLocaleString()} basis states carry any amplitude.`}
        {binned &&
          ` More states than pixels, so each mark is the largest of the ${Math.ceil(
            support.length / marks.length,
          )} or so sharing its column.`}
        {!showDials && support.length > 0 && ' Phases are too dense to dial here — see the table.'}
        {significant.length < support.length &&
          showDials &&
          ` Dials shown for the ${
            significant.length === 1 ? 'one state' : `${significant.length} states`
          } above 0.2%.`}
      </p>

      <table className="data">
        <thead>
          <tr>
            <th>State</th>
            <th>Index</th>
            <th>Probability</th>
            <th>Amplitude</th>
            <th>Phase</th>
          </tr>
        </thead>
        <tbody>
          {support.slice(0, 8).map((e) => (
            <tr key={e.index} className={e.index === likeliest ? 'is-peak' : undefined}>
              <td>{ket(e.index, nQubits)}</td>
              <td>{e.index}</td>
              <td>{pct(e.prob, 3)}</td>
              <td>{complex(e.re, e.im)}</td>
              <td>{fixed(e.phase, 3)}</td>
            </tr>
          ))}
          {support.length === 0 && (
            <tr>
              <td colSpan={5}>no amplitude anywhere — the register is empty</td>
            </tr>
          )}
        </tbody>
      </table>
      {support.length > 8 && (
        <p className="note">Showing the 8 largest of {support.length} occupied states.</p>
      )}
      <p className="note">
        Register: {nQubits} qubits, {count.toLocaleString()} amplitudes, {bytes(count * 16)} in the
        engine.
      </p>
      {node}
    </div>
  );
}

/** Up to nine evenly spaced basis indices, always including the ends. */
function axisTicks(count: number): number[] {
  if (count <= 16) return Array.from({ length: count }, (_, i) => i);
  const step = Math.ceil(count / 8);
  const out: number[] = [];
  for (let i = 0; i < count; i += step) out.push(i);
  if (out[out.length - 1] !== count - 1) out.push(count - 1);
  return out;
}

/** A bar with a 4px rounded data end and a square baseline. */
function bar(x0: number, w: number, top: number, base: number): string {
  const r = Math.min(4, w / 2, Math.max(0, base - top));
  const x1 = x0 + w;
  if (r <= 0.5) return `M${x0},${top} H${x1} V${base} H${x0} Z`;
  return (
    `M${x0},${base} V${top + r} Q${x0},${top} ${x0 + r},${top} ` +
    `H${x1 - r} Q${x1},${top} ${x1},${top + r} V${base} Z`
  );
}

/**
 * Collapse the support to one entry per pixel column, keeping the largest.
 *
 * Keeping the largest rather than averaging is deliberate: the question a state
 * vector answers is "where is the probability", and a peak one state wide must
 * not be averaged away by its empty neighbours.
 */
function binByColumn(support: BasisEntry[], count: number, plotW: number): BasisEntry[] {
  const columns = Math.max(1, Math.floor(plotW));
  const best = new Map<number, BasisEntry>();
  for (const e of support) {
    const column = Math.floor((e.index / count) * columns);
    const current = best.get(column);
    if (!current || e.prob > current.prob) best.set(column, e);
  }
  return [...best.values()];
}
