/**
 * A drawer: a sheet that slides in from an edge, over UI SDK's Drawer,
 * which gives it the scrim, focus held inside, Escape and a click on the
 * scrim to dismiss, focus handed back on close, and the swipe to dismiss
 * on a phone. Controlled with `open`/`onOpenChange`; a closed drawer is
 * out of the tree, so nothing inside it is read while it is shut.
 * `side` is the edge it comes from, right by default,
 * and the panel is at most 420px wide (a left drawer the same), full
 * width on a phone. The sheet is named by its `title` or, where it draws
 * none, by `ariaLabel`; one of the two is required.
 *
 * It wears what a layer wears: a scrim over the whole window, a head with the
 * title and a close control (`closeLabel` says its word), an edge against the
 * page, and the scope of the component that drew it, so a page's own classes
 * apply to the markup it puts in here as they do in the page (Modal.tsx does
 * the same).
 */
import { Drawer as Sheet, DrawerBackdrop, DrawerClose, DrawerContent, DrawerTitle } from '@ui-sdk/react/drawer';
import { useContext, type CSSProperties, type KeyboardEventHandler, type ReactNode, type Ref } from 'react';
import type { ChangeDetails } from './changeDetails.js';
import { ComponentStyleScope } from './internal/ComponentStyleScope.js';
import { heard } from './internal/layers.js';
import { popupContainer } from './internal/popups.js';
import { useSurfaceSeam } from './internal/surfaceSeam.js';
import { slotted } from './internal/uiKitContext.js';

/** Screen edge from which a `Drawer` sheet enters. */
export type DrawerSide = 'left' | 'right';

interface DrawerBase {
  open: boolean;
  onOpenChange?: (
    open: boolean,
    details: ChangeDetails<
      | 'trigger-press'
      | 'outside-press'
      | 'escape-key'
      | 'close-watcher'
      | 'close-press'
      | 'focus-out'
      | 'imperative-action'
      | 'swipe'
      | 'implicit'
    >,
  ) => void;
  side?: DrawerSide;
  /** Stands beside the page with no backdrop scrim so the workspace underneath remains live and clickable. */
  beside?: boolean;
  /** Whether the drawer traps focus and dims the page. Defaults to `false` when `beside` is true, else `true`. */
  modal?: boolean | 'trap-focus';
  /** Flush against the viewport edge instead of floating inset. */
  docked?: boolean;
  /** Omit the default sheet header when the caller draws its own header chrome. */
  hideHeader?: boolean;
  /** Optional controls rendered in the default sheet header beside the close button. */
  headerActions?: ReactNode;
  /** Whether Escape or outside presses automatically dismiss the drawer. Defaults to `true`. */
  dismissible?: boolean;
  /** Optional surface mode attribute forwarded onto `DrawerContent`. */
  dataMode?: string;
  /** Optional floating corner position attribute forwarded onto `DrawerContent`. */
  dataPosition?: string;
  /** Optional content-bounded fullscreen attribute forwarded onto `DrawerContent`. */
  dataBounded?: boolean;
  /** Optional aria-modal override on `DrawerContent`. */
  ariaModal?: boolean;
  /** Where focus goes when the drawer opens (`'none'` keeps focus untouched). */
  initialFocus?: 'auto' | 'content' | 'none';
  id?: string;
  role?: string;
  style?: CSSProperties;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  children: ReactNode;
  className?: string;
  /** A non-cancellable operation is awaiting acknowledgement. */
  closeDisabled?: boolean;
  /** The close control's name, in the caller's language. */
  closeLabel?: string;
  /** Localized strings for Drawer controls. */
  words?: { close?: string };
  ref?: Ref<HTMLDivElement>;
}

/** Props for `Drawer`; requires either a visible `title` or an `ariaLabel`. */
export type DrawerProps = DrawerBase & ({ title: ReactNode; ariaLabel?: string } | { title?: undefined; ariaLabel: string });

function DefaultDrawer({
  open,
  onOpenChange,
  side = 'right',
  beside = false,
  modal,
  docked = false,
  hideHeader = false,
  headerActions,
  dismissible = true,
  dataMode,
  dataPosition,
  dataBounded,
  ariaModal,
  initialFocus,
  id,
  role,
  style,
  onKeyDown,
  title,
  ariaLabel,
  children,
  className,
  closeDisabled = false,
  closeLabel,
  words,
  ref,
}: DrawerProps) {
  const componentScope = useContext(ComponentStyleScope);
  const seam = useSurfaceSeam();
  const resolvedCloseLabel = closeLabel ?? words?.close ?? seam?.defaultWords?.().close ?? 'Close';
  const resolvedModal = modal ?? (beside ? false : true);
  return (
    <Sheet
      container={popupContainer()}
      open={open}
      side={side}
      modal={resolvedModal}
      dismissible={dismissible}
      closeOnOutsidePress={beside ? false : undefined}
      onOpenChange={(next, details) => {
        if (!next && closeDisabled) return details.cancel();
        onOpenChange?.(next, heard(details));
      }}
    >
      {!beside && <DrawerBackdrop />}
      <DrawerContent
        ref={ref}
        id={id}
        style={style}
        onKeyDown={onKeyDown}
        initialFocus={initialFocus}
        data-kind="sheet"
        data-beside={beside ? '' : undefined}
        data-docked={docked ? '' : undefined}
        data-mode={dataMode}
        data-position={dataPosition}
        data-bounded={dataBounded ? '' : undefined}
        data-component={componentScope}
        className={className}
        aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
        render={
          role || (hideHeader && ariaLabel) || ariaModal !== undefined
            ? (drawn) => (
                <div
                  {...drawn}
                  role={role ?? drawn.role}
                  aria-modal={ariaModal !== undefined ? (ariaModal ? 'true' : undefined) : drawn['aria-modal']}
                  aria-labelledby={hideHeader && ariaLabel ? undefined : drawn['aria-labelledby']}
                />
              )
            : undefined
        }
      >
        {!hideHeader && (
          <header data-slot="sheet-head">
            {title !== undefined ? <DrawerTitle>{title}</DrawerTitle> : <span />}
            <div data-slot="sheet-head-actions">
              {headerActions}
              <DrawerClose aria-label={resolvedCloseLabel} disabled={closeDisabled} data-variant="quiet">
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                  <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </DrawerClose>
            </div>
          </header>
        )}
        {hideHeader ? children : <div data-slot="sheet-body">{children}</div>}
      </DrawerContent>
    </Sheet>
  );
}

/** Slide-in edge sheet dialog with focus trap, backdrop scrim, and Escape/swipe dismissal. */
export const Drawer = slotted('Drawer', DefaultDrawer, { onOpenChange: [1, 'implicit'] });
