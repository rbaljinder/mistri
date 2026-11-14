/**
 * A tooltip: a short note on an element, said on hover and on focus alike,
 * never on hover alone. Over UI SDK's Tooltip, which gives it the
 * anchoring, the Escape to dismiss, the note's role and the wire from the
 * trigger to it. The trigger is the caller's element (a button, a word);
 * the note is the popup's children. The note is added to a description
 * the trigger already had (a field's hint) and does not take its place,
 * and a button passed as the trigger is never nested inside the part's
 * own button (internal/layers.tsx).
 *
 * A tooltip says something extra, never something essential: a reader who
 * never hovers must still understand the trigger from its own label, and
 * a note that carries an action belongs in a Popover instead, where it
 * can be reached and used.
 *
 * Drawn where Popover.tsx draws its layer: inside an enclosing dialog,
 * and otherwise where the page says its popups go.
 */
import { Tooltip as Note, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip';
import { useContext, useRef, type ReactNode } from 'react';
import type { ChangeDetails } from './changeDetails.js';
import { ComponentStyleScope } from './internal/ComponentStyleScope.js';
import { describedTrigger, heard } from './internal/layers.js';
import { popupContainer, useDialogContainer } from './internal/popups.js';
import { slotted } from './internal/uiKitContext.js';

export interface TooltipProps {
  /** The element the note belongs to; a button, a word, an icon. */
  trigger: ReactNode;
  /** The note itself: short, supplementary, never an action. */
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (
    open: boolean,
    details: ChangeDetails<
      'trigger-hover' | 'trigger-focus' | 'trigger-press' | 'outside-press' | 'escape-key' | 'disabled' | 'imperative-action' | 'implicit'
    >,
  ) => void;
  className?: string;
}

function DefaultTooltip({ trigger, children, open, defaultOpen, onOpenChange, className }: TooltipProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const container = useDialogContainer(anchor);
  /* The layer is drawn outside the page that opened it; the page's scope goes with it (Modal.tsx). */
  const componentScope = useContext(ComponentStyleScope);
  return (
    <Note open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange && ((next, details) => onOpenChange(next, heard(details)))}>
      <TooltipTrigger render={describedTrigger(trigger)} ref={anchor} />
      <TooltipContent
        className={className}
        data-component={componentScope}
        sideOffset={8}
        collisionPadding={8}
        container={container ?? popupContainer()}
      >
        {children}
      </TooltipContent>
    </Note>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Tooltip = slotted('Tooltip', DefaultTooltip, { onOpenChange: [1, 'implicit'] });
