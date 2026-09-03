export interface RadioOption {
  value: string;
  label: string;
}

interface RadioGroupProps {
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: RadioOption[];
  columns?: 2 | 3;
}

export function RadioGroup({ name, value, onChange, options, columns = 2 }: RadioGroupProps) {
  return (
    <div className={`segmented ${columns === 3 ? 'three' : ''}`}>
      {options.map((option) => {
        const id = `${name}-${option.value}`;
        return (
          <span key={option.value} style={{ display: 'contents' }}>
            <input
              id={id}
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <label htmlFor={id}>{option.label}</label>
          </span>
        );
      })}
    </div>
  );
}
