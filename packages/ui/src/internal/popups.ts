/**
 * Where the primitives' layers — a dialog, a menu, a listbox, a popover — are drawn.
 *
 * On the page: the document's body, unless a shell drawn inside another page (an embed) names its own container
 * with `drawPopupsIn` (packages/mistri/src/embed/seams/shellHost.ts). UI SDK left to itself draws a layer where its
 * trigger is, in the top layer, which looks the same and is not: a menu opened from a column's head is then inside
 * the table and its keys go up through the grid's, a picker's form is a form inside the form its button stands in,
 * a press on an option inside a label presses the label's control, and a dialog opened from a dialog is counted
 * among the first one's fields. A layer opened inside a dialog is the exception, and is drawn in that dialog
 * (`useDialogContainer`), so it shares the dialog's focus and is not made inert with the page behind it.
 */

import { useLayoutEffect, useState } from 'react';

let container: () => HTMLElement | undefined = () => undefined;

/** The container handed to UI SDK's layers: the named one, else the page. */
export const popupContainer = (): HTMLElement | undefined => container() ?? (typeof document === 'undefined' ? undefined : document.body);

/** Draw every popup in this container from now on. */
export function drawPopupsIn(where: () => HTMLElement | undefined): void {
  container = where;
}

/**
 * The dialog a trigger stands in, read once it is mounted: its layer is drawn there and not on the page, so it
 * shares the dialog's stacking context and focus trap rather than landing behind it, inert, on the body. A popover
 * is a dialog too.
 */
export function useDialogContainer(trigger: { current: Element | null }): HTMLElement | null {
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  /* Before the first paint: a control that opens as it mounts (a cell's editor) would otherwise draw its list on
     the page and then again in the dialog, and whoever held an option from the first drawing held nothing. */
  useLayoutEffect(() => {
    setDialog((trigger.current?.closest('dialog, [role="dialog"]') as HTMLElement | null) ?? null);
  }, [trigger]);
  return dialog;
}
