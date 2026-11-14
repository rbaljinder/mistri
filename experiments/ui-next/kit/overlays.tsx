import { X } from '@phosphor-icons/react';
import { Dialog, DialogBackdrop, DialogContent } from '@ui-sdk/react/dialog';
import { Drawer as Sheet, DrawerBackdrop, DrawerClose, DrawerContent, DrawerTitle } from '@ui-sdk/react/drawer';
import { Popover as Layer, PopoverContent, PopoverTrigger } from '@ui-sdk/react/popover';
import { Tooltip as Note, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip';
import { isValidElement, useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type ReactElement } from 'react';
import type { UiKitSlots } from '@mistriwork/ui/UiKit.js';
import { told } from './told';

/* Open from the moment it mounts, gone when the caller unmounts it; the caller hears `onClose` once, whichever
   way it closed, and can close it through the handle. `beforeClose` and `closeDisabled` refuse a close, which is
   said to UI SDK by cancelling the change. */
export const Modal: UiKitSlots['Modal'] = ({
  className,
  onClose,
  closeDisabled = false,
  beforeClose,
  children,
  initialFocus,
  finalFocus,
  ariaLabel,
  backdrop = true,
  fullscreen = 'mobile',
  ref,
}) => {
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
  /* A dialog with no name of its own is named by its first heading, which every one of these opens with. */
  const headingId = useId();
  const [labelledBy, setLabelledBy] = useState<string | undefined>();
  const box = useCallback(
    (node: HTMLElement | null) => {
      if (ariaLabel || !node) return;
      const heading = node.querySelector<HTMLElement>('h1, h2, h3');
      if (!heading) return;
      if (!heading.id) heading.id = headingId;
      setLabelledBy(heading.id);
    },
    [ariaLabel, headingId],
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        if (!close()) details.cancel();
      }}
    >
      {backdrop ? <DialogBackdrop /> : null}
      <DialogContent
        ref={box}
        className={className}
        data-kind="modal"
        data-fullscreen={fullscreen === true ? 'always' : fullscreen === 'mobile' ? 'mobile' : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : labelledBy}
        aria-modal="true"
        initialFocus={initialFocus === false ? 'content' : initialFocus ? () => initialFocus.current : undefined}
        finalFocus={finalFocus ? () => finalFocus.current : undefined}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
};

/* A sheet from an edge: a head with its title and a close control, then the caller's content. */
export const Drawer: UiKitSlots['Drawer'] = ({
  open,
  onOpenChange,
  side = 'right',
  title,
  ariaLabel,
  children,
  className,
  closeDisabled = false,
  closeLabel = 'Close',
}) => (
  <Sheet
    open={open}
    side={side}
    onOpenChange={(next, details) => {
      // A non-cancellable operation: a dismissal is refused and the drawer stays open.
      if (!next && closeDisabled) return details.cancel();
      onOpenChange?.(next, told('implicit', details));
    }}
  >
    <DrawerBackdrop />
    <DrawerContent data-kind="sheet" className={className} aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}>
      <header data-slot="sheet-head">
        {title !== undefined ? <DrawerTitle>{title}</DrawerTitle> : <span />}
        <DrawerClose aria-label={closeLabel} disabled={closeDisabled} data-variant="quiet">
          <X aria-hidden="true" />
        </DrawerClose>
      </header>
      <div data-slot="sheet-body">{children}</div>
    </DrawerContent>
  </Sheet>
);

/* The trigger is rendered as the trigger, not inside one: a button passed in would otherwise nest in a button. */
const element = (trigger: unknown): ReactElement<Record<string, unknown>> =>
  isValidElement<Record<string, unknown>>(trigger) ? trigger : <button type="button">{trigger as React.ReactNode}</button>;

export const Popover: UiKitSlots['Popover'] = ({ trigger, children, open, defaultOpen, onOpenChange, className, ariaLabel }) => (
  <Layer
    open={open}
    defaultOpen={defaultOpen}
    onOpenChange={onOpenChange && ((next, details) => onOpenChange(next, told('implicit', details)))}
  >
    <PopoverTrigger render={element(trigger)} />
    <PopoverContent className={className} aria-label={ariaLabel} sideOffset={8} collisionPadding={8}>
      {children}
    </PopoverContent>
  </Layer>
);

/* A short note on an element, said on hover and on focus alike. UI SDK gives the note its role and joins it to
   the trigger's description itself. */
export const Tooltip: UiKitSlots['Tooltip'] = ({ trigger, children, open, defaultOpen, onOpenChange, className }) => (
  <Note
    open={open}
    defaultOpen={defaultOpen}
    onOpenChange={onOpenChange && ((next, details) => onOpenChange(next, told('implicit', details)))}
  >
    <TooltipTrigger render={element(trigger)} />
    <TooltipContent className={className} sideOffset={8} collisionPadding={8}>
      {children}
    </TooltipContent>
  </Note>
);
