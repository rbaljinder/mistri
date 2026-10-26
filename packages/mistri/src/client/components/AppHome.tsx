/**
 * An App's home, as the content pane draws it when nothing is on the walk
 * (Content.tsx): where the App's work starts and what is waiting, not the
 * anatomy of the database it happens to run on. The server's answer (the
 * payload's `home`) names it and is followed, never worked out here: one of
 * the App's rooms — a list, a signed-in form, a dashboard — or, where it
 * names none, a public view; with no home it can draw, the App's home card.
 *
 * The App framework's, drawn through the shell's rooms slot (appNavigation.js
 * `rooms.Home`), so the kit's pane names none of the App's own rooms.
 */
import { findTable } from '@mistriwork/kit/client/core.js';
import { activeApp } from '../appState.js';
import { shell, type AppHomeProps } from '@mistriwork/kit/client/shellMode.js';
import { dashboardEntry } from '@mistriwork/kit/client/dashboard.js';
import { isFormView } from '../../shared/appModel.js';
import { AppHomeLanding, AppLanding } from './AppLanding.js';
import { appListQuery } from '@mistriwork/kit/client/components/appListModel.js';
import { homeRoom, isListRoom } from '@mistriwork/kit/client/components/appRooms.js';
import type { DashboardDef } from '@mistriwork/kit/client/components/dashboardModel.js';
import { preloadDashboardParts } from '@mistriwork/kit/client/components/dashboardParts.js';
import { FormBody } from './FormRoom.js';
import { LoadErrorNote } from '@mistriwork/kit/client/components/Landing.js';
import { PublicHome } from './PublicHome.js';
import { AppListRoom } from '@mistriwork/kit/client/components/Rooms.js';

export function AppHome({ paint, said, entry, pages }: AppHomeProps) {
  const app = activeApp();
  const home = app ? homeRoom(app) : undefined;
  const homeDash = home && 'sections' in home ? (home as DashboardDef) : undefined;
  const homeList = home && isListRoom(home) && findTable(home.table) ? home : undefined;
  /* Asked while this first render runs, not from the dashboard's effects after it: the first page waits on them. */
  if (homeDash) preloadDashboardParts(homeDash);
  if (homeList)
    return (
      <>
        <LoadErrorNote error={shell().loadError()} />
        {said}
        <AppListRoom key={paint} entry={{ table: homeList.table, query: appListQuery(homeList) }} spec={homeList} />
      </>
    );
  /* A signed-in form home is the form, as its room draws it. */
  if (app && home && isFormView(home))
    return (
      <>
        <LoadErrorNote error={shell().loadError()} />
        {said}
        <FormBody key={paint} form={home} appName={app.name} />
      </>
    );
  /* A dashboard home is drawn exactly the way the dashboard route draws —
     full width, no card around it. A public home is drawn with the menu
     beside it. With no home it can draw, the App's home card. */
  return (
    <>
      {said}
      {app && homeDash ? (
        <div className="landing-host">
          <AppLanding
            key={paint}
            app={app}
            firstDash={homeDash}
            loadError={shell().loadError()}
            pages={pages}
            dashboardEntry={dashboardEntry as never}
            entry={entry}
          />
        </div>
      ) : app?.home !== undefined && !home ? (
        <PublicHome key={paint} view={app.home} loadError={shell().loadError()} />
      ) : app ? (
        <AppHomeLanding app={app} loadError={shell().loadError()} pages={pages} />
      ) : null}
    </>
  );
}
