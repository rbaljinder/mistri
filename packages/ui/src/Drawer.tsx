/**
 * A drawer: a sheet that slides in from an edge, over Base UI's Drawer,
 * which gives it the scrim, focus held inside, Escape and a click on the
 * scrim to dismiss, focus handed back on close, and the swipe to dismiss
 * on a phone. Controlled with `open`/`onOpenChange`; a closed drawer is
 * dismissed (its exit animation aside, the sheet stays in the tree only
 * while that runs), so nothing inside it is read while it is shut.
 * `side` is the edge it comes from, right by default,
 * and the panel is at most 420px wide (a left drawer the same), full
 * width on a phone. The sheet is named by its `title` or, where it draws
 * none, by `ariaLabel`; one of the two is required.
 */
import type { ReactNode } from 'react';
import { Drawer as BaseDrawer } from '@base-ui/react/drawer';

export type DrawerSide = 'left' | 'right';

interface DrawerBase {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: DrawerSide;
  children: ReactNode;
  className?: string;
  /** A non-cancellable operation is awaiting acknowledgement. */
  closeDisabled?: boolean;
}

/** A sheet is named by a title it draws or by an `ariaLabel` it does not; one of the two is required, so none is announced unnamed. */
export type DrawerProps = DrawerBase & ({ title: ReactNode; ariaLabel?: string } | { title?: undefined; ariaLabel: string });

export function Drawer({ open, onOpenChange, side = 'right', title, ariaLabel, children, className, closeDisabled = false }: DrawerProps) {
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
          <BaseDrawer.Popup className="ui-drawer" aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}>
            {title !== undefined ? <BaseDrawer.Title className="ui-drawer-title">{title}</BaseDrawer.Title> : null}
            {children}
          </BaseDrawer.Popup>
        </BaseDrawer.Viewport>
      </BaseDrawer.Portal>
    </BaseDrawer.Root>
  );
}
