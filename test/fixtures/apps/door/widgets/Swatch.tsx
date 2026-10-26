/**
 * A color field drawn as a row of swatches: what the visitor picks is handed back as text, and the server reads it
 * as the field's kind (text, at most 20 characters) whatever this draws.
 */
import type { InputProps } from '@mistriwork/mistri/ui';

const COLORS = ['tomato', 'teal', 'navy'] as const;

export default function Swatch({ value, onChange, id, label, disabled }: InputProps<string>) {
  return (
    <div id={id} role="radiogroup" aria-label={label} data-swatch="">
      {COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          disabled={disabled}
          onClick={() => onChange(color)}
          style={{ background: color, color: 'white', marginRight: 8, padding: '4px 10px', border: 0 }}
        >
          {color}
        </button>
      ))}
    </div>
  );
}
