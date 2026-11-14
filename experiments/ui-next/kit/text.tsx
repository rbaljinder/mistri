import { Button } from '@ui-sdk/react/button';
import { Input } from '@ui-sdk/react/input';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Mask } from '@mistriwork/ui/masks.js';
import type { MaskedFieldProps, TextFieldProps } from '@mistriwork/ui/TextField.js';
import type { UiKitSlots } from '@mistriwork/ui/UiKit.js';
import { Frame } from './Frame';
import { told } from './told';

const digits = (text: string): string => text.replace(/\D/g, '');

/* Whole money, drawn `$2,500` (or `25,000` with no symbol); the value is the digits. Said here and not read from
   @mistriwork/ui because a kit is compiled with nothing of mistri's but the page's own modules. */
const money = (symbol: string, max = 7): Mask => ({
  parse: (typed) => digits(typed).slice(0, max),
  format: (raw) => (raw === '' ? '' : `${symbol}${Number(raw).toLocaleString('en-US')}`),
  inputMode: 'numeric',
});

/* The mark at a box's end, in room that is always kept for it, so it arrives without moving the text. Decorative:
   validity is aria-invalid's to say. */
function Mark({ valid, icon }: { valid?: boolean; icon?: React.ReactNode }) {
  return valid ? (
    <span data-slot="field-mark" aria-hidden="true">
      {icon}
    </span>
  ) : null;
}

/* Each slot is its plain component, typed by mistri's own props, where a change always carries its details; the
   slot's type only adds that a kit may leave them out. */
function Text(props: TextFieldProps) {
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
          required={props.required}
          onValueChange={(value, details) => props.onChange(String(value), told('input-change', details))}
          onBlur={props.onBlur}
        />
        <Mark valid={props.valid} icon={props.validIcon} />
      </div>
      {props.after}
    </Frame>
  );
}

export const TextField: UiKitSlots['TextField'] = Text;

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

/* A box that shows its value through a mask and keeps the raw one. The mask is a pair of functions and knows
   nothing of the caret (packages/ui/src/masks.ts), so the box keeps it: a value rewritten under the reader's
   hands would otherwise throw the caret to the end each time they edit its middle. Where the kept value is
   digits, the caret is put back after as many digits as stood before it, and a Backspace that only took out a
   bracket or a dash takes the digit before it instead, since the mask would draw the punctuation again. A mask
   that keeps more than digits is left to the browser. */
function Masked({ mask, value, onChange, inputRef, ...rest }: MaskedFieldProps) {
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
    <Text
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

export const MaskedField: UiKitSlots['MaskedField'] = Masked;

export const MoneyField: UiKitSlots['MoneyField'] = ({ symbol = '$', ...rest }: Omit<MaskedFieldProps, 'mask'> & { symbol?: string }) => (
  <Masked kind="money" {...rest} mask={money(symbol)} />
);

/* A number kept out of sight: dots until Show is pressed, typed at the end. The value lives in the caller's state
   alone; while hidden the dots are all the page holds. Show is a button of its own after the box. */
export const SensitiveField: UiKitSlots['SensitiveField'] = (props) => {
  const [shown, setShown] = useState(false);
  const formatted = props.mask.format(props.value);
  const change = (typed: string, details: Parameters<typeof told>[1]) => {
    if (shown) return props.onChange(props.mask.parse(typed), told('input-change', details));
    // Hidden: what is left of the dots keeps that many characters of the number; a digit typed is added at the end.
    const kept = formatted.slice(0, typed.replace(/[^•]/g, '').length);
    props.onChange(props.mask.parse(digits(kept) + digits(typed)), told('input-change', details));
  };
  return (
    <Frame {...props}>
      <div data-slot="field-with-action">
        <div data-slot="field-box" data-has-mark={props.valid === undefined ? undefined : ''}>
          <Input
            id={props.id}
            value={shown ? formatted : '•'.repeat(formatted.length)}
            inputMode={props.mask.inputMode ?? 'numeric'}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            required={props.required}
            onValueChange={(value, details) => change(String(value), details)}
            onBlur={props.onBlur}
          />
          <Mark valid={props.valid} icon={props.validIcon} />
        </div>
        <Button data-variant="quiet" onClick={() => setShown(!shown)}>
          {shown ? props.hideLabel : props.showLabel}
        </Button>
      </div>
      {props.note ? (
        <p data-slot="field-note">
          {props.noteIcon}
          {props.note}
        </p>
      ) : null}
    </Frame>
  );
};
