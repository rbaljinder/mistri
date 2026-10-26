/**
 * Home, in an app.
 *
 * In an app, home is the app: where its work starts and what is waiting,
 * not the anatomy of the database it happens to run on. An app with a
 * screen of its own opens on it, drawn exactly the way the dashboard
 * route draws — full width, no card around it — with the author's home
 * cards leading when both exist, and "Where you were" as one quiet
 * section under the screen. An app without a dashboard opens on its home
 * card: the name, the cards, and the menu as rows of links beside the
 * reader's own work.
 */
import { useRef, type ReactNode } from 'react';
import { currentEntry, findTable, go, pageView, state, tableView, toast } from '@mistriwork/kit/client/core.js';
import { syncHash } from '@mistriwork/kit/client/url.js';
import { recentVisits } from '@mistriwork/kit/client/pagemarks.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { dashboardSelection, rootSlot, type DashboardDef } from '@mistriwork/kit/client/components/dashboardModel.js';
import type { PageEntry } from '@mistriwork/kit/client/components/pageModel.js';
import { appListQuery } from '@mistriwork/kit/client/components/appListModel.js';
import {
  ASSISTANT_PAGE,
  appMenu,
  dashPageId,
  formPageId,
  isAssistantRoom,
  type MenuEntry,
} from '@mistriwork/kit/client/components/appRooms.js';
import type { NavigationNode } from '@mistriwork/kit/client/components/navigationTree.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import { isFormView } from '../../shared/appModel.js';
import { formatNumber } from '@mistriwork/kit/client/locale.js';
import { say } from '../copy/shell/components/AppLanding.js';
import { LoadErrorNote } from '@mistriwork/kit/client/components/Landing.js';
import { WorkPanel, type KnownPage as WorkPage } from '@mistriwork/kit/client/components/WorkPanel.js';

/* A dashboard and its charts are a chunk of their own: an App whose home is a
   list never loads them. */
const Dashboard = onDemand(() => import('./Dashboard.js'), 'Dashboard');
const FreePage = onDemand(() => import('./FreePage.js'), 'FreePage');

/** What the landing reads of the served App: its name, its menu, and where the menu sits. */
type AppInfo = Pick<AppPayloadApp, 'name' | 'ui' | 'views' | 'nav' | 'resources' | 'home'>;

interface KnownPage {
  id: string;
  base: string;
}

interface AppLandingProps {
  app: AppInfo;
  /** The dashboard the server served as this visitor's home: the screen they start on. */
  firstDash: DashboardDef;
  /** Why the app directory on disk no longer loads, or ''. */
  loadError: string;
  /** The pages this connection has, as the last read left them. */
  pages: KnownPage[];
  /** The home dashboard route, for a window or a pick chosen from here. */
  dashboardEntry: (
    dash: DashboardDef,
    windowNow: string | null,
    picks: Record<string, string>,
    home: boolean,
    periods?: Record<string, string>,
  ) => unknown;
  entry?: PageEntry;
}

/** One row of links under a label, the shape the work card also uses. */
function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className="shape-line">
      <span className="shape-label">{label}</span>
      <span className="landing-links">{children}</span>
    </li>
  );
}

/**
 * The app's name and — in the sidebar shell — its menu as rows. The body
 * of the home card only: the card itself (`section.shape`) is the host this
 * is drawn into, because the landing's grid addresses its cards as direct
 * children.
 */
export function AppHomeBody({ app }: { app: AppInfo }) {
  /* The menu as rows: an App without nav has none (its one room is its home). */
  const tree = appMenu(app);
  const link = (entry: MenuEntry<AppInfo>) => {
    if ('sections' in entry) {
      return (
        <button
          key={`d:${entry.id}`}
          type="button"
          className="landing-link"
          data-dash={dashPageId(entry.id)}
          title={entry.error ?? say('aDashboard', { label: entry.label })}
          onClick={() =>
            entry.error ? toast(entry.error, 'error') : go(pageView(dashPageId(entry.id), undefined, undefined, entry.label), 'reset')
          }
        >
          <span className="landing-link-name">{entry.label}</span>
        </button>
      );
    }
    if (isFormView(entry)) {
      return (
        <button
          key={`f:${entry.id}`}
          type="button"
          className="landing-link"
          data-form={formPageId(entry.id)}
          title={entry.error ?? say('aForm', { label: entry.label })}
          onClick={() =>
            entry.error ? toast(entry.error, 'error') : go(pageView(formPageId(entry.id), undefined, undefined, entry.label), 'reset')
          }
        >
          <span className="landing-link-name">{entry.label}</span>
        </button>
      );
    }
    if (isAssistantRoom(entry)) {
      return (
        <button
          key="assistant"
          type="button"
          className="landing-link"
          data-form={ASSISTANT_PAGE}
          onClick={() => go(pageView(ASSISTANT_PAGE, undefined, undefined, entry.label), 'reset')}
        >
          <span className="landing-link-name">{entry.label}</span>
        </button>
      );
    }
    const table = findTable(entry.table) as { approxRows?: number } | undefined;
    return (
      <button
        key={`t:${entry.id}:${entry.query ?? ''}`}
        type="button"
        className="landing-link"
        title={entry.error ?? entry.table}
        onClick={() =>
          entry.error ? toast(entry.error, 'error') : go({ ...tableView(entry.table, appListQuery(entry)), view: entry.id }, 'reset')
        }
      >
        <span className="landing-link-name">{entry.label}</span>
        {!entry.error && !entry.query && table?.approxRows != null && (
          <span className="landing-link-detail">{formatNumber(table.approxRows)}</span>
        )}
      </button>
    );
  };
  const branch = (nodes: NavigationNode<MenuEntry<AppInfo>>[]): ReactNode =>
    nodes.map((node, index) =>
      node.kind === 'destination' ? (
        <li key={index} className="landing-nav-destination">
          {link(node.entry)}
        </li>
      ) : (
        <li key={node.id} className="landing-nav-group">
          <h3>{node.label}</h3>
          <ul className="shape-lines">{branch(node.children)}</ul>
        </li>
      ),
    );
  return (
    <>
      {/* The app's name is the page's one h1. */}
      <h1 className="landing-heading">{app.name}</h1>
      {/* In the top-bar shell the menu is one glance up — repeating it as
          link rows on the landing was the duplication the sidebar rework
          already removed once. */}
      {app.ui.shell?.placement !== 'top' && (
        <ul className="shape-lines">
          {tree.some((node) => node.kind === 'group')
            ? branch(tree)
            : tree.map(
                (node, index) =>
                  node.kind === 'destination' && (
                    <Line key={index} label={say('go')}>
                      {link(node.entry)}
                    </Line>
                  ),
              )}
        </ul>
      )}
    </>
  );
}

/**
 * "Where you were", spoken in the dashboard's own language: one more
 * section under the screen — a hairline, a dim title, a row of quiet
 * chips. Only the positions survive down here; the pages are already the
 * menu's and ⌘K's answer.
 */
function Resume({ pages }: { pages: KnownPage[] }) {
  const positions = (recentVisits() as Array<{ pageId: string; name: string; base: string; key?: Record<string, unknown>; label?: string }>)
    .filter((v) => v.label)
    .slice(0, 6);
  if (!positions.length) return null;
  const byId = new Map(pages.map((p) => [p.id, p]));
  return (
    <div className="page-body dash-body landing-resume">
      <section className="page-section width-full">
        <h2 className="page-section-title">{say('common.where')}</h2>
        <div className="resume-chips">
          {positions.map((visit, i) => (
            <button
              key={i}
              type="button"
              className="resume-chip"
              title={`${visit.name} — ${visit.label}`}
              onClick={() => go(pageView(visit.pageId, byId.get(visit.pageId)?.base ?? visit.base, visit.key, visit.label), 'reset')}
            >
              <span className="resume-chip-name">{visit.label}</span>
              <span className="resume-chip-kind">{visit.name}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

/** The screen an app with a dashboard opens on. */
export function AppLanding({ firstDash, loadError, pages, dashboardEntry, entry }: AppLandingProps) {
  const selection = dashboardSelection(firstDash, entry?.rootBody);
  const windowOn = useRef(selection.window);
  const picksOn = useRef(selection.picks);
  const periodsOn = useRef(selection.periods);
  const writeSelection = () => {
    if (currentEntry() !== entry) return;
    if (!entry) {
      go(dashboardEntry(firstDash, windowOn.current, picksOn.current as Record<string, string>, true, periodsOn.current), 'replace');
      return;
    }
    entry.rootBody = rootSlot(windowOn.current, picksOn.current, periodsOn.current, firstDash.window) || undefined;
    (state as unknown as { navMode: string }).navMode = 'replace';
    syncHash();
  };
  if (firstDash.page)
    return (
      <>
        {loadError ? <p className="note app-loaderror">{say('stillShowingTheLast', { loadError })}</p> : null}
        <FreePage
          entry={entry}
          dashboard={firstDash}
          page={firstDash.page}
          initialEntry={() => dashboardEntry(firstDash, null, {}, true) as PageEntry}
        />
      </>
    );
  return (
    <>
      {loadError ? <p className="note app-loaderror">{say('stillShowingTheLast', { loadError })}</p> : null}
      <div className="applist-head dash-head">
        <h1 className={`applist-title${firstDash.headingHidden ? ' visually-hidden' : ''}`}>{firstDash.heading ?? firstDash.label}</h1>
        {firstDash.description && <p className="note dash-description">{firstDash.description}</p>}
      </div>
      <Dashboard
        dashboard={firstDash}
        window={selection.window}
        picks={selection.picks}
        periods={selection.periods}
        onWindow={(w) => {
          windowOn.current = w;
          writeSelection();
        }}
        onPick={(p) => {
          picksOn.current = p;
          writeSelection();
        }}
        onPeriods={(p) => {
          periodsOn.current = p;
          writeSelection();
        }}
      />
      <Resume pages={pages} />
    </>
  );
}

/** An App's home when it has no screen of its own: its front door beside the work panel. */
export function AppHomeLanding({ app, loadError, pages }: { app: AppInfo; loadError: string; pages: WorkPage[] }) {
  return (
    <div className="panel-pad">
      <LoadErrorNote error={loadError} />
      <div className="landing-top">
        {/* The landing's grid addresses its cards as direct children. */}
        <section className="landing-pages shape">
          <AppHomeBody app={app} />
        </section>
        <WorkPanel pages={pages} />
      </div>
    </div>
  );
}
