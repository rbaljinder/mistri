import { Check } from '@phosphor-icons/react';
import {
  Select as Listbox,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@ui-sdk/react/select';
import { useId, useRef, type ComponentProps } from 'react';
import type { UiKitSlots } from '@mistriwork/ui/UiKit.js';
import { useDialogContainer } from './container';
import { Frame } from './Frame';
import { told } from './told';

type DropdownProps = ComponentProps<UiKitSlots['Dropdown']>;
type MultiDropdownProps = ComponentProps<UiKitSlots['MultiDropdown']>;
type Base = Omit<DropdownProps, 'value' | 'onChange'>;

/* A value no option could carry, so an action's row is told apart from an option's. */
const ACTION = '~~action:';

/* The listbox, one choice or several. The button is a button to a reader, as mistri's own is, where UI SDK's
   trigger calls itself a combobox; the role is said on the element handed to `render`, which is the one place a
   part's role gives way. Actions ride under a rule and run rather than become the value. */
function List(
  props: Base &
    (
      | { multiple?: false; value: string; onChange: DropdownProps['onChange'] }
      | { multiple: true; value: string[]; onChange: MultiDropdownProps['onChange'] }
    ),
) {
  const { items, actions = [] } = props;
  const root = useRef<HTMLSpanElement>(null);
  const container = useDialogContainer(root);
  const chosen = props.multiple ? props.value : props.value === '' ? [] : [props.value];
  const known = items.filter((item) => chosen.includes(item.value));
  const run = (value: unknown, details: { cancel(): void }): boolean => {
    const picked = [value].flat().find((one) => typeof one === 'string' && one.startsWith(ACTION));
    if (typeof picked !== 'string') return false;
    details.cancel();
    actions[Number(picked.slice(ACTION.length))]?.onSelect();
    return true;
  };
  const trigger = (
    <SelectTrigger
      render={<button type="button" role="button" />}
      id={props.id}
      ref={props.buttonRef}
      className={props.buttonClassName}
      aria-label={props.ariaLabelledBy ? undefined : props.ariaLabel}
      aria-labelledby={props.ariaLabelledBy}
      aria-describedby={props.ariaDescribedBy}
      aria-invalid={props.ariaInvalid || undefined}
    >
      <SelectValue id={props.valueId} className={props.valueClassName} data-placeholder={known.length ? undefined : ''}>
        {known.length ? known.map((item) => item.label).join(', ') : (props.placeholder ?? '—')}
      </SelectValue>
    </SelectTrigger>
  );
  const content = (
    <SelectContent ref={props.popupRef} className={props.listClassName} container={container}>
      {items.map((item) => (
        <SelectItem key={item.value} value={item.value} disabled={item.disabled} data-tone={item.tone}>
          {props.multiple && (
            <SelectItemIndicator keepMounted>
              <Check aria-hidden="true" weight="bold" />
            </SelectItemIndicator>
          )}
          {item.swatches?.length ? (
            <span data-slot="swatches" aria-hidden="true">
              {item.swatches.map((colour) => (
                <span key={colour} style={{ background: colour }} />
              ))}
            </span>
          ) : null}
          <span data-slot="option-label">{item.label}</span>
          {item.detail ? <span data-slot="option-detail">{item.detail}</span> : null}
          {item.badge ? <span data-slot="option-badge">{item.badge}</span> : null}
        </SelectItem>
      ))}
      {actions.length ? <SelectSeparator /> : null}
      {actions.map((action, index) => (
        <SelectItem key={action.label} value={`${ACTION}${index}`} data-kind="action">
          {action.label}
        </SelectItem>
      ))}
    </SelectContent>
  );
  const open =
    props.onOpenChange && ((next: boolean, details: Parameters<typeof told>[1]) => props.onOpenChange?.(next, told('implicit', details)));
  return (
    <span ref={root} data-slot="dropdown">
      {props.multiple ? (
        <Listbox
          multiple
          value={props.value}
          disabled={props.disabled}
          readOnly={props.readOnly}
          onOpenChange={open}
          onValueChange={(next, details) => {
            if (run(next, details)) return;
            const picked = next.map(String);
            // Kept in the items' order, whatever order they were chosen in.
            props.onChange(
              items.map((item) => item.value).filter((value) => picked.includes(value)),
              told('item-press', details),
            );
          }}
        >
          {trigger}
          {content}
        </Listbox>
      ) : (
        <Listbox
          value={known[0]?.value ?? null}
          disabled={props.disabled}
          readOnly={props.readOnly}
          onOpenChange={open}
          onValueChange={(next, details) => {
            if (run(next, details)) return;
            props.onChange(next === null ? '' : String(next), told('item-press', details));
          }}
        >
          {trigger}
          {content}
        </Listbox>
      )}
    </span>
  );
}

export const Dropdown: UiKitSlots['Dropdown'] = (props) => <List {...props} />;
export const MultiDropdown: UiKitSlots['MultiDropdown'] = (props) => <List {...props} multiple />;

/* The listbox of a form: the list in a field's frame. The button is named by the field's label and its own
   value both, so a reader hears "Stage, High". */
export const Select: UiKitSlots['Select'] = (props) => {
  const id = useId();
  return (
    <Frame {...props}>
      <FieldList frame={props} labelId={`${id}-label`}>
        {(names) => (
          <List
            items={props.options}
            value={props.value}
            onChange={props.onChange}
            id={props.id}
            ariaLabelledBy={names}
            valueId={`${id}-value`}
            buttonRef={props.buttonRef}
            placeholder={props.placeholder}
            disabled={props.disabled}
          />
        )}
      </FieldList>
    </Frame>
  );
};

export const MultiSelect: UiKitSlots['MultiSelect'] = (props) => {
  const id = useId();
  return (
    <Frame {...props}>
      <FieldList frame={props} labelId={`${id}-label`}>
        {(names) => (
          <List
            multiple
            items={props.options}
            value={props.value}
            onChange={props.onChange}
            id={props.id}
            ariaLabelledBy={names}
            valueId={`${id}-value`}
            buttonRef={props.buttonRef}
            placeholder={props.placeholder}
            disabled={props.disabled}
          />
        )}
      </FieldList>
    </Frame>
  );
};

/* UI SDK's Field names the button by the label on its own; this only leaves the naming to it. */
function FieldList({ children }: { frame: unknown; labelId: string; children: (names: string | undefined) => React.ReactNode }) {
  return <>{children(undefined)}</>;
}
