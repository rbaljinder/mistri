/**
 * The text boxes of a form: a plain box, a box that draws its value through a mask, and whole money. A frame's label,
 * hint and problem are wired into the box by UI SDK's field; a valid mark stands at its inline end in space that is
 * always reserved, so it arrives without moving the text. Props only. Preview: @mistriwork/ui is Preview at 1.0.
 */
import { Input } from '@ui-sdk/react/input';
import { useLayoutEffect, useRef, type ReactNode, type Ref } from 'react';
import type { FieldFrame } from './fieldFrame.js';
import { digits, maskNamed, masks, type Mask, type MaskName } from './masks.js';
import { changeDetails, type ChangeDetails } from './changeDetails.js';
import { Frame } from './internal/Frame.js';
import { slotted } from './internal/uiKitContext.js';

/** Props for `ValidMark`. */
export interface ValidMarkProps {
  icon?: ReactNode;
  className?: string;
  ref?: Ref<HTMLSpanElement>;
}

/** The mark at a box's inline end: drawn in CSS unless a picture is lent. Decorative: validity is `aria-invalid`'s to say. */
function DefaultValidMark({ icon, className, ref }: ValidMarkProps): ReactNode {
  return (
    <span ref={ref} data-slot="field-mark" className={className || undefined} aria-hidden="true">
      {icon}
    </span>
  );
}

/** Props for the `TextField` form control. */
export interface TextFieldProps extends FieldFrame {
  value: string;
  onValueChange?: (value: string, details: ChangeDetails<'input-change'>) => void;
  onBlur?: () => void;
  /** Present, the box reserves room for the mark; true draws it. Leave it out for a box that never shows one. */
  valid?: boolean;
  /** A picture for the mark in place of the drawn check. */
  validIcon?: ReactNode;
  type?: 'text' | 'email' | 'tel' | 'url';
  inputMode?: 'text' | 'email' | 'tel' | 'numeric' | 'decimal' | 'url';
  autoComplete?: string;
  placeholder?: string;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  ref?: Ref<HTMLInputElement>;
  /** Something drawn under the box: a computed line, say. */
  after?: ReactNode;
}

function DefaultTextField(props: TextFieldProps): ReactNode {
  const targetRef = props.ref ?? (props as { inputRef?: Ref<HTMLInputElement> }).inputRef;
  return (
    <Frame {...props}>
      <div data-slot="field-box" data-has-mark={props.valid === undefined ? undefined : ''}>
        <Input
          id={props.id}
          ref={targetRef}
          type={props.type ?? 'text'}
          name={props.name}
          value={props.value}
          inputMode={props.inputMode}
          autoComplete={props.autoComplete ?? 'off'}
          placeholder={props.placeholder}
          disabled={props.disabled}
          readOnly={props.readOnly}
          aria-required={props.required || undefined}
          onChange={(event) => {
            const info = changeDetails('input-change', event);
            const legacy = (props as { onChange?: (value: string, details: ChangeDetails<'input-change'>) => void }).onChange;
            props.onValueChange?.(event.target.value, info);
            legacy?.(event.target.value, info);
          }}
          onBlur={props.onBlur}
        />
        {props.valid ? <ValidMark icon={props.validIcon} /> : null}
      </div>
      {props.after}
    </Frame>
  );
}

/** Props for the `MaskedField` form control. */
export interface MaskedFieldProps extends Omit<TextFieldProps, 'value' | 'onValueChange'> {
  mask: Mask | MaskName;
  /** The raw value: the digits, usually. */
  value: string;
  onValueChange?: (raw: string, details: ChangeDetails<'input-change'>) => void;
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

/** A box that shows its value through a mask and keeps the raw one: `masks.phone`, `masks.date` (typed MM/DD/YYYY), `masks.ssn`… */
function DefaultMaskedField(props: MaskedFieldProps): ReactNode {
  const {
    mask,
    value,
    onValueChange,
    ref,
    onChange: legacyChange,
    inputRef: legacyRef,
    ...rest
  } = props as MaskedFieldProps & {
    onChange?: (raw: string, details: ChangeDetails<'input-change'>) => void;
    inputRef?: Ref<HTMLInputElement>;
  };
  const resolvedMask = maskNamed(mask);
  const targetRef = ref ?? legacyRef;
  const box = useRef<HTMLInputElement | null>(null);
  const kept = useRef<number | null>(null);
  const shown = resolvedMask.format(value);
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
      ref={(el: HTMLInputElement | null) => {
        box.current = el;
        if (typeof targetRef === 'function') targetRef(el);
        else if (targetRef) (targetRef as { current: HTMLInputElement | null }).current = el;
      }}
      value={shown}
      onValueChange={(typed, details) => {
        let next = resolvedMask.parse(typed);
        if (/^\d*$/.test(value) && /^\d*$/.test(next)) {
          const before = digits(typed.slice(0, box.current?.selectionStart ?? typed.length)).length;
          if (next === value && typed.length < shown.length && before > 0) {
            next = value.slice(0, before - 1) + value.slice(before);
            kept.current = before - 1;
          } else kept.current = before;
        }
        onValueChange?.(next, details);
        legacyChange?.(next, details);
      }}
      inputMode={rest.inputMode ?? resolvedMask.inputMode}
      placeholder={rest.placeholder ?? resolvedMask.placeholder}
    />
  );
}

/** Props for the `MoneyField` form control. */
export type MoneyFieldProps = Omit<MaskedFieldProps, 'mask'> & { symbol?: string };

/** Money, drawn `$2,500` or `$1,250.50` (or `25,000` with `symbol=""`) in the page's locale. The value is a plain decimal
    string whatever the locale: `2500`, `1250.5`, `-5`. */
function DefaultMoneyField({ symbol = '$', ...rest }: MoneyFieldProps): ReactNode {
  return <MaskedField kind="money" {...rest} mask={masks.money(symbol)} />;
}

/** Decorative inline check indicator rendered inside validated field boxes. */
export const ValidMark = slotted('ValidMark', DefaultValidMark);

/** Framed single-line text input wiring label, hint, problem, and optional validity mark. */
export const TextField = slotted('TextField', DefaultTextField, { onValueChange: [1, 'input-change'] });

/** Framed text input formatting display values through a reversible `Mask` while preserving caret position. */
export const MaskedField = slotted('MaskedField', DefaultMaskedField, { onValueChange: [1, 'input-change'] });

/** Framed currency input built over `MaskedField` and `masks.money`. */
export const MoneyField = slotted('MoneyField', DefaultMoneyField, { onValueChange: [1, 'input-change'] });
