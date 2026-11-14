import { X } from '@phosphor-icons/react';
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@ui-sdk/react/alert-dialog';
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@ui-sdk/react/dialog';
import { Drawer, DrawerBackdrop, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@ui-sdk/react/drawer';
import { Menu, MenuContent, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from '@ui-sdk/react/menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip';
import { useShortcut } from '@ui-sdk/react/shortcuts';
import { type ReactElement, type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { words } from './words';

/* The overlays, each a head, a body that scrolls and a foot that does not. The caller owns whether one is open,
   so a menu item, a row or a shortcut can open it as well as a button. */

type Sheet = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  /* The verbs, usually an ActionBar's children: they stay in view while the body scrolls. */
  footer?: ReactNode;
  /* Something has been entered that closing would lose. Escape, a press outside and the cross then ask first, in
     the sheet's own foot, and only Discard closes it. */
  unsaved?: boolean;
  /* False where nothing but the sheet's own buttons may close it (a step that must be finished): no cross, and
     Escape and a press outside do nothing. */
  dismissible?: boolean;
};

/* What a sheet does when it is asked to close with something unsaved in it. It does not open a second dialog over
   the first, which is a dialog about a dialog: the question takes the place of the sheet's foot, Keep editing has
   the keyboard, and what was typed stays in view behind the question while it is answered. */
function useGuard({ open, onOpenChange, unsaved, dismissible = true }: Pick<Sheet, 'open' | 'onOpenChange' | 'unsaved' | 'dismissible'>) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!open || !unsaved) setAsking(false);
  }, [open, unsaved]);
  const guarded = unsaved === true;
  return {
    asking,
    /* What the dialog itself is told: it may be dismissed only when nothing would be lost. */
    dismissible: dismissible && !guarded,
    onDismissAttempt: () => {
      if (guarded && dismissible) setAsking(true);
    },
    /* The cross, which a dialog's own Close part would let through unasked. */
    cross: !dismissible ? null : guarded ? (
      <button
        type="button"
        data-slot="button"
        data-variant="quiet"
        data-kind="sheet-close"
        aria-label={words.close}
        onClick={() => setAsking(true)}
      >
        <X aria-hidden="true" />
      </button>
    ) : undefined,
    question: asking ? (
      <footer data-slot="sheet-foot" data-kind="guard" role="alert">
        <span>{words.discardAsk}</span>
        <button type="button" data-slot="button" data-variant="quiet" autoFocus onClick={() => setAsking(false)}>
          {words.keepEditing}
        </button>
        <button type="button" data-slot="button" data-variant="destructive" onClick={() => onOpenChange(false)}>
          {words.discard}
        </button>
      </footer>
    ) : null,
  };
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size,
  unsaved,
  dismissible,
}: Sheet & { size?: 'md' | 'lg' }) {
  const guard = useGuard({ open, onOpenChange, unsaved, dismissible });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} dismissible={guard.dismissible} onDismissAttempt={guard.onDismissAttempt}>
      <DialogBackdrop />
      <DialogContent data-kind="sheet" data-size={size}>
        <header data-slot="sheet-head">
          <div>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </div>
          {guard.cross === undefined ? (
            <DialogClose aria-label={words.close} data-variant="quiet">
              <X aria-hidden="true" />
            </DialogClose>
          ) : (
            guard.cross
          )}
        </header>
        <div data-slot="sheet-body">{children}</div>
        {guard.question ?? (footer && <footer data-slot="sheet-foot">{footer}</footer>)}
      </DialogContent>
    </Dialog>
  );
}

/* Whether the window has room for a panel and the page beside it at once. */
const ROOMY = '(min-width: 64rem)';
const watch = (heard: () => void) => {
  const query = window.matchMedia(ROOMY);
  query.addEventListener('change', heard);
  return () => query.removeEventListener('change', heard);
};
const useRoomy = (): boolean =>
  useSyncExternalStore(
    watch,
    () => window.matchMedia(ROOMY).matches,
    () => false,
  );

/* A panel from the side: the list stays in view behind it, which is why a New form opens here.

   `beside` is for a panel that shows what a row is, not one that asks for something. Where the window has room, it
   takes nothing from the page: no dim, no trap, the list under it still answers, and pressing another row changes
   what the panel shows. A reader comparing rows then never closes anything. On a narrow window the panel is the
   whole screen, so there it is the ordinary one.

   The page is told the panel is there (`data-m-beside` on the root, the width it takes in `--m-beside`), so what
   stands under it can step aside instead of being covered: a list's last columns, its pager and its selection bar
   would otherwise be out of reach for as long as the panel is open. */
export function SidePanel({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  beside,
  side = 'right',
  unsaved,
  dismissible,
}: Sheet & { beside?: boolean; /* The edge it comes from. */ side?: 'right' | 'left' }) {
  const live = useRoomy() && beside === true;
  const guard = useGuard({ open, onOpenChange, unsaved, dismissible });
  useEffect(() => {
    if (!live || !open) return;
    const page = document.documentElement;
    page.setAttribute('data-m-beside', '');
    return () => page.removeAttribute('data-m-beside');
  }, [live, open]);
  /* The panel does not hold the keyboard, so Escape has to reach it from the list as well: it closes the panel
     unless something over the page (a dialog, a menu) has the better claim to the key. */
  useShortcut(live && open ? 'escape' : null, () => onOpenChange(false), {
    when: () => !document.querySelector('[aria-modal="true"], [role="menu"], [role="listbox"]:popover-open'),
    description: words.closePanel,
  });
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      side={side}
      modal={!live}
      dismissible={guard.dismissible}
      onDismissAttempt={guard.onDismissAttempt}
    >
      {!live && <DrawerBackdrop />}
      <DrawerContent data-kind="sheet" data-beside={live ? '' : undefined}>
        <header data-slot="sheet-head">
          <div>
            <DrawerTitle>{title}</DrawerTitle>
            {description && <DrawerDescription>{description}</DrawerDescription>}
          </div>
          {guard.cross === undefined ? (
            <DrawerClose aria-label={words.close} data-variant="quiet">
              <X aria-hidden="true" />
            </DrawerClose>
          ) : (
            guard.cross
          )}
        </header>
        <div data-slot="sheet-body">{children}</div>
        {guard.question ?? (footer && <footer data-slot="sheet-foot">{footer}</footer>)}
      </DrawerContent>
    </Drawer>
  );
}

export type ConfirmProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirm: string;
  cancel?: string;
  /* A confirmation that destroys says so in the critical tone, and what it destroys in its description. */
  danger?: boolean;
  onConfirm: () => void;
};

export function Confirm({ open, onOpenChange, title, description, confirm, cancel, danger, onConfirm }: ConfirmProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-kind="confirm">
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        <div data-slot="action-bar">
          <AlertDialogClose data-variant="quiet">{cancel ?? words.cancel}</AlertDialogClose>
          <AlertDialogClose
            value="confirm"
            data-variant={danger ? 'danger-solid' : 'solid'}
            data-agent-confirm={danger ? description : undefined}
            onClick={onConfirm}
          >
            {confirm}
          </AlertDialogClose>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type DropItem = {
  value: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  separated?: boolean;
  /* The item cannot be chosen now. It stays in the menu, so the reader sees it exists. */
  disabled?: boolean;
  /* A word at the item's end: its shortcut, a count. */
  hint?: ReactNode;
  /* A heading over this item and the ones after it. */
  heading?: string;
};

export function DropMenu({
  label,
  trigger,
  items,
  onAction,
  align,
  quiet,
}: {
  /* The trigger's name, for one that is only an icon. */
  label?: string;
  trigger: ReactNode;
  items: DropItem[];
  onAction: (value: string) => void;
  align?: 'start' | 'end';
  quiet?: boolean;
}) {
  return (
    <Menu onAction={(value) => onAction(String(value))}>
      <MenuTrigger aria-label={label} data-variant={quiet ? 'quiet' : undefined}>
        {trigger}
      </MenuTrigger>
      <MenuContent align={align ?? 'end'}>
        {items.map((item) => (
          <div key={item.value} style={{ display: 'contents' }}>
            {item.separated && <MenuSeparator />}
            {item.heading && <MenuGroupLabel>{item.heading}</MenuGroupLabel>}
            <MenuItem value={item.value} disabled={item.disabled} data-tone={item.danger ? 'critical' : undefined}>
              {item.icon}
              {item.label}
              {item.hint && <span data-slot="menu-item-hint">{item.hint}</span>}
            </MenuItem>
          </div>
        ))}
      </MenuContent>
    </Menu>
  );
}

/* A hint on whatever it wraps: the child is the trigger, so a button keeps its own look. */
export function Tip({
  hint,
  side,
  children,
}: {
  hint: string;
  /* Which side of what it is about it stands on, where the usual one would cover something. */
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: ReactElement<Record<string, unknown>>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>{hint}</TooltipContent>
    </Tooltip>
  );
}
