import { useState } from 'react';
import { ThemeToggle } from './components/ThemeToggle';
import { useEngine } from './lib/useEngine';
import { CapacityPanel } from './panels/CapacityPanel';
import { AlgorithmsPanel } from './panels/AlgorithmsPanel';
import { PlaygroundPanel } from './panels/PlaygroundPanel';
import { ShardedPanel } from './panels/ShardedPanel';

type Tab = 'capacity' | 'sharded' | 'algorithms' | 'playground';

const TABS: { id: Tab; label: string }[] = [
  { id: 'capacity', label: 'Capacity benchmark' },
  { id: 'sharded', label: 'Sharded capacity' },
  { id: 'algorithms', label: 'Algorithm tests' },
  { id: 'playground', label: 'Playground' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('capacity');
  const { client, info, error } = useEngine();

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>Quantum simulation engine — test bench</h1>
          <p>
            A state-vector simulator written in Rust and compiled to WebAssembly. Measure how large a
            quantum register this machine can hold, and check the engine against results the physics
            predicts independently.
          </p>
        </div>
        <div className="masthead-aside">
          <ThemeToggle />
          {info && (
            <div className="engine-badge">
              <span>qsim v{info.version}</span>
              <span>max {info.maxQubits} qubits</span>
              <span>{info.gateNames.length} gates</span>
            </div>
          )}
        </div>
      </header>

      {error && (
        <div className="banner banner-critical">
          <div>
            <strong>Could not load the engine.</strong> {error} — run <span className="mono">npm run build:wasm</span>{' '}
            to build <span className="mono">engine/pkg</span>.
          </div>
        </div>
      )}

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            className="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {!info && !error && <p className="progress-line">Loading engine…</p>}

      {client && info && tab === 'capacity' && <CapacityPanel client={client} info={info} />}
      {info && tab === 'sharded' && <ShardedPanel />}
      {client && info && tab === 'algorithms' && <AlgorithmsPanel client={client} info={info} />}
      {client && info && tab === 'playground' && <PlaygroundPanel client={client} />}
    </div>
  );
}
