/**
 * The app's menu as a top bar.
 *
 * The authored hierarchy becomes nested desktop menus; root destinations
 * stand alone, and so do the entries of a group that says `inline`. The current room lights its item, and the group holding it
 * lights too. Available header space decides whether the strip fits; phones
 * use one folded menu — labelled sections when the groups are one level
 * deep, a drill-in when any group nests another. The folded menu stays
 * within the viewport and scrolls independently. The search field at the
 * end is the palette wearing a box.
 *
 * One menu open at a time, and none after the pointer or the keyboard has
 * left: outside click and Escape close whatever is open.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from '@ui-sdk/react/menu';
import { message, messageLanguage, subscribeMessages } from '@mistriwork/kit/client/messages.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { NavGlyph } from '@mistriwork/kit/client/components/NavGlyph.js';
import { go, pageView, subscribeWalk, tableView, toast, state } from '@mistriwork/kit/client/core.js';
import { openPalette } from '@mistriwork/kit/client/palette.js';
import { prefetchList } from '@mistriwork/kit/client/components/listRowsPress.js';
import { appListQuery, currentNavIndex } from '@mistriwork/kit/client/components/appListModel.js';
import {
  ASSISTANT_PAGE,
  DIRECTORY_PAGE,
  appMenu,
  dashPageId,
  dashViewKey,
  formPageId,
  formViewKey,
  homeRoom,
  isAssistantRoom,
  isListRoom,
  roomPageId,
  type MenuEntry,
} from '@mistriwork/kit/client/components/appRooms.js';
import type { WalkEntry } from '@mistriwork/kit/client/components/walk.js';
import {
  navigationContains,
  navigationNests,
  navigationPaths,
  type AvailableNavigationNode,
  type NavigationTargetNode,
} from '@mistriwork/kit/client/components/navigationTree.js';
import { appNavTargetKey, useAppNavTargetState, refreshAppNavTargets, type NavTargetApp } from '../appNavTargets.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { AppPayloadNavNode } from '../../shared/appPayload.js';
import { isFormView } from '../../shared/appModel.js';
import { openFavorite, shownFavorites } from '@mistriwork/kit/client/components/favoriteNav.js';
import { favoriteId, favoritesVersion, subscribeFavorites } from '@mistriwork/kit/client/components/favorites.js';
import { say } from '@mistriwork/kit/client/copy/shell/components/TopNav.js';
import { shellById, shellRoot } from '@mistriwork/kit/client/shellHost.js';

interface TopNavProps {
  /** The served App, whose nav the bar draws. */
  app: NavTargetApp;
  /** The bar's element, which the tree is drawn straight into. */
  host: HTMLElement;
}

/** Retain authored group controls during checks, never the retired target leaves. */
function pendingGroups(
  nav: readonly AppPayloadNavNode[],
  available: AvailableNavigationNode<MenuEntry>[],
): AvailableNavigationNode<MenuEntry>[] {
  const hasTarget = (nodes: readonly AppPayloadNavNode[]): boolean =>
    nodes.some((node) => 'to' in node || ('group' in node && hasTarget(node.children)));
  return nav.flatMap((node): AvailableNavigationNode<MenuEntry>[] => {
    if ('to' in node) return [];
    if ('view' in node) {
      const label = node.label;
      const found = available.find(
        (candidate) => candidate.kind === 'destination' && candidate.entry.id === node.view && candidate.entry.label === label,
      );
      return found ? [found] : [];
    }
    const found = available.find((candidate) => candidate.kind === 'group' && candidate.id === node.group);
    const children = pendingGroups(node.children, found?.kind === 'group' ? found.children : []);
    return children.length || hasTarget(node.children)
      ? [{ kind: 'group', id: node.group, label: node.label, icon: node.icon, children }]
      : [];
  });
}

/* The schema the strip last read, by when it was replaced: a new one is a new strip. */
let schemaSeen: unknown;
let schemaCount = 0;
const schemaTick = () => (state.schema === schemaSeen ? schemaCount : ((schemaSeen = state.schema), ++schemaCount));

export function TopNav({ app, host }: TopNavProps) {
  useSyncExternalStore(subscribeMessages, messageLanguage, messageLanguage);
  const [open, setOpen] = useState<string | null>(null);
  const [folded, setFolded] = useState(false);
  const [placed, setPlaced] = useState(false);
  useEffect(() => setPlaced(true), []);
  const [compactSearch, setCompactSearch] = useState(false);
  const [menuPath, setMenuPath] = useState<string[]>([]);
  const returnGroup = useRef<string | null>(null);
  const links = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLButtonElement>(null);
  const schema = state.schema as DatabaseSchema | null;
  const { hrefs: targetHrefs, pending } = useAppNavTargetState(app, schema);
  const availableTree = appMenu(app, (target) => targetHrefs.get(appNavTargetKey(target)));
  const tree = pending ? pendingGroups(app.nav, availableTree) : availableTree;
  const refreshTargets = () => refreshAppNavTargets(app, schema);
  useSyncExternalStore(subscribeFavorites, favoritesVersion, favoritesVersion);
  /* Starred records and views, first: one menu of the reader's own. */
  const starred = shownFavorites(app);
  const favoriteItems = starred.map((favorite) => (
    <MenuItem
      key={favoriteId(favorite)}
      render={<button type="button" className="tn-popitem tn-favorite" />}
      onSelect={() => {
        setOpen(null);
        openFavorite(app, favorite);
      }}
    >
      <span>{favorite.label}</span>
    </MenuItem>
  ));
  const favoritesSection =
    starred.length > 0 ? (
      <MenuGroup key="favorites" className="tn-folded-section">
        <MenuGroupLabel className="tn-folded-label">{say('common.favorites')}</MenuGroupLabel>
        {favoriteItems}
      </MenuGroup>
    ) : null;
  const tables = navigationPaths(tree)
    .map((path) => path.entry)
    .filter(isListRoom);
  /* Which room is current. A dashboard by its view key; a table by the
     walk's query, preferring the module whose standing conditions lead it.
     With nothing on the walk the visitor is on the home the server served
     them, so its room is lit, a dashboard or a list. */
  const lit = () => {
    const here = (state.stack as WalkEntry[]).at(-1);
    const home = here ? undefined : homeRoom(app);
    const dashView =
      here?.kind === 'page' && dashViewKey(here.pageId) !== undefined
        ? dashViewKey(here.pageId)!
        : home && 'sections' in home
          ? home.id
          : null;
    const formView =
      here?.kind === 'page' && formViewKey(here.pageId) !== undefined
        ? formViewKey(here.pageId)!
        : home && isFormView(home)
          ? home.id
          : null;
    const currentTable =
      here?.table && !dashView && !formView
        ? tables[currentNavIndex(tables, here.table ?? '', here.query ?? '', here.view)]
        : home && isListRoom(home)
          ? tables.find((entry) => entry.id === home.id)
          : undefined;
    return {
      dashView,
      formView,
      currentTable,
      onAssistant: here?.kind === 'page' && here.pageId === ASSISTANT_PAGE,
      onDirectory: here?.kind === 'page' && here.pageId === DIRECTORY_PAGE,
    };
  };
  /* The strip is drawn again when the walk changes what it lights, or the schema it reads under it, not on every
     paint: a sort or a filter drew every group's menu again inside its click (test/built-client-vitals.mjs). */
  const litWords = () => {
    const now = lit();
    return [now.dashView, now.formView, tables.indexOf(now.currentTable!), now.onAssistant, now.onDirectory, schemaTick()].join('\n');
  };
  useSyncExternalStore(subscribeWalk, litWords, litWords);
  const { dashView, formView, currentTable, onAssistant, onDirectory } = lit();
  const isCurrent = (entry: MenuEntry) =>
    isAssistantRoom(entry)
      ? onAssistant
      : 'sections' in entry
        ? Boolean(dashView) && entry.id === dashView
        : isFormView(entry)
          ? entry.id === formView
          : entry === currentTable;

  const visit = (entry: MenuEntry) => {
    setOpen(null);
    if (entry.error) {
      toast(entry.error, 'error');
      return;
    }
    if (isListRoom(entry)) go({ ...tableView(entry.table, appListQuery(entry)), view: entry.id }, 'reset');
    else go(pageView(roomPageId(entry)!, undefined, undefined, entry.label), 'reset');
  };

  /* A room in the strip is a button; a room in a menu is the menu's item,
     drawn as the same button so the stylesheet and the highlight see one
     thing. Items carry the same data-table/data-navq the sidebar rows do. */
  const item = (entry: MenuEntry, inPop: boolean): ReactNode => {
    const dash = 'sections' in entry;
    const list = isListRoom(entry) ? entry : undefined;
    const key = list ? `t:${list.id ?? list.table}:${list.query ?? ''}` : dash ? `d:${entry.id}` : `f:${entry.id}`;
    const shared = {
      className: `${inPop ? 'tn-popitem' : 'tn-item'}${!dash && entry.error ? ' nav-missing' : ''}`,
      'data-dash': dash ? dashPageId(entry.id) : undefined,
      'data-form': isFormView(entry) ? formPageId(entry.id) : isAssistantRoom(entry) ? ASSISTANT_PAGE : undefined,
      'data-table': list?.table,
      'data-navq': list ? (list.query ?? '') : undefined,
      'aria-current': isCurrent(entry),
      title: !dash ? (entry.error ?? undefined) : undefined,
      /* A press, or Enter, begins the list's first reads while the button is still down (listRowsPress.ts); hovering asks nothing. */
      ...(list
        ? {
            onPointerDown: () => prefetchList(list),
            onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
              if (event.key === 'Enter') prefetchList(list);
            },
          }
        : {}),
    };
    if (!inPop)
      return (
        <button key={key} type="button" {...shared} onClick={() => visit(entry)}>
          <NavGlyph icon={entry.icon} label={entry.label} color={entry.navColor} />
          <span>{entry.label}</span>
        </button>
      );
    return (
      <MenuItem key={key} render={<button type="button" {...shared} />} onSelect={() => visit(entry)}>
        <NavGlyph icon={entry.icon} label={entry.label} color={entry.navColor} />
        <span>{entry.label}</span>
      </MenuItem>
    );
  };
  const targetItem = (node: NavigationTargetNode, inPop: boolean): ReactNode => {
    const content = (
      <>
        <NavGlyph label={node.label} color={node.color} />
        <span>{node.label}</span>
      </>
    );
    const anchor = <a className={`${inPop ? 'tn-popitem' : 'tn-item'} app-nav-target`} href={node.href} />;
    return inPop ? (
      <MenuItem key={`target:${node.label}:${node.href}`} render={anchor}>
        {content}
      </MenuItem>
    ) : (
      <a key={`target:${node.label}:${node.href}`} className="tn-item app-nav-target" href={node.href}>
        {content}
      </a>
    );
  };

  /* One group's menu. Kept in the strip rather than portalled, and kept
     mounted while closed, so `#topnav [data-dash]` and its siblings are
     always there to be asked which room is current. */
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const focusedPopup = useRef<HTMLElement | null>(null);
  const keyboardSubmenu = useRef<HTMLElement | null>(null);
  const loading = (
    <div role="status" className="tn-popitem" aria-label={message('common.loading')}>
      {message('common.loading')}
    </div>
  );
  const group = (
    key: string,
    label: ReactNode,
    buttonClass: string,
    popClass: string,
    ariaLabel: string | undefined,
    children: ReactNode,
  ) => (
    <Menu
      open={open === key}
      onOpenChange={(next) => {
        if (next) refreshTargets();
        setOpen(next ? key : null);
        setMenuPath([]);
      }}
    >
      <MenuTrigger
        className={buttonClass}
        // The bar's own item, whole: none of the control's button dress under its classes.
        data-own=""
        aria-label={ariaLabel}
        ref={(el: HTMLButtonElement | null) => {
          triggers.current[key] = el;
        }}
      >
        {label}
        <Icon name="caret-down" className="tn-caret" />
      </MenuTrigger>
      {/* Under the button, flush with its left edge. Drawn once the strip is on the page (`placed`), so the kept
          menus stand after it in the bar: a menu drawn in the strip's own first render is put in the bar before the
          strip, and `#topnav [data-form]` then found a closed menu's entry ahead of the strip's own. */}
      {placed && (
        <MenuContent
          keepMounted
          container={host}
          side="bottom"
          align="start"
          sideOffset={1}
          collisionPadding={8}
          className={popClass}
          aria-label={key === 'folded' ? menuLabel : ariaLabel}
          aria-busy={pending || undefined}
          onFocusCapture={(event) => {
            if ((event.target as HTMLElement).closest('[role="menu"]') === event.currentTarget) focusedPopup.current = event.currentTarget;
          }}
        >
          {children}
          {pending && loading}
        </MenuContent>
      )}
    </Menu>
  );

  /* An App without nav has no menu: its one room, its home, is in no tree,
     and with nothing to draw there is no fold. Folded, groups one level
     deep become labelled sections of one menu, every room a tap away; only
     a group that nests another makes the fold a drill-in, levels deep. */
  const structured = navigationNests(tree);
  let menuChildren = tree;
  let menuLabel = message('navigation.menu');
  for (const id of menuPath) {
    const node = menuChildren.find((node) => node.kind === 'group' && node.id === id);
    if (node?.kind !== 'group') break;
    menuChildren = node.children;
    menuLabel = node.label;
  }
  const popNode = (node: AvailableNavigationNode<MenuEntry>): ReactNode => {
    if (node.kind === 'target') return targetItem(node, true);
    if (node.kind === 'destination') return item(node.entry, true);
    return (
      <MenuSub
        key={node.id}
        onOpenChange={(next) => {
          if (next) refreshTargets();
        }}
      >
        <MenuSubTrigger
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') keyboardSubmenu.current = event.currentTarget;
          }}
          render={
            <button
              type="button"
              className="tn-popitem tn-subgroup"
              data-nav-group={node.id}
              data-active={navigationContains(node, isCurrent) || undefined}
            />
          }
        >
          <span>
            <NavGlyph icon={node.icon} label={node.label} />
            {node.label}
          </span>
          <Icon name="caret-right" />
        </MenuSubTrigger>
        <MenuSubContent
          container={host}
          side="right"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="tn-pop"
          aria-label={node.label}
          aria-busy={pending || undefined}
          onFocusCapture={(event) => {
            if ((event.target as HTMLElement).closest('[role="menu"]') === event.currentTarget) focusedPopup.current = event.currentTarget;
          }}
        >
          {node.children.map(popNode)}
          {pending && loading}
        </MenuSubContent>
      </MenuSub>
    );
  };
  const back = () => {
    returnGroup.current = menuPath.at(-1) ?? null;
    setMenuPath((path) => path.slice(0, -1));
  };
  useLayoutEffect(() => {
    if (!open) return;
    // A menu that opens with no item in it, while checks run, leaves the keyboard on the button that opened it (or
    // on the popup, if it was already in there). Once items arrive, give the keyboard its first item without
    // closing/reopening (and rechecking).
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      const previous = focusedPopup.current;
      const requested = keyboardSubmenu.current;
      const opening =
        focused === requested && requested?.getAttribute('aria-expanded') === 'true'
          ? shellById(requested.getAttribute('aria-controls') ?? '')
          : null;
      if (!pending) keyboardSubmenu.current = null;
      const waiting = focused === previous || focused === triggers.current[open] || focused === document.body || !focused?.isConnected;
      if (!opening && !waiting) return;
      const popup =
        opening ??
        (previous?.isConnected && previous.hasAttribute('data-open')
          ? previous
          : host.querySelector<HTMLElement>('[role="menu"][data-open]'));
      if (popup) {
        const first = !pending && popup.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
        (first || popup).focus();
      } else if (!pending) {
        setOpen(null);
        (folded ? triggers.current.folded : links.current?.querySelector<HTMLElement>('button, a[href]'))?.focus();
        if (document.activeElement === document.body) search.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [pending, targetHrefs, open, folded, host]);
  useLayoutEffect(() => {
    if (open !== 'folded' || !structured) return;
    const frame = requestAnimationFrame(() => {
      const popup = host.querySelector('.tn-drill-pop');
      const buttons = Array.from(popup?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
      const target = buttons.find((button) => button.dataset.navGroup === returnGroup.current) ?? buttons[0];
      returnGroup.current = null;
      target?.focus();
      if (popup) popup.scrollTop = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, menuPath, host, structured]);
  useLayoutEffect(() => {
    const strip = links.current;
    const searchButton = search.current;
    if (!strip || !searchButton) return;
    const phone = window.matchMedia('(max-width: 600px)');
    const measure = () => {
      const gap = parseFloat(getComputedStyle(host).columnGap) || 0;
      const searchWidth = parseFloat(getComputedStyle(searchButton).minWidth) || 0;
      const next = phone.matches || strip.scrollWidth + searchWidth + gap > host.clientWidth;
      setFolded(next);
      const fullSearchWidth = parseFloat(getComputedStyle(shellRoot()).fontSize) * 11;
      setCompactSearch(!next && host.clientWidth - strip.scrollWidth - gap < fullSearchWidth);
    };
    // The clipped strip stays measurable when folded; fonts and brand width
    // can change independently of the viewport. All sizes are layout pixels.
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    observer.observe(strip);
    observer.observe(searchButton);
    phone.addEventListener('change', measure);
    measure();
    return () => {
      observer.disconnect();
      phone.removeEventListener('change', measure);
    };
  }, [host, app]);
  useLayoutEffect(() => {
    setOpen(null);
    const focused = document.activeElement;
    const inMenu = open !== null && focused && host.contains(focused);
    if (folded && focused && (links.current?.contains(focused) || inMenu)) triggers.current.folded?.focus();
    if (!folded && (focused === triggers.current.folded || inMenu)) links.current?.querySelector<HTMLElement>('button, a[href]')?.focus();
  }, [folded]);
  return (
    <>
      <div className={`tn-wide${folded ? ' folded' : ''}`} inert={folded} aria-hidden={folded || undefined}>
        <div className="tn-links" ref={links}>
          {starred.length > 0 && (
            <div key="favorites" className="tn-group">
              {group(
                'favorites',
                <span>{say('common.favorites')}</span>,
                'tn-item tn-group-button',
                'tn-pop',
                say('common.favorites'),
                favoriteItems,
              )}
            </div>
          )}
          {tree
            .flatMap((node) =>
              /* An inline group's entries stand in the strip themselves, a portal's few places as links;
               folded, it is a section of the one menu like any group. */
              node.kind === 'group' && node.inline ? node.children : [node],
            )
            .map((node) => {
              if (node.kind === 'target') return targetItem(node, false);
              if (node.kind === 'destination') return item(node.entry, false);
              const key = `root:${node.id}`;
              const active = navigationContains(node, isCurrent);
              return (
                <div key={key} className={`tn-group${active ? ' active' : ''}`}>
                  {group(
                    key,
                    <>
                      <NavGlyph icon={node.icon} label={node.label} />
                      <span>{node.label}</span>
                    </>,
                    'tn-item tn-group-button',
                    'tn-pop',
                    node.label,
                    node.children.map(popNode),
                  )}
                </div>
              );
            })}
          {/* A menu past a dozen places ends in its Directory: every one of them, found by typing (Directory.tsx). */}
          {app.directory && (
            <button
              type="button"
              className="tn-item"
              data-form={DIRECTORY_PAGE}
              aria-current={onDirectory}
              onClick={() => {
                setOpen(null);
                go(pageView(DIRECTORY_PAGE, undefined, undefined, say('allPages')), 'reset');
              }}
            >
              <NavGlyph icon={app.directory.icon} label={say('allPages')} />
              <span>{say('allPages')}</span>
            </button>
          )}
        </div>
      </div>
      {(tree.length > 0 || starred.length > 0 || pending) && (
        <div className="tn-group tn-folded-group" hidden={!folded}>
          {group(
            'folded',
            <>
              <Icon name="list" className="tn-folded-icon" />
              <span className="tn-folded-word">{message('navigation.menu')}</span>
            </>,
            'tn-item tn-group-button tn-folded',
            `tn-pop ${structured ? 'tn-drill-pop' : 'tn-folded-pop'}`,
            message('navigation.menu'),
            structured ? (
              <div
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' && menuPath.length) {
                    event.preventDefault();
                    event.stopPropagation();
                    back();
                  }
                }}
              >
                {menuPath.length > 0 && (
                  <MenuItem closeOnSelect={false} render={<button type="button" className="tn-popitem tn-back" />} onSelect={back}>
                    <Icon name="arrow-left" />
                    <span>{say('common.back')}</span>
                    <span className="tn-level-label">{menuLabel}</span>
                  </MenuItem>
                )}
                {menuPath.length === 0 && favoritesSection}
                {menuChildren.map((node) =>
                  node.kind === 'target' ? (
                    targetItem(node, true)
                  ) : node.kind === 'destination' ? (
                    item(node.entry, true)
                  ) : (
                    <MenuItem
                      key={node.id}
                      closeOnSelect={false}
                      render={
                        <button
                          type="button"
                          className="tn-popitem tn-subgroup"
                          data-nav-group={node.id}
                          data-active={navigationContains(node, isCurrent) || undefined}
                        />
                      }
                      onSelect={() => {
                        refreshTargets();
                        setMenuPath((path) => [...path, node.id]);
                      }}
                    >
                      <span>
                        <NavGlyph icon={node.icon} label={node.label} />
                        {node.label}
                      </span>
                      <Icon name="caret-right" />
                    </MenuItem>
                  ),
                )}
              </div>
            ) : (
              [
                favoritesSection,
                ...tree.map((node, index) =>
                  node.kind === 'target' ? (
                    targetItem(node, true)
                  ) : node.kind === 'destination' ? (
                    item(node.entry, true)
                  ) : (
                    <MenuGroup key={index} className="tn-folded-section">
                      <MenuGroupLabel className="tn-folded-label">{node.label}</MenuGroupLabel>
                      {node.children.map(popNode)}
                    </MenuGroup>
                  ),
                ),
              ]
            ),
          )}
        </div>
      )}
      <button
        ref={search}
        type="button"
        className={`tn-search${compactSearch ? ' compact' : ''}`}
        aria-label={say('searchK')}
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => openPalette()}
      >
        <Icon name="magnifying-glass" className="tn-search-icon" />
        <span className="tn-search-hint">{say('search')}</span>
        {/* A space between the word and the key, as the bar's markup has (index.html): run together, the words a
            voice command or axe reads are "Search…⌘K", which the name "Search ⌘K" does not hold. The flex box draws
            no space for it. */}{' '}
        <span className="tn-search-key">⌘K</span>
      </button>
    </>
  );
}
