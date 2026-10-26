/**
 * The App's own frame for a story: the top bar, the side menu and the one
 * <main> the room is drawn in, laid out by the App's stylesheets exactly as
 * index.html and app.js lay them out. Under 900px the side menu leaves and
 * the bar's Menu opens it as a drawer, as app.js decides with the same query.
 *
 * A story drawn without it showed a desk layout in its phone capture: a
 * sidebar squeezed beside the content, which no phone ever sees.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Sidebar } from '../../packages/kit/src/client/components/Sidebar.js';
import { MobileNavDrawer } from '../../packages/mistri/src/client/components/MobileNavDrawer.js';
import { Content } from '../../packages/kit/src/client/components/Content.js';
import { activeApp } from '../../packages/mistri/src/client/appState.js';
import { state } from '../mocks/core.js';
import type { WalkEntry } from '../../packages/kit/src/client/components/walk.js';

/* app.js's own breakpoint for the drawer (compactAppNavigation). */
const COMPACT = '(max-width: 900px)';
const compact = () => window.matchMedia(COMPACT).matches;
const subscribe = (listener: () => void) => {
  const query = window.matchMedia(COMPACT);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
};

/** The room a story opens on: the walk's one entry, as a link would leave
    it — or, with `step`, one more step along a walk already begun. */
export function openOn(entry: WalkEntry, step = false) {
  const walk = state as { stack: WalkEntry[] };
  walk.stack = step ? [...walk.stack, entry] : [entry];
}

export function AppShell({ children, rail = false }: { children?: ReactNode; rail?: boolean }) {
  const narrow = useSyncExternalStore(subscribe, compact, compact);
  const [list, setList] = useState<HTMLUListElement | null>(null);
  const [topnav, setTopnav] = useState<HTMLElement | null>(null);
  const app = activeApp() as { name?: string; ui?: object } | null;
  useEffect(() => {
    document.body.classList.toggle('app-mobile-nav', narrow);
    // The icon rail is the side menu folded (`ui.shell.rail`): only beside the content.
    document.body.classList.toggle('app-nav-rail', rail && !narrow);
    document.body.classList.toggle('sidebar-hidden', rail && !narrow);
    return () => document.body.classList.remove('app-mobile-nav', 'app-nav-rail', 'sidebar-hidden');
  }, [narrow, rail]);
  return (
    <div className="story-app-shell" style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <header className="topbar">
        <button type="button" className="brand" title="Home">
          <span className="brand-mark" />
          <span className="brand-name">{app?.name ?? 'App'}</span>
        </button>
        <nav ref={setTopnav} id="topnav" className="topnav" aria-label="App navigation" hidden={!narrow}>
          {narrow && topnav && app ? <MobileNavDrawer app={app} /> : null}
        </nav>
      </header>
      <div className="layout">
        {!narrow && (
          <nav className="sidebar" aria-label="App menu">
            <ul ref={setList} id="table-list">
              {list && <Sidebar host={list} />}
            </ul>
          </nav>
        )}
        <main className="content" id="content">
          {children ?? <Content onHome={() => {}} />}
        </main>
      </div>
    </div>
  );
}
