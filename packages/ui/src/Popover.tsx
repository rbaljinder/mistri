/**
 * A popover: a small layer anchored to a trigger, over Base UI's Popover,
 * which gives it the anchoring, Escape and a click outside to dismiss,
 * and focus handed back on close. The trigger is the caller's element
 * (a button, a word); the popup is the layer's children. Controlled with
 * `open`/`onOpenChange`, uncontrolled with `defaultOpen`. Where the
 * popup is a menu of actions, DropMenu is the right primitive instead:
 * a popover is a layer, not a list of commands.
 *
 * Placed as DropMenu places its menu: anchored on the zoom-aware ruler
 * (anchor.ts) and fixed to the viewport, and drawn inside an enclosing
 * dialog, so the density zoom cannot throw it a room away from its trigger
 * and a dialog's focus trap keeps it as its own.
 */
import { isValidElement, useContext, useRef, type ReactNode } from 'react';
import { Popover as BasePopover } from '@base-ui/react/popover';
import { layoutViewport, zoomAnchor } from './internal/anchor.js';
import { ComponentStyleScope } from './internal/ComponentStyleScope.js';
import { popupContainer, useDialogContainer } from './internal/popups.js';

export interface PopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  /** The popup's accessible name, where it needs one. */
  ariaLabel?: string;
}

export function Popover({ trigger, children, open, defaultOpen, onOpenChange, className, ariaLabel }: PopoverProps) {
  /* The trigger is rendered as the trigger, not inside one: a button
     passed as a child nested inside Base UI's own button, giving two
     buttons for one control. The render prop merges onto the caller's
     element (DropMenu.tsx does the same for its trigger). */
  const triggerElement = isValidElement(trigger) ? trigger : <button type="button">{trigger}</button>;
  const anchor = useRef<HTMLButtonElement>(null);
  const container = useDialogContainer(anchor);
  /* The layer is drawn outside the page that opened it; the page's scope goes with it (Modal.tsx). */
  const componentScope = useContext(ComponentStyleScope);
  return (
    <BasePopover.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <BasePopover.Trigger className="ui-popover-trigger" render={triggerElement} ref={anchor} />
      <BasePopover.Portal container={container ?? popupContainer()}>
        <BasePopover.Positioner
          anchor={() => (anchor.current ? zoomAnchor(anchor.current) : null)}
          positionMethod="fixed"
          sideOffset={8}
          collisionBoundary={layoutViewport()}
          collisionPadding={8}
        >
          <BasePopover.Popup
            data-component={componentScope}
            className={['ui-popover', className].filter(Boolean).join(' ')}
            aria-label={ariaLabel}
          >
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
