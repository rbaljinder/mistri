import { useEffect, useState, type RefObject } from 'react';

/* A popup opened inside a dialog is drawn inside it, so the dialog's focus trap and its stacking keep it as their
   own (packages/ui/src/internal/popups.ts does the same for Base UI). UI SDK draws a popup in place where the
   browser has a top layer; where it has to move one, this says where to. */
export function useDialogContainer(anchor: RefObject<Element | null>): HTMLElement | undefined {
  const [container, setContainer] = useState<HTMLElement | undefined>();
  useEffect(() => {
    setContainer((anchor.current?.closest('dialog, [role="dialog"]') as HTMLElement | null) ?? undefined);
  }, [anchor]);
  return container;
}
