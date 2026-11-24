/**
 * A number kept out of sight (an SSN, say): dots until Show is pressed, typed at the end. Show is a button of its own,
 * after the box: two controls do not share a box (docs/design.md). The intake style draws it over the box's inline end,
 * in room the box keeps for it, so it reads as part of the field and is still its own Tab stop. The value lives in the caller's state alone:
 * this never logs it, stores it or writes it anywhere, the box turns off autofill and spellcheck, and while hidden the
 * dots are all the page holds. Preview: @mistriwork/ui is Preview at 1.0.
 */
import { Input } from '@ui-sdk/react/input';
import { useState, type ReactNode, type Ref } from 'react';
import { Button } from './Button.js';
import type { FieldFrame } from './fieldFrame.js';
import { digits, maskNamed, type Mask, type MaskName } from './masks.js';
import { ValidMark } from './TextField.js';
import { changeDetails, type ChangeDetails } from './changeDetails.js';
import { Frame } from './internal/Frame.js';
import { slotted } from './internal/uiKitContext.js';

/** Props for the `SensitiveField` masked secret control. */
export interface SensitiveFieldProps extends FieldFrame {
  /** The raw value. */
  value: string;
  onValueChange?: (raw: string, details: ChangeDetails<'input-change'>) => void;
  mask: Mask | MaskName;
  disabled?: boolean;
  valid?: boolean;
  validIcon?: ReactNode;
  onBlur?: () => void;
  /** The line under the box. */
  note?: ReactNode;
  noteIcon?: ReactNode;
  /** The words of the button beside the box. */
  showLabel: string;
  hideLabel: string;
  ref?: Ref<HTMLInputElement>;
}

function DefaultSensitiveField(props: SensitiveFieldProps): ReactNode {
  const [shown, setShown] = useState(false);
  const resolvedMask = maskNamed(props.mask);
  const formatted = resolvedMask.format(props.value);
  const display = shown ? formatted : '•'.repeat(formatted.length);
  const targetRef = props.ref ?? (props as { inputRef?: Ref<HTMLInputElement> }).inputRef;
  const emit = (raw: string, details: ChangeDetails<'input-change'>) => {
    const legacy = (props as { onChange?: (raw: string, details: ChangeDetails<'input-change'>) => void }).onChange;
    props.onValueChange?.(raw, details);
    legacy?.(raw, details);
  };
  const change = (typed: string, caret: number | null, details: ChangeDetails<'input-change'>): void => {
    if (shown) return emit(resolvedMask.parse(typed), details);
    if (/^•*$/.test(typed)) {
      if (typed.length >= formatted.length) return;
      const at = caret !== null && caret <= typed.length ? caret : typed.length;
      const removed = formatted.length - typed.length;
      const prefix = formatted.slice(0, at);
      const suffix = formatted.slice(at + removed);
      let nextDigits = digits(prefix) + digits(suffix);
      if (nextDigits === digits(formatted)) {
        const pre = digits(prefix);
        const post = digits(suffix);
        nextDigits = pre.length > 0 ? pre.slice(0, -1) + post : post.slice(1);
      }
      return emit(resolvedMask.parse(nextDigits), details);
    }
    let lead = 0;
    while (lead < typed.length && lead < formatted.length && typed[lead] === '•') lead++;
    let trail = 0;
    while (trail < typed.length - lead && trail < formatted.length - lead && typed[typed.length - 1 - trail] === '•') {
      trail++;
    }
    const prefix = formatted.slice(0, lead);
    const inserted = typed.slice(lead, typed.length - trail);
    const suffix = trail > 0 ? formatted.slice(formatted.length - trail) : '';
    emit(resolvedMask.parse(digits(prefix) + digits(inserted) + digits(suffix)), details);
  };
  return (
    <Frame {...props}>
      <div data-slot="field-with-action">
        <div data-slot="field-box" data-has-mark={props.valid === undefined ? undefined : ''}>
          <Input
            id={props.id}
            ref={targetRef}
            data-hidden={shown ? undefined : ''}
            value={display}
            disabled={props.disabled}
            inputMode={resolvedMask.inputMode ?? 'numeric'}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            aria-required={props.required || undefined}
            onChange={(event) => change(event.target.value, event.target.selectionStart, changeDetails('input-change', event))}
            onBlur={props.onBlur}
          />
          {props.valid ? <ValidMark icon={props.validIcon} /> : null}
          <Button variant="ghost" disabled={props.disabled} aria-pressed={shown} aria-controls={props.id} onClick={() => setShown(!shown)}>
            {shown ? props.hideLabel : props.showLabel}
          </Button>
        </div>
      </div>
      {props.note ? (
        <p data-slot="field-note">
          {props.noteIcon}
          {props.note}
        </p>
      ) : null}
    </Frame>
  );
}

/** Masked sensitive identifier field holding bullet dots in the DOM until explicitly revealed. */
export const SensitiveField = slotted('SensitiveField', DefaultSensitiveField, { onValueChange: [1, 'input-change'] });
