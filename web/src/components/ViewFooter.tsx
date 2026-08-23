/**
 * The bottom of every view: a legend, then one line of facts.
 *
 * Each view used to hand-roll its own swatch markup and scatter one to three
 * paragraphs underneath, so the bottom of the screen changed shape every time
 * you switched tabs. Same structure everywhere now, and the marks come from one
 * table so a blue line means the same thing drawn the same way in all of them.
 *
 * The caption is for *facts* — counts, what has been truncated, why a layer is
 * missing. Explanation belongs behind the view's ⓘ, not here.
 */
import type { ReactNode } from 'react';

export type LegendMark =
  | { kind: 'fill'; colour: string; empty?: boolean }
  | { kind: 'ring'; colour: string; dashed?: boolean }
  | { kind: 'line'; colour: string; dashed?: boolean }
  | { kind: 'dot'; colour: string };

export interface LegendItem {
  mark: LegendMark;
  label: string;
}

function Mark({ mark }: { mark: LegendMark }): ReactNode {
  switch (mark.kind) {
    case 'fill':
      return (
        <span
          className="swatch"
          style={{
            background: mark.empty ? 'var(--surface-2)' : mark.colour,
            border: mark.empty ? `1px solid ${mark.colour}` : undefined,
          }}
        />
      );
    case 'ring':
      return (
        <svg width={12} height={12} aria-hidden>
          <circle
            cx={6}
            cy={6}
            r={4.5}
            fill="none"
            stroke={mark.colour}
            strokeWidth={2}
            strokeDasharray={mark.dashed ? '3 2' : undefined}
          />
        </svg>
      );
    case 'line':
      return (
        <svg width={22} height={10} aria-hidden>
          <line
            x1={1}
            y1={5}
            x2={21}
            y2={5}
            stroke={mark.colour}
            strokeWidth={mark.dashed ? 1.5 : 3}
            strokeDasharray={mark.dashed ? '3 3' : undefined}
            strokeLinecap="round"
          />
        </svg>
      );
    case 'dot':
      return (
        <span className="swatch" style={{ background: mark.colour, borderRadius: 999 }} />
      );
  }
}

export function ViewFooter({
  legend,
  caption,
}: {
  legend?: LegendItem[];
  caption?: ReactNode;
}) {
  return (
    <div className="view-footer">
      {legend && legend.length > 0 && (
        <div className="legend">
          {legend.map((item) => (
            <span className="legend-item" key={item.label}>
              <Mark mark={item.mark} />
              {item.label}
            </span>
          ))}
        </div>
      )}
      {caption && <p className="note">{caption}</p>}
    </div>
  );
}
