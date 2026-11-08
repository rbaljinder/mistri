/**
 * The workspaces of an App that declares them (`navGroup(…, { workspace: true })`), as links: tabs in the bar after the App's
 * mark at a desk, a list at the top of the menu drawer on a phone. Each is a plain link to the first room of the workspace
 * this reader may open, so a middle-click opens it in a tab; the current one is marked as the top bar marks its current
 * room. The sidebar's own model decides which is current (sidebarModel.ts), so this draws what the sidebar lists.
 *
 * In the bar a label is never cut and the row never scrolls: the tabs that do not fit go under More (useTabFold.ts).
 */
import { useSyncExternalStore, type MouseEvent } from 'react';
import { NavGlyph } from '@mistriwork/kit/client/components/NavGlyph.js';
import { navigationPaths } from '@mistriwork/kit/client/components/navigationTree.js';
import { viewLink, type ViewLink } from '@mistriwork/kit/client/components/viewLink.js';
import { chooseWorkspace, subscribeSidebar, workspaceSwitcher } from '@mistriwork/kit/client/components/sidebarModel.js';
import { useTabFold } from '@mistriwork/kit/client/components/useTabFold.js';
import type { ShownApp } from '@mistriwork/kit/client/components/appRooms.js';
import { subscribeWalk } from '@mistriwork/kit/client/core.js';
import { say } from '@mistriwork/kit/client/copy/shell/components/WorkspaceSwitcher.js';
import { message, messageLanguage, subscribeMessages } from '@mistriwork/kit/client/messages.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';

interface WorkspaceSwitcherProps {
  app: ShownApp;
  /** Where it stands: the bar's tabs, or the phone drawer's list. */
  variant: 'header' | 'drawer';
  /** The reader chose a workspace; the drawer stays open, to show that workspace's entries. */
  onChoose?: () => void;
}

const subscribe = (notify: () => void) => {
  const stops = [subscribeWalk(notify), subscribeSidebar(notify), subscribeMessages(notify)];
  return () => stops.forEach((stop) => stop());
};

type Switcher = NonNullable<ReturnType<typeof workspaceSwitcher>>;

/** The first room of a workspace that has an address of its own: the assistant's and the Directory's have none, so are passed over. */
function firstLink(space: Switcher['spaces'][number]): ViewLink | undefined {
  return navigationPaths(space.children)
    .filter(({ entry }) => !entry.error)
    .map(({ entry }) => viewLink(entry.id, 'reset'))
    .find((candidate) => candidate !== undefined);
}

/** A plain click chooses the workspace before the walk moves, so a first room that two workspaces share opens in the one asked for. */
function choose(app: ShownApp, id: string, link: ViewLink | undefined, event: MouseEvent<HTMLAnchorElement> | null, onChoose?: () => void) {
  if (event && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
  chooseWorkspace(app, id);
  if (event) {
    if (link?.onClick) link.onClick(event);
    else event.preventDefault();
  } else {
    /* From the More menu, which is a button: the link's own handler wants a plain left click. */
    link?.onClick?.({
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault() {},
    } as MouseEvent<HTMLAnchorElement>);
  }
  onChoose?.();
}

export function WorkspaceSwitcher({ app, variant, onChoose }: WorkspaceSwitcherProps) {
  /* A string, so the row is drawn again when the workspaces or the current one change, not on every paint of the walk. */
  const words = () => {
    const now = workspaceSwitcher(app);
    return now ? `${now.current}\n${now.spaces.map((space) => space.id).join(',')}` : '';
  };
  useSyncExternalStore(subscribe, words, words);
  useSyncExternalStore(subscribeMessages, messageLanguage, messageLanguage);
  const switcher = workspaceSwitcher(app);
  if (!switcher) return null;
  return variant === 'drawer' ? (
    <DrawerList app={app} switcher={switcher} onChoose={onChoose} />
  ) : (
    <HeaderTabs app={app} switcher={switcher} onChoose={onChoose} />
  );
}

function DrawerList({ app, switcher, onChoose }: { app: ShownApp; switcher: Switcher; onChoose?: () => void }) {
  return (
    <nav className="workspace-tabs workspace-tabs-drawer" aria-label={say('workspaces')}>
      <ul className="workspace-list">
        {switcher.spaces.map((space) => {
          const link = firstLink(space);
          return (
            <li key={space.id}>
              <a
                className="workspace-tab"
                href={link?.href ?? '#'}
                aria-current={space.id === switcher.current ? 'page' : undefined}
                data-workspace={space.id}
                onClick={(event) => choose(app, space.id, link, event, onChoose)}
              >
                <NavGlyph icon={space.icon} label={space.label} />
                <span>{space.label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function HeaderTabs({ app, switcher, onChoose }: { app: ShownApp; switcher: Switcher; onChoose?: () => void }) {
  const active = switcher.spaces.findIndex((space) => space.id === switcher.current);
  const { strip, folded } = useTabFold(switcher.spaces.length, active);
  const links = switcher.spaces.map(firstLink);
  return (
    <nav className="workspace-tabs" aria-label={say('workspaces')}>
      <div className="workspace-strip folds" ref={strip}>
        {switcher.spaces.map((space, i) => (
          <a
            key={space.id}
            className="workspace-tab"
            href={links[i]?.href ?? '#'}
            aria-current={i === active ? 'page' : undefined}
            data-workspace={space.id}
            data-fold={i}
            data-folded={folded.has(i) ? '' : undefined}
            aria-hidden={folded.has(i) || undefined}
            tabIndex={folded.has(i) ? -1 : undefined}
            onClick={(event) => choose(app, space.id, links[i], event, onChoose)}
          >
            <NavGlyph icon={space.icon} label={space.label} />
            <span>{space.label}</span>
          </a>
        ))}
        <div
          className="workspace-more"
          data-fold-more=""
          data-folded={folded.size ? undefined : ''}
          aria-hidden={!folded.size || undefined}
        >
          <DropMenu
            className="workspace-more-menu"
            triggerClassName="workspace-tab"
            label={message('common.more')}
            popupClassName="page-actions-popup"
            align="end"
          >
            {switcher.spaces.map((space, i) =>
              folded.has(i) ? (
                <DropItem key={space.id} className="page-actions-item" onClick={() => choose(app, space.id, links[i], null, onChoose)}>
                  {space.label}
                </DropItem>
              ) : null,
            )}
          </DropMenu>
        </div>
      </div>
    </nav>
  );
}
