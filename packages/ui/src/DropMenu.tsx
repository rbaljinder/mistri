/**
 * A button that opens a menu, over UI SDK's Menu — what the `<details>`
 * menus here did with a summary and a hook (react to a click, close on
 * Escape or a click outside, hand focus back), plus what they never did:
 * arrows between the items, Home and End, typeahead, and the roles a
 * screen reader expects of a menu.
 *
 * The wrapper keeps the caller's class (`export`, `pb-picker`) because the
 * caller's stylesheet places the control by it; the trigger and the popup
 * wear the classes the caller gives them, over the menu's own parts. The
 * popup is shown in the browser's top layer where it has one, so nothing
 * here says how it stacks. The
 * popup is drawn inside an enclosing dialog, and otherwise where the page
 * says its popups go, so a scrolling panel cannot clip it. The open state
 * can be the caller's, for a menu that has to stay up while a click inside
 * it fetches.
 */
import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from '@ui-sdk/react/menu';
import { useEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import type { ChangeDetails } from './changeDetails.js';
import { heard } from './internal/layers.js';
import { popupContainer, useDialogContainer } from './internal/popups.js';
import { slotted } from './internal/uiKitContext.js';

interface DropMenuProps {
  /** The wrapper's class — where the stylesheet places the control. */
  className?: string;
  /** The trigger's classes, in place of the menu's own trigger, which is a secondary button: a trigger that has them
   *  says `data-own` and is dressed by them alone. */
  triggerClassName?: string;
  triggerTitle?: string;
  /** The trigger's accessible name, when its visible label is shared with another menu on the page. */
  triggerLabel?: string;
  label: ReactNode;
  /** The popup's classes, over the menu's own surface. */
  popupClassName?: string;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  sideOffset?: number;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (
    open: boolean,
    details: ChangeDetails<
      | 'trigger-hover'
      | 'trigger-focus'
      | 'trigger-press'
      | 'outside-press'
      | 'focus-out'
      | 'list-navigation'
      | 'escape-key'
      | 'item-press'
      | 'close-press'
      | 'sibling-open'
      | 'cancel-open'
      | 'imperative-action'
      | 'implicit'
    >,
  ) => void;
  /** Where the focus goes when the menu closes; absent, back to the trigger. An element, a ref to one, or a function
      that answers once the page has drawn again: an element, `true` for the trigger, `false` to leave the focus be. */
  finalFocus?: boolean | RefObject<HTMLElement | null> | (() => boolean | HTMLElement | null | void);
  children: ReactNode;
}

function DefaultDropMenu({
  className,
  triggerClassName,
  triggerTitle,
  triggerLabel,
  label,
  popupClassName,
  side = 'bottom',
  align = 'end',
  sideOffset = 4,
  disabled,
  open,
  onOpenChange,
  finalFocus,
  children,
}: DropMenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  /* Inside a dialog the popup is drawn into that dialog, so it shares its
     stacking context rather than landing behind it; elsewhere it goes
     where the page says its popups go. */
  const container = useDialogContainer(root);
  /* Where the caller says the focus goes is answered here and not by UI SDK, which would ask as the menu closes:
     a caller's answer is often a row its own item just moved, which is where it will be only once the page has
     drawn again. So the close is noted, and the answer is asked for after that draw. */
  const closing = useRef<{ held: boolean } | null>(null);
  const [closes, setCloses] = useState(0);
  useEffect(() => {
    const noted = closing.current;
    closing.current = null;
    if (!noted?.held || finalFocus === undefined) return;
    // A function that answers nothing means the default, as an answer of true does.
    const answer = (typeof finalFocus === 'function' ? finalFocus() : finalFocus) as
      | boolean
      | RefObject<HTMLElement | null>
      | HTMLElement
      | null
      | undefined;
    if (answer === false) return;
    const to = answer === true || answer == null ? trigger.current : 'current' in answer ? answer.current : answer;
    const at = document.activeElement;
    // Only while the focus is still the menu's to give: a reader who has moved on is not pulled back.
    if (to?.isConnected && (!at || at === document.body || !at.isConnected || popup.current?.contains(at)))
      to.focus({ preventScroll: true });
    // Asked once for each close; what the caller's answer reads is its own to keep current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closes]);
  /* A menu that opens before its items have arrived (a caller that fetches on open) has nothing to give the
     keyboard, and UI SDK leaves it on the button. When the first item is drawn the keyboard is given it, as it
     would have been had the item been there: only while it is still where the opening left it, and only for a
     menu that opened empty, so one that opened with its items under a pointer keeps no item lit. */
  const [own, setOwn] = useState(false);
  const isOpen = disabled ? false : (open ?? own);
  const openedEmpty = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      openedEmpty.current = false;
      return undefined;
    }
    const frame = requestAnimationFrame(() => {
      const menu = popup.current;
      if (!menu) return;
      const first = menu.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"], :disabled)');
      if (!first) {
        openedEmpty.current = true;
        return;
      }
      if (!openedEmpty.current) return;
      openedEmpty.current = false;
      const at = document.activeElement;
      if (!at || at === document.body || !at.isConnected || at === trigger.current || at === menu) first.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
    // After every draw while open: the items are the caller's children, which arrive as a draw and nothing else.
  });
  return (
    <div className={className || undefined} data-slot="drop-menu" ref={root}>
      <Menu
        open={disabled ? false : open}
        onOpenChange={(next, details) => {
          if (disabled && next) return;
          setOwn(next);
          if (!next && finalFocus !== undefined) {
            const at = document.activeElement;
            closing.current = { held: !at || at === document.body || Boolean(popup.current?.contains(at)) };
            setCloses((count) => count + 1);
          }
          onOpenChange?.(next, heard(details));
        }}
      >
        <MenuTrigger
          ref={trigger}
          className={triggerClassName}
          /* A trigger given classes is the caller's to dress, whole: it wears none of the button's own (controls.css). */
          data-own={triggerClassName ? '' : undefined}
          title={triggerTitle}
          aria-label={triggerLabel}
          disabled={disabled}
        >
          {label}
        </MenuTrigger>
        <MenuContent
          ref={popup}
          className={popupClassName}
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          container={container ?? popupContainer()}
          finalFocus={finalFocus === undefined ? undefined : 'none'}
        >
          {children}
        </MenuContent>
      </Menu>
    </div>
  );
}

/** A labelled run of items: a menu that changes several things says which each item changes. */
function DefaultDropGroup({
  className,
  labelClassName,
  label,
  children,
}: {
  className?: string;
  labelClassName?: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <MenuGroup className={className}>
      <MenuGroupLabel className={labelClassName}>{label}</MenuGroupLabel>
      {children}
    </MenuGroup>
  );
}

/** A rule between two runs of items, a separator to a screen reader. */
function DefaultDropSeparator({ className }: { className?: string }) {
  return <MenuSeparator className={className} />;
}

/** An item drawn as a button, so `disabled` and the button styles hold. Closes the menu unless told not to. */
function DefaultDropItem({
  className,
  disabled,
  closeOnClick,
  onClick,
  title,
  children,
  ref,
}: {
  className?: string;
  disabled?: boolean;
  closeOnClick?: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <MenuItem
      render={<button type="button" />}
      // The part is typed as the element it is by default; here it is drawn as the button the caller's ref is for.
      ref={ref as Ref<HTMLElement> as Ref<HTMLDivElement>}
      className={className}
      title={title}
      disabled={disabled}
      closeOnSelect={closeOnClick}
      onSelect={() => onClick()}
    >
      {children}
    </MenuItem>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const DropMenu = slotted('DropMenu', DefaultDropMenu, { onOpenChange: [1, 'implicit'] });
export const DropGroup = slotted('DropGroup', DefaultDropGroup);
export const DropSeparator = slotted('DropSeparator', DefaultDropSeparator);
export const DropItem = slotted('DropItem', DefaultDropItem);
