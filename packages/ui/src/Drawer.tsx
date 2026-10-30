/**
 * A drawer: a sheet that slides in from an edge, over Base UI's Drawer,
 * which gives it the scrim, focus held inside, Escape and a click on the
 * scrim to dismiss, focus handed back on close, and the swipe to dismiss
 * on a phone. Controlled with `open`/`onOpenChange`; a closed drawer is
 * dismissed (its exit animation aside, the sheet stays in the tree only
 * while that runs), so nothing inside it is read while it is shut.
 * `side` is the edge it comes from, right by default,
 * and the panel is at most 420px wide (a left drawer the same), full
 * width on a phone. A title is required where the sheet needs one: the
 * sheet's accessible name, never a decorative heading alone.
 */
import type { ReactNode } from 'react';
import { Drawer as BaseDrawer } from '@base-ui/react/drawer';

export type DrawerSide = 'left' | 'right';

export interface DrawerProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: DrawerSide;
  /** The sheet's accessible name. */
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  /** A non-cancellable operation is awaiting acknowledgement. */
  closeDisabled?: boolean;
}

export function DrawerSheet({ open, onOpenChange, side = 'right', title, children, className, closeDisabled = false }: DrawerProps) {
  return (
    <BaseDrawer.Root
      open={open}
      disablePointerDismissal={closeDisabled}
      onOpenChange={(next) => {
        /* A non-cancellable operation: a dismissal request (Escape, a
           click outside) is refused here, as Modal's beforeClose refuses
           one, and the controlled drawer stays open. */
        if (!next && closeDisabled) return;
        onOpenChange?.(next);
      }}
    >
      <BaseDrawer.Portal>
        <BaseDrawer.Backdrop className="ui-drawer-backdrop" />
        <BaseDrawer.Viewport className={['ui-drawer-viewport', `ui-drawer-${side}`, className].filter(Boolean).join(' ')}>
          <BaseDrawer.Popup className="ui-drawer" aria-label={typeof title === 'string' ? title : undefined}>
            {title !== undefined ? <BaseDrawer.Title className="ui-drawer-title">{title}</BaseDrawer.Title> : null}
            {children}
          </BaseDrawer.Popup>
        </BaseDrawer.Viewport>
      </BaseDrawer.Portal>
    </BaseDrawer.Root>
  );
}

/** The short name, as the other primitives export theirs. */
export const Drawer = DrawerSheet;
