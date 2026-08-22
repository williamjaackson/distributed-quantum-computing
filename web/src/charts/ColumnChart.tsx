import { useMemo, useState } from 'react';
import { ChartFrame, DEFAULT_MARGINS, Legend } from './ChartFrame';
import { bandScale, extent, linearScale } from './scale';
import { useMeasure } from './useMeasure';

export interface ColumnSeries {
  label: string;
  values: number[];
  colorVar: string;
}

interface ColumnChartProps {
  categories: string[];
  series: ColumnSeries[];
  formatY: (v: number) => string;
  xLabel: string;
  yLabel: string;
  height?: number;
}

/** Bars are capped rather than filling their slot, so the band keeps some air. */
const MAX_BAR_WIDTH = 24;
/** The surface does the separating — never a stroke around the mark. */
const SURFACE_GAP = 2;
const CORNER_RADIUS = 4;

/** Rounded at the data end, square at the baseline. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(CORNER_RADIUS, w / 2, Math.max(h, 0));
  if (h <= 0.5) return `M${x},${y} h${w}`;
  return [
    `M${x},${y + h}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `H${x + w - r}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `V${y + h}`,
    'Z',
  ].join(' ');
}

export function ColumnChart({
  categories,
  series,
  formatY,
  xLabel,
  yLabel,
  height = 260,
}: ColumnChartProps) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const m = DEFAULT_MARGINS;
  const plotLeft = m.left;
  const plotRight = Math.max(width - m.right, plotLeft + 1);
  const plotTop = m.top;
  const plotBottom = height - m.bottom;

  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));

  const y = useMemo(() => {
    const [, hi] = extent(all);
    // Columns encode length from a zero baseline, so the domain must include 0.
    return linearScale([0, hi], [plotBottom, plotTop], 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all.join(','), height, width]);

  if (width === 0) return <div ref={ref} style={{ height }} />;

  const band = bandScale(categories.length, [plotLeft, plotRight]);
  const groupWidth = Math.min(band.width - SURFACE_GAP * 2, MAX_BAR_WIDTH * series.length);
  const barWidth = Math.max((groupWidth - SURFACE_GAP * (series.length - 1)) / series.length, 1);

  // Thin the x labels to whatever fits; the tooltip and table carry the rest.
  const labelStride = Math.max(1, Math.ceil(categories.length / Math.max(1, Math.floor((plotRight - plotLeft) / 40))));
  const xTicks = categories
    .map((c, i) => ({ px: band.center(i), label: c, i }))
    .filter((t) => t.i % labelStride === 0);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (mx < plotLeft || mx > plotRight) {
      setHover(null);
      return;
    }
    // The whole band is the hit target, not just the drawn bar.
    const i = Math.min(categories.length - 1, Math.max(0, Math.floor((mx - plotLeft) / band.width)));
    setHover(i);
  };

  const hoverCenter = hover != null ? band.center(hover) : 0;
  const tooltipRight = hoverCenter > (plotLeft + plotRight) / 2;

  return (
    <div className="chart-wrap" ref={ref}>
      <Legend entries={series.map((s) => ({ label: s.label, colorVar: s.colorVar }))} />
      <div className="chart-plot">
        <svg
          width={width}
          height={height}
          className="chart-hit"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          <ChartFrame
            width={width}
            height={height}
            y={y}
            formatY={formatY}
            xTicks={xTicks}
            xLabel={xLabel}
            yLabel={yLabel}
          >
            {hover != null && (
              <rect
                x={band.start(hover)}
                y={plotTop}
                width={band.width}
                height={plotBottom - plotTop}
                className="chart-hover-band"
              />
            )}
            {categories.map((c, i) => {
              const groupLeft = band.center(i) - groupWidth / 2;
              return (
                <g key={`${c}-${i}`}>
                  {series.map((s, si) => {
                    const v = s.values[i] ?? 0;
                    const top = y.map(v);
                    const h = plotBottom - top;
                    return (
                      <path
                        key={s.label}
                        d={columnPath(groupLeft + si * (barWidth + SURFACE_GAP), top, barWidth, h)}
                        style={{ fill: `var(${s.colorVar})` }}
                        className="chart-column"
                      />
                    );
                  })}
                </g>
              );
            })}
          </ChartFrame>
        </svg>

        {hover != null && (
          <div
            className="tooltip"
            style={{
              left: tooltipRight ? undefined : hoverCenter + 14,
              right: tooltipRight ? width - hoverCenter + 14 : undefined,
              top: plotTop,
            }}
          >
            <div className="tooltip-head">{categories[hover]}</div>
            {series.map((s) => (
              <div key={s.label} className="tooltip-row">
                <span className="legend-swatch" style={{ background: `var(${s.colorVar})` }} aria-hidden="true" />
                <span className="tooltip-label">{s.label}</span>
                <span className="tooltip-value">{formatY(s.values[hover] ?? 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
