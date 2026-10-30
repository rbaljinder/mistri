/**
 * A popover: a small layer anchored to a trigger, over Base UI's Popover,
 * which gives it the anchoring, Escape and a click outside to dismiss,
 * and focus handed back on close. The trigger is the caller's element
 * (a button, a word); the popup is the layer's children. Controlled with
 * `open`/`onOpenChange`, uncontrolled with `defaultOpen`. Where the
 * popup is a menu of actions, DropMenu is the right primitive instead:
 * a popover is a layer, not a list of commands.
 */
import { isValidElement, type ReactNode } from 'react';
import { Popover as BasePopover } from '@base-ui/react/popover';

export interface PopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  /** The popup's accessible name, where it needs one. */
  label?: string;
}

export function PopoverLayer({ trigger, children, open, defaultOpen, onOpenChange, className, label }: PopoverProps) {
  /* The trigger is rendered as the trigger, not inside one: a button
     passed as a child nested inside Base UI's own button, giving two
     buttons for one control. The render prop merges onto the caller's
     element (DropMenu.tsx does the same for its trigger). */
  const triggerElement = isValidElement(trigger) ? trigger : <button type="button">{trigger}</button>;
  return (
    <BasePopover.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <BasePopover.Trigger className="ui-popover-trigger" render={triggerElement} />
      <BasePopover.Portal>
        <BasePopover.Positioner sideOffset={8}>
          <BasePopover.Popup className={['ui-popover', className].filter(Boolean).join(' ')} aria-label={label}>
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}

/** The short name, as the other primitives export theirs. */
export const Popover = PopoverLayer;
