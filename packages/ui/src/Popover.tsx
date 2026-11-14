/**
 * A popover: a small layer anchored to a trigger, over UI SDK's Popover,
 * which gives it the anchoring, Escape and a click outside to dismiss,
 * and focus handed back on close. The trigger is the caller's element
 * (a button, a word); the popup is the layer's children. Controlled with
 * `open`/`onOpenChange`, uncontrolled with `defaultOpen`. Where the
 * popup is a menu of actions, DropMenu is the right primitive instead:
 * a popover is a layer, not a list of commands.
 *
 * Drawn inside an enclosing dialog, so a dialog's focus trap keeps it as
 * its own, and otherwise where the page says its popups go (popups.ts).
 */
import { Popover as Layer, PopoverContent, PopoverTrigger } from '@ui-sdk/react/popover';
import { useContext, useRef, type ReactNode } from 'react';
import type { ChangeDetails } from './changeDetails.js';
import { ComponentStyleScope } from './internal/ComponentStyleScope.js';
import { heard, triggerElement } from './internal/layers.js';
import { popupContainer, useDialogContainer } from './internal/popups.js';
import { slotted } from './internal/uiKitContext.js';

export interface PopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (
    open: boolean,
    details: ChangeDetails<
      | 'trigger-hover'
      | 'trigger-focus'
      | 'trigger-press'
      | 'outside-press'
      | 'escape-key'
      | 'close-press'
      | 'focus-out'
      | 'imperative-action'
      | 'implicit'
    >,
  ) => void;
  className?: string;
  /** The popup's accessible name, where it needs one. */
  ariaLabel?: string;
}

function DefaultPopover({ trigger, children, open, defaultOpen, onOpenChange, className, ariaLabel }: PopoverProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const container = useDialogContainer(anchor);
  /* The layer is drawn outside the page that opened it; the page's scope goes with it (Modal.tsx). */
  const componentScope = useContext(ComponentStyleScope);
  return (
    <Layer open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange && ((next, details) => onOpenChange(next, heard(details)))}>
      {/* The trigger is rendered as the trigger, not inside one: a button passed as a child would nest inside the
          part's own button, giving two buttons for one control (DropMenu.tsx does the same for its trigger). */}
      <PopoverTrigger render={triggerElement(trigger)} ref={anchor} />
      <PopoverContent
        className={className}
        data-component={componentScope}
        aria-label={ariaLabel}
        /* UI SDK names the popup by its trigger. A name the caller gives is the popup's own, and the trigger's
           words would be read in its place: `aria-labelledby` outranks `aria-label`. */
        render={ariaLabel ? (drawn) => <div {...drawn} aria-labelledby={undefined} /> : undefined}
        sideOffset={8}
        collisionPadding={8}
        container={container ?? popupContainer()}
      >
        {children}
      </PopoverContent>
    </Layer>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Popover = slotted('Popover', DefaultPopover, { onOpenChange: [1, 'implicit'] });
