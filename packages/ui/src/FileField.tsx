/**
 * A file chosen in the browser, handed to the page as a `File` (or null): for a page that reads a file before any
 * command runs, a CSV parsed and shown, say. It is drawn as the look draws a control, the kit's button and the chosen
 * names beside it, not the browser's grey "Choose Files"; underneath it is still the browser's own input (hidden
 * visually, never removed), so the label, hint and problem are wired in as they are for a text box, and the keyboard
 * (Tab to it, Enter or Space) and the file dialog are the platform's. A command's form has `field.file`, which sends
 * the bytes; this sends nothing. Props only. Preview: @mistriwork/ui is Preview at 1.0.
 */
import { useEffect, useRef, type ReactNode, type Ref } from 'react';
import { buttonClass } from './Button.js';
import { changeDetails, type ChangeDetails } from './changeDetails.js';
import { Field } from './Field.js';
import { frameOf, type FieldFrame } from './fieldFrame.js';

interface FileFieldBase extends FieldFrame {
  /** What the picker offers, as the input's `accept`: `.csv`, `text/csv`, `image/*`, separated by commas. */
  accept?: string;
  name?: string;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** The button's words, in the caller's language: "Choose file" ("Choose files" with `multiple`) unless said. */
  chooseLabel?: string;
  /** What the names say while there is no file: "No file chosen". */
  noneLabel?: string;
}

/**
 * One file by default: `value` is the chosen File (null while there is none) and `onChange` hands up one. With `multiple`
 * the picker takes several at once, `value` is a `File[]` (empty while there is none) and `onChange` hands up the whole
 * choice, in the order the browser gives it; the input itself says how many ("3 files"), so a page need not.
 */
export type FileFieldProps = FileFieldBase &
  (
    | {
        multiple?: false;
        /** The chosen file; null while there is none. Set it to null to clear the choice. */
        value: File | null;
        onChange: (file: File | null, details: ChangeDetails<'file-pick'>) => void;
      }
    | {
        multiple: true;
        /** The chosen files; empty while there are none. Set it to `[]` to clear the choice. */
        value: File[];
        onChange: (files: File[], details: ChangeDetails<'file-pick'>) => void;
      }
  );

export function FileField(props: FileFieldProps): ReactNode {
  const own = useRef<HTMLInputElement | null>(null);
  // The input keeps its own files, so a page that clears the value (null, or an empty list) has to clear it too.
  const cleared = props.multiple ? props.value.length === 0 : props.value === null;
  useEffect(() => {
    if (cleared && own.current && own.current.value !== '') own.current.value = '';
  }, [cleared]);
  const chosen = props.value;
  const names = Array.isArray(chosen) ? chosen.map((file) => file.name) : chosen ? [chosen.name] : [];
  const said = names.join(', ');
  return (
    <Field {...frameOf(props)}>
      {(control) => (
        <div className="field-file">
          {/* The browser's input, clipped and not removed: it is the control the label names and the keyboard reaches. */}
          <input
            {...control}
            ref={(node) => {
              own.current = node;
              if (typeof props.inputRef === 'function') props.inputRef(node);
              else if (props.inputRef) props.inputRef.current = node;
            }}
            className="field-file-input"
            type="file"
            name={props.name}
            accept={props.accept}
            disabled={props.disabled}
            multiple={props.multiple === true}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              const details = changeDetails('file-pick', e);
              if (props.multiple === true) props.onChange(files, details);
              else props.onChange(files[0] ?? null, details);
            }}
          />
          {/* The pointer's way to it: out of the tab order and the tree, the input being the one control for both. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className={buttonClass({ intent: 'secondary', className: 'field-file-button' })}
            disabled={props.disabled}
            onClick={() => own.current?.click()}
          >
            {props.chooseLabel ?? (props.multiple ? 'Choose files' : 'Choose file')}
          </button>
          <span className={`field-file-names${names.length ? '' : ' is-none'}`} title={said || undefined}>
            {said || (props.noneLabel ?? 'No file chosen')}
          </span>
        </div>
      )}
    </Field>
  );
}
