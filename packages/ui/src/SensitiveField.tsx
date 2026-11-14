/**
 * A number kept out of sight (an SSN, say): dots until Show is pressed, typed at the end. Show is a button of its own,
 * after the box: two controls do not share a box (docs/design.md). The intake style draws it over the box's inline end,
 * in room the box keeps for it, so it reads as part of the field and is still its own Tab stop. The value lives in the caller's state alone:
 * this never logs it, stores it or writes it anywhere, the box turns off autofill and spellcheck, and while hidden the
 * dots are all the page holds. Preview: @mistriwork/ui is Preview at 1.0.
 */
import { Input } from '@ui-sdk/react/input';
import { useState, type ReactNode } from 'react';
import { Button } from './Button.js';
import type { FieldFrame } from './fieldFrame.js';
import { digits, type Mask } from './masks.js';
import { ValidMark } from './TextField.js';
import { changeDetails, type ChangeDetails } from './changeDetails.js';
import { Frame } from './internal/Frame.js';
import { slotted } from './internal/uiKitContext.js';

export interface SensitiveFieldProps extends FieldFrame {
  /** The raw value. */
  value: string;
  onChange: (raw: string, details: ChangeDetails<'input-change'>) => void;
  mask: Mask;
  valid?: boolean;
  validIcon?: ReactNode;
  onBlur?: () => void;
  /** The line under the box. */
  note?: ReactNode;
  noteIcon?: ReactNode;
  /** The words of the button beside the box. */
  showLabel: string;
  hideLabel: string;
}

function DefaultSensitiveField(props: SensitiveFieldProps): ReactNode {
  const [shown, setShown] = useState(false);
  const formatted = props.mask.format(props.value);
  const display = shown ? formatted : '•'.repeat(formatted.length);
  const change = (typed: string, details: ChangeDetails<'input-change'>): void => {
    if (shown) return props.onChange(props.mask.parse(typed), details);
    // Hidden: what is left of the dots keeps that many characters of the number; a digit typed is added at the end.
    const kept = formatted.slice(0, typed.replace(/[^•]/g, '').length);
    props.onChange(props.mask.parse(digits(kept) + digits(typed)), details);
  };
  return (
    <Frame {...props}>
      <div data-slot="field-with-action">
        <div data-slot="field-box" data-has-mark={props.valid === undefined ? undefined : ''}>
          <Input
            id={props.id}
            data-hidden={shown ? undefined : ''}
            value={display}
            inputMode={props.mask.inputMode ?? 'numeric'}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            aria-required={props.required || undefined}
            // React's own change, as the text box hears it (TextField.tsx says why).
            onChange={(event) => change(event.target.value, changeDetails('input-change', event))}
            onBlur={props.onBlur}
          />
          {props.valid ? <ValidMark icon={props.validIcon} /> : null}
        </div>
        <Button intent="quiet" onClick={() => setShown(!shown)}>
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
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const SensitiveField = slotted('SensitiveField', DefaultSensitiveField, { onChange: [1, 'input-change'] });
