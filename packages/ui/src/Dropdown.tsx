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
import { popupContainer, useDialogContainer } from './internal/popups.js';
import { told } from './internal/told.js';
import { slotted } from './internal/uiKitContext.js';

export interface DropdownItem {
  value: string;
  label: string;
  detail?: string;
  badge?: string;
  disabled?: boolean;
  /** Colours the option's word; the five tones of a display rule. */
  tone?: 'good' | 'warn' | 'bad' | 'info' | 'neutral';
  swatches?: string[];
}

/** Why a dropdown's choice moved: an option pressed (or chosen by key); `autofill`, the browser putting back what the
    hidden field held; or `sync`, every other way the value follows something else: a letter typed on the closed
    button, a form reset, a chosen option that left the list. A `sync` with a key behind it says `keyboard`; with
    nothing behind it, it is the page's own change. */
export type DropdownChange = ChangeDetails<'item-press' | 'autofill' | 'sync'>;

interface DropdownBase {
  items: DropdownItem[];
  /** What a reader hears the list called; the kit's Dropdown supplies its catalog's word where a caller names none. */
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  /** The caption that names the button, where it is drawn beside it (a field's label, "(required)" and all); `ariaLabel` gives way to it. */
  ariaLabelledBy?: string;
  /** The button's id, so a field's `<label for>` names it (components/Field.tsx). */
  id?: string;
  /** The button, for a form that needs to put focus on this control. */
  buttonRef?: Ref<HTMLButtonElement>;
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
  /** A class on the shown value — a page title that is also a picker. */
  valueClassName?: string;
  /** Things to do rather than pick, listed under a divider — "re-read the schema" beneath the databases. */
  actions?: DropdownAction[];
  /** Classes on the button beside `dd-button`: a form's field wears `field-control` through it. */
  buttonClassName?: string;
  /** Classes on the list beside `dd-list`. */
  listClassName?: string;
  /** The id of the shown value, so a form can name the button by its label and its value both. */
  valueId?: string;
  /** What the button says while nothing is chosen (a form's "Choose"); without it an empty list says a dash. */
  placeholder?: string;
}

export type DropdownProps = DropdownBase & { value: string; onChange: (value: string, details: DropdownChange) => void };
/** `MultiDropdown`'s: the list of values taken and given, kept in the items' order. */
export type MultiDropdownProps = DropdownBase & { value: string[]; onChange: (value: string[], details: DropdownChange) => void };
type DropdownInput = DropdownBase &
  (
    | { multiple?: false; value: string; onChange: (value: string, details: DropdownChange) => void }
    | { multiple: true; value: string[]; onChange: (value: string[], details: DropdownChange) => void }
  );

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
  /* Where the list is drawn. A list portalled to the end of the body sits behind a modal <dialog>'s top layer, and
     half the pickers here live in one, so inside a dialog the list is drawn into that dialog and keeps its stacking
     context; elsewhere it goes where every floating surface here does (internal/popups.ts), which an embedded
     shell names for itself. */
  const root = useRef<HTMLSpanElement>(null);
  const dialog = useDialogContainer(root);
  /* Nothing chosen: a value no item carries (a form's empty answer) reads as no selection, not as a stray one. An
     item may itself be the empty value (a sort's "Default order"), and is then the one chosen. */
  const chosen = props.multiple === true ? props.value : [props.value];
  const known = items.filter((item) => chosen.includes(item.value));
  /* An action's row is pressed like an option's, and the press is refused before it becomes the value. */
  const run = (value: unknown, details: { cancel(): void }): boolean => {
    const picked = [value].flat().find((one) => typeof one === 'string' && one.startsWith(ACTION));
    if (typeof picked !== 'string') return false;
    details.cancel();
    actions[Number(picked.slice(ACTION.length))]?.onSelect();
    return true;
  };
  /* A button named only by `ariaLabel` is named by it and then by the value it shows (WCAG 2.5.3, label in name):
     its own label first, the shown value after, as a field's `ariaLabelledBy` names it with `valueId`. */
  const made = useId();
  const buttonId = props.id ?? `dropdown-${made}`;
  const shownId = props.valueId ?? `${buttonId}-value`;
  const label = props.ariaLabelledBy?.split(' ')[0];
  const first = props.multiple === true ? undefined : known[0];
  /* Inside a field UI SDK describes the trigger by the field's hint and problem itself. A Select hands the same
     ids on as props (so a kit's Dropdown hears them too), and saying them twice would list each id twice. */
  const wired = (useFieldControl()?.props({}) as Record<string, unknown> | undefined)?.['aria-describedby'];
  const described = props.ariaDescribedBy && props.ariaDescribedBy === wired ? undefined : props.ariaDescribedBy;
  const trigger = (
    <SelectTrigger
      render={<button type="button" role="button" />}
      id={buttonId}
      ref={props.buttonRef}
      className={props.buttonClassName}
      aria-label={props.ariaLabelledBy ? undefined : props.ariaLabel}
      aria-labelledby={props.ariaLabelledBy ?? (props.ariaLabel ? `${buttonId} ${shownId}` : undefined)}
      aria-describedby={described}
      aria-invalid={props.ariaInvalid || undefined}
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
      // The list is called what the button is, without the value the button also says: UI SDK names it by the
      // whole button, so the name is put on what it draws.
      render={(drawn) => <div {...drawn} aria-label={props.ariaLabel} aria-labelledby={props.ariaLabel ? undefined : label} />}
    >
      {items.map((item) => (
        // Named by its word alone, which is what a letter typed in the list looks for: not its detail and badge too.
        <SelectItem key={item.value} value={item.value} label={item.label} disabled={item.disabled} data-tone={item.tone}>
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
    <span ref={root} data-slot="dropdown">
      {props.multiple === true ? (
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
              told(changeReason(details.reason), details),
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
            props.onChange(next === null ? '' : String(next), told(changeReason(details.reason), details));
          }}
        >
          {trigger}
          {content}
        </Listbox>
      )}
    </span>
  );
}

const DROPDOWN_FILLS = { onChange: [1, 'item-press'], onOpenChange: [1, 'implicit'] } as const;

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Dropdown = slotted('Dropdown', DefaultDropdown, DROPDOWN_FILLS);
export const MultiDropdown = slotted('MultiDropdown', DefaultMultiDropdown, DROPDOWN_FILLS);
