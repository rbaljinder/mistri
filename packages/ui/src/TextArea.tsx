/**
 * A box of several lines, in the same frame as a TextField: a frame's label, hint and problem wired to a textarea by
 * UI SDK's field, which the reader may stretch down. Props only. Preview: @mistriwork/ui is Preview at 1.0.
 */
import { Textarea } from '@ui-sdk/react/textarea';
import type { ReactNode, Ref } from 'react';
import type { FieldFrame } from './fieldFrame.js';
import { changeDetails, type ChangeDetails } from './changeDetails.js';
import { Frame } from './internal/Frame.js';
import { slotted } from './internal/uiKitContext.js';

/** Props for the `TextArea` multi-line form control. */
export interface TextAreaProps extends FieldFrame {
  value: string;
  onValueChange?: (value: string, details: ChangeDetails<'input-change'>) => void;
  onBlur?: () => void;
  /** Lines the box shows before the reader stretches it. Default 3. */
  rows?: number;
  maxLength?: number;
  autoComplete?: string;
  placeholder?: string;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  monospace?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
  /** Something drawn under the box: a count, say. */
  after?: ReactNode;
}

function DefaultTextArea(props: TextAreaProps): ReactNode {
  const targetRef = props.ref ?? (props as { inputRef?: Ref<HTMLTextAreaElement> }).inputRef;
  return (
    <Frame {...props}>
      <Textarea
        id={props.id}
        ref={targetRef}
        name={props.name}
        value={props.value}
        rows={props.rows ?? 3}
        maxLength={props.maxLength}
        autoComplete={props.autoComplete ?? 'off'}
        placeholder={props.placeholder}
        disabled={props.disabled}
        readOnly={props.readOnly}
        data-monospace={props.monospace ? '' : undefined}
        aria-required={props.required || undefined}
        onChange={(event) => {
          const info = changeDetails('input-change', event);
          const legacy = (props as { onChange?: (value: string, details: ChangeDetails<'input-change'>) => void }).onChange;
          props.onValueChange?.(event.target.value, info);
          legacy?.(event.target.value, info);
        }}
        onBlur={props.onBlur}
      />
      {props.after}
    </Frame>
  );
}

/** Framed multi-line textarea wiring label, hint, problem, and optional monospace styling. */
export const TextArea = slotted('TextArea', DefaultTextArea, { onValueChange: [1, 'input-change'] });
