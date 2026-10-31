/**
 * A tooltip: a short note on an element, said on hover and on focus alike,
 * never on hover alone. Over Base UI's Tooltip, which gives it the
 * anchoring and the Escape to dismiss. Base UI does not name the note
 * itself in this version — no `role="tooltip"`, no `aria-describedby` on
 * the trigger — so this wrapper owns both: the popup carries the role
 * and an id, and the trigger carries that id as its description while
 * the note is open. The trigger is the caller's element (a button, a
 * word); the note is the popup's children. The render prop merges onto
 * the caller's element (Popover.tsx does the same), so a button passed as
 * the trigger is never nested inside Base UI's own button.
 *
 * A tooltip says something extra, never something essential: a reader who
 * never hovers must still understand the trigger from its own label, and
 * a note that carries an action belongs in a Popover instead, where it
 * can be reached and used.
 */
import { cloneElement, isValidElement, useId, useState, type ReactNode } from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';

export interface TooltipProps {
  /** The element the note belongs to; a button, a word, an icon. */
  trigger: ReactNode;
  /** The note itself: short, supplementary, never an action. */
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function TooltipLayer({ trigger, children, open, defaultOpen, onOpenChange, className }: TooltipProps) {
  const tooltipId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;
  const base = isValidElement(trigger) ? trigger : <button type="button">{trigger}</button>;
  /* The description wire exists only while the note is open, so a closed
     tooltip never points at an id that is not in the tree. */
  const triggerElement = isOpen ? cloneElement(base, { 'aria-describedby': tooltipId } as Record<string, unknown>) : base;
  return (
    <BaseTooltip.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={(next, details) => {
        if (open === undefined) setUncontrolledOpen(next);
        onOpenChange?.(next);
        void details;
      }}
    >
      <BaseTooltip.Trigger className="ui-tooltip-trigger" render={triggerElement} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={8}>
          <BaseTooltip.Popup id={tooltipId} role="tooltip" className={['ui-tooltip', className].filter(Boolean).join(' ')}>
            {children}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/** The short name, as the other primitives export theirs. */
export const Tooltip = TooltipLayer;
