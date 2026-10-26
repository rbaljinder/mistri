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
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { message, messageLanguage, subscribeMessages } from '@mistriwork/kit/client/messages.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { NavGlyph } from '@mistriwork/kit/client/components/NavGlyph.js';
import { layoutViewport, zoomAnchor } from '@mistriwork/ui/anchor.js';
import { go, pageView, tableView, toast, state } from '@mistriwork/kit/client/core.js';
import { openPalette } from '@mistriwork/kit/client/palette.js';
import { appListQuery, currentNavIndex } from '@mistriwork/kit/client/components/appListModel.js';
import {
  ASSISTANT_PAGE,
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
import { useWalk } from '@mistriwork/kit/client/components/walk.js';
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

export function TopNav({ app, host }: TopNavProps) {
  useSyncExternalStore(subscribeMessages, messageLanguage, messageLanguage);
  const stack = useWalk();
  const [open, setOpen] = useState<string | null>(null);
  const [folded, setFolded] = useState(false);
  const [compactSearch, setCompactSearch] = useState(false);
  const [menuPath, setMenuPath] = useState<string[]>([]);
  const returnGroup = useRef<string | null>(null);
  const links = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLButtonElement>(null);
  const here = stack[stack.length - 1] as { kind?: string; table?: string; query?: string; pageId?: string; view?: string } | undefined;

  /* Which room is current. A dashboard by its view key; a table by the
     walk's query, preferring the module whose standing conditions lead it.
     With nothing on the walk the visitor is on the home the server served
     them, so its room is lit, a dashboard or a list. */
  const schema = state.schema as DatabaseSchema | null;
  const { hrefs: targetHrefs, pending } = useAppNavTargetState(app, schema);
  const availableTree = appMenu(app, (target) => targetHrefs.get(appNavTargetKey(target)));
  const tree = pending ? pendingGroups(app.nav, availableTree) : availableTree;
  const refreshTargets = () => refreshAppNavTargets(app, schema);
  useSyncExternalStore(subscribeFavorites, favoritesVersion, favoritesVersion);
  /* Starred records and views, first: one menu of the reader's own. */
  const starred = shownFavorites(app);
  const favoriteItems = starred.map((favorite) => (
    <Menu.Item
      key={favoriteId(favorite)}
      render={<button type="button" className="tn-popitem tn-favorite" />}
      nativeButton
      onClick={() => {
        setOpen(null);
        openFavorite(app, favorite);
      }}
    >
      <span>{favorite.label}</span>
    </Menu.Item>
  ));
  const favoritesSection =
    starred.length > 0 ? (
      <Menu.Group key="favorites" className="tn-folded-section">
        <Menu.GroupLabel className="tn-folded-label">{say('common.favorites')}</Menu.GroupLabel>
        {favoriteItems}
      </Menu.Group>
    ) : null;
  const home = here ? undefined : homeRoom(app);
  const dashView =
    here?.kind === 'page' && dashViewKey(here.pageId) !== undefined
      ? dashViewKey(here.pageId)!
      : home && 'sections' in home
        ? home.id
        : null;
  const formView =
    here?.kind === 'page' && formViewKey(here.pageId) !== undefined ? formViewKey(here.pageId)! : home && isFormView(home) ? home.id : null;
  const tables = navigationPaths(tree)
    .map((path) => path.entry)
    .filter(isListRoom);
  const currentTable =
    here?.table && !dashView && !formView
      ? tables[currentNavIndex(tables, here.table ?? '', here.query ?? '', here.view)]
      : home && isListRoom(home)
        ? tables.find((entry) => entry.id === home.id)
        : undefined;
  const onAssistant = here?.kind === 'page' && here.pageId === ASSISTANT_PAGE;
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
    };
    if (!inPop)
      return (
        <button key={key} type="button" {...shared} onClick={() => visit(entry)}>
          <NavGlyph icon={entry.icon} label={entry.label} color={entry.navColor} />
          <span>{entry.label}</span>
        </button>
      );
    return (
      <Menu.Item key={key} render={<button type="button" {...shared} />} nativeButton onClick={() => visit(entry)}>
        <NavGlyph icon={entry.icon} label={entry.label} color={entry.navColor} />
        <span>{entry.label}</span>
      </Menu.Item>
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
      <Menu.Item key={`target:${node.label}:${node.href}`} render={anchor} nativeButton={false}>
        {content}
      </Menu.Item>
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
    <Menu.Root
      open={open === key}
      onOpenChange={(next) => {
        if (next) refreshTargets();
        setOpen(next ? key : null);
        setMenuPath([]);
      }}
    >
      <Menu.Trigger
        render={
          <button
            type="button"
            className={buttonClass}
            aria-label={ariaLabel}
            ref={(el: HTMLButtonElement | null) => {
              triggers.current[key] = el;
            }}
          />
        }
      >
        {label}
        <Icon name="caret-down" className="tn-caret" />
      </Menu.Trigger>
      <Menu.Portal keepMounted container={host}>
        {/* Under the button, flush with its left edge, on the zoom-aware ruler (anchor.ts). */}
        <Menu.Positioner
          anchor={() => (triggers.current[key] ? zoomAnchor(triggers.current[key]!) : null)}
          positionMethod="fixed"
          side="bottom"
          align="start"
          sideOffset={1}
          collisionBoundary={layoutViewport()}
          collisionPadding={8}
          style={{ zIndex: 40 }}
        >
          <Menu.Popup
            className={popClass}
            aria-label={key === 'folded' ? menuLabel : ariaLabel}
            aria-busy={pending || undefined}
            onFocusCapture={(event) => {
              if ((event.target as HTMLElement).closest('[role="menu"]') === event.currentTarget)
                focusedPopup.current = event.currentTarget;
            }}
          >
            {children}
            {pending && loading}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
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
      <Menu.SubmenuRoot
        key={node.id}
        onOpenChange={(next) => {
          if (next) refreshTargets();
        }}
      >
        <Menu.SubmenuTrigger
          nativeButton
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') keyboardSubmenu.current = event.currentTarget;
          }}
          render={
            <button
              type="button"
              className="tn-popitem tn-subgroup"
              data-nav-group={node.id}
              ref={(element: HTMLButtonElement | null) => {
                triggers.current[`submenu:${node.id}`] = element;
              }}
              data-active={navigationContains(node, isCurrent) || undefined}
            />
          }
        >
          <span>
            <NavGlyph icon={node.icon} label={node.label} />
            {node.label}
          </span>
          <Icon name="caret-right" />
        </Menu.SubmenuTrigger>
        <Menu.Portal container={host}>
          <Menu.Positioner
            anchor={() => {
              const element = triggers.current[`submenu:${node.id}`];
              return element ? zoomAnchor(element) : null;
            }}
            side="right"
            align="start"
            sideOffset={4}
            collisionPadding={8}
            collisionBoundary={layoutViewport()}
            positionMethod="fixed"
            style={{ zIndex: 41 }}
          >
            <Menu.Popup
              className="tn-pop"
              aria-label={node.label}
              aria-busy={pending || undefined}
              onFocusCapture={(event) => {
                if ((event.target as HTMLElement).closest('[role="menu"]') === event.currentTarget)
                  focusedPopup.current = event.currentTarget;
              }}
            >
              {node.children.map(popNode)}
              {pending && loading}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.SubmenuRoot>
    );
  };
  const back = () => {
    returnGroup.current = menuPath.at(-1) ?? null;
    setMenuPath((path) => path.slice(0, -1));
  };
  useLayoutEffect(() => {
    if (!open) return;
    // Base UI focuses an empty popup while checks run. Once items arrive, give
    // the keyboard its first item without closing/reopening (and rechecking).
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      const previous = focusedPopup.current;
      const requested = keyboardSubmenu.current;
      const opening =
        focused === requested && requested?.getAttribute('aria-expanded') === 'true'
          ? shellById(requested.getAttribute('aria-controls') ?? '')
          : null;
      if (!pending) keyboardSubmenu.current = null;
      if (!opening && focused !== previous && focused !== document.body && focused?.isConnected) return;
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
                  <Menu.Item
                    closeOnClick={false}
                    render={<button type="button" className="tn-popitem tn-back" />}
                    nativeButton
                    onClick={back}
                  >
                    <Icon name="arrow-left" />
                    <span>{say('common.back')}</span>
                    <span className="tn-level-label">{menuLabel}</span>
                  </Menu.Item>
                )}
                {menuPath.length === 0 && favoritesSection}
                {menuChildren.map((node) =>
                  node.kind === 'target' ? (
                    targetItem(node, true)
                  ) : node.kind === 'destination' ? (
                    item(node.entry, true)
                  ) : (
                    <Menu.Item
                      key={node.id}
                      closeOnClick={false}
                      nativeButton
                      render={
                        <button
                          type="button"
                          className="tn-popitem tn-subgroup"
                          data-nav-group={node.id}
                          data-active={navigationContains(node, isCurrent) || undefined}
                        />
                      }
                      onClick={() => {
                        refreshTargets();
                        setMenuPath((path) => [...path, node.id]);
                      }}
                    >
                      <span>
                        <NavGlyph icon={node.icon} label={node.label} />
                        {node.label}
                      </span>
                      <Icon name="caret-right" />
                    </Menu.Item>
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
                    <Menu.Group key={index} className="tn-folded-section">
                      <Menu.GroupLabel className="tn-folded-label">{node.label}</Menu.GroupLabel>
                      {node.children.map(popNode)}
                    </Menu.Group>
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
        onClick={() => openPalette()}
      >
        <Icon name="magnifying-glass" className="tn-search-icon" />
        <span className="tn-search-hint">{say('search')}</span>
        <span className="tn-search-key">⌘K</span>
      </button>
    </>
  );
}
