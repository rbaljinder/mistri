import { Input } from '@ui-sdk/react/input';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { ValidMark } from './display';
import { FieldFrame } from './fields';
import { caretAfter, digits, type Mask, type MaskName, masks } from './masks';

export type MaskedFieldProps = {
  label: string;
  name?: string;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  required?: boolean;
  tip?: ReactNode;
  /* One of the named shapes (`phone`, `date`, `card`, …) or a mask of the caller's own (masks.ts). */
  mask: MaskName | Mask;
  /* The kept value: the digits, without the shape. */
  value?: string;
  defaultValue?: string;
  /* Hears the kept value, and whether it is whole. */
  onValueChange?: (value: string, whole: boolean) => void;
  disabled?: boolean;
};

/* A field that shows what is typed in the shape the reader expects (a phone number in its brackets, a card in
   fours) and keeps only the digits. Three things a mask usually gets wrong are done here: the caret stays where
   the reader is typing when they edit the middle of a value; deleting across a bracket or a dash deletes the
   digit before it, not the punctuation the field would only draw again; and a value that is whole says so with a
   mark, so the reader knows the field wants no more. The form is sent the digits, in a hidden field of this name. */
export function MaskedField({
  label,
  name,
  hint,
  error,
  optional,
  required,
  tip,
  mask,
  value,
  defaultValue,
  onValueChange,
  disabled,
}: MaskedFieldProps) {
  const shape = typeof mask === 'string' ? masks[mask] : mask;
  const [own, setOwn] = useState(defaultValue ?? '');
  const raw = value ?? own;
  const shown = shape.format(raw);
  const box = useRef<HTMLInputElement>(null);
  /* How many kept characters stood before the caret when the reader last typed; where the caret goes next. */
  const kept = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (kept.current === null || !box.current) return;
    const at = caretAfter(shown, kept.current);
    box.current.setSelectionRange(at, at);
    kept.current = null;
  });
  const whole = shape.length !== undefined && raw.length === shape.length;

  return (
    <FieldFrame {...{ label, hint, error, optional, required, tip }}>
      <div data-slot="adorned" data-kind="masked">
        <Input
          ref={box}
          value={shown}
          disabled={disabled}
          inputMode={shape.inputMode}
          autoComplete={shape.autoComplete}
          placeholder={shape.placeholder}
          onValueChange={(typed, details) => {
            const text = String(typed);
            const el = details?.event?.target instanceof HTMLInputElement ? details.event.target : box.current;
            const before = digits(text.slice(0, el?.selectionStart ?? text.length)).length;
            let next = shape.parse(text);
            // A Backspace that only took out punctuation: the reader meant the digit before it.
            if (next === raw && text.length < shown.length && before > 0) {
              next = raw.slice(0, before - 1) + raw.slice(before);
              kept.current = before - 1;
            } else kept.current = before;
            setOwn(next);
            onValueChange?.(next, shape.length !== undefined && next.length === shape.length);
          }}
        />
        {whole && !error && <ValidMark />}
      </div>
      {name && <input type="hidden" name={name} value={raw} />}
    </FieldFrame>
  );
}
