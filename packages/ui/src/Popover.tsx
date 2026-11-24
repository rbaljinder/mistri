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
import { Popover as Layer, PopoverArrow, PopoverContent, PopoverTrigger } from '@ui-sdk/react/popover';
import { useContext, useRef, type ReactNode, type Ref } from 'react';
import type { ChangeDetails } from './changeDetails.js';
import { ComponentStyleScope } from './internal/ComponentStyleScope.js';
import { heard, triggerElement } from './internal/layers.js';
import { popupContainer, useDialogContainer } from './internal/popups.js';
import { slotted } from './internal/uiKitContext.js';

/** Props for the `Popover` anchored floating surface. */
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
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  arrow?: boolean;
  className?: string;
  /** The popup's accessible name, where it needs one. */
  ariaLabel?: string;
  ref?: Ref<HTMLDivElement>;
}

function DefaultPopover({
  trigger,
  children,
  open,
  defaultOpen,
  onOpenChange,
  side,
  align,
  sideOffset = 8,
  arrow,
  className,
  ariaLabel,
  ref,
}: PopoverProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const container = useDialogContainer(anchor);
  const componentScope = useContext(ComponentStyleScope);
  return (
    <Layer open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange && ((next, details) => onOpenChange(next, heard(details)))}>
      <PopoverTrigger render={triggerElement(trigger)} ref={anchor} />
      <PopoverContent
        ref={ref}
        className={className}
        data-component={componentScope}
        aria-label={ariaLabel}
        render={ariaLabel ? (drawn) => <div {...drawn} aria-labelledby={undefined} /> : undefined}
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        container={container ?? popupContainer()}
      >
        {arrow ? <PopoverArrow className="nx-popover-arrow" /> : null}
        {children}
      </PopoverContent>
    </Layer>
  );
}

/** Anchored floating popover layer with collision-aware placement, Escape dismissal, and dialog portal containment. */
export const Popover = slotted('Popover', DefaultPopover, { onOpenChange: [1, 'implicit'] });
