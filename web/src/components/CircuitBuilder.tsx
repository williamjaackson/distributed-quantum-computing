import { useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import type { InputValue } from '../lib/types';
import { GATE_CONTROLS, GATE_PARAMS, VARIADIC, gateArity } from '../lib/steps';
import { parseCircuit } from '../lib/circuit';
import type { CircuitDefinition, CircuitGate } from '../lib/circuit';

const GROUPS = [
  { label: 'Basics', gates: ['h', 'x', 'y', 'z', 'cx', 'cz', 'swap'] },
  { label: 'Phase', gates: ['s', 'sdg', 't', 'tdg', 'p', 'rz'] },
  { label: 'Rotate', gates: ['rx', 'ry', 'u3'] },
  { label: 'Control', gates: ['ch', 'cy', 'crx', 'cry', 'crz', 'cp', 'ccx', 'ccz', 'mcx', 'mcz'] },
];
const ANGLES = [0, Math.PI / 4, Math.PI / 2, Math.PI, 3 * Math.PI / 2, 2 * Math.PI];
const LABELS: Record<string, string> = { sdg: 'S†', tdg: 'T†', swap: '×' };
const gateLabel = (name: string) => LABELS[name] ?? name.toUpperCase();
type Drag = { kind: 'new'; name: string } | { kind: 'column'; index: number } | { kind: 'pin'; index: number; pin: number };

export function CircuitBuilder({ value, onChange }: { value: InputValue | undefined; onChange: (value: string) => void }) {
  const circuit = parseCircuit(value);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const commit = (next: CircuitDefinition) => onChange(JSON.stringify(next));
  const finish = () => { setDrag(null); setHot(null); };
  const updateGate = (index: number, gate: CircuitGate) => { const gates = [...circuit.gates]; gates[index] = gate; commit({ ...circuit, gates }); };
  const dropOnWire = (at: number, qubit: number) => {
    if (!drag) return;
    const gates = [...circuit.gates];
    if (drag.kind === 'new') gates.splice(at, 0, newGate(drag.name, circuit.qubits, qubit));
    if (drag.kind === 'pin') { const gate = gates[drag.index]; gates[drag.index] = { ...gate, qubits: uniqueQubit(gate.qubits, drag.pin, qubit) }; }
    commit({ ...circuit, gates }); finish();
  };
  const dropColumn = (at: number) => {
    if (!drag || drag.kind !== 'column') return;
    const gates = [...circuit.gates]; const [gate] = gates.splice(drag.index, 1);
    gates.splice(at > drag.index ? at - 1 : at, 0, gate); commit({ ...circuit, gates }); finish();
  };
  const allow = (e: DragEvent, id: string) => { e.preventDefault(); setHot(id); };

  return (
    <div className="circuit-builder visual-builder">
      <div className="builder-toolbar">
        <div className="builder-register"><span className="field-label">Wires</span><button disabled={circuit.qubits <= 1} onClick={() => commit(resize(circuit, circuit.qubits - 1))}>−</button><span className="wire-count">{circuit.qubits}</span><button disabled={circuit.qubits >= 12} onClick={() => commit(resize(circuit, circuit.qubits + 1))}>+</button></div>
        <span className="builder-help">Drag a gate onto a wire · drag symbols to move · drag ⠿ to reorder</span>
      </div>
      <div className="gate-palette" aria-label="Gate palette">
        {GROUPS.map((group) => <div className="gate-group" key={group.label}><span>{group.label}</span><div>{group.gates.map((name) => { const disabled = (gateArity(name) ?? 2) > circuit.qubits; return <button key={name} draggable={!disabled} disabled={disabled} onClick={() => commit({ ...circuit, gates: [...circuit.gates, newGate(name, circuit.qubits, 0)] })} onDragStart={(e) => { setDrag({ kind: 'new', name }); e.dataTransfer.effectAllowed = 'copy'; }} onDragEnd={finish} title={`Click to add, or drag ${gateLabel(name)} onto a wire`}>{gateLabel(name)}</button>; })}</div></div>)}
      </div>
      <div className="wire-editor" style={{ '--wire-count': circuit.qubits } as CSSProperties}>
        <div className="wire-labels">{Array.from({ length: circuit.qubits }, (_, row) => <span key={row}>q{circuit.qubits - 1 - row}</span>)}</div>
        <div className="wire-canvas">
          <div className="wire-lines" aria-hidden>{Array.from({ length: circuit.qubits }, (_, row) => <i key={row} />)}</div>
          {circuit.gates.length === 0 && <div className="wire-empty"><span>Drop any gate onto a wire</span>{Array.from({ length: circuit.qubits }, (_, row) => { const q = circuit.qubits - 1 - row; return <div key={q} className={hot === `empty-${q}` ? 'is-hot' : ''} onDragOver={(e) => allow(e, `empty-${q}`)} onDrop={() => dropOnWire(0, q)} />; })}</div>}
          {circuit.gates.map((gate, index) => <div className="gate-column-wrap" key={index}>
            <div className={`column-drop${hot === `before-${index}` ? ' is-hot' : ''}`} onDragOver={(e) => drag?.kind === 'column' && allow(e, `before-${index}`)} onDrop={() => dropColumn(index)} />
            <div className={`gate-column${drag?.kind === 'column' && drag.index === index ? ' is-dragging' : ''}`}>
              <div className="column-head"><button className="drag-column" draggable onDragStart={(e) => { setDrag({ kind: 'column', index }); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={finish}>⠿</button><span>{index + 1}</span><button className="remove-column" onClick={() => commit({ ...circuit, gates: circuit.gates.filter((_, i) => i !== index) })}>×</button></div>
              <div className="gate-lane">
                {Array.from({ length: circuit.qubits }, (_, row) => { const q = circuit.qubits - 1 - row; const pin = gate.qubits.indexOf(q); const role = gate.name === 'swap' ? 'swap' : pin >= 0 && pin < controlCount(gate) ? 'control' : 'target'; const id = `cell-${index}-${q}`; return <div key={q} className={`wire-cell${hot === id ? ' is-hot' : ''}`} onDragOver={(e) => (drag?.kind === 'new' || (drag?.kind === 'pin' && drag.index === index)) && allow(e, id)} onDrop={() => drag?.kind === 'new' ? dropOnWire(index + 1, q) : dropOnWire(index, q)}>{pin >= 0 && <button className={`circuit-node ${role}`} draggable onDragStart={(e) => { e.stopPropagation(); setDrag({ kind: 'pin', index, pin }); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={finish}><span>{role === 'control' ? '' : gateLabel(gate.name)}</span></button>}</div>; })}
                {gate.qubits.length > 1 && <i className="gate-connector" style={connectorStyle(gate, circuit.qubits)} />}
              </div>
              {gate.params.length > 0 && <div className="angle-chips">{gate.params.map((param, pi) => <button key={pi} onClick={() => { const params = [...gate.params]; params[pi] = ANGLES[(nearestAngle(param) + 1) % ANGLES.length]; updateGate(index, { ...gate, params }); }} title="Click to rotate"><span>{gate.params.length > 1 ? ['θ', 'φ', 'λ'][pi] : '↻'}</span>{angleLabel(param)}</button>)}</div>}
            </div>
          </div>)}
          {circuit.gates.length > 0 && <div className={`column-drop end${hot === 'end' ? ' is-hot' : ''}`} onDragOver={(e) => drag?.kind === 'column' && allow(e, 'end')} onDrop={() => dropColumn(circuit.gates.length)} />}
          {circuit.gates.length > 0 && <div className="add-gate-lane"><span>drop</span>{Array.from({ length: circuit.qubits }, (_, row) => { const q = circuit.qubits - 1 - row; const id = `add-${q}`; return <div key={q} className={hot === id ? 'is-hot' : ''} onDragOver={(e) => drag?.kind === 'new' && allow(e, id)} onDrop={() => dropOnWire(circuit.gates.length, q)}><i>+</i></div>; })}</div>}
        </div>
      </div>
    </div>
  );
}

function newGate(name: string, n: number, target: number): CircuitGate { const arity = Math.min(gateArity(name) ?? 3, n); const others = Array.from({ length: n }, (_, q) => q).filter((q) => q !== target).sort((a, b) => Math.abs(a - target) - Math.abs(b - target)).slice(0, arity - 1); return { name, qubits: name === 'swap' ? [target, ...others] : [...others, target], params: Array.from({ length: GATE_PARAMS[name] ?? 0 }, () => Math.PI / 2) }; }
function controlCount(gate: CircuitGate) { const count = GATE_CONTROLS[gate.name] ?? 0; return count === VARIADIC ? gate.qubits.length - 1 : count; }
function nearestAngle(v: number) { return ANGLES.reduce((best, angle, i) => Math.abs(angle - v) < Math.abs(ANGLES[best] - v) ? i : best, 0); }
function angleLabel(v: number) { return ['0', 'π⁄4', 'π⁄2', 'π', '3π⁄2', '2π'][nearestAngle(v)]; }
function uniqueQubit(qubits: number[], at: number, value: number) { const next = [...qubits]; const collision = next.findIndex((q, i) => i !== at && q === value); if (collision >= 0) next[collision] = next[at]; next[at] = value; return next; }
function connectorStyle(gate: CircuitGate, n: number) { const rows = gate.qubits.map((q) => n - 1 - q); const top = Math.min(...rows); const bottom = Math.max(...rows); return { top: `calc((${top} + .5) * var(--wire-row))`, height: `calc(${bottom - top} * var(--wire-row))` }; }
function resize(circuit: CircuitDefinition, qubits: number): CircuitDefinition { return { qubits, gates: circuit.gates.filter((g) => g.qubits.length <= qubits).map((g) => ({ ...g, qubits: g.qubits.map((q) => Math.min(q, qubits - 1)).filter((q, i, a) => a.indexOf(q) === i) })).filter((g) => g.qubits.length === (gateArity(g.name) ?? g.qubits.length)) }; }
