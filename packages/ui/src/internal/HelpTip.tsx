/**
 * The help tip's drawing (FormParts.tsx hands it out), in a module of its own: every field's frame draws one
 * (./Frame.tsx), and a page with one field should not load the rest of a form's parts to do it.
 */
import { Tooltip as Note, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { HelpTipProps } from '../FormParts.js';
import { slotted } from './uiKitContext.js';
import { popupContainer, useDialogContainer } from './popups.js';

/* Help beside a label: a button that opens it, so it works under a finger and from the keyboard, and what it
   says is the button's description while it is open. UI SDK's tooltip is the note (its role, its place by the
   button, Escape), made to open on a press and stay; a press anywhere else closes it. */
function DefaultHelpTip({ text, label, icon, className, ref }: HelpTipProps): ReactNode {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const container = useDialogContainer(button);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: Event) => {
      if (!button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return (
    <Note
      toggleable
      open={open}
      onOpenChange={(next, details) => {
        if (next && details.reason !== 'trigger-press') return details.cancel();
        setOpen(next);
      }}
    >
      <TooltipTrigger
        ref={(node: HTMLButtonElement | null) => {
          button.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) (ref as { current: HTMLButtonElement | null }).current = node;
        }}
        className={className}
        aria-label={label}
        aria-expanded={open}
        data-kind="help-tip"
      >
        {icon ?? <span aria-hidden="true">i</span>}
      </TooltipTrigger>
      <TooltipContent
        render={<span />}
        data-kind="help-tip"
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        container={container ?? popupContainer()}
      >
        {text}
      </TooltipContent>
    </Note>
  );
}

/** Press-activated inline help button and note popover beside form field labels. */
export const HelpTip = slotted('HelpTip', DefaultHelpTip);
