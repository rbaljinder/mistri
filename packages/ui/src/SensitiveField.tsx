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
}

function DefaultSensitiveField(props: SensitiveFieldProps): ReactNode {
  const [shown, setShown] = useState(false);
  const formatted = props.mask.format(props.value);
  const display = shown ? formatted : '•'.repeat(formatted.length);
  const change = (typed: string, caret: number | null, details: ChangeDetails<'input-change'>): void => {
    if (shown) return props.onChange(props.mask.parse(typed), details);
    // Hidden: preserve unchanged leading and trailing dots around the edited span so mid-string edits do not corrupt later digits.
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
      return props.onChange(props.mask.parse(nextDigits), details);
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
    props.onChange(props.mask.parse(digits(prefix) + digits(inserted) + digits(suffix)), details);
  };
  return (
    <Frame {...props}>
      <div data-slot="field-with-action">
        <div data-slot="field-box" data-has-mark={props.valid === undefined ? undefined : ''}>
          <Input
            id={props.id}
            data-hidden={shown ? undefined : ''}
            value={display}
            disabled={props.disabled}
            inputMode={props.mask.inputMode ?? 'numeric'}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            aria-required={props.required || undefined}
            // React's own change, as the text box hears it (TextField.tsx says why).
            onChange={(event) => change(event.target.value, event.target.selectionStart, changeDetails('input-change', event))}
            onBlur={props.onBlur}
          />
          {props.valid ? <ValidMark icon={props.validIcon} /> : null}
        </div>
        <Button intent="quiet" disabled={props.disabled} aria-pressed={shown} aria-controls={props.id} onClick={() => setShown(!shown)}>
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
