/**
 * The circuit, with the playhead on the gate that just ran.
 *
 * One column per step rather than per moment: the transport advances one engine
 * call at a time, so a column and a step are the same thing and the playhead
 * never lands between two gates. Columns are clickable, which makes the diagram
 * a second scrubber.
 *
 * Conditional gates — the corrections at the end of teleportation — are drawn
 * dashed. They are in the diagram because they actually ran, and the run that
 * produced them is the one on screen.
 */
import { useEffect, useRef } from 'react';
import { controlsOf, targets } from '../lib/steps';
import { describe, gateLabel } from '../lib/format';
import type { GateStep, Step } from '../lib/types';
import { useTip } from '../components/Tooltip';
import type { ViewProps } from './types';

const COL = 54;
const GUTTER = 92;
const ROW = 42;
const TOP = 34;
const PAD_RIGHT = 24;

export function CircuitView({ timeline, index, onSeek }: ViewProps) {
  const { steps, nQubits, wireLabels } = timeline;
  const { bind, node } = useTip();
  const scroller = useRef<HTMLDivElement>(null);
  const hasClassical = steps.some((s) => s.kind === 'measure');

  const width = GUTTER + steps.length * COL + PAD_RIGHT;
  const classicalY = TOP + nQubits * ROW + 6;
  const height = classicalY + (hasClassical ? 30 : 0) + 24;

  // Keep the playhead in sight while playing, without yanking the view around
  // when it is already visible.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const x = GUTTER + (index - 0.5) * COL;
    const left = el.scrollLeft;
    const right = left + el.clientWidth;
    if (x < left + COL) el.scrollTo({ left: Math.max(0, x - COL * 2), behavior: 'smooth' });
    else if (x > right - COL) el.scrollTo({ left: x - el.clientWidth + COL * 2, behavior: 'smooth' });
  }, [index]);

  const wireY = (q: number) => TOP + (nQubits - 1 - q) * ROW;
  const colX = (i: number) => GUTTER + i * COL + COL / 2;

  const stages = groupStages(steps);

  return (
    <div className="stage-scroll-x" ref={scroller}>
      <svg width={width} height={height} role="img" aria-label="Quantum circuit">
        {/* Stage bands, so a long circuit reads as phases rather than a wall of gates. */}
        {stages.map((s) => (
          <g key={`${s.label}-${s.from}`}>
            <rect
              x={GUTTER + s.from * COL}
              y={TOP - 24}
              width={(s.to - s.from + 1) * COL}
              height={height - TOP + 10}
              fill={s.ordinal % 2 === 0 ? 'transparent' : 'var(--surface-2)'}
            />
            <text
              x={GUTTER + s.from * COL + 4}
              y={TOP - 26}
              fontSize={10}
              fill="var(--text-muted)"
            >
              {s.label}
            </text>
          </g>
        ))}

        {/* Executed region — the part of the circuit that has actually run. */}
        {index > 0 && (
          <rect
            x={GUTTER}
            y={TOP - 14}
            width={index * COL}
            height={nQubits * ROW}
            fill="var(--blue-100)"
            opacity={0.45}
          />
        )}

        {/* Playhead on the step that just ran. */}
        {index > 0 && (
          <rect
            x={GUTTER + (index - 1) * COL}
            y={TOP - 16}
            width={COL}
            height={nQubits * ROW + 4}
            fill="none"
            stroke="var(--blue)"
            strokeWidth={2}
            rx={4}
          />
        )}

        {/* Wires. */}
        {Array.from({ length: nQubits }, (_, q) => (
          <g key={q}>
            <text x={GUTTER - 12} y={wireY(q) + 4} textAnchor="end" fontSize={12}>
              {wireLabels[q] ?? `q${q}`}
            </text>
            <text
              x={GUTTER - 12}
              y={wireY(q) + 16}
              textAnchor="end"
              fontSize={9}
              fill="var(--text-muted)"
              className="mono"
            >
              q{q}
            </text>
            <line
              x1={GUTTER}
              x2={width - PAD_RIGHT / 2}
              y1={wireY(q)}
              y2={wireY(q)}
              stroke="var(--axis)"
              strokeWidth={1}
            />
          </g>
        ))}

        {/* Classical register: the double line convention. */}
        {hasClassical && (
          <g>
            <text x={GUTTER - 12} y={classicalY + 4} textAnchor="end" fontSize={11}>
              bits
            </text>
            <line
              x1={GUTTER}
              x2={width - PAD_RIGHT / 2}
              y1={classicalY - 2}
              y2={classicalY - 2}
              stroke="var(--axis)"
            />
            <line
              x1={GUTTER}
              x2={width - PAD_RIGHT / 2}
              y1={classicalY + 2}
              y2={classicalY + 2}
              stroke="var(--axis)"
            />
          </g>
        )}

        {steps.map((step, i) => (
          <g
            key={i}
            className="hit"
            onClick={() => onSeek(i + 1)}
            {...bind(`step ${i + 1}\n${describe(step, wireLabels)}`)}
          >
            <rect
              x={GUTTER + i * COL}
              y={TOP - 16}
              width={COL}
              height={height - TOP}
              fill="transparent"
              style={{ cursor: 'pointer' }}
            />
            <StepMark
              step={step}
              x={colX(i)}
              wireY={wireY}
              classicalY={classicalY}
              done={i < index}
            />
          </g>
        ))}
      </svg>
      {node}
    </div>
  );
}

function StepMark({
  step,
  x,
  wireY,
  classicalY,
  done,
}: {
  step: Step;
  x: number;
  wireY: (q: number) => number;
  classicalY: number;
  done: boolean;
}) {
  const ink = done ? 'var(--blue)' : 'var(--axis)';
  const text = done ? 'var(--text-primary)' : 'var(--text-muted)';

  if (step.kind === 'measure') {
    const y = wireY(step.qubit);
    const meter = done ? 'var(--orange)' : 'var(--axis)';
    return (
      <g>
        <line
          x1={x}
          x2={x}
          y1={y + 13}
          y2={classicalY - 4}
          stroke={meter}
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <rect
          x={x - 13}
          y={y - 13}
          width={26}
          height={26}
          rx={4}
          fill="var(--surface-1)"
          stroke={meter}
          strokeWidth={2}
        />
        <path
          d={`M ${x - 7} ${y + 5} A 7 7 0 0 1 ${x + 7} ${y + 5}`}
          fill="none"
          stroke={meter}
          strokeWidth={1.5}
        />
        <line x1={x} y1={y + 5} x2={x + 5} y2={y - 4} stroke={meter} strokeWidth={1.5} />
      </g>
    );
  }

  const controls = controlsOf(step);
  const tgts = targets(step);
  const rows = [...controls, ...tgts].map(wireY);
  const dashed = step.conditional ? '5 3' : undefined;

  return (
    <g>
      {rows.length > 1 && (
        <line
          x1={x}
          x2={x}
          y1={Math.min(...rows)}
          y2={Math.max(...rows)}
          stroke={ink}
          strokeWidth={1.5}
          strokeDasharray={dashed}
        />
      )}
      {controls.map((c) => (
        <circle key={c} cx={x} cy={wireY(c)} r={4.5} fill={ink} />
      ))}
      {step.name === 'swap'
        ? tgts.map((q) => (
            <g key={q} stroke={ink} strokeWidth={2}>
              <line x1={x - 6} y1={wireY(q) - 6} x2={x + 6} y2={wireY(q) + 6} />
              <line x1={x - 6} y1={wireY(q) + 6} x2={x + 6} y2={wireY(q) - 6} />
            </g>
          ))
        : tgts.map((q) =>
            isNotTarget(step) ? (
              // The CNOT convention: a target that is only ever an X gets the
              // exclusive-or ring rather than a box, so the shape carries the
              // meaning at a glance.
              <g key={q}>
                <circle
                  cx={x}
                  cy={wireY(q)}
                  r={10}
                  fill="var(--surface-1)"
                  stroke={ink}
                  strokeWidth={2}
                  strokeDasharray={dashed}
                />
                <line x1={x - 10} x2={x + 10} y1={wireY(q)} y2={wireY(q)} stroke={ink} strokeWidth={2} />
                <line x1={x} x2={x} y1={wireY(q) - 10} y2={wireY(q) + 10} stroke={ink} strokeWidth={2} />
              </g>
            ) : (
              <GateBox
                key={q}
                x={x}
                y={wireY(q)}
                step={step}
                ink={ink}
                textColor={text}
                dashed={dashed}
              />
            ),
          )}
    </g>
  );
}

/** True for the gates drawn as ⊕ instead of a labelled box. */
function isNotTarget(step: GateStep): boolean {
  return (step.name === 'cx' || step.name === 'ccx') && step.controls > 0;
}

function GateBox({
  x,
  y,
  step,
  ink,
  textColor,
  dashed,
}: {
  x: number;
  y: number;
  step: GateStep;
  ink: string;
  textColor: string;
  dashed?: string;
}) {
  const label = gateLabel(step);
  const twoLine = label.includes('(');
  const head = twoLine ? label.slice(0, label.indexOf('(')) : label;
  const angle = twoLine ? label.slice(label.indexOf('(') + 1, -1) : '';
  const w = 34;
  return (
    <g>
      <rect
        x={x - w / 2}
        y={y - 14}
        width={w}
        height={28}
        rx={5}
        fill="var(--surface-1)"
        stroke={ink}
        strokeWidth={2}
        strokeDasharray={dashed}
      />
      <text
        x={x}
        y={twoLine ? y - 1 : y + 4}
        textAnchor="middle"
        fontSize={12}
        fontWeight={600}
        fill={textColor}
        className="mono"
      >
        {head}
      </text>
      {twoLine && (
        <text x={x} y={y + 10} textAnchor="middle" fontSize={8} fill="var(--text-muted)">
          {angle}
        </text>
      )}
    </g>
  );
}

/** Runs of consecutive steps that share a `stage`, for the banding. */
function groupStages(steps: Step[]) {
  const out: { label: string; from: number; to: number; ordinal: number }[] = [];
  steps.forEach((step, i) => {
    const label = step.stage;
    if (!label) return;
    const last = out[out.length - 1];
    if (last && last.label === label && last.to === i - 1) last.to = i;
    else out.push({ label, from: i, to: i, ordinal: out.length });
  });
  return out;
}
