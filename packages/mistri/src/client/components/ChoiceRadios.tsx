/**
 * One choice as radios, every option in view: a form's own (CommandFields) and a choice from a table's once its rows
 * have arrived (IntakeControls), so `as: 'radios'` draws the same group whichever module holds the field.
 */
import type { CommandValue } from '../commandState.js';

interface ChoiceRadiosProps {
  id: string;
  options: readonly { value: string | number; label: string }[];
  value: unknown;
  describedBy?: string;
  required?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  onChange: (value: CommandValue) => void;
}

export function ChoiceRadios({ id, options, value, describedBy, required, invalid, disabled, onChange }: ChoiceRadiosProps) {
  const chosen = options.findIndex((option) => option.value === value);
  return (
    <div
      className="command-choices"
      role="radiogroup"
      id={id}
      aria-labelledby={`${id}-label`}
      aria-describedby={describedBy}
      aria-required={required || undefined}
      aria-invalid={invalid || undefined}
    >
      {options.map((option, index) => (
        <label className="command-choice" key={`${typeof option.value}:${option.value}`}>
          <input type="radio" name={id} checked={index === chosen} disabled={disabled} onChange={() => onChange(option.value)} />
          {option.label}
        </label>
      ))}
    </div>
  );
}
