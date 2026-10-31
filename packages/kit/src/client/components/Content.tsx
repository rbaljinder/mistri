/**
 * The content pane: what is on screen, decided by the walk.
 *
 * Mounted once on `#content` and subscribed to the walk. Nothing on the
 * stack is a landing — the app's screen or its home card, the workbench's
 * shape of the database; otherwise the trail, then the room the top entry
 * names. Each kind is named explicitly: a dispatch whose last branch is
 * "or else a row" turns every kind it has not heard of into a record view
 * asking for a key nobody supplied.
 *
 * Three ticks drive it. Every `render()` is a paint: the address bar is
 * written. The room is keyed by the room tick (core.js `roomVersion`), which
 * moves on nearly every paint, so the room's state and its fetches start
 * over the way a repaint always did — except for a refinement of the table
 * room on screen (a page, a page size, a header's sort or filter), which
 * keeps the room and lets its Query re-ask in place — in an App's list as in
 * the Workbench's table. A crumb correction
 * (`renderCrumbs`) ticks the walk alone: the trail re-reads its labels and
 * the room is left be, because re-fetching the row that just resolved its
 * own label would loop.
 */
import { Fragment, useLayoutEffect } from 'react';
import { currentEntry, paintVersion, renderCrumbs, roomVersion } from '../core.js';
import { shell } from '../shellMode.js';
import { syncHash } from '../url.js';
import { appListFor, type ListSpec } from './appListModel.js';
import { ASSISTANT_PAGE, INBOX_PAGE, dashPageId, dashViewKey, formViewKey, homeRoom } from './appRooms.js';
import { onDemand } from './onDemand.js';
import type { BreakdownEntry } from './Breakdown.js';
import { Crumbs } from './Crumbs.js';
import type { DashboardDef } from './dashboardModel.js';
import { LoadErrorNote, NothingGranted, WorkbenchLanding } from './Landing.js';
import type { PageEntry } from './pageModel.js';
import { PageRoom } from './PageRoom.js';
import type { RowEntry } from './Record.js';
import { AppListRoom, DashboardRoom, RowRoom } from './Rooms.js';
import { SavedViewsSection } from './SavedViews.js';
import { TableRoom } from './TableRoom.js';
import type { TableEntry } from './TableView.js';
import { useWalk } from './walk.js';
import type { KnownPage } from './WorkPanel.js';
import { AppFooter } from './AppFooter.js';
import { documentAt } from '../documents.js';
import { ErrorBoundary } from './ErrorBoundary.js';

/* A breakdown is the query language at work, loaded when one is first asked. */
const BreakdownRoom = onDemand(() => import('./BreakdownRoom.js'), 'BreakdownRoom');
/* An App's own rooms — its home, a form, the inbox, the assistant, a record's document — are the App
   framework's, drawn through the shell's rooms slot (shellMode.ts `rooms`); this pane names none of them. */

/* The pages this connection has, as the last read left them. Synchronous,
   because the landing is drawn before anything is fetched — the shell fills
   this once the pages are known, and a first visit has none to show. */
let knownPages: KnownPage[] = [];
export function setKnownPages(pages: KnownPage[]): void {
  knownPages = pages;
}

/* A sentence above the landing — the link that could not be followed, and
   the way forward — shown until the next paint takes it away. */
let notice: { text: string; paint: number } | null = null;
export function noticeOnContent(text: string): void {
  notice = { text, paint: paintVersion() };
  renderCrumbs();
}

/* Set by boot while an address it has not applied yet names somewhere: the
   walk is still empty then, and an empty walk is home. Drawn in that gap,
   the home dashboard mounted and fired every tile's query — fourteen
   requests on a warm-tab deep link to a list — for a room nobody asked
   for, replaced a moment later. Released the moment the address is
   applied (app.js boot, switchAndRestore), and the paint that follows
   draws the room the address names. */
let homeHeld = false;
export function holdHome(held: boolean): void {
  homeHeld = held;
}
export function homeIsHeld(): boolean {
  return homeHeld;
}

export function Content({ onHome }: { onHome: () => void }) {
  useWalk();
  const frame = shell().inApp() ? shell().app()?.ui.shell : undefined;
  const body = <ContentBody onHome={onHome} />;
  /* The frame draws the content's width, gutter and title. Placement, the
     menu, search and breadcrumbs are drawn elsewhere and need no frame. */
  const framed = frame !== undefined && (frame.width !== undefined || frame.gutter !== undefined || frame.heading === false);
  /* The App's footer belongs to every room, so it is drawn here rather than
     by each room — and inside the frame, so it takes the content's width
     rather than the window's. A landing standing alone draws its own (LandingSurface); one drawn as this
     pane's home is told not to (PublicHome), so there is one footer either way. */
  const footer = shell().inApp() ? shell().app()?.ui.footer : undefined;
  const withFooter = footer ? (
    <>
      {body}
      <AppFooter footer={footer} />
    </>
  ) : (
    body
  );
  return framed ? (
    <div
      className={`app-content-frame${frame?.heading === false ? ' app-content-no-title' : ''}`}
      data-width={frame?.width}
      data-gutter={frame?.gutter}
    >
      {withFooter}
    </div>
  ) : (
    withFooter
  );
}

function ContentBody({ onHome }: { onHome: () => void }) {
  useWalk();
  const paint = paintVersion();
  const entry = currentEntry() as ((TableEntry | BreakdownEntry | PageEntry | RowEntry) & { kind: string }) | undefined;
  /* Every paint is a state change worth linking to, so the address bar is
     written here rather than at each of the dozen places that call go(). */
  useLayoutEffect(() => {
    syncHash();
  }, [paint]);
  const said = notice && notice.paint === paint ? <p className="note">{notice.text}</p> : null;

  const app = shell().inApp() ? shell().app() : null;
  /* Where this visitor starts is the server's answer (the payload's `home`),
     followed and never worked out here: one of the App's rooms, or — when
     it names none — a public view (AppHome.tsx). */
  const home = app ? homeRoom(app) : undefined;
  const homeDash = home && 'sections' in home ? (home as DashboardDef) : undefined;
  const homeEntry =
    entry?.kind === 'page' && (entry as PageEntry).tab === 'home' && homeDash && (entry as PageEntry).pageId === dashPageId(homeDash.id)
      ? (entry as PageEntry)
      : undefined;
  if (!entry && homeHeld) return null;
  if (!entry || homeEntry) {
    /* In an app, home is the app: where its work starts and what is waiting,
       not the anatomy of the database it happens to run on. The schema
       summary and diagram still exist — they are the workbench's landing,
       one "All tables" flip away. */
    if (shell().inApp()) {
      const Home = shell().rooms.Home;
      return Home ? <Home paint={paint} said={said} entry={homeEntry} pages={knownPages} /> : null;
    }
    // An App is served, and this account's roles read none of it.
    if (shell().app())
      return (
        <>
          {said}
          <NothingGranted />
        </>
      );
    return (
      <>
        {said}
        <WorkbenchLanding pages={knownPages} />
      </>
    );
  }

  const loadError = shell().inApp() ? shell().loadError() : '';
  /* Spelled apart, so a room in one mode is never taken for the same room
     in the other when the mode changes under the same key. An App's list
     keeps its room through a refinement too (a header's sort, a page): it
     was keyed by the paint, so a sort threw the whole grid away and built
     it again inside the click, the slowest interaction measured on a list
     (test/built-client-vitals.mjs). */
  const room = shell().inApp() ? `app:${roomVersion()}` : `room:${roomVersion()}`;
  return (
    <>
      {app?.ui.shell?.breadcrumbs !== false && (
        <div className="crumbs-host">
          <Crumbs onHome={onHome} />
        </div>
      )}
      <LoadErrorNote error={loadError} />
      {said}
      {/* A room that throws says so under the trail, which still leads out of it. */}
      <Fragment key={room}>
        <ErrorBoundary scope="room">
          <Room entry={entry} />
        </ErrorBoundary>
      </Fragment>
    </>
  );
}

function Room({ entry }: { entry: (TableEntry | BreakdownEntry | PageEntry | RowEntry) & { kind: string } }) {
  if (entry.kind === 'table') {
    const table = entry as TableEntry;
    /* In app mode every table renders as an app list page — one of the
       App's views when it has one, a synthesized one (humanized name,
       derived filters) when a drill from a page lands outside them. Same
       entry, same URL; which room you are in decides the dress. */
    const appList = shell().inApp() ? (appListFor(table.table, table.query) as ListSpec | null) : null;
    if (appList) return <AppListRoom entry={table} spec={appList} />;
    /* Saved filters sit above the view tabs and below the trail: they are a
       property of the table you are on, not of the walk that got you here. */
    return (
      <>
        <SavedViewsSection entry={table} />
        <TableRoom entry={table} />
      </>
    );
  }
  if (entry.kind === 'breakdown') return <BreakdownRoom entry={entry as BreakdownEntry} />;
  /* A record's document is said where its tab would be (`/orders/12/invoice`): the record's room yields to the sheet. */
  const document = entry.kind === 'page' || entry.kind === 'row' ? documentAt(entry as PageEntry | RowEntry) : undefined;
  const rooms = shell().rooms;
  if (document) return rooms.Document ? <rooms.Document entry={entry as PageEntry | RowEntry} document={document} /> : null;
  if (entry.kind === 'page') {
    const page = entry as PageEntry;
    /* A dashboard rides the page token with a reserved id space: saved pages
       say `saved:`, config pages `config-`, suggestions `suggested:` —
       `dash-` and `form-` are the app's own screens, and branching here
       costs the URL machinery nothing. */
    if (shell().inApp() && dashViewKey(page.pageId) !== undefined) return <DashboardRoom entry={page} />;
    if (shell().inApp() && formViewKey(page.pageId) !== undefined) return rooms.Form ? <rooms.Form entry={page} /> : null;
    if (shell().inApp() && page.pageId === INBOX_PAGE) return rooms.Inbox ? <rooms.Inbox /> : null;
    if (shell().inApp() && page.pageId === ASSISTANT_PAGE) return rooms.Assistant ? <rooms.Assistant conversation={page.tab} /> : null;
    return <PageRoom entry={page} />;
  }
  return <RowRoom entry={entry as RowEntry} />;
}
