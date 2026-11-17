/**
 * The head of a dashboard or a free-form page, as markup: the title, its star, a line of intro, and, when there are
 * any, the page's verbs and a way back. DashHead is the platform's own use of it; a free-form page that draws its own
 * head reaches it through the SDK's `PageHeader`, so both wear the one set of classes and every look and theme
 * dresses them alike (features.css `.dash-head`).
 */
import type { ReactNode } from 'react';

export function PageHeading({
  title,
  favorite,
  description,
  actions,
  back,
  hidden = false,
  level = 1,
}: {
  title: ReactNode;
  /** The Favorites star beside the title. */
  favorite?: ReactNode;
  description?: ReactNode;
  /** The page's verbs, at the head's far end. */
  actions?: ReactNode;
  /** A way back, over the title. */
  back?: ReactNode;
  /** The title stays for a screen reader and is not seen. */
  hidden?: boolean;
  /** A page has one h1, the platform's; a head a page draws itself is an h2. */
  level?: 1 | 2;
}) {
  const Title = level === 1 ? 'h1' : 'h2';
  const drawn = actions !== undefined && actions !== null && actions !== false;
  return (
    <div className={`applist-head dash-head${drawn ? ' has-actions' : ''}${back ? ' has-back' : ''}`}>
      {back ? <div className="dash-head-back">{back}</div> : null}
      <Title className={`applist-title${hidden ? ' visually-hidden' : ''}`}>{title}</Title>
      {favorite}
      {drawn ? <div className="applist-head-tools dash-head-actions">{actions}</div> : null}
      {/* A page that draws its own head says its own intro; `heading: false` hides only the title. */}
      {description ? <p className="note dash-description">{description}</p> : null}
    </div>
  );
}
