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
import { useSurfaceSeam } from './internal/surfaceSeam.js';
import { slotted } from './internal/uiKitContext.js';

interface FileFieldBase extends FieldFrame {
  /** What the picker offers, as the input's `accept`: `.csv`, `text/csv`, `image/*`, separated by commas. */
  accept?: string;
  name?: string;
  disabled?: boolean;
  ref?: Ref<HTMLInputElement>;
  /** The button's words, in the caller's language: "Choose file" ("Choose files" with `multiple`) unless said. */
  chooseLabel?: string;
  /** What the names say while there is no file: "No file chosen". */
  noneLabel?: string;
  /** Localized strings for FileField controls. */
  words?: { chooseFile?: string; chooseFiles?: string; noFileChosen?: string };
}

/** Props for single-file or multi-file `FileField`. */
export type FileFieldProps = FileFieldBase &
  (
    | {
        multiple?: false;
        /** The chosen file; null while there is none. Set it to null to clear the choice. */
        value: File | null;
        onValueChange?: (file: File | null, details: ChangeDetails<'file-pick'>) => void;
      }
    | {
        multiple: true;
        /** The chosen files; empty while there are none. Set it to `[]` to clear the choice. */
        value: readonly File[];
        onValueChange?: (files: File[], details: ChangeDetails<'file-pick'>) => void;
      }
  );

function DefaultFileField(props: FileFieldProps): ReactNode {
  const seam = useSurfaceSeam();
  const seamWords = seam?.defaultWords?.();
  const own = useRef<HTMLInputElement | null>(null);
  const cleared = props.multiple ? props.value.length === 0 : props.value === null;
  useEffect(() => {
    if (cleared && own.current && own.current.value !== '') own.current.value = '';
  }, [cleared]);
  const chosen = props.value;
  const names = Array.isArray(chosen) ? chosen.map((file) => file.name) : chosen ? [(chosen as File).name] : [];
  const said = names.join(', ');
  const targetRef = props.ref ?? (props as { inputRef?: Ref<HTMLInputElement> }).inputRef;
  return (
    <Frame {...props}>
      <div data-slot="file-field">
        <FieldControl
          id={props.id}
          ref={(node: HTMLInputElement | null) => {
            own.current = node;
            if (typeof targetRef === 'function') targetRef(node);
            else if (targetRef) (targetRef as { current: HTMLInputElement | null }).current = node;
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
            if (props.multiple === true) {
              const legacy = (props as { onChange?: (files: File[], details: ChangeDetails<'file-pick'>) => void }).onChange;
              props.onValueChange?.(files, details);
              legacy?.(files, details);
            } else {
              const first = files[0] ?? null;
              const legacy = (props as { onChange?: (file: File | null, details: ChangeDetails<'file-pick'>) => void }).onChange;
              props.onValueChange?.(first, details);
              legacy?.(first, details);
            }
          }}
        />
        <Button
          type="button"
          data-kind="file"
          tabIndex={-1}
          aria-hidden="true"
          disabled={props.disabled}
          onClick={() => own.current?.click()}
        >
          {props.chooseLabel ??
            (props.multiple
              ? (props.words?.chooseFiles ?? seamWords?.chooseFiles ?? 'Choose files')
              : (props.words?.chooseFile ?? seamWords?.chooseFile ?? 'Choose file'))}
        </Button>
        <span data-slot="file-field-names" data-none={names.length ? undefined : ''} title={said || undefined}>
          {said || (props.noneLabel ?? props.words?.noFileChosen ?? seamWords?.noFileChosen ?? 'No file chosen')}
        </span>
      </div>
    </Frame>
  );
}

/** Accessible browser file picker field with themed trigger button and selected file readout. */
export const FileField = slotted('FileField', DefaultFileField, { onValueChange: [1, 'file-pick'] });
