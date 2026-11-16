/**
 * The text boxes of a form: a plain box, a box that draws its value through a mask, and whole money. A frame's label,
 * hint and problem are wired into the box by UI SDK's field; a valid mark stands at its inline end in space that is
 * always reserved, so it arrives without moving the text. Props only. Preview: @mistriwork/ui is Preview at 1.0.
 */
import { Input } from '@ui-sdk/react/input';
import { useLayoutEffect, useRef, type ReactNode, type Ref } from 'react';
import type { FieldFrame } from './fieldFrame.js';
import { digits, masks, type Mask } from './masks.js';
import { changeDetails, type ChangeDetails } from './changeDetails.js';
import { Frame } from './internal/Frame.js';
import { slotted } from './internal/uiKitContext.js';

/** The mark at a box's inline end: drawn in CSS unless a picture is lent. Decorative: validity is `aria-invalid`'s to say. */
function DefaultValidMark({ icon }: { icon?: ReactNode }): ReactNode {
  return (
    <span data-slot="field-mark" aria-hidden="true">
      {icon}
    </span>
  );
}

export interface TextFieldProps extends FieldFrame {
  value: string;
  onChange: (value: string, details: ChangeDetails<'input-change'>) => void;
  onBlur?: () => void;
  /** Present, the box reserves room for the mark; true draws it. Leave it out for a box that never shows one. */
  valid?: boolean;
  /** A picture for the mark in place of the drawn check. */
  validIcon?: ReactNode;
  type?: 'text' | 'email' | 'tel' | 'url';
  inputMode?: 'text' | 'email' | 'tel' | 'numeric' | 'url';
  autoComplete?: string;
  placeholder?: string;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** Something drawn under the box: a computed line, say. */
  after?: ReactNode;
}

function DefaultTextField(props: TextFieldProps): ReactNode {
  return (
    <Frame {...props}>
      <div data-slot="field-box" data-has-mark={props.valid === undefined ? undefined : ''}>
        <Input
          id={props.id}
          ref={props.inputRef}
          type={props.type ?? 'text'}
          name={props.name}
          value={props.value}
          inputMode={props.inputMode}
          autoComplete={props.autoComplete ?? 'off'}
          placeholder={props.placeholder}
          disabled={props.disabled}
          readOnly={props.readOnly}
          aria-required={props.required || undefined}
          /* React's own change, not UI SDK's `onValueChange`: that one hears the `input` event alone, and a value put
             in the box without one (a browser's autofill, a script that sets it and says `change`) would be shown and
             never reported. */
          onChange={(event) => props.onChange(event.target.value, changeDetails('input-change', event))}
          onBlur={props.onBlur}
        />
        {props.valid ? <ValidMark icon={props.validIcon} /> : null}
      </div>
      {props.after}
    </Frame>
  );
}

export interface MaskedFieldProps extends Omit<TextFieldProps, 'value' | 'onChange'> {
  mask: Mask;
  /** The raw value: the digits, usually. */
  value: string;
  onChange: (raw: string, details: ChangeDetails<'input-change'>) => void;
}

/* Where the caret belongs in `text` when it stood after this many digits: just past the last of them. */
function caretAfter(text: string, kept: number): number {
  if (kept <= 0) return 0;
  let seen = 0;
  for (let at = 0; at < text.length; at += 1) {
    if (/\d/.test(text[at]!)) seen += 1;
    if (seen === kept) return at + 1;
  }
  return text.length;
}

/* The mask is a pair of functions and knows nothing of the caret (masks.ts), so the box keeps it: a value rewritten
   under the reader's hands would otherwise throw the caret to the end each time they edit its middle. Where the kept
   value is digits, the caret is put back after as many digits as stood before it, and a Backspace that only took out
   a bracket or a dash takes the digit before it instead, since the mask would draw the punctuation again. A mask that
   keeps more than digits is left to the browser. */
/** A box that shows its value through a mask and keeps the raw one: `masks.phone`, `masks.date` (typed MM/DD/YYYY), `masks.ssn`… */
function DefaultMaskedField({ mask, value, onChange, inputRef, ...rest }: MaskedFieldProps): ReactNode {
  const box = useRef<HTMLInputElement | null>(null);
  const kept = useRef<number | null>(null);
  const shown = mask.format(value);
  useLayoutEffect(() => {
    const at = kept.current;
    kept.current = null;
    if (at === null || !box.current || box.current.ownerDocument.activeElement !== box.current) return;
    const place = caretAfter(shown, at);
    box.current.setSelectionRange(place, place);
  });
  return (
    <TextField
      {...rest}
      inputRef={(el: HTMLInputElement | null) => {
        box.current = el;
        if (typeof inputRef === 'function') inputRef(el);
        else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = el;
      }}
      value={shown}
      onChange={(typed, details) => {
        let next = mask.parse(typed);
        if (/^\d*$/.test(value) && /^\d*$/.test(next)) {
          const before = digits(typed.slice(0, box.current?.selectionStart ?? typed.length)).length;
          if (next === value && typed.length < shown.length && before > 0) {
            next = value.slice(0, before - 1) + value.slice(before);
            kept.current = before - 1;
          } else kept.current = before;
        }
        onChange(next, details);
      }}
      inputMode={rest.inputMode ?? mask.inputMode}
      placeholder={rest.placeholder ?? mask.placeholder}
    />
  );
}

/** Whole money, drawn `$2,500` (or `25,000` with `symbol=""`). The value is the digits. */
function DefaultMoneyField({ symbol = '$', ...rest }: Omit<MaskedFieldProps, 'mask'> & { symbol?: string }): ReactNode {
  return <MaskedField kind="money" {...rest} mask={masks.money(symbol)} />;
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const ValidMark = slotted('ValidMark', DefaultValidMark);
export const TextField = slotted('TextField', DefaultTextField, { onChange: [1, 'input-change'] });
export const MaskedField = slotted('MaskedField', DefaultMaskedField, { onChange: [1, 'input-change'] });
export const MoneyField = slotted('MoneyField', DefaultMoneyField, { onChange: [1, 'input-change'] });
