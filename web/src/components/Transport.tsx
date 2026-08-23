/**
 * Playback controls, and the one line that says what the engine just did.
 *
 * The step description and the literal `applyGate(...)` call sit directly above
 * the buttons rather than off in a log: the whole point of stepping is to tie a
 * change on screen to the one call that caused it.
 *
 * Playing stops at the end of the circuit, where most of these programs leave
 * the interesting thing in a superposition. The primary button then offers to
 * *measure*, because looking is a separate act from computing and a destructive
 * one — so it is asked for rather than assumed.
 */
import { BASE_INTERVAL_MS, SPEEDS } from '../lib/usePlayer';
import { describe, engineCall } from '../lib/format';
import type { Step } from '../lib/types';

interface TransportProps {
  index: number;
  last: number;
  playing: boolean;
  speed: number;
  atStart: boolean;
  atEnd: boolean;
  step: Step | null;
  wires: string[];
  onSeek: (i: number) => void;
  onStep: (delta: number) => void;
  onToggle: () => void;
  onStart: () => void;
  onEnd: () => void;
  onSpeed: (s: number) => void;
  /** Offered when the circuit has finished and nothing has read it out yet. */
  onMeasure?: () => void;
  /** Offered alongside it when the program can say which shot was best. */
  onBestShot?: () => void;
  /** A draw has already been taken, so the offer is another one. */
  measured?: boolean;
}

export function Transport(props: TransportProps) {
  const { index, last, playing, speed, atStart, atEnd, step, wires } = props;

  return (
    <div className="transport">
      <div className="now">
        <span className="now-step">
          step {index} / {last}
        </span>
        {step?.stage && <span className="now-stage">{step.stage}</span>}
        <span className="now-note">
          {step ? describe(step, wires) : 'Register initialised to |0…0⟩'}
        </span>
        {step?.conditional && <span className="now-cond">because {step.conditional}</span>}
        <code className="now-call">{step ? engineCall(step) : 'new Simulator(n)'}</code>
      </div>

      <div className="controls">
        <button className="btn" onClick={props.onStart} disabled={atStart} title="Start (Home)">
          <Icon shape="start" />
        </button>
        <button className="btn" onClick={() => props.onStep(-1)} disabled={atStart} title="Back (←)">
          <Icon shape="prev" />
        </button>
        {props.onMeasure && atEnd && !playing ? (
          <>
            <button
              className="btn btn-measure"
              onClick={props.onMeasure}
              title={
                props.measured
                  ? 'Measure again — a different run, and a different draw'
                  : 'Measure the register (space) — one draw, and it collapses'
              }
            >
              <Icon shape="measure" />
              {props.measured ? 'Measure again' : 'Measure'}
            </button>
            {props.onBestShot && (
              <button
                className="btn"
                onClick={props.onBestShot}
                title="Collapse onto the best-scoring outcome among the shots you took"
              >
                Best shot
              </button>
            )}
          </>
        ) : (
          <button
            className="btn btn-primary"
            onClick={props.onToggle}
            disabled={last === 0}
            title="Play / pause (space)"
          >
            <Icon shape={playing ? 'pause' : 'play'} />
          </button>
        )}
        <button className="btn" onClick={() => props.onStep(1)} disabled={atEnd} title="Forward (→)">
          <Icon shape="next" />
        </button>
        <button className="btn" onClick={props.onEnd} disabled={atEnd} title="End (End)">
          <Icon shape="end" />
        </button>

        <input
          className="scrub"
          type="range"
          min={0}
          max={Math.max(1, last)}
          step={1}
          value={index}
          disabled={last === 0}
          aria-label="Timeline position"
          onChange={(e) => props.onSeek(Number(e.target.value))}
        />

        <select
          className="compact"
          value={speed}
          aria-label="Playback speed"
          title="Milliseconds per step"
          onChange={(e) => props.onSpeed(Number(e.target.value))}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}× · {Math.round(BASE_INTERVAL_MS / s)} ms
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

type Shape = 'start' | 'prev' | 'play' | 'pause' | 'next' | 'end' | 'measure';

function Icon({ shape }: { shape: Shape }) {
  const common = { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'currentColor' } as const;
  switch (shape) {
    case 'start':
      return (
        <svg {...common} aria-hidden>
          <path d="M2 2h1.6v10H2zM12 2v10L4.8 7z" />
        </svg>
      );
    case 'prev':
      return (
        <svg {...common} aria-hidden>
          <path d="M11 2v10L4 7z" />
        </svg>
      );
    case 'play':
      return (
        <svg {...common} aria-hidden>
          <path d="M3.5 1.8 12 7l-8.5 5.2z" />
        </svg>
      );
    case 'pause':
      return (
        <svg {...common} aria-hidden>
          <path d="M3.4 2h2.6v10H3.4zM8 2h2.6v10H8z" />
        </svg>
      );
    case 'next':
      return (
        <svg {...common} aria-hidden>
          <path d="M3 2v10l7-5z" />
        </svg>
      );
    case 'end':
      return (
        <svg {...common} aria-hidden>
          <path d="M10.4 2H12v10h-1.6zM2 2v10l7.2-5z" />
        </svg>
      );
    case 'measure':
      // The meter glyph the circuit diagram uses for a measurement, so the
      // button and the step it adds look like the same thing.
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
          <path d="M2.2 10.5a4.8 4.8 0 0 1 9.6 0" />
          <path d="M7 10.5 10.2 4.8" />
        </svg>
      );
  }
}
