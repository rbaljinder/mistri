/**
 * A themed listbox, over UI SDK's Select.
 *
 * A native `<select>` cannot be styled where it matters: the open menu is
 * drawn by the operating system, in the system font, with the system
 * highlight colour, ignoring the page entirely. UI SDK gives back what
 * the native one gave for free — arrows move, Home and End jump, Enter and
 * Space choose, Escape closes and returns focus, Tab closes, typing jumps
 * to a matching option, the roles and `aria-expanded` — and this draws it
 * on its parts' slots (`select-trigger`, `select-content`, `select-item`),
 * which the stylesheet dresses.
 *
 * Actions ride under a divider and are walked with the same arrows, but
 * run rather than become the value: the value stays what the caller says
 * it is, so choosing "re-read the schema" cannot select it.
 */
import { useId, useRef, type Ref } from 'react';
import {
  Select as Listbox,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@ui-sdk/react/select';
import { useFieldControl } from '@ui-sdk/react/field';
import type { ChangeDetails } from './changeDetails.js';
import { toDataTone, type Tone } from './internal/cx.js';
import { popupContainer, useDialogContainer } from './internal/popups.js';
import { useSurfaceSeam } from './internal/surfaceSeam.js';
import { told } from './internal/told.js';
import { slotted } from './internal/uiKitContext.js';

/** Option item descriptor for `Dropdown` and `MultiDropdown`. */
export interface DropdownItem {
  value: string;
  label: string;
  detail?: string;
  badge?: string;
  disabled?: boolean;
  /** Semantic tone colouring the option's label. */
  tone?: Tone;
  swatches?: string[];
}

/** Change details reported when a `Dropdown` or `MultiDropdown` value moves. */
export type DropdownChange = ChangeDetails<'item-press' | 'autofill' | 'sync'>;

interface DropdownBase {
  items: readonly DropdownItem[];
  /** What a reader hears the list called; falls back to the host seam's `select` word when unnamed. */
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  /** The caption that names the button, where it is drawn beside it (a field's label, "(required)" and all); `ariaLabel` gives way to it. */
  ariaLabelledBy?: string;
  /** The button's id, so a field's `<label for>` names it (components/Field.tsx). */
  id?: string;
  /** Ref forwarded to the trigger `<button>` element. */
  ref?: Ref<HTMLButtonElement>;
  popupRef?: Ref<HTMLDivElement>;
  onOpenChange?: (
    open: boolean,
    details: ChangeDetails<
      | 'trigger-press'
      | 'outside-press'
      | 'escape-key'
      | 'window-resize'
      | 'item-press'
      | 'focus-out'
      | 'list-navigation'
      | 'cancel-open'
      | 'implicit'
    >,
  ) => void;
  disabled?: boolean;
  readOnly?: boolean;
  /** Wrapper class name on the `[data-slot="dropdown"]` container. */
  className?: string;
  /** A class on the shown value — a page title that is also a picker. */
  valueClassName?: string;
  /** Things to do rather than pick, listed under a divider — "re-read the schema" beneath the databases. */
  actions?: readonly DropdownAction[];
  /** Classes on the button beside `dd-button`: a form's field wears `field-control` through it. */
  buttonClassName?: string;
  /** Classes on the list beside `dd-list`. */
  listClassName?: string;
  /** The id of the shown value, so a form can name the button by its label and its value both. */
  valueId?: string;
  /** What the button says while nothing is chosen (a form's "Choose"); without it an empty list says a dash. */
  placeholder?: string;
}

/** Props for single-value `Dropdown`. */
export type DropdownProps = DropdownBase & {
  value: string;
  onValueChange?: (value: string, details: DropdownChange) => void;
};

/** Props for multi-value `MultiDropdown`. */
export type MultiDropdownProps = DropdownBase & {
  value: readonly string[];
  onValueChange?: (value: string[], details: DropdownChange) => void;
};

type DropdownInput = DropdownBase &
  (
    | { multiple?: false; value: string; onValueChange?: (value: string, details: DropdownChange) => void }
    | { multiple: true; value: readonly string[]; onValueChange?: (value: string[], details: DropdownChange) => void }
  );

/** Non-selectable command row rendered beneath a separator inside `Dropdown`. */
export interface DropdownAction {
  label: string;
  onSelect: () => void;
}

/* A value no option could carry, so an action's row is told apart from an option's. */
const ACTION = '~~action:';

function DefaultDropdown(props: DropdownProps) {
  return <DropdownList {...props} />;
}

/** The same listbox choosing several: it stays open while it is chosen from, and the button says the choices. */
function DefaultMultiDropdown(props: MultiDropdownProps) {
  return <DropdownList {...props} multiple />;
}

/* Why the list opened or closed: UI SDK's own word where it is one this callback's type lists, `implicit` for the
   ones it has that no caller here reads (the window losing focus, a swipe, the page's own call). */
const OPENS = new Set(['trigger-press', 'outside-press', 'escape-key', 'item-press', 'focus-out', 'list-navigation'] as const);
type OpenReason = typeof OPENS extends Set<infer Word> ? Word | 'implicit' : never;
const openReason = (said: string | undefined): OpenReason => (said && (OPENS as Set<string>).has(said) ? (said as OpenReason) : 'implicit');

/* UI SDK's word for why the value moved, in the three a caller here can hear. `restore` is the browser putting a
   form's values back (history, autofill); everything else that is not a press follows something else. */
const changeReason = (said: string | undefined): 'item-press' | 'autofill' | 'sync' =>
  said === 'item-press' ? 'item-press' : said === 'restore' ? 'autofill' : 'sync';

/* The mark beside a chosen option of several. */
const Tick = () => (
  <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M3 8.5l3.25 3.25L13 4.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Swatches({ colours }: { colours: string[] }) {
  return (
    <span data-slot="swatches" aria-hidden="true">
      {colours.map((colour, index) => (
        <span key={index} style={{ background: colour }} />
      ))}
    </span>
  );
}

/* The listbox, one choice or several. The button is a button to a reader, as it has always been announced, where
   UI SDK's trigger calls itself a combobox: the role is said on the element handed to `render`, which is the one
   place a part's role gives way. */
function DropdownList(props: DropdownInput) {
  const { items, actions = [] } = props;
  const seam = useSurfaceSeam();
  const root = useRef<HTMLSpanElement>(null);
  const dialog = useDialogContainer(root);
  const chosen = props.multiple === true ? (props.value ?? []) : [props.value];
  const known = items.filter((item) => chosen.includes(item.value));
  const run = (value: unknown, details: { cancel(): void }): boolean => {
    const picked = [value].flat().find((one) => typeof one === 'string' && one.startsWith(ACTION));
    if (typeof picked !== 'string') return false;
    details.cancel();
    actions[Number(picked.slice(ACTION.length))]?.onSelect();
    return true;
  };
  const made = useId();
  const fieldProps = useFieldControl()?.props({}) as Record<string, unknown> | undefined;
  const inheritFieldLabel = !props.ariaLabel && !props.ariaLabelledBy;
  const fieldId = inheritFieldLabel && typeof fieldProps?.id === 'string' && fieldProps.id ? fieldProps.id : undefined;
  const fieldLabelledBy =
    inheritFieldLabel && typeof fieldProps?.['aria-labelledby'] === 'string' && fieldProps['aria-labelledby']
      ? fieldProps['aria-labelledby']
      : undefined;
  const fieldInvalid = fieldProps?.['aria-invalid'] === true || fieldProps?.['aria-invalid'] === 'true';
  const effectiveAriaLabel = props.ariaLabel ?? (!props.ariaLabelledBy && !fieldLabelledBy ? seam?.defaultWords?.().select : undefined);
  const buttonId = props.id ?? fieldId ?? `dropdown-${made}`;
  const shownId = props.valueId ?? `${buttonId}-value`;
  const effectiveLabelledBy =
    props.ariaLabelledBy ?? (fieldLabelledBy ? `${fieldLabelledBy} ${shownId}` : effectiveAriaLabel ? `${buttonId} ${shownId}` : undefined);
  const label = (props.ariaLabelledBy ?? fieldLabelledBy)?.split(' ')[0];
  const first = props.multiple === true ? undefined : known[0];
  const wired = fieldProps?.['aria-describedby'];
  const described = props.ariaDescribedBy && props.ariaDescribedBy === wired ? undefined : props.ariaDescribedBy;
  const triggerRef = props.ref ?? (props as { buttonRef?: Ref<HTMLButtonElement> }).buttonRef;
  const trigger = (
    <SelectTrigger
      render={<button type="button" role="button" />}
      id={buttonId}
      ref={triggerRef}
      className={props.buttonClassName}
      aria-label={props.ariaLabelledBy || fieldLabelledBy ? undefined : effectiveAriaLabel}
      aria-labelledby={effectiveLabelledBy}
      aria-describedby={described}
      aria-invalid={props.ariaInvalid || fieldInvalid || undefined}
      title={first?.detail}
    >
      {first?.swatches?.length ? <Swatches colours={first.swatches} /> : null}
      <SelectValue id={shownId} className={props.valueClassName} data-placeholder={known.length ? undefined : ''}>
        {known.length ? known.map((item) => item.label).join(', ') : (props.placeholder ?? '—')}
      </SelectValue>
    </SelectTrigger>
  );
  const content = (
    <SelectContent
      ref={props.popupRef}
      className={props.listClassName}
      container={dialog ?? popupContainer()}
      render={(drawn) => <div {...drawn} aria-label={effectiveAriaLabel} aria-labelledby={effectiveAriaLabel ? undefined : label} />}
    >
      {items.map((item) => (
        <SelectItem key={item.value} value={item.value} label={item.label} disabled={item.disabled} data-tone={toDataTone(item.tone)}>
          {props.multiple === true && (
            <SelectItemIndicator keepMounted>
              <Tick />
            </SelectItemIndicator>
          )}
          {item.swatches?.length ? <Swatches colours={item.swatches} /> : null}
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
    props.onOpenChange &&
    ((next: boolean, details: Parameters<typeof told>[1] & { reason?: string }) =>
      props.onOpenChange?.(next, told(openReason(details?.reason), details)));
  return (
    <span ref={root} data-slot="dropdown" className={props.className || undefined}>
      {props.multiple === true ? (
        <Listbox
          multiple
          value={[...(props.value ?? [])]}
          disabled={props.disabled}
          readOnly={props.readOnly}
          onOpenChange={open}
          onValueChange={(next, details) => {
            if (run(next, details)) return;
            const picked = next.map(String);
            const ordered = items.map((item) => item.value).filter((value) => picked.includes(value));
            const info = told(changeReason(details.reason), details);
            const legacy = (props as { onChange?: (value: string[], details: DropdownChange) => void }).onChange;
            props.onValueChange?.(ordered, info);
            legacy?.(ordered, info);
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
            const chosenValue = next === null ? '' : String(next);
            const info = told(changeReason(details.reason), details);
            const legacy = (props as { onChange?: (value: string, details: DropdownChange) => void }).onChange;
            props.onValueChange?.(chosenValue, info);
            legacy?.(chosenValue, info);
          }}
        >
          {trigger}
          {content}
        </Listbox>
      )}
    </span>
  );
}

const DROPDOWN_FILLS = { onValueChange: [1, 'item-press'], onOpenChange: [1, 'implicit'] } as const;

/** Accessible single-select listbox popup with keyboard typeahead, swatches, and trailing actions. */
export const Dropdown = slotted('Dropdown', DefaultDropdown, DROPDOWN_FILLS);

/** Accessible multi-select listbox popup preserving item order and check indicators. */
export const MultiDropdown = slotted('MultiDropdown', DefaultMultiDropdown, DROPDOWN_FILLS);
