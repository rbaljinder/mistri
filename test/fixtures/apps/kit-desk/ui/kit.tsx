/**
 * A control kit in plain HTML, with no dependency: the proof that a kit plugs in through the seam alone. It draws the
 * slots the gate walks — a button, a link dressed as one, a dialog, a menu's four parts, a typeahead and a date field
 * — and leaves every other slot to the platform. Each control carries `data-kit`, so the spec can tell the kit's from
 * the platform's; ui/kit.test.tsx holds it to the conformance suite.
 *
 * Its popups are drawn in place, inside whatever drew them, so a menu or a list opened in a dialog is in the dialog.
 */
import { createContext, useContext, useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { defineUiKit, type UiKitSlots } from '@mistriwork/mistri/page';
import './kit.css';

const classes = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ');

const Button: UiKitSlots['Button'] = ({
  variant = 'secondary',
  size,
  loading = false,
  loadingLabel,
  leadingIcon,
  trailingIcon,
  shortcut,
  block = false,
  iconOnly: _iconOnly,
  type = 'button',
  ariaLabel,
  className,
  disabled,
  onClick,
  children,
  ref,
  ...rest
}) => {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      aria-label={ariaLabel}
      data-kit="button"
      data-variant={variant}
      className={classes('kit-button', `kit-${variant}`, size === 'sm' && 'kit-sm', block && 'kit-block', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={onClick ? (e) => void onClick(e, { reason: 'press', source: 'pointer', event: e.nativeEvent } as never) : undefined}
    >
      {leadingIcon}
      {loading && loadingLabel ? loadingLabel : children}
      {trailingIcon}
      {shortcut}
    </button>
  );
};

const ButtonLink: UiKitSlots['ButtonLink'] = ({
  variant = 'secondary',
  size,
  leadingIcon,
  trailingIcon,
  shortcut,
  block = false,
  iconOnly: _iconOnly,
  disabled,
  ariaLabel,
  onClick,
  className,
  children,
  ref,
  ...rest
}) => {
  const held = Boolean(disabled) || rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
  return (
    <a
      {...rest}
      ref={ref}
      aria-label={ariaLabel}
      data-kit="button-link"
      aria-disabled={held ? true : rest['aria-disabled']}
      onClick={(e) => {
        if (held) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      className={classes('kit-button', `kit-${variant}`, size === 'sm' && 'kit-sm', block && 'kit-block', className)}
    >
      {leadingIcon}
      {children}
      {trailingIcon}
      {shortcut}
    </a>
  );
};

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* Open from mount; `onClose` once, however it closed; the focus back where it was when it opened. */
const Modal: UiKitSlots['Modal'] = ({
  className,
  onClose,
  closeDisabled = false,
  beforeClose,
  children,
  initialFocus,
  finalFocus,
  ariaLabel,
  ref,
}) => {
  const box = useRef<HTMLDivElement>(null);
  const closed = useRef(false);
  const close = () => {
    if (closed.current || closeDisabled || beforeClose?.() === false) return;
    closed.current = true;
    onClose();
  };
  useImperativeHandle(ref, () => ({ close }));
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = initialFocus === false ? null : (initialFocus?.current ?? box.current?.querySelector<HTMLElement>(FOCUSABLE));
    (first ?? box.current)?.focus();
    return () => {
      const back = finalFocus?.current ?? before;
      if (back?.isConnected) back.focus();
    };
    // Where the focus was is read once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      /* The focus stays in the dialog: past the last control it goes to the first, and back. */
      const all = [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (!all.length) return;
      const at = all.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey ? at <= 0 : at === all.length - 1) {
        event.preventDefault();
        all[event.shiftKey ? all.length - 1 : 0].focus();
      }
    }
  };
  return createPortal(
    <div data-kit="modal" className="kit-modal-layer">
      <div className="kit-scrim" onClick={close} />
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={classes('kit-modal', className)}
        onKeyDown={keys}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
};

/* ---- The menu: four parts sharing one state ---- */

const MenuState = createContext<{ close: (refocus: boolean) => void }>({ close: () => {} });

const DropMenu: UiKitSlots['DropMenu'] = ({
  className,
  triggerClassName,
  triggerTitle,
  triggerLabel,
  ariaLabel,
  label,
  popupClassName,
  align = 'end',
  open,
  onOpenChange,
  children,
}) => {
  const [own, setOwn] = useState(false);
  const shown = open ?? own;
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const triggerId = useId();
  const set = (next: boolean) => {
    if (open === undefined) setOwn(next);
    onOpenChange?.(next);
  };
  const close = (refocus: boolean) => {
    if (refocus) trigger.current?.focus();
    set(false);
  };
  useEffect(() => {
    if (!shown) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) set(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
    // The listener is set for each opening; `set` reads the latest props when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Home') items[0]?.focus();
    else if (event.key === 'End') items.at(-1)?.focus();
    else items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <span ref={wrap} data-kit="drop-menu" className={classes('kit-menu-wrap', className)}>
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        className={classes('kit-button', 'kit-secondary', triggerClassName)}
        title={triggerTitle}
        aria-label={ariaLabel ?? triggerLabel}
        aria-haspopup="menu"
        aria-expanded={shown}
        onClick={() => set(!shown)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !shown) {
            event.preventDefault();
            set(true);
          }
        }}
      >
        {label}
      </button>
      {shown ? (
        <MenuState.Provider value={{ close }}>
          <div
            ref={menu}
            role="menu"
            aria-labelledby={triggerId}
            className={classes('kit-menu', `kit-align-${align}`, popupClassName)}
            onKeyDown={move}
          >
            {children}
          </div>
        </MenuState.Provider>
      ) : null}
    </span>
  );
};

const DropGroup: UiKitSlots['DropGroup'] = ({ className, labelClassName, label, children }) => {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className={className}>
      <div id={id} className={classes('kit-menu-label', labelClassName)}>
        {label}
      </div>
      {children}
    </div>
  );
};

const DropItem: UiKitSlots['DropItem'] = ({ className, disabled, closeOnClick = true, onClick, title, children, ref }) => {
  const { close } = useContext(MenuState);
  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      tabIndex={-1}
      data-kit="drop-item"
      className={classes('kit-menu-item', className)}
      title={title}
      disabled={disabled}
      onClick={() => {
        /* The focus goes back to the trigger before the item runs, so a dialog the item opens returns it there. */
        if (closeOnClick) close(true);
        onClick();
      }}
    >
      {children}
    </button>
  );
};

const DropSeparator: UiKitSlots['DropSeparator'] = ({ className }) => (
  <div role="separator" className={classes('kit-menu-rule', className)} />
);

/* ---- A box with a list of matches under it ---- */

const Typeahead: UiKitSlots['Typeahead'] = ({
  text,
  onText,
  items,
  itemKey,
  itemLabel,
  itemClassName,
  renderItem,
  onPick,
  open,
  onOpenChange,
  inputProps,
  ref,
  popupRef,
  popupClassName,
  listClassName,
  empty,
  emptyClassName,
  autoHighlight = true,
  onHighlight,
}) => {
  const list = useId();
  const [lit, setLit] = useState(-1);
  const start = autoHighlight && items.length ? 0 : -1;
  useEffect(() => {
    setLit(start);
    onHighlight?.(start >= 0 ? items[start] : undefined);
    // A new list of matches lights its first row again; the callback is read when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, start]);
  const light = (at: number) => {
    setLit(at);
    onHighlight?.(at >= 0 ? items[at] : undefined);
  };
  const shown = open && (items.length > 0 || empty !== undefined);
  const { onKeyDown, onBlur, className, ariaLabel, ...rest } = inputProps;
  return (
    <>
      <input
        type="text"
        {...rest}
        ref={ref}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={shown}
        aria-controls={shown ? list : undefined}
        aria-autocomplete="list"
        aria-activedescendant={shown && lit >= 0 ? `${list}-${lit}` : undefined}
        data-kit="typeahead"
        className={classes('kit-field', className)}
        value={text}
        onChange={(event) => onText(event.target.value)}
        onBlur={(event) => {
          onBlur?.(event);
          if (open) onOpenChange(false);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            onOpenChange(false);
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) onOpenChange(true);
            else if (items.length) light(event.key === 'ArrowDown' ? Math.min(lit + 1, items.length - 1) : Math.max(lit - 1, 0));
          } else if (event.key === 'Enter' && open && lit >= 0 && items[lit] !== undefined) {
            event.preventDefault();
            onPick(items[lit]);
          }
        }}
      />
      {shown ? (
        <div ref={popupRef} className={classes('kit-popup', popupClassName)}>
          {/* Nothing matched: the message is a status on the list's surface, and no listbox is left holding no option. */}
          {items.length === 0 ? (
            <div id={list} className={classes('kit-list', listClassName)}>
              <div role="status" className={emptyClassName}>
                {typeof empty === 'object' && empty !== null && 'title' in empty ? empty.title : empty}
              </div>
            </div>
          ) : (
            <div
              role="listbox"
              id={list}
              aria-label={ariaLabel}
              aria-labelledby={rest['aria-labelledby']}
              className={classes('kit-list', listClassName)}
            >
              {items.map((item, at) => (
                <div
                  key={itemKey(item)}
                  id={`${list}-${at}`}
                  role="option"
                  aria-selected={at === lit}
                  className={classes('kit-option', at === lit && 'kit-lit', itemClassName(item, at === lit))}
                  title={itemLabel(item)}
                  /* The box keeps the focus through a pick, so its blur does not close the list first. */
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => light(at)}
                  onClick={() => onPick(item)}
                >
                  {renderItem(item)}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </>
  );
};

/* ---- A date typed as text, or picked with the browser's own calendar ---- */

const DateField: UiKitSlots['DateField'] = ({
  id,
  words,
  value,
  onValueChange,
  onBlur,
  onKeyDown,
  disabled,
  required,
  min,
  max,
  className,
  name,
  ref,
  placeholder,
  withTime,
  ariaLabel: label,
  'aria-invalid': invalid,
  'aria-describedby': describedBy,
}) => {
  const [picking, setPicking] = useState(false);
  return (
    <span data-kit="date-field" className="kit-date">
      <input
        id={id}
        ref={ref}
        type="text"
        name={name}
        className={classes('kit-field', className)}
        value={value}
        placeholder={placeholder ?? (withTime ? `YYYY-MM-DD ${words.timePattern}` : 'YYYY-MM-DD')}
        disabled={disabled}
        required={required}
        aria-label={label}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={(event) => onValueChange?.(event.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="kit-button kit-ghost kit-sm"
        aria-label={words.chooseDate(label)}
        aria-expanded={picking}
        disabled={disabled}
        onClick={() => setPicking(!picking)}
      >
        ▾
      </button>
      {picking ? (
        <input
          type={withTime ? 'datetime-local' : 'date'}
          className="kit-calendar"
          aria-label={words.calendar(label)}
          value={withTime ? value.replace(' ', 'T').slice(0, 16) : value.slice(0, 10)}
          min={min}
          max={max}
          onChange={(event) => {
            onValueChange?.(withTime ? event.target.value.replace('T', ' ') : event.target.value);
            setPicking(false);
          }}
        />
      ) : null}
    </span>
  );
};

export default defineUiKit({ Button, ButtonLink, Modal, DropMenu, DropGroup, DropItem, DropSeparator, Typeahead, DateField });
