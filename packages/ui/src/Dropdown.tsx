/**
 * A themed listbox, over Base UI's Select.
 *
 * A native `<select>` cannot be styled where it matters: the open menu is
 * drawn by the operating system, in the system font, with the system
 * highlight colour, ignoring the page entirely. Base UI gives back what
 * the native one gave for free — arrows move, Home and End jump, Enter and
 * Space choose, Escape closes and returns focus, Tab closes, typing jumps
 * to a matching option, the roles and `aria-expanded` — and this draws it
 * in the tool's own classes, so the stylesheet and the browser suite see
 * the control they always saw.
 *
 * Actions ride under a divider and are walked with the same arrows, but
 * run rather than become the value: the value stays what the caller says
 * it is, so choosing "re-read the schema" cannot select it.
 */
import { useEffect, useRef, useState, type Ref } from 'react';
import { Select } from '@base-ui/react/select';
import { layoutViewport, zoomAnchor } from './anchor.js';
import { popupContainer } from './popups.js';

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
  onOpenChange?: (open: boolean) => void;
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

export type DropdownProps = DropdownBase & { value: string; onChange: (value: string) => void };
/** `MultiDropdown`'s: the list of values taken and given, kept in the items' order. */
export type MultiDropdownProps = DropdownBase & { value: string[]; onChange: (value: string[]) => void };
type DropdownInput = DropdownBase &
  (
    | { multiple?: false; value: string; onChange: (value: string) => void }
    | { multiple: true; value: string[]; onChange: (value: string[]) => void }
  );

export interface DropdownAction {
  label: string;
  onSelect: () => void;
}

/* A value no option could carry, so an action's row is told apart from an option's. */
const ACTION = '~~action:';

export function Dropdown(props: DropdownProps) {
  return <DropdownList {...props} />;
}

/** The same listbox choosing several: it stays open while it is chosen from, and the button says the choices. */
export function MultiDropdown(props: MultiDropdownProps) {
  return <DropdownList {...props} multiple />;
}

function DropdownList(props: DropdownInput) {
  const {
    items,
    ariaLabel,
    ariaInvalid,
    ariaDescribedBy,
    ariaLabelledBy,
    id,
    buttonRef,
    popupRef,
    onOpenChange,
    disabled,
    readOnly,
    valueClassName,
    actions = [],
    buttonClassName,
    listClassName,
    valueId,
    placeholder,
  } = props;
  const many = props.multiple === true;
  const chosen: string[] = props.multiple === true ? props.value : [props.value];
  const selected = items.find((i) => i.value === chosen[0]);
  /* Nothing chosen: a value no item carries (a form's empty answer) reads as no selection, not as a stray one. */
  const said = many
    ? items
        .filter((i) => chosen.includes(i.value))
        .map((i) => i.label)
        .join(', ')
    : (selected?.label ?? '');
  /* Where the list is drawn. A list portalled to the end of the body sits
     behind a modal <dialog>'s top layer, and half the pickers here live in
     one — so inside a dialog the list is drawn into that dialog, and keeps
     its stacking context; elsewhere it goes to the body the way every
     floating surface here does. */
  const root = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setContainer(root.current?.closest('dialog, [role="dialog"]') as HTMLElement | null);
  }, []);
  /* The trigger, for the anchor measured with the zoom-aware ruler (anchor.ts). */
  const trigger = useRef<HTMLButtonElement | null>(null);
  const setTrigger = (node: HTMLButtonElement | null) => {
    trigger.current = node;
    if (typeof buttonRef === 'function') buttonRef(node);
    else if (buttonRef) (buttonRef as { current: HTMLButtonElement | null }).current = node;
  };
  return (
    <div className="dd" ref={root}>
      <Select.Root
        multiple={many || undefined}
        value={(many ? chosen : selected ? selected.value : null) as never}
        disabled={disabled}
        readOnly={readOnly}
        onOpenChange={onOpenChange}
        /* The labels, handed over: without them Base UI mounts the list
           once, hidden, to read the selected label off an item. */
        items={items.map((i) => ({ value: i.value, label: i.label }))}
        onValueChange={(next: unknown) => {
          if (props.multiple === true) {
            if (!Array.isArray(next)) return;
            const ran = next.find((v): v is string => typeof v === 'string' && v.startsWith(ACTION));
            if (ran) actions[Number(ran.slice(ACTION.length))]?.onSelect();
            else props.onChange(items.map((i) => i.value).filter((v) => next.includes(v)));
            return;
          }
          if (typeof next !== 'string') return;
          if (next.startsWith(ACTION)) {
            actions[Number(next.slice(ACTION.length))]?.onSelect();
            return;
          }
          if (next !== props.value) props.onChange(next);
        }}
      >
        {/* A button that opens a listbox, as it has always been announced —
            Base UI's own "combobox" role is the other reading of the same
            pattern, and every test and stylesheet here knows this one. */}
        <Select.Trigger
          render={
            <button
              type="button"
              role="button"
              id={id}
              className={buttonClassName ? `dd-button ${buttonClassName}` : 'dd-button'}
              ref={setTrigger}
              aria-label={ariaLabelledBy ? undefined : ariaLabel}
              aria-labelledby={ariaLabelledBy}
              aria-invalid={ariaInvalid || undefined}
              aria-describedby={ariaDescribedBy}
              title={selected?.detail ?? ''}
            />
          }
        >
          {selected?.swatches && (
            <span className="dd-swatches" aria-hidden="true">
              {selected.swatches.map((color, index) => (
                <span key={index} style={{ background: color }} />
              ))}
            </span>
          )}
          <span id={valueId} className={`dd-value${valueClassName ? ` ${valueClassName}` : ''}${said ? '' : ' is-empty'}`}>
            {said || placeholder || '—'}
          </span>
          <span className="dd-caret" aria-hidden="true">
            ▾
          </span>
        </Select.Trigger>
        <Select.Portal container={container ?? popupContainer()}>
          {/* Below the trigger and flush with its left edge, the way the list
              has always opened; never over the trigger the way a native
              select overlaps its own value. Fixed, so a scrolling panel
              cannot clip it, the way the old list escaped them. */}
          <Select.Positioner
            anchor={() => (trigger.current ? zoomAnchor(trigger.current) : null)}
            alignItemWithTrigger={false}
            positionMethod="fixed"
            side="bottom"
            align="start"
            sideOffset={4}
            collisionBoundary={layoutViewport()}
            collisionPadding={8}
            style={{ zIndex: 40 }}
          >
            <Select.Popup ref={popupRef} className="dd-popup">
              <Select.List
                className={['dd-list', many ? 'dd-list-multi' : '', listClassName].filter(Boolean).join(' ')}
                aria-label={ariaLabel}
                aria-labelledby={ariaLabel ? undefined : ariaLabelledBy?.split(' ')[0]}
              >
                {items.map((item) => (
                  <Select.Item
                    key={item.value}
                    value={item.value}
                    label={item.label}
                    disabled={item.disabled}
                    className={(s) =>
                      `dd-option${s.selected ? ' selected' : ''}${item.disabled ? ' disabled' : ''}${item.tone ? ` dd-tone-${item.tone}` : ''}${s.highlighted ? ' active' : ''}`
                    }
                  >
                    {many ? (
                      <span className="dd-box" aria-hidden="true" />
                    ) : (
                      <span className="dd-check" aria-hidden="true">
                        {item.value === props.value ? '✓' : ''}
                      </span>
                    )}
                    {item.swatches && (
                      <span className="dd-swatches" aria-hidden="true">
                        {item.swatches.map((color, index) => (
                          <span key={index} style={{ background: color }} />
                        ))}
                      </span>
                    )}
                    <span className="dd-text">
                      <span className="dd-label">{item.label}</span>
                      {item.detail && <span className="dd-detail">{item.detail}</span>}
                    </span>
                    {item.badge && <span className="dd-badge">{item.badge}</span>}
                  </Select.Item>
                ))}
                {actions.length ? <div className="dd-divider" role="presentation" /> : null}
                {actions.map((action, i) => (
                  <Select.Item
                    key={action.label}
                    value={`${ACTION}${i}`}
                    label={action.label}
                    className={(s) => `dd-option dd-action${s.highlighted ? ' active' : ''}`}
                  >
                    <span className="dd-check" aria-hidden="true" />
                    <span className="dd-text">
                      <span className="dd-label">{action.label}</span>
                    </span>
                  </Select.Item>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
