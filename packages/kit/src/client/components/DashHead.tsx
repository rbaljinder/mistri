/**
 * A dashboard's or a free-form page's head (Rooms.tsx, the App's FreePage and
 * landing): its one h1, its star, its intro — in the form the page asks for.
 *
 * `head: 'compact'` is the title alone on one line with its verbs, at a list's
 * size and with no intro: a working page whose body starts at once. `head:
 * false` is a page that draws its own head; its title is kept for a screen
 * reader, so the room still has the one h1 that names it, while the document
 * title, the crumbs and the palette read the label as they always do.
 */
import { FavoriteStar } from './FavoriteStar.js';
import type { DashboardDef } from './dashboardModel.js';

export function DashHead({
  dashboard,
  star = true,
}: {
  dashboard: Pick<DashboardDef, 'id' | 'label' | 'heading' | 'headingHidden' | 'head' | 'description' | 'favorite'>;
  /** The landing draws no star: its page is the App's front door, not a place one keeps. */
  star?: boolean;
}) {
  const hidden = dashboard.headingHidden === true || dashboard.head === 'own';
  const title = dashboard.heading ?? dashboard.label;
  const favorite = star && dashboard.favorite && dashboard.head !== 'own' && (
    <FavoriteStar favorite={{ kind: 'view', view: dashboard.id, label: dashboard.label }} name={dashboard.label} />
  );
  /* Nothing to see: only the title a screen reader keeps. It stands alone rather than in the head's box, which would
     hold its minimum height and its rule over a page that draws its own head, and the pane starts at the page. */
  if (hidden && !favorite && !(dashboard.description && dashboard.head !== 'own'))
    return <h1 className="applist-title visually-hidden">{title}</h1>;
  if (dashboard.head === 'compact' && !hidden)
    return (
      <div className="applist-head applist-head-row dash-head-compact">
        <h1 className="applist-title">{title}</h1>
        {favorite}
      </div>
    );
  return (
    <div className="applist-head dash-head">
      <h1 className={`applist-title${hidden ? ' visually-hidden' : ''}`}>{title}</h1>
      {favorite}
      {/* A page that draws its own head says its own intro; `heading: false` hides only the title. */}
      {dashboard.description && dashboard.head !== 'own' && <p className="note dash-description">{dashboard.description}</p>}
    </div>
  );
}
