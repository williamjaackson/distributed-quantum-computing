import { useMemo, useState } from 'react';
import { ChartFrame, DEFAULT_MARGINS, Legend, type ReferenceLine } from './ChartFrame';
import { extent, linearScale, logScale } from './scale';
import { useMeasure } from './useMeasure';

export interface LineSeries {
  label: string;
  /** `null` marks a gap — a point that was not measured. */
  values: (number | null)[];
  colorVar: string;
}

interface LineChartProps {
  x: number[];
  series: LineSeries[];
  yScaleType?: 'linear' | 'log';
  yTicks?: number[];
  formatY: (v: number) => string;
  formatX?: (v: number) => string;
  xLabel: string;
  yLabel: string;
  referenceLines?: ReferenceLine[];
  height?: number;
  /** Direct-label each series at its final point. */
  endLabels?: boolean;
}

export function LineChart({
  x,
  series,
  yScaleType = 'linear',
  yTicks,
  formatY,
  formatX = (v) => String(v),
  xLabel,
  yLabel,
  referenceLines = [],
  height = 260,
  endLabels = false,
}: LineChartProps) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const m = DEFAULT_MARGINS;
  const plotLeft = m.left;
  const plotRight = Math.max(width - m.right, plotLeft + 1);
  const plotTop = m.top;
  const plotBottom = height - m.bottom;

  const finite = series.flatMap((s) => s.values.filter((v): v is number => v != null && Number.isFinite(v)));
  const refValues = referenceLines.map((r) => r.value);

  const scales = useMemo(() => {
    const [lo, hi] = extent([...finite, ...refValues]);
    const yr: [number, number] = [plotBottom, plotTop];
    const yy =
      yScaleType === 'log'
        ? logScale([lo, hi], yr, yTicks)
        : linearScale([Math.min(lo, 0) === lo ? lo : 0, hi], yr, 5, yTicks);
    const [xlo, xhi] = extent(x);
    const xx = linearScale([xlo, xhi], [plotLeft, plotRight], Math.min(x.length, 8));
    return { yy, xx };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finite.join(','), refValues.join(','), x.join(','), width, height, yScaleType, yTicks?.join(',')]);

  if (width === 0) return <div ref={ref} style={{ height }} />;

  const px = (v: number) => scales.xx.map(v);
  const py = (v: number) => scales.yy.map(v);

  // One tick per x value where they fit, thinned otherwise.
  const stride = Math.max(1, Math.ceil(x.length / Math.max(1, Math.floor((plotRight - plotLeft) / 44))));
  const xTicks = x
    .map((v, i) => ({ px: px(v), label: formatX(v), i }))
    .filter((t) => t.i % stride === 0);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (mx < plotLeft - 8 || mx > plotRight + 8) {
      setHover(null);
      return;
    }
    // Nearest x index, so the hit target is the whole vertical band rather than
    // the mark itself.
    let best = 0;
    let bestD = Infinity;
    x.forEach((v, i) => {
      const d = Math.abs(px(v) - mx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  };

  const hoverX = hover != null ? px(x[hover]) : 0;
  const tooltipRight = hoverX > (plotLeft + plotRight) / 2;

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
            y={scales.yy}
            formatY={formatY}
            xTicks={xTicks}
            xLabel={xLabel}
            yLabel={yLabel}
            referenceLines={referenceLines}
          >
            {hover != null && (
              <line x1={hoverX} x2={hoverX} y1={plotTop} y2={plotBottom} className="chart-crosshair" />
            )}

            {series.map((s) => {
              // Break the path at gaps so a missing measurement is not
              // interpolated over.
              const segments: string[] = [];
              let current: string[] = [];
              s.values.forEach((v, i) => {
                if (v == null || !Number.isFinite(v)) {
                  if (current.length) segments.push(current.join(' '));
                  current = [];
                  return;
                }
                current.push(`${current.length ? 'L' : 'M'}${px(x[i])},${py(v)}`);
              });
              if (current.length) segments.push(current.join(' '));

              const lastIdx = s.values.reduce<number>(
                (acc, v, i) => (v != null && Number.isFinite(v) ? i : acc),
                -1,
              );

              return (
                <g key={s.label}>
                  {segments.map((d, i) => (
                    <path key={i} d={d} className="chart-line" style={{ stroke: `var(${s.colorVar})` }} />
                  ))}
                  {lastIdx >= 0 && (
                    <circle
                      cx={px(x[lastIdx])}
                      cy={py(s.values[lastIdx] as number)}
                      r={4}
                      className="chart-marker"
                      style={{ fill: `var(${s.colorVar})` }}
                    />
                  )}
                  {endLabels && lastIdx >= 0 && (
                    <text
                      x={px(x[lastIdx]) - 10}
                      y={py(s.values[lastIdx] as number) - 10}
                      className="chart-point-label"
                      textAnchor="end"
                    >
                      {formatY(s.values[lastIdx] as number)}
                    </text>
                  )}
                </g>
              );
            })}

            {hover != null &&
              series.map((s) => {
                const v = s.values[hover];
                if (v == null || !Number.isFinite(v)) return null;
                return (
                  <circle
                    key={`h-${s.label}`}
                    cx={hoverX}
                    cy={py(v)}
                    r={4}
                    className="chart-marker"
                    style={{ fill: `var(${s.colorVar})` }}
                  />
                );
              })}
          </ChartFrame>
        </svg>

        {hover != null && (
          <div
            className="tooltip"
            style={{
              left: tooltipRight ? undefined : hoverX + 14,
              right: tooltipRight ? width - hoverX + 14 : undefined,
              top: plotTop,
            }}
          >
            <div className="tooltip-head">
              {xLabel}: {formatX(x[hover])}
            </div>
            {series.map((s) => {
              const v = s.values[hover];
              return (
                <div key={s.label} className="tooltip-row">
                  <span className="legend-swatch" style={{ background: `var(${s.colorVar})` }} aria-hidden="true" />
                  <span className="tooltip-label">{s.label}</span>
                  <span className="tooltip-value">
                    {v == null || !Number.isFinite(v) ? 'not measured' : formatY(v)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
