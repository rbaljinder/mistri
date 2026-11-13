/**
 * A box of several lines, in the same frame as a TextField: a Field's label, hint and problem wired to a textarea, which
 * the reader may stretch down. Props only. Preview: @mistriwork/ui is Preview at 1.0.
 */
import type { ReactNode, Ref } from 'react';
import { Field } from './Field.js';
import { frameOf, type FieldFrame } from './fieldFrame.js';
import { changeDetails, type ChangeDetails } from './changeDetails.js';

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

export function TextArea(props: TextAreaProps): ReactNode {
  return (
    <Field {...frameOf(props)}>
      {(control) => (
        <>
          <div className="field-box">
            <textarea
              {...control}
              ref={props.inputRef}
              className="field-control"
              rows={props.rows ?? 3}
              maxLength={props.maxLength}
              name={props.name}
              value={props.value}
              autoComplete={props.autoComplete ?? 'off'}
              placeholder={props.placeholder}
              disabled={props.disabled}
              readOnly={props.readOnly}
              onChange={(e) => props.onChange(e.target.value, changeDetails('input-change', e))}
              onBlur={props.onBlur}
            />
          </div>
          {props.after}
        </>
      )}
    </Field>
  );
}
