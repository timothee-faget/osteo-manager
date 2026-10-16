import { useId } from "react";

/** Decimal input followed by its unit; the label holds only the field name. */
export function UnitField({
  label,
  unit,
  hint,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <span className="with-unit">
        <input
          id={id}
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {unit}
      </span>
      {hint && <small>{hint}</small>}
    </div>
  );
}
