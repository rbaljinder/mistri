/**
 * A free-form page's room (definePage), as the content pane's dashboard room
 * draws it where the dashboard is a page (Rooms.tsx `DashboardRoom`, through
 * the shell's rooms slot `Page`): the App framework's, with the page's side of
 * @mistriwork/mistri/ui, so the kit's rooms name none of it.
 */
import { useRef, useState } from 'react';
import { currentEntry, go, state } from '@mistriwork/kit/client/core.js';
import { syncHash } from '@mistriwork/kit/client/url.js';
import { FavoriteStar } from '@mistriwork/kit/client/components/FavoriteStar.js';
import { ErrorBoundary } from '@mistriwork/kit/client/components/ErrorBoundary.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { pagePlace, rootSlot, type DashboardDef } from '@mistriwork/kit/client/components/dashboardModel.js';
import type { PageEntry } from '@mistriwork/kit/client/components/pageModel.js';
import { UiPageContext, type UiPageFrame } from './sdk/context.js';

/* A free-form page's component, and the page's side of @mistriwork/mistri/ui with it: fetched the first time one is opened. */
const CustomPage = onDemand(() => import('./sdk/CustomPage.js'), 'CustomPageBody');

/**
 * A free-form page (definePage): the dashboard of its one component, which
 * is handed the page's frame — what it declared it reads and runs, its
 * loader, and its place in the address. Its place rides the page entry's
 * root slot as a dashboard's picks do, so `/{app}/pick-walk?list=12` opens
 * where the reader was; a change is a step Back returns from, unless the
 * component says it refines this one.
 */
export function FreePage({
  entry,
  dashboard,
  page,
  initialEntry,
}: {
  entry?: PageEntry;
  dashboard: DashboardDef;
  page: NonNullable<DashboardDef['page']>;
  initialEntry?: () => PageEntry;
}) {
  const [tick, setTick] = useState(0);
  const initial = useRef<PageEntry | undefined>(undefined);
  const section = dashboard.sections[0];
  const place = pagePlace(dashboard, entry?.rootBody);
  const frame: UiPageFrame = {
    view: dashboard.id,
    label: dashboard.label,
    reads: page.reads,
    commands: page.commands,
    params: page.params,
    ...(page.loader ? { loader: page.loader } : {}),
    get: (name) => place[name],
    set: (name, value, options = {}) => {
      const owned = entry ?? initial.current;
      if (currentEntry() !== owned) return;
      /* Read live, so two changes in one handler (a line reset, then a list) both land. */
      const next = { ...pagePlace(dashboard, owned?.rootBody) };
      if (next[name] === value) return;
      if (value === undefined) delete next[name];
      else next[name] = value;
      const body = rootSlot(null, next) || undefined;
      if (!owned) {
        if (initialEntry) {
          initial.current = { ...initialEntry(), rootBody: body };
          go(initial.current, options.push ? 'push' : 'replace');
        }
        return;
      }
      if (!options.push) {
        owned.rootBody = body;
        /* A refinement of the place the reader is on, not a step: replace. */
        (state as unknown as { navMode: string }).navMode = 'replace';
        syncHash();
        setTick(tick + 1);
      } else go({ ...owned, rootBody: body }, 'push');
    },
  };
  return (
    <>
      <div className="applist-head dash-head">
        <h1 className={`applist-title${dashboard.headingHidden ? ' visually-hidden' : ''}`}>{dashboard.heading ?? dashboard.label}</h1>
        {dashboard.favorite && (
          <FavoriteStar favorite={{ kind: 'view', view: dashboard.id, label: dashboard.label }} name={dashboard.label} />
        )}
        {dashboard.description && <p className="note dash-description">{dashboard.description}</p>}
      </div>
      {/* The page's one component, on the page's own body: it is not a dashboard's tile, so no look's tray frames it. */}
      <div className="page-body free-page-body">
        <section className="page-section width-full">
          <ErrorBoundary>
            <UiPageContext.Provider value={frame}>{section ? <CustomPage frame={frame} section={section} /> : null}</UiPageContext.Provider>
          </ErrorBoundary>
        </section>
      </div>
    </>
  );
}
