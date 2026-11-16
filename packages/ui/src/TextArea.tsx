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

export interface TextAreaProps extends FieldFrame {
  value: string;
  onChange: (value: string, details: ChangeDetails<'input-change'>) => void;
  onBlur?: () => void;
  /** Lines the box shows before the reader stretches it. Default 3. */
  rows?: number;
  maxLength?: number;
  autoComplete?: string;
  placeholder?: string;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  /** Something drawn under the box: a count, say. */
  after?: ReactNode;
}

function DefaultTextArea(props: TextAreaProps): ReactNode {
  return (
    <Frame {...props}>
      <Textarea
        id={props.id}
        ref={props.inputRef}
        name={props.name}
        value={props.value}
        rows={props.rows ?? 3}
        maxLength={props.maxLength}
        autoComplete={props.autoComplete ?? 'off'}
        placeholder={props.placeholder}
        disabled={props.disabled}
        readOnly={props.readOnly}
        aria-required={props.required || undefined}
        // React's own change, as the text box hears it (TextField.tsx says why).
        onChange={(event) => props.onChange(event.target.value, changeDetails('input-change', event))}
        onBlur={props.onBlur}
      />
      {props.after}
    </Frame>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const TextArea = slotted('TextArea', DefaultTextArea, { onChange: [1, 'input-change'] });
