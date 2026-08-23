/**
 * Every amplitude as a point in the complex plane.
 *
 * This is the only view where phase is exact rather than encoded: the angle on
 * screen *is* the phase, and the distance from the origin is the magnitude. Run
 * the Fourier transform here and the winding is visible directly — the points
 * space themselves evenly around the circle at a rate set by the input.
 *
 * The radial scale is the smallest power of two that contains the largest
 * amplitude, and it is written on the outer ring. Powers of two rather than a
 * fit to the data for a reason: a uniform superposition of 2^n states puts every
 * amplitude at exactly 2^(-n/2), so a scale pinned to 1 squeezes the whole
 * picture into a dot near the origin, while a scale fitted to the maximum would
 * twitch on every step. Snapping to powers of two only changes when the largest
 * amplitude crosses one, so a point that moves has actually moved.
 */
import { complex, fixed, ket, pct } from '../lib/format';
import { useMeasure } from '../lib/useMeasure';
import { useTip } from '../components/Tooltip';
import { ViewFooter } from '../components/ViewFooter';
import type { ViewProps } from './types';

/** Points below this are drawn but not labelled; labels are for the story. */
const LABEL_LIMIT = 8;
const PAD = 34;

export function ComplexPlaneView({ analysis }: ViewProps) {
  const { ref, width, height } = useMeasure<HTMLDivElement>();
  const { bind, node } = useTip();
  const { support, supportTruncated, nQubits, amplitudeCount } = analysis;

  const size =
    Math.floor(Math.max(220, Math.min(width || 520, (height || 520) - 150)) / 8) * 8;
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - PAD;
  // Smallest power of two that contains every amplitude.
  const peak = support.length > 0 ? support[0].mag : 1;
  const scale = peak > 0 ? Math.min(1, 2 ** Math.ceil(Math.log2(peak))) : 1;

  const px = (re: number) => cx + (R * re) / scale;
  const py = (im: number) => cy - (R * im) / scale;

  // Labels only where one will not land on top of another. A uniform state puts
  // hundreds of points at the same radius, and stacking their names reads worse
  // than leaving them to the tooltip.
  const labelled: typeof support = [];
  const placed: [number, number][] = [];
  for (const e of support) {
    if (labelled.length >= LABEL_LIMIT) break;
    const at: [number, number] = [px(e.re), py(e.im)];
    if (placed.some(([lx, ly]) => Math.hypot(lx - at[0], ly - at[1]) < 30)) continue;
    placed.push(at);
    labelled.push(e);
  }

  return (
    <div
      ref={ref}
      style={{ height: '100%', minHeight: 340, display: 'grid', justifyItems: 'center', alignContent: 'center' }}
    >
      <svg width={size} height={size} role="img" aria-label="Amplitudes in the complex plane">
        {/* Magnitude rings. The outer one is |amplitude| = 1. */}
        {[0.25, 0.5, 0.75, 1].map((m) => (
          <circle
            key={m}
            cx={cx}
            cy={cy}
            r={R * m}
            fill="none"
            stroke={m === 1 ? 'var(--axis)' : 'var(--grid)'}
          />
        ))}
        <line x1={cx - R} x2={cx + R} y1={cy} y2={cy} stroke="var(--axis)" />
        <line x1={cx} x2={cx} y1={cy - R} y2={cy + R} stroke="var(--axis)" />

        <text x={cx + R + 4} y={cy + 4} fontSize={10} fill="var(--text-muted)">
          Re
        </text>
        <text x={cx + 5} y={cy - R - 4} fontSize={10} fill="var(--text-muted)">
          Im
        </text>
        {[0.5, 1].map((m) => (
          <text
            key={m}
            x={cx + R * m + 3}
            y={cy - 5}
            fontSize={9}
            fill="var(--text-muted)"
            className="mono"
          >
            {magnitude(scale * m)}
          </text>
        ))}

        {/* Stems, so a point near the origin still reads as a direction. */}
        {support.map((e) => (
          <line
            key={`s-${e.index}`}
            x1={cx}
            y1={cy}
            x2={px(e.re)}
            y2={py(e.im)}
            stroke="var(--blue)"
            strokeOpacity={0.28}
            strokeWidth={1}
          />
        ))}

        {support.map((e) => (
          <circle
            key={e.index}
            cx={px(e.re)}
            cy={py(e.im)}
            r={4 + 7 * e.prob}
            fill="var(--blue)"
            fillOpacity={0.85}
            stroke="var(--surface-1)"
            strokeWidth={2}
            {...bind(
              `${ket(e.index, nQubits)}\n` +
                `amplitude ${complex(e.re, e.im)}\n` +
                `magnitude ${fixed(e.mag)}   phase ${fixed(e.phase, 3)} rad\n` +
                `probability ${pct(e.prob, 3)}`,
            )}
          />
        ))}

        {/* Labels only on the largest few, placed radially outward. */}
        {labelled.map((e) => {
          const r = Math.hypot(e.re, e.im) || 1;
          const ox = (e.re / r) * 16;
          const oy = (e.im / r) * 16;
          return (
            <text
              key={`l-${e.index}`}
              x={px(e.re) + ox}
              y={py(e.im) - oy + 3}
              textAnchor={ox > 4 ? 'start' : ox < -4 ? 'end' : 'middle'}
              fontSize={10}
              className="mono"
              fill="var(--text-secondary)"
            >
              {ket(e.index, nQubits)}
            </text>
          );
        })}
      </svg>

      <ViewFooter
        legend={[
          { mark: { kind: 'dot', colour: 'var(--blue)' }, label: 'one amplitude — area is its probability' },
          { mark: { kind: 'line', colour: 'var(--axis)' }, label: `outer ring is magnitude ${magnitude(scale)}` },
        ]}
        caption={
          supportTruncated
            ? `The ${support.length} largest of ${amplitudeCount.toLocaleString()} amplitudes; the ${LABEL_LIMIT} biggest are labelled.`
            : `${support.length.toLocaleString()} of ${amplitudeCount.toLocaleString()} amplitudes are non-zero${
                support.length > LABEL_LIMIT ? `; the ${LABEL_LIMIT} largest are labelled` : ''
              }.`
        }
      />
      {node}
    </div>
  );
}

/** Magnitudes as a fraction when they are a power of two, else as a decimal. */
function magnitude(m: number): string {
  const inv = 1 / m;
  const rounded = Math.round(inv);
  return Math.abs(inv - rounded) < 1e-9 && rounded > 1 ? `1/${rounded}` : m.toPrecision(3);
}
