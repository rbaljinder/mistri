/**
 * The listbox of a form: one choice, or several, in a field (or standalone when `label` is omitted). It is the
 * Dropdown (UI SDK's Select) in a field's frame, so the keyboard is the one it has: ArrowDown opens it, the arrows
 * move, Enter and Space choose, Escape closes and returns focus to the box. Props only.
 */
import { useFieldControl } from '@ui-sdk/react/field';
import { useId, type ReactNode, type Ref } from 'react';
import { Dropdown, MultiDropdown, type DropdownChange, type DropdownItem } from './Dropdown.js';
import type { FieldFrame } from './fieldFrame.js';
import type { ControlSize } from './internal/cx.js';
import { Frame } from './internal/Frame.js';
import { slotted } from './internal/uiKitContext.js';

/** Option item descriptor for `Select` and `MultiSelect`. */
export type SelectOption<T extends string = string> = Omit<DropdownItem, 'value'> & {
  value: T;
  icon?: ReactNode;
  description?: string;
};

interface BaseSelectFrame<T extends string = string> extends Omit<FieldFrame, 'label'> {
  label?: ReactNode;
  options: readonly SelectOption<T>[];
  /** What the box says while nothing is chosen ("Choose"). */
  placeholder?: string;
  disabled?: boolean;
  size?: ControlSize;
  ariaLabel?: string;
  'aria-labelledby'?: string;
  triggerClassName?: string;
  ref?: Ref<HTMLButtonElement>;
}

/** Props for single-choice `Select`. */
export interface SelectProps<T extends string = string> extends BaseSelectFrame<T> {
  value?: T | null;
  onValueChange?: (value: T, details: DropdownChange) => void;
}

/** Props for multi-choice `MultiSelect`. */
export interface MultiSelectProps<T extends string = string> extends BaseSelectFrame<T> {
  value: readonly T[];
  onValueChange?: (value: T[], details: DropdownChange) => void;
}

interface Wiring {
  id?: string;
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
        id: text(said?.id),
        label: text(said?.['aria-labelledby']),
        describedBy: text(said?.['aria-describedby']),
        invalid: said?.['aria-invalid'] === true || said?.['aria-invalid'] === 'true' || undefined,
      })}
    </>
  );
}

function normalizeOptions<T extends string>(options: readonly SelectOption<T>[]): DropdownItem[] {
  return options.map((opt) => ({
    ...opt,
    detail: opt.detail ?? opt.description,
  }));
}

/** One choice from a list, under a field box or standalone. */
function DefaultSelect<T extends string = string>(props: SelectProps<T>): ReactNode {
  const valueId = useId();
  const items = normalizeOptions(props.options);
  const legacyChange = (props as { onChange?: (value: T, details: DropdownChange) => void }).onChange;
  const legacyAriaLabel = (props as unknown as Record<string, unknown>)['aria-label'] as string | undefined;
  const legacyRef = (props as { buttonRef?: Ref<HTMLButtonElement> }).buttonRef;
  const targetRef = props.ref ?? legacyRef;
  const handleChange = (next: string, details: DropdownChange) => {
    props.onValueChange?.(next as T, details);
    legacyChange?.(next as T, details);
  };
  const resolvedAriaLabel = props.ariaLabel ?? legacyAriaLabel;
  if (props.label === undefined) {
    return (
      <Wired>
        {({ id: fieldId, label, describedBy, invalid }) => {
          const inheritField = !resolvedAriaLabel && !props['aria-labelledby'];
          return (
            <Dropdown
              items={items}
              value={props.value ?? ''}
              onValueChange={handleChange}
              id={props.id ?? (inheritField ? fieldId : undefined)}
              ariaLabel={resolvedAriaLabel}
              ariaLabelledBy={props['aria-labelledby'] ?? (inheritField && label ? `${label} ${valueId}` : undefined)}
              ariaDescribedBy={inheritField ? describedBy : undefined}
              ariaInvalid={Boolean(props.problem) || (inheritField ? invalid : undefined)}
              valueId={valueId}
              ref={targetRef}
              buttonClassName={props.triggerClassName ?? props.className}
              placeholder={props.placeholder}
              disabled={props.disabled}
            />
          );
        }}
      </Wired>
    );
  }
  return (
    <Frame {...props} label={props.label}>
      <Wired>
        {({ id: fieldId, label, describedBy, invalid }) => (
          <Dropdown
            items={items}
            value={props.value ?? ''}
            onValueChange={handleChange}
            id={props.id ?? fieldId}
            ariaLabelledBy={label && `${label} ${valueId}`}
            ariaDescribedBy={describedBy}
            ariaInvalid={invalid}
            valueId={valueId}
            ref={targetRef}
            buttonClassName={props.triggerClassName}
            placeholder={props.placeholder}
            disabled={props.disabled}
          />
        )}
      </Wired>
    </Frame>
  );
}

/** Several choices, each with a checkbox; the closed box says them as "Acura, Alfa Romeo". */
function DefaultMultiSelect<T extends string = string>(props: MultiSelectProps<T>): ReactNode {
  const valueId = useId();
  const items = normalizeOptions(props.options);
  const legacyChange = (props as { onChange?: (value: T[], details: DropdownChange) => void }).onChange;
  const legacyAriaLabel = (props as unknown as Record<string, unknown>)['aria-label'] as string | undefined;
  const legacyRef = (props as { buttonRef?: Ref<HTMLButtonElement> }).buttonRef;
  const targetRef = props.ref ?? legacyRef;
  const handleChange = (next: string[], details: DropdownChange) => {
    props.onValueChange?.(next as T[], details);
    legacyChange?.(next as T[], details);
  };
  const resolvedAriaLabel = props.ariaLabel ?? legacyAriaLabel;
  if (props.label === undefined) {
    return (
      <Wired>
        {({ id: fieldId, label, describedBy, invalid }) => {
          const inheritField = !resolvedAriaLabel && !props['aria-labelledby'];
          return (
            <MultiDropdown
              items={items}
              value={props.value}
              onValueChange={handleChange}
              id={props.id ?? (inheritField ? fieldId : undefined)}
              ariaLabel={resolvedAriaLabel}
              ariaLabelledBy={props['aria-labelledby'] ?? (inheritField && label ? `${label} ${valueId}` : undefined)}
              ariaDescribedBy={inheritField ? describedBy : undefined}
              ariaInvalid={Boolean(props.problem) || (inheritField ? invalid : undefined)}
              valueId={valueId}
              ref={targetRef}
              buttonClassName={props.triggerClassName ?? props.className}
              placeholder={props.placeholder}
              disabled={props.disabled}
            />
          );
        }}
      </Wired>
    );
  }
  return (
    <Frame {...props} label={props.label}>
      <Wired>
        {({ id: fieldId, label, describedBy, invalid }) => (
          <MultiDropdown
            items={items}
            value={props.value}
            onValueChange={handleChange}
            id={props.id ?? fieldId}
            ariaLabelledBy={label && `${label} ${valueId}`}
            ariaDescribedBy={describedBy}
            ariaInvalid={invalid}
            valueId={valueId}
            ref={targetRef}
            buttonClassName={props.triggerClassName}
            placeholder={props.placeholder}
            disabled={props.disabled}
          />
        )}
      </Wired>
    </Frame>
  );
}

/** Framed or standalone single-choice listbox control over `Dropdown`. */
export const Select = slotted('Select', DefaultSelect, {
  onValueChange: [1, 'item-press'],
}) as typeof DefaultSelect;

/** Framed or standalone multi-choice listbox control over `MultiDropdown`. */
export const MultiSelect = slotted('MultiSelect', DefaultMultiSelect, {
  onValueChange: [1, 'item-press'],
}) as typeof DefaultMultiSelect;
