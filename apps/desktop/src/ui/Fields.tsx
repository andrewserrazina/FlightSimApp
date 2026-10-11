import { useId, type ReactNode } from "react";

export function CheckboxField({ label, description, checked, onChange, disabled }: { label: string; description?: ReactNode; checked: boolean; onChange(v: boolean): void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="field field--checkbox">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} aria-describedby={description ? `${id}-d` : undefined} />
      <div>
        <label htmlFor={id} className="field__label">
          {label}
        </label>
        {description && (
          <p id={`${id}-d`} className="field__description">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

export function SelectField<T extends string>({ label, description, value, options, onChange, disabled }: { label: string; description?: ReactNode; value: T; options: Array<{ value: T; label: string }>; onChange(v: T): void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="field__label">
        {label}
      </label>
      <select id={id} className="field__control" value={value} disabled={disabled} onChange={(e) => onChange(e.currentTarget.value as T)} aria-describedby={description ? `${id}-d` : undefined}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {description && (
        <p id={`${id}-d`} className="field__description">
          {description}
        </p>
      )}
    </div>
  );
}

export function NumberField({ label, description, value, min, max, unit, onCommit }: { label: string; description?: ReactNode; value: number; min: number; max: number; unit?: string; onCommit(v: number): void }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="field__label">
        {label}
        {unit && <span className="field__unit"> ({unit})</span>}
      </label>
      <input
        id={id}
        key={value}
        className="field__control field__control--number"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        defaultValue={value}
        aria-describedby={description ? `${id}-d` : undefined}
        onBlur={(e) => {
          const v = Number(e.currentTarget.value);
          if (Number.isInteger(v) && v >= min && v <= max) onCommit(v);
          else e.currentTarget.value = String(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      {description && (
        <p id={`${id}-d`} className="field__description">
          {description}
        </p>
      )}
    </div>
  );
}

export function TextField({
  label,
  description,
  value,
  onChange,
  type = "text",
  autoComplete,
  inputMode,
  required,
  disabled,
  maxLength,
}: {
  label: string;
  description?: ReactNode;
  value: string;
  onChange(v: string): void;
  type?: "text" | "email" | "password";
  autoComplete?: string;
  inputMode?: "text" | "email" | "numeric";
  required?: boolean;
  disabled?: boolean;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="field__label">
        {label}
      </label>
      <input
        id={id}
        className="field__control"
        type={type}
        value={value}
        autoComplete={autoComplete}
        inputMode={inputMode}
        required={required}
        disabled={disabled}
        maxLength={maxLength}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => onChange(e.currentTarget.value)}
        aria-describedby={description ? `${id}-d` : undefined}
      />
      {description && (
        <p id={`${id}-d`} className="field__description">
          {description}
        </p>
      )}
    </div>
  );
}
