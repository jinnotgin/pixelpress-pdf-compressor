import { useEffect, useState } from 'react';

interface RangeControlProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
  /** Small helper line shown under the control, e.g. which direction shrinks the file. */
  hint?: string;
}

/**
 * Slider paired with a number field. The number field keeps a local draft so
 * you can clear and retype it; the value is clamped and committed on blur/Enter.
 */
export function RangeControl({
  id,
  label,
  value,
  min,
  max,
  unit,
  onChange,
  hint,
}: RangeControlProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const parsed = Number(draft);
    const bounded = Number.isFinite(parsed)
      ? Math.max(min, Math.min(max, Math.round(parsed)))
      : value;
    setDraft(String(bounded));
    if (bounded !== value) onChange(bounded);
  };

  const updateRange = (next: string) => {
    const bounded = Math.max(min, Math.min(max, Number(next)));
    setDraft(String(bounded));
    onChange(bounded);
  };

  return (
    <div>
      <label className="sub-label" htmlFor={id}>
        <span>{label}</span>
        <output>
          {value}
          {unit}
        </output>
      </label>
      <div className="range-row">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(event) => updateRange(event.target.value)}
        />
        <input
          className="number-input"
          aria-label={`${label} numeric value`}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
        />
      </div>
      {hint && <p className="control-hint">{hint}</p>}
    </div>
  );
}
