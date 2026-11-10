/**
 * A file chosen in the browser, handed to the page as a `File` (or null): for a page that reads a file before any
 * command runs, a CSV parsed and shown, say. It is the browser's own picker in a field's box, so the label, hint and
 * problem are wired in as they are for a text box, and the keyboard and the file dialog are the platform's. A command's
 * form has `field.file`, which sends the bytes; this sends nothing. Props only. Preview: @mistriwork/ui is Preview at 1.0.
 */
import { useEffect, useRef, type ReactNode, type Ref } from 'react';
import { Field } from './Field.js';
import { frameOf, type FieldFrame } from './fieldFrame.js';

export interface FileFieldProps extends FieldFrame {
  /** The chosen file; null while there is none. Set it to null to clear the choice. */
  value: File | null;
  onChange: (file: File | null) => void;
  /** What the picker offers, as the input's `accept`: `.csv`, `text/csv`, `image/*`, separated by commas. */
  accept?: string;
  name?: string;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

export function FileField(props: FileFieldProps): ReactNode {
  const own = useRef<HTMLInputElement | null>(null);
  // The input keeps its own file, so a page that clears the value (null) has to clear it too.
  useEffect(() => {
    if (props.value === null && own.current && own.current.value !== '') own.current.value = '';
  }, [props.value]);
  return (
    <Field {...frameOf(props)}>
      {(control) => (
        <input
          {...control}
          ref={(node) => {
            own.current = node;
            if (typeof props.inputRef === 'function') props.inputRef(node);
            else if (props.inputRef) props.inputRef.current = node;
          }}
          className="field-control field-file"
          type="file"
          name={props.name}
          accept={props.accept}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.files?.[0] ?? null)}
        />
      )}
    </Field>
  );
}
