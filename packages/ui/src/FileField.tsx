/**
 * A file chosen in the browser, handed to the page as a `File` (or null): for a page that reads a file before any
 * command runs, a CSV parsed and shown, say. It is drawn as the look draws a control, the kit's button and the chosen
 * names beside it, not the browser's grey "Choose Files"; underneath it is still the browser's own input (hidden
 * visually, never removed), so the label, hint and problem are wired in as they are for a text box, and the keyboard
 * (Tab to it, Enter or Space) and the file dialog are the platform's. A command's form has `field.file`, which sends
 * the bytes; this sends nothing. Props only. Preview: @mistriwork/ui is Preview at 1.0.
 */
import { Button } from '@ui-sdk/react/button';
import { FieldControl } from '@ui-sdk/react/field';
import { useEffect, useRef, type ChangeEvent, type ReactNode, type Ref } from 'react';
import { changeDetails, type ChangeDetails } from './changeDetails.js';
import type { FieldFrame } from './fieldFrame.js';
import { Frame } from './internal/Frame.js';
import { slotted } from './internal/uiKitContext.js';

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

function DefaultFileField(props: FileFieldProps): ReactNode {
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
    <Frame {...props}>
      <div data-slot="file-field">
        {/* The browser's input, clipped and not removed: it is the control the label names and the keyboard reaches. It
            is the field's control part, so the field hands it its id, its description and `aria-invalid` as it does a
            control of UI SDK's. */}
        <FieldControl
          id={props.id}
          ref={(node: HTMLInputElement | null) => {
            own.current = node;
            if (typeof props.inputRef === 'function') props.inputRef(node);
            else if (props.inputRef) props.inputRef.current = node;
          }}
          data-kind="file"
          type="file"
          name={props.name}
          accept={props.accept}
          disabled={props.disabled}
          multiple={props.multiple === true}
          aria-required={props.required || undefined}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files ?? []);
            const details = changeDetails('file-pick', event);
            if (props.multiple === true) props.onChange(files, details);
            else props.onChange(files[0] ?? null, details);
          }}
        />
        {/* The pointer's way to it: out of the tab order and the tree, the input being the one control for both. */}
        <Button
          type="button"
          data-kind="file"
          tabIndex={-1}
          aria-hidden="true"
          disabled={props.disabled}
          onClick={() => own.current?.click()}
        >
          {props.chooseLabel ?? (props.multiple ? 'Choose files' : 'Choose file')}
        </Button>
        <span data-slot="file-field-names" data-none={names.length ? undefined : ''} title={said || undefined}>
          {said || (props.noneLabel ?? 'No file chosen')}
        </span>
      </div>
    </Frame>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const FileField = slotted('FileField', DefaultFileField, { onChange: [1, 'file-pick'] });
