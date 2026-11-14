/**
 * A modal, over UI SDK's Dialog: what every dialog here used to get from
 * the native `<dialog>` — the scrim, focus held inside, Escape and a click
 * on the scrim to dismiss, focus handed back on close — in one place, and
 * the one thing the native element could not give: popups drawn inside it
 * (a listbox, a menu) that the dialog knows are its own.
 *
 * Open from the moment it mounts, gone when the caller unmounts it; the
 * caller hears `onClose` once, whichever way it closed, and can close it
 * itself through the handle. Wears the caller's classes — `confirm`,
 * `prefs`, `cols` — so the caller's stylesheet and the browser suite see
 * the box they always saw. The scrim wears no class: it says whose it is
 * (`data-for`, the box's first class), so a caller's stylesheet that knows
 * the box can say what stands behind it. The placement the element used
 * to supply is the stylesheet's, by the part (`data-kind="modal"`); a
 * `plain` box is left to place itself.
 */
import { Dialog, DialogBackdrop, DialogContent } from '@ui-sdk/react/dialog';
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { ComponentStyleScope } from './internal/ComponentStyleScope.js';
import { popupContainer } from './internal/popups.js';
import { slotted } from './internal/uiKitContext.js';

export interface ModalHandle {
  close: () => void;
}

interface ModalProps {
  /** The classes the stylesheet knows the box by (`confirm`, `prefs`); the first also names the scrim (`[data-slot='dialog-backdrop'][data-for='confirm']`). Optional: a bare modal is centered and sized as a modal alone. */
  className?: string;
  /** Told once, however the dialog closed. */
  onClose: () => void;
  /** A non-cancellable operation is awaiting acknowledgement. */
  closeDisabled?: boolean;
  /** Return false to keep the dialog open, for example while confirming discard. */
  beforeClose?: () => boolean;
  children: ReactNode;
  /** The control to focus on open; UI SDK's default (the first focusable) otherwise. */
  initialFocus?: RefObject<HTMLElement | null> | false;
  /** Where focus goes on close, once the page is no longer inert; the element focused at open otherwise. */
  finalFocus?: RefObject<HTMLElement | null>;
  /** The dialog's name; absent, its first heading names it. */
  ariaLabel?: string;
  /** The name of a cross in the box's top corner that closes it ("Close"). Given, the cross is drawn; it steps aside
      while a button of the caller's own says the same word, so a dialog has one control of that name. */
  closeLabel?: string;
  /** The box places itself — a panel that is its own scrim, a box the stylesheet already centres — so the `modal` placement is left off. */
  plain?: boolean;
  /** No scrim element: the box covers the screen itself. */
  backdrop?: boolean;
  /** `'mobile'` — the default — takes the whole screen under 640px, because a
      dialog that leaves a sliver of the page around it on a phone reads as a
      mistake rather than as a layer. `true` takes the whole screen at every
      width; `false` opts out, for a dialog small enough to be a confirmation
      and nothing more. */
  fullscreen?: boolean | 'mobile';
  ref?: Ref<ModalHandle>;
}

function DefaultModal({
  className = '',
  onClose,
  closeDisabled = false,
  beforeClose,
  children,
  initialFocus,
  finalFocus,
  ariaLabel,
  closeLabel,
  plain = false,
  backdrop = true,
  fullscreen = 'mobile',
  ref,
}: ModalProps) {
  /* A dialog is drawn outside the component that opened it, so it says whose it is: the component's scoped
     stylesheet reaches what carries its name and nothing else. */
  const componentScope = useContext(ComponentStyleScope);
  const [open, setOpen] = useState(true);
  const closed = useRef(false);
  const close = () => {
    if (closed.current || closeDisabled || beforeClose?.() === false) return false;
    closed.current = true;
    setOpen(false);
    onClose();
    return true;
  };
  useImperativeHandle(ref, () => ({ close }));
  /* The caller unmounts the dialog the moment it hears `onClose`, which is before UI SDK has handed the focus
     back. So what had the focus when the dialog arrived is remembered here, read while rendering (before any
     effect has moved it), and given it back when the dialog goes, unless the caller named another place. */
  const [opener] = useState(() => (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)));
  useEffect(
    () => () => {
      const to = finalFocus?.current ?? opener;
      queueMicrotask(() => {
        const at = document.activeElement;
        if (to?.isConnected && (!at || at === document.body || !at.isConnected)) to.focus({ preventScroll: true });
      });
    },
    [opener, finalFocus],
  );
  /* A dialog with no `aria-label` is named by its first heading, which every one of these opens with: a screen reader
     announces "Delete invoice 7, dialog" rather than an unnamed dialog. Done when the box attaches, because the heading
     is the caller's children and the box mounts after this component's first effect. */
  const headingId = useId();
  const [labelledBy, setLabelledBy] = useState<string | undefined>();
  const unwatch = useRef<(() => void) | undefined>(undefined);
  /* Whether the focus is in the box, kept across the box being read again: a dialog whose name changes (a glance,
     stepping) is handed a new callback in the very render that removes what had the focus. */
  const within = useRef(false);
  /* The caller's own button already says the cross's word (a form that has finished offers "Close" in its foot):
     two controls of one name in one dialog are one too many to ask for by name, so the cross leaves while it stands. */
  const [ownClose, setOwnClose] = useState(false);
  useEffect(() => () => unwatch.current?.(), []);
  const popup = useCallback(
    (node: HTMLElement | null) => {
      unwatch.current?.();
      unwatch.current = undefined;
      if (!node) return;
      const heading = ariaLabel ? null : node.querySelector<HTMLElement>('h1, h2, h3');
      if (heading) {
        if (!heading.id) heading.id = headingId;
        setLabelledBy(heading.id);
      }
      /* What has the focus may be taken off the page while the dialog is open: a glance steps to the next record
         and draws its body anew, a row in a dialog is removed. The browser then leaves the focus on the body, under
         the dialog, where no key reaches it, and says so with no event. So the box is watched, and takes the focus
         itself when the element that had it is gone. */
      const page = node.ownerDocument;
      const entered = () => {
        within.current = true;
      };
      const left = (event: FocusEvent) => {
        if (!(event.relatedTarget instanceof Node) || !node.contains(event.relatedTarget)) within.current = event.relatedTarget === null;
      };
      const held = () => {
        const at = page.activeElement;
        if (within.current && node.isConnected && (!at || at === page.body)) node.focus({ preventScroll: true });
      };
      const named = () => {
        if (!closeLabel) return;
        const said = closeLabel.trim().toLowerCase();
        setOwnClose(
          [...node.querySelectorAll<HTMLElement>('button:not([data-slot="dialog-close"])')].some(
            (button) => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim().toLowerCase() === said,
          ),
        );
      };
      const watch = new MutationObserver(() => {
        held();
        named();
      });
      node.addEventListener('focusin', entered);
      node.addEventListener('focusout', left);
      watch.observe(node, { childList: true, subtree: true, characterData: true });
      named();
      /* The render that renames the dialog is the one that draws its body anew, and this callback is that render's:
         the last watcher was let go before the change and this one begins after it, so neither saw it. Asked once
         here, or the focus stayed on the page until something else in the box happened to change. */
      held();
      unwatch.current = () => {
        node.removeEventListener('focusin', entered);
        node.removeEventListener('focusout', left);
        watch.disconnect();
      };
    },
    [ariaLabel, headingId, closeLabel],
  );
  /* The scrim says which box it stands behind, by the box's first class, so a caller's stylesheet that knows the
     box (`lightbox`) can say what stands behind it (`[data-slot='dialog-backdrop'][data-for='lightbox']`). */
  const first = className.split(/\s+/)[0];
  // A plain box places itself, and its scrim is the caller's to paint: neither wears the modal's dress.
  const kind = plain ? 'plain' : 'modal';
  return (
    <Dialog
      container={popupContainer()}
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        if (!close()) details.cancel();
      }}
    >
      {backdrop ? <DialogBackdrop data-for={first || undefined} data-kind={kind} /> : null}
      <DialogContent
        ref={popup}
        className={className || undefined}
        data-kind={kind}
        data-component={componentScope}
        data-fullscreen={fullscreen === true ? 'always' : fullscreen === 'mobile' ? 'mobile' : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : labelledBy}
        aria-modal="true"
        initialFocus={initialFocus === false ? 'content' : initialFocus ? () => initialFocus.current : undefined}
        finalFocus={finalFocus ? () => finalFocus.current : undefined}
      >
        {children}
        {closeLabel && !ownClose && (
          <button
            type="button"
            data-slot="dialog-close"
            data-part="cross"
            aria-label={closeLabel}
            title={closeLabel}
            disabled={closeDisabled}
            onClick={() => close()}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Modal = slotted('Modal', DefaultModal);
