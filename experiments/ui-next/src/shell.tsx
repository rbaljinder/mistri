import { Bell, CaretDown, List, SidebarSimple, X } from '@phosphor-icons/react';
import { Drawer, DrawerBackdrop, DrawerClose, DrawerContent, DrawerTitle } from '@ui-sdk/react/drawer';
import { Popover as Pop, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover';
import { useShortcut } from '@ui-sdk/react/shortcuts';
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from './Button';
import { Avatar } from './display';
import { SensitiveField, TextField } from './fields';
import { type DropItem, DropMenu, Tip } from './overlays';
import { words } from './words';

/* What stands around every page of an App: the menu down the side, the bar over the page, and the page. */

export type NavItem = {
  id: string;
  label: string;
  href: string;
  icon?: ReactNode;
  /* A count at the item's end: what is waiting there. */
  count?: number;
  /* Shown, and goes nowhere yet. */
  idle?: boolean;
};
export type NavGroup = { label?: string; items: NavItem[] };

const PHONE = '(max-width: 56rem)';
const watch = (heard: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener('change', heard);
  return () => query.removeEventListener('change', heard);
};
const usePhone = (): boolean =>
  useSyncExternalStore(
    watch,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );

const typing = (): boolean =>
  !(document.activeElement instanceof HTMLElement && document.activeElement.matches('input, textarea, select, [contenteditable="true"]'));

export type AppShellProps = {
  /* The App's mark and name, at the head of the menu: a link home. */
  brand: { name: string; mark?: ReactNode; href: string };
  nav: NavGroup[];
  /* The room being read: its item is marked, and arriving in it from the menu puts the keyboard on the page. */
  current?: string;
  /* Where the menu stands: down the side, or along the bar with each group a menu of its own. */
  layout?: 'side' | 'top';
  /* Where the reader is, at the head of the bar. Left out, it is the current room under its group's name; `null`
     leaves it off for a page that says where it is itself. */
  trail?: ReactNode;
  /* The bar's own middle: the palette's box. */
  bar?: ReactNode;
  /* The bar's far end: a bell, the account. */
  end?: ReactNode;
  /* Under the menu: a note, a plan, a version. */
  foot?: ReactNode;
  /* A name to keep the menu's width under, in this browser. */
  remember?: string;
  children: ReactNode;
};

/* The menu, the bar and the page. The menu folds to its icons (its button, or `[`) and stays folded across
   visits; folded, each icon says its name when pointed at or reached, and one with something waiting wears a
   dot. Where the window is narrow the menu is a drawer behind a button in the bar, and choosing a room closes
   it. The first stop on the page is a link past the menu to the content. Choosing a room from the menu puts the
   keyboard on the page that arrives, so the next Tab is in what was asked for and not back at the top of the
   menu.

   The bar says where the reader is, and once the page has scrolled under it, that it is over something. The
   menu's head and the bar are one line across the window: the brand and the bar's controls share a centre. */
export function AppShell({ brand, nav, current, layout = 'side', trail, bar, end, foot, remember, children }: AppShellProps) {
  const store = remember ? `m-shell:${remember}` : undefined;
  const [folded, setFolded] = useState(() => {
    try {
      return store ? window.localStorage.getItem(store) === 'folded' : false;
    } catch {
      return false;
    }
  });
  const [drawer, setDrawer] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const phone = usePhone();
  const side = layout === 'side' && !phone;
  const top = layout === 'top' && !phone;
  const main = useRef<HTMLElement | null>(null);
  const mark = useRef<HTMLSpanElement | null>(null);
  const before = useRef(current);

  const fold = (next: boolean) => {
    setFolded(next);
    try {
      if (store) window.localStorage.setItem(store, next ? 'folded' : 'open');
    } catch {
      // Nothing kept: the menu still folds.
    }
  };
  useShortcut(side ? '[' : null, () => fold(!folded), { when: typing, description: folded ? words.openMenu : words.foldMenu });

  useEffect(() => {
    if (before.current === current) return;
    before.current = current;
    setDrawer(false);
    const from = document.activeElement;
    // Arriving from the menu (or its drawer, which has just closed and left the keyboard nowhere).
    if (from instanceof HTMLElement && (from.closest('[data-slot="shell-nav"]') || from === document.body)) {
      main.current?.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  }, [current]);

  // Whether the page has gone under the bar: a mark at the page's head leaves the window when it has.
  useEffect(() => {
    const el = mark.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const watch = new IntersectionObserver(([entry]) => setScrolled(entry ? !entry.isIntersecting : false));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const here = nav.flatMap((group) => group.items.filter((item) => item.id === current).map((item) => ({ group: group.label, item })))[0];
  const crumbs =
    trail === undefined ? (
      here ? (
        <nav data-slot="shell-trail" aria-label={words.youAreHere}>
          {here.group && <span>{here.group}</span>}
          <b aria-current="page">{here.item.label}</b>
        </nav>
      ) : null
    ) : (
      trail
    );

  const link = (item: NavItem, iconsOnly: boolean) => {
    const one = (
      <a
        key={item.id}
        href={item.href}
        aria-current={item.id === current ? 'page' : undefined}
        aria-disabled={item.idle || undefined}
        data-idle={item.idle ? '' : undefined}
        aria-label={iconsOnly ? (item.count === undefined ? item.label : `${item.label}, ${item.count}`) : undefined}
        onClick={(click) => {
          if (item.idle) click.preventDefault();
        }}
      >
        {item.icon && (
          <span data-slot="shell-nav-icon" aria-hidden="true">
            {item.icon}
            {iconsOnly && item.count !== undefined && item.count > 0 && <i data-slot="shell-nav-dot" />}
          </span>
        )}
        <span data-slot="shell-nav-label">{item.label}</span>
        {item.count !== undefined && <span data-slot="shell-nav-count">{item.count.toLocaleString()}</span>}
      </a>
    );
    return iconsOnly ? (
      <Tip key={item.id} hint={item.label} side="right">
        {one}
      </Tip>
    ) : (
      one
    );
  };
  const menu = (iconsOnly: boolean) => (
    <nav data-slot="shell-nav" aria-label={words.rooms}>
      {nav.map((group, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={group.label ?? index} data-slot="shell-nav-group">
          {group.label && <p>{group.label}</p>}
          {group.items.map((item) => link(item, iconsOnly))}
        </div>
      ))}
    </nav>
  );
  /* Along the bar: rooms with no group are links, and a group is a menu under its name, marked when the room
     being read is in it. */
  const along = (
    <nav data-slot="shell-topnav" aria-label={words.rooms}>
      {nav.map((group, index) =>
        group.label === undefined ? (
          group.items.map((item) => link(item, false))
        ) : (
          <DropMenu
            // eslint-disable-next-line react/no-array-index-key
            key={group.label ?? index}
            quiet
            align="start"
            trigger={
              <span data-slot="shell-topnav-group" data-current={group.items.some((item) => item.id === current) ? '' : undefined}>
                {group.label}
                <CaretDown aria-hidden="true" />
              </span>
            }
            items={group.items.map((item) => ({
              value: item.id,
              label: item.label,
              icon: item.icon,
              disabled: item.idle,
              hint: item.count === undefined ? undefined : item.count.toLocaleString(),
            }))}
            onAction={(id) => {
              const item = group.items.find((each) => each.id === id);
              if (item) window.location.assign(item.href);
            }}
          />
        ),
      )}
    </nav>
  );
  const brandLink = (iconsOnly: boolean) => (
    <a href={brand.href} data-slot="shell-brand" aria-label={iconsOnly ? brand.name : undefined}>
      {brand.mark && (
        <span data-slot="shell-brand-mark" aria-hidden="true">
          {brand.mark}
        </span>
      )}
      <span data-slot="shell-nav-label">{brand.name}</span>
    </a>
  );

  return (
    <div
      data-slot="shell"
      data-layout={phone ? 'phone' : layout}
      data-folded={folded && side ? '' : undefined}
      data-phone={phone ? '' : undefined}
      data-scrolled={scrolled ? '' : undefined}
    >
      <a
        href="#content"
        data-slot="shell-skip"
        onClick={(click) => {
          click.preventDefault();
          main.current?.focus();
        }}
      >
        {words.skipToContent}
      </a>
      {side && (
        <aside data-slot="shell-rail">
          <div data-slot="shell-rail-head">{brandLink(folded)}</div>
          <div data-slot="shell-rail-body">{menu(folded)}</div>
          {foot && !folded && <div data-slot="shell-foot">{foot}</div>}
        </aside>
      )}
      <div data-slot="shell-pane">
        <header data-slot="shell-bar">
          {phone && (
            <Button
              intent="quiet"
              size="sm"
              data-part="shell-fold"
              aria-label={words.openMenu}
              aria-expanded={drawer}
              onClick={() => setDrawer(true)}
            >
              <List aria-hidden="true" />
            </Button>
          )}
          {side && (
            <Tip hint={`${folded ? words.openMenu : words.foldMenu} [`}>
              <Button
                intent="quiet"
                size="sm"
                data-part="shell-fold"
                aria-label={folded ? words.openMenu : words.foldMenu}
                aria-expanded={!folded}
                onClick={() => fold(!folded)}
              >
                <SidebarSimple aria-hidden="true" />
              </Button>
            </Tip>
          )}
          {top && brandLink(false)}
          {top ? along : crumbs}
          <div data-slot="shell-bar-middle">{bar}</div>
          <div data-slot="shell-bar-end">{end}</div>
        </header>
        <main ref={main} id="content" tabIndex={-1} data-slot="shell-main">
          <span ref={mark} data-slot="shell-mark" aria-hidden="true" />
          {children}
        </main>
      </div>
      {phone && (
        <Drawer open={drawer} onOpenChange={setDrawer} side="left">
          <DrawerBackdrop />
          <DrawerContent data-kind="shell-drawer">
            <header>
              <DrawerTitle data-kind="visually-hidden">{words.rooms}</DrawerTitle>
              {brandLink(false)}
              <DrawerClose aria-label={words.close} data-variant="quiet">
                <X aria-hidden="true" />
              </DrawerClose>
            </header>
            {menu(false)}
            {foot && <div data-slot="shell-foot">{foot}</div>}
          </DrawerContent>
        </Drawer>
      )}
    </div>
  );
}

export type Notice = { id: string; title: string; detail?: string; when?: string; unread?: boolean; href?: string };

/* What is waiting for the reader, behind a bell that says how many are new, in words as well as in a dot. Opening
   one marks it read; one press marks them all. */
export function InboxBell({
  notices,
  onOpen,
  onReadAll,
}: {
  notices: Notice[];
  onOpen?: (notice: Notice) => void;
  onReadAll?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const unread = notices.filter((notice) => notice.unread).length;
  return (
    <Pop open={open} onOpenChange={setOpen}>
      <PopoverTrigger aria-label={words.notices(unread)} data-variant="quiet" data-part="bell">
        <Bell aria-hidden="true" />
        {unread > 0 && (
          <span data-slot="bell-count" aria-hidden="true">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} data-part="inbox">
        <header>
          <PopoverTitle>{words.noticesTitle}</PopoverTitle>
          {unread > 0 && onReadAll && (
            <Button size="sm" intent="quiet" onClick={onReadAll}>
              {words.markAllRead}
            </Button>
          )}
        </header>
        {notices.length === 0 ? (
          <p data-slot="inbox-empty">{words.nothingWaiting}</p>
        ) : (
          <ul>
            {notices.map((notice) => (
              <li key={notice.id} data-unread={notice.unread ? '' : undefined}>
                <a
                  href={notice.href ?? '#'}
                  onClick={(click) => {
                    if (click.metaKey || click.ctrlKey || click.shiftKey) return;
                    if (!notice.href) click.preventDefault();
                    onOpen?.(notice);
                    setOpen(false);
                  }}
                >
                  <span data-slot="inbox-dot" aria-hidden="true" />
                  <span data-slot="inbox-words">
                    <b>
                      {notice.unread && <span data-kind="visually-hidden">{words.unread} </span>}
                      {notice.title}
                    </b>
                    {notice.detail && <span>{notice.detail}</span>}
                  </span>
                  {notice.when && <time>{notice.when}</time>}
                </a>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Pop>
  );
}

/* The reader's own menu, behind their disc. */
export function AccountMenu({
  name,
  items,
  onAction,
  src,
}: {
  name: string;
  items: DropItem[];
  onAction: (value: string) => void;
  src?: string;
}) {
  // Named by what it holds (the word, then the disc as the person's name), so the initials seen are not a label
  // that says something else.
  return (
    <DropMenu
      quiet
      trigger={
        <>
          <span data-kind="visually-hidden">{words.account}</span>
          <Avatar name={name} src={src} size="sm" alone />
        </>
      }
      items={items}
      onAction={onAction}
    />
  );
}

export type SignInProps = {
  /* What is being signed in to. */
  name: string;
  mark?: ReactNode;
  /* Asked with what was typed. What it throws is said under the form, and the words stay. */
  onSubmit: (answer: { email: string; password: string }) => void | Promise<void>;
  /* Other ways in, each a button over the form. */
  providers?: { id: string; label: string; icon?: ReactNode }[];
  onProvider?: (id: string) => void;
  /* Under the form: a way to reset a password, to ask for an account. */
  foot?: ReactNode;
};

/* The way in: an address and a password, said plainly. A refusal is said once, under the form, and puts the
   keyboard back on the password with what was typed still there, since the usual fix is to type it again. The
   password field says when Caps Lock is on, which is the usual reason it was wrong. */
export function SignIn({ name, mark, onSubmit, providers, onProvider, foot }: SignInProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [missing, setMissing] = useState<{ email?: string; password?: string }>({});
  const [caps, setCaps] = useState(false);
  const form = useRef<HTMLFormElement | null>(null);
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const said = new FormData(event.currentTarget);
    const email = String(said.get('email') ?? '').trim();
    const password = String(said.get('password') ?? '');
    const lacking = { email: email ? undefined : words.emailNeeded, password: password ? undefined : words.passwordNeeded };
    setMissing(lacking);
    setProblem(null);
    if (lacking.email || lacking.password) {
      form.current?.querySelector<HTMLElement>(lacking.email ? 'input[name="email"]' : 'input[name="password"]')?.focus();
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ email, password });
    } catch (error) {
      setProblem(error instanceof Error && error.message ? error.message : words.signInRefused);
      form.current?.querySelector<HTMLInputElement>('input[name="password"]')?.select();
    } finally {
      setBusy(false);
    }
  };
  const lock = (event: KeyboardEvent<HTMLElement>) => setCaps(event.getModifierState?.('CapsLock') ?? false);
  return (
    <div data-slot="sign-in">
      <header>
        {mark && (
          <span data-slot="shell-brand-mark" aria-hidden="true">
            {mark}
          </span>
        )}
        <h1>{words.signInTo(name)}</h1>
      </header>
      {providers && providers.length > 0 && (
        <>
          <div data-slot="sign-in-providers">
            {providers.map((provider) => (
              <Button key={provider.id} block onClick={() => onProvider?.(provider.id)}>
                {provider.icon}
                {words.continueWith(provider.label)}
              </Button>
            ))}
          </div>
          <p data-slot="sign-in-or">
            <span>{words.or}</span>
          </p>
        </>
      )}
      <form ref={form} noValidate onSubmit={(event) => void send(event)} aria-label={words.signInTo(name)}>
        <TextField label={words.email} name="email" type="email" autoComplete="username" inputMode="email" error={missing.email} />
        <div onKeyDown={lock} onKeyUp={lock}>
          <SensitiveField label={words.password} name="password" error={missing.password} hint={caps ? words.capsLock : undefined} />
        </div>
        {problem && (
          <p data-slot="sign-in-problem" role="alert">
            {problem}
          </p>
        )}
        <Button type="submit" intent="primary" block busy={busy}>
          {words.signIn}
        </Button>
      </form>
      {foot && <footer>{foot}</footer>}
    </div>
  );
}
