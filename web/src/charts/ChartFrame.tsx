import type { ReactNode } from 'react';
import type { Scale } from './scale';

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// The left gutter has to clear the widest tick label plus the rotated axis
// title; unit-suffixed values like "100.0 ms" need more room than bare numbers.
export const DEFAULT_MARGINS: Margins = { top: 16, right: 28, bottom: 40, left: 84 };

export interface ReferenceLine {
  value: number;
  label: string;
}

interface ChartFrameProps {
  width: number;
  height: number;
  margins?: Margins;
  y: Scale;
  formatY: (v: number) => string;
  /** X-axis tick marks, already positioned in pixels. */
  xTicks: { px: number; label: string }[];
  xLabel: string;
  yLabel: string;
  /**
   * Threshold markers. Dashed on purpose — a dash reads as "limit", which is
   * exactly what these are; gridlines and axes stay solid hairlines.
   */
  referenceLines?: ReferenceLine[];
  children: ReactNode;
}

export function ChartFrame({
  width,
  height,
  margins = DEFAULT_MARGINS,
  y,
  formatY,
  xTicks,
  xLabel,
  yLabel,
  referenceLines = [],
  children,
}: ChartFrameProps) {
  const plotLeft = margins.left;
  const plotRight = width - margins.right;
  const plotBottom = height - margins.bottom;

  return (
    <svg width={width} height={height} role="presentation" className="chart-svg">
      {/* Horizontal gridlines: solid hairlines, one step off the surface. */}
      {y.ticks.map((t) => {
        const py = y.map(t);
        return (
          <g key={`grid-${t}`}>
            <line
              x1={plotLeft}
              x2={plotRight}
              y1={py}
              y2={py}
              className="chart-grid"
              shapeRendering="crispEdges"
            />
            <text x={plotLeft - 10} y={py} className="chart-tick" textAnchor="end" dominantBaseline="middle">
              {formatY(t)}
            </text>
          </g>
        );
      })}

      {referenceLines.map((r) => {
        const py = y.map(r.value);
        if (py < margins.top || py > plotBottom) return null;
        return (
          <g key={`ref-${r.label}`}>
            <line x1={plotLeft} x2={plotRight} y1={py} y2={py} className="chart-reference" />
            <text x={plotRight} y={py - 6} className="chart-reference-label" textAnchor="end">
              {r.label}
            </text>
          </g>
        );
      })}

      {/* Baseline. */}
      <line
        x1={plotLeft}
        x2={plotRight}
        y1={plotBottom}
        y2={plotBottom}
        className="chart-axis"
        shapeRendering="crispEdges"
      />

      {xTicks.map((t, i) => (
        <text
          key={`xt-${i}-${t.label}`}
          x={t.px}
          y={plotBottom + 18}
          className="chart-tick"
          textAnchor="middle"
        >
          {t.label}
        </text>
      ))}

      <text x={(plotLeft + plotRight) / 2} y={height - 4} className="chart-axis-label" textAnchor="middle">
        {xLabel}
      </text>
      <text
        transform={`translate(14, ${(margins.top + plotBottom) / 2}) rotate(-90)`}
        className="chart-axis-label"
        textAnchor="middle"
      >
        {yLabel}
      </text>

      {children}
    </svg>
  );
}

export interface LegendEntry {
  label: string;
  colorVar: string;
}

/**
 * Identity channel for multi-series charts. Always rendered at two or more
 * series; omitted for one, where the chart title already names what is plotted.
 * The swatch carries the color — the text stays in ink tokens.
 */
export function Legend({ entries }: { entries: LegendEntry[] }) {
  if (entries.length < 2) return null;
  return (
    <div className="legend">
      {entries.map((e) => (
        <span key={e.label} className="legend-item">
          <span className="legend-swatch" style={{ background: `var(${e.colorVar})` }} aria-hidden="true" />
          {e.label}
        </span>
      ))}
    </div>
  );
}
