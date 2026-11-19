import { useState } from 'react';
import { defaultParams, type EffectInfo, type EffectParam, type EffectParams, type ParamValue } from '../../shared/effects';
import { applyEffect, previewEffect } from '../effects/apply';
import { hasEffectTarget, useStudio } from '../store/project';

export function EffectParamsPopover({ effect, onClose }: { effect: EffectInfo; onClose(): void }) {
  const [values, setValues] = useState<EffectParams>(() => defaultParams(effect.params));
  const hasSelection = useStudio(hasEffectTarget);
  const busy = useStudio((state) => state.effectQueue.includes(effect.id));

  const setValue = (key: string, value: ParamValue) => setValues((current) => ({ ...current, [key]: value }));

  return (
    <div className="popover" role="dialog" aria-label={`${effect.label} settings`}>
      <div className="popover-head">
        <strong>{effect.label}</strong>
        <button className="icon-button" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="popover-description">{effect.description}</p>
      {effect.params.map((param) => (
        <ParamControl key={param.key} param={param} value={values[param.key]} onChange={(value) => setValue(param.key, value)} />
      ))}
      <div className="popover-actions">
        <button className="tool" disabled={!hasSelection || busy} onClick={() => void previewEffect(effect.id, values)}>
          Preview
        </button>
        <button
          className="chunky small"
          disabled={!hasSelection}
          onClick={() => {
            applyEffect(effect.id, values, true);
            onClose();
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

function ParamControl({ param, value, onChange }: { param: EffectParam; value: ParamValue; onChange(value: ParamValue): void }) {
  if (param.type === 'bool') {
    return (
      <label className="param param-inline">
        <input type="checkbox" checked={value as boolean} onChange={(event) => onChange(event.target.checked)} />
        {param.label}
      </label>
    );
  }
  if (param.type === 'text') {
    return (
      <label className="param">
        {param.label}
        <input type="text" maxLength={120} value={value as string} onChange={(event) => onChange(event.target.value)} />
      </label>
    );
  }
  if (param.type === 'select') {
    return (
      <label className="param">
        {param.label}
        <select value={value as string} onChange={(event) => onChange(event.target.value)}>
          {param.options?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="param">
      <span className="param-row">
        {param.label}
        <span className="param-value">{value as number}</span>
      </span>
      <input
        type="range"
        min={param.min}
        max={param.max}
        step={param.step}
        value={value as number}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
