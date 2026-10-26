/**
 * A button that opens a menu, over Base UI's Menu — what the `<details>`
 * menus here did with a summary and a hook (react to a click, close on
 * Escape or a click outside, hand focus back), plus what they never did:
 * arrows between the items, Home and End, typeahead, and the roles a
 * screen reader expects of a menu.
 *
 * The wrapper keeps the caller's class (`export`, `pb-picker`) because the
 * stylesheet places the control by it; the trigger and the popup wear the
 * classes the summary and the panel wore. The popup is anchored on the
 * zoom-aware ruler (anchor.ts) and fixed to the viewport, so a scrolling
 * panel cannot clip it. The open state can be the caller's, for a menu
 * that has to stay up while a click inside it fetches.
 */
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Menu } from '@base-ui/react/menu';
import { layoutViewport, zoomAnchor } from './anchor.js';
import { popupContainer } from './popups.js';

interface DropMenuProps {
  /** The wrapper's class — where the stylesheet places the control. */
  className: string;
  triggerClassName: string;
  triggerTitle?: string;
  /** The trigger's accessible name, when its visible label is shared with another menu on the page. */
  triggerLabel?: string;
  label: ReactNode;
  popupClassName: string;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  sideOffset?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where the focus goes when the menu closes; absent, back to the trigger. */
  finalFocus?: Menu.Popup.Props['finalFocus'];
  children: ReactNode;
}

export function DropMenu({
  className,
  triggerClassName,
  triggerTitle,
  triggerLabel,
  label,
  popupClassName,
  side = 'bottom',
  align = 'end',
  sideOffset = 4,
  open,
  onOpenChange,
  finalFocus,
  children,
}: DropMenuProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  /* Inside a dialog the popup is drawn into that dialog, so it shares its
     stacking context rather than landing behind it; elsewhere it goes to
     the body the way every floating surface here does. */
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setContainer(trigger.current?.closest('dialog, [role="dialog"]') as HTMLElement | null);
  }, []);
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const change = (next: boolean, details: Menu.Root.ChangeEventDetails) => {
    // Return focus before unmount so a containing dialog does not reclaim it — unless the caller says where it goes.
    if (!next && details.reason === 'escape-key' && finalFocus === undefined) trigger.current?.focus({ preventScroll: true });
    setOwn(next);
    onOpenChange?.(next);
  };
  return (
    <div className={className}>
      <Menu.Root open={isOpen} onOpenChange={change}>
        <Menu.Trigger
          render={<button type="button" className={triggerClassName} title={triggerTitle} aria-label={triggerLabel} ref={trigger} />}
        >
          {label}
        </Menu.Trigger>
        <Menu.Portal container={container ?? popupContainer()}>
          <Menu.Positioner
            anchor={() => (trigger.current ? zoomAnchor(trigger.current) : null)}
            positionMethod="fixed"
            side={side}
            align={align}
            sideOffset={sideOffset}
            collisionBoundary={layoutViewport()}
            collisionPadding={8}
            style={{ zIndex: 90 }}
          >
            <Menu.Popup className={popupClassName} finalFocus={finalFocus}>
              {children}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

/** A labelled run of items: a menu that changes several things says which each item changes. */
export function DropGroup({
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
    <Menu.Group className={className}>
      <Menu.GroupLabel className={labelClassName}>{label}</Menu.GroupLabel>
      {children}
    </Menu.Group>
  );
}

/** A rule between two runs of items, a separator to a screen reader. */
export function DropSeparator({ className }: { className: string }) {
  return <Menu.Separator className={className} />;
}

/** An item drawn as a button, so `disabled` and the button styles hold. Closes the menu unless told not to. */
export function DropItem({
  className,
  disabled,
  closeOnClick,
  onClick,
  title,
  children,
  ref,
}: {
  className: string;
  disabled?: boolean;
  closeOnClick?: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <Menu.Item
      render={<button type="button" className={className} title={title} ref={ref} />}
      nativeButton
      disabled={disabled}
      closeOnClick={closeOnClick}
      onClick={onClick}
    >
      {children}
    </Menu.Item>
  );
}
