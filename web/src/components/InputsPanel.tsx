/**
 * The program's own inputs, rendered from its `InputSpec[]`.
 *
 * Generic on purpose: a program declares what it needs and the panel builds the
 * controls, so adding a program never means touching this file.
 */
import { resolve } from '../lib/inputs';
import { bitString } from '../lib/format';
import { Info } from './Info';
import type { InputSpec, InputValue, InputValues } from '../lib/types';

interface Props {
  specs: InputSpec[];
  values: InputValues;
  /** Largest register this run will attempt, for inputs that size it. */
  qubitCeiling: number;
  onChange: (id: string, value: InputValue) => void;
}

export function InputsPanel({ specs, values, qubitCeiling, onChange }: Props) {
  if (specs.length === 0) {
    return <p className="field-hint">This program takes no inputs.</p>;
  }
  return (
    <div>
      {specs.map((spec) => (
        <Field
          key={spec.id}
          spec={spec}
          values={values}
          qubitCeiling={qubitCeiling}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

function Field({
  spec,
  values,
  qubitCeiling,
  onChange,
}: {
  spec: InputSpec;
  values: InputValues;
  qubitCeiling: number;
  onChange: (id: string, value: InputValue) => void;
}) {
  const raw = values[spec.id];

  switch (spec.kind) {
    case 'slider': {
      const value = typeof raw === 'number' ? raw : spec.default;
      const shown = spec.format ? spec.format(value) : value.toFixed(2);
      return (
        <div className="field">
          <div className="field-head">
            <span className="field-label">{spec.label}</span>
            {spec.hint && <Info about={spec.label}>{spec.hint}</Info>}
            <span className="field-value">
              {shown}
              {spec.unit ? ` ${spec.unit}` : ''}
            </span>
          </div>
          <input
            type="range"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={value}
            aria-label={spec.label}
            onChange={(e) => onChange(spec.id, Number(e.target.value))}
          />
        </div>
      );
    }

    case 'stepper': {
      const declared = resolve(spec.max, values);
      const max = spec.capByCeiling ? Math.min(declared, qubitCeiling) : declared;
      const value = Math.min(max, Math.max(spec.min, typeof raw === 'number' ? raw : spec.default));
      return (
        <div className="field">
          <div className="field-head">
            <span className="field-label" id={`label-${spec.id}`}>
              {spec.label}
            </span>
            {spec.hint && <Info about={spec.label}>{spec.hint}</Info>}
          </div>
          <div className="stepper" role="group" aria-labelledby={`label-${spec.id}`}>
            <button
              className="btn"
              onClick={() => onChange(spec.id, Math.max(spec.min, value - 1))}
              disabled={value <= spec.min}
              aria-label={`Decrease ${spec.label}`}
            >
              −
            </button>
            <output>{value}</output>
            <button
              className="btn"
              onClick={() => onChange(spec.id, Math.min(max, value + 1))}
              disabled={value >= max}
              aria-label={`Increase ${spec.label}`}
            >
              +
            </button>
            {spec.unit && <span className="unit">{spec.unit}</span>}
          </div>
          {spec.capByCeiling && max < declared && (
            <span className="field-hint">stops at {max}</span>
          )}
        </div>
      );
    }

    case 'select': {
      const value = typeof raw === 'string' ? raw : spec.default;
      const chosen = spec.options.find((o) => o.value === value);
      return (
        <div className="field">
          <div className="field-head">
            <label className="field-label" htmlFor={`input-${spec.id}`}>
              {spec.label}
            </label>
            {(chosen?.hint ?? spec.hint) && (
              <Info about={spec.label}>{chosen?.hint ?? spec.hint ?? ''}</Info>
            )}
          </div>
          <select
            id={`input-${spec.id}`}
            aria-label={spec.label}
            value={value}
            onChange={(e) => onChange(spec.id, e.target.value)}
          >
            {spec.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    }

    case 'bits': {
      const width = resolve(spec.width, values);
      const mask = (1 << width) - 1;
      const value = (typeof raw === 'number' ? raw : spec.default) & mask;
      // Highest qubit first, so the row reads the same way as a ket.
      const order = Array.from({ length: width }, (_, i) => width - 1 - i);
      return (
        <div className="field">
          <div className="field-head">
            <span className="field-label">{spec.label}</span>
            {spec.hint && <Info about={spec.label}>{spec.hint}</Info>}
            <span className="field-value">
              |{bitString(value, width)}⟩ = {value}
            </span>
          </div>
          <div className="bit-row">
            {order.map((q) => (
              <button
                key={q}
                className="bit"
                aria-pressed={((value >> q) & 1) === 1}
                title={`qubit ${q}`}
                onClick={() => onChange(spec.id, value ^ (1 << q))}
              >
                {(value >> q) & 1}
              </button>
            ))}
            <span className="bit-value">q{width - 1}…q0</span>
          </div>
        </div>
      );
    }

    case 'toggle': {
      const value = typeof raw === 'boolean' ? raw : spec.default;
      return (
        <div className="field field-inline">
          <label className="switch">
            <input
              type="checkbox"
              checked={value}
              onChange={(e) => onChange(spec.id, e.target.checked)}
            />
            <span className="field-label">{spec.label}</span>
          </label>
          {spec.hint && <Info about={spec.label}>{spec.hint}</Info>}
        </div>
      );
    }
  }
}
