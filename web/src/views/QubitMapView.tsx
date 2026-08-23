/**
 * The register as a ring of qubits, with the correlations between them drawn as
 * chords.
 *
 * Each qubit is a dial that fills from the bottom with P(1) — grey is a
 * definite 0, full blue is a definite 1, and anything in between is exactly how
 * undecided it is. That single mark covers the case a circuit diagram cannot
 * show at all: an entangled qubit sitting at half, going nowhere, while the
 * chord to its partner carries everything.
 *
 * Chord weight is the connected Pauli correlation the engine's `reduced_two`
 * feeds — 1 for a Bell pair, ~0.58 for a pair that has been measured and is now
 * only classically correlated, 0 for independent qubits. Every pair costs a pass
 * over the state, so on a register too large to afford that the dials stand
 * alone and the note says so rather than the map implying independence.
 */
import { fixed, pct } from '../lib/format';
import { controlsOf, targets } from '../lib/steps';
import { useMeasure } from '../lib/useMeasure';
import { useTip } from '../components/Tooltip';
import { ViewFooter } from '../components/ViewFooter';
import type { ViewProps } from './types';

const R_QUBIT = 26;
/** Below this a chord is rounding noise, not a correlation. */
const LINK_FLOOR = 0.015;
/**
 * Chords drawn at most, strongest first.
 *
 * A fully correlated register has `n(n-1)/2` links — 120 at sixteen qubits —
 * and drawing them all produces a solid disc that says less than a handful of
 * them plus a count. The cap is announced in the note; it is never silent.
 */
const MAX_CHORDS = 48;

export function QubitMapView({ timeline, index, analysis }: ViewProps) {
  const { ref, width, height } = useMeasure<HTMLDivElement>();
  const { bind, node } = useTip();
  const { nQubits, wireLabels } = timeline;

  const links = analysis.links;

  // The wrapper is pinned to the stage's height, so measuring it gives the real
  // room available rather than the height its own contents just produced.
  // Quantised to 8px: a size that tracks the container pixel for pixel can
  // feed back into the container's own scroll state and never settle.
  const size = quantise(clamp(Math.min(width || 520, (height || 520) - 120), 220, 640));
  const cx = size / 2;
  const cy = size / 2;
  // Cap the ring for a small register: two qubits at opposite ends of a wide
  // circle read as unrelated, which is the opposite of what the chord says.
  const ring = Math.min(Math.max(52, size / 2 - R_QUBIT - 34), 42 * nQubits);

  const pos = Array.from({ length: nQubits }, (_, q) => {
    // Start at the top and go clockwise, so qubit 0 is where the eye lands.
    const angle = -Math.PI / 2 + (2 * Math.PI * q) / nQubits;
    return { x: cx + ring * Math.cos(angle), y: cy + ring * Math.sin(angle), angle };
  });

  const active = new Set<number>();
  const activeControls = new Set<number>();
  const step = index > 0 ? timeline.steps[index - 1] : null;
  if (step) {
    if (step.kind === 'measure') active.add(step.qubit);
    else {
      for (const q of targets(step)) active.add(q);
      for (const q of controlsOf(step)) activeControls.add(q);
    }
  }

  const chords: { a: number; b: number; c: number }[] = [];
  if (links) {
    for (let a = 0; a < nQubits; a++) {
      for (let b = a + 1; b < nQubits; b++) {
        const c = links[a * nQubits + b];
        if (c > LINK_FLOOR) chords.push({ a, b, c });
      }
    }
  }
  // Strongest last, and ties scattered rather than left in index order: a
  // register where every pair is *equally* correlated (a GHZ state is exactly
  // that) would otherwise have the cap keep one lexicographic corner of the
  // ring, which looks like structure that is not there.
  chords.sort((p, q) => p.c - q.c || scatter(p.a, p.b) - scatter(q.a, q.b));
  const total = chords.length;
  const drawn = chords.slice(-MAX_CHORDS);
  // Thin the ink as the graph fills in, or a dense map is one opaque blob.
  const damp = Math.max(0.3, Math.min(1, 18 / Math.max(1, drawn.length)));

  return (
    <div
      ref={ref}
      style={{ height: '100%', minHeight: 320, display: 'grid', justifyItems: 'center', alignContent: 'center' }}
    >
      <svg width={size} height={size} role="img" aria-label="Qubit map">
        {/* Chords first, so a qubit dial is never crossed by a line. */}
        {drawn.map(({ a, b, c }) => {
          const p = pos[a];
          const q = pos[b];
          // Pull the control point toward the centre by how strong the link is:
          // a weak correlation bows out near the rim, a Bell pair cuts across.
          const bend = 1 - 0.85 * c;
          return (
            <path
              key={`${a}-${b}`}
              d={`M${p.x},${p.y} Q${cx + (p.x + q.x - 2 * cx) * bend * 0.5},${
                cy + (p.y + q.y - 2 * cy) * bend * 0.5
              } ${q.x},${q.y}`}
              fill="none"
              stroke="var(--blue)"
              strokeWidth={(1 + 5 * c) * damp}
              strokeOpacity={(0.18 + 0.62 * c) * damp}
              strokeLinecap="round"
              {...bind(
                `${label(wireLabels, a)} ↔ ${label(wireLabels, b)}\n` +
                  `correlation ${fixed(c, 3)}\n` +
                  (c > 0.9
                    ? 'maximally correlated — a Bell-type pair'
                    : c > 0.5
                      ? 'strongly correlated'
                      : 'weakly correlated'),
              )}
            />
          );
        })}

        {pos.map((p, q) => {
          const st = analysis.qubits[q];
          const fillH = 2 * R_QUBIT * st.p1;
          const clipId = `fill-${q}`;
          const definite = st.p1 < 1e-9 || st.p1 > 1 - 1e-9;
          return (
            <g key={q}>
              <defs>
                <clipPath id={clipId}>
                  <rect
                    x={p.x - R_QUBIT}
                    y={p.y + R_QUBIT - fillH}
                    width={2 * R_QUBIT}
                    height={Math.max(0, fillH)}
                  />
                </clipPath>
              </defs>

              {/* The qubit this step is acting on gets a ring outside the dial. */}
              {(active.has(q) || activeControls.has(q)) && (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={R_QUBIT + 6}
                  fill="none"
                  stroke="var(--orange)"
                  strokeWidth={2}
                  strokeDasharray={activeControls.has(q) ? '4 3' : undefined}
                />
              )}

              <circle cx={p.x} cy={p.y} r={R_QUBIT} fill="var(--surface-2)" />
              <circle
                cx={p.x}
                cy={p.y}
                r={R_QUBIT}
                fill="var(--blue)"
                clipPath={`url(#${clipId})`}
              />
              <circle
                cx={p.x}
                cy={p.y}
                r={R_QUBIT}
                fill="none"
                stroke={definite && st.p1 > 0.5 ? 'var(--blue)' : 'var(--axis)'}
                strokeWidth={2}
              />

              <text
                x={p.x}
                y={p.y + 4}
                textAnchor="middle"
                fontSize={12}
                fontWeight={600}
                fill={st.p1 > 0.55 ? '#fff' : 'var(--text-primary)'}
                className="mono"
              >
                {definite ? (st.p1 > 0.5 ? '1' : '0') : pct(st.p1, 0)}
              </text>

              <text
                x={p.x}
                y={p.y + R_QUBIT + 15}
                textAnchor="middle"
                fontSize={11}
                fill="var(--text-secondary)"
              >
                {label(wireLabels, q)}
              </text>

              <circle
                cx={p.x}
                cy={p.y}
                r={R_QUBIT + 6}
                fill="transparent"
                {...bind(
                  `${label(wireLabels, q)}  (qubit ${q})\n` +
                    `P(1)     ${pct(st.p1, 2)}\n` +
                    `⟨X⟩ ${fixed(st.x)}  ⟨Y⟩ ${fixed(st.y)}  ⟨Z⟩ ${fixed(st.z)}\n` +
                    `radius   ${fixed(st.r)} — ${
                      st.r > 0.999
                        ? 'a state of its own'
                        : st.r < 0.001
                          ? 'no state of its own; fully entangled'
                          : 'partly entangled'
                    }`,
                )}
              />
            </g>
          );
        })}
      </svg>

      <ViewFooter
        legend={[
          { mark: { kind: 'fill', colour: 'var(--axis)', empty: true }, label: '|0⟩' },
          { mark: { kind: 'fill', colour: 'var(--blue)' }, label: '|1⟩ — partial fill is P(1)' },
          { mark: { kind: 'line', colour: 'var(--blue)' }, label: 'correlated — thicker is stronger' },
          { mark: { kind: 'ring', colour: 'var(--orange)' }, label: 'touched by this step' },
        ]}
        caption={
          links === null
            ? timeline.detail.linksReason === 'sharded'
              ? 'Links off while sharded. The dials are exact.'
              : `Links off — too costly at ${nQubits} qubits. The dials are exact.`
            : chords.length === 0
              ? 'No correlations — every qubit is independent of the others.'
              : `${total} correlated pair${total === 1 ? '' : 's'}, strongest ${fixed(
                  chords[total - 1].c,
                  3,
                )} of 1${total > drawn.length ? `, drawing the ${drawn.length} strongest` : ''}.`
        }
      />
      {node}
    </div>
  );
}

function label(labels: string[], q: number): string {
  return labels[q] ?? `q${q}`;
}

/** Deterministic scatter in [0, 1) for tie-breaking, stable across frames. */
function scatter(a: number, b: number): number {
  const h = Math.imul(a * 73856093 + b * 19349663, 0x27d4eb2d) >>> 0;
  return h / 4294967296;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function quantise(v: number): number {
  return Math.floor(v / 8) * 8;
}
