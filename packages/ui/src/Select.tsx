/**
 * The listbox of a form: one choice, or several, in a field. It is the Dropdown (UI SDK's Select) in a field's frame,
 * so the keyboard is the one it has: ArrowDown opens it, the arrows move, Enter and Space choose, Escape closes and
 * returns focus to the box. Props only. Preview: @mistriwork/ui is Preview at 1.0.
 */
import { useFieldControl } from '@ui-sdk/react/field';
import { useId, type ReactNode, type Ref } from 'react';
import { Dropdown, MultiDropdown, type DropdownChange, type DropdownItem } from './Dropdown.js';
import type { FieldFrame } from './fieldFrame.js';
import { Frame } from './internal/Frame.js';
import { slotted } from './internal/uiKitContext.js';

interface ListFrame extends FieldFrame {
  options: DropdownItem[];
  /** What the box says while nothing is chosen ("Choose"). */
  placeholder?: string;
  disabled?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
}

/* What the field this stands in says of its control: the label's id, what describes it and whether it holds a
   problem. The frame's field names its control by that label alone and wires the hint, the problem and validity to
   it; a list's button is named by the label and then by what it shows, so a reader hears "Make, Alfa Romeo". The
   description and the validity are handed on as the Dropdown's own props, and not left to UI SDK's field to wire,
   because the Dropdown is a slot: a kit that draws only the Dropdown is not inside UI SDK's field and would hear
   neither. */
interface Wiring {
  label?: string;
  describedBy?: string;
  invalid?: boolean;
}
function Wired({ children }: { children: (field: Wiring) => ReactNode }) {
  const said = useFieldControl()?.props({}) as Record<string, unknown> | undefined;
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  return (
    <>
      {children({
        label: text(said?.['aria-labelledby']),
        describedBy: text(said?.['aria-describedby']),
        invalid: said?.['aria-invalid'] === true || said?.['aria-invalid'] === 'true' || undefined,
      })}
    </>
  );
}

/** One choice from a list, under a field box. */
function DefaultSelect(props: ListFrame & { value: string; onChange: (value: string, details: DropdownChange) => void }): ReactNode {
  const valueId = useId();
  return (
    <Frame {...props}>
      <Wired>
        {({ label, describedBy, invalid }) => (
          <Dropdown
            items={props.options}
            value={props.value}
            onChange={props.onChange}
            id={props.id}
            ariaLabelledBy={label && `${label} ${valueId}`}
            ariaDescribedBy={describedBy}
            ariaInvalid={invalid}
            valueId={valueId}
            buttonRef={props.buttonRef}
            placeholder={props.placeholder}
            disabled={props.disabled}
          />
        )}
      </Wired>
    </Frame>
  );
}

/** Several choices, each with a checkbox; the closed box says them as "Acura, Alfa Romeo". */
function DefaultMultiSelect(
  props: ListFrame & { value: string[]; onChange: (value: string[], details: DropdownChange) => void },
): ReactNode {
  const valueId = useId();
  return (
    <Frame {...props}>
      <Wired>
        {({ label, describedBy, invalid }) => (
          <MultiDropdown
            items={props.options}
            value={props.value}
            onChange={props.onChange}
            id={props.id}
            ariaLabelledBy={label && `${label} ${valueId}`}
            ariaDescribedBy={describedBy}
            ariaInvalid={invalid}
            valueId={valueId}
            buttonRef={props.buttonRef}
            placeholder={props.placeholder}
            disabled={props.disabled}
          />
        )}
      </Wired>
    </Frame>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Select = slotted('Select', DefaultSelect, { onChange: [1, 'item-press'] });
export const MultiSelect = slotted('MultiSelect', DefaultMultiSelect, { onChange: [1, 'item-press'] });
