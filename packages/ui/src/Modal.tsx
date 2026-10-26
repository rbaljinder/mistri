/**
 * A modal, over Base UI's Dialog: what every dialog here used to get from
 * the native `<dialog>` — the scrim, focus held inside, Escape and a click
 * on the scrim to dismiss, focus handed back on close — in one place, and
 * the one thing the native element could not give: popups drawn inside it
 * (a listbox, a menu) that Base UI knows are its own.
 *
 * Open from the moment it mounts, gone when the caller unmounts it; the
 * caller hears `onClose` once, whichever way it closed, and can close it
 * itself through the handle. Wears the caller's classes — `confirm`,
 * `prefs`, `cols` — so the stylesheet and the browser suite see the box
 * they always saw, plus `modal` for the placement the element used to
 * supply, and a backdrop named after the first class for its scrim.
 */
import { useCallback, useContext, useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import { ComponentStyleScope } from './ComponentStyleScope.js';
import { Dialog } from '@base-ui/react/dialog';
import { popupContainer } from './popups.js';

export interface ModalHandle {
  close: () => void;
}

interface ModalProps {
  className: string;
  /** Told once, however the dialog closed. */
  onClose: () => void;
  /** A non-cancellable operation is awaiting acknowledgement. */
  closeDisabled?: boolean;
  /** Return false to keep the dialog open, for example while confirming discard. */
  beforeClose?: () => boolean;
  children: ReactNode;
  /** The control to focus on open; Base UI's default (the first focusable) otherwise. */
  initialFocus?: RefObject<HTMLElement | null> | false;
  /** Where focus goes on close, once the page is no longer inert; the element focused at open otherwise. */
  finalFocus?: RefObject<HTMLElement | null>;
  'aria-label'?: string;
  /** The box places itself — a panel that is its own scrim, a box the stylesheet already centres — so the `modal` placement is left off. */
  plain?: boolean;
  /** No scrim element: the box covers the screen itself. */
  backdrop?: boolean;
  /** Cover the viewport always, or only on narrow screens. Keeps dialog ownership. */
  /** `'mobile'` — the default — takes the whole screen under 640px, because a
      dialog that leaves a sliver of the page around it on a phone reads as a
      mistake rather than as a layer. `true` takes the whole screen at every
      width; `false` opts out, for a dialog small enough to be a confirmation
      and nothing more. */
  fullscreen?: boolean | 'mobile';
  ref?: Ref<ModalHandle>;
}

export function Modal({
  className,
  onClose,
  closeDisabled = false,
  beforeClose,
  children,
  initialFocus,
  finalFocus,
  'aria-label': ariaLabel,
  plain = false,
  backdrop = true,
  fullscreen = 'mobile',
  ref,
}: ModalProps) {
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
  /* A dialog with no `aria-label` is named by its first heading, which every one of these opens with: a screen reader
     announces "Delete invoice 7, dialog" rather than an unnamed dialog. Done when the box attaches, because the heading
     is the caller's children and the box mounts in a portal after this component's first effect. */
  const headingId = useId();
  const [labelledBy, setLabelledBy] = useState<string | undefined>();
  const popup = useCallback(
    (node: HTMLDivElement | null) => {
      if (ariaLabel || !node) return;
      const heading = node.querySelector<HTMLElement>('h1, h2, h3');
      if (!heading) return;
      if (!heading.id) heading.id = headingId;
      setLabelledBy(heading.id);
    },
    [ariaLabel, headingId],
  );
  const scrim = `modal-backdrop ${className.split(/\s+/)[0]}-backdrop`;
  const size = fullscreen ? ` modal-fullscreen${fullscreen === 'mobile' ? '-mobile' : ''}` : '';
  return (
    <Dialog.Root
      modal
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        if (!close()) details.cancel();
      }}
    >
      <Dialog.Portal container={popupContainer()}>
        {backdrop ? <Dialog.Backdrop className={plain ? scrim.replace('modal-backdrop ', '') : scrim} /> : null}
        <Dialog.Popup
          data-component={componentScope}
          className={`${plain ? className : `modal ${className}`}${size}`}
          initialFocus={initialFocus}
          {...(finalFocus ? { finalFocus } : {})}
          ref={popup}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : labelledBy}
          aria-modal="true"
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
