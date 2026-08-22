/**
 * The visualiser shell: pick a program, feed it inputs, step through it, and
 * look at the register from whichever angle answers the question.
 *
 * One source of truth for the whole app: `runProgram` produces a timeline of
 * recorded summaries, and everything on screen is a function of that timeline
 * plus a playhead. Changing an input re-runs the program from scratch, which is
 * microseconds at small sizes and seconds at large ones — hence the progress
 * line rather than a frozen tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analyse, readRegister } from './lib/analysis';
import type { Execution } from './lib/backend';
import { engineLimitsIfReady, loadWasm } from './lib/backend';
import { ceiling, runProgram } from './lib/runner';
import { defaultValues } from './lib/inputs';
import type { InputValue, InputValues, Readout, ReadoutContext, Timeline } from './lib/types';
import { usePlayer } from './lib/usePlayer';
import { PROGRAMS, programById } from './programs';
import { VIEWS, viewById } from './views';
import { InputsPanel } from './components/InputsPanel';
import { OutputsPanel } from './components/OutputsPanel';
import { Transport } from './components/Transport';
import { ExecutionPanel } from './components/ExecutionPanel';

export function App() {
  const [ready, setReady] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [programId, setProgramId] = useState(PROGRAMS[0].id);
  const [valuesById, setValuesById] = useState<Record<string, InputValues>>({});
  const [viewId, setViewId] = useState('qubits');
  const [seed, setSeed] = useState(0x5eed);
  const [execution, setExecution] = useState<Execution>('auto');
  const [unlocked, setUnlocked] = useState(false);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    loadWasm()
      .then(() => setReady(true))
      .catch((e: unknown) => setEngineError(e instanceof Error ? e.message : String(e)));
  }, []);

  const program = programById(programId);
  // Memoised for its *identity*, not its cost: a program with no stored values
  // yet would otherwise get a fresh defaults object on every render, and since
  // the run effect depends on it, that is an infinite loop rather than a wasted
  // allocation.
  const values = useMemo(
    () => valuesById[programId] ?? defaultValues(program.inputs),
    [valuesById, programId, program],
  );

  const setValue = useCallback(
    (id: string, value: InputValue) => {
      setValuesById((prev) => ({
        ...prev,
        [programId]: { ...(prev[programId] ?? defaultValues(program.inputs)), [id]: value },
      }));
    },
    [programId, program],
  );

  const chooseProgram = useCallback((id: string) => {
    setProgramId(id);
    const next = programById(id);
    if (next.suggestedView) setViewId(next.suggestedView);
  }, []);

  // Runs are async and a fast input (a dragged slider) can outpace them, so each
  // one carries a generation number and only the newest is allowed to land.
  const generation = useRef(0);
  useEffect(() => {
    if (!ready) return;
    const mine = ++generation.current;
    setProgress(0);
    let abandoned = false;
    void runProgram(program, values, seed, {
      execution,
      unlocked,
      onProgress: (done) => {
        if (generation.current === mine) setProgress(done);
      },
      cancelled: () => abandoned || generation.current !== mine,
    }).then((tl) => {
      if (generation.current !== mine) return;
      setTimeline(tl);
      setProgress(null);
    });
    return () => {
      abandoned = true;
    };
  }, [ready, program, values, seed, execution, unlocked]);

  const player = usePlayer(timeline?.frames.length ?? 1);

  // A new program starts at the beginning; changing an input on the program you
  // are already watching does not, so a slider can be dragged mid-circuit.
  const resetPlayhead = player.reset;
  useEffect(() => {
    resetPlayhead();
  }, [programId, resetPlayhead]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          player.toggle();
          break;
        case 'ArrowRight':
          e.preventDefault();
          player.step(1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          player.step(-1);
          break;
        case 'Home':
          player.toStart();
          break;
        case 'End':
          player.toEnd();
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player]);

  const frameIndex = timeline ? Math.min(player.index, timeline.frames.length - 1) : 0;
  const frame = timeline?.frames[frameIndex] ?? null;
  const analysis = useMemo(
    () => (timeline && frame ? analyse(frame, timeline.nQubits, timeline.amplitudeCount) : null),
    [timeline, frame],
  );

  const readouts: Readout[] = useMemo(() => {
    if (!timeline || !analysis || !program.outputs) return [];
    const byIndex = new Map(analysis.support.map((e) => [e.index, e.prob]));
    const ctx: ReadoutContext = {
      nQubits: timeline.nQubits,
      amplitudeCount: timeline.amplitudeCount,
      values: timeline.values,
      probabilityOf: (i) => analysis.probs?.[i] ?? byIndex.get(i) ?? 0,
      probabilities: analysis.probs,
      p1: Float64Array.from(analysis.qubits, (q) => q.p1),
      bits: frame?.bits ?? {},
      likeliest: analysis.likeliest,
      entropyBits: analysis.entropyBits,
      finished: frameIndex >= timeline.steps.length,
      readRegister: (qubits) => readRegister(analysis, qubits),
    };
    try {
      return program.outputs(ctx);
    } catch {
      // A readout is a convenience, not part of the run — never let one take the
      // page down.
      return [];
    }
  }, [timeline, analysis, program, frame, frameIndex]);

  const view = viewById(viewId);
  const currentStep =
    timeline && frameIndex > 0 ? (timeline.steps[frameIndex - 1] ?? null) : null;
  const limits = ready ? engineLimitsIfReady() : null;

  if (engineError) {
    return (
      <div className="center">
        <p className="error">Could not start the engine: {engineError}</p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          qsim<span>quantum circuit visualiser</span>
        </div>
        <div className="chips">
          {timeline && (
            <>
              <span className="chip">
                {timeline.nQubits} qubits · {timeline.amplitudeCount.toLocaleString()} amplitudes
              </span>
              <span className="chip">{timeline.backend.description}</span>
              {timeline.backend.exchangedBlocks > 0 && (
                <span className="chip">
                  {timeline.backend.exchangedBlocks.toLocaleString()} blocks exchanged
                </span>
              )}
              <span className="chip">
                {timeline.steps.length} steps in {timeline.elapsedMs.toFixed(1)} ms
              </span>
            </>
          )}
          {progress !== null && <span className="chip">running… step {progress}</span>}
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <section className="card">
            <h2 className="card-title">Program</h2>
            <select
              value={programId}
              onChange={(e) => chooseProgram(e.target.value)}
              aria-label="Program"
            >
              {PROGRAMS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.blurb}
                </option>
              ))}
            </select>
            <p style={{ marginTop: 8, fontSize: 12 }}>{program.detail}</p>
          </section>

          <section className="card">
            <h2 className="card-title">Inputs</h2>
            <InputsPanel
              specs={program.inputs}
              values={values}
              qubitCeiling={ceiling(execution, unlocked, limits)}
              onChange={setValue}
            />
            <div className="field">
              <div className="field-head">
                <span className="field-label">Measurement seed</span>
                <span className="field-value">{seed}</span>
              </div>
              <div className="stepper">
                <button className="btn" onClick={() => setSeed((s) => (s + 1) & 0xffff)}>
                  Next seed
                </button>
                <span className="field-hint">re-rolls every measurement in the run</span>
              </div>
            </div>
          </section>

          <section className="card" id="outputs">
            <h2 className="card-title">Outputs</h2>
            {timeline && frame ? (
              <OutputsPanel
                readouts={readouts}
                bits={frame.bits}
                norm={frame.norm}
                finished={frameIndex >= timeline.steps.length}
              />
            ) : (
              <p className="field-hint">starting the engine…</p>
            )}
            {timeline?.error && (
              <p className="error" style={{ marginTop: 8 }}>
                {timeline.error}
              </p>
            )}
          </section>

          <ExecutionPanel
            execution={execution}
            onExecution={setExecution}
            unlocked={unlocked}
            onUnlocked={setUnlocked}
            timeline={timeline}
            limits={limits}
          />
        </aside>

        <main className="main">
          <div className="tabs">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                className={`tab${program.suggestedView === v.id ? ' tab-suggested' : ''}`}
                aria-pressed={v.id === viewId}
                onClick={() => setViewId(v.id)}
                title={
                  program.suggestedView === v.id
                    ? `${v.subtitle} — the best angle on ${program.name}`
                    : v.subtitle
                }
              >
                {v.name}
              </button>
            ))}
          </div>

          <section className="stage">
            <div className="stage-head">
              <h2>{view.name}</h2>
              <p>{view.subtitle}</p>
            </div>
            <div className="stage-body">
              {timeline && frame && analysis ? (
                <view.Component
                  timeline={timeline}
                  index={frameIndex}
                  frame={frame}
                  analysis={analysis}
                  execution={execution}
                  onSeek={player.seek}
                />
              ) : (
                <div className="center">
                  {progress !== null ? `running the circuit… step ${progress}` : 'starting the engine…'}
                </div>
              )}
            </div>
          </section>

          <Transport
            index={player.index}
            last={player.last}
            playing={player.playing}
            speed={player.speed}
            atStart={player.atStart}
            atEnd={player.atEnd}
            step={currentStep}
            wires={timeline?.wireLabels ?? []}
            onSeek={player.seek}
            onStep={player.step}
            onToggle={player.toggle}
            onStart={player.toStart}
            onEnd={player.toEnd}
            onSpeed={player.setSpeed}
          />
        </main>
      </div>
    </div>
  );
}
