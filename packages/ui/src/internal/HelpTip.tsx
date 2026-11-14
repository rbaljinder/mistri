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
function DefaultHelpTip({ text, label, icon }: HelpTipProps): ReactNode {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // Drawn where the page's other layers are: inside an enclosing dialog, else where the page says its popups go.
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
        // Pointing at the button is not asking: the note opens on a press, as a finger has to open it.
        if (next && details.reason !== 'trigger-press') return details.cancel();
        setOpen(next);
      }}
    >
      <TooltipTrigger ref={button} aria-label={label} aria-expanded={open} data-kind="help-tip">
        {icon ?? <span aria-hidden="true">i</span>}
      </TooltipTrigger>
      {/* A span, as the tip stands where a label or a line of text does, which a block may not stand in. */}
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

/* The slot is made here, beside its default, so the frame that draws a field's tip draws the kit's where a kit has
   one. FormParts.tsx hands the same component out. */
export const HelpTip = slotted('HelpTip', DefaultHelpTip);
