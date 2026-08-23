/**
 * Bloch spheres — one per qubit, seen from one side.
 *
 * The arrow is the qubit's own state: north is |0⟩, south is |1⟩, and the
 * equator is every equal superposition, differing only in phase. The length of
 * the arrow is the part a state vector cannot show you: a qubit entangled with
 * the rest of the register has *no* state of its own, and its arrow shrinks to
 * nothing at the centre while the register as a whole stays perfectly pure.
 *
 * The wireframe is sampled as polylines through one orthographic projection
 * rather than assembled from ellipses, so latitude, longitude and the state
 * arrow are all guaranteed to agree with each other.
 */
import { fixed, pct } from '../lib/format';
import { controlsOf, targets } from '../lib/steps';
import { useMeasure } from '../lib/useMeasure';
import { useTip } from '../components/Tooltip';
import type { QubitStat } from '../lib/analysis';
import type { ViewProps } from './types';

/** Camera: a touch to the side and a touch above, so all three axes are visible. */
const AZIMUTH = (28 * Math.PI) / 180;
const ELEVATION = (16 * Math.PI) / 180;
const TILE = 168;
const TILE_H = 166;
const R = 54;
/** Sphere centre inside the tile, leaving room for the pole labels and caption. */
const CY = 76;

/** Orthographic projection of a unit-sphere point onto the tile. */
function project(x: number, y: number, z: number): [number, number] {
  const ex = x * Math.cos(AZIMUTH) - y * Math.sin(AZIMUTH);
  const depth = x * Math.sin(AZIMUTH) + y * Math.cos(AZIMUTH);
  const ey = z * Math.cos(ELEVATION) - depth * Math.sin(ELEVATION);
  return [R * ex, -R * ey];
}

function polyline(points: [number, number, number][]): string {
  return points
    .map((p, i) => {
      const [sx, sy] = project(...p);
      return `${i === 0 ? 'M' : 'L'}${sx.toFixed(2)},${sy.toFixed(2)}`;
    })
    .join(' ');
}

const STEPS = 64;

function latitude(z: number): [number, number, number][] {
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = (2 * Math.PI * i) / STEPS;
    return [r * Math.cos(t), r * Math.sin(t), z] as [number, number, number];
  });
}

function meridian(lon: number): [number, number, number][] {
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = (2 * Math.PI * i) / STEPS;
    return [Math.cos(lon) * Math.sin(t), Math.sin(lon) * Math.sin(t), Math.cos(t)] as [
      number,
      number,
      number,
    ];
  });
}

const WIRE = [
  ...[-0.5, 0, 0.5].map(latitude),
  ...[0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4].map(meridian),
];

export function PolarisationView({ timeline, index, analysis }: ViewProps) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const { bind, node } = useTip();
  const { wireLabels } = timeline;

  const perRow = Math.max(1, Math.floor((width || TILE * 3) / TILE));
  const step = index > 0 ? timeline.steps[index - 1] : null;
  const touched = new Set<number>();
  if (step) {
    if (step.kind === 'measure') touched.add(step.qubit);
    else {
      for (const q of targets(step)) touched.add(q);
      for (const q of controlsOf(step)) touched.add(q);
    }
  }

  return (
    <div ref={ref}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${perRow}, minmax(0, ${TILE}px))`,
          justifyContent: 'start',
          gap: 4,
        }}
      >
        {analysis.qubits.map((st, q) => (
          <Sphere
            key={q}
            stat={st}
            label={wireLabels[q] ?? `q${q}`}
            qubit={q}
            highlight={touched.has(q)}
            bind={bind}
          />
        ))}
      </div>

      <div className="legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: 'var(--blue)', borderRadius: 999 }} />
          state direction — length is how much of a state the qubit has of its own
        </span>
        <span className="legend-item">
          <svg width={22} height={10} aria-hidden>
            <line
              x1={1}
              y1={5}
              x2={21}
              y2={5}
              stroke="var(--axis)"
              strokeWidth={1.5}
              strokeDasharray="3 3"
            />
          </svg>
          drop to the equatorial plane, for depth
        </span>
        <span className="legend-item">
          <span className="swatch swatch-ring" style={{ borderColor: 'var(--orange)' }} />
          touched by this step
        </span>
      </div>
      {node}
    </div>
  );
}

function Sphere({
  stat,
  label,
  qubit,
  highlight,
  bind,
}: {
  stat: QubitStat;
  label: string;
  qubit: number;
  highlight: boolean;
  bind: (text: string) => object;
}) {
  const [tipX, tipY] = project(stat.x, stat.y, stat.z);
  const [dropX, dropY] = project(stat.x, stat.y, 0);
  const [northX, northY] = project(0, 0, 1);
  const [southX, southY] = project(0, 0, -1);
  const [xAxisX, xAxisY] = project(1.16, 0, 0);
  const [yAxisX, yAxisY] = project(0, 1.16, 0);
  const cx = TILE / 2;
  const cy = CY;

  return (
    <div
      {...bind(
        `${label}  (qubit ${qubit})\n` +
          `P(1)   ${pct(stat.p1, 2)}\n` +
          `⟨X⟩ ${fixed(stat.x)}  ⟨Y⟩ ${fixed(stat.y)}  ⟨Z⟩ ${fixed(stat.z)}\n` +
          `radius ${fixed(stat.r)}   purity ${fixed(stat.purity)}`,
      )}
    >
      <svg width={TILE} height={TILE_H} role="img" aria-label={`Bloch sphere for ${label}`}>
        <g transform={`translate(${cx}, ${cy})`}>
          {highlight && <circle r={R + 9} fill="none" stroke="var(--orange)" strokeWidth={2} />}
          <circle r={R} fill="var(--surface-1)" stroke="var(--axis)" strokeWidth={1} />
          {WIRE.map((curve, i) => (
            <path key={i} d={polyline(curve)} fill="none" stroke="var(--grid)" strokeWidth={1} />
          ))}

          {/* Axis stubs. Only |0⟩ and |1⟩ are named — the other two are just
              directions, and labelling all six turns the tile into a diagram of
              itself. */}
          <line x1={0} y1={0} x2={xAxisX} y2={xAxisY} stroke="var(--grid)" strokeWidth={1} />
          <line x1={0} y1={0} x2={yAxisX} y2={yAxisY} stroke="var(--grid)" strokeWidth={1} />
          <text x={northX} y={northY - 6} textAnchor="middle" fontSize={9} fill="var(--text-muted)">
            |0⟩
          </text>
          <text x={southX} y={southY + 13} textAnchor="middle" fontSize={9} fill="var(--text-muted)">
            |1⟩
          </text>

          {stat.r > 0.004 && (
            <>
              <line
                x1={tipX}
                y1={tipY}
                x2={dropX}
                y2={dropY}
                stroke="var(--axis)"
                strokeWidth={1.5}
                strokeDasharray="3 3"
              />
              <line
                x1={0}
                y1={0}
                x2={tipX}
                y2={tipY}
                stroke="var(--blue)"
                strokeWidth={2}
                strokeLinecap="round"
              />
            </>
          )}
          <circle
            cx={tipX}
            cy={tipY}
            r={4.5}
            fill="var(--blue)"
            stroke="var(--surface-1)"
            strokeWidth={2}
          />
        </g>

        <text x={cx} y={TILE_H - 6} textAnchor="middle" fontSize={11} fill="var(--text-secondary)">
          {label} · P(1) {pct(stat.p1, 0)}
          {stat.r < 0.999 ? ` · r ${fixed(stat.r, 2)}` : ''}
        </text>
      </svg>
    </div>
  );
}
