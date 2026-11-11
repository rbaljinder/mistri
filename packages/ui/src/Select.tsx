/**
 * The listbox of a form: one choice, or several, in a field. It is the Dropdown (Base UI's Select) dressed as a field
 * box, so the keyboard is the one it has: ArrowDown opens it, the arrows move, Enter and Space choose, Escape closes and
 * returns focus to the box. Props only. Preview: @mistriwork/ui is Preview at 1.0.
 */
import { useId, type ReactNode, type Ref } from 'react';
import { Dropdown, MultiDropdown, type DropdownItem } from './Dropdown.js';
import { Field } from './Field.js';
import { frameOf, type FieldFrame } from './fieldFrame.js';
import { slotted } from './internal/uiKitContext.js';

interface ListFrame extends FieldFrame {
  options: DropdownItem[];
  /** What the box says while nothing is chosen ("Choose"). */
  placeholder?: string;
  disabled?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
}

/** One choice from a list, under a field box. */
function DefaultSelect(props: ListFrame & { value: string; onChange: (value: string) => void }): ReactNode {
  const valueId = useId();
  return (
    <Field {...frameOf(props)} group>
      {(control) => (
        <Dropdown
          items={props.options}
          value={props.value}
          onChange={props.onChange}
          id={control.id}
          ariaLabelledBy={`${control['aria-labelledby']} ${valueId}`}
          ariaDescribedBy={control['aria-describedby']}
          ariaInvalid={control['aria-invalid']}
          valueId={valueId}
          buttonClassName="field-control field-select"
          listClassName="field-list"
          buttonRef={props.buttonRef}
          placeholder={props.placeholder}
          disabled={props.disabled}
        />
      )}
    </Field>
  );
}

/** Several choices, each with a checkbox; the closed box says them as "Acura, Alfa Romeo". */
function DefaultMultiSelect(props: ListFrame & { value: string[]; onChange: (value: string[]) => void }): ReactNode {
  const valueId = useId();
  return (
    <Field {...frameOf(props)} group>
      {(control) => (
        <MultiDropdown
          items={props.options}
          value={props.value}
          onChange={props.onChange}
          id={control.id}
          ariaLabelledBy={`${control['aria-labelledby']} ${valueId}`}
          ariaDescribedBy={control['aria-describedby']}
          ariaInvalid={control['aria-invalid']}
          valueId={valueId}
          buttonClassName="field-control field-select"
          listClassName="field-list"
          buttonRef={props.buttonRef}
          placeholder={props.placeholder}
          disabled={props.disabled}
        />
      )}
    </Field>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Select = slotted('Select', DefaultSelect);
export const MultiSelect = slotted('MultiSelect', DefaultMultiSelect);
